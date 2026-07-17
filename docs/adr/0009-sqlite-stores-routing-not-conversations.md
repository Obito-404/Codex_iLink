# SQLite 只保存路由和传输状态

Bridge 使用 SQLite WAL 持久化绑定、队列、游标、审批、去重、Dispatch Intent 和 Outbox，但 Codex 持久化会话仍是唯一对话事实源。入站正文在恢复责任已原子转移到队列或 Dispatch Intent，或失败回复已持久化后删除；Dispatch 输入在 App Server 明确接受且不再需要提交恢复后删除，出站正文在 iLink 明确确认后删除。这样既避免 Bridge 演变成第二套聊天历史，也保留崩溃恢复与至少一次传输所需状态。

微信入站消息可以带媒体，因此 `inbound_messages`、`queued_turns` 和 `dispatch_intents` 的正文列保存同一种版本化输入 payload：文本、附件种类、显示名和本地绝对路径。图片最终映射为 Codex `localImage`，文件和视频映射为 `mention`。SQLite 不保存媒体二进制。

Codex App Server 的最终回复没有独立媒体字段。为适配 Codex Desktop 的标准本地文件展示格式，Bridge 只把独占一行的 `[名称](<Windows 绝对路径>)` 或 `![名称](<Windows 绝对路径>)` 当作显式出站附件契约，不扫描普通自然语言路径、HTTP URL 或行内链接。路径在 Outbox 提交前必须指向当时存在且不超过 100 MiB 的普通文件；单次最多两个。原始本地附件 payload 先进入 Outbox，上传成功后原子替换为固定的 CDN `encrypt_query_param`、AES key、文件名和大小；这样 `sendmessage` 结果未知时仍以相同 `client_id` 和相同媒体 item 重试。确认发送后正文照常清空。

媒体二进制单独保存在 `%LOCALAPPDATA%\Codex_iLink\media\inbound\<sha256(dedupeKey)>`。它至少保留到对应回合终态；提交状态未知时保留到公开 App Server 接口完成对账。启动清理只删除未被入站、队列或未完成 Dispatch Intent 引用的孤儿目录，不能按时间猜测删除仍可能被 Codex 读取的文件。

这一区分保证队列和崩溃恢复仍然可靠，同时把媒体二进制和长期对话排除在 SQLite 之外。出站 CDN 引用和 AES key 只在未确认 Outbox 中短暂存在；各阶段只在下一阶段已经承担恢复责任后清除上一份 payload。入站媒体目录在终态或未知状态对账完成后安全清理。
