# Hooks 通过失败放行的 Named Pipe 上报

Desktop 插件 Hooks 优先通过当前用户专属的 Windows Named Pipe 向 Bridge 上报生命周期元数据，Pipe 不可用时写入有界本地 Spool，二者合计等待最多 500ms，全部失败仍然放行。Bridge 消费单个 Spool 事件最多等待 5 秒；普通生命周期事件失败后移入有界 `dead-letter`，承载仲裁状态的门禁 `UserPromptSubmit` 最多尝试 3 次后再隔离，不让坏事件在微信轮询主链路中无限重放。这样避免开放本机 TCP 端口和阻塞 Codex Desktop；公开接口对账只修复状态，不能可靠重建同时丢失的事件或据此伪造主动通知。此 fail-open 规则只适用于生命周期通知；共享会话写入仲裁属于安全边界，按 ADR-0011 使用本地原子租约，不依赖 Pipe 通知成功。
