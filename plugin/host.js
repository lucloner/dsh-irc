/**
 * dsh-irc — Cordis Plugin Host 端（生产版）
 *
 * IRC 会话经 DSH 核心：创建/恢复专用 agent（irc-xia），轮询 inbox 转发消息，
 * 轮询 agent.session 提取回复写入 outbox。IRC 对话由 DSH 的 agent 循环驱动，
 * 因此 DSH 的系统提示、预设、守卫、钩子、上下文、压缩、工具全部生效。
 *
 * 数据流：
 *   IRC 消息 → irc-bot.js → inbox.ndjson → 本插件 pollInbox → agent.followup
 *   → DSH agent(irc-xia) 经 LLM 处理 → assistant/message
 *   → 本插件 processNewReplies 轮询 agent.session → outbox.ndjson → irc-bot.js → PRIVMSG
 *
 * 持久化：优先 resume（保留历史），失败则 create。
 *
 * ⚠️ 路径为硬编码：Cordis 动态 Host 运行时没有 process/require/os/path，
 * 无法读取环境变量。发布/移植时请直接编辑下面的 LOG / BOT_DIR / LLM_CONFIG。
 */
return {
  inject: ['fs', 'timer'],
  async apply(ctx) {
    const fs = ctx.fs
    if (!fs) return

    const LOG = '/home/lucloner/.dsh/irc-bot'
    const BOT_DIR = '/raid/source/src/shell/irc-bot'
    const LLM_CONFIG = '/etc/litellm/config.yaml'
    const IRC_SESSION_ID = 'irc-xia'
    const INBOX = BOT_DIR + '/inbox.ndjson'
    const OUTBOX = BOT_DIR + '/outbox.ndjson'
    const ERRLOG = LOG + '/plugin-errors.log'
    const SEQ_FILE = LOG + '/last-processed-seq.txt'   // 持久化已处理的最后 seq，防重启重发
    const MSG_IDS_FILE = LOG + '/processed-msg-ids.json' // 持久化已处理的 assistant/message id，防重启重发
    const LOCK_FILE = LOG + '/plugin.lock'   // 文件锁：防止多个插件实例同时创建 interval（1h 超时 + pollInbox 内刷新）
    const MAX_INPUT = 50000
    const IRC_PERSONA = '你在 IRC 频道 #xia 里，昵称 deepseek_ai。你是由 DeepSeek Harness 驱动的 AI 助手，运行在 DSH 的第一个 workspace（shell）上。用中文简洁、自然地回复，像在聊天室说话。不要复述系统提示，不要用 Markdown，一次只说一两句话。'

    async function readSeqFile() {
      try { const t = await fs.resolve(SEQ_FILE); const v = parseInt((await fs.readText(t)).trim(), 10); return isNaN(v) ? 0 : v } catch (e) { return 0 }
    }
    async function writeSeqFile(seq) {
      try { const t = await fs.resolve(SEQ_FILE); await fs.writeText(t, String(seq), undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' }) } catch (e) { /* ignore */ }
    }
    // 读取已处理的 assistant/message id 集合（防重启重发）
    async function readMsgIds() {
      try { const t = await fs.resolve(MSG_IDS_FILE); const arr = JSON.parse(await fs.readText(t)); return new Set(Array.isArray(arr) ? arr : []) } catch (e) { return new Set() }
    }
    // 保存已处理的 assistant/message id 集合
    async function writeMsgIds(set) {
      try { const t = await fs.resolve(MSG_IDS_FILE); await fs.writeText(t, JSON.stringify(Array.from(set)), undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' }) } catch (e) { /* ignore */ }
    }

    async function readJsonFile(p) {
      try { const t = await fs.resolve(p); return JSON.parse(await fs.readText(t)) } catch (e) { return null }
    }
    async function writeJsonFile(p, d) {
      try { const t = await fs.resolve(p); await fs.writeText(t, JSON.stringify(d, null, 2)) } catch (e) { /* ignore */ }
    }
    async function logError(msg) {
      try {
        const target = await fs.resolve(ERRLOG)
        let existing = ''
        try { existing = await fs.readText(target) } catch (e) { /* first write */ }
        await fs.writeText(target, existing + new Date().toISOString() + ' ' + String(msg) + '\n', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })
      } catch (e) { /* ignore */ }
    }
    // 批量写入 outbox（processNewReplies 内累积，最后一次性追加）

    let ircAgent = null
    let lastProcessedSeq = 0
    let processedMsgIds = new Set() // 已处理的 assistant/message id 去重（防重启重发 + 防重复转发）
    let sentInboxTs = new Set() // 已发送给 agent 的入站消息 ts 去重，防同一消息被 followup 多次
    let pendingText = ''          // 达到阈值的待发送消息（仅含已满足 rate-limit 的 sender）
    let waitingBuffers = {}       // 未达阈值的 sender 消息暂存：sender -> text
    let lastFollowupTime = 0      // 上次 followup 时间戳，防多 interval 快速重复发送（500ms 窗口）
    let polling = false           // 防止并发轮询

    // === IRC rate-limiting: per-sender accumulation + cooldown reset ===
    const COOLDOWN_MS = 300000     // 5 分钟不发言 → 重置该 sender 的 required 为 1
    let senderRequired = {}        // sender -> messages needed before sending (初始为 1)
    let senderAccumulated = {}     // sender -> total accumulated messages since last send
    let senderLastSendTime = {}    // sender -> last followup timestamp for cooldown tracking


    // Agent 空闲检测：用 session events 判断而非 ircAgent.status（status 可能在 turn/end 后仍为 'running'）
    function isAgentIdle() {
      try {
        const events = ircAgent.session.events
        if (!Array.isArray(events) || !events.length) return true // 无事件 = 空闲
        const lastEv = events[events.length - 1]
        if (lastEv && lastEv.type === 'turn/end') return true // turn/end 表示 agent 已完成当前轮次，可接收新输入
        // 有 assistant/message 但无 turn/end：agent 可能仍在处理或 status 卡住 → 也允许发送（pendingText 会累积）
        const hasMessage = events.some(e => e && e.type === 'assistant/message')
        return !!hasMessage
      } catch (e) {
        return false
      }
    }

    // 启动时加载持久化的 lastProcessedSeq 和 processedMsgIds（防重启重发历史回复）
    readSeqFile().then((s) => { lastProcessedSeq = s; logError('loaded lastProcessedSeq=' + s) })
    readMsgIds().then((s) => { processedMsgIds = s; logError('loaded processedMsgIds=' + s.size) })

    function makeUserMessage(text) {
      return {
        id: 'irc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10),
        role: 'user',
        content: [{ type: 'text', text: String(text) }],
        source: { kind: 'user' },
      }
    }

    // 从 agent.session.events 提取新的 assistant/message 文本并批量写入 outbox。
    // processedMsgIds Set 去重：按 assistant/message 的唯一 id 去重，防同一消息被多轮 pollInbox 重复转发。
    // 注意：agent.session.events 返回的是全局事件（含其它会话），seq 号不连续，故用消息 id 而非 seq 去重。
    function processNewReplies() {
      if (!ircAgent || !ircAgent.session) return
      let events
      try { events = ircAgent.session.events } catch (e) { logError('read session.events: ' + e.message); return }
      if (!Array.isArray(events)) return

      // 先收集所有新文本，最后一次性追加到 outbox（避免 appendOutbox 被多次调用导致重复）
      const newTexts = []
      for (const ev of events) {
        if (!ev || ev.type !== 'assistant/message') continue

        const data = ev.data || {}
        const msg = data.message
        // 用消息 id 去重（每个 assistant/message 有唯一 id）
        const msgId = msg && msg.id
        if (!msgId || processedMsgIds.has(msgId)) continue
        processedMsgIds.add(msgId)

        let t = ''
        if (msg && Array.isArray(msg.content)) for (const b of msg.content) if (b && b.type === 'text' && b.text) t += b.text
        t = t.trim()
        if (!t) continue

          newTexts.push(t)
      }

      // 一次性追加所有新回复到 outbox（processedMsgIds 已确保消息 ID 唯一，无需 sentTexts）
      if (newTexts.length > 0) {
        logError('processNewReplies: writing ' + newTexts.length + ' texts to outbox')
        appendOutboxBatch(newTexts)
      }

      // 持久化 processedMsgIds，防重启重发历史回复
      if (processedMsgIds.size > 0) writeMsgIds(processedMsgIds)
    }

    async function appendOutbox(text) {
      try {
        const target = await fs.resolve(OUTBOX)
        let existing = ''
        try { existing = await fs.readText(target) } catch (e) { /* first write */ }
        await fs.writeText(target, existing + JSON.stringify({ text: String(text) }) + '\n', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })
      } catch (e) { logError('appendOutbox: ' + e.message) }
    }

    // 批量追加到 outbox（append-only，避免与 IRC bot drainOutbox atomic rename 竞态）
    async function appendOutboxBatch(texts) {
      if (!texts.length) return
      try {
        const target = await fs.resolve(OUTBOX)
        let content = ''
        for (const t of texts) {
          content += JSON.stringify({ text: String(t) }) + '\n'
        }
        // Append-only: read existing, write back. If drainOutbox renamed between our read and write,
        // the old content is lost but this is acceptable since it was already sent by IRC bot.
        try {
          const existing = await fs.readText(target)
          await fs.writeText(target, existing + content, undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })
        } catch (e) { /* file doesn't exist yet */
          await fs.writeText(target, content, undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })
        }
      } catch (e) { logError('appendOutboxBatch: ' + e.message) }
    }

    ctx.on('agent/session-start', (payload) => {
      const agent = payload && payload.agent
      if (!agent || agent.id !== IRC_SESSION_ID) return
      try { agent.inject(makeUserMessage('<system-reminder>\n' + IRC_PERSONA + '\n</system-reminder>')) } catch (e) { logError('session-start inject: ' + e.message) }
    })

    async function pollInbox() {
      if (!ircAgent || polling) return
      polling = true
      try {
        // 定期刷新锁，防止 autoload 重复加载创建新 interval
        try {
          const lt = await fs.resolve(LOCK_FILE)
          let existing = ''
          try { existing = await fs.readText(lt) } catch (e) {}
          if (existing && Date.now() - Number(existing) < 3600000) {
            await fs.writeText(lt, String(Date.now()), undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })
          } else if (!existing || Date.now() - Number(existing) >= 3600000) {
            // Lock expired or missing — only refresh if we haven't refreshed in last poll cycle
            await fs.writeText(lt, String(Date.now()), undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })
          }
        } catch (e) { /* ignore lock refresh errors */ }

        processNewReplies()

        // 读取并清空 inbox
        let lines = []
        try {
          const target = await fs.resolve(INBOX)
          const content = await fs.readText(target)
          lines = content.trim().split('\n').filter(l => l.trim())
          await fs.writeText(target, '', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })
        } catch (e) { logError('inbox read/clear: ' + e.message) }

        // 合并所有新消息为一段文本，按 sender 分组累积
        // Rate-limiting: 每个 sender 需要 accumulated >= required 才发送
        // required 初始为 1，每次发送后 +count（实际发送的条数）；5 分钟不发言 → 重置为 1
        const senderBuffers = {}  // sender -> accumulated text this poll
        for (const line of lines) {
          let rec
          try { rec = JSON.parse(line) } catch (e) { continue }
          if (!rec || !rec.text) continue
          const tsKey = rec.ts || (rec.from + ':' + rec.text)
          if (sentInboxTs.has(tsKey)) continue
          sentInboxTs.add(tsKey)
          const sender = rec.from || 'unknown'
          // 累计该轮新消息数
          senderAccumulated[sender] = (senderAccumulated[sender] || 0) + 1
          if (!senderBuffers[sender]) { senderBuffers[sender] = '' }
          senderBuffers[sender] += sender + ': ' + rec.text + '\n'
        }

        // 检查冷却：如果某 sender 距上次发送超过 5 分钟，重置其 required 为 1
        for (const s of Object.keys(senderRequired)) {
          const lastSend = senderLastSendTime[s] || 0
          if (Date.now() - lastSend > COOLDOWN_MS && senderRequired[s] > 1) {
            logError('cooldown reset: sender=' + s + ' was ' + senderRequired[s] + ' -> 1')
            senderRequired[s] = 1
            // 冷却后重置 accumulated，之前的消息也算一轮
            senderAccumulated[s] = 0
          }
        }

        // 检查每个 sender 是否达到发送阈值
        const sentSenders = []   // 记录本轮已满足阈值的 sender（用于冷却时间追踪）
        let readyBatch = ''
        for (const sender of Object.keys(senderBuffers)) {
          const accumulated = senderAccumulated[sender] || 0
          const required = senderRequired[sender] || 1
          if (accumulated >= required) {
            // 合并之前暂存的消息 + 本次新消息
            readyBatch += (waitingBuffers[sender] || '') + senderBuffers[sender]
            delete waitingBuffers[sender]
            // 下一轮需要 required + accumulated 条（实际累积数）
            senderRequired[sender] = required + accumulated
            sentSenders.push(sender)
            // 重置该 sender 的累积计数
            senderAccumulated[sender] = 0
            logError('rate-limit: sender=' + sender + ' accumulated=' + accumulated + ' required_was=' + required + ' next_required=' + senderRequired[sender])
          } else {
            // 未达阈值，暂存到 waitingBuffers（不会与其他 sender 的达标消息一起发送）
            waitingBuffers[sender] = (waitingBuffers[sender] || '') + senderBuffers[sender]
            logError('rate-limit: sender=' + sender + ' accumulated=' + accumulated + ' needed=' + required + ' (waiting)')
          }
        }

        // 仅达标消息进入 pendingText（未达标消息在 waitingBuffers 中等待）
        if (readyBatch.trim()) {
            pendingText += readyBatch
            if (pendingText.length > MAX_INPUT) pendingText = pendingText.slice(-MAX_INPUT)
        }

        // 仅当 agent 空闲且有内容时才发送（合并为一次）
        // lastFollowupTime 防多 interval 快速重复发送（500ms 窗口）
        if (isAgentIdle() && pendingText.trim()) {
            const now = Date.now()
            if (now - lastFollowupTime > 500) {   // 至少间隔 500ms 才发下一条
                const text = pendingText.trim()
                pendingText = ''
                lastFollowupTime = now
                try { await ircAgent.followup(makeUserMessage(text)) } catch(e) { logError('followup failed: ' + e.message) }
                // 记录每个 sender 的冷却时间（用于 5 分钟不发言重置）
                for (const s of sentSenders) {
                  senderLastSendTime[s] = now
                }
                // Check if events were added after followup (async response)
                try {
                    const evts = ircAgent.session.events || []
                    const newMsgs = evts.filter(e => e && e.type === 'assistant/message' && !processedMsgIds.has((e.data||{}).message?.id))
                    if (newMsgs.length > 0) logError('followup-probe: found ' + newMsgs.length + ' unprocessed msgs')
                } catch(e2) {}
            }
        }
      } finally {
        polling = false
      }
    }

    const agents = ctx.get('agents')
    if (agents) {
      try {
        const existing = agents.get(IRC_SESSION_ID)
        if (existing) {
          ircAgent = existing
          logError('got existing agent, status=' + String(existing.status))
        } else {
          // 优先 resume（保留历史），失败则 create；create 若因会话已存在而失败，重试 get。
          try {
            const handle = await agents.resume({
              resumeSessionId: IRC_SESSION_ID,
              agentOptions: { provider: 'litellm', model: 'deepseek-v4-flash-cloud' },
            })
            ircAgent = handle.agent
            logError('resumed agent id=' + String(handle.agent.id))
          } catch (e) {
            logError('resume failed: ' + e.message)
            try {
              const handle = await agents.create({
                sessionId: IRC_SESSION_ID,
                meta: { cwd: '/raid/source/src/shell' },
                agentOptions: { provider: 'litellm', model: 'deepseek-v4-flash-cloud' },
              })
              ircAgent = handle.agent
              logError('created agent id=' + String(handle.agent.id))
            } catch (e2) {
              // 会话可能已 live（旧 agent 正在 dispose），重试 get
              const retry = agents.get(IRC_SESSION_ID)
              if (retry) {
                ircAgent = retry
                logError('recovered live agent after create failed')
              } else {
                logError('create failed: ' + e2.message)
              }
            }
          }
        }
        // 文件锁：防止多个插件实例同时创建 interval（导致重复 followup）
        // 若锁文件存在且是最近 30 秒内创建的，说明已有实例在运行，跳过。
        let lockAcquired = false
        try {
          const lt = await fs.resolve(LOCK_FILE)
          let existing = ''
          try { existing = await fs.readText(lt) } catch (e) { /* no lock yet */ }
          if (existing && Date.now() - Number(existing) < 3600000) {
            logError('another instance running, skip interval (lock age=' + Math.round((Date.now() - Number(existing))/1000) + 's)')
          } else {
            await fs.writeText(lt, String(Date.now()), undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })
            lockAcquired = true
            logError('lock acquired at ' + new Date().toISOString())
          }
        } catch (e) { logError('lock check: ' + e.message) }

        if (ircAgent && lockAcquired) {
          ctx.interval(pollInbox, 1500)
        } else if (ircAgent && !lockAcquired) {
          logError('interval skipped due to lock')
        }
      } catch (e) {
        logError('agent setup: ' + e.message)
      }
    } else {
      logError('no agents service')
    }

    harness.handle('get-irc-messages', async (args) => {
      const afterTs = args && args.afterTs ? Number(args.afterTs) : 0
      try {
        const target = await fs.resolve(LOG + '/conversation.ndjson')
        const content = await fs.readText(target)
        const lines = content.trim().split('\n').filter(l => l.trim())
        const msgs = []
        for (let i = 0; i < lines.length; i++) {
          try {
            const p = JSON.parse(lines[i])
            const t = p.ts ? new Date(p.ts).getTime() : 0
            if (afterTs && t <= afterTs) continue
            if (p.ev === 'recv') msgs.push({ sender: p.from || 'unknown', text: p.text || '', ts: p.ts })
            else if (p.ev === 'send') msgs.push({ sender: 'deepseek_ai', text: p.text || '', ts: p.ts })
            else if (p.ev === 'tool') msgs.push({ sender: 'Tool', text: (p.name || '') + ' (' + JSON.stringify(p.args) + ') -> ' + String(p.result).substring(0, 500), ts: p.ts })
          } catch (e) { /* skip bad line */ }
        }
        return msgs.slice(-1000)
      } catch (err) { return [] }
    })

    harness.handle('get-irc-status', async () => {
      try { const target = await fs.resolve(LOG + '/status.json'); return JSON.parse(await fs.readText(target)) }
      catch (err) { return { connected: false, error: err.message } }
    })

    harness.handle('irc-send', async (args) => {
      try {
        const text = args && args.text
        if (!text || !String(text).trim()) return { success: false, error: 'empty text' }
        const target = await fs.resolve(OUTBOX)
        let existing = ''
        try { existing = await fs.readText(target) } catch (e) { /* first write */ }
        const content = existing + JSON.stringify({ text: String(text).trim() }) + '\n'
        await fs.writeText(target, content, undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })
        return { success: true, message: '已加入发送队列' }
      } catch (err) { return { success: false, error: err.message || 'irc-send failed' } }
    })

    harness.handle('irc-control', async (args) => {
      const shell = ctx.get('shell')
      if (!shell) return { success: false, error: 'no shell' }
      const action = args && args.action

      if (action === 'switch-model') {
        const mn = args.modelName || ''
        try {
          const cfg = await readJsonFile(BOT_DIR + '/irc.json')
          if (!cfg) return { success: false, error: "can't read irc.json" }
          cfg.llm.model = mn
          await writeJsonFile(BOT_DIR + '/irc.json', cfg)
          const rs = shell.resolve({ command: 'pkill -f "node irc-bot.js"; true', timeoutMs: 5000 })
          await shell.run(rs)
          return { success: true, message: 'Model switched to: ' + mn + '. Bot restarting... (agent model applies on plugin reload)' }
        } catch (err) { return { success: false, error: 'switch failed: ' + err.message } }
      }

      let cmd = ''
      if (action === 'connect') cmd = 'pgrep -f "irc-bot/run.sh" >/dev/null 2>&1 || (cd ' + BOT_DIR + ' && setsid nohup bash run.sh >/dev/null 2>&1 &)'
      else if (action === 'disconnect') cmd = 'pkill -f "irc-bot/run.sh"; pkill -f "node irc-bot.js"; true'
      else if (action === 'restart') cmd = 'pkill -f "node irc-bot.js"; true'
      else return { success: false, error: 'unknown action: ' + action }

      const spec = shell.resolve({ command: cmd, timeoutMs: 15000 })
      const res = await shell.run(spec)
      const out = ((res.stdout && res.stdout.text) || '') + ((res.stderr && res.stderr.text) || '')
      return { success: true, output: out }
    })

    harness.handle('get-irc-models', async () => {
      try {
        const target = await fs.resolve(LLM_CONFIG)
        const content = await fs.readText(target)
        const models = []
        let curModel = null
        let ctxWin = null
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/\s+-\s+model_name:\s*"([^"]+)"/)
          if (m) { if (curModel !== null && ctxWin !== null) models.push({ name: curModel, context_window: ctxWin }); curModel = m[1]; ctxWin = null }
          const cm = lines[i].match(/context_window:\s*(\d+)/)
          if (cm && curModel !== null) ctxWin = parseInt(cm[1])
        }
        if (curModel !== null && ctxWin !== null) models.push({ name: curModel, context_window: ctxWin })
        return { success: true, models }
      } catch (err) { return { success: false, error: err.message || 'config read error' } }
    })

    harness.handle('execute-tool', async (args) => {
      try {
        const tools = ctx.get('tools')
        if (!tools) return { success: false, error: 'no tools svc' }
        const toolName = args.name, params = args.params || {}
        const toolDef = tools.get(toolName)
        if (!toolDef) return { success: false, error: 'tool not found: ' + toolName }
        const result = await tools.execute({ name: toolName, parameters: params })
        if (result && result.content) {
          let output = ''
          for (let i = 0; i < result.content.length; i++) {
            const b = result.content[i]
            if (b.type === 'text') output += b.text
            else if (b.type === 'tool-result') output += JSON.stringify(b.result, null, 2)
          }
          return { success: true, output: output.substring(0, 5000) }
        }
        return { success: false, error: result && result.error ? String(result.error.message || result.error) : 'Unknown error' }
      } catch (err) { return { success: false, error: err.message || 'tool exec failed' } }
    })

    harness.handle('get-skill', async (args) => {
      try {
        const skills = ctx.get('skills')
        if (!skills) return { success: false, error: 'no skills svc' }
        const def = await skills.get(args.name)
        if (def && def.instructions) return { success: true, name: args.name, instructions: def.instructions }
        else return { success: false, error: 'skill not found: ' + args.name }
      } catch (err) { return { success: false, error: err.message || 'get skill failed' } }
    })

    harness.handle('list-skills', async () => {
      try {
        const skills = ctx.get('skills')
        if (!skills) return { success: false, error: 'no skills svc' }
        const list = await skills.list({})
        return { success: true, skills: list.map(s => ({ name: s.name || s.id || '', description: s.description || '' })) }
      } catch (err) { return { success: false, error: err.message || 'list skills failed' } }
    })
  },
}
