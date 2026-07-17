# WeClaw 作为参考基线而非原样运行

实现参考 WeClaw v0.7.1 已有的 iLink 与 Codex App Server 代码，以缩短协议验证时间，但不原样部署其内存 Thread 映射、自动批准、`approvalPolicy=never` 或 `danger-full-access` 默认值，也不保留不需要的 ACP 和多 Agent fallback。这样复用成熟链路，同时让权限、持久化和 Desktop Hooks 服从本项目已经确定的边界。
