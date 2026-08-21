# dsh-irc

> **⚠️ 中文单语言界面** — This software uses a **single Chinese-language interface only**. All UI labels, help text, and system prompts are in Chinese. English is used only in this README for documentation.
>
> **⚠️ Chinese-only UI** — 本软件为**中文单语言界面**。所有 UI 标签、帮助文本和系统提示均为中文；英文仅用于本 README 文档。

An IRC chat bridge for **DeepSeek Harness (DSH)** Web GUI, consisting of three parts:

1. **`irc-bot/`** — Standalone Node.js IRC bot (real TCP connection, LLM replies, MCP tool calls, supervisor auto-restart)
2. **`plugin/`** — DSH Cordis plugin (injects an IRC floating panel into the Web GUI, interoperates with the bot)
3. **`autoload/`** — **dsh-autoload** framework: a generic DSH dynamic-plugin autoloader that auto-registers the IRC panel at DSH startup (no manual `run` after restart). The IRC panel is the framework's first example component.

The panel and bot communicate via an **outbox queue** (`outbox.ndjson`): panel input → write to queue → bot reads every 500ms and sends to channel.

---

## Table of Contents

```
dsh-irc/
├── README.md                 # This file
├── irc-bot/                  # Standalone IRC bot
│   ├── irc-bot.js            # Bot main program (Node net real TCP)
│   ├── run.sh                # Supervisor: ensures bot always runs, auto-restart on crash
│   └── irc.json              # Config: server / nick / channel / LLM / reply policy
├── plugin/                   # DSH Cordis plugin (first autoload component)
│   ├── host.js               # Host side: 8 RPC handlers
│   ├── client.js             # Client side: IRC floating panel UI
│   └── plugin.json           # Plugin metadata
├── autoload/                 # dsh-autoload framework (generic, reusable)
│   ├── index.js              # Auto-loader plugin (standard Cordis host)
│   ├── package.json          # @dsh-mod/dsh-autoload
│   └── README.md             # Framework docs + how to add components
├── docs/                     # Design and troubleshooting docs
│   ├── irc-chat-tools-bridge.md
│   ├── irc-cordis-plugin.md
│   ├── irc-real-bot.md
│   └── irc-scroll-to-bottom-fix.md
└── install.sh                # One-click installation script
```

---

## Prerequisites

- **DeepSeek Harness (DSH)** Web profile running (`dsh --profile web`)
- **Node.js** ≥ 18 (for the bot)
- An **IRC server** to connect to
- An **OpenAI-compatible LLM endpoint** (e.g. local LiteLLM proxy) for bot replies

---

## Installation

### 1. Install the IRC bot

The bot is a standalone Node.js program. No build step is needed.

```bash
cd irc-bot
npm install   # if any dependencies are declared; otherwise skip
```

### 2. Configure the bot

Edit `irc-bot/irc.json` — see [Configuration](#configuration) below.

### 3. Start the bot (supervisor auto-restart)

```bash
cd irc-bot
./run.sh &          # Background supervisor; bot crashes auto-restart
```

Or run in foreground for debugging: `node irc-bot.js`

### 4. Install the DSH panel (auto-load)

The panel is a **dynamic Cordis plugin** auto-registered by the `autoload/` framework at DSH startup.

1. Add the framework as a local dependency in the profile's `package.json`:

   ```json
   {
     "dependencies": {
       "@dsh-mod/dsh-autoload": "file:../../../src/dsh-irc/autoload"
     }
   }
   ```

2. Run `npm install` in the profile directory.

3. Register the IRC component in the profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: dsh-autoload
         name: '@dsh-mod/dsh-autoload'
         inject: ['dynamicCordisRunner']
         config:
           components:
             - id: irc
               name: 'IRC Chat Panel'
               purpose: '...'
               idPrefix: 'irct'
               hostFile: '/home/lucloner/src/dsh-irc/plugin/host.js'
               clientFile: '/home/lucloner/src/dsh-irc/plugin/client.js'
   ```

4. Restart DSH: `systemctl --user restart dsh-web.service`

5. **Refresh the browser** — the **IRC** button appears at the sidebar bottom automatically.

> The `autoload/` framework is generic and reusable. See [`autoload/README.md`](autoload/README.md) for how to add more components.

---

## Configuration

### `irc-bot/irc.json`

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

Key fields:

| Field | Description |
|-------|-------------|
| `server` | IRC server address, port, TLS enabled/disabled |
| `nick` / `user` | Bot identity on the IRC network |
| `channel` | Channel to join (e.g. `#xia`) |
| `llm.base` | OpenAI-compatible LLM endpoint (local LiteLLM proxy) |
| `llm.keyFile` | Credentials file containing `LITELLM_API_KEY: sk-...` |
| `llm.model` | Fallback model (bot follows DSH session's latest used model by default, see below) |
| `reply` | Reply policy: cooldown, burst limit, ignored bot nicks |
| `logDir` | Where `conversation.ndjson` + `status.json` are written |

### Panel path constants (`plugin/host.js`)

The Cordis dynamic Host runtime has **no** `process`/`require`/`os`/`path`, cannot read environment variables,
so plugin paths are **hardcoded**. Edit the three constants at the top of `plugin/host.js` when publishing or porting:

| Constant | Default | Description |
|----------|---------|-------------|
| `LOG` | `/home/lucloner/.dsh/irc-bot` | Session log directory |
| `BOT_DIR` | `/raid/source/src/shell/irc-bot` | Bot source directory |
| `LLM_CONFIG` | `/etc/litellm/config.yaml` | LiteLLM model config |

The bot-side `run.sh` supports overriding the log directory via `IRC_BOT_LOG_DIR`; `BOT_DIR` auto-detects from script location.

---

## Panel Commands

Type in the panel input bar (commands start with `/`, otherwise auto-sent to channel as `/irc say`):

| Command | Description |
|---------|-------------|
| `/irc status` | View IRC connection status (fixed display, does not auto-hide) |
| `/irc say <text>` | Send message to channel |
| `/irc connect` | Start IRC bot |
| `/irc disconnect` | Stop IRC bot |
| `/irc restart` | Restart IRC bot (supervisor auto-recovers) |
| `/irc models` | List available LLM models |
| `/irc model <name>` | Switch bot model (writes back to irc.json and restarts bot) |
| `/irc help` | Show help |
| `/skills list` | List available skills |
| `/skill <name>` | View skill details |
| `/tool <name> {json}` | Call MCP/DSH tool |

> Any input not starting with `/` is automatically sent to the channel as `/irc say <text>`.

---

## Panel Features

- **Sticky area**: Up to 3 top hint messages; oldest discarded when exceeded
- **Message area**: Up to 1000 messages
- **Auto-scroll**: Enabled by default, scrolls to bottom on panel open; can toggle manually or scroll-to-bottom with one click
- **Connection status**: Green dot in title bar + `(online)` indicates connected
- **Command history**: Reserved (up/down arrow browsing)

---

## Architecture & Data Flow

```
[IRC Channel #xia]
       │  PRIVMSG in/out (TCP)
       ▼
[irc-bot.js]  ── LLM reply ──▶ LiteLLM proxy ──▶ Model
       │  MCP tool call ──▶ MCP servers in ~/.config/opencode/opencode.json
       │
       ├── Write conversation.ndjson + status.json (log directory)
       └── Read outbox.ndjson (external send queue)
               ▲
               │  fs.writeText (danger-full-access)
[DSH Web GUI Panel (plugin/client.js)]
       │  host.call('irc-send'|'get-irc-messages'|...)
       ▼
[plugin/host.js] 8 RPC handlers
```

### Model Follow System

The bot does not use a fixed model by default. It scans the latest `"model":"..."` in DSH session storage (`~/.dsh/sessions/**/session.jsonl.zstd`) and follows whatever model DSH is currently using; falls back to `irc.json`'s `llm.model` on failure. The panel `/irc model` command can manually override.

### Context Window Fallback

If the model returns a context overflow error (`Request exceeds model context window`), the bot auto-retries once without tools; only context errors are permanently recorded in that model's no-tools list.

---

## Troubleshooting

- **Panel messages not sending**: Ensure outbox write uses `danger-full-access` (Cordis fs default
  workspace-write denies paths outside workspace). See `docs/irc-chat-tools-bridge.md` §14.4.
- **Bot not replying**: Check `status.json` for `connected`, `model`, `mcpFailed`.
- **Supervisor false positive**: `run.sh` uses `pgrep -f 'node irc-bot.js'` for precise matching, avoiding bash processes whose command line contains that string.
- **Model switch not taking effect**: `/irc model` writes back to `irc.json` and pkill the bot; supervisor auto-restarts with the new model.

More details in `docs/`.

---

# dsh-irc（中文说明）

> **⚠️ 中文单语言界面** — 本软件为**中文单语言界面**。所有 UI 标签、帮助文本和系统提示均为中文；英文仅用于本 README 文档。
>
> **⚠️ Chinese-only UI** — This software uses a **single Chinese-language interface only**. All UI labels, help text, and system prompts are in Chinese. English is used only in this README for documentation.

一个把 IRC 聊天接入 **DeepSeek Harness (DSH)** Web GUI 的完整方案，包含三部分：

1. **`irc-bot/`** — 独立的 Node.js IRC bot（真实 TCP 连接、LLM 回复、MCP 工具调用、supervisor 自动重启）
2. **`plugin/`** — DSH Cordis 插件（在 Web GUI 注入 IRC 浮动面板，与 bot 联动）
3. **`autoload/`** — **dsh-autoload** 框架：通用 DSH 动态插件自动加载器，DSH 启动时自动注册 IRC 面板（重启后免手动 run）。IRC 面板是本框架的第一个示例组件。

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
├── plugin/                   # DSH Cordis 插件（第一个 autoload 组件）
│   ├── host.js               # Host 端：8 个 RPC handler
│   ├── client.js             # Client 端：IRC 浮动面板 UI
│   └── plugin.json           # 插件元数据
├── autoload/                 # dsh-autoload 框架（通用、可复用）
│   ├── index.js              # 自动加载器插件（标准 Cordis host）
│   ├── package.json          # @dsh-mod/dsh-autoload
│   └── README.md             # 框架文档 + 如何添加组件
├── docs/                     # 设计与排障文档
│   ├── irc-chat-tools-bridge.md
│   ├── irc-cordis-plugin.md
│   ├── irc-real-bot.md
│   └── irc-scroll-to-bottom-fix.md
└── install.sh                # 一键安装脚本
```

---

## 前置要求

- **DeepSeek Harness (DSH)** Web profile 运行中（`dsh --profile web`）
- **Node.js** ≥ 18（用于 bot）
- 一个可连接的 **IRC 服务器**
- 一个 **OpenAI 兼容的 LLM 端点**（如本地 LiteLLM proxy）用于 bot 回复

---

## 安装指南

### 1. 安装 IRC bot

bot 是独立的 Node.js 程序，无需构建。

```bash
cd irc-bot
npm install   # 若声明了依赖则执行；否则跳过
```

### 2. 配置 bot

编辑 `irc-bot/irc.json` — 见下方 [配置指南](#配置指南)。

### 3. 启动 bot（supervisor 自动重启）

```bash
cd irc-bot
./run.sh &          # 后台 supervisor，bot 崩溃自动重启
```

或直接前台运行调试：`node irc-bot.js`

### 4. 安装 DSH 面板（自动加载）

面板是**动态 Cordis 插件**，由 `autoload/` 框架在 DSH 启动时自动注册。

1. 在 profile 的 `package.json` 里把框架加为本地依赖：

   ```json
   {
     "dependencies": {
       "@dsh-mod/dsh-autoload": "file:../../../src/dsh-irc/autoload"
     }
   }
   ```

2. 在 profile 目录运行 `npm install`。

3. 在 profile 的 `cordis.patch.yml` 里注册 IRC 组件：

   ```yaml
   - insert:
       - id: dsh-autoload
         name: '@dsh-mod/dsh-autoload'
         inject: ['dynamicCordisRunner']
         config:
           components:
             - id: irc
               name: 'IRC Chat Panel'
               purpose: '...'
               idPrefix: 'irct'
               hostFile: '/home/lucloner/src/dsh-irc/plugin/host.js'
               clientFile: '/home/lucloner/src/dsh-irc/plugin/client.js'
   ```

4. 重启 DSH：`systemctl --user restart dsh-web.service`

5. **刷新浏览器** — 侧边栏底部自动出现 **IRC** 按钮。

> `autoload/` 框架是通用、可复用的。如何添加更多组件见 [`autoload/README.md`](autoload/README.md)。

---

## 配置指南

### `irc-bot/irc.json`

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

| 字段 | 说明 |
|------|------|
| `server` | IRC 服务器地址、端口、是否 TLS |
| `nick` / `user` | bot 在 IRC 网络上的身份 |
| `channel` | 要加入的频道（如 `#xia`） |
| `llm.base` | OpenAI 兼容的 LLM 端点（本地 LiteLLM proxy） |
| `llm.keyFile` | 含 `LITELLM_API_KEY: sk-...` 的凭证文件 |
| `llm.model` | 回退模型（bot 优先跟随 DSH 会话最新使用的模型，见下） |
| `reply` | 回复策略：冷却、爆发上限、忽略的 bot nick |
| `logDir` | `conversation.ndjson` + `status.json` 的写入目录 |

### 面板路径常量（`plugin/host.js`）

Cordis 动态 Host 运行时**没有** `process`/`require`/`os`/`path`，无法读取环境变量，
因此插件路径为**硬编码**，发布/移植时请直接编辑 `plugin/host.js` 顶部的三个常量：

| 常量 | 默认 | 说明 |
|------|------|------|
| `LOG` | `/home/lucloner/.dsh/irc-bot` | 会话日志目录 |
| `BOT_DIR` | `/raid/source/src/shell/irc-bot` | bot 源码目录 |
| `LLM_CONFIG` | `/etc/litellm/config.yaml` | LiteLLM 模型配置 |

bot 侧 `run.sh` 支持 `IRC_BOT_LOG_DIR` 覆盖日志目录，`BOT_DIR` 自动取脚本所在目录。

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

## 排障

- **面板消息发不出去**：确认 outbox 写入用了 `danger-full-access`（Cordis fs 默认
  workspace-write 会拒绝写 workspace 外路径）。见 `docs/irc-chat-tools-bridge.md` §14.4。
- **bot 不回复**：检查 `status.json` 的 `connected`、`model`、`mcpFailed`。
- **supervisor 误判**：`run.sh` 用 `pgrep -f 'node irc-bot.js'` 精确匹配，避免匹配到
  命令行含该字符串的 bash 进程。
- **模型切换不生效**：`/irc model` 写回 `irc.json` 并 pkill bot，supervisor 自动用新模型重启。

更多细节见 `docs/`。
