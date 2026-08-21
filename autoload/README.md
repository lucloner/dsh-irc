# dsh-autoload — DSH Dynamic-Plugin Autoloader Framework

> **⚠️ Chinese-only UI** — This framework is part of the **dsh-irc** project, which uses a **single Chinese-language interface only**. All UI labels, help text, and system prompts are in Chinese. English is used only in this README for documentation.
>
> **⚠️ 中文单语言界面** — 本框架属于 **dsh-irc** 项目，该项目为**中文单语言界面**。所有 UI 标签、帮助文本和系统提示均为中文；英文仅用于本 README 文档。

A **standard Cordis Host plugin** that auto-registers a set of "components" as dynamic Cordis plugins at DSH startup, removing the need to manually `run` + approve in the browser after every restart.

> Part of the **dsh-irc** project. The **IRC chat panel** is the first component (example) using this framework.

---

## Why it exists

DSH's dynamic-plugin registry is **process-local**: after a DSH restart all dynamic plugin definitions are lost, the panel button disappears, and you must manually `run` + approve in the browser to restore it.

This framework calls the `dynamicCordisRunner` service at DSH startup (after agent creation) to re-`define` + `runHostHalf` every configured component, so the panel is **restored automatically**.

---

## How it works

```
DSH startup
  └─ cordis.patch.yml loads @dsh-mod/dsh-autoload (standard plugin)
       └─ listens for agent/created (root agent)
            └─ for each component:
                 dynamicCordisRunner.define({ sessionId, name, purpose, idPrefix, code })
                 dynamicCordisRunner.runHostHalf(agent, pluginId, packageId, 'run', null, true)
                      └─ requestId=null → pre-approves the client half (no manual approval)
```

Key points:

- **Only for root agents** — subagents are skipped, avoiding duplicate panels.
- **Per-session idempotent** — each session creates a component once; a newly opened root session gets its own panel.
- **No approval needed** — `runHostHalf` with `requestId=null` adds the client package to `approvedClientPackages`; the browser loads it after a refresh.

---

## Adding a new component

1. Prepare a pair of source files: `host.js` (Host side, registers `harness.handle` methods) + `client.js` (Client side, injects UI). See `../plugin/host.js` and `../plugin/client.js` for reference.
2. Add an entry to the `config.components` array in `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-autoload
      name: '@dsh-mod/dsh-autoload'
      inject: ['dynamicCordisRunner']
      config:
        components:
          - id: irc                      # unique component id
            name: 'IRC Chat Panel'       # plugin display name
            purpose: '...'               # plugin purpose
            idPrefix: 'irct'             # dynamic plugin id prefix (3-6 lowercase letters)
            hostFile: '/abs/path/host.js'   # Host source absolute path
            clientFile: '/abs/path/client.js' # Client source absolute path
```

3. Restart DSH (`systemctl --user restart dsh-web.service`) and refresh the browser.

---

## Component config fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique component id, used for idempotent dedup |
| `name` | yes | Dynamic plugin display name |
| `purpose` | yes | Dynamic plugin purpose description |
| `idPrefix` | yes | Dynamic plugin id prefix, 3–6 lowercase English letters |
| `hostFile` | no | Host source file absolute path (at least one of `hostFile`/`clientFile`) |
| `clientFile` | no | Client source file absolute path |

---

## Installation

The framework is referenced as a local npm package by the profile. Add the dependency in the profile's `package.json`:

```json
{
  "dependencies": {
    "@dsh-mod/dsh-autoload": "file:../../../src/dsh-irc/autoload"
  }
}
```

Then `npm install`, and register it in `cordis.patch.yml` (see above).

---

## Directory structure

```
dsh-irc/
├── autoload/            # This framework (generic, reusable)
│   ├── index.js         # Auto-loader plugin
│   ├── package.json     # @dsh-mod/dsh-autoload
│   └── README.md        # This file
├── plugin/              # First component: IRC chat panel
│   ├── host.js
│   ├── client.js
│   └── plugin.json
└── README.md
```

---

# dsh-autoload — DSH 动态插件自动加载框架（中文说明）

> **⚠️ 中文单语言界面** — 本框架属于 **dsh-irc** 项目，该项目为**中文单语言界面**。所有 UI 标签、帮助文本和系统提示均为中文；英文仅用于本 README 文档。
>
> **⚠️ Chinese-only UI** — This framework is part of the **dsh-irc** project, which uses a **single Chinese-language interface only**. All UI labels, help text, and system prompts are in Chinese. English is used only in this README for documentation.

一个**标准 Cordis Host 插件**，在 DSH 启动后自动把一组「组件」注册为动态 Cordis 插件，
免去每次重启后手动 `run` + 浏览器批准。

> 这是 **dsh-irc** 项目的一部分。**IRC 聊天面板**是使用本框架的第一个组件（示例）。

---

## 为什么需要它

DSH 的动态插件注册表是 **process-local**（进程本地）：DSH 重启后所有动态插件定义必然丢失，
面板按钮消失，需要手动重新 `run` + 浏览器批准才能恢复。

本框架在 DSH 启动时（agent 创建后）自动调用 `dynamicCordisRunner` 服务，把配置里的每个组件
重新 `define` + `runHostHalf`，从而**免手动恢复**。

---

## 工作原理

```
DSH 启动
  └─ cordis.patch.yml 加载 @dsh-mod/dsh-autoload（标准插件）
       └─ 监听 agent/created 事件（主会话 root agent）
            └─ 对每个组件：
                 dynamicCordisRunner.define({ sessionId, name, purpose, idPrefix, code })
                 dynamicCordisRunner.runHostHalf(agent, pluginId, packageId, 'run', null, true)
                      └─ requestId=null → 免审批预授权 client 端
```

关键点：

- **只为主会话（root agent）创建**，子代理（subagent）跳过，避免重复面板。
- **按 session 幂等**：同一会话只创建一次；新开的主会话各自拥有自己的面板。
- **免审批**：`runHostHalf` 传 `requestId=null` 会自动把 client package 加入
  `approvedClientPackages`，浏览器刷新后即可加载，无需手动批准。

---

## 如何添加一个新组件

1. 准备一对源码文件：`host.js`（Host 端，注册 `harness.handle` 方法）+ `client.js`
   （Client 端，注入 UI）。参考 `../plugin/host.js` 与 `../plugin/client.js`。
2. 在 `cordis.patch.yml` 的 `config.components` 数组里加一项：

```yaml
- insert:
    - id: dsh-autoload
      name: '@dsh-mod/dsh-autoload'
      inject: ['dynamicCordisRunner']
      config:
        components:
          - id: irc                      # 组件唯一 id
            name: 'IRC Chat Panel'       # 插件显示名
            purpose: '...'                # 插件用途描述
            idPrefix: 'irct'             # 动态插件 id 前缀（3-6 个小写字母）
            hostFile: '/abs/path/host.js'   # Host 源码绝对路径
            clientFile: '/abs/path/client.js' # Client 源码绝对路径
```

3. 重启 DSH（`systemctl --user restart dsh-web.service`），刷新浏览器页面。

---

## 组件配置字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 组件唯一标识，用于幂等去重 |
| `name` | 是 | 动态插件的显示名 |
| `purpose` | 是 | 动态插件用途描述 |
| `idPrefix` | 是 | 动态插件 id 前缀，3–6 个小写英文字母 |
| `hostFile` | 否 | Host 端源码文件绝对路径（与 `clientFile` 至少一个） |
| `clientFile` | 否 | Client 端源码文件绝对路径 |

---

## 安装

本框架作为本地 npm 包被 profile 引用。在 profile 的 `package.json` 里加依赖：

```json
{
  "dependencies": {
    "@dsh-mod/dsh-autoload": "file:../../../src/dsh-irc/autoload"
  }
}
```

然后 `npm install`，并在 `cordis.patch.yml` 里注册（见上文）。

---

## 目录结构

```
dsh-irc/
├── autoload/            # 本框架（通用、可复用）
│   ├── index.js         # 自动加载器插件
│   ├── package.json     # @dsh-mod/dsh-autoload
│   └── README.md        # 本文件
├── plugin/              # 第一个组件：IRC 聊天面板
│   ├── host.js
│   ├── client.js
│   └── plugin.json
└── README.md
```
