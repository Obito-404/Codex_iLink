# 微信只选择 Codex 原生权限 Profile

> 状态：已被 [ADR 0015](./0015-codex-is-the-only-permission-source.md) 完全取代。保留本文作为“Bridge 持久化 Profile ID”阶段的历史决策。

唯一微信控制者可以使用 `perm` 查看当前项目由 Codex `permissionProfile/list` 返回且允许选择的原生权限 Profile，并使用 `perm<n>` 切换当前任务。已加载任务通过 `thread/settings/update.permissions` 更新后续回合，首次加载或 App Server 重连时通过 `thread/resume.permissions` 传递选择。Bridge 仅持久化 `thread_id → profile_id`；Sandbox、审批策略和最终权限判断全部由 Codex 执行。

Bridge 为此在 `initialize` 声明 `experimentalApi` 客户端能力，但不打开 Codex 功能开关，不拼装自定义 Sandbox，不调用 Hook 自动允许，也不修改 Codex Desktop 全局设置、其他任务或已经开始的回合。Desktop 插件 Hook 的 `PermissionRequest` stdout 继续保持为空，Desktop 回合仍由 Desktop 审批。

Bridge App Server 自己只有一个实时待审批时由 `ok` 或 `no` 决定；多个待审批时必须使用 `ok<code>` 或 `no<code>`。短码随机生成、在进程内不复用，旧回复不能命中新请求。微信通知发送失败不会伪装成用户拒绝，而是在请求仍存活时使用同一短码退避重试；请求超时或 App Server 回调丢失时明确通知失效，Bridge 重启后旧短码也无法批准。回调本身不持久化，避免重启后批准已经不存在的请求。

该能力依赖 Codex `0.144.x` 的实验性权限 Profile API。接口不可用、Profile 被配置禁止或 Codex 未确认切换结果时，Bridge 必须失败关闭并返回权限命令错误，不能自行降级为更高权限。
