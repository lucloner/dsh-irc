# 真实 IRC Bot — `deepseek_ai`（#xia）完成记录

> 状态：**已完成并端到端验证通过**（TCP 直连 InspIRCd-4，20 轮 FIFO 会话缓冲，LLM 自动回复）。
> 关联文档：
> - `docs/irc-cordis-plugin.md` — Cordis 逻辑会话插件版（进程内，无 raw TCP socket）
> - `docs/cordis-define-model-stringification-bug.md` — cordis_define 字符串容忍根因

## 1. 结论

- Bot **真实连接**到 IRC 服务器 `192.168.4.252:6667`（InspIRCd-4，网络 LocalIRCNet），加入频道 `#xia`。
- Nick `deepseek_ai`，User `deepseekai`（解决 USERLEN=10 限制）。
- **最多只记录 20 轮会话**：FIFO buffer 严格上限 20 条消息（含 inbound + outbound），超出自动丢弃最早条目。
- AI 回复通过本地 LiteLLM proxy (`http://127.0.0.1:4000/v1`)，使用模型 `n_qwen3.8`——与 DSH 第一个 workspace 的 agent-default-model 一致。
- **端到端验证**：probe 客户端 JOIN → PRIVMSG → bot 收到 → generateReply(LiteLLM) → PRIVMSG 回复，完整链路确认通过。

## 2. IRC 服务器信息

| 项目 | 值 |
|------|-----|
| 主机 | `192.168.4.252`（`irc.biggee.cn` / `biggee.chat`） |
| 端口 | `6667`（明文 TCP，无 TLS） |
| 软件 | InspIRCd-4 |
| 网络名 | LocalIRCNet |
| 频道 | `#xia`（无 key，无需密码） |
| USERLEN | 10 字符 |
| NICKLEN | 30 字符 |

## 3. #xia 频道成员

在线 bot：`deepseek_ai`、`hermes`（gpt-oss-120b-cloud）、`nanoclaw`（中文回复）、`BiggeeL`。
人类用户：`xia`、`Biggee@192.168.0.2`（可能离线）。

## 4. Bot 配置（irc.json）

配置文件位于 `irc-bot/irc.json`，所有参数可热修改后重启 bot：

```jsonc
{
  "server": {
    "host": "192.168.4.252",    // IRC 服务器地址
    "port": 6667,               // TCP 端口（明文）
    "tls": false                // TLS 开关
  },
  "nick": "deepseek_ai",         // IRC nick（用户授权自定义）
  "user": "deepseekai",          // IRC user（USERLEN=10，不能超过）
  "channel": "#xia",             // 加入的频道
  "maxRounds": 20,               // FIFO 会话缓冲上限

  "llm": {
    "base": "http://127.0.0.1:4000/v1",   // LiteLLM proxy
    "model": "n_qwen3.8",                   // DSH agent-default-model
    "keyFile": "/home/lucloner/.dsh/.credentials.yaml",  // API key 来源
    "system": "你在 IRC 频道 #xia 里，昵称 deepseek_ai。你是由 DeepSeek Harness 驱动的 AI 助手..."
  },

  "reply": {
    "enabled": true,
    "cooldownMs": 1500,        // 两次回复之间最小间隔（ms）
    "maxLen": 320,             // 回复最大字符数
    "maxRepliesPerBurst": 3,   // burstWindowMs 内最多回复次数
    "burstWindowMs": 10000,    // burst 窗口
    "ignoreNicks": ["hermes", "nanoclaw"]  // 忽略的 bot nick（防回声循环）
  },

  "logDir": "/home/lucloner/.dsh/irc-bot"   // NDJSON 日志目录
}
```

## 5. Bot 架构（irc-bot.js）

### 5.1 模块概览

| 函数/变量 | 职责 |
|-----------|------|
| `connect()` | 创建 TCP socket → `net.connect(host, port)` → `onConnected` |
| `onConnected()` | 发送 `NICK <nick>` + `USER <user> 0 * :<nick>`，等待 001/376 后 JOIN |
| `handleLine(line)` | 解析 IRC 行：PING→PONG、001→JOIN、PRIVMSG→onMessage |
| `onMessage(sender, text)` | 入 FIFO buffer（上限 maxRounds）、检查 shouldReply()、调用 generateReply()、发送 PRIVMSG |
| `shouldReply(sender)` | ignoreNicks / cooldown / burst cap / self-check |
| `generateReply(inbound)` | POST LiteLLM `/chat/completions`，messages = system + buffer + inbound → 返回 AI text |
| `readKey()` | 正则从 `.credentials.yaml` 提取 LITELLM_API_KEY |

### 5.2 IRC 协议流程

```
1. TCP connect(host:port)
2. onConnected() → send('NICK deepseek_ai')
3.              → send('USER deepseekai 0 * :deepseek_ai')
4. 收到 001 Welcome → registered=true, send('JOIN #xia')
5. 收到 JOIN ack + NAMES → bot 在频道内，开始监听 PRIVMSG
6. PING 周期性发送 → PONG 响应（保持存活）
7. 收到 PRIVMSG <channel> :<text> → onMessage()
```

### 5.3 20 轮 FIFO Buffer 语义

- `buffer` 数组存储 `{ nick, text, ts, dir }`，dir 为 `'in'`（他人消息）或 `'out'`（bot 回复）。
- 每次入队后 `while (buffer.length > maxRounds) buffer.shift()`。
- Buffer 同时作为 LLM context：每条 inbound 消息推入 messages 列表，bot 的 outbound 标记为 assistant role。
- 实际发送给 LiteLLM 的消息数 ≤ 20（inbound + outbound），满足"最多只记录 20 轮会话"需求。

### 5.4 Anti-Loop 机制

| 检查项 | 实现 |
|--------|------|
| 不回复自己 | `sender !== nick` |
| 忽略其他 bot | `reply.ignoreNicks.includes(sender)` → `["hermes", "nanoclaw"]` |
| 冷却时间 | `ms - lastReplyAt < reply.cooldownMs`（默认 1500ms） |
| Burst cap | burstWindowMs(10s) 内最多 maxRepliesPerBurst(3) 次回复 |

### 5.5 断线重连策略

指数退避：`delay = min(30000, 2000 * 2^attempt)`，最大 30 秒。每次重连重置 `registered=false`，重新走 NICK→USER→JOIN 流程。

## 6. LLM 路由细节

- **API Key**：从 `/home/lucloner/.dsh/.credentials.yaml` 正则提取 `LITELLM_API_KEY\s*[:=]\s*['"]?(sk-[A-Za-z0-9_-]+)`
- **请求格式**：POST `http://127.0.0.1:4000/v1/chat/completions`，headers 含 `Authorization: Bearer <key>`。
- **消息体**：`{ model: "n_qwen3.8", messages: [...], max_tokens: 200, temperature: 0.7 }`
- **messages 结构**：
  - `[0]`: `{ role: "system", content: llm.system }`（中文指令，要求简洁 IRC 聊天风格）
  - `[1..N]`: buffer 中的每条消息 → user/assistant 根据 nick === nick 判断
  - `[last]`: `{ role: "user", content: inbound_text }`

## 7. 日志与监控

### 7.1 NDJSON 事件日志（conversation.ndjson）

每行一个 JSON 对象，包含 `ts`（ISO-8601）、`ev`（事件类型）和可选数据字段：

| ev 值 | 含义 |
|-------|------|
| `connected` | TCP 连接建立 |
| `registered` | 收到 001/376，已完全注册到 IRC 服务器 |
| `joined` | JOIN ack（含 line: `:<nick>!user@host JOIN :<channel>`） |
| `recv` | 收到 PRIVMSG（from, text） |
| `send` | 发送 PRIVMSG（text） |
| `llm-error` | LLM API 调用失败（message: error text） |
| `shutdown` | SIGTERM/SIGINT 接收，主动关闭 |
| `disconnected` / `reconnect-in` | 断线及重连倒计时 |

### 7.2 status.json

实时状态快照（每次 recv/send/join/注册变化时更新），包含：
- `connected`: boolean
- `nick`, `channel`, `server:port`
- `rounds`: 总 inbound 消息数
- `replies`: 总 outbound AI 回复数
- `llmErrors`: LLM 调用失败次数
- `bufferLen`: 当前 buffer 长度（≤ maxRounds）
- `replyEnabled`: boolean

## 8. 启动与停止

### 启动
```bash
cd /raid/source/src/shell/irc-bot
setsid nohup node irc-bot.js > /home/lucloner/.dsh/irc-bot/bot-stdout.log 2>&1 &
```

### 停止（按 node exe 过滤，避免 pkill -f 匹配自身）
```bash
for pid in $(pgrep -f 'irc-bot.js'); do
  exe=$(readlink /proc/$pid/exe)
  case "$exe" in *node*) kill $pid ;; esac
done
```

### 重启（编辑配置后）
先杀旧进程 → `setsid nohup node irc-bot.js ... &`。bot 自动重连并 JOIN #xia。

## 9. 端到端验证记录

| 时间 | Probe nick | 发送消息 | Bot 回复 | 状态 |
|------|-----------|---------|---------|------|
| 16:22:03 | mt3 | "Hello deepseek_ai! Reply with hi." | "hi！" | ✅ |
| 16:26:33 | e2etest2 | "deepseek_ai, what is 2+2 in Chinese?" | "2+2 等于四，四。"/"四啊，sì，这还用问嘛 😄" | ✅ |

两次验证均确认：
- Bot 收到 PRIVMSG（`recv` 事件）→ generateReply → LLM POST → `send` 事件发送回复。
- Anti-loop 生效：忽略 hermes/nanoclaw 消息、不回复自己。
- FIFO buffer 上限 20 轮精确生效。

## 10. Supervisor（自动启动 + 断线重连）

### run.sh — Bot supervisor

位于 `irc-bot/run.sh`，功能：
- **启动时自动连接**：调用 `node irc-bot.js` 直连 IRC 服务器
- **进程守护**：每 5 秒检查 bot 是否存活，未运行则自动重启
- **断线重连策略**：bot 内部 `close` 事件触发后，**固定 60 秒（1 分钟）后重试连接**
- **connect-error 处理**：TCP connect() 异常后同样 **60 秒后重试**

### irc-bot.js 内重连逻辑（§5.4 已改）

```js
// close 事件 — 断线后每分钟重连
sock.on('close', () => {
  // ...
  const delay = 60000 // 固定 1 分钟，不再指数退避
  setTimeout(connect, delay)
})

// catch 块 — connect() 异常后每分钟重试
catch (e) {
  log('connect-error', ...)
  setTimeout(connect, 60000)
}
```

### supervisor 日志

- `irc-bot/bot-supervisor.log` — supervisor 启动/停止事件
- `irc-bot/bot-stdout.log` — bot stdout/stderr（含 NDJSON log() 输出）

| 维度 | Cordis 插件版（irc-cordis-plugin.md） | 真实 Bot 版（本文档） |
|------|---------------------------------------|---------------------|
| 运行环境 | 受限 DSH 插件运行时（无 raw TCP socket） | Node.js 独立进程（`net` 模块直连） |
| "连接"语义 | 逻辑会话（工具模拟 IRC 收发） | 真实 TCP → InspIRCd-4 → #xia |
| 20 轮 Buffer | ✅ cordis_define 内实现 | ✅ irc-bot.js buffer.shift() |
| LLM 路由 | LiteLLM POST（同本文档） | LiteLLM POST（同本文档） |
| 可见性 | DSH UI 工具卡片 | IRC NAMES #xia + The Lounge 频道 |

**选择理由**：受限插件运行时无 raw TCP socket，无法直连 IRC 服务器。真实连接必须走独立 Node 进程。Cordis 插件版可作为 supervisor（irc_status/irc_read/irc_send 等工具）包装本 bot——后续可选项。

## 11. 配置文件路径

| 文件 | 用途 |
|------|------|
| `irc-bot/irc.json` | Bot 配置（nick, user, channel, LLM route, reply settings） |
| `irc-bot/irc-bot.js` | Bot 实现（221 lines，Node `net` + FIFO buffer + LiteLLM） |
| `/home/lucloner/.dsh/irc-bot/conversation.ndjson` | NDJSON 事件日志 |
| `/home/lucloner/.dsh/irc-bot/status.json` | 实时状态快照 |
| `/home/lucloner/.dsh/irc-bot/bot-stdout.log` | bot stdout/stderr（含 log() JSON） |
| `/home/lucloner/.dsh/.credentials.yaml` | LITELLM_API_KEY 来源 |

## 12. 后续可选项

1. **Cordis Supervisor 插件**：用 cordis_define 创建 irc-supervisor 插件，提供 irc_status/irc_read/irc_send/irc_restart/irc_stop 工具，绑定到第一个 workspace。
2. **多频道支持**：配置解析 `channel` 为数组，JOIN 多个频道。
3. **@mention 触发**：只在收到 `PRIVMSG #xia :<nick> <text>`（含 nick）时回复，而非所有消息。
4. **Webhook/HTTP API**：暴露 `/api/bot/status` 供 The Lounge 或其他客户端查询 bot 状态。
