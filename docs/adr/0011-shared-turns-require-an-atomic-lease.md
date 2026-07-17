# 共享回合必须先取得原子租约

两个独立 Codex App Server 会同时接受同一 `thread_id` 的回合并破坏历史归属，因此废弃“先查 idle、最后依赖 Busy”的方案。Desktop 的 `UserPromptSubmit` Hook 与 Bridge 必须在进入 Codex 前原子竞争同一个按会话命名的本地租约：Desktop 失败时用 `continue:false` 阻止该回合，Bridge 失败时排队；只有租约持有者可以提交，且只能用匹配令牌释放。生命周期通知仍可 fail-open，但租约 I/O 异常必须 fail-closed，优先保证历史不被双写。
