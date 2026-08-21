/**
 * dsh-irc — Cordis Plugin Host 端
 *
 * 在 DeepSeek Harness (DSH) 的 Cordis 运行时中注册 8 个 Host RPC handler，
 * 供 Client 面板调用：
 *
 *   get-irc-messages  读取 IRC 会话记录（conversation.ndjson），返回最近 1000 条
 *   get-irc-status    读取 bot 实时状态（status.json）
 *   irc-send          把面板输入追加到 outbox 队列，由 bot 发送到频道
 *   irc-control       connect / disconnect / restart / switch-model
 *   get-irc-models    从 LiteLLM config 解析可用模型列表
 *   execute-tool      调用 DSH tools 服务执行任意工具
 *   get-skill         读取技能说明
 *   list-skills       列出可用技能
 *
 * ⚠️ 路径为硬编码：Cordis 动态 Host 运行时没有 process/require/os/path，
 * 无法读取环境变量。发布/移植时请直接编辑下面的 LOG / BOT_DIR / LLM_CONFIG。
 */
return {
  inject: ['fs'],
  apply(ctx) {
    const fs = ctx.fs
    if (!fs) return

    const LOG = '/home/lucloner/.dsh/irc-bot'
    const BOT_DIR = '/raid/source/src/shell/irc-bot'
    const LLM_CONFIG = '/etc/litellm/config.yaml'

    async function readJsonFile(p) {
      try { const t = await fs.resolve(p); return JSON.parse(await fs.readText(t)) } catch (e) { return null }
    }
    async function writeJsonFile(p, d) {
      try { const t = await fs.resolve(p); await fs.writeText(t, JSON.stringify(d, null, 2)) } catch (e) { /* ignore */ }
    }

    // 读取 IRC 会话记录。支持增量：传 afterTs 只返回该时间戳之后的新消息，
    // 避免客户端每次全量重渲染。不传时返回最近 1000 条。
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

    // 读取 bot 实时状态
    harness.handle('get-irc-status', async () => {
      try { const target = await fs.resolve(LOG + '/status.json'); return JSON.parse(await fs.readText(target)) }
      catch (err) { return { connected: false, error: err.message } }
    })

    // 面板输入 -> outbox 队列（bot 每 500ms 读取并发送到频道）
    harness.handle('irc-send', async (args) => {
      try {
        const text = args && args.text
        if (!text || !String(text).trim()) return { success: false, error: 'empty text' }
        const outboxPath = BOT_DIR + '/outbox.ndjson'
        const target = await fs.resolve(outboxPath)
        let existing = ''
        try { existing = await fs.readText(target) } catch (e) { /* first write */ }
        const content = existing + JSON.stringify({ text: String(text).trim() }) + '\n'
        // 显式传 danger-full-access，绕过 Cordis fs 沙箱默认 workspace-write 限制
        await fs.writeText(target, content, undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })
        return { success: true, message: '已加入发送队列' }
      } catch (err) { return { success: false, error: err.message || 'irc-send failed' } }
    })

    // bot 控制：connect / disconnect / restart / switch-model
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
          return { success: true, message: 'Model switched to: ' + mn + '. Bot restarting...' }
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

    // 从 LiteLLM config 解析可用模型列表
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

    // 调用 DSH tools 服务执行任意工具
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

    // 读取技能说明
    harness.handle('get-skill', async (args) => {
      try {
        const skills = ctx.get('skills')
        if (!skills) return { success: false, error: 'no skills svc' }
        const def = await skills.get(args.name)
        if (def && def.instructions) return { success: true, name: args.name, instructions: def.instructions }
        else return { success: false, error: 'skill not found: ' + args.name }
      } catch (err) { return { success: false, error: err.message || 'get skill failed' } }
    })

    // 列出可用技能
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
