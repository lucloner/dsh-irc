#!/usr/bin/env node
'use strict'
/**
 * Real IRC bot for #xia (biggee.chat / 192.168.4.252:6667).
 *
 * - Reads server address + nick + channel + LLM route from irc.json (config-driven).
 * - Real TCP connection via Node `net`.
 * - IRC protocol: NICK / USER / JOIN / PING->PONG / PRIVMSG in & out.
 * - Keeps a 20-round FIFO conversation buffer (used as LLM context).
 * - **Model follows the system**: the LLM model is resolved dynamically from the
 *   most recently used model in DSH's session store (the newest session.jsonl.zstd's
 *   last `"model":"..."` field), falling back to irc.json's `llm.model`.
 * - **MCP tools follow the system MCP config**: the bot reads the same MCP server
 *   configuration the system uses (~/.config/opencode/opencode.json -> `mcp`, the
 *   canonical source the DSH preset mirrors), connects to each enabled server
 *   (streamable-http and stdio), and exposes their tools to the LLM as
 *   `mcp__<server>__<tool>` OpenAI function-calling tools. A local `run_command`
 *   tool is also kept for shell access.
 * - Agentic loop: the LLM is given the tools; when it requests a tool call the bot
 *   executes it (via MCP or shell) and feeds the result back, looping until the
 *   model produces a final text reply.
 * - Anti-loop: ignore other known bots, cooldown, burst cap.
 * - Reconnects with backoff; logs every event to conversation.ndjson + status.json.
 *
 * Usage: node irc-bot.js   (config at ./irc.json or $IRC_BOT_CONFIG)
 */
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { exec, execFileSync, spawn } = require('child_process')

const CONFIG_PATH = process.env.IRC_BOT_CONFIG || path.join(__dirname, 'irc.json')
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
const { server, nick, user, channel, maxRounds = 20, llm, reply, logDir } = config

fs.mkdirSync(logDir, { recursive: true })
const convLog = path.join(logDir, 'conversation.ndjson')
const statusFile = path.join(logDir, 'status.json')
// external send queue (panel -> IRC channel). Lives in the workspace dir so the
// Cordis plugin's fs.writeText can write it (fs is denied outside the workspace).
const outboxFile = path.join(__dirname, 'outbox.ndjson')

// ---- state ----
const buffer = []          // rounds: { nick, text, ts, dir }  (FIFO, max maxRounds)
let connected = false
let lastReplyAt = 0
let burstCount = 0
let burstStart = 0
let rounds = 0             // total inbound channel messages seen
let replies = 0            // total replies sent
let llmErrors = 0
let toolCalls = 0          // total tool calls executed
let reconnectAttempts = 0
let sock = null
let shuttingDown = false
let registered = false   // becomes true on the 001 Welcome (fully connected)

const now = () => new Date().toISOString()

function log(ev, data) {
  const rec = { ts: now(), ev, ...data }
  try { fs.appendFileSync(convLog, JSON.stringify(rec) + '\n') } catch (e) { /* ignore */ }
  console.log(JSON.stringify(rec))
}

function writeStatus() {
  const s = {
    ts: now(), connected, nick, channel,
    server: server.host + ':' + server.port,
    rounds, replies, llmErrors, toolCalls,
    bufferLen: buffer.length, maxRounds,
    replyEnabled: !!reply.enabled,
    model: lastModel,
    mcp: Object.fromEntries(mcpServers.map((srv) => [srv.name, srv.tools.length])),
    mcpFailed: mcpFailed,
    mcpToolTotal: mcpServers.reduce((n, srv) => n + srv.tools.length, 0),
  }
  try { fs.writeFileSync(statusFile, JSON.stringify(s, null, 2)) } catch (e) { /* ignore */ }
}

// ---- LLM (local LiteLLM proxy, same route DSH uses) ----
function readKey() {
  try {
    const raw = fs.readFileSync(llm.keyFile, 'utf8')
    const m = raw.match(/LITELLM_API_KEY\s*[:=]\s*['"]?(sk-[A-Za-z0-9_-]+)/)
    if (m) return m[1]
  } catch (e) { /* ignore */ }
  return null
}
const API_KEY = readKey()

// ============================================================================
// Model resolution: follow the most recently used model in DSH's session store.
// ============================================================================
let lastModel = llm.model
let modelCache = { at: 0, model: null }

function resolveModel() {
  const t = Date.now()
  if (modelCache.model && t - modelCache.at < 30000) return modelCache.model
  let model = null
  try {
    const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
    let best = null
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir)) {
        const f = path.join(dir, d)
        let st
        try { st = fs.statSync(f) } catch (e) { continue }
        if (st.isDirectory()) walk(f)
        else if (d === 'session.jsonl.zstd' && (!best || st.mtimeMs > best.mtime)) best = { f, mtime: st.mtimeMs }
      }
    }
    walk(sessionsRoot)
    if (best) {
      const out = execFileSync('zstd', ['-dc', best.f], { timeout: 15000, maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
      const all = out.match(/"model":"([^"]+)"/g)
      if (all && all.length) {
        const m = all[all.length - 1].match(/"model":"([^"]+)"/)
        if (m) model = m[1]
      }
    }
  } catch (e) { /* ignore */ }
  modelCache = { at: t, model: model || llm.model }
  lastModel = modelCache.model
  return lastModel
}

// ============================================================================
// MCP client: connect to the system's MCP servers (streamable-http + stdio).
// ============================================================================
const mcpServers = []   // { name, transport, tools:[{name,description,inputSchema}], call(name,args) }
const mcpFailed = []     // server names that failed to start

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms + 'ms')), ms))])
}

function expandEnv(str) {
  if (typeof str !== 'string') return str
  return str.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_, name, __, def) => {
    const v = process.env[name]
    return v !== undefined && v !== '' ? v : (def !== undefined ? def : '')
  })
}

function parseSseData(body) {
  // text/event-stream body -> array of parsed JSON data payloads
  const out = []
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) {
      const v = line.slice(5).trim()
      if (!v) continue
      try { out.push(JSON.parse(v)) } catch (e) { /* ignore */ }
    }
  }
  return out
}

function formatMcpResult(r) {
  if (r == null) return '(no result)'
  let text = ''
  if (Array.isArray(r.content)) {
    text = r.content.map((c) => (c && c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
  } else {
    text = JSON.stringify(r)
  }
  if (r.isError) text = 'ERROR: ' + text
  return text || '(no result)'
}

// --- streamable-http transport ---
class McpHttp {
  constructor(name, cfg) {
    this.name = name
    this.transport = 'streamable-http'
    this.url = cfg.url
    this.headers = Object.fromEntries(Object.entries(cfg.headers || {}).map(([k, v]) => [k, expandEnv(v)]))
    this.sessionId = null
    this.tools = []
  }
  async post(payload, extraHeaders) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...this.headers,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...extraHeaders,
        },
        body: JSON.stringify(payload),
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
      const ct = res.headers.get('content-type') || ''
      // Notifications carry no id; drain and return immediately.
      if (payload.id === undefined) {
        try { if (res.body) await res.body.cancel() } catch (e) { /* ignore */ }
        return null
      }
      if (ct.includes('text/event-stream')) {
        // Read the SSE stream and stop at the matching id instead of waiting
        // for the connection to close (the server may keep it open).
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim()
            buf = buf.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            const v = line.slice(5).trim()
            if (!v) continue
            let j
            try { j = JSON.parse(v) } catch (e) { continue }
            if (j && j.id === payload.id) {
              try { await reader.cancel() } catch (e) { /* ignore */ }
              return j
            }
          }
        }
        return null
      }
      const body = await res.text()
      if (!body) return null
      try { return JSON.parse(body) } catch (e) { return null }
    } finally {
      clearTimeout(timer)
    }
  }
  async init() {
    const r = await this.post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'irc-bot', version: '1.0' } },
    })
    if (!r || r.error) throw new Error((r && r.error && r.error.message) || 'initialize failed')
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }
  async listTools() {
    const r = await this.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    if (!r || r.error) throw new Error((r && r.error && r.error.message) || 'tools/list failed')
    return (r.result && r.result.tools) || []
  }
  async call(name, args) {
    const r = await this.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })
    if (!r) return '(no response)'
    if (r.error) return 'ERROR: ' + (r.error.message || JSON.stringify(r.error))
    return formatMcpResult(r.result)
  }
  kill() { /* nothing to kill */ }
}

// --- stdio transport ---
class McpStdio {
  constructor(name, cmd, args, env) {
    this.name = name
    this.transport = 'stdio'
    this.cmd = cmd
    this.args = args || []
    this.env = env || {}
    this.tools = []
    this.child = null
    this.buf = ''
    this.pending = new Map()
    this.seq = 10
  }
  start() {
    const child = spawn(this.cmd, this.args, { env: { ...process.env, ...Object.fromEntries(Object.entries(this.env).map(([k, v]) => [k, expandEnv(v)])) } })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => { /* ignore stderr noise */ })
    child.on('error', (e) => { this.failAll(e.message) })
    child.on('close', () => { this.failAll('process closed') })
    child.stdout.on('data', (d) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        let j
        try { j = JSON.parse(line) } catch (e) { continue }
        if (j.id !== undefined && this.pending.has(j.id)) {
          const { resolve, reject } = this.pending.get(j.id)
          this.pending.delete(j.id)
          if (j.error) reject(new Error(j.error.message || JSON.stringify(j.error)))
          else resolve(j.result)
        }
      }
    })
  }
  failAll(msg) {
    for (const { reject } of this.pending.values()) reject(new Error(msg))
    this.pending.clear()
  }
  rpc(method, params, id) {
    if (!this.child || this.child.killed) this.start()
    const rid = id !== undefined ? id : this.seq++
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject })
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
      } catch (e) { this.pending.delete(rid); reject(e) }
    })
  }
  async init() {
    this.start()
    const r = await this.rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'irc-bot', version: '1.0' },
    }, 1)
    if (!r) throw new Error('initialize failed')
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  }
  async listTools() {
    const r = await this.rpc('tools/list', {}, 2)
    return (r && r.tools) || []
  }
  async call(name, args) {
    const r = await this.rpc('tools/call', { name, arguments: args }, 3)
    return formatMcpResult(r)
  }
  kill() { try { if (this.child) this.child.kill() } catch (e) { /* ignore */ } }
}

// --- read the system MCP config (opencode.json, the canonical source) ---
function readMcpConfig() {
  const candidates = [
    process.env.IRC_MCP_CONFIG,
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
  ].filter(Boolean)
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (j && j.mcp && typeof j.mcp === 'object') return j.mcp
    } catch (e) { /* try next */ }
  }
  return {}
}

async function discoverMcp() {
  const cfg = readMcpConfig()
  const entries = Object.entries(cfg).filter(([, c]) => !(c && c.enabled === false))
  await Promise.all(entries.map(async ([name, c]) => {
    let srv
    try {
      if (c && (c.type === 'remote' || c.url)) {
        srv = new McpHttp(name, c)
      } else if (c && Array.isArray(c.command) && c.command.length) {
        const [cmd, ...args] = c.command
        srv = new McpStdio(name, cmd, args, c.environment || {})
      } else {
        return
      }
      // litellm's streamable-http server is slow to initialize (~40s total for
      // init + listTools), so give each phase a generous timeout.
      await withTimeout(srv.init(), 60000)
      const tools = await withTimeout(srv.listTools(), 60000)
      srv.tools = tools || []
      mcpServers.push(srv)
      log('mcp-ready', { server: name, transport: srv.transport, tools: srv.tools.length })
    } catch (e) {
      if (srv) { try { srv.kill() } catch (_) { /* ignore */ } }
      mcpFailed.push(name)
      log('mcp-fail', { server: name, error: e.message })
    }
  }))
  indexTools()
  writeStatus()
  log('mcp-summary', { servers: mcpServers.map((s) => s.name), failed: mcpFailed, tools: mcpServers.reduce((n, s) => n + s.tools.length, 0) })
}

// ============================================================================
// Tool definitions for the LLM: local shell tool + all MCP tools.
// ============================================================================
const LOCAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command on the host machine and return its output (stdout + stderr). Use this to execute commands, run scripts, query system state, or interact with local services.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute, e.g. "ls -la /raid" or "curl -s http://127.0.0.1:4000/v1/models"' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 15000)', default: 15000 },
        },
        required: ['command'],
      },
    },
  },
]

function buildTools() {
  const out = LOCAL_TOOLS.slice()
  for (const srv of mcpServers) {
    for (const t of srv.tools) {
      if (!t || !t.name) continue
      const schema = (t.inputSchema && typeof t.inputSchema === 'object') ? { ...t.inputSchema } : { type: 'object', properties: {} }
      if (!schema.type) schema.type = 'object'
      if (!schema.properties) schema.properties = {}
      out.push({
        type: 'function',
        function: {
          name: 'mcp__' + srv.name + '__' + t.name,
          description: (t.description || '').slice(0, 500),
          parameters: schema,
        },
      })
    }
  }
  return out
}

// tool full name -> { server, rawName } lookup
const toolIndex = new Map()
function indexTools() {
  toolIndex.clear()
  for (const srv of mcpServers) {
    for (const t of srv.tools) {
      if (t && t.name) toolIndex.set('mcp__' + srv.name + '__' + t.name, { server: srv, rawName: t.name })
    }
  }
}

function runCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    const t = Number(timeoutMs) || 15000
    exec(command, { timeout: t, maxBuffer: 1024 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim()
      const errOut = String(stderr || '').trim()
      if (err) {
        resolve('exit ' + (err.code !== undefined ? err.code : 'error') + (err.signal ? ' (signal ' + err.signal + ')' : '') +
          '\n' + (out || '') + (errOut ? '\nSTDERR:\n' + errOut : ''))
      } else {
        resolve(out || errOut || '(no output)')
      }
    })
  })
}

async function executeTool(fullName, args) {
  toolCalls++
  if (fullName === 'run_command') return await runCommand(args.command, args.timeoutMs)
  const hit = toolIndex.get(fullName)
  if (!hit) return 'unknown tool: ' + fullName
  try {
    return await withTimeout(hit.server.call(hit.rawName, args || {}), 60000)
  } catch (e) {
    return 'ERROR: ' + e.message
  }
}

// ============================================================================
// LLM agentic loop.
// ============================================================================
const noToolsModels = new Set() // models that reject the `tools` parameter

async function chatOnce(messages, useTools) {
  const body = {
    model: resolveModel(),
    messages,
    max_tokens: 400,
    temperature: 0.7,
  }
  if (useTools) { body.tools = buildTools(); body.tool_choice = 'auto' }
  const res = await fetch(llm.base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + API_KEY },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('llm http ' + res.status + ' ' + (await res.text()).slice(0, 200))
  const j = await res.json()
  const msg = j.choices && j.choices[0] && j.choices[0].message
  if (!msg) throw new Error('empty llm response')
  return msg
}

async function generateReply(inbound) {
  const sysPrompt = llm.system + '\n\n你可以调用工具来完成任务。当用户要求执行命令、查询数据库、搜索信息、操作文件、查询文档等时，调用相应工具并把结果告诉用户。工具结果会作为上下文提供给你。'
  const messages = [{ role: 'system', content: sysPrompt }]
  for (const r of buffer) {
    messages.push({ role: r.nick === nick ? 'assistant' : 'user', content: r.text })
  }
  messages.push({ role: 'user', content: inbound })

  const model = resolveModel()
  let useTools = mcpServers.length > 0 && !noToolsModels.has(model)

  function isContextError(text) {
    return /exceeds|context.*(window|limit)|too long for/i.test(String(text || ''))
  }

  let finalText = ''
  for (let turn = 0; turn < 4; turn++) {
    let msg
    try {
      msg = await chatOnce(messages, useTools)
    } catch (e) {
      if (useTools) {
        // Only permanently disable tools for context-window errors; transient
        // errors (network, timeout, 5xx) should retry once without tools but
        // NOT poison the model for future turns (the model is dynamic).
        if (isContextError(e.message)) noToolsModels.add(model)
        useTools = false
        log('llm-tools-fallback', { model, error: e.message })
        msg = await chatOnce(messages, false)
      } else {
        throw e
      }
    }

    const calls = msg.tool_calls && msg.tool_calls.length ? msg.tool_calls : null
    if (calls) {
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls })
      for (const tc of calls) {
        const name = tc.function && tc.function.name
        let args = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch (e) { args = {} }
        let result
        try { result = await executeTool(name, args) } catch (e) { result = 'ERROR: ' + e.message }
        result = String(result).slice(0, 4000)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
        log('tool', { name, args: JSON.stringify(args).slice(0, 200), result: result.slice(0, 200) })
      }
      writeStatus()
      continue
    }
    finalText = String(msg.content || '').trim()
    // If the model returned a context-window error, retry without tools.
    if (useTools && isContextError(finalText)) {
      noToolsModels.add(model)
      useTools = false
      log('llm-context-fallback', { model })
      msg = await chatOnce(messages, false)
      finalText = String(msg.content || '').trim()
    }
    break
  }
  return finalText
}

// ---- anti-loop ----
function shouldReply(sender) {
  if (!reply.enabled) return false
  if (sender === nick) return false
  if (reply.ignoreNicks && reply.ignoreNicks.includes(sender)) return false
  const ms = Date.now()
  if (ms - lastReplyAt < reply.cooldownMs) return false
  if (ms - burstStart > reply.burstWindowMs) { burstStart = ms; burstCount = 0 }
  if (burstCount >= reply.maxRepliesPerBurst) return false
  return true
}

// ---- IRC ----
function send(raw) { if (sock) { try { sock.write(raw + '\r\n') } catch (e) { /* ignore */ } } }

// ---- outbox: external send queue (panel -> IRC channel) ----
// The Cordis plugin writes JSON lines {text} (or plain text) to outboxFile;
// this bot drains it and sends each message to the channel when connected.
function drainOutbox() {
  if (!connected || !registered) return
  let lines = []
  try {
    const raw = fs.readFileSync(outboxFile, 'utf8')
    lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return
    fs.writeFileSync(outboxFile, '') // clear queue before sending (best-effort)
  } catch (e) { return }
  for (const line of lines) {
    let text = line
    try { const j = JSON.parse(line); if (j && typeof j.text === 'string') text = j.text } catch (e) { /* plain text */ }
    const trimmed = String(text).split('\n').join(' ').slice(0, reply.maxLen)
    send('PRIVMSG ' + channel + ' :' + trimmed)
    buffer.push({ nick, text: trimmed, ts: now(), dir: 'out' })
    while (buffer.length > maxRounds) buffer.shift()
    log('send', { text: trimmed, via: 'outbox' })
  }
  writeStatus()
}

function handleLine(line) {
  if (line.startsWith('PING')) { send('PONG ' + line.slice(5)); return }
  if (line.startsWith('ERROR')) { log('server-error', { line }); return }
  // 001 = Welcome (fully connected) -> safe to JOIN now (InspIRCd rejects JOIN before this)
  if (/^:\S+ 001 \S+ :/.test(line)) {
    registered = true
    log('registered', {})
    send('JOIN ' + channel)
    return
  }
  // 376 = End of MOTD (fallback signal to JOIN if 001 was missed)
  if (/^:\S+ 376 \S+ :/.test(line) && !registered) {
    registered = true
    log('registered', { via: '376' })
    send('JOIN ' + channel)
    return
  }
  // own JOIN acknowledgement -> confirm we are in the channel
  if (/^:[^ ]+ JOIN /.test(line) && line.includes(channel)) {
    log('joined', { line })
    writeStatus()
    return
  }
  const m = line.match(/^:([^ ]+) PRIVMSG ([^ ]+) :(.*)$/)
  if (m) {
    const sender = m[1].split('!')[0]
    const target = m[2]
    const text = m[3]
    if (target.toLowerCase() === channel.toLowerCase() && sender !== nick) {
      onMessage(sender, text)
    }
  }
}

function onMessage(sender, text) {
  rounds++
  buffer.push({ nick: sender, text, ts: now(), dir: 'in' })
  while (buffer.length > maxRounds) buffer.shift()
  log('recv', { from: sender, text })
  writeStatus()
  if (!shouldReply(sender)) return
  generateReply(text)
    .then((aiText) => {
      if (!aiText) return
      const trimmed = aiText.split('\n').join(' ').slice(0, reply.maxLen)
      send('PRIVMSG ' + channel + ' :' + trimmed)
      replies++
      lastReplyAt = Date.now()
      buffer.push({ nick, text: trimmed, ts: now(), dir: 'out' })
      while (buffer.length > maxRounds) buffer.shift()
      log('send', { text: trimmed })
      writeStatus()
    })
    .catch((e) => {
      llmErrors++
      log('llm-error', { message: e.message })
      writeStatus()
    })
}

// ---- connection with proper partial-frame accumulation ----
let pending = ''

function onData(d) {
  pending += d
  let i
  while ((i = pending.indexOf('\r\n')) >= 0) {
    const line = pending.slice(0, i)
    pending = pending.slice(i + 2)
    handleLine(line)
  }
}

function onConnected() {
  connected = true
  reconnectAttempts = 0
  registered = false
  log('connected', { host: server.host, port: server.port })
  send('NICK ' + nick)
  send('USER ' + user + ' 0 * :' + nick)
  writeStatus()
}

function connect() {
  if (shuttingDown) return
  try {
    sock = net.connect({ host: server.host, port: server.port }, onConnected)
    sock.setEncoding('utf8')
    sock.on('data', onData)
    sock.on('error', (e) => log('socket-error', { message: e.message }))
    sock.on('close', () => {
      connected = false
      log('disconnected', {})
      writeStatus()
      if (!shuttingDown) {
        const delay = 60000 // reconnect every 1 minute on disconnect
        log('reconnect-in', { delayMs: delay })
        setTimeout(connect, delay)
      }
    })
  } catch (e) {
    log('connect-error', { message: e.message })
    setTimeout(connect, 60000) // reconnect every 1 minute on connect error
  }
}

function shutdown(sig) {
  shuttingDown = true
  log('shutdown', { signal: sig })
  for (const srv of mcpServers) { try { srv.kill() } catch (e) { /* ignore */ } }
  try { if (sock) sock.destroy() } catch (e) { /* ignore */ }
  writeStatus()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// ---- startup ----
resolveModel()
log('startup', { model: lastModel, mcpConfig: path.join(os.homedir(), '.config', 'opencode', 'opencode.json') })
discoverMcp()
connect()
// drain the external send queue (panel -> IRC channel) every 500ms
setInterval(drainOutbox, 500)
