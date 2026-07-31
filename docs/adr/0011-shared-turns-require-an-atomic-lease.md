# 共享回合必须先取得原子租约

两个独立 Codex App Server 会同时接受同一 `thread_id` 的回合并破坏历史归属，因此废弃“先查 idle、最后依赖 Busy”的方案。Desktop 的 `UserPromptSubmit` Hook 与 Bridge 必须在进入 Codex 前原子竞争同一个按会话命名的本地租约：Desktop 失败时用 `continue:false` 阻止该回合，Bridge 失败时排队；只有租约持有者可以提交，且只能用匹配令牌释放。生命周期通知仍可 fail-open，但租约 I/O 异常必须 fail-closed，优先保证历史不被双写。

Desktop 宿主中断回合时可能不发送 `Stop`。此后只有同一会话的新 Desktop `UserPromptSubmit` 能执行兼容恢复，而且必须从该 Hook 提供、文件名绑定当前 `thread_id` 的本地 rollout 有界尾部读到顶层结构化 `turn_aborted`，其 `turn_id` 精确匹配旧租约且 `reason` 为 `interrupted`。Hook 在同一个 `BEGIN IMMEDIATE` 临界区内用旧租约完整令牌 CAS 为新 Desktop 令牌；它不先删除租约，不接管 Bridge 租约，旧回合延迟到达的 `Stop` 也不能修改新租约。transcript 格式不是稳定契约，因此缺失、超界、未完整写入、损坏或格式变化时一律保持旧租约并阻止新回合。
