# 微信回合由本机 App Server 执行

微信入口与 Codex Desktop 共享同一个持久化会话，但微信回合由本机 Codex App Server 恢复并执行，而不要求 Desktop UI 进程执行。这样可以使用公开的会话恢复接口接收外部消息，同时保留原会话历史与已持久化配置并让 Desktop 看到结果；代价是交互式审批必须另行路由，Desktop 与 Bridge 的同会话并发拒绝必须先通过实现门禁，否则不能发布共享写入能力。
