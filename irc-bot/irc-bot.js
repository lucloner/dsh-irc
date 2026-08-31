#!/usr/bin/env node
'use strict'
/**
 * Thin IRC transport for #xia (biggee.chat / 192.168.4.252:6667).
 *
 * This process ONLY owns the IRC TCP connection. It no longer calls any LLM,
 * manages a context buffer, or runs an agentic loop — all conversation
 * processing is delegated to the DeepSeek Harness (DSH) core via the Cordis
 * plugin's Host half:
 *
 *   inbound:  IRC channel message -> append to inbox.ndjson
 *             (the DSH Host plugin polls this, routes it through a DSH agent,
 *              and writes the assistant reply to outbox.ndjson)
 *   outbound: read outbox.ndjson -> PRIVMSG to the channel
 *
 * The transport still logs every recv/send to conversation.ndjson (for the
 * Web panel display) and writes status.json.
 *
 * Usage: node irc-bot.js   (config at ./irc.json or $IRC_BOT_CONFIG)
 */
const net = require('net')
const fs = require('fs')
const path = require('path')

const CONFIG_PATH = process.env.IRC_BOT_CONFIG || path.join(__dirname, 'irc.json')
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
const { server, nick, user, channel, reply, logDir } = config

fs.mkdirSync(logDir, { recursive: true })
const convLog = path.join(logDir, 'conversation.ndjson')
const statusFile = path.join(logDir, 'status.json')
// inbound queue (IRC -> DSH Host plugin). Lives in the workspace dir so the
// Cordis plugin's fs service can read it.
const inboxFile = path.join(__dirname, 'inbox.ndjson')
// outbound queue (DSH Host plugin / panel -> IRC channel).
const outboxFile = path.join(__dirname, 'outbox.ndjson')

// ---- state ----
let connected = false
let registered = false   // becomes true on the 001 Welcome (fully connected)
let rounds = 0           // total inbound channel messages seen
let replies = 0          // total replies sent
let sock = null
let shuttingDown = false
let pending = ''
let reconnectAttempts = 0

const now = () => new Date().toISOString()

function log(ev, data) {
  const rec = { ts: now(), ev, ...data }
  try { fs.appendFileSync(convLog, JSON.stringify(rec) + '\n') } catch (e) { /* ignore */ }
  console.log(JSON.stringify(rec))
}

function writeStatus() {
  const s = {
    ts: now(), connected, registered, nick, channel,
    server: server.host + ':' + server.port,
    rounds, replies,
    replyEnabled: !!reply.enabled,
    transport: 'thin',
  }
  try { fs.writeFileSync(statusFile, JSON.stringify(s, null, 2)) } catch (e) { /* ignore */ }
}

// ---- IRC ----
function send(raw) { if (sock) { try { sock.write(raw + '\r\n') } catch (e) { /* ignore */ } } }

// ---- outbox: external send queue (DSH agent reply / panel -> IRC channel) ----
// The DSH Host plugin and the Web panel write JSON lines {text} (or plain text)
// to outboxFile; this transport drains it and sends each message to the channel.
function drainOutbox() {
  if (!connected || !registered) return
  let lines = []
  try {
    const tmpFile = outboxFile + '.tmp'
    // Atomic rename: move file, read from renamed copy, delete copy.
    // This prevents race with plugin's appendOutboxBatch (read-modify-write):
    // if plugin reads old content between our read+clear, it restores old content.
    // With atomic rename, plugin always sees empty file after we take ownership.
    fs.renameSync(outboxFile, tmpFile)
    const raw = fs.readFileSync(tmpFile, 'utf8')
    fs.unlinkSync(tmpFile)
    lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return
  } catch (e) { return }
  for (const line of lines) {
    let text = line
    try { const j = JSON.parse(line); if (j && typeof j.text === 'string') text = j.text } catch (e) { /* plain text */ }
    const trimmed = String(text).split('\n').join(' ').slice(0, reply.maxLen)
    send('PRIVMSG ' + channel + ' :' + trimmed)
    replies++
    log('send', { text: trimmed, via: 'outbox' })
  }
  writeStatus()
}

function handleLine(line) {
  if (line.startsWith('PING')) { send('PONG ' + line.slice(5)); return }
  if (line.startsWith('ERROR')) { log('server-error', { line }); return }
  // 433 = Nick already in use — try alternate nick to prevent registration deadlock
  if (/^:\S+ 433 /.test(line)) {
    const altNick = nick + '_' + Math.floor(Math.random() * 100)
    log('nick-collision', { altNick })
    send('NICK ' + altNick)
    return
  }
  // 001 = Welcome (fully connected) -> safe to JOIN now (InspIRCd rejects JOIN before this)
  if (/^:\S+ 001 \S+ :/.test(line)) {
    registered = true
    reconnectAttempts = 0
    log('registered', {})
    startKeepalive()
    send('JOIN ' + channel)
    writeStatus()
    return
  }
  // 376 = End of MOTD (fallback signal to JOIN if 001 was missed)
  if (/^:\S+ 376 \S+ :/.test(line) && !registered) {
    registered = true
    log('registered', { via: '376' })
    startKeepalive()
    send('JOIN ' + channel)
    writeStatus()
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
  log('recv', { from: sender, text })
  writeStatus()
  // Queue the inbound message for the DSH Host plugin to route through a DSH agent.
  try {
    fs.appendFileSync(inboxFile, JSON.stringify({ ts: now(), from: sender, text }) + '\n')
  } catch (e) { /* ignore */ }
}

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
  registered = false
  log('connected', { host: server.host, port: server.port })
  send('NICK ' + nick)
  send('USER ' + user + ' 0 * :' + nick)
  writeStatus()
  // Registration timeout: if no 001 Welcome within 15s, force reconnect
  setTimeout(() => {
    if (connected && !registered && !shuttingDown) {
      log('registration-timeout', {})
      try { sock.destroy() } catch (e) { /* ignore */ }
    }
  }, 15000)
}

// Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped)
function getReconnectDelay() {
  const delays = [5000, 10000, 20000, 40000, 60000]
  const delay = delays[Math.min(reconnectAttempts, delays.length - 1)]
  reconnectAttempts++
  return delay
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
        const delay = getReconnectDelay()
        log('reconnect-in', { delayMs: delay, attempt: reconnectAttempts })
        setTimeout(connect, delay)
      }
    })
  } catch (e) {
    log('connect-error', { message: e.message })
    const delay = getReconnectDelay()
    setTimeout(connect, delay)
  }
}

// Keepalive PING every 3 minutes to prevent idle disconnect from IRC server
let keepaliveTimer = null
function startKeepalive() {
  if (keepaliveTimer) return
  keepaliveTimer = setInterval(() => {
    // Send a dummy PING to the server to keep connection alive and detect dead connections
    try { sock.write('PING :keepalive\n') } catch (e) { /* ignore */ }
  }, 180000) // 3 minutes
}

function shutdown(sig) {
  shuttingDown = true
  log('shutdown', { signal: sig })
  try { if (sock) sock.destroy() } catch (e) { /* ignore */ }
  writeStatus()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// ---- startup ----
log('startup', { transport: 'thin', config: CONFIG_PATH })
connect()
// drain the external send queue (DSH agent reply / panel -> IRC channel) every 500ms
setInterval(drainOutbox, 500)
