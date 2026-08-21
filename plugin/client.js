/**
 * dsh-irc — Cordis Plugin Client 端
 *
 * 在 DSH Web GUI 注入一个 IRC 聊天浮动面板：
 *   - 侧边栏底部 "IRC" 按钮开关面板
 *   - 顶部 sticky 区（最多 3 条，超出丢弃最旧）
 *   - 消息区最多 1000 条
 *   - 自动滚动默认开启，打开面板即滚到底部
 *   - 命令输入栏：/irc status|say|connect|disconnect|restart|models|model|help
 *   - 无法识别为命令的输入自动当作 /irc say 发送到频道
 *   - 命令历史（上下键）预留
 *
 * 依赖：React.createElement（无 JSX），slots + timer 服务。
 */
return {
  inject: ['slots', 'timer'],
  apply: function (ctx) {
    var slots = ctx.get('slots')
    if (!slots) return

    var ircMessages = []
    var stickyMessages = []
    var panelVisible = false
    var connStatus = 'unknown'
    var autoScroll = true // 默认开启：自动跟随滚动到底部
    var commandHistory = []
    var historyIndex = -1
    var overlayDisposer = null
    var statusDisposer = null
    var listeners = new Set()

    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn) } }
    function notify() { listeners.forEach(function (fn) { try { fn() } catch (e) { } }) }

    function getStyle() {
      var w = typeof window !== 'undefined' ? window.innerWidth : 768
      var h = typeof window !== 'undefined' ? window.innerHeight : 1024
      var isMobile = w < 768
      var safeBottom = 0
      if (typeof window !== 'undefined' && window.visualViewport) { safeBottom = Math.max(0, (window.visualViewport.height || h) - h) }
      if (isMobile) return { position: 'fixed', left: '5px', right: '5px', bottom: (safeBottom + 10) + 'px', width: 'auto', maxHeight: Math.max(240, h - safeBottom - 60) + 'px', background: '#1a1a2e', border: '1px solid #444', borderRadius: '12px', zIndex: 9997 }
      return { position: 'fixed', right: '20px', bottom: '60px', width: '500px', maxHeight: Math.max(340, h - 100) + 'px', background: '#1a1a2e', border: '1px solid #333', borderRadius: '12px', zIndex: 9997 }
    }

    function formatTime(ts) {
      if (!ts) return ''
      try { var d = new Date(ts); if (isNaN(d.getTime())) d = new Date(parseInt(ts)); return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) } catch (e) { return '' }
    }

    function scrollToBottom() {
      function doScroll() { try { var el = document.getElementById('irc-msg-list'); if (el) el.scrollTop = el.scrollHeight } catch (e) { } }
      doScroll()
      if (window.requestAnimationFrame) { window.requestAnimationFrame(function () { doScroll() }) }
      setTimeout(doScroll, 60)
      setTimeout(doScroll, 200)
    }

    function handleScroll(e) {
      var el = e.target
      var atBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 30
      if (atBottom && !autoScroll) { autoScroll = true; notify() }
      else if (!atBottom && autoScroll) { autoScroll = false; notify() }
    }

    function toggleAutoScroll() { autoScroll = !autoScroll; if (autoScroll) scrollToBottom(); notify() }
    function goToBottom() { autoScroll = true; notify(); scrollToBottom() }

    async function fetchMessages() {
      try { var r = await host.call('get-irc-messages'); if (r && Array.isArray(r)) { ircMessages = r.slice(-1000); notify(); if (autoScroll) scrollToBottom() } } catch (e) { }
    }

    async function refreshStatus() {
      try { var s = await host.call('get-irc-status'); if (s) connStatus = s.connected ? 'connected' : 'disconnected'; notify(); return s } catch (e) { }
    }

    // sticky 消息最多 3 条（顶部区域），超出丢弃最旧
    function pushSticky(sender, text) {
      stickyMessages.unshift({ id: 'sticky-' + Date.now(), sender: sender, text: text, ts: new Date().toISOString() })
      if (stickyMessages.length > 3) stickyMessages.length = 3
      notify()
    }

    function pushMsg(sender, text) {
      ircMessages.push({ id: Date.now() + Math.random(), sender: sender, text: text, ts: new Date().toISOString() })
      if (ircMessages.length > 1000) ircMessages.splice(0, ircMessages.length - 1000)
      notify()
      if (autoScroll) scrollToBottom()
    }

    async function callTool(name, params) {
      try { var r = await host.call('execute-tool', { name: name, params: params || {} }); if (r && r.success) pushMsg('Tool', name + '(' + JSON.stringify(params, null, 2) + ')\n' + String(r.output).substring(0, 4000)); else pushMsg('Error', (r && r.error) || 'Unknown error') } catch (e) { pushMsg('Error', e.message || 'tool failed') }
    }

    async function loadSkill(name) {
      try { var r = await host.call('get-skill', { name: name }); if (r && r.success) pushMsg('Skill', '# ' + r.name + '\n\n' + (r.instructions || '')); else pushMsg('Error', (r && r.error) || 'Skill not found') } catch (e) { pushMsg('Error', e.message || 'skill failed') }
    }

    async function listSkills() {
      try { var r = await host.call('list-skills'); if (r && r.success) { var ls = ['## Skills\n', '```']; r.skills.forEach(function (s) { ls.push('- **' + s.name + '**: ' + (s.description || '').substring(0, 80)) }); ls.push('```'); pushMsg('Skills', ls.join('\n')) } else pushMsg('Error', 'Failed to list skills') } catch (e) { pushMsg('Error', e.message || 'list skills failed') }
    }

    function ircControl(action) {
      host.call('irc-control', { action: action }).then(function (r) {
        pushMsg('Tool', (r && r.success ? '[OK] ' : '[FAIL] ') + action + (r && r.output ? '\n' + r.output : ''))
        setTimeout(refreshStatus, 800)
      }).catch(function (e) { pushMsg('Error', e.message || 'irc-control failed') })
    }

    function ircSay(text) {
      host.call('irc-send', { text: text }).then(function (r) {
        if (r && r.success) pushSticky('IRC Send', '✅ 已加入发送队列: ' + text)
        else pushSticky('Error', '发送失败: ' + (r && r.error || 'Unknown error'))
      }).catch(function (e) { pushSticky('Error', '发送失败: ' + e.message) })
    }

    // processCommand: 已知命令执行；其余输入自动当作 /irc say 发送到频道
    function processCommand(cmd) {
      cmd = cmd.trim()
      if (!cmd) return
      commandHistory.unshift(cmd); historyIndex = -1
      var parts = cmd.split(' ')
      var first = parts[0].toLowerCase()

      if (first === '/skills' && (parts.length < 2 || parts[1] === 'list')) { listSkills(); return }
      if (first === '/skill' && parts[1]) { loadSkill(parts.slice(1).join(' ')); return }
      if (first === '/tools' || first === '/tool') {
        if (parts.length > 2 && parts[1] === 'list') callTool('mcp__litellm__mysql-get_database_summary', { max_tables: 30 })
        else if (parts.length >= 3) {
          var tn = parts[1]
          var as = cmd.substring(tn.length + 6).trim()
          try { callTool(tn, JSON.parse(as)) } catch (e2) {
            var kv = {}
            as.split(' ').forEach(function (p) { if (p.includes('=')) { var k = p.split('=')[0]; var v = p.split('=').slice(1).join('='); try { kv[k] = JSON.parse(v) } catch (e3) { kv[k] = v } } })
            callTool(tn, Object.keys(kv).length > 0 ? kv : {})
          }
        }
        else callTool('mcp__litellm__mysql-get_database_summary', {})
        return
      }

      if (first === '/irc') {
        var ircCmd = parts[1]

        if (ircCmd === 'help') {
          pushSticky('IRC Help',
            '📝 IRC 帮助\n\n以下是 IRC 面板支持的命令:\n\n' +
            '  /irc status       - 查看 IRC 连接状态 (固定显示)\n' +
            '  /irc say <text>   - 发送消息到 #xia 频道\n' +
            '  /irc connect      - 启动 IRC bot\n' +
            '  /irc disconnect   - 停止 IRC bot\n' +
            '  /irc restart      - 重启 IRC bot (supervisor 会自动复活)\n' +
            '  /irc models       - 列出当前可用的 LLM 模型\n' +
            "  /irc model <name> - 切换 IRC bot 模型 (例:'/irc model deepseek-v4-flash-cloud')\n" +
            '  /irc help         - 显示此帮助信息\n\n' +
            '其他:\n' +
            '  /skills list      - 列出可用技能\n' +
            '  /skill <name>     - 查看技能详情\n' +
            '  /tool list        - 快速查看数据库信息\n' +
            "  /tool <name> {json} - 调用 MCP/DSH 工具\n\n" +
            '💡 提示: 输入不是命令的文本会自动发送到频道')
          return
        }

        if (ircCmd === 'say') {
          var sayText = parts.slice(2).join(' ').trim()
          if (!sayText) { pushSticky('Error', '用法: /irc say <text>'); return }
          ircSay(sayText)
          return
        }

        if (ircCmd === 'status') {
          refreshStatus().then(function (s) {
            var st = '🔍 IRC 状态\n\n' +
              '连接: ' + (connStatus === 'connected' ? '✅ 已连接' : connStatus === 'disconnected' ? '❌ 断开' : '⚠️ 未知') + '\n'
            if (s) {
              st += '服务器: ' + (s.server || 'N/A') + '\n'
              st += 'Nick: ' + (s.nick || 'N/A') + '\n'
              st += '频道: ' + (s.channel || 'N/A') + '\n'
              if (s.rounds !== undefined) st += '回合数: ' + s.rounds + '\n'
              if (s.replies !== undefined) st += '回复数: ' + s.replies + '\n'
              if (s.model) st += '当前模型: ' + s.model + '\n'
              if (s.mcpToolTotal !== undefined) st += 'MCP 工具: ' + s.mcpToolTotal + '\n'
            }
            pushSticky('IRC Status', st)
          })
          return
        }

        if (ircCmd === 'models') {
          host.call('get-irc-models').then(function (r) {
            if (!r || !r.success) { pushSticky('Error', '获取模型列表失败: ' + (r && r.error || 'Unknown')); return }
            var mlist = r.models || []
            if (mlist.length === 0) { pushSticky('Models', '没有可用的 LLM 模型'); return }
            var ls = ['🛠️ 可用 LLM 模型 (' + mlist.length + '个)\n']
            var grouped = {}
            mlist.forEach(function (m) { var ctx = String(m.context_window); if (!grouped[ctx]) grouped[ctx] = []; grouped[ctx].push(m.name) })
            Object.keys(grouped).sort(function (a, b) { return parseInt(b) - parseInt(a) }).forEach(function (ctx) {
              ls.push('\n  ┌ Context Window: ' + ctx.toLocaleString() + '\n')
              grouped[ctx].slice(0, 15).forEach(function (mn) { ls.push('     ▸ ' + mn) })
              if (grouped[ctx].length > 15) ls.push('     ... and ' + (grouped[ctx].length - 15) + ' more')
            })
            ls.push('\n📤 切换模型:\n  /irc model <model_name>')
            pushSticky('Models', ls.join('\n'))
          }).catch(function (e) { pushSticky('Error', '获取模型失败: ' + e.message) })
          return
        }

        if (ircCmd === 'model') {
          var mn = parts.slice(2).join(' ').trim()
          if (!mn && parts.length >= 3) mn = parts[2] || ''
          if (!mn || mn.length < 1) { pushSticky('Error', '请指定模型:\n  /irc model <model_name>\n\n使用 \'/irc models\' 查看可用模型'); return }
          host.call('irc-control', { action: 'switch-model', modelName: mn }).then(function (r) {
            if (r && r.success) pushSticky('Model Switched', '✅ ' + (r.message || '模型已切换'))
            else pushSticky('Error', '切换模型失败: ' + (r && r.error || 'Unknown error'))
          }).catch(function (e) { pushSticky('Error', '切换模型失败: ' + e.message) })
          return
        }

        // 未知 /irc 子命令 -> 当作 say
        ircSay(cmd)
        return
      }

      // 无法识别为命令 -> 自动当作 /irc say 发送到频道
      ircSay(cmd)
    }

    function togglePanel() { if (panelVisible) closePanel(); else openPanel() }

    function openPanel() {
      if (panelVisible) return
      panelVisible = true
      if (!overlayDisposer) { overlayDisposer = slots.inject('shell.overlay', function () { return slots.register({ name: 'shell.overlay', id: 'irc-chat-panel' }, Panel) }) }
      if (!statusDisposer) statusDisposer = ctx.interval(refreshStatus, 5000)
      refreshStatus(); fetchMessages(); notify()
      // 打开面板即滚到底部，自动滚动开启
      autoScroll = true
      setTimeout(scrollToBottom, 100)
      setTimeout(scrollToBottom, 300)
    }

    function closePanel() {
      panelVisible = false
      if (overlayDisposer) { overlayDisposer(); overlayDisposer = null }
      if (statusDisposer) { statusDisposer(); statusDisposer = null }
      notify()
    }

    function Panel() {
      var s = React.useState(0)
      React.useEffect(function () { return subscribe(function () { s[1](function (t) { return t + 1 }) }) }, [])
      return renderBody()
    }

    function renderStickyMessages() {
      if (!stickyMessages || stickyMessages.length === 0) return null
      var items = []
      for (var i = 0; i < stickyMessages.length; i++) {
        var msg = stickyMessages[i]
        ;(function (idx) {
          items.push(React.createElement('div', { key: msg.id, style: { padding: '8px 14px', marginBottom: '6px', borderRadius: '8px', background: '#0d2137', borderLeft: '3px solid #4fc3f7' } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } },
              React.createElement('span', { style: { fontWeight: 600, fontSize: '12px', color: '#4fc3f7' } }, msg.sender),
              React.createElement('button', { onClick: function () { stickyMessages.splice(idx, 1); notify() }, style: { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '14px', padding: '2px 6px' } }, '×')
            ),
            React.createElement('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#ccc', fontSize: '12px', lineHeight: '1.6' } }, msg.text || '')
          ))
        })(i)
      }
      return React.createElement('div', null, items)
    }

    function renderBody() {
      var mob = typeof window !== 'undefined' ? window.innerWidth < 768 : false
      var style = getStyle()

      var hdr = [
        React.createElement('div', { key: 'si', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          React.createElement('span', { style: { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block', background: connStatus === 'connected' ? '#4caf50' : connStatus === 'disconnected' ? '#f44336' : '#ff9800' } }),
          React.createElement('span', { style: { color: '#e0e0e0', fontSize: mob ? '14px' : '15px', fontWeight: 600, userSelect: 'none' } }, '#xia'),
          connStatus === 'connected' ? React.createElement('span', { key: 'ot', style: { fontSize: '11px', color: '#4caf50' } }, '(online)') : null),
        React.createElement('button', { key: 'cb', onClick: function () { closePanel() }, style: { background: 'none', border: '1px solid #555', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', color: '#e0e0e0', fontSize: mob ? '13px' : '14px', userSelect: 'none' } }, 'X')
      ]

      var scrollBar = React.createElement('div', { key: 'scrollbar', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 12px', background: '#0d0d1a', borderBottom: '1px solid #2a2a4e' } },
        React.createElement('button', { onClick: toggleAutoScroll, style: { background: 'none', border: 'none', color: autoScroll ? '#4fc3f7' : '#888', cursor: 'pointer', fontSize: '11px', padding: '2px 4px', userSelect: 'none' } }, autoScroll ? '📌 自动滚动: 开' : '📌 自动滚动: 关'),
        React.createElement('button', { onClick: goToBottom, style: { background: 'none', border: 'none', color: '#4caf50', cursor: 'pointer', fontSize: '11px', padding: '2px 4px', userSelect: 'none' } }, '⬇ 到底部')
      )

      var mlc
      if (ircMessages.length === 0) mlc = React.createElement('div', { style: { color: '#666', textAlign: 'center', padding: '40px 20px', fontSize: '13px' } }, '暂无 IRC 消息')
      else mlc = ircMessages.map(function (msg) {
        var ib = msg.sender === 'deepseek_ai'
        var bg, bL, nC
        if (ib) { bg = '#0f3460'; bL = '3px solid #00d9ff'; nC = '#00d9ff' }
        else if (msg.sender === 'Tool') { bg = '#1e1e3f'; bL = '3px solid #ffd700'; nC = '#ffd700' }
        else if (msg.sender === 'Error') { bg = '#3f1e1e'; bL = '3px solid #ff4444'; nC = '#ff4444' }
        else { bg = '#16213e'; bL = '3px solid #555'; nC = '#aaa' }
        return React.createElement('div', { key: msg.id || msg.sender, style: { padding: mob ? '8px 10px' : '6px 12px', marginBottom: '4px', borderRadius: '6px', background: bg, borderLeft: bL, fontSize: '13px' } },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' } },
            React.createElement('span', { style: { fontWeight: 600, fontSize: '12px', color: nC } }, msg.sender),
            React.createElement('span', { style: { fontSize: '10px', color: '#555' } }, formatTime(msg.ts))),
          React.createElement('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: ib ? '#ccc' : '#ddd', fontSize: '13px' } }, msg.text || ''))
      })

      var inp = [
        React.createElement('span', { key: 'pr', style: { color: '#4caf50', fontSize: mob ? '12px' : '13px', fontWeight: 600, userSelect: 'none', whiteSpace: 'nowrap' } }, '> '),
        React.createElement('input', { key: 'in', id: 'irc-cmd-input', type: 'text', placeholder: mob ? '/irc help' : '/irc help /say /models /model <name>', style: { flex: 1, background: '#2a2a4e', border: '1px solid #444', borderRadius: '4px', padding: mob ? '6px 8px' : '6px 10px', color: '#e0e0e0', fontSize: mob ? '12px' : '13px', outline: 'none' }, onKeyDown: function (e) { if (e.key === 'Enter') { var i = document.getElementById('irc-cmd-input'); if (i && i.value.trim()) { processCommand(i.value); i.value = ''; scrollToBottom() } } } }),
        React.createElement('button', { key: 'sb', onClick: function () { var i = document.getElementById('irc-cmd-input'); if (i && i.value.trim()) { processCommand(i.value); i.value = ''; scrollToBottom() } }, style: { background: '#16213e', border: '1px solid #444', borderRadius: '4px', padding: mob ? '6px 10px' : '6px 12px', color: '#4caf50', cursor: 'pointer', fontSize: mob ? '12px' : '13px', userSelect: 'none', whiteSpace: 'nowrap' } }, mob ? '>' : 'send')
      ]

      return React.createElement('div', { key: 'panel', style: style },
        React.createElement('div', { key: 'hdr', style: { padding: mob ? '10px 14px' : '12px 16px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#16213e' } }, hdr),
        React.createElement('div', { key: 'sticky', id: 'irc-sticky-area', style: { padding: mob ? '8px 10px' : '8px 12px', borderBottom: '1px solid #2a2a4e', maxHeight: '35vh', overflowY: 'auto', background: '#0d0d1a' } }, renderStickyMessages()),
        scrollBar,
        React.createElement('div', { key: 'msgs', id: 'irc-msg-list', onScroll: handleScroll, style: { overflowY: 'auto', maxHeight: mob ? Math.max(160, window.innerHeight - 240) + 'px' : '380px', padding: mob ? '10px' : '0' } }, mlc),
        React.createElement('div', { key: 'ibar', style: { padding: mob ? '8px 10px' : '8px 12px', borderTop: '1px solid #333', display: 'flex', gap: '6px', background: '#111' } }, inp),
        React.createElement('div', { key: 'ftr', style: { padding: '4px 14px', fontSize: '9px', color: '#555', textAlign: 'center', background: '#0a0a15' } }, 'IRC #xia - ' + ircMessages.length + ' msgs - /irc help /irc say /models /model <name>')
      )
    }

    slots.inject('sidebar.footer.action', function () {
      return slots.register({ name: 'sidebar.footer.action', id: 'irc-toggle' }, function (props) {
        return React.createElement('button', { onClick: function (e) { e.stopPropagation(); fetchMessages(); togglePanel() }, title: 'IRC Chat' }, React.createElement('span', null, 'IRC'))
      })
    })

    ctx.interval(fetchMessages, 3000)
    fetchMessages()
  },
}
