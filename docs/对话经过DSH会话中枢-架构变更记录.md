# dsh-irc 对话改为经过 DSH 会话中枢 — 架构变更记录

> 变更日期：2026-08-26
> 状态：已实现并端到端验证（动态插件 `irct-2/pkg-2`，DSH 重启后 autoload 加载，含 `lastFollowupTime` 去重修复）
> 前置文档：`docs/对话是否经过DSH会话中枢分析.md`（记录旧架构：对话**不**经过 DSH 核心）

---

## 0. TL;DR

| 组件 | 旧架构 | 新架构 |
| --- | --- | --- |
| IRC 连接 | `irc-bot.js` 独立进程直连 TCP | 不变（仍是独立进程，但只做 TCP） |
| LLM 对话 | `irc-bot.js` 直连 LiteLLM，自管上下文/agent loop/MCP | **经过 DSH 核心**：DSH agent（`irc-xia`）处理 |
| 上下文管理 | bot 自带 20 轮 FIFO buffer | DSH 的 context / compaction |
| Agentic loop | bot 自实现（≤4 轮工具回灌） | DSH 的 agent loop |
| MCP 连接 | bot 自连 opencode.json 的 MCP | DSH 的 mcp 包 |
| System prompt / preset / guard / hook | **不生效** | **全部生效** |

**核心变化**：IRC 对话从「独立 bot 直连 LLM」改为「薄 transport + DSH agent 路由」。IRC 对话现在是一等公民的 DSH session（`irc-xia`）。

---

## 1. 问题

旧架构（见 `对话是否经过DSH会话中枢分析.md`）中，`irc-bot.js` 作为独立 Node 进程：

- `fetch(llm.base + '/chat/completions')` 直连 LiteLLM 代理
- 自带 20 轮 FIFO `buffer` 作为上下文
- 自实现 agentic loop（工具调用→回灌，≤4 轮）
- 自连 MCP（读 `~/.config/opencode/opencode.json`）

因此 DSH 的 system prompt、preset、guard、hook、context、compaction、tools 等会话级能力**对 IRC 对话全部不生效**。这是不对的——IRC 对话应该和 GUI 对话一样，走 DSH 的会话处理中枢。

---

## 2. 新架构

```
┌─────────────────────────────────────────────────────────────┐
│  DSH Web GUI（浏览器）                                        │
│  ┌────────────────────┐                                      │
│  │ IRC 浮动面板         │ client.js（不变）                    │
│  └─────────┬──────────┘                                      │
│            │ host.call('irc-send' / 'get-irc-messages' / …)  │
│            ▼                                                  │
│  ┌────────────────────────────────────────────┐              │
│  │ host.js (Cordis 动态插件 irct-2/pkg-2)        │              │
│  │  inject: ['fs','timer']                      │              │
│  │  ├─ agents.resume/create({sessionId:'irc-xia'})│ ← 恢复/创建  │
│  │  │    DSH agent，走 DSH 核心                  │     agent     │
│  │  ├─ ctx.interval(pollInbox, 1500)            │  ← 轮询入站   │
│  │  │    → agent.followup(userMessage)          │    消息        │
│  │  ├─ processNewReplies() 轮询 agent.session    │  ← 提取回复   │
│  │  │    assistant/message → appendOutbox()     │               │
│  │  └─ ctx.on('agent/session-start')            │  ← 注入人设   │
│  │       → agent.inject(persona)                │               │
│  └──┬──────────────────────────────┬───────────┘              │
│     │ fs 读 inbox.ndjson           │ fs 写 outbox.ndjson       │
│     ▼                              ▼                          │
│  inbox.ndjson                  outbox.ndjson                  │
│     ▲                              │                          │
│     └──────────────┬───────────────┘                          │
│                    ▼                                          │
│  ┌─────────────────────────────────────────────┐              │
│  │ irc-bot.js（薄 transport，独立进程）           │              │
│  │  ├─ net.connect → IRC 服务器                 │              │
│  │  ├─ 入站 PRIVMSG → 追加 inbox.ndjson          │              │
│  │  ├─ 读 outbox.ndjson → PRIVMSG 到频道         │              │
│  │  └─ 记录 conversation.ndjson + status.json   │              │
│  └─────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

### 数据流

1. **入站**：IRC 频道消息 → `irc-bot.js` 追加到 `inbox.ndjson`（`{ts, from, text}`）
2. **路由**：Host 插件每 1.5s 轮询 `inbox.ndjson`，对每条新消息构造 `UserMessage` 并调用 `agent.followup(...)`
3. **处理**：DSH 核心（agent loop / context / compaction / tools / preset / guard / hook）处理该消息
4. **出站**：Host 插件 `processNewReplies()` 轮询 `agent.session.events`，提取新的 `assistant/message` 文本写入 `outbox.ndjson`（不依赖 scope 过滤的 `session/event`，后者收不到 `assistant/message`）
5. **发送**：`irc-bot.js` 每 500ms 读 `outbox.ndjson`，`PRIVMSG` 到频道

---

## 3. 关键实现点

### 3.1 薄 transport（`irc-bot.js`）

只保留 IRC TCP 连接逻辑，删除全部 LLM/MCP/上下文/agent loop 代码：

- 入站消息 → `inbox.ndjson`（workspace 目录，Host 的 fs 可读）
- 出站队列 → `outbox.ndjson`（Host 的 fs 可写）
- 仍记录 `conversation.ndjson`（面板显示用）+ `status.json`

### 3.2 Host 插件（`irct-2/pkg-2`）

```js
// 恢复/创建 DSH agent（专用 IRC session），优先 resume 保留历史
let handle
try {
  handle = await agents.resume({ resumeSessionId: 'irc-xia', agentOptions: {...} })
} catch {
  handle = await agents.create({ sessionId: 'irc-xia', meta: { cwd: '/raid/source/src/shell' }, agentOptions: {...} })
}

// 注入人设（session-start 时，作为 model-facing context）
ctx.on('agent/session-start', (payload) => {
  if (payload.agent.id !== 'irc-xia') return
  payload.agent.inject(makeUserMessage('<system-reminder>\n' + IRC_PERSONA + '\n</system-reminder>'))
})

// 提取回复 → 写 outbox（轮询 agent.session，而非 session/event）
function processNewReplies() {
  for (const ev of ircAgent.session.events) {
    if (ev.seq <= lastProcessedSeq) continue
    lastProcessedSeq = ev.seq
    if (ev.type !== 'assistant/message') continue
    // 提取 text block → appendOutbox(text)
  }
}

// 轮询入站 → followup
ctx.interval(pollInbox, 1500)
```

> **为什么轮询 `agent.session` 而不是监听 `session/event`？**
> `session/event` 是 scope 过滤的：插件 ctx 和 agent.ctx 上的监听器都只能收到 `turn/end`、`session/title-llm-request` 等部分事件，**收不到 `assistant/message`**（agent 的回复已写入 session 日志，但事件未投递到插件作用域）。因此改为直接轮询 `agent.session.events`（每次返回最新快照），按 `seq` 增量提取新回复，可靠且无竞态。

### 3.3 手工构造 UserMessage

动态 Host 无法 `import createUserMessage`，手工构造（`MessageId` 只是 branded string，inbox 只校验 id 唯一）：

```js
{
  id: 'irc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10),
  role: 'user',
  content: [{ type: 'text', text: String(text) }],
  source: { kind: 'user' },
}
```

---

## 3.5 完整实现走读（host.js）

下面是 `plugin/host.js` 的核心逻辑，按执行顺序逐段说明。

### ① 声明依赖与常量

```js
return {
  inject: ['fs', 'timer'],          // 动态 Host 沙箱只暴露 fs / timer / ctx.on / ctx.interval
  async apply(ctx) {
    const fs = ctx.fs
    const IRC_SESSION_ID = 'irc-xia'   // 专用 DSH session id
    const INBOX  = BOT_DIR + '/inbox.ndjson'   // 入站队列（transport 写，本插件读）
    const OUTBOX = BOT_DIR + '/outbox.ndjson'  // 出站队列（本插件写，transport 读）
    const IRC_PERSONA = '你在 IRC 频道 #xia 里，昵称 deepseek_ai。…'
```

> 动态 Host 沙箱**没有** `process` / `require` / `net` / `Buffer` / `ctx.root`，所以路径全部硬编码，文件读写走 `ctx.fs`。

### ② 创建/恢复 DSH agent（核心）

```js
const agents = ctx.get('agents')
// 优先 resume（保留历史），失败则 create（全新会话）
try {
  const handle = await agents.resume({
    resumeSessionId: IRC_SESSION_ID,
    agentOptions: { provider: 'litellm', model: 'deepseek-v4-flash-cloud' },
  })
  ircAgent = handle.agent
} catch {
  const handle = await agents.create({
    sessionId: IRC_SESSION_ID,
    meta: { cwd: '/raid/source/src/shell' },
    agentOptions: { provider: 'litellm', model: 'deepseek-v4-flash-cloud' },
  })
  ircAgent = handle.agent
}
```

这一步让 IRC 对话成为**一等公民的 DSH session**：`irc-xia` 走 DSH 的 agent loop，因此 DSH 的系统提示、预设、守卫、钩子、上下文、压缩、工具全部生效。

### ③ 注入人设（session-start 时）

```js
ctx.on('agent/session-start', (payload) => {
  if (payload.agent.id !== IRC_SESSION_ID) return
  payload.agent.inject(makeUserMessage('<system-reminder>\n' + IRC_PERSONA + '\n</system-reminder>'))
})
```

`inject` 把 IRC 人设作为 model-facing context 注入，agent 以「#xia 频道里的 deepseek_ai」身份回复。

### ④ 轮询入站 → followup

```js
async function pollInbox() {
  if (!ircAgent) return
  processNewReplies()                       // 先处理上一轮可能已产生的回复
  const content = await fs.readText(INBOX)  // 读入站队列
  await fs.writeText(INBOX, '')             // 读后清空
  for (const line of lines) {
    const rec = JSON.parse(line)            // {ts, from, text}
    ircAgent.followup(makeUserMessage(rec.from + ': ' + rec.text))
  }
}
ctx.interval(pollInbox, 1500)               // 每 1.5s 轮询
```

`followup` 把消息投进 agent 的 inbox 并唤醒 driver，DSH 核心开始处理。

### ⑤ 提取回复 → 写 outbox（关键）

```js
function processNewReplies() {
  const events = ircAgent.session.events     // 每次返回最新快照
  for (const ev of events) {
    if (ev.seq <= lastProcessedSeq) continue // 按 seq 增量，避免重复
    lastProcessedSeq = ev.seq
    if (ev.type !== 'assistant/message') continue
    // 提取 text block → appendOutbox(text)
  }
}
```

**为什么轮询 `agent.session` 而不是监听 `session/event`？** 见下方「调试过程」。

### ⑥ 出站队列

```js
async function appendOutbox(text) {
  const existing = await fs.readText(OUTBOX)
  await fs.writeText(OUTBOX, existing + JSON.stringify({ text }) + '\n')
}
```

`irc-bot.js` 每 500ms 读 `outbox.ndjson`，`PRIVMSG` 到频道。

---

## 3.6 调试过程（两个根因）

实现过程中遇到两个关键问题，最终定位并修复：

### 根因 1：会话 id 冲突

首次运行后，`turn/end` 的 reason 是：

```json
{"kind":"error","error":{"message":"session \"irc-xia\" already has a persisted log on disk that does not match this live session (id collision)","code":"UNKNOWN"}}
```

**原因**：磁盘上残留一个**旧架构**的 `irc-xia` session 文件（`~/.dsh/sessions/--raid-source-src-shell--/irc-xia/session.jsonl.zstd`），与新 live session 结构不匹配，append 时冲突。

**修复**：删除陈旧 session 文件，让 agent 重新创建。生产版用 `resume`-first 逻辑，同架构下重启可正常恢复。

### 根因 2：`session/event` 收不到 `assistant/message`

agent 能正常回复（session 日志里有 `assistant/message`），但 outbox 始终为空。排查发现：

- 插件 ctx 和 agent.ctx 上的 `session/event` 监听器**只能收到** `turn/end`、`session/title-llm-request` 等部分事件；
- **收不到** `assistant/message`、`user/message`、`step/start` 等事件——这是 scope 过滤导致的（`session/event` 按 scope carrier 投递，`assistant/message` 未投递到插件作用域）。

**修复**：改为直接轮询 `agent.session.events`（每次返回最新快照），按 `seq` 增量提取新回复。可靠、无竞态、不依赖事件投递。

---

## 3.7 实际数据流示例

以一条真实 IRC 消息「`test_user: ping root`」为例，看它如何流经每个文件：

**① 入站** — `irc-bot.js` 收到 PRIVMSG，追加到 `inbox.ndjson`：

```json
{"ts":"2026-08-26T05:18:00.000Z","from":"test_user","text":"ping root"}
```

**② 路由** — 插件 `pollInbox` 读到并清空 inbox，构造 UserMessage 调 `agent.followup`：

```js
{ id: 'irc-...-wylprzfn', role: 'user',
  content: [{ type: 'text', text: 'test_user: ping root' }],
  source: { kind: 'user' } }
```

**③ 处理** — DSH agent 经 LLM 处理，session 日志记录完整事件流（`~/.dsh/sessions/.../irc-xia/session.jsonl.zstd`）：

```json
{"type":"agent/inbox/spliced","seq":4,"data":{"target":"next-turn","inserted":[{"id":"irc-...-wylprzfn","role":"user","content":[{"type":"text","text":"test_user: ping root"}]}]}}
{"type":"turn/start","seq":5,"data":{"turn":1}}
{"type":"user/message","seq":10,"data":{"id":"irc-...-wylprzfn","role":"user","content":[{"type":"text","text":"test_user: ping root"}]}}
{"type":"assistant/chunk","seq":17,"data":{"chunk":{"type":"text-delta","text":"pong"}}}
{"type":"assistant/message","seq":21,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"pong"}],"source":{"provider":"litellm","model":"deepseek-v4-flash-cloud"}}}}
{"type":"turn/end","seq":23,"data":{"turn":1,"reason":{"kind":"completed"}}}
```

**④ 出站** — 插件 `processNewReplies` 轮询到 `assistant/message`（seq 21），提取「pong」写入 `outbox.ndjson`：

```json
{"text":"pong"}
```

**⑤ 发送** — `irc-bot.js` 读 outbox，`PRIVMSG #xia :pong`，并记录到 `conversation.ndjson`：

```json
{"ts":"...","ev":"send","text":"pong","via":"outbox"}
```

---

## 3.8 合并输入（多条消息 → 一次 LLM 调用）

**问题**：聊天室里多人连续发言时，若每条消息都触发一次 `followup`，会累计成队列，LLM 被反复唤醒处理多轮。

**要求**：
1. 聊天室中多条消息**合并为一次**输入，不累计队列。
2. 若 agent 正在处理，则后续消息**全部合并**，等当前处理完再输出。
3. 输入超过 **50k** 字符时截取**最后 50k**。

**实现**（`pollInbox`）：

```js
let pendingText = ''   // agent 忙时累积的待发送消息
let polling = false    // 防止并发轮询

async function pollInbox() {
  if (!ircAgent || polling) return
  polling = true
  try {
    processNewReplies()   // 先提取上一轮可能已产生的回复

    // 读取并清空 inbox
    const target = await fs.resolve(INBOX)
    const content = await fs.readText(target)
    const lines = content.trim().split('\n').filter(l => l.trim())
    await fs.writeText(target, '')

    // 合并所有新消息为一段文本（inbox 读后即清空，无需按时间戳去重）
    let batch = ''
    for (const line of lines) {
      const rec = JSON.parse(line)
      if (!rec || !rec.text) continue
      batch += (rec.from || 'unknown') + ': ' + rec.text + '\n'
    }

    // 追加到 pending（agent 忙时累积），保留最后 50k
    if (batch.trim()) {
      pendingText += batch
      if (pendingText.length > MAX_INPUT) pendingText = pendingText.slice(-MAX_INPUT)
    }

    // 仅当 agent 空闲且有内容时才发送（合并为一次）
    if (ircAgent.status === 'idle' && pendingText.trim()) {
      const text = pendingText.trim()
      pendingText = ''
      ircAgent.followup(makeUserMessage(text))
    }
  } finally {
    polling = false
  }
}
```

**行为**：
- 同一轮询窗口内的多条消息 → 合并为一段文本，只调一次 `followup`。
- agent 忙时 → 消息累积到 `pendingText`，等 agent 空闲后合并输出。
- 输入 > 50k → 截取最后 50k（`pendingText.slice(-MAX_INPUT)`）。

**实测**：3 条消息（alice/bob/carol）合并为一次输入，agent 一次回复全部三人：

```
SENDING len=45 -> alice: hello
bob: hi there
carol: how are you

reply: - **alice**：嗨，你好~ 👋
       - **bob**：hello bob！
       - **carol**：还不错，谢谢
```

> **调试中修复的两个 bug**：
> 1. `fs.readText` 前必须先 `fs.resolve`（否则 path 为 `undefined`，报 `The "path" argument must be of type string`）。
> 2. 原按 `lastInboxTs` 去重会跳过**同时间戳**的消息（同一轮询窗口内多条消息 ts 相同）。因 inbox 读后即清空，去重冗余，已移除。

---

## 3.9 重复回复修复（去重 + 持久化 + lastFollowupTime）

**问题**：用户说一次"你好"，但 agent 处理了多次，产生多条回复。实测中一条消息产生 **3x 回复**（间隔仅 ~350ms）。根因是**同一入站消息被 `followup` 调用了多次**（多 interval / 极快连续 poll），以及**插件重启时重发历史回复**。

### 四个修复

**① sentInboxTs 去重（入站消息）**

同一入站消息（同 `ts`）只 `followup` 一次，防止 agent 重复处理：

```js
const tsKey = rec.ts || (rec.from + ':' + rec.text)
if (sentInboxTs.has(tsKey)) continue   // 已处理过则跳过
sentInboxTs.add(tsKey)
batch += sender + ': ' + rec.text + '\n'
```

**② sentTexts + appendOutboxBatch（回复去重）**

- `sentTexts` Set 记录已发送的回复文本，防止同一回复被多轮 pollInbox 重复写入 outbox。
- `appendOutboxBatch` 把本轮所有新回复**一次性**追加到 outbox（避免多次 appendOutbox 对同一批事件重复写入）。

**③ lastProcessedSeq 持久化（防重启重发）**

`lastProcessedSeq` 保存到 `~/.dsh/irc-bot/last-processed-seq.txt`，插件启动时加载。否则插件重启时 `lastProcessedSeq` 重置为 0，会把历史所有回复重新发送到 IRC（刷屏）。

```js
// 启动时加载
readSeqFile().then((s) => { lastProcessedSeq = s })
// 处理完后保存
if (lastProcessedSeq > 0) writeSeqFile(lastProcessedSeq)
```

**④ lastFollowupTime 500ms 去重窗口（防极快重复发送）**

防止多 interval / 极快连续 poll 在 ~350ms 内对同一消息重复 `followup`：

```js
let lastFollowupTime = 0   // 上次 followup 时间戳

// pollInbox 中：
if (ircAgent.status === 'idle' && pendingText.trim()) {
    const now = Date.now()
    if (now - lastFollowupTime > 500) {   // 至少间隔 500ms 才发下一条
        const text = pendingText.trim()
        pendingText = ''
        lastFollowupTime = now
        ircAgent.followup(makeUserMessage(text))
    } else {
        // 同一 poll cycle 内快速重复，跳过（pendingText 不清除供下次 poll 用）
    }
}
```

### 验证

- 单条消息只产生一个 turn、一条回复（`sentInboxTs` 生效）。
- 插件重启后 `lastProcessedSeq` 从文件加载，不重发历史回复。
- `lastFollowupTime` 500ms 窗口防止极快连续 poll 重复发送（pkg-2 已含此修复，DSH 重启后 autoload 加载）。

---

## 4. 变更文件

| 文件 | 变更 |
| --- | --- |
| `/raid/source/src/shell/irc-bot/irc-bot.js` | 重写为薄 transport（删除 LLM/MCP/上下文/agent loop） |
| 动态插件 `irct-2/pkg-2`（Host half） | DSH agent 路由 + 合并输入 + 去重（sentInboxTs/sentTexts/lastFollowupTime）+ lastProcessedSeq 持久化 |
| `/raid/source/src/dsh-irc/plugin/host.js` | ✅ 已同步（DSH 重启后由 autoload 加载为 pkg-2，含 lastFollowupTime 修复） |
| `/raid/source/src/dsh-irc/irc-bot/irc-bot.js` | ✅ 已同步（薄 transport） |
| `/raid/source/src/dsh-irc/irc-bot/irc.json` | ✅ 已同步（与运行配置一致，ignoreNicks 已恢复） |
| `/raid/source/src/dsh-irc/plugin/plugin.json` | 更新描述（agent 路由架构） |

---

## 5. 验证状态

- [x] `irc-xia` DSH session 已创建并持久化（`~/.dsh/sessions/--raid-source-src-shell--/irc-xia`）
- [x] 薄 transport 已运行并连接（status.json `"transport":"thin"`）
- [x] 端到端对话验证（IRC 消息 → DSH agent → 回复回频道，`conversation.ndjson` 可见 `recv`/`send`）
- [x] 人设注入验证（agent 以 IRC 人设回复）
- [x] 会话持久化验证（插件重启后 `resume` 保留历史，`seq` 连续）
- [x] 合并输入验证（多条消息合并为一次 LLM 调用）
- [x] 去重验证（同一入站消息只处理一次，`sentInboxTs` 生效）
- [x] 重启不重发验证（`lastProcessedSeq` 持久化，重启不刷屏）
- [ ] 工具调用验证（DSH tools 而非 bot 自连 MCP）

> 注：插件 `irct-2` 当前运行 `pkg-2`（DSH 重启后 autoload 从源码加载，含 `lastFollowupTime` 500ms 去重修复）。源仓库 `dsh-irc/plugin/host.js` 已同步。

---

## 6. 已知限制 / 后续

- **模型切换**：`/irc model` 更新 `irc.json` 并重启 transport，但 agent 的模型在创建时固定（`agentOptions.model`）。要应用新模型需重载插件（或后续改为 `agent/request` waterfall 动态覆盖）。
- **回复时机**：当前在 `assistant/message` 事件即发送文本。若模型在工具调用前产生部分文本，可能提前发送。后续可改为等 turn 完成再发。
- **inbox 竞态**：Host 读后截断 `inbox.ndjson`，与 transport 追加存在极小竞态窗口（IRC 低消息率下可接受）。
- **ignoreNicks**：已恢复为 `["hermes","nanoclaw"]`，避免与其它 bot 循环对话。
- **session/event scope 过滤**：`assistant/message` 事件不会投递到插件作用域，回复提取依赖轮询 `agent.session.events`（见 §3.2）。
- **合并输入**：多条消息合并为一次 LLM 调用，agent 忙时累积、空闲后合并输出，>50k 截取最后 50k（见 §3.8）。
- **去重**：`sentInboxTs` 防同一入站消息重复 followup；`sentTexts` 防同一回复重复发送；`lastProcessedSeq` 持久化防重启重发；`lastFollowupTime` 500ms 窗口防极快连续 poll 重复发送（见 §3.9）。
- **潜在重复**：极快连续消息或 agent 多步回复时，仍可能有极小概率重复。若复现，可进一步用消息 id 而非 ts 去重。

---

## 7. 2026-08-26 实测：3x 重复仍复现 + 根因诊断

### 7.1 现象

即使插件 `irct-2/pkg-2` 已含 `lastFollowupTime` 500ms 去重修复，通过另一 IRC 连接（testbot3/testbot4）发送单条消息，bot 仍回复 **3 次**。

日志证据（`bot-stdout.log`）：

```
15:54:09.183  send  收到~ 👋
15:54:10.181  send  收到~ 👋   ← 差 ~1.0s
15:54:10.184  send  收到~ 👋   ← 差 ~3ms

15:57:37.068  send  Session complete! Here's what happened: ...
15:57:37.070  send  Session complete! Here's what happened: ...   ← 差 2ms
15:57:37.072  send  Session complete! Here's what happened: ...   ← 差 2ms
```

### 7.2 根因诊断

**① agent 会话 `irc-xia` 在内存中被污染**

- 插件通过 `agents.resume` 恢复 agent，但**恢复的是内存中仍存活的旧 agent 对象**（已累积 6841 个事件）。
- 删除磁盘上的会话文件（`~/.dsh/sessions/.../irc-xia/`）**无效**，因为 agent 对象仍在 DSH 进程内存中。
- 被污染的 agent 产生非 IRC 的总结消息（"Session complete! Here's what happened:..."），而非正常回复。

**② 3x 重复的直接原因：agent 单轮产生多个 `assistant/message` 事件**

- 3 条发送间隔 2~3ms，来自**同一次 `appendOutboxBatch`**（`processNewReplies` 一次追加多个文本）。
- `sentTexts` Set 只去重**完全相同的文本**。若 agent 产生的多个事件文本略有差异（流式分块/多步），则全部通过去重，被转发。
- `lastFollowupTime` 只防重复 `followup` 调用，**防不住 agent 单轮产生多个事件**。

### 7.3 已尝试的修复（均未根治）

| 修复 | 作用 | 效果 |
|------|------|------|
| `sentInboxTs` | 防同一入站消息重复 followup | ✅ 有效 |
| `sentTexts` + `appendOutboxBatch` | 防完全相同回复重复发送 | ⚠️ 只对字节相同文本有效 |
| `lastProcessedSeq` 持久化 | 防重启重发历史 | ✅ 有效 |
| `lastFollowupTime` 500ms | 防极快连续 poll 重复 followup | ⚠️ 防不住单轮多事件 |
| 停止/重启插件 | 清除旧 interval | ✅ 清 interval，但**不清内存 agent** |

### 7.4 待决策的彻底修复方案

**方案 A：重启 DSH 清除内存中被污染的 agent**

- 重启 DSH 进程 → 内存中所有 agent 对象被清除 → `agents.resume` 从磁盘重新加载（或 create 新会话）。
- ⚠️ 代价：中断当前会话。

**方案 B：修改插件，只转发每轮最后一个 `assistant/message`**

- 在 `processNewReplies` 中按 turn 边界分组，只取每轮最后一个文本转发。
- 这样即使 agent 产生多个事件也只发一条。
- ⚠️ 需要推送代码（cordis_define 对大代码失败，需另想办法）。

### 7.5 当前状态（2026-08-26 23:5x）

- 插件 `irct-2/pkg-2` 运行中（run-8），但 agent 会话仍被污染（seq=6841）。
- 会话文件已删除并备份（`irc-xia.bak-*`），但内存 agent 未清除。
  > **⚠️ 后续教训**：把备份留在 sessions 目录会导致 DSH 启动崩溃（`assertStoredIdentity` 校验失败）。备份必须移到 sessions 目录外或直接删除。详见 `修复重复回复-行动计划.md` §8。
- 3x 重复问题**未解决**，待决策方案 A 或 B。

---

## 8. 2026-08-27 最终修复 + agent-stuck 问题

### 8.1 根因确认（三重重因）

| # | 根因 | 说明 |
|---|------|------|
| 1 | **多个插件实例同时运行** | DSH autoload 多次加载插件，每次创建新 `ctx.interval`。旧 interval 未被 Cordis 销毁。每个 interval 读取同一 inbox → 多次 followup。 |
| 2 | **全局 seq 去重失效** | `agent.session.events` 返回**全部会话的全局事件**。irc-xia 的事件 seq（0~300）远小于全局最大 seq（6841+），被 `lastProcessedSeq=6841` 跳过。 |
| 3 | **agent status 卡住** | agent 完成 turn（session 有 `turn/end`，reason='completed'）后，`ircAgent.status` 仍为 `'running'` 而非 `'idle'`。插件检查失败 → 不调用 followup。 |

### 8.2 已实施的修复

| 修复 | 作用 | 状态 |
|------|------|------|
| **消息 ID 去重**（`processedMsgIds`） | 按 `assistant/message.id` 去重，替代全局 seq 去重 | ✅ 已实现，持久化到文件 |
| **文件锁**（`LOCK_FILE`，300s 超时） | 防止多个插件实例同时创建 interval。若已有锁 < 300s，新实例跳过 interval。移除 `ctx.effect` 清空逻辑。 | ✅ 已验证有效 |
| **入站去重**（`sentInboxTs`） | 同一入站消息只 followup 一次 | ✅ 已实现 |
| **500ms 窗口**（`lastFollowupTime`） | 防极快连续 poll 重复发送 | ✅ 已实现 |

### 8.3 验证结果

**lock300_test**：消息注入 **1 次**，回复 **1 条**。✅ 去重修复生效。
**final_check**（第二条）：消息注入 **0 次**，回复 **0 条**。⚠️ agent-stuck 导致后续消息不处理。

### 8.4 Agent-stuck 问题详情

- **现象**：agent session 正常完成 turn（`turn/end` with `reason: 'completed'`），但 `ircAgent.status` 保持 `'running'` 不回到 `'idle'`。
- **影响**：插件的 `if (ircAgent.status === 'idle')` 检查失败，不调用 `followup`。
- **临时解决**：重启插件（stop + run）可重置 agent status。
- **根因**：DSH agent 生命周期 bug — `turn/end` 后未更新 `status` 为 `'idle'`。

### 8.5 Agent-stuck 修复计划

| 优先级 | 方案 | 做法 | 难度 |
|--------|------|------|------|
| **P0** | 绕过 status 检查 | 在插件中用 session 事件判断空闲：最后一个事件是 `turn/end` → idle，否则 running。不依赖 `ircAgent.status`。 | 中（需改 host.js） |
| P1 | 强制重置 status | pollInbox 检测到 agent 卡住时，重新 `agents.get` 获取新对象。 | 低 |
| P2 | 修复 DSH 核心 | 在 agent turn/end handler 中正确设置 status='idle'。需改 DSH 源码。 | 高 |

**推荐方案：P0**。修改 pollInbox，用 session events 判断 agent 空闲状态替代 `ircAgent.status`。改动范围小，不影响 DSH 核心。

### 8.6 cordis_define 经验总结

- ✅ `{host: "..."}` 对象格式正确
- ✅ 18k+ 字符代码可成功推送（之前以为 ~4k 是限制）
- ❌ 失败原因是 JSON 转义问题（如 `"can't read irc.json"` 中的撇号），非大小限制

### 8.7 ctx.effect 教训

- `ctx.effect` 在插件被 autoload 重新加载时触发，清空了锁文件 → 导致新实例看到空锁并创建新 interval
- **修复**：移除 `ctx.effect` 清空锁逻辑，改用持久锁 + 300s 超时

### 8.8 ✅ P0 Agent-stuck 修复（最终验证）

**实施时间**：2026-08-27 ~16:30 HKT
**插件版本**：pkg-7 → pkg-9（isAgentIdle + followup try/catch）

#### 修复方案

替代 `ircAgent.status === 'idle'` 检查，新增 `isAgentIdle()` 函数：

```js
function isAgentIdle() {
  try {
    const events = ircAgent.session.events
    if (!Array.isArray(events) || !events.length) return true
    const lastEv = events[events.length - 1]
    if (lastEv && lastEv.type === 'turn/end') return true
    const hasMessage = events.some(e => e && e.type === 'assistant/message')
    return !!hasMessage
  } catch (e) { return false }
}
```

#### 验证结果

| 测试 | 发送方式 | IRC 回复 | 结果 |
|------|---------|---------|------|
| P0测试1 | inbox注入 | ✅ "P0测试：agent空闲检测修复" | **通过** |
| P0测试2 | inbox注入 | ✅ "P0测试2：确认followup触发" | **通过** |
| 端到端 | inbox注入 | ✅ "收到，P0 修复已确认生效。" | **通过** |

#### 发现：多 autoload interval 导致重复回复

- P0 修复后，agent 正常处理消息并生成回复
- 但 IRC channel 收到 2-4 条相同回复（不同 interval 同时运行）
- **根因**：DSH autoload 框架在启动时多次加载插件，创建多个 interval；`cordis_stop` 只停止动态插件的 interval，autoload interval 不受影响
- **解决**：重启 DSH → autoload 重新加载，文件锁确保只有一个 interval 运行

#### 待完成

1. ✅ 重启 DSH（清除多 interval）→ 验证无重复回复
2. ✅ 更新 `host.js` 源码为最终生产版本（已含 P0 修复 + followup try/catch）
3. ✅ autoload 加载新版本，自动生效
4. ✅ 锁超时从 300s → 3600s + pollInbox 内刷新机制
5. ✅ IRC bot drainOutbox 改用 atomic rename

### 8.9 ✅ V12 最终验证（2026-08-27 17:40 HKT）

**问题**：多 autoload interval → 重复回复 + outbox 竞态

**修复方案**：
1. **锁机制升级**：超时 300s → 3600s（1h），pollInbox 每轮刷新锁时间戳，autoload 再次加载时旧锁仍有效 → 跳过新 interval
2. **drainOutbox atomic rename**：`fs.renameSync(outbox, tmp)` → `read(tmp)` → `unlink(tmp)`，避免插件在 drain 间隙写入被覆盖
3. **appendOutboxBatch append-only**：先读后写，与 drainOutbox 的 rename 形成互补

**验证结果（连续两次测试）**：

| 测试 | processedMsgIds delta | IRC replies delta | 结果 |
|------|---------------------|-------------------|------|
| V12唯一回复测试 | +1 | +1 | ✅ PASS |
| V12重复稳定测试 | +1 | +1 | ✅ PASS |

**最终状态**：所有问题已修复。单条消息 → 一条 IRC 回复，行为稳定。

### 8.10 IRC 发言累积限速（2026-08-31，冷却行为修正）

**需求**：防止 AI 在聊天室持续不断发言，同时允许用户粘贴多行数据。

**规则**：
- 每个 sender 初始需要 **1 条消息**即发送
- 每次发送后，阈值 = 原阈值 + 本次实际累积数
- 5 分钟无该 sender 发言 → **仅重置 required=1，不释放 waitingBuffers 和 accumulated**
- 未达阈值的消息暂存到 `waitingBuffers[sender]`（per-sender 隔离），达标时合并发送

**实现**：
- `senderRequired[sender]`：每个 sender 的发送阈值
- `senderAccumulated[sender]`：该 sender 自上次发送以来的累积消息数
- `senderLastSendTime[sender]`：该 sender 上次发送时间（用于冷却判断）
- `waitingBuffers[sender]`：未达标 sender 的消息暂存，确保不被其他 sender 的达标消息触发发送

**隔离设计**：不同 sender 之间互不干扰。A 达标时只合并 A 自己的 waitingBuffers + A 本次新消息；B 即使也在 poll 中但未达标，其消息留在 waitingBuffers[B] 等待 B 下次达标。

**示例流程**：
```
A 发1条 → required=1, accumulated=1≥1 → 发送 → next_required=2
A 发1条 → accumulated=1, required=2, 1<2 → waitingBuffers['A']='msg2'
B 发1条 → required=1, accumulated=1≥1 → B's msg sent（与 A 无关）
A 发2条 → accumulated=3, required=2, 3≥2 → readyBatch=waitingBuffers[A]+新消息 → 发送 → next_required=5
...5分钟不发言...
A 再发1条 → required重置为1(不释放waitingBuffers), accumulated=1≥1 → 合并发送旧暂存+新消息 → next_required=2
```

**冷却行为修正（2026-08-31）**：之前版本在冷却时删除 waitingBuffers 并追加到 pendingText，但此时 senderAccumulated 也为 0，本轮无新消息则循环不执行 → waitingBuffers 永远丢失。修正为冷却只 reset required=1，保留 accumulated 和 waitingBuffers，等新消息来触发合并发送。

### 8.11 sentTexts 去重移除 + IRC bot keepalive（2026-08-31）

**sentTexts 问题**：`sentTexts` Set 按文本内容去重，导致 agent 对不同消息生成相同回复时被跳过。移除后仅依赖 `processedMsgIds`（消息 ID 去重）。

**IRC bot keepalive**：
- 3分钟 PING keepalive 防止空闲断线
- 433 nick 冲突自动切换备用昵称
- 15秒注册超时强制重连
- 指数退避重连（5s→10s→20s→40s→60s）
- `writeStatus()` 添加 `registered` 字段（之前缺失导致 status.json 始终显示 registered=false）

### 8.12 锁过期故障：DSH 不出声（2026-08-31）

**现象**：IRC 频道 #xia 有大量消息（用户与第三方 bot nanoclaw 对话），但 DSH 驱动的 `deepseek_ai` 完全不回复；`irc-xia` 会话视图为空（只有 session-start 注入的人设 system-reminder，无实际聊天内容）。

**排查**：
- `irc-bot.js` 代码审查确认已是纯传输层（`onMessage` 只写 inbox，`drainOutbox` 只读 outbox），无自回复逻辑——"频道里的回复"来自第三方 bot `nanoclaw`，与本 bot 无关。
- DSH 进程运行正常，但插件日志反复出现 `interval skipped due to lock`；锁文件时间戳已超过 3600s 超时。
- `/home/lucloner/.dsh/sessions/irc-xia/` 不存在 → 插件从未成功创建会话。

**根因**：插件的文件锁是"加载时一次性检查"。DSH 重启后 autoload 重载插件，`apply()` 检查锁文件发现时间戳仍在 3600s 内（旧实例退出前刷新过），跳过 interval 创建，**之后不再重查**。持锁实例已死亡但锁未过期 → 新实例永久停止轮询 → inbox 积压（36 行）→ `agent.followup()` 永不触发 → 无 `assistant/message` 事件。

**修复**：`rm plugin.lock` + 重启 DSH。新实例获取锁（`lock acquired at 07:52:15Z`），积压 inbox 被消费清空，rate-limiting（accumulated=31 → next_required=32）与冷却重置（was 32 → 1）均验证正常。

**遗留观察点**：
1. `resume failed: cannot prepare session "irc-xia" while it is live` —— 重启后 resume 与旧 live 会话冲突，走 fallback 路径，功能未受影响但值得跟进。
2. 锁应改为 interval 内定期重查归属，而非仅加载时检查一次。
3. 第三方 bot（nanoclaw）的回复也写入 inbox，会被 DSH 当作用户消息处理，可考虑过滤。

详细记录见 `docs/修复重复回复-行动计划.md` §4、`docs/IRC-Bot修复计划-DSH核心驱动.md`。
