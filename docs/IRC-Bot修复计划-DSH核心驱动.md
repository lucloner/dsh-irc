# IRC Bot 修复计划 — 从"独立回复"到 DSH 核心驱动

> **状态**：✅ 已完成并验证（2026-08-31）
> **创建日期**：2026-08-31
> **关联文件**：`host.js`（插件轮询）、`irc-bot.js`（传输层）、`inbox.ndjson` / `outbox.ndjson`
> **核心目标**：让 IRC bot 不再自行回复消息，所有流量经 DSH agent (`irc-xia`) 处理，享受内核级 rate‑limiting、上下文压缩、MCP 工具调用等能力。
> **关联文档**：`修复重复回复-行动计划.md`（§4 故障记录）

---

## 1. 问题描述（计划时假设 vs 实际排查结论）

### 1.1 计划时的假设（后被证伪）

| 症状 | 假设原因 |
|------|----------|
| IRC 频道中出现大量"bot 自回复" | 怀疑 `irc-bot.js` 收到消息后立即写 inbox + 直接 PRIVMSG 回复 |
| DSH session (`irc-xia`) 视图为空 | 怀疑 bot 未把消息交给 DSH |

### 1.2 实际排查结论（2026-08-31）

| 检查项 | 实际结果 | 结论 |
|--------|----------|------|
| `irc-bot.js` 代码审查 | `onMessage()` 只 `fs.appendFileSync(inboxFile, ...)`；`drainOutbox()` 只读 outbox 发 PRIVMSG | ✅ **bot 已是纯传输层，无自回复逻辑**，无需修改 |
| 频道里的"回复"来源 | inbox 中回复来自 `nanoclaw`（频道里另一个第三方 bot），非本 bot `deepseek_ai` | 频道活跃 ≠ 本 bot 在回复 |
| DSH 插件 | 日志 `interval skipped due to lock` 反复出现 | ❌ **真正根因：锁过期但插件加载时已决定跳过轮询** |

**修正后的根因**：DSH 进程重启 → autoload 重载插件 → `apply()` 检查锁文件发现"仍有效"（旧实例退出前刷新过）→ 跳过 interval → inbox 无人消费 → `agent.followup()` 永不触发 → 无 `assistant/message` → DSH 会话视图为空 + IRC 无回复。

---

## 2. 架构（目标即现状）

```
用户 → IRC → irc-bot.js ──→ inbox.ndjson (仅写入，不回复)
                               ↓
                          pollInbox() ──→ agent.followup(text)
                                          ↓
                              DSH agent (irc-xia) 处理
                              ├── rate-limiting (per-sender, cooldown, waitingBuffers)
                              ├── context compaction（自动压缩）
                              ├── MCP tools
                              └── system prompt / persona / guard hooks
                                          ↓
                              assistant/message 事件
                                          ↓
                           processNewReplies() → outbox.ndjson
                               ↓
                    irc-bot.js drainOutbox() ──→ PRIVMSG (#xia)
```

**关键原则**：irc-bot.js 只做两件事 — 1) 把 IRC 消息写进 inbox；2) 读取 outbox 并发送 PRIVMSG。**不自行回复**。

---

## 3. 执行记录（实际完成）

| 步骤 | 计划内容 | 实际结果 |
|------|----------|----------|
| 1. 审查 `irc-bot.js` | 移除直接 PRIVMSG 回复逻辑 | ✅ 审查确认**无此逻辑**，bot 已是纯转发（`onMessage` 只写 inbox），无需修改 |
| 2. 确认 `drainOutbox()` | 每 500ms 轮询 outbox 并发送 | ✅ 已存在（`setInterval(drainOutbox, 500)`，含原子 rename 防竞态） |
| 3. 清除过期锁 | `rm /home/lucloner/.dsh/irc-bot/plugin.lock` | ✅ 已执行 |
| 4. 重启 DSH | 用户执行重启 | ✅ 新 PID 31015（15:49 启动） |
| 5. 验证流程 | 插件日志确认锁获取 + 轮询 + 回复 | ✅ 见 §4 |

---

## 4. 恢复验证（2026-08-31 15:52–15:57，插件日志）

```
07:52:14Z resume failed: cannot prepare session "irc-xia" while it is live
07:52:15Z lock acquired at 2026-08-31T07:52:15.266Z          ← 新实例拿到锁
07:52:16Z processNewReplies: writing 1 texts to outbox        ← 回复开始产出
07:52:16Z rate-limit: sender=nanoclaw accumulated=31 required_was=1 next_required=32
07:54:24Z rate-limit: sender=nanoclaw accumulated=4 required_was=1 next_required=5
07:54:27Z rate-limit: sender=nanoclaw accumulated=15 required_was=5 next_required=20
07:57:18Z cooldown reset: sender=nanoclaw was 32 -> 1          ← 5分钟冷却正常触发
```

| 验证项 | 结果 |
|--------|------|
| 锁被新实例获取 | ✅ `lock acquired` |
| 积压 inbox 被消费（36 行清空） | ✅ `wc -l` = 0 |
| rate-limiting 累积逻辑 | ✅ accumulated 31 → next_required 32 |
| 冷却重置（不释放 waitingBuffers） | ✅ `was 32 -> 1` |
| 回复写入 outbox → IRC | ✅ `processNewReplies: writing N texts` |

---

## 5. Rate-limiting 行为确认（冷却 + waitingBuffers）

| 场景 | required | accumulated | waitingBuffers | 是否发送 | next_required |
|------|----------|-------------|----------------|---------|---------------|
| A 发 1 条 | 1 | 1≥1 → ✅ | — | 是 | 2 |
| A 发 3 条 | 2 | 4≥2 → ✅ | — | 是（含旧暂存） | 6 |
| A 发 4 条 | 5 | 4<5 → ❌ | 'msg1\nmsg2...' | 否 | — |
| **冷却后**A 再发 1 条 | **1**(重置) | **1≥1 → ✅** | **合并发送 (旧 4+新 1)** | 是 | 2 |

> 冷却只重置 `required=1`，**不释放** `waitingBuffers` 和 `accumulated`；等该 sender 再发新消息时合并发送。

---

## 6. 相关文件索引

| 文件 | 用途 |
|------|------|
| `/raid/source/src/dsh-irc/plugin/host.js` | DSH 插件 Host 端（轮询 inbox、rate-limiting、agent.followup、processNewReplies） |
| `/raid/source/src/shell/irc-bot/irc-bot.js` | IRC 传输层（连接、PING、433 nick 处理、drainOutbox 原子 rename） |
| `/raid/source/src/shell/irc-bot/inbox.ndjson` | DSH 插件读取的入站消息队列 |
| `/raid/source/src/shell/irc-bot/outbox.ndjson` | DSH agent 回复写入，bot 读取后发送 PRIVMSG |
| `/home/lucloner/.dsh/irc-bot/plugin.lock` | 文件锁（3600s 超时 + pollInbox 刷新） |
| `/home/lucloner/.dsh/irc-bot/plugin-errors.log` | 插件错误日志（含 rate-limit、cooldown、interval skipped 等） |

---

## 7. TL;DR — 结论

1. **irc-bot.js 无需修改**：它已经是纯传输层（写 inbox / 读 outbox），"自回复"是误判——频道里的回复来自第三方 bot `nanoclaw`。
2. **真正故障是插件锁**：DSH 重启后插件因过期锁跳过 interval，导致 inbox 积压、DSH 不出声。
3. **修复 = 清锁 + 重启 DSH**：已执行并验证，rate-limiting / cooldown / waitingBuffers 全部按设计工作。
4. **遗留观察点**：见 `修复重复回复-行动计划.md` §6.2（resume 冲突、锁一次性检查、第三方 bot 消息过滤）。