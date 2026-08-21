# dsh-irc

一个把 IRC 聊天接入 **DeepSeek Harness (DSH)** Web GUI 的完整方案，包含两部分：

1. **`irc-bot/`** — 独立的 Node.js IRC bot（真实 TCP 连接、LLM 回复、MCP 工具调用、supervisor 自动重启）
2. **`plugin/`** — DSH Cordis 插件（在 Web GUI 注入 IRC 浮动面板，与 bot 联动）

面板与 bot 通过 **outbox 队列**（`outbox.ndjson`）通信：面板输入 → 写入队列 → bot 每 500ms 读取并发送到频道。

---

## 目录结构

```
dsh-irc/
├── README.md                 # 本文件
├── irc-bot/                  # 独立 IRC bot
│   ├── irc-bot.js            # bot 主程序（Node net 真实 TCP）
│   ├── run.sh                # supervisor：确保 bot 始终运行，退出自动重启
│   └── irc.json              # 配置：服务器 / nick / 频道 / LLM / 回复策略
├── plugin/                   # DSH Cordis 插件
│   ├── host.js               # Host 端：8 个 RPC handler
│   ├── client.js             # Client 端：IRC 浮动面板 UI
│   └── plugin.json           # 插件元数据
├── docs/                     # 设计与排障文档
│   ├── irc-chat-tools-bridge.md
│   ├── irc-cordis-plugin.md
│   ├── irc-real-bot.md
│   └── irc-scroll-to-bottom-fix.md
└── install.sh                # 一键安装脚本
```

---

## 快速开始

### 1. 配置 bot

编辑 `irc-bot/irc.json`：

```json
{
  "server": { "host": "192.168.4.252", "port": 6667, "tls": false },
  "nick": "deepseek_ai",
  "user": "deepseekai",
  "channel": "#xia",
  "maxRounds": 20,
  "llm": {
    "base": "http://127.0.0.1:4000/v1",
    "model": "n_qwen3.8",
    "keyFile": "/home/lucloner/.dsh/.credentials.yaml",
    "system": "你在 IRC 频道 #xia 里，昵称 deepseek_ai。..."
  },
  "reply": {
    "enabled": true,
    "scope": "all",
    "cooldownMs": 1500,
    "maxLen": 320,
    "maxRepliesPerBurst": 3,
    "burstWindowMs": 10000,
    "ignoreNicks": ["hermes", "nanoclaw"]
  },
  "logDir": "/home/lucloner/.dsh/irc-bot"
}
```

关键字段：
- **server** — IRC 服务器地址、端口、是否 TLS
- **llm.base** — OpenAI 兼容的 LLM 端点（本地 LiteLLM proxy）
- **llm.keyFile** — 含 `LITELLM_API_KEY: sk-...` 的凭证文件
- **llm.model** — 回退模型（bot 优先跟随 DSH 会话最新使用的模型，见下）
- **reply** — 回复策略：冷却、爆发上限、忽略的 bot nick

### 2. 启动 bot（supervisor 自动重启）

```bash
cd irc-bot
./run.sh &          # 后台 supervisor，bot 崩溃自动重启
```

或直接前台运行调试：`node irc-bot.js`

### 3. 安装 DSH 插件

在 DSH 中把 `plugin/host.js` + `plugin/client.js` 加载为 Cordis 插件（`irct-4`），
或运行 `./install.sh` 参考安装。安装后刷新浏览器，侧边栏底部出现 **IRC** 按钮。

---

## 面板命令

在面板输入栏输入（以 `/` 开头为命令，否则自动当作 `/irc say` 发送到频道）：

| 命令 | 说明 |
|------|------|
| `/irc status` | 查看 IRC 连接状态（固定显示，不自动隐藏） |
| `/irc say <text>` | 发送消息到频道 |
| `/irc connect` | 启动 IRC bot |
| `/irc disconnect` | 停止 IRC bot |
| `/irc restart` | 重启 IRC bot（supervisor 自动复活） |
| `/irc models` | 列出可用 LLM 模型 |
| `/irc model <name>` | 切换 bot 模型（写回 irc.json 并重启 bot） |
| `/irc help` | 显示帮助 |
| `/skills list` | 列出可用技能 |
| `/skill <name>` | 查看技能详情 |
| `/tool <name> {json}` | 调用 MCP/DSH 工具 |

> 任何不以 `/` 开头的输入会被自动当作 `/irc say <text>` 发送到频道。

---

## 面板特性

- **sticky 区**：顶部最多 3 条提示消息，超出丢弃最旧
- **消息区**：最多 1000 条
- **自动滚动**：默认开启，打开面板即滚到底部；可手动切换 / 一键到底
- **连接状态**：标题栏绿点 + `(online)` 表示已连接
- **命令历史**：预留（上下键浏览）

---

## 架构与数据流

```
[IRC 频道 #xia]
      │  PRIVMSG in/out (TCP)
      ▼
[irc-bot.js]  ── LLM 回复 ──▶ LiteLLM proxy ──▶ 模型
      │  MCP 工具调用 ──▶ ~/.config/opencode/opencode.json 中的 MCP servers
      │
      ├── 写 conversation.ndjson + status.json（日志目录）
      └── 读 outbox.ndjson（外部发送队列）
              ▲
              │  fs.writeText (danger-full-access)
[DSH Web GUI 面板 (plugin/client.js)]
      │  host.call('irc-send'|'get-irc-messages'|...)
      ▼
[plugin/host.js] 8 个 RPC handler
```

### 模型跟随系统

bot 默认不固定模型，而是扫描 DSH 会话存储（`~/.dsh/sessions/**/session.jsonl.zstd`）
中最新的 `"model":"..."`，跟随 DSH 当前使用的模型；失败回退 `irc.json` 的 `llm.model`。
面板 `/irc model` 可手动覆盖。

### 上下文窗口兜底

若模型返回上下文超限错误（`Request exceeds model context window`），bot 自动重试一次
不带 tools；只有上下文错误才永久记入该模型的 no-tools 列表。

---

## 环境变量（插件可移植性）

插件路径默认硬编码，可用环境变量覆盖：

| 变量 | 默认 | 说明 |
|------|------|------|
| `DSH_IRC_LOG_DIR` | `~/.dsh/irc-bot` | 会话日志目录 |
| `DSH_IRC_BOT_DIR` | `../irc-bot` | bot 源码目录 |
| `DSH_IRC_LLM_CONFIG` | `/etc/litellm/config.yaml` | LiteLLM 模型配置 |

bot 侧 `run.sh` 支持 `IRC_BOT_LOG_DIR` 覆盖日志目录，`BOT_DIR` 自动取脚本所在目录。

---

## 排障

- **面板消息发不出去**：确认 outbox 写入用了 `danger-full-access`（Cordis fs 默认
  workspace-write 会拒绝写 workspace 外路径）。见 `docs/irc-chat-tools-bridge.md` §14.4。
- **bot 不回复**：检查 `status.json` 的 `connected`、`model`、`mcpFailed`。
- **supervisor 误判**：`run.sh` 用 `pgrep -f 'node irc-bot.js'` 精确匹配，避免匹配到
  命令行含该字符串的 bash 进程。
- **模型切换不生效**：`/irc model` 写回 `irc.json` 并 pkill bot，supervisor 自动用新模型重启。

更多细节见 `docs/`。
