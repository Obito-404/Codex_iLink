# SQLite 只保存路由和传输状态

Bridge 使用 SQLite WAL 持久化绑定、队列、游标、审批、去重、Dispatch Intent 和 Outbox，但 Codex 持久化会话仍是唯一对话事实源。入站正文在恢复责任已原子转移到队列或 Dispatch Intent，或失败回复已持久化后删除；Dispatch 输入在 App Server 明确接受且不再需要提交恢复后删除，出站正文在 iLink 明确确认后删除。这样既避免 Bridge 演变成第二套聊天历史，也保留崩溃恢复与至少一次传输所需状态。

微信入站消息可以带媒体，因此 `inbound_messages`、`queued_turns` 和 `dispatch_intents` 的正文列保存同一种版本化输入 payload：文本、附件种类、显示名和本地绝对路径。图片最终映射为 Codex `localImage`，文件和视频映射为 `mention`。SQLite 不保存媒体二进制、CDN URL、AES 密钥，也不从 Codex 最终自然语言回复中提取路径作为出站附件。

媒体二进制单独保存在 `%LOCALAPPDATA%\Codex_iLink\media\inbound\<sha256(dedupeKey)>`。它至少保留到对应回合终态；提交状态未知时保留到公开 App Server 接口完成对账。启动清理只删除未被入站、队列或未完成 Dispatch Intent 引用的孤儿目录，不能按时间猜测删除仍可能被 Codex 读取的文件。

这一区分保证队列和崩溃恢复仍然可靠，同时把 CDN 授权信息、解密密钥和大块内容排除在 SQLite 之外。各阶段只在下一阶段已经承担恢复责任后清除上一份 payload；媒体目录在终态或未知状态对账完成后安全清理。
