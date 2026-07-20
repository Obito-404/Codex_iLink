# 可行性与已知边界

## 结论

“Codex Desktop 插件 Hooks + 当前用户 Bridge + 常驻 App Server + 微信 iLink”可以实现微信与 Desktop 共用持久化会话，但不能做成纯插件单体。插件只感知本机 Codex 生命周期，Bridge 负责长轮询、路由和持久化，App Server 执行微信回合。

当前结论是“核心链路可行，关键仲裁已实现，最终实机抢占待验收”。`idle + Busy` 已被实测证明不能阻止两个独立 App Server 双写并错组历史；当前实现已改用 Desktop Hook 与 Bridge 共用的原子 SQLite 租约，并由 `UserPromptSubmit` 执行 fail-closed 仲裁。新版 Hook 捕获、同任务持久化继续和真实微信扫码绑定均已通过，剩余重点是真实 Desktop/Bridge 同时抢占与微信收发、主动推送闭环。

## 已验证

- App Server 创建的持久化任务可由 Desktop 检索和读取。
- 当前项目的 App Server 可见性样本 `019f664b-3baa-7183-9159-27256b164cb5` 已完成 `WECHAT_APP_SERVER_VISIBLE_OK` 回合，并显示在 Desktop 最近任务顶部；观察到外部新建任务的列表缓存可能要在打开或刷新后更新。
- 独立 App Server 进程可恢复同一 `thread_id` 并追加回合，Desktop 能读取新增历史。
- 同一任务的持久化继续记录可由 Desktop 任务记录读取，Bridge 不需要复制 Transcript。
- 本机验证样本为 `019f653c-a959-7f52-833d-3ba61f85c905`，标题“Codex iLink 微信同会话验证”；恢复时读取到 `gpt-5.6-sol`、`cwd=D:\Codex_iLink`、`approvalPolicy=on-request` 和 `workspaceWrite`。
- 插件内部 ID 为 `codex-ilink-probe`，显示名为 `Codex iLink Guard`；Codex Desktop 的 Hook 信任页显示内部 ID。新版生产 Hook 经人工信任后，已在 Desktop 既有任务的继续回合中真实捕获 `SessionStart`、`UserPromptSubmit` 和 `Stop`，包括 `session_id`、`turn_id` 与 `cwd`；2026-07-16 又实机验证了运行中精确 Desktop 租约存在、Stop 后自动释放，以及缺 Stop 的租约跨 Bridge 重启仍保守保留。
- PATH 中的 `codex-cli 0.144.4` 与 Desktop 内置 Codex `0.144.2` 也均捕获到真实生命周期元数据。
- 两个运行时的 App Server 均可用捕获到的 `session_id` 恢复任务；恢复响应包含模型、工作目录、审批策略和 Sandbox，只传 `threadId` 时继承成功。
- 当前版本生成的 Schema 包含所需会话、回合、状态和审批接口，并提供 `clientUserMessageId`；没有 `project/list`。
- App Server 事件可观察 `idle → active → idle` 及 `turn/completed`。
- 外部 App Server 无法可靠实时订阅另一个 Desktop 进程的所有事件，因此需要 Hooks 和持久化 Spool。
- 实机进一步确认：独立 App Server 读取同一活动 Desktop turn 时可能返回 `thread=notLoaded`、`turn=interrupted`，而 Desktop 本身仍显示 `active/inProgress`。因此公开 `thread/read` 只能配合精确 Stop 证据做对账，不能单独承担并发仲裁或 Desktop 租约释放。
- 官方 Hooks 提供 `SessionStart`、`UserPromptSubmit`、`Stop`、`PermissionRequest`，以及 `session_id`、`turn_id`、`cwd`、模型和权限模式等输入。
- `PermissionRequest` Hook 已接入在线审批适配器：Bridge 无覆盖读取任务实际审批者，`auto_review` 保持 stdout 为空且不通知微信；`user` 可通过微信短码返回 `allow` 或 `deny`。
- 继承到子进程的失效 `CODEX_API_KEY` 或 `OPENAI_API_KEY` 会污染现有 ChatGPT 登录认证；从 Desktop 内启动探针时，`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 和 `CODEX_THREAD_ID` 还会错误标记子进程来源。探针已按大小写不敏感方式清理这四项，生产 Bridge 必须使用同样的受控环境策略。
- Windows 最后输入 API 可读取当前用户键鼠空闲时间。
- 腾讯 `openclaw-weixin` 源码包含扫码登录、`get_updates_buf` 长轮询、`message_id`、`context_token` 和文本发送。
- 已完成真实 iLink 扫码并绑定唯一微信用户。
- 离开时 Desktop 终态通知、送达后 5 分钟回复路由、活动任务电源保持，以及最终回复每条最多 2000 UTF-8 字节、最多 3 条的截断策略均已实现。

## 尚未验证

- 已实现的原子租约 + `UserPromptSubmit continue:false` 仲裁仍需完成真实 Desktop/Bridge 同时抢占验收，并验证异常退出后的保守租约恢复。
- 固定 iLink `client_id` 重放是否具有服务端幂等语义；确认前只能保证入站去重，出站通知可能极少量重复。
- 真实微信文本收发、断线游标恢复、长期账号会话和主动通知可达性。
- 独立 App Server 对项目 Skills、MCP、连接器、Computer Use、设备证明等 Desktop 能力的实际复用范围。
- App Server 在审批等待期间崩溃后的恢复能力；规格按失效并拒绝旧审批设计。
- Windows 锁屏事件、空闲判断和电源请求在目标机器长期运行时的稳定性。

## 公开接口边界

- App Server 当前有 `thread/list`，没有 `project/list`；项目只能从会话与 Hook 观察数据派生。
- App Server Schema 是版本相关产物，升级 Codex 后必须先做兼容检查。
- `PermissionRequest` 只在在线 Pipe、请求身份完整且微信回复上下文存在时等待微信决定；Pipe 离线或状态不确定时 stdout 为空并回退 Desktop/Codex，不把审批写入 Spool，也不重放旧决定。
- 非托管命令 Hook 的持久信任绑定当前定义 hash，首次安装和定义变化后都需要用户人工审核。普通安装没有受支持的自动持久信任接口；`--dangerously-bypass-hook-trust` 只适用于已经在 Codex 外部审查来源的单次自动化调用，本项目生产流程不使用。
- Hook Transcript 格式不是稳定接口；插件不解析 Transcript，最终结果通过公开会话接口获取。
- 插件可以打包 Hooks，但不是后台服务，也不能被当成稳定的 Desktop UI 扩展点。
- 微信回合共享持久化会话和本机 Codex 配置，不等于复用 Desktop UI 进程或所有宿主能力。

## iLink 边界

- 腾讯维护的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 提供扫码授权、HTTP 长轮询、游标、发送消息和媒体能力；本项目第一版只采用文本。
- 回复应带回最近入站消息提供的 `context_token`。账号会话、Token、网络或上下文失效时，消息进入 Outbox。
- API 请求含客户端生成的 `client_id`，但参考实现没有证明服务端去重保证；真实收发验收必须覆盖相同 ID 重放。
- 用户本人真实扫码绑定已完成；文本收发和主动通知端到端测试仍待完成。

## 更成熟的替代方案

Codex 官方 [Remote connections](https://learn.chatgpt.com/docs/remote-connections) 已支持从 ChatGPT 手机端继续主机上的既有任务、发送后续、审批和接收通知，并复用主机环境。若“手机远程控制”比“必须使用微信”更重要，官方 Remote 是更简单、更成熟的选择；它不能替代微信入口，而且主机 Desktop 关闭或休眠后会断开。

## 风险结论

| 风险 | 当前策略 | 开发门禁 |
|---|---|---|
| Desktop/Bridge 同会话双写 | `idle + Busy` 已实测失败；Hook 与 Bridge 共用的原子租约已实现 | 完成真实同时抢占与异常恢复验收 |
| 配置继承不完整 | 不发送覆盖字段，能力缺失时报错 | 验证模型、权限、Skills、MCP |
| Hook 丢失 | Named Pipe 失败后写有界 Spool | 验证 Bridge 离线再恢复 |
| 审批回调丢失 | 重启后旧审批失效，绝不重放批准 | 审批中强杀 App Server |
| 消息重复或丢失 | SQLite 事务、去重键、Dispatch Intent、Outbox | 注入每个提交边界的崩溃 |

## 主要参考

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex Plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [PermissionRequest Hook 输出 Schema（Codex 0.144.2）](https://github.com/openai/codex/blob/rust-v0.144.2/codex-rs/hooks/schema/generated/permission-request.command.output.schema.json)
- [Codex Remote connections](https://learn.chatgpt.com/docs/remote-connections)
- [Tencent openclaw-weixin](https://github.com/Tencent/openclaw-weixin)
- [WeClaw v0.7.1](https://github.com/fastclaw-ai/weclaw/releases/tag/v0.7.1)
