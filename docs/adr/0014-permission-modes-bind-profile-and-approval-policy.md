# 权限模式绑定 Profile、审批策略和审批人

## 状态

已被 [ADR 0015](./0015-codex-is-the-only-permission-source.md) 完全取代。保留本文作为“Bridge 维护固定权限组合”阶段的历史决策。

## 背景

Codex 的 Sandbox 与审批策略是相互独立的会话设置。仅选择 `:danger-full-access` 不能完整表达用户所说的“全部开放”，因为后续操作仍可能由 `approvalPolicy` 触发审批。App Server 的 `thread/settings/update` 和 `thread/resume` 都支持同时传递 `permissions`、`approvalPolicy` 与 `approvalsReviewer`。

审批通知还存在两种不同状态：微信接口是否确认接收，以及用户是否实际处理。网络失败需要重试；接口接收后长时间无人处理则需要提醒，二者不能混为一谈。

## 决策

控制者显式执行 `perm<n>` 时，三个内置权限模式写入当前共享会话的固定组合：

| 模式 | `permissions` | `approvalPolicy` | `approvalsReviewer` |
| --- | --- | --- | --- |
| 只读 | `:read-only` | `on-request` | `user` |
| 工作区（推荐） | `:workspace` | `on-request` | `user` |
| 完全访问 | `:danger-full-access` | `never` | `user` |

完全访问在用户明确选择后直接生效，不增加风险确认。Bridge 不拼装自定义 Sandbox；遇到非上述三个内置 ID 时只转交 Profile ID，不推断其审批策略。更新后必须重新恢复会话，并校验 Codex 实际返回的 Profile、审批策略和审批人。

Bridge 持久化 `thread_id → profile_id + approval_policy + approvals_reviewer`，供首次加载和 App Server 重连恢复。迁移前的旧记录将新增字段保留为 `NULL`，恢复时只传原 Profile ID，避免静默把旧的 `:danger-full-access` 扩展为 `approvalPolicy=never`。

Bridge App Server 的实时审批通知失败时使用稳定事件标识指数退避；请求仍未处理时在 60 秒和 5 分钟各提醒一次，30 分钟后自动拒绝。Bridge 关闭或 App Server 回调丢失时，旧请求立即拒绝并发送可持久恢复的失效通知。`st` 展示通知接收/重试、发送次数、提醒次数和最短剩余时间，但不把“微信接口已接收”描述为“用户已读”。

Desktop 回合仍只在 Desktop 审批；本决策不改变 Hook 的空 stdout，也不把微信接入 Desktop 审批决定链路。

## 结果

- “完全访问”具有稳定、可验证的官方组合语义。
- 权限切换只影响用户明确选择的当前共享会话，不修改项目或全局默认值。
- 重连能够恢复完整组合，同时兼容旧数据库且不自动扩权。
- 审批网络故障与用户未响应分别处理，失效结果可以可靠送达。
