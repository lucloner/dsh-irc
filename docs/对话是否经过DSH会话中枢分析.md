# dsh-irc 对话是否经过 DSH 会话处理中枢 — 分析记录

> ⚠️ **本文档描述的是旧架构（2026-08-24 分析）。** 2026-08-26 已改为「薄 transport + DSH agent 路由」，IRC 对话现在**经过** DSH 会话中枢。请参阅 `docs/对话经过DSH会话中枢-架构变更记录.md`。
>
> 问题：插件中使用对话系统，会经过 deepseek-harness（DSH）的会话处理中枢吗？
> 结论（旧架构）：**不会**。对话完全旁路 DSH 会话中枢，DSH 仅充当「文件中转站 + tools/skills 服务调用方」。
> 分析日期：2026-08-24
> 涉及代码：
>
> - 插件：`/mnt/raid/source/src/dsh-irc/plugin/`（`client.js` / `host.js` / `plugin.json`）
> - IRC bot：`/mnt/raid/source/src/dsh-irc/irc-bot/irc-bot.js`
> - DSH 源码：`/mnt/raid/source/src/deepseek-harness/`

---

## 0. TL;DR

| 组件                                | 是否经过 DSH 会话中枢 | 说明                                                        |
| ----------------------------------- | --------------------- | ----------------------------------------------------------- |
| 插件面板（`plugin/`）               | 否                    | 面板只做文件读写与控制，不产生对话                          |
| IRC bot 的 LLM 对话（`irc-bot.js`） | 否                    | 直连 LiteLLM 代理，自管上下文与 agent loop                  |
| `execute-tool` / `get-skill` 调用   | 部分                  | 走 DSH 的 `tools`/`skills` 服务，但那是工具服务，非会话中枢 |

**唯一与 DSH 会话存储有交集**：bot 启动时读取 `~/.dsh/sessions/**/session.jsonl.zstd` 的最后一条 `"model"` 字段做模型名发现（仅发现，请求不路由进 DSH）。

---

## 1. 插件层（`plugin/`）本身不产生对话

`client.js`（Web 浮动面板）通过 `host.call(...)` 调用 `host.js` 注册的 8 个 RPC handler。这些 handler 做的是**文件读写与进程控制**，不是对话生成：

| Handler            | 行为                                                                             | 是否涉及 DSH 会话中枢        |
| ------------------ | -------------------------------------------------------------------------------- | ---------------------------- |
| `get-irc-messages` | 读 `conversation.ndjson`（bot 自落盘的日志）                                     | 否                           |
| `get-irc-status`   | 读 `status.json`（bot 自写状态）                                                 | 否                           |
| `irc-send`         | 追加 `outbox.ndjson` 队列                                                        | 否                           |
| `irc-control`      | `connect/disconnect/restart/switch-model`，通过 `ctx.get('shell')` 起停 bot 进程 | 否（走 shell 服务）          |
| `get-irc-models`   | 解析 `/etc/litellm/config.yaml`                                                  | 否                           |
| `execute-tool`     | 走 `ctx.get('tools')` 执行 DSH 工具                                              | 走 tools 服务（非会话中枢）  |
| `get-skill`        | 走 `ctx.get('skills')` 读技能                                                    | 走 skills 服务（非会话中枢） |
| `list-skills`      | 同上                                                                             | 同上                         |

**关键观察**：面板里看到的"对话消息"只是把 bot 落盘的 `conversation.ndjson` 记录渲染出来，面板本身不发起任何 LLM 请求。`host.js:38-57` 的 `get-irc-messages` 就是纯文件读取。

唯一与 DSH 内部服务交互的是 `tools` 和 `skills`，但这两者是 DSH 的**工具/技能服务**，不是"会话处理中枢"（session / compaction / context / agent loop 等包）。

---

## 2. 真正的 LLM 对话在独立 bot 进程，完全绕过 DSH

bot（`irc-bot/irc-bot.js`）作为独立 Node 进程运行（由插件通过 `shell.run` 启停），对话回路完全自包含：

### 2.1 LLM 请求直连 LiteLLM 代理

```js
// irc-bot.js:478
const res = await fetch(llm.base + '/chat/completions', { ... })
```

请求直接打到 `llm.base`（本地 LiteLLM 代理），**不经 DSH 的 `packages/llm`、`session`、`compaction`、`context` 等任何会话相关包**。

### 2.2 上下文自管

- 自带 20 轮 FIFO `buffer` 作为 LLM 上下文（`irc-bot.js:9, 493-496`）
- 不使用 DSH 的上下文管理 / 压缩 / compaction
- 满则 `shift()` 丢弃最旧一轮（`irc-bot.js:630, 642`）

### 2.3 自带 Agentic Loop

bot 自己实现了工具调用回路（`irc-bot.js:506-550`）：

```
for (turn = 0; turn < 4; turn++) {
  msg = await chatOnce(messages, useTools)
  if (msg.tool_calls) {
    // 执行工具 → 回灌 tool 结果 → continue
  } else {
    finalText = msg.content
    break
  }
}
```

不经过 DSH 的 agent loop / subagent / workflow 等包。

### 2.4 MCP 自连

bot 直接读 `~/.config/opencode/opencode.json` 的 `mcp` 配置，自己实现 `McpHttp` / `McpStdio` 两种 transport 连接 MCP server（`irc-bot.js:130-382`），**不复用 DSH 的 MCP 连接层**（`packages/mcp`）。

### 2.5 与 DSH 会话存储的唯一交集：模型名发现

```js
// irc-bot.js:99-128  resolveModel()
const sessionsRoot = path.join(os.homedir(), ".dsh", "sessions");
// 遍历找最新 session.jsonl.zstd
// zstd 解压后正则匹配最后一个 "model":"..." 字段
```

这只是为了**让 bot 用上和 DSH 当前会话相同的模型**（"model follows the system"），是**只读的模型名发现**，请求本身并不路由进 DSH 会话中枢。

---

## 3. 数据流总览

```
┌─────────────────────────────────────────────────────────────┐
│  DSH Web GUI（浏览器）                                        │
│  ┌────────────────────┐                                      │
│  │ IRC 浮动面板         │ client.js                            │
│  │ (React, slots.inject)│                                     │
│  └─────────┬──────────┘                                      │
│            │ host.call('irc-send' / 'get-irc-messages' / …)   │
│            ▼                                                  │
│  ┌────────────────────┐                                      │
│  │ host.js (Cordis)    │  ← 注册 8 个 RPC handler              │
│  │  inject: ['fs']     │                                      │
│  └──┬───────────┬─────┘                                      │
│     │ fs        │ ctx.get('shell'/'tools'/'skills')           │
│     ▼           ▼                                              │
│  outbox.ndjson  DSH services（shell / tools / skills）        │
│  conv.ndjson    ↑ 仅工具/技能/进程控制，非会话中枢             │
└─────────────────│────────────────────────────────────────────┘
                  │ shell.run 起/停
                  ▼
┌─────────────────────────────────────────────────────────────┐
│  irc-bot.js（独立 Node 进程）                                 │
│   ├─ net.connect → IRC 服务器（192.168.4.252:6667）          │
│   ├─ drainOutbox() ← 读 outbox.ndjson → PRIVMSG 到频道       │
│   ├─ onMessage() → generateReply()                           │
│   │    ├─ buffer（自管 20 轮上下文）                          │
│   │    ├─ fetch(llm.base + '/chat/completions')  ← 直连     │
│   │    │    LiteLLM 代理（不经 DSH 会话中枢）                │
│   │    └─ agentic loop（自管工具调用→回灌，≤4 轮）           │
│   ├─ MCP：自读 opencode.json，自连 streamable-http / stdio   │
│   ├─ resolveModel()：只读 ~/.dsh/sessions/**/*.zstd 的模型名 │
│   └─ log → conversation.ndjson + status.json                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 证据索引（file:line）

| 断言                                  | 证据                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| 插件面板不发起 LLM 请求               | `client.js` 全文无 `fetch`/`chat/completions`，仅 `host.call(...)`                         |
| host handler 做文件读写而非对话       | `host.js:38-57`（读 ndjson）、`host.js:66-79`（写 outbox）、`host.js:82-110`（shell 起停） |
| 唯一接入 DSH 服务的是 tools/skills    | `host.js:135` `ctx.get('tools')`、`host.js:157,169` `ctx.get('skills')`                    |
| bot 直连 LiteLLM                      | `irc-bot.js:478` `fetch(llm.base + '/chat/completions')`                                   |
| bot 自管上下文                        | `irc-bot.js:45` `buffer`、`irc-bot.js:493-496` 拼 messages                                 |
| bot 自管 agent loop                   | `irc-bot.js:506-550` for-loop 工具调用回灌                                                 |
| bot 自连 MCP                          | `irc-bot.js:338-382` `discoverMcp` 读 opencode.json                                        |
| 与 DSH 会话存储唯一交集（只读模型名） | `irc-bot.js:99-128` `resolveModel`                                                         |

---

## 5. 含义与边界

- **可移植性**：bot 与 DSH 的耦合点只有三处——①读 `~/.dsh/sessions/**` 取模型名；②读 `~/.config/opencode/opencode.json` 取 MCP 配置；③由 DSH 的 `shell` 服务起停。去掉这三处即可脱离 DSH 独立运行。
- **会话隔离**：bot 的对话历史（`conversation.ndjson` + 内存 `buffer`）与 DSH 自身的会话存储（`~/.dsh/sessions/`）是**两套独立数据**，互不写入、互不压缩、互不索引。
- **工具调用路径分叉**：用户在面板里用 `/tool` 命令 → 走 DSH `tools` 服务（`host.js:133-152`）；bot 在生成回复时调工具 → 走 bot 自连的 MCP（`irc-bot.js:453-463`）。两条路径互不影响。
- **模型一致性**：bot 通过 `resolveModel()` 跟随 DSH 当前模型，是为了对话风格统一，但请求仍走 LiteLLM 代理而非 DSH 会话管线，所以 DSH 的 system prompt、preset、guard、hooks 等会话级能力**对 bot 对话全部不生效**。

---

## 6. 相关文档

- `docs/irc-cordis-plugin.md` — 插件开发记录（含早期 6 工具版的设计，与本分析所指的浮动面板版不同，但架构一致）
- `docs/irc-chat-tools-bridge.md` — IRC 与聊天工具桥接
- `docs/irc-real-bot.md` — 真实 IRC bot 说明
