# Codex 是唯一权限事实源，iLink 只转发审批

## 状态

已接受，完全取代 [ADR 0013](./0013-wechat-selects-native-permission-profiles.md) 与 [ADR 0014](./0014-permission-modes-bind-profile-and-approval-policy.md)；其中“新任务不提交权限默认值”和“Desktop 只能本机审批”已由 [ADR 0016](./0016-new-task-permission-defaults-and-live-desktop-approval.md) 取代。

## 背景

Bridge 曾把 Profile、审批策略和审批人保存到 SQLite，并在 `thread/resume` 时回灌。这让 iLink 形成了第二套权限状态：Codex 升级或任务的实际设置变化后，本地快照可能过期，恢复失败又会把普通消息转成无法自动前进的队列。固定组合还会让 iLink 自己解释“完全访问”等 Profile，而不是服从当前 Codex 的原生语义。

审批请求的安全转发与权限策略不是同一件事。前者需要短码、通知重试和失效状态；后者应完全由 Codex 决定。

## 决策

1. Codex 持久化任务的当前权限设置是唯一事实源和策略引擎。
2. 新任务只传必要的 `cwd` 与 iLink 运行指令，权限采用 Codex 当时的默认值。
3. 既有任务恢复不得传 `permissions`、`approvalPolicy`、`approvalsReviewer` 或 Sandbox 覆盖值。
4. `perm` 对当前绑定任务执行无权限覆盖的实时查询，只把 Codex 当前审批人精简显示为“权限”；Profile、审批策略和 Sandbox 不在微信重复展示。权限只能在 Codex Desktop 中修改；iLink 不列出编号式可选 Profile，也不提交任何权限更新。
5. SQLite 不保存权限选择、审批策略、审批人或 Sandbox。schema v14 删除旧 `thread_permission_profiles`，旧行不再生效。
6. iLink 只保存实时审批请求到短码的临时内存映射，以及通知的投递、提醒和失效 Outbox；不持久化可重放的批准决定。
7. Bridge 或 App Server 重启会使旧审批回调和短码失效，不把旧决定用于新请求。
8. 当前权限元数据读取失败只使 `perm` 明确失败，不阻塞普通消息。任务恢复在 Codex 自身安全重试后仍失败时，该输入明确标记为未执行；已排队输入以“队列终结 + 失败 Outbox”同一事务退出，不能无限静默排队。

## 结果

- Codex 升级后的 Profile、审批策略和 Sandbox 语义自然随 Codex 改变，iLink 无需复制映射。
- Desktop、微信和 Bridge 重启后看到的是同一任务的实际权限，不存在 SQLite 快照覆盖。
- 微信入口不能切换或提升任务权限；权限编辑面只有 Codex Desktop。
- `ok/no` 仍可安全回应 Bridge 当前在线的单次 Codex 审批，但 iLink 没有独立权限策略。
- 恢复错误会明确区分“未执行”和“已排队”，避免用户误以为任务仍在运行。
