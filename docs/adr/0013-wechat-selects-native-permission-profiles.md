# 微信只选择 Codex 原生权限 Profile

唯一微信控制者可以使用 `/perm` 查看当前项目由 Codex `permissionProfile/list` 返回且允许选择的原生权限 Profile，并使用 `/perm <n>` 通过 `thread/resume.permissions` 直接切换当前任务。Bridge 仅持久化 `thread_id → profile_id`，用于自身 App Server 重连后重新传递同一选择；Sandbox、审批策略和最终权限判断全部由 Codex 执行。

Bridge 为此在 `initialize` 声明 `experimentalApi` 客户端能力，但不打开 Codex 功能开关，不拼装自定义 Sandbox，不调用 Hook 自动允许，也不修改 Codex Desktop 全局设置、其他任务或已经开始的回合。Desktop 插件 Hook 的 `PermissionRequest` stdout 继续保持为空，Desktop 回合仍由 Desktop 审批。

Bridge App Server 自己收到的实时审批可以由 `/ok <n>` 或 `/no <n>` 决定。微信通知发送失败不会再立即伪装成用户拒绝，而是在请求仍存活时使用同一编号退避重试；请求超时或 App Server 回调丢失时明确通知失效，Bridge 重启后旧编号也无法批准。回调本身不持久化，避免重启后批准已经不存在的请求。

该能力依赖 Codex `0.144.x` 的实验性权限 Profile API。接口不可用、Profile 被配置禁止或 Codex 未确认切换结果时，Bridge 必须失败关闭并返回权限命令错误，不能自行降级为更高权限。
