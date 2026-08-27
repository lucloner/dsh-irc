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
    replies++
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
        log('reconnect-in', { delayMs: 60000 })
        setTimeout(connect, 60000)
      }
    })
  } catch (e) {
    log('connect-error', { message: e.message })
    setTimeout(connect, 60000)
  }
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
