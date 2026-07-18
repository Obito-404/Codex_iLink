# SQLite 只保存路由和传输状态

Bridge 使用 SQLite WAL 持久化绑定、队列、游标、审批、去重、Dispatch Intent 和 Outbox，但 Codex 持久化会话仍是唯一对话事实源。入站正文在恢复责任已原子转移到队列或 Dispatch Intent，或失败回复已持久化后删除；Dispatch 输入在 App Server 明确接受且不再需要提交恢复后删除，出站正文在 iLink 明确确认后删除。这样既避免 Bridge 演变成第二套聊天历史，也保留崩溃恢复与至少一次传输所需状态。

微信入站消息可以带媒体，因此 `inbound_messages`、`queued_turns` 和 `dispatch_intents` 的正文列保存同一种版本化输入 payload：文本、附件种类、显示名和本地绝对路径。图片最终映射为 Codex `localImage`，文件和视频映射为 `mention`。SQLite 不保存媒体二进制。

iLink 新建任务通过 App Server `dynamicTools` 注册 `send_file(path)`；Bridge 仅接受当前实例持有的微信回合，并从 App Server 当前 thread 读取 canonical `cwd`。只有 cwd 子树内、当时存在且不超过 100 MiB 的普通单链接文件可登记；UNC、设备路径、ADS、Node 可识别的 symlink/junction、hardlink 与 cwd 外路径一律拒绝。授权后立即复制到 iLink 私有 `Outbound` 快照，UUID 文件名绑定内容 SHA-256，`outbound_attachment_intents` 和 Outbox 只引用快照；投递从稳定文件描述符读取并校验 hash 后直接把该字节副本交给上传器，避免登记后或校验后的 TOCTOU。Markdown 本地链接不再是附件契约；`thread/resume` 无法补装工具的旧任务需新建 iLink 任务。成功终态与最终正文原子进入 Outbox，失败或中断终态清理未引用快照；上传成功后先把固定 CDN 参数、AES key、文件名和大小持久化替换到 Outbox，再删除受信任根内的 UUID 快照。Daemon 启动以附件意图与待发 Outbox 为引用集，只清理未引用的受信任快照。SQLite v12 为附件意图增加 `snapshot_provenance`：迁移前记录固定为 `legacy`，其规范化路径 key 写入永久保护集；旧路径不得读取、上传或删除，只有新登记的 `staged-v1` 快照能进入 Outbox 和清理流程。旧版本遗留的未标记本地媒体只替换为安全提示；`sendmessage` 结果未知时仍以相同 `client_id` 和相同 prepared media 重试。确认发送后正文照常清空。

媒体二进制单独保存在 `%LOCALAPPDATA%\Codex_iLink\media\inbound\<sha256(dedupeKey)>`。它至少保留到对应回合终态；提交状态未知时保留到公开 App Server 接口完成对账。启动清理只删除未被入站、队列或未完成 Dispatch Intent 引用的孤儿目录，不能按时间猜测删除仍可能被 Codex 读取的文件。

这一区分保证队列和崩溃恢复仍然可靠，同时把媒体二进制和长期对话排除在 SQLite 之外。出站 CDN 引用和 AES key 只在未确认 Outbox 中短暂存在；各阶段只在下一阶段已经承担恢复责任后清除上一份 payload。入站媒体目录在终态或未知状态对账完成后安全清理。
