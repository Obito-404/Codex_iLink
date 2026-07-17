# 微信不能变更会话权限模式

微信回合继承共享会话现有的权限模式，并可以批准或拒绝由 Bridge 的 App Server 发起、仍在当前进程中等待的单次审批请求，但不能在“请求批准”“替我审批”和“完全访问权限”之间切换。

Codex `0.144.x` 的 `PermissionRequest` Hook 技术上支持返回 `allow` 或 `deny`。V1 明确不使用这项能力：Desktop 插件 Hook 只上报审批元数据，stdout 始终为空，Desktop 回合的审批仍由 Codex Desktop 自己处理。这个限制是安全策略，不是 Hook 协议的技术限制，目的是避免让微信入口成为 Desktop 的远程永久提权通道。
