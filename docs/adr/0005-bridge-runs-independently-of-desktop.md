# Bridge 独立于 Desktop 窗口运行

Bridge 在 Windows 用户会话中独立后台运行，通过 Codex App Server 处理微信消息和持久化状态，不要求 Codex Desktop 窗口保持打开。Desktop 插件负责上报 Desktop 内部生命周期事件，Desktop 重新打开后继续读取同一批持久化会话；这一边界保证远程入口可用，同时避免依赖 UI 进程生命周期。
