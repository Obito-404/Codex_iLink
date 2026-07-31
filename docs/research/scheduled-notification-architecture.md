# 已安排任务完成后向外部渠道推送：架构研究

## 研究范围

本文研究“调度任务完成后，如何可靠地向微信等外部渠道推送”，只引用规范或厂商官方文档，并把结论映射到 Codex_iLink 的 Cron、同会话 heartbeat、Codex Hook、SQLite 与 iLink 链路。

核对日期：2026-07-23。主要一手来源：

- CNCF CloudEvents `v1.0.2` 规范；
- AWS EventBridge Scheduler API Reference 与 User Guide；
- AWS Prescriptive Guidance 的 Transactional Outbox；
- Amazon SQS 的至少一次交付说明；
- OpenAI 官方 Scheduled tasks、Hooks 与 Codex App Server 文档。

## 结论先行

1. **调度完成事实与微信发送不是一个动作。** 主流架构先产生带稳定身份和明确类型的终态事件，再由独立投递器发送到外部渠道。事件本身不绑定微信；微信只是一个消费者。
2. **可靠性基线是至少一次，而不是假设恰好一次。** 重试可能造成重复，因此生产者要重放同一个事件 ID，消费者要按该 ID 幂等。
3. **重试必须有边界。** 同时限制最大尝试次数和最大事件年龄；永久失败或耗尽边界后进入 DLQ，不能静默丢弃，也不能无限热循环。
4. **数据库状态变化与待发送消息要原子交接。** 能共享事务时使用 Transactional Outbox；Codex 与 Bridge 无法跨进程共享事务时，则采用“持久 Inbox → 幂等对账 → Outbox”的单调责任转移。
5. **Cron、heartbeat 和普通 Desktop 回合必须是不同事件类型。** 不能仅凭自然语言或线程级来源猜测。heartbeat 的 `NOTIFY` 与 `DONT_NOTIFY` 也必须成为结构化决策。
6. **Hook 是捕获边界，不是网络发送器。** Hook 应快速写入本地持久状态；微信网络、退避、鉴权恢复和 DLQ 由常驻 Bridge 负责。

## 1. 一手资料核对

### 1.1 CNCF CloudEvents：类型化事件与稳定事件 ID

CloudEvents 规定每个事件必须带有必需的上下文属性，并强调这些属性可以在不反序列化事件数据的情况下被中间件检查：

> “Every CloudEvent conforming to this specification MUST include context attributes designated as REQUIRED.”
>
> “This allows for them to be inspected at the destination without having to deserialize the event data.”

来源：[CloudEvents v1.0.2 Context Attributes L155-L163](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md#L155-L163)。

四个必需属性是 `id`、`source`、`specversion`、`type`。其中：

- `id` 的规范原文要求生产者保证 `source + id` 对每个不同事件唯一；网络失败后重发同一个事件可以沿用同一个 `id`，消费者可以把相同 `source + id` 视为重复事件。见 [CloudEvents v1.0.2 `id` L246-L257](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md#L246-L257)。
- `type` 用来描述事件类型，规范明确列出 routing、observability、policy enforcement 等用途；类型格式由生产者定义，建议使用反向 DNS 前缀。见 [CloudEvents v1.0.2 `type` L318-L328](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md#L318-L328)。
- CloudEvents 把事件定义为 occurrence 与 context 的记录，事件可按自身上下文路由，但不直接指定某个路由目的地。见 [CloudEvents v1.0.2 Event L74-L81](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md#L74-L81)。

对本项目的含义：

- `automation_id` 是“计划定义”的身份，不是一次运行事件的身份；同一个计划的多次运行必须有不同事件 ID。
- `thread_id + turn_id + terminal-kind` 可以构成一次终态 occurrence 的稳定身份；同一个 Stop、Spool 重放或进程恢复必须复用该身份。
- `type` 应直接表达 `cron`、`heartbeat.notify`、`heartbeat.quiet`、`desktop` 及终态，而不是等发送时再从正文或 Presence 猜测。
- 微信目标用户、`context_token` 等传输信息属于 Outbox，不应污染领域事件类型。

### 1.2 AWS EventBridge Scheduler：至少一次、延迟重试、最大年龄与 DLQ

EventBridge Scheduler 官方说明：

> “EventBridge Scheduler provides at-least-once event delivery to targets.”
>
> “EventBridge Scheduler retries failed tasks with delayed attempts.”

来源：[What is Amazon EventBridge Scheduler? — Retries](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html)。

`RetryPolicy` API 进一步定义了两个独立边界：

- `MaximumEventAgeInSeconds`：继续重试的最长时间，允许范围为 60–86400 秒；
- `MaximumRetryAttempts`：失败前的最大重试次数，允许范围为 0–185；
- 使用指数退避，直到达到最大尝试次数或最大事件年龄，任一条件先到即停止。

来源：[EventBridge Scheduler `RetryPolicy`](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html)、[`MaximumEventAgeInSeconds`](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html#scheduler-Type-RetryPolicy-MaximumEventAgeInSeconds)、[`MaximumRetryAttempts`](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html#scheduler-Type-RetryPolicy-MaximumRetryAttempts)。

DLQ 官方行为是：

- Scheduler 无法调用目标时，把包含调用细节和目标响应的 JSON 投递到指定的 Amazon SQS standard queue；
- 如果配置了重试策略，则在耗尽最大重试次数后投递 dead-letter event；
- Scheduler 的 DLQ 不支持 FIFO queue。

来源：[Configuring a schedule's dead-letter queue](https://docs.aws.amazon.com/scheduler/latest/UserGuide/configuring-schedule-dlq.html)、[EventBridge Scheduler `DeadLetterConfig`](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_DeadLetterConfig.html)。

这些数值是 AWS 服务约束，不应机械复制到本地 Bridge。可迁移的设计原则是：**次数上限、事件年龄、退避计划和 DLQ 必须同时存在且可观察**。

### 1.3 Transactional Outbox：解决双写，确认后再删除

AWS Prescriptive Guidance 对 Transactional Outbox 的定义是：

> “The transactional outbox pattern resolves the dual write operations issue ... when a single operation involves both a database write operation and a message or event notification.”

其关系数据库实现要求业务表与 outbox 表在同一事务更新，另一个服务读取 outbox、投递消息；官方示例只在下游成功响应后删除 outbox 记录。来源：

- [Transactional outbox — Intent and Motivation](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html#transactional-outbox-intent)
- [Using an outbox table with a relational database](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html#using-an-outbox-table-with-a-relational-database.cf77aee8-083c-53c3-87c4-f2ac9c018844)
- [Transactional outbox sample code](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html#using-an-outbox-table.0948c3c2-e393-5c8d-932e-6f72eb809fa5)

官方同时明确提醒：

> “The events processing service might send out duplicate messages or events, so we recommend that you make the consuming service idempotent by tracking the processed messages.”

来源：[Transactional outbox — Issues and considerations](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html#transactional-outbox-issues)。

对本项目的含义：

- Codex 自身终态与 Bridge SQLite 不在同一数据库，无法做真正的跨进程原子事务；
- 因此必须先把精确 Stop/终态证据持久化为 Inbox Job，再对账并写入 Outbox；
- 在 Outbox 已经承担恢复责任前不能删除 Inbox Job；
- 如果崩溃发生在“Outbox 已写、Inbox 未删”之间，稳定事件 ID 和 Outbox 主键应让重放成为无副作用操作。

### 1.4 幂等消费者：重复是正常输入

Amazon SQS 官方说明，标准队列为高可用保存消息副本；极少数情况下删除时某份副本不可用，之后可能再次收到相同消息。因此：

> “Design your applications to be idempotent (they should not be affected adversely when processing the same message more than once).”

来源：[Amazon SQS at-least-once delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html)。

对本项目的含义：

- Hook Pipe、Spool、启动恢复和轮询对账都可能重复交付同一终态；
- `source + event_id` 必须有唯一约束；
- 同一逻辑微信消息的 `client_id` 必须跨进程重启和网络重试保持不变；
- “发送请求返回前连接断开”是结果未知，不应生成新 ID 重发；
- iLink 对相同 `client_id` 的服务端去重尚未被一手协议保证，因此 Bridge 自身仍要抑制重复；极端的“服务端已接收、客户端未收到确认”窗口必须作为已知限制保留。

### 1.5 OpenAI Scheduled tasks、Hooks 与 App Server：两种调度语义、一个生命周期边界

OpenAI 官方 Scheduled tasks 文档区分：

- standalone scheduled task：每次运行创建新 chat，结果进入 Scheduled；
- scheduled task inside a chat：返回现有 chat，复用该 chat 的上下文；
- Scheduled 视图本身是 inbox，带 findings 的运行在其中出现。

来源：[Scheduled tasks](https://learn.chatgpt.com/docs/automations)、[Manage scheduled tasks](https://learn.chatgpt.com/docs/automations#manage-scheduled-tasks)、[Schedule a task inside a chat](https://learn.chatgpt.com/docs/automations#schedule-a-task-inside-a-chat)。

这与本项目的两类来源直接对应：

- **Cron**：独立调度运行，通常产生独立 chat/turn；
- **heartbeat**：唤醒同一个 chat，线程仍可能保留普通用户来源，不能仅靠线程级 `threadSource` 识别。

OpenAI Hooks 官方文档还明确：

- `UserPromptSubmit` 和 `Stop` 都是 turn-scoped Hook；
- `UserPromptSubmit` 输入包含 `turn_id` 与 `prompt`；
- `Stop` 输入包含 `turn_id` 与 `last_assistant_message`；
- `transcript_path` 指向的 transcript 不是稳定接口，格式可能变化。

来源：[Hooks runtime behavior](https://learn.chatgpt.com/docs/hooks)、[Common input fields](https://learn.chatgpt.com/docs/hooks#common-input-fields)、[`UserPromptSubmit`](https://learn.chatgpt.com/docs/hooks#userpromptsubmit)、[`Stop`](https://learn.chatgpt.com/docs/hooks#stop)。

Codex App Server 是 OpenAI 官方公开的客户端集成协议，公开了 thread/turn 生命周期及 `thread/read` 等读取能力。来源：[Codex App Server protocol](https://developers.openai.com/codex/app-server/)。

因此，heartbeat 的优先识别路径应是：

1. `UserPromptSubmit` 对严格、完整的 `<heartbeat>` envelope 派生类型化元数据；
2. 只持久化 `turn_id`、事件类型、受限的 `automation_id` 或其摘要，不保存整段敏感 prompt；
3. `Stop` 用同一 `turn_id` 关联，并从 `last_assistant_message` 中解析同 ID 的 `NOTIFY` / `DONT_NOTIFY`；
4. 若实机证明系统 heartbeat 不触发 `UserPromptSubmit`，才通过 App Server 的 `thread/read` 回退读取明确 `thread_id + turn_id` 的目标 turn；不得扫描最近线程、猜测正文归属或依赖不稳定 transcript。

上述 Hook 字段是官方支持面，但 heartbeat 是否实际触发该 Hook 仍需版本级实机验证。

对本项目的边界映射是：Scheduled tasks 定义 Cron 与同会话 heartbeat 的运行语义；Hooks 在逐回合入口/出口捕获 `turn_id` 和最终消息；App Server 只负责按稳定 ID 补读目标 turn。三者都不承担微信投递，外部网络重试仍由 Bridge Outbox Worker 负责。

本轮最小兼容实现不扩展 Hook 持久化格式，而是复用 Stop 已保存的精确 `thread_id + turn_id`，通过公开 `thread/read(includeTurns=true)` 只读取目标 turn。它对输入与输出 envelope 做失败关闭校验，并且只把结果用于通知分类；不扫描其他线程，也不把正文解析结果用于授权。

## 2. 推荐参考架构

```text
Codex Scheduler
  ├─ standalone Cron run
  └─ in-chat heartbeat
          │
          ▼
UserPromptSubmit Hook（捕获逐回合来源；不得发送微信）
          │
          ▼
Codex turn
          │
          ▼
Stop Hook（thread_id + turn_id + 最终消息）
          │
          ▼
Terminal Event Inbox / Reconciliation Job
  - UNIQUE(source, event_id)
  - 类型、终态、捕获时间、绑定安全边界
  - durable retry metadata
          │
          ▼
Reconciler（App Server 精确读取 target turn）
          │
          ├─ heartbeat DONT_NOTIFY → quiet terminal record
          │
          └─ should notify
                    │
                    ▼
             Notification Outbox
             - stable delivery/client_id
             - frozen destination
             - payload hash/body
                    │
                    ▼
             iLink Delivery Worker
             - exponential backoff
             - max attempts + max age
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
      confirmed             exhausted/permanent
          │                   │
          ▼                   ▼
  confirmed + reply route   Notification DLQ
  （同一 SQLite 事务）       （可检查、可重放）
```

关键边界：

- Hook 返回与微信网络完全解耦；Pipe 失败可落 Spool，但同一事件身份不变。
- Inbox 负责“这个 Codex 终态不能丢”；Outbox 负责“这个微信发送不能丢”。
- Inbox 到 Outbox 是单调责任转移：先写 Outbox，后删除/完成 Inbox。
- DLQ 保存最小诊断元数据和 payload hash；不得长期复制凭证、`context_token` 或不必要的完整对话。
- `confirmed` 表示 iLink 接口已接受，不表示微信用户已读。

## 3. 建议的类型化终态事件

不要求引入 CloudEvents SDK 或外部消息代理；SQLite 内部记录采用同一语义子集即可。

示例：

```json
{
  "specversion": "1.0",
  "id": "thread/019f.../turn/019f.../terminal/v1",
  "source": "urn:codex-ilink:installation:LOCAL_INSTALLATION_ID",
  "type": "io.github.obito404.codex.scheduled.heartbeat.notify.v1",
  "subject": "thread/019f.../turn/019f...",
  "time": "2026-07-23T07:04:15.454Z",
  "data": {
    "threadId": "019f...",
    "turnId": "019f...",
    "status": "completed",
    "automationIdDigest": "sha256:...",
    "replyable": true
  }
}
```

`type` 名称由本项目定义，可采用下表语义：

| 事件类型 | 微信策略 | Presence |
| --- | --- | --- |
| `...scheduled.cron.completed.v1` | 推送完成结果 | 不抑制 |
| `...scheduled.cron.failed.v1` | 推送失败 | 不抑制 |
| `...scheduled.cron.interrupted.v1` | 推送中断，不开放回复路由 | 不抑制 |
| `...scheduled.heartbeat.notify.v1` | 只推送结构化 `<message>` | 不抑制 |
| `...scheduled.heartbeat.quiet.v1` | 记录终态，不写微信 Outbox | 不适用 |
| `...scheduled.heartbeat.failed.v1` | 推送失败 | 不抑制 |
| `...desktop.turn.completed.v1` | 普通 Desktop 离开通知 | 保留现有 Presence 门禁 |

事件身份与投递身份要分开：

- `event_id`：一次 Codex occurrence 的身份；所有消费者共享；
- `delivery_id/client_id`：某事件发往某渠道、某目标的一次逻辑投递身份；
- `attempt_id`：仅用于诊断某次网络尝试，不能拿来做消息去重。

多段微信消息应从同一个 `delivery_id` 确定性派生 `part:1..N`；重试时不得重新编号。

## 4. Cron、heartbeat 与 Hook 的具体映射

### 4.1 Cron

Cron 是独立 scheduled run。当前 Codex 版本实测可见线程级 `threadSource=automation`，但该字面值不是 CloudEvents 身份，也不是跨版本授权契约。

推荐：

- 优先使用上游明确的 scheduled-run/run-id 元数据；
- 当前缺少更强逐回合元数据时，可把 `source=vscode + threadSource=automation` 作为版本门控的兼容适配器；
- 最终生成本项目自己的 `scheduled.cron.*` 类型，后续投递不再依赖原始字符串；
- 每个 run/turn 生成不同事件 ID，同一 run 的 Stop 重放复用同一 ID。

### 4.2 Heartbeat

Heartbeat 回到现有 chat，因此线程仍可显示 `threadSource=user`。线程级分类会把它误当普通 Desktop 回合，并在用户在场时抑制。

最小安全规则：

- 兼容回退只对实测的 `source=vscode + threadSource=user` 生效，CLI、未知来源和其他线程类型不得升级为已安排任务；
- 输入必须是精确 target turn 的唯一 `userMessage`、唯一 text block、完整严格匹配 `<heartbeat>` envelope；
- `automation_id` 必须唯一、非空、有界；持久化时优先保存摘要；
- completed 时，最终回答末尾必须有唯一同 ID heartbeat envelope；
- `NOTIFY` 才创建 Outbox，并只提取 `<message>`；`DONT_NOTIFY` 的 `<message>` 仅作结构校验并被忽略，只记录 quiet 终态；
- 畸形、重复标签、ID 不一致、多 user message、未知 decision 一律失败关闭；
- failed/interrupted 没有最终 decision 时，可凭已持久化的严格 heartbeat 起始证据生成失败事件；
- 该正文 fallback 只能用于通知分类，不能用于审批、授权或权限提升。

### 4.3 Hook

Hook 只执行：

- 规范化并校验 `thread_id`、`turn_id`；
- 派生类型化、最小化事件元数据；
- 通过 Named Pipe 或有界 Spool 把事件交给 Bridge；
- 在本地事务中竞争必要的 turn lease。

Hook 不执行：

- 直接调用 iLink；
- 网络退避；
- 长时间读取 App Server；
- 按自然语言关键词推断“定时任务”；
- 解析不稳定 transcript 作为通知分类或通用事实源；唯一例外是 ADR-0011 的租约兼容恢复：只对当前会话本地 rollout 的有界完整 JSONL 尾部读取精确匹配旧 `turn_id` 的结构化 `turn_aborted`，任何路径、格式或读取异常都继续失败关闭。

## 5. 与当前 Codex_iLink 实现的差距

| 当前组件 | 已符合主流设计的部分 | 仍需补齐 |
| --- | --- | --- |
| `terminal_notification_jobs` | Stop 先持久化；`thread_id + turn_id` 唯一；带过期时间 | 增加类型化 `event_id/type`、持久 attempt count、`next_attempt_at`、`last_error_code`、终止原因与 DLQ |
| `DesktopNotifier` | 生成稳定的 `automation/desktop + thread + turn` client ID；Outbox 批量写入事务；heartbeat 已严格识别 `NOTIFY/DONT_NOTIFY`，且只投递 `<message>` | 将内部 `automation` 进一步拆成 `cron` 与 `heartbeat` 类型，并为 quiet 终态保留可观察记录 |
| `outbox` | `client_id` 主键；pending/confirmed；确认后清正文；确认与 reply route 同事务 | 增加持久重试年龄、次数、下次尝试时间、错误分类和 dead-letter 状态 |
| `OutboxWorker` | 同一 `client_id` 重放；单轮最多 3 次；指数退避 | 当前失败集合是进程内状态；需要跨重启的退避计划、最大年龄、永久错误分类与 DLQ |
| `notification_routes` | 只在投递确认后创建回复路由 | 绑定目标必须冻结；旧控制者期间开始的事件不得在换绑后重定向给新控制者 |
| Hook Pipe/Spool | 网络与 Hook 解耦；有界 Spool；当前可用 Stop + App Server 精确 target-turn 回退分类 | 若后续版本能稳定验证 heartbeat 的逐回合 Hook，再持久化最小类型元数据，仍避免保存完整敏感 prompt |

当前相关实现：

- [`terminal_notification_jobs` migration](../../src/bridge/migrations/016-terminal-notification-jobs.sql)
- [`OutboxWorker`](../../src/bridge/outbox-worker.ts)
- [`SqliteState` Outbox 事务](../../src/bridge/sqlite-state.ts)
- [`desktop-notification-identity`](../../src/bridge/desktop-notification-identity.ts)
- [`BridgeDaemon` 终态对账](../../src/daemon/bridge-daemon.ts)

## 6. 重试与 DLQ 状态建议

两个重试域必须分开：

| 重试域 | 临时失败示例 | 成功条件 | 耗尽后的 DLQ stage |
| --- | --- | --- | --- |
| 终态对账 | App Server 未加载、瞬时 interrupted、读取超时 | 精确 target turn 得到可信终态和类型 | `terminal-reconcile` |
| 外部投递 | 网络超时、429、5xx、iLink 暂时不可用 | iLink 明确接受相同 `client_id` | `ilink-delivery` |

建议持久字段：

```text
event_id
stage
attempt_count
first_attempt_at_ms
last_attempt_at_ms
next_attempt_at_ms
expires_at_ms
last_error_code
last_error_at_ms
dead_lettered_at_ms
payload_sha256
```

错误分类：

- 网络超时、429、5xx：按退避重试；
- 认证过期：暂停该账号投递并保留 Outbox，等待重新登录，不做热循环；
- payload 永久非法、目标不存在等确定性 4xx：直接 DLQ；
- 结果未知：用同一个 `client_id` 重试；
- 达到最大次数或最大年龄：原子迁移到 DLQ。

DLQ 至少支持：

- 列表和按 stage/type 查询；
- 展示脱敏错误、首次/末次时间、尝试次数和 payload hash；
- 修复外部状态后以原 `event_id` / `delivery_id` 人工重放；
- 有界保留和明确清理策略。

## 7. 幂等与崩溃边界验收

必须覆盖：

1. 同一 Stop 经 Pipe 与 Spool 重复到达，只生成一个 terminal event。
2. Outbox 已写、Inbox Job 未删时崩溃；恢复后不生成第二个 Outbox。
3. iLink 已接受、Bridge 在写 confirmed 前崩溃；恢复后复用相同 `client_id`。
4. 多段消息在任一段失败；后续段不得越过，已确认段不得换 ID 重发。
5. `DONT_NOTIFY` 重放始终不生成 Outbox。
6. 换绑前开始的任务在换绑后结束，不得投递给新控制者。
7. App Server 长时间不可读，达到事件年龄后进入 `terminal-reconcile` DLQ。
8. iLink 长时间 5xx/429，达到投递边界后进入 `ilink-delivery` DLQ。
9. 进程重启后仍遵守原有 `next_attempt_at`，不形成启动重试风暴。
10. 普通 Desktop 正文包含 `<heartbeat>` 字样但不满足严格 envelope，不得绕过 Presence。

## 8. 最终设计判断

本项目不需要引入 AWS 或外部消息代理；本地单用户场景用 SQLite 足够。应借鉴的是它们的可靠性语义：

- CloudEvents：稳定事件身份、显式事件类型、事件与目的地解耦；
- EventBridge Scheduler：至少一次、延迟退避、最大次数、最大年龄、DLQ；
- Transactional Outbox：状态与待发消息原子交接，确认后再清理；
- Idempotent Consumer：重复是正常输入，所有处理必须可重放；
- OpenAI Scheduled tasks / Hooks / App Server：Cron 与同会话 heartbeat 是不同运行语义，Hook 提供逐回合捕获边界，App Server 仅按稳定 ID 补读精确目标 turn。

落到 Codex_iLink，就是：

> **Hook 捕获类型化终态 → SQLite Inbox 对账 → SQLite Outbox 原子接棒 → iLink 使用稳定 client ID 有界重试 → confirmed 后建立回复路由 → 耗尽进入可检查 DLQ。**

这条链路既能覆盖独立 Cron，也能覆盖线程仍标记为 `user` 的 heartbeat，同时不会让普通 Desktop 回合在用户在场时产生重复微信通知。
