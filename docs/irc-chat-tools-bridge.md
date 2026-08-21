# IRC Chat + Slash Commands — Cordis 插件 `irct-4`

> **状态：** ✅ 运行中（`irct-4/pkg-26`，currentPackageId: pkg-26）  
> **最新版本特性（pkg-26）：** 面板打开即滚到底部 + 自动滚动默认开启 + 无法识别输入自动当作 `/irc say` 发送到频道 + sticky 顶部消息最多 3 条 + `/irc say` 面板消息发送到频道（`irc-send` handler，`fs.writeText` + danger-full-access policy）+ 稳健滚动到底（多帧 `scrollToBottom`）+ 自动跟随滚动开关（📌 toggle + ⬇ 到底部）+ 1000 条消息上限 + sticky 状态/帮助/模型列表 + `fs.resolve()` 修复 + 真实 NDJSON 解析器 + `slots.inject` disposer 关闭 + pub/sub 实时重渲染 + IRC bot 工具调用（MCP 随系统配置 + 动态模型 + 82 个 MCP 工具）
> **关联文档：**
> - `docs/irc-real-bot.md` — 真实 IRC bot（TCP 直连 #xia）
> - `docs/cordis-plugin-irc-completion.md` — Cordis 逻辑会话插件版

## 1. 概述

IRC Chat Plugin (`irct-4`) 是一个动态 Cordis Plugin，将 IRC `#xia` 频道的聊天记录同步到 DSH Web GUI，并提供**斜杠命令系统**。用户可以在侧栏浮动面板中实时查看 IRC 对话，通过 `/irc` 命令控制 bot 状态、设置模型、列出会话等。

## 2. 架构概览

```
┌───────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│   IRC Bot     │────▶│    Cordis Host   │────▶│   DSH Web GUI        │
│ (irc-bot.js)  │     │  (irct-4 Plugin) │     │   (IRC Chat Panel)   │
│               │     │                  │     │                      │
│ • TCP → #xia  │     │ • get-irc-messages│    │ • IRC 消息流          │
│ • FIFO buffer │     │ • execute-tool   │    │ • /skills list        │
│ • LLM reply   │     │ • get-skill      │    │ • /tool <name> {json} │
│               │     │ • list-skills    │    │ • 命令输入栏           │
└───────────────┘     └──────────────────┘     └──────────────────────┘
```

### 2.1 Host（服务端）职责

- **IRC 日志读取**：`harness.handle('get-irc-messages')` → `fs.readText()` 解析 NDJSON。
- **工具执行桥接**：`harness.handle('execute-tool')` → `ctx.tools.get(name).execute(params)`，将 Client 请求转发到系统 Tool 注册表。
- **Skills 集成**：`harness.handle('get-skill')` / `'list-skills'` → `ctx.skills.get(name)` / `.list({})`。
- **斜杠命令处理**：通过 Client 面板输入栏的 `processCommand()` 解析 `/irc`、`/skill`、`/tool` 等命令（见 §13）。

### 2.2 Client（浏览器端）职责

- **浮动面板 UI**：注册在 `sidebar.footer.action`（侧栏底部 💬 按钮）和 `shell.overlay`（覆盖层）。
- **compact ↔ expanded 模式切换**：移动端默认显示为圆形按钮，点击展开完整面板。
- **命令输入栏**：底部输入框支持 `/skills list`、`/skill <name>`、`/tool <name> {json}` 等命令。
- **消息轮询刷新**：每 3000ms 通过 `host.call('get-irc-messages')` 拉取最新 IRC 对话记录（保留最近 **1000** 条，pkg-17）。

## 3. Slash Commands（斜杠命令）+ 面板命令系统

### 3.1 IRC Bot 控制命令（通过 `/irc` 前缀）

| 命令 | 参数 | 功能 |
|------|------|------|
| `/irc status` | — | 显示 IRC bot 连接状态、服务器地址、频道、当前模型（sticky 固定显示） |
| `/irc help` | — | 列出所有可用命令（sticky 固定显示） |
| `/irc say <text>` | 任意文本 | 发送消息到 `#xia` 频道（通过 bot 的 outbox 队列，pkg-20+） |
| `/irc models` | — | 列出 LiteLLM 配置中所有可用模型（按 context window 分组） |
| `/irc model <name>` | `qwen3-8b` / `deepseek-v4-flash-cloud` 等 | 切换 IRC bot 使用的模型并自动重启 bot（默认动态跟随 DSH 最近使用模型，见 §14.2） |
| `/irc connect` | — | 启动 IRC bot 连接到 `192.168.4.252:6667` |
| `/irc disconnect` | — | 断开 IRC bot 连接 |
| `/irc restart` | — | 重启 IRC bot 进程（supervisor 自动复活） |

> **注意（pkg-24）：** 已知命令（`/skills`、`/skill`、`/tool`、`/irc ...`）正常执行；**无法识别为命令的输入**（不以 `/` 开头，或未知 `/irc` 子命令）会**自动当作 `/irc say <text>` 发送到频道**。用户在输入栏输入任意文本即发送到 `#xia`。

### 3.2 Skills + Tools 命令（通过面板输入栏）

| 类别 | 语法 | 示例 |
|------|------|------|
| **Skills** | `/skills list` | 列出所有可用技能 |
| **Skills** | `/skill <name>` | 加载指定技能的完整指令 |
| **Tools** | `/tool <name> {json}` | 执行系统 MCP 工具（pkg-16 起统一走此格式） |

### 3.3 常用示例

```bash
# IRC bot 管理
/irc status            # 检查 bot 连接状态
/irc connect           # 启动 IRC bot

# Skills
/skills list           # 查看所有可用技能
/skill cordis-plugin-development   # 加载 Cordis 插件开发技能指令

# Tools（通过 execute-tool RPC）
/tool mcp__litellm__mysql-get_database_summary {"max_tables": 30}
/tool bash {"command": "ls -la"}
```

## 4. Web GUI 面板功能

### 4.1 触发方式

- 点击侧栏底部 **「💬 IRC Chat」** 按钮打开浮动面板。

### 4.2 IRC 消息 Tab

| 元素 | 说明 |
|------|------|
| **头部** | 标题 "IRC Chat" + 关闭按钮 ✕ |
| **消息列表** | 滚动区域，显示解析后的 NDJSON 事件（recv/send/llm-reply），每条带 sender、文本内容 |
| **底部状态栏** | `✅ Connected \| N messages` 或 `⏳ Loading...` |

### 4.3 Web GUI 面板功能（pkg-7+）

#### 触发方式
- **桌面端**：点击侧栏底部「💬 IRC Chat」按钮打开浮动面板。
- **移动端**：面板以圆形 `💬` 按钮悬浮在输入框上方，点击进入 expanded 模式。

#### 面板结构（expanded 模式）
| 区域 | 内容 |
|------|------|
| **头部栏** | 🟢/🟡/🔴 连接状态点 + `#xia` 频道名 + ✕ 关闭按钮 |
| **消息列表** | 滚动区域，IRC recv/send/llm-reply 事件按时间顺序排列 |
| **命令输入栏** | `> [文本框] [发送按钮]`，支持 Enter 快捷提交 |
| **底部状态条** | 显示 IRC #xia、消息计数、可用命令提示 |

#### 消息类型样式（pkg-11）
| sender | 背景 | 左边框 | 用途 |
|--------|------|--------|------|
| `deepseek_ai` | #0f3460 | 青蓝 | IRC bot LLM 回复 |
| `lucloner` / 其他 nick | #16213e | 灰 | IRC 用户消息 |
| 🔧 Tool | #1e1e3f | 金 | MCP 工具执行结果 |
| 📚 Skill / Skills | #1a1e3f | 蓝 | Skills 加载/列表结果 |
| ❌ Error | #3f1e1e | 红 | 错误信息 |

### 4.4 compact ↔ expanded 模式切换（pkg-7+）

IRC 消息每 3000ms 自动拉取最新 NDJSON 日志并解析，保留最近 **1000** 条（pkg-17）。连接状态每 5000ms 更新。

#### 渲染逻辑
| 条件 | 显示内容 |
|------|----------|
| `panelVisible = false` + 移动端 | 圆形 💬 按钮（36×36px），点击 → openPanel() |
| `panelVisible = true` | 完整面板：header + messages + command input bar + footer |
| Desktop | 始终显示完整面板，无 compact 模式 |

#### slots.inject disposer 生命周期（pkg-13+）
```
openPanel():
  ├─ panelVisible = true
  ├─ overlayDisposer = slots.inject('shell.overlay', () => register(..., Panel))
  ├─ statusDisposer = ctx.interval(refreshStatus, 5000)
  └─ refreshStatus() + fetchMessages()   ← 立即刷新（pkg-14）

closePanel():
  ├─ panelVisible = false
  ├─ overlayDisposer()   ← disposer 移除 overlay（pkg-13，不再用不存在的 slots.remove）
  └─ statusDisposer()    ← 停止状态轮询
```

## 5. 数据流详解

```
Client (IRC Chat Tab) 
  │
  ├─ ctx.interval(3000ms) → fetchMessages()
  │     │
  │     └─ host.call('get-irc-messages')
  │           │
  │           ▼
  │       Host: harness.handle('get-irc-messages')
  │         ├─ fs.readText('/home/lucloner/.dsh/irc-bot/conversation.ndjson')
  │         ├─ split('\n').filter(Boolean)
  │         └─ parse each line → extract event type, sender, text
  │
  ▼
Client: ircMessages[] updated (slice(-1000), pkg-17)
```

## 6. NDJSON 日志格式（conversation.ndjson）

> ⚠️ **pkg-13 起修正**：`irc-bot.js` 实际写入的格式是扁平 `{ev, ...}`，不是早期文档假设的 `{type, event}` 嵌套结构。pkg-13 的 `get-irc-messages` 解析器已按真实格式解析。

每条记录结构（`irc-bot.js` 的 `log(ev, data)` 写入）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ts` | string (ISO-8601) | 事件时间戳 |
| `ev` | string | 事件类型：`connected` / `registered` / `joined` / `recv` / `send` / `tool` / `llm-error` / `socket-error` / `disconnected` / `reconnect-in` / `connect-error` / `server-error` / `shutdown` |
| `from` | string | 发送者 nick（仅 `recv`） |
| `text` | string | IRC PRIVMSG 内容（`recv`/`send`） |
| `name` / `args` / `result` | string | 工具调用信息（仅 `tool`） |

**面板解析规则（pkg-13 `get-irc-messages`）：**
```javascript
// recv → 用户消息
{ "ts": "...", "ev": "recv", "from": "nanoclaw", "text": "Hello" }
→ { sender: 'nanoclaw', text: 'Hello' }

// send → bot 回复
{ "ts": "...", "ev": "send", "text": "你好！" }
→ { sender: 'deepseek_ai', text: '你好！' }

// tool → 工具调用
{ "ts": "...", "ev": "tool", "name": "run_command", "args": "{\"command\":\"ls\"}", "result": "..." }
→ { sender: 'Tool', text: 'run_command({"command":"ls"}) -> ...' }
```

## 7. 配置参考（irc.json）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `server.host` | `"192.168.4.252"` | IRC 服务器地址 |
| `server.port` | `6667` | TCP 端口（明文） |
| `nick` | `"deepseek_ai"` | Bot nick |
| `user` | `"deepseekai"` | IRC user（USERLEN=10） |
| `channel` | `"#xia"` | 加入的频道 |
| `llm.base` | `"http://127.0.0.1:4000/v1"` | LiteLLM proxy endpoint |
| `llm.model` | `"n_qwen3.8"` | LLM model 回退值（bot 默认动态跟随 DSH 最近使用模型，见 §14.2） |
| `logDir` | `"/home/lucloner/.dsh/irc-bot"` | NDJSON 日志目录 |

## 8. 文件路径索引

| 路径 | 用途 |
|------|------|
| `irc-bot/irc.json` | Bot 配置文件（nick, channel, LLM route, reply settings） |
| `irc-bot/irc-bot.js` | Bot 主程序（TCP connect + FIFO buffer + LLM reply） |
| `/home/lucloner/.dsh/irc-bot/conversation.ndjson` | IRC 事件日志（被 cordis plugin 读取） |
| `/home/lucloner/.dsh/irc-bot/status.json` | Bot 实时状态快照（connected/nick/channel/bufferLen/replies） |

## 9. 插件版本历史与清理记录

### 当前运行中的插件

| 插件 ID | PackageId | 状态 | 说明 |
|---------|-----------|------|------|
| **`irct-4`** | **pkg-26** (current) | ✅ running | IRC Chat v25 — 面板打开即滚到底 + 自动滚动默认开 + 无法识别输入自动 say + sticky 3 条上限 + `/irc say` 发送到频道 + 稳健滚动 + 1000 条上限 + 模型切换 |

### 中间迭代版本（未删除，可 rollback）

| PackageId | 说明 | 关键改进 / 遗留问题 |
|-----------|------|---------------------|
| pkg-4 | IRC Chat v4 — 初始成功版 | slots.register name + timer inject 修复 ✅ |
| pkg-5 | IRC Chat v5 — Mobile Responsive | 响应式定位，但关闭按钮事件冒泡导致无效 ❌ |
| pkg-6 | IRC Chat v6 — Optimized Mobile Panel | compact/expanded toggle 逻辑优化，但仍受事件冒泡影响 ❌ |
| **pkg-7** | **IRC Chat v7 — Fixed Close Button** | **移除容器 onClick，按钮统一 stopPropagation ✅** |
| pkg-8 | IRC Chat v8 — Proper slot removal | slots.remove + inject 生命周期修复 ✅ |
| pkg-9 | IRC Chat v9 — MCP Tool Execution | Host harness.handle('execute-tool') 注册 ✅ |
| pkg-10 | IRC Chat v10 — Command Input Bar | 命令输入栏 + processCommand() 解析器 ✅ |
| **pkg-11** | **IRC Chat v11 — Skills Integration** | **/skills list + /skill <name> 完整集成 ctx.skills service ✅** |

### 已删除的失败插件

| 插件 ID | PackageId | Error | 根因 | 清理时间 |
|---------|-----------|-------|------|----------|
| `irc-1` | pkg-1 | `slots.register options need a string name` | 缺少 `{ name: 'slotKey' }` 选项 | ✅ 已删除 |
| `irc-2` | pkg-2 | `service "timer" is not declared` | client code 使用 `ctx.interval()` 但未在 inject 声明 `'timer'` | ✅ 已删除 |
| `irc-3` | pkg-3 | same timer error as irc-2 | 同上 | ✅ 已删除 |

## 10. 关键修复记录

### 问题 #4: 面板 status 误报 disconnect（pkg-13 → pkg-14）

**错误表现：**
IRC 聊天面板头部状态点显示红点 / `/irc status` 输出 "IRC 状态: disconnected"，但 bot 实际已连接（`status.json` 的 `connected:true`、进程运行、已 JOIN #xia）。

**根因分析：**
```
get-irc-status handler:
  fs.readText(LOG + '/status.json')   ← 传原始字符串路径
        │
        ▼
  readText(target: FsTarget) 需要 { displayPath, targetKey } 对象
  传字符串 → target.displayPath / target.targetKey 均为 undefined
        │
        ▼
  readWholeText({displayPath: undefined, targetKey: undefined}) 必然失败
        │
        ▼
  catch → return { connected: false }  →  面板显示 disconnect
```

Cordis 的 `ctx.fs.readText()` 签名是 `readText(target: FsTarget)`，需要 `{displayPath, targetKey}` 对象，**不接受原始字符串路径**。`get-irc-messages` 也有同样问题。

**修复方式（pkg-14）：**
1. 两个 handler 都改为 `await ctx.fs.resolve(路径)` 得到 `FsTarget` 再传给 `readText`：
   ```js
   const target = await fs.resolve(LOG + '/status.json')
   const content = await fs.readText(target)
   ```
2. Client `openPanel()` 立即调用 `refreshStatus()` + `fetchMessages()`，不再等 5s 间隔才首次刷新。

### 问题 #3: 关闭按钮点击无效（pkg-5 / pkg-6 → pkg-7）

**错误表现：**
点击面板右上角的 ✕ 关闭按钮后，面板重新弹开。

**根因分析：**
```
外层容器 onClick → togglePanel() → panelExpanded = true → showOverlay()
     ↑                                      │
     └──── closePanel() 设置 false ◄────────┘
```
1. pkg-5/pkg-6 在外层 `div` 上注册了 `onClick: togglePanel()`
2. 关闭按钮点击触发 `hideOverlay()`，将 `panelExpanded = false` 并移除 overlay
3. **事件冒泡**到外层容器 → `togglePanel()` 再次执行 → `panelExpanded = true` → 重新调用 `showOverlay()`
4. 结果：关闭后立即弹开

**修复方式（pkg-7）：**
1. **移除**容器级 onClick，改为两种互斥渲染模式：
   - Compact 模式（`!panelVisible`）：仅显示圆形按钮
   - Expanded 模式（`panelVisible`）：显示 header + messages + footer
2. **所有按钮统一添加 `e.stopPropagation()`**：
   ```js
   // Sidebar button
   onClick: function(e) { e.stopPropagation(); fetchMessages(); openPanel(); }

   // Close button  
   onClick: function(e) { e.stopPropagation(); closePanel(); }

   // Compact circle button
   onClick: function(e) { e.stopPropagation(); openPanel(); }
   ```
3. **重构为共享 render 函数**，避免闭包状态混乱：
   - `renderCompactButton()` — compact 模式按钮
   - `renderHeader()` — header（status dot + channel name + close）
   - `renderMessages()` — 消息列表

### 问题 #2: `ctx.interval()` 未声明 `'timer'` inject（irc-2/pkg-2, irc-3/pkg-3）

**错误信息：**
```
Error: service "timer" is not declared by your plugin. 
Declare it on the plugin you return: { inject: ['timer', …], apply(ctx) { … } }
```

**根因：** Client code 中使用了 `ctx.interval(fetchMessages, 3000)`，但插件返回对象只在 `inject` 数组中声明了 `['slots']`。Cordis 要求所有使用的 Service 必须在 inject 中声明。

### 问题 #1: `slots.register()` 缺少 `name` 选项（irc-1/pkg-1）

**错误信息：**
```
Error: slots.register options need a string 'name' (the target slot key)
```

**根因：** Cordis Client `slots.register()` 要求第一个参数必须包含 `{ name: 'slotKey', id: '...' }`，其中 `name` 是必填的 slot key（如 `'sidebar.footer.action'`、`'shell.overlay'`）。

**修复方式：** 所有 `slots.register()` 调用添加 `name` 字段：
```js
// Before (failed)
slots.register({ id: 'irc-toggle', label: 'IRC' }, ...)

// After (works - irct-4/pkg-4+)
slots.register({ name: 'sidebar.footer.action', id: 'irc-toggle', label: 'IRC' }, ...)
```

## 11. Cordis Plugin 开发关键规则总结

| 规则 | 说明 |
|------|------|
| **Client `ctx.interval()` / `ctx.timeout()`** | 必须在 `inject: ['timer']` 中声明 timer service |
| **Client `slots.register()`** | 第一个参数必须包含 `{ name: 'exact-slot-key', id: '...' }`，`name` 是必填的 slot key |
| **Host `ctx.shell.run()`** | 通过 `harness.handle('method')` + Client `host.call('method')` 通信 |
| **Host `ctx.get('commands')`** | 可选 service，需先 check undefined 再注册命令 |
| **Host `inject: ['fs']`** | 必须声明才能使用 `ctx.fs`（读取 NDJSON 日志） |
| **Host `fs.readText()`** | 签名是 `readText(target: FsTarget)`，**不接受原始字符串路径**。必须先 `await ctx.fs.resolve(path)` 得到 `FsTarget` 再传入（pkg-14 修复） |
| **React onClick stopPropagation** | 嵌套按钮点击事件需加 `e.stopPropagation()` 防止冒泡到外层容器触发意外逻辑（pkg-7 修复） |

## 12. pkg-7 架构变更说明

### 渲染模式切换

```
┌─────────────┐     ┌──────────────┐
│  Compact    │     │  Expanded    │
│  (圆形按钮)  │ ◄─► │  (完整面板)   │
│             │      │              │
│ 💬          │      │ ╔══════════╗ │
│             │      │ ║ ✕ #xia   ║ │
└─────────────┘      │ ╠══════════╣ │
                     │ ║ 消息列表  ║ │
                     │ ╚══════════╝ │
```

### 状态管理（pkg-7 vs pkg-6）

| 特性 | pkg-6 | pkg-7 |
|------|-------|-------|
| `panelExpanded` toggle | ❌ 事件冒泡导致反复弹开 | ✅ 互斥渲染，关闭即移除 overlay |
| `stopPropagation()` | ❌ 仅 header 按钮使用 | ✅ **所有**按钮统一添加 |
| render 函数 | ❌ 内联 JSX/React.createElement | ✅ 提取为共享函数 |
| compact 模式 | 🔘 圆形按钮 + onClick toggle | 🔘 圆形按钮，点击 openPanel() |

## 13. pkg-26 IRC 面板 + Bot 工具调用（当前版本）

### 面板命令系统

IRC 聊天面板底部提供**命令输入栏**，支持以下命令格式：

| 类别 | 命令语法 | 示例 |
|------|----------|------|
| **Skills** | `/skills list` | 列出所有可用技能 |
| **Skills** | `/skill <name>` | 加载指定技能的完整指令 |
| **Tools** | `/tool <name> {json}` | 执行系统 MCP 工具（pkg-16 起统一走此格式，`name: {json}` 冒号格式已移除） |
| **IRC Bot** | `/irc status` | 查看 IRC bot 状态（**固定显示，不自动隐藏**） |
| **IRC Bot** | `/irc help` | 列出所有可用命令 |
| **IRC Bot** | `/irc models` | 列出 LiteLLM 配置中所有可用模型（按 context window 分组） |
| **IRC Bot** | `/irc model <name>` | 切换 bot 的 LLM 模型并自动重启 bot |
| **IRC Bot** | `/irc connect/disconnect/restart` | 控制 bot 生命周期 |

> **pkg-15 新增：sticky 消息区。** 面板顶部新增独立 `stickyMessages` 区域，`/irc status`、`/irc help`、`/irc models`、`/irc model` 的输出都写入这里，**始终固定在面板顶部，不会被新 IRC 消息滚动挤掉**（普通 `pushMsg` 消息仍走下方滚动区，上限 1000 条，pkg-17）。每条 sticky 消息右上角有 `×` 可单独关闭。

### Host RPC Handlers（pkg-26）

| Handler | Service | 用途 |
|---------|---------|------|
| `get-irc-messages` | `ctx.fs.resolve()` + `ctx.fs.readText()` → 真实 NDJSON 解析 | 读取 IRC 聊天日志（`ev`/`from`/`text`/`tool`） |
| `get-irc-status` | `ctx.fs.resolve()` + `ctx.fs.readText(status.json)` | 读取 bot 实时状态（connected/nick/rounds/toolCalls/model） |
| `irc-send` | `ctx.fs.writeText(outbox.ndjson, ..., {mode:'danger-full-access'})` | **pkg-20+** 把消息追加到 bot 的 outbox 队列，bot 每 500ms 读取并发送到频道 |
| `irc-control` | `ctx.shell.resolve()` + `.run()` | 启动/断开/重启 bot；**`switch-model` action** |
| `get-irc-models` | `ctx.fs.resolve()` + `readText(/etc/litellm/config.yaml)` + 正则解析 | 解析 LiteLLM 配置中所有 `model_name` + `context_window` |
| `execute-tool` | `ctx.tools.get(name)` + `.execute()` | 执行任意系统工具 |
| `get-skill` | `ctx.skills.get(name)` | 加载技能指令 |
| `list-skills` | `ctx.skills.list({})` | 列出所有可用技能 |

> **pkg-14 关键修复（面板 status 误报 disconnect）：** `ctx.fs.readText()` 的签名是 `readText(target: FsTarget)`，需要 `{displayPath, targetKey}` 对象。pkg-13 直接传原始字符串路径，`target.displayPath`/`target.targetKey` 均为 `undefined`，读取必然失败 → `get-irc-status` 的 catch 返回 `{connected:false}` → 面板显示红点/disconnect。pkg-14 改为 `await ctx.fs.resolve(路径)` 得到 `FsTarget` 再传给 `readText`。同时 `openPanel()` 现在立即调用 `refreshStatus()` + `fetchMessages()`，不再等 5s 间隔才首次刷新。
>
> **pkg-15 新增：模型切换（`irc-control` 的 `switch-model` action）。** 读取 `irc-bot/irc.json` → 把 `llm.model` 改为目标模型 → 写回 → `pkill -f "irc-bot.js"` 让 supervisor 自动重启 bot 加载新模型。`get-irc-models` 用正则从 `/etc/litellm/config.yaml` 提取 `model_name` 与 `context_window`（当前约 140 个模型），客户端按 context window 分组展示。

### Client 命令解析器（processCommand）

```
输入 → trim()
  ├─ /skills list    → host.call('list-skills')
  ├─ /skill <name>   → host.call('get-skill', {name})
  ├─ /tool <name> {json} → host.call('execute-tool', {name, params})
  ├─ /irc status     → host.call('get-irc-status') → pushSticky('IRC Status')
  ├─ /irc help       → pushSticky('IRC Help') 列出所有命令
  ├─ /irc say <text> → host.call('irc-send', {text}) → pushSticky('IRC Send')
  ├─ /irc models     → host.call('get-irc-models') → pushSticky('Models') 按 ctx 分组
  ├─ /irc model <name> → host.call('irc-control', {action:'switch-model', modelName}) → pushSticky
  ├─ /irc connect|disconnect|restart → host.call('irc-control', {action})
  └─ 其他输入（不以 '/' 开头，或未知 /irc 子命令）→ 自动当作 /irc say 发送到频道 ★ pkg-24
```

> **pkg-16 关键修复（仅 `/` 开头输入作为命令）：** pkg-15 的 `processCommand` 有两个问题——① `if(cmd.indexOf('{')>0)` 分支会把任何包含 `{` 的输入（即使不以 `/` 开头）当作 raw tool call；② 末尾的 `pushMsg('Error','未知命令...')` 会把任何不以 `/` 开头的输入都当作未知命令报错。pkg-16 在 `processCommand` 开头加 `if (cmd.charAt(0) !== '/') return;`，**只有以 `/` 开头的输入才作为命令处理，普通文本直接忽略**；同时移除危险的 raw tool call 分支（工具调用统一走 `/tool <name> {json}`）。
>
> **pkg-24 关键变更（无法识别输入自动当作 `/irc say`）：** 移除 pkg-16 的「不以 `/` 开头直接忽略」规则。现在**已知命令正常执行**；**无法识别为命令的输入**（不以 `/` 开头，或未知 `/irc` 子命令）会**自动当作 `/irc say <text>` 发送到频道**。用户在输入栏输入任意文本即发送到 `#xia`。
>
> **pkg-17 新增：自动跟随滚动开关 + 1000 条消息上限。**
> - **自动跟随滚动**：消息列表上方新增控制条，含「📌 自动滚动: 开/关」toggle 和「⬇ 到底部」按钮。默认开启，新消息到达自动滚到底部；用户手动向上滚动时自动关闭（滚回底部时自动重新开启）；点「⬇ 到底部」立即跳到底部并恢复跟随。
> - **1000 条消息上限**：`ircMessages` 上限从 200 提到 **1000**。Host `get-irc-messages` 返回 `slice(-1000)`，Client `fetchMessages` 用 `slice(-1000)` 兜底，`pushMsg` 新增消息超过 1000 时用 `splice` 丢弃最旧的。
>
> **pkg-19 新增：稳健滚动到底（合并自 `irct-5/pkg-18`）。** 修复「⬇ 到底部」按钮点了却滚不到底的问题。根因是原 `scrollToBottom()` 只用单个 **50ms `setTimeout`** 设置 `scrollTop = scrollHeight`——若浏览器仍在完成布局（长消息换行、React 重渲染、3s 轮询刚推入新消息），50ms 时测得的 `scrollHeight` 是**过期值**，滚到的是「点击瞬间的底部」而非「布局稳定后的真正底部」，底部留白。修复：改为**立即 + `requestAnimationFrame` + 60ms/200ms 双重兜底**的多帧滚动；`goToBottom()` 先 `notify()` 触发重渲染再 `scrollToBottom()`，让多帧兜底在重渲染后仍能钉到真正底部。详见 `docs/irc-scroll-to-bottom-fix.md`。
>
> **pkg-25 新增：sticky 顶部消息最多 3 条。** `pushSticky` 用 `unshift` 添加消息，超过 3 条时 `stickyMessages.length = 3` 丢弃最旧的。IRC 消息列表仍保持 1000 条上限。
>
> **pkg-26 新增：面板打开即滚到底部 + 自动滚动默认开启。** `openPanel()` 强制 `autoScroll = true`，并加 `setTimeout(scrollToBottom, 100/300)` 延迟滚动，确保消息异步加载、布局稳定后仍滚到最底部。

### pkg-13 关键修复

| 问题 | 根因 | 修复 |
|------|------|------|
| 远端 IRC 聊天不显示 | `get-irc-messages` 解析器期望 `{type,event}` 嵌套格式，但 bot 写入扁平 `{ev,from,text}` | 解析器改为匹配真实 NDJSON 格式 |
| 关闭按钮无效 | `slots` 服务只有 `register`/`inject`，`slots.remove()` 不存在 → 抛错 | 改用 `slots.inject()` 返回的 disposer 关闭 |
| 输入/新消息无反应 | 面板读闭包变量 `ircMessages`，无 React 状态触发重渲染 | 加 pub/sub（`subscribe`/`notify`）+ `Panel` 组件 `useState` 订阅 |
| `/irc status` 无响应 | host 未定义 `get-irc-status` handler | 新增 `get-irc-status` |
| `/irc connect/disconnect` 无响应 | host 未定义 `run-command` handler | 新增 `irc-control`（用 `ctx.shell`） |

### 消息样式映射（pkg-13）

| sender | 背景色 | 左边框 | 名称颜色 |
|--------|--------|--------|----------|
| `deepseek_ai` (bot) | #0f3460 | 3px solid #00d9ff | #00d9ff (青蓝) |
| `lucloner` (user) | #1a3a2e | 3px solid #4caf50 | #4caf50 (绿) |
| Tool | #1e1e3f | 3px solid #ffd700 | #ffd700 (金) |
| Skill / Skills | #1a1e3f | 3px solid #64b5f6 | #64b5f6 (蓝) |
| Error | #3f1e1e | 3px solid #ff4444 | #ff4444 (红) |
| 其他 IRC 用户 | #16213e | 3px solid #555 | #aaa (灰) |

## 14. IRC Bot 工具调用 + 动态模型（irc-bot.js，非光杆机器人）

> 解决用户反馈「deepseek_ai 没挂任何 MCP tools，就一光杆聊天机器人」+「mcp工具应该随系统mcp配置」+「模型应该为当前最近使用的模型」。

`irc-bot.js` 现在通过 **OpenAI function-calling** 让 bot 成为 agent，而非纯文本聊天机器人：

- `generateReply()` 在请求 LiteLLM `/chat/completions` 时携带 `tools` + `tool_choice:'auto'`。
- 当模型请求工具时，bot 执行工具并把结果以 `role:'tool'` 回填，循环最多 4 轮直到模型产出最终文本。
- 工具执行记录以 `ev:'tool'` 写入 `conversation.ndjson`，`status.json` 新增 `toolCalls` 计数。

### 14.1 MCP 工具随系统 MCP 配置

bot 启动时读取**系统 MCP 配置**（`~/.config/opencode/opencode.json` 的 `mcp` 段，即 DSH preset 镜像的同一份配置），连接每个启用的 MCP server（streamable-http 与 stdio 两种传输），把它们的工具以 `mcp__<server>__<tool>` 命名暴露给 LLM：

| 来源 | 传输 | 工具数 | 说明 |
|------|------|--------|------|
| `fff` | stdio | 3 | 文件搜索（find_files / grep / multi_grep） |
| `litellm` | streamable-http | 70 | mysql / memory / context7 / searxng / fetch |
| `agentmemory` | stdio | 7 | 知识图谱（memory-*） |
| `react-grab-mcp` | stdio | 1 | React 抓取 |
| `sequential-thinking` | stdio | 1 | 顺序思考 |
| `logpilot` / `sem` | stdio | 0 | 本机未安装对应二进制，跳过 |
| `qmd` | stdio | 0 | npx 下载超时，跳过 |

> 连接失败的 server 记入 `status.json` 的 `mcpFailed`，不影响其他 server。bot 重启后会自动重新发现。
>
> **优化（irc-bot.js）：** `discoverMcp()` 的 `init()`/`listTools()` 超时从 30s 提高到 **60s**。litellm 的 streamable-http 初始化需要 ~40s（init + listTools 各 ~20s），30s 超时会导致 litellm 经常连接失败（`mcpFailed` 含 `litellm`）。提高后 litellm 稳定连上，同时 npx 下载的 server（agentmemory/react-grab-mcp/sequential-thinking）也有足够时间下载，MCP 工具总数从 73 提升到 **82**。

本地 `run_command` 工具始终保留（shell 访问），与 MCP 工具一起提供给 LLM。

### 14.2 模型随当前最近使用

bot 不再硬编码模型，而是动态解析 **DSH 会话存储里最近使用的模型**：

- 扫描 `~/.dsh/sessions/**/session.jsonl.zstd`，取 mtime 最新的会话文件。
- 用 `zstd -dc` 解压，取最后一个 `"model":"..."` 字段作为当前模型。
- 每次回复前重新解析（30s 缓存），因此用户在 DSH GUI 切换模型后，bot 自动跟随。
- 解析失败时回退到 `irc.json` 的 `llm.model`。

### 14.3 上下文窗口兜底

若模型因上下文窗口不足拒绝带 tools 的请求（返回 `⚠️ Error: Request exceeds model context window...`），bot 会**自动重试一次不带 tools**，保证 bot 仍能正常回复纯文本。

> **优化（irc-bot.js）：** 只有**上下文窗口错误**才会把模型永久记入 `noToolsModels`（后续该模型不再带 tools）。临时错误（网络超时、5xx）只重试一次不带 tools，**不会**污染模型缓存——因为模型是动态跟随的，一个临时错误不应让该模型后续永远失去工具能力。

这样 bot 在 IRC 里被要求「执行命令 / 查询数据库 / 搜索信息 / 操作文件」时，会真正调用工具并把结果回复到频道，而不是空谈。

### 14.4 外部发送队列（outbox）— 面板消息发送到频道

面板的 `/irc say <text>`（或无法识别输入自动 say）通过 Cordis 插件的 `irc-send` handler 写入 **outbox 队列文件**，bot 定期读取并发送到频道：

- **outbox 文件**：`/raid/source/src/shell/irc-bot/outbox.ndjson`（在 workspace 内，使 `fs.writeText` 可写）。
- **bot 端（irc-bot.js）**：新增 `drainOutbox()`，每 500ms 读取 outbox 文件，有消息就 `send('PRIVMSG ' + channel + ' :' + text)` 并清空文件，记录 `ev:'send'`（`via:'outbox'`）。
- **插件端（`irc-send` handler）**：读取 outbox 现有内容 → 追加 `{text}` → 写回。

> **沙箱修复（pkg-20 → pkg-23）：** `irc-send` 写入 outbox 经历了三次迭代——
> - **pkg-20**：`fs.writeText` 写 workspace 外 outbox → 被 workspace-write 沙箱拒绝。
> - **pkg-21**：改用 `ctx.shell` 执行命令 → 主机无沙箱后端（bubblewrap/Landlock），shell 拒绝执行。
> - **pkg-22**：`fs.writeText` 写 workspace 内 outbox → 仍被拒，因为 **Cordis 插件的 fs 服务不继承 DSH 会话的 full access**（`checkedTarget` 用 `ctx.sandboxPolicy.resolve()` 无 session，取 `defaultMode` = workspace-write）。
> - **pkg-23（成功）**：`fs.writeText(target, content, undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/' })` —— **显式传 `danger-full-access` sandboxPolicy**，`checkedTarget` 直接不加围栏写 outbox。

## 15. 后续可选项

1. **多频道支持**：配置解析 `channel` 为数组，面板增加频道选择器。
2. **MCP Server 集成**：将 IRC bot 的 recv/send/llm-reply 事件通过 MCP 协议暴露给 DSH agent tools。
3. **@mention 触发模式**：仅在 PRIVMSG 包含 nick 时回复（减少 noise）。
4. **技能快捷执行**：在 `/skill <name>` 后自动加载 skill instructions，支持 `.skill` 前缀直接调用已加载技能的工具集。
5. **命令历史**：当前 `commandHistory[] + historyIndex` 预留了上下键浏览历史的功能，待实现。
6. **更多 bot 工具**：✅ 已完成 — bot 现在随系统 MCP 配置自动挂载 mysql / memory / searxng / context7 / fetch 等工具（见 §14.1）。
7. **面板消息发送到频道**：✅ 已完成 — `/irc say <text>` + 无法识别输入自动 say，通过 outbox 队列发送到 `#xia`（见 §14.4）。

## 16. 版本历史速查

| Package | 关键变更 | 状态 |
|---------|----------|------|
| pkg-4 | IRC Chat v4 — slots.register name + timer inject 修复 | ✅ 已归档 |
| pkg-7 | IRC Chat v7 — stopPropagation 修复关闭按钮事件冒泡 | ✅ 已归档 |
| pkg-8 | IRC Chat v8 — proper slot removal lifecycle | ✅ 已归档 |
| pkg-10 | IRC Chat v10 — command input bar + processCommand parser | ✅ 已归档 |
| pkg-11 | IRC Chat v11 — Skills/Tools 完整集成 | ✅ 已归档 |
| pkg-12 | IRC Chat v12 — toggle panel（仍用不存在的 slots.remove） | ✅ 已归档 |
| **pkg-13** | **IRC Chat v13 — 真实解析 + disposer 关闭 + 实时刷新 + bot 工具** | ✅ 已归档 |
| **pkg-14** | **IRC Chat v14 — `fs.resolve()` 修复状态误报 + 面板打开即刷新** | ✅ 已归档 |
| **pkg-15** | **IRC Chat v15 — sticky 状态/帮助/模型列表 + `/irc help` `/irc models` `/irc model <name>` + 模型切换** | ✅ 已归档 |
| **pkg-16** | **IRC Chat v16 — 仅 `/` 开头输入作为命令（普通文本忽略）** | ✅ 已归档 |
| **pkg-17** | **IRC Chat v17 — 自动跟随滚动开关 + 1000 条消息上限** | ✅ 已归档 |
| **pkg-19** | **IRC Chat v18 — 稳健滚动到底（多帧 `scrollToBottom`，合并自 `irct-5/pkg-18`）** | ✅ 已归档 |
| **pkg-20** | **IRC Chat v19 — `/irc say` 命令 + `irc-send` handler（面板消息发送到频道）** | ✅ 已归档 |
| **pkg-21** | **IRC Chat v20 — `irc-send` 用 `ctx.shell`（无沙箱后端，失败）** | ✅ 已归档 |
| **pkg-22** | **IRC Chat v21 — `irc-send` 用 `fs.writeText` 写 workspace 内 outbox（仍被拒）** | ✅ 已归档 |
| **pkg-23** | **IRC Chat v22 — `irc-send` 用 `fs.writeText` + `danger-full-access` policy（成功）** | ✅ 已归档 |
| **pkg-24** | **IRC Chat v23 — 无法识别输入自动当作 `/irc say` 发送到频道** | ✅ 已归档 |
| **pkg-25** | **IRC Chat v24 — sticky 顶部消息最多 3 条（超出丢弃最旧）** | ✅ 已归档 |
| **pkg-26** | **IRC Chat v25 — 面板打开即滚到底 + 自动滚动默认开启** | **✅ running** |

## 17. 相关文件索引
