# 新任务使用 iLink 默认权限，Desktop 人工审批保持在线回调

## 状态

已接受；其中“iLink 保存并配置新任务默认权限”的决策已被 [ADR 0017](./0017-new-tasks-follow-desktop-permissions.md) 取代，Desktop 在线审批部分仍有效。本文保留为历史决策。

## 背景

微信主会话使用非 Git Inbox 时，Codex 默认可能创建为只读，导致用户每次都要在 Desktop 修改。另一方面，旧 `PermissionRequest` Hook 只发“回电脑批准”通知：即使任务审批者是 `auto_review` 也可能误报，微信收到通知后又无法真正批准。

新任务默认值与已有任务权限快照不是同一件事。前者是一次 `thread/start` 输入；创建完成后，Codex 持久化结果仍是当前任务唯一事实源。Desktop Hook 也只有在在线连接仍存在时才有安全的 stdout 决策回调。

## 决策

1. `bridge_settings` 保存 iLink 全局的新任务默认值，初始为 `:workspace + on-request + auto_review`。
2. `ilink config set default-permission|default-approval|default-reviewer` 修改默认值，`config reset` 恢复安全默认组合与超时默认值。
3. 微信主会话首次创建、`new` 和 `clear` 调用 `thread/start` 时提交当时的默认值；`thread/resume` 永不提交权限覆盖，因此已有任务不受配置变化影响。
4. `PermissionRequest` Hook 通过命名管道等待 Bridge。Bridge 无覆盖恢复任务并读取实际 `approvalPolicy` 与 `approvalsReviewer`。
5. `auto_review`、`approvalPolicy=never`、元数据不完整、Pipe 离线或无微信回复上下文时，不发微信，Hook stdout 为空，由 Codex/Desktop 原生流程继续。
6. 只有 `approvalsReviewer=user` 的在线请求进入与 App Server 共用的临时短码队列；微信 `y/n` 返回 `hookSpecificOutput.decision.behavior=allow|deny`。
7. PermissionRequest 不写 Spool。30 分钟超时或 Bridge 正常关闭时拒绝；Hook 断开或 Bridge 崩溃时 stdout 为空并回退原生流程。旧决定不持久化、不重放。
8. 审批按 `method + threadId + turnId + itemId` 去重；不同 item 即使文案相同也保留独立短码，摘要同时展示原因和具体命令。
9. `ya`、`na` 只展示并快照在线短码，两分钟内使用该快照的唯一确认码才逐个回应；切换操作或其他消息取消确认，快照之后新增的审批不继承本次批量决定。

## 结果

- 新装默认不再因 Inbox 目录而反复落到只读，同时仍保留 workspace Sandbox 和 Codex `auto_review` 风险判断。
- `auto_review` 不产生误导性微信通知；发送到微信的 Desktop 审批可以真正批准或拒绝。
- 全局配置不覆盖已有任务，Codex 仍是任务实际权限的唯一事实源。
- Bridge 不可用时审批回退 Desktop，不会形成无回调的持久待审批记录。
