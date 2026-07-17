# 微信 Channel 与 Agent Runtime 边界研究

## 研究范围

本文只核对固定版本的一手源码和项目自有文档，不把博客或二手说明当成事实依据：

- 腾讯官方 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) `v2.4.6`，固定提交 [`cef0bfc390393f716903e16d50408118047f87e0`](https://github.com/Tencent/openclaw-weixin/commit/cef0bfc390393f716903e16d50408118047f87e0)。包本身把自己描述为 `OpenClaw Weixin channel`，并以 OpenClaw 为 peer dependency，见 [`package.json` L1-L5、L30-L39](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/package.json#L1-L39)。
- OpenClaw 宿主 `v2026.5.12`，固定提交 [`f066dd2f31c231f38fbcaacd6f6dfce0801143b3`](https://github.com/openclaw/openclaw/commit/f066dd2f31c231f38fbcaacd6f6dfce0801143b3)。该版本号见 [`package.json` L1-L4](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/package.json#L1-L4)。这是腾讯插件固定版本声明的最低宿主基线。
- FastClaw 的 [`WeClaw`](https://github.com/fastclaw-ai/weclaw) `v0.7.1`，固定提交 [`b48cc9737319d77724d3f65f1ce4cd4d1370a1f6`](https://github.com/fastclaw-ai/weclaw/commit/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6)。它是自身实现的一手来源，但不是腾讯 iLink 的官方规范。

媒体 wire、AES 和 MIME 的逐字段核对已有单独文档：[`tencent-openclaw-weixin-media.md`](./tencent-openclaw-weixin-media.md)。本文只讨论工作流边界、并发、终态和运行隔离。

## 结论先行

1. **腾讯插件只是微信 Channel，不是 Agent Runtime。** 它负责登录、长轮询、游标、鉴权、消息/媒体规范化和微信发送；会话路由、模型选择、工具循环、队列、超时及最终回复由 OpenClaw 宿主负责。
2. **OpenClaw 的关键做法是“一个宿主持有完整回合”。** 同一个宿主既知道 Agent 是否仍在运行，也持有每会话串行 lane、工具事件、终止信号和最终发送，因此不会靠另一个观察连接去猜任务状态。
3. **OpenClaw 的 Codex 运行时默认与个人 Codex/ Desktop 隔离。** 它启动自己管理的 app-server，为每个 Agent 设置独立 `CODEX_HOME` 和 `HOME`；Codex 原生插件与 Computer Use 默认关闭。这能避免微信入口影响个人 Desktop，但也意味着它默认不共享 Desktop 的任务、插件和 thread state。
4. **WeClaw 是一个方便验证协议的单进程桥，但不适合作为并发与权限基线。** 它自己启动 ACP/CLI/HTTP Agent，把微信用户映射到内存 session/thread；每条入站消息直接开 goroutine，没有同用户 FIFO；Codex app-server 路径默认 `approvalPolicy=never`、`danger-full-access`，还会自动允许权限请求。
5. **这些上游都没有同时解决“复用正在运行的 Codex Desktop 任务”和“完全不继承 Desktop 全局插件/配置”。** 这是 Codex_iLink 自己新增的约束，不能靠照搬某个项目自然获得。

## 1. 腾讯官方插件的真实边界

### 1.1 Channel 注册与宿主注入

插件入口只调用 `api.registerChannel`，没有创建模型、工具执行器或 Agent 进程，见 [`index.ts` L1-L18](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/index.ts#L1-L18)。Monitor 的依赖类型明确要求 Gateway 注入 `channelRuntime`，其中包含 reply、routing、session、media 和 commands，见 [`monitor.ts` L18-L35](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/monitor/monitor.ts#L18-L35)。

实际链路是：

```text
微信 getUpdates
  -> 腾讯 channel：游标、鉴权、媒体下载、MsgContext
  -> OpenClaw routing：agentId + sessionKey
  -> OpenClaw session：recordInboundSession
  -> OpenClaw reply：dispatchReplyFromConfig
  -> OpenClaw Agent loop：模型 <-> 工具，直到终态
  -> 腾讯 channel deliver：sendmessage / CDN
```

路由和会话记录由注入的宿主接口完成，见 [`process-message.ts` L219-L269](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L219-L269)；最终调用的也是宿主 `dispatchReplyFromConfig`，见 [`process-message.ts` L449-L473](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L449-L473)。因此，插件看到工具开始/结束只是宿主通过回调暴露的进度，不是插件自己续接模型工具循环；进度消息只有一条 Promise send chain 来保证发送顺序，见 [`reply-progress-sender.ts` L34-L70、L73-L120](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/reply-progress-sender.ts#L34-L120)。

### 1.2 入站顺序不是持久化任务队列

官方 Monitor 成功取到响应后先保存新游标，再逐条 `await processOneMessage`，见 [`monitor.ts` L150-L183](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/monitor/monitor.ts#L150-L183)。这带来两个准确边界：

- 同一个账号、同一次 poll 中的消息由 channel 串行背压，不会同时进入 Agent。
- channel 没有一张可恢复的“待执行消息表”；它保存的是服务端游标。若保存游标后、批次处理完前进程崩溃，单凭本插件源码不能证明尚未处理的消息一定会重放。

真正的同会话运行串行与 busy-message 策略属于 OpenClaw 宿主，而不是腾讯插件。

### 1.3 中断、错误和审批

- Monitor 的 `AbortSignal` 用于立即取消正在进行的长轮询和 backoff sleep，见 [`monitor.ts` L89-L102、L184-L223](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/monitor/monitor.ts#L89-L223)。插件没有实现自己的 Agent `turn/interrupt`。
- 回复发送失败由 channel 分类并尝试回发文本错误提示，见 [`process-message.ts` L414-L445](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L414-L445)。Agent 回合卡住仍需宿主结束或中断，channel 才能走到最终发送。
- 该版本只原生截获 `/echo` 与 `/toggle-debug`；其他 slash command 返回 `handled: false`，继续进入 OpenClaw 命令/Agent 管道，见 [`slash-commands.ts` L61-L109](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/slash-commands.ts#L61-L109)。插件本身没有声明微信原生审批按钮或自己决定 shell 权限。

### 1.4 附件、语音和主动发送

- Channel 声明 `media: true`，见 [`channel.ts` L179-L183](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L179-L183)。入站只选一个媒体，优先级为图片、视频、文件、无转写语音，并交给宿主的 media store，见 [`process-message.ts` L113-L156](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L113-L156)。
- 出站暴露独立的 `sendText` 与 `sendMedia`，可以由 Agent message tool、cron 或其他宿主流程调用；单账号可直接选择，多个账号则需要显式 accountId 或能由 context token 唯一反查，见 [`channel.ts` L57-L106、L217-L298](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L57-L298)。
- 插件给 Agent 的提示明确要求 cron 保存 `delivery.to` 与 `delivery.accountId`，见 [`channel.ts` L196-L203](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L196-L203)。所以“主动推送”不是 channel 监听某个桌面会话完成，而是 OpenClaw 的任务/cron 在终态时调用 channel outbound。

## 2. OpenClaw 宿主如何持有完整 Agent 回合

### 2.1 工具循环、会话 lane 与 busy message

OpenClaw 把真实 Agent loop 定义为“输入、上下文、模型、工具、流式回复、持久化”的完整链路，并规定同一 session 只有一个串行 run，见 [`agent-loop.md` L9-L15](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/concepts/agent-loop.md#L9-L15)。宿主执行器负责加载模型/skills、运行 embedded loop、转发模型与工具事件并产生 lifecycle end/error，见 [`agent-loop.md` L22-L43](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/concepts/agent-loop.md#L22-L43)。

并发模型有两层：

- `session:<key>` lane 保证同一会话只运行一个 Agent；全局 `main` lane 再控制总并发，见 [`queue.md` L16-L22](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/concepts/queue.md#L16-L22)。
- 默认 busy-message 模式是 `steer`：把新消息注入当前回合的下一个模型边界；不能 steer 时回退为 followup。还支持 `followup`、`collect`、`steer-backlog`、`interrupt`，见 [`queue.md` L24-L51](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/concepts/queue.md#L24-L51)。默认 followup 容量 20、静默窗口 500ms、溢出总结旧消息，见 [`queue.md` L73-L83](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/concepts/queue.md#L73-L83)。

源码也明确在活动 run 时把 `steer`/legacy `queue` 判为 `enqueue-followup`，而 `interrupt` 会先 abort 当前 run、等待结束，再判断是否可启动新 run，见 [`queue-policy.ts` L3-L24](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/src/auto-reply/reply/queue-policy.ts#L3-L24)、[`get-reply-run-queue.ts` L15-L50](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/src/auto-reply/reply/get-reply-run-queue.ts#L15-L50)。

这套队列仍是宿主进程内状态，不是外部任务队列；其保证是同一宿主内的 session 串行和消息策略。文档明确说明它是纯 TypeScript + Promise、没有外部 worker，见 [`queue.md` L106-L112](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/concepts/queue.md#L106-L112)。

### 2.2 超时不是一个数字，而是分层终止

OpenClaw 分开处理：

- 整个 Agent run 的外层超时默认 48 小时，超时后 abort；模型无响应另有 idle watchdog，通常最多 120 秒，见 [`agent-loop.md` L163-L170](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/concepts/agent-loop.md#L163-L170)。
- Codex 动态工具默认 30 秒，最多 10 分钟；超时会中断工具并把失败结果返回 Codex，使回合可以继续，见 [`codex-harness-reference.md` L234-L248](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/plugins/codex-harness-reference.md#L234-L248)。
- 对“工具已返回，但 Codex 没有发 `turn/completed`”这一类卡点，Codex harness 有独立的 `turnCompletionIdleTimeoutMs`，默认 60 秒；安静超时后 best-effort interrupt，并释放 session lane，见 [`codex-harness-reference.md` L88-L104、L250-L262](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/plugins/codex-harness-reference.md#L88-L104)。

最后一层正对应“工具结果成功返回，但模型没有继续产生 final/turn completed”的故障类型；仅给微信 transport 加网络超时无法解决它。

### 2.3 审批属于宿主策略，不属于微信 transport

OpenClaw 明确区分：`approvals.exec` 负责把审批提示转发到聊天目的地，`channels.<channel>.execApprovals` 才是某个 channel 的原生审批客户端；真正的门禁始终是 host exec policy。支持命令回复的 channel 可以走同会话 `/approve`，见 [`faq-first-run.md` L131-L150](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/help/faq-first-run.md#L131-L150)。

这意味着微信 channel 不应自行把“收到任意回复”解释为批准，也不应为了避免卡住而无条件放行。它只负责安全地展示和路由一个带稳定 approval id 的决定。

### 2.4 Codex 运行隔离是显式设计

OpenClaw 的 Codex harness 默认启动捆绑、受管的 `codex app-server --listen stdio://`，版本不跟随电脑上另一个 Codex CLI，见 [`codex-harness-reference.md` L50-L62](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/plugins/codex-harness-reference.md#L50-L62)。更关键的是：

- 本地 app-server 每个 Agent 都有独立 `CODEX_HOME` 与 `HOME`，Codex 原生 skills、plugins、config、账号和 thread state 不会从操作者个人 Codex Home 泄漏进来，见 [`codex-harness-reference.md` L149-L180](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/plugins/codex-harness-reference.md#L149-L180)。
- Codex 原生插件默认关闭，Computer Use 默认关闭；需要的工具由 OpenClaw registry 明确提供，见 [`codex-harness-reference.md` L39-L48、L211-L232](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/plugins/codex-harness-reference.md#L39-L48)。
- 本地无人值守默认是 YOLO（`never` + `danger-full-access`），但可切到 guardian（`on-request` + `auto_review` + `workspace-write`），见 [`codex-harness-reference.md` L109-L147](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/plugins/codex-harness-reference.md#L109-L147)。隔离和权限仍是两个不同维度：独立 Home 不等于应该给 full access。

因此，上游解决“不要影响 Desktop 所有项目会话”的方式不是在共享个人配置上不断打补丁，而是让远程 Agent runtime 根本不加载个人 Desktop 的 native plugins/config/thread state。

### 2.5 主动推送

OpenClaw cron 的 `announce` 会在 Agent 没有自行发送时把最终文本投递到明确 channel/target；message tool 已发送到当前目标时则抑制重复 fallback，见 [`cron-jobs.md` L154-L170](https://github.com/openclaw/openclaw/blob/f066dd2f31c231f38fbcaacd6f6dfce0801143b3/docs/automation/cron-jobs.md#L154-L170)。其触发源是宿主任务终态，而不是重新打开 GUI 后读取渲染内容。

## 3. WeClaw v0.7.1 的做法与局限

### 3.1 它同时是 channel bridge 和 Agent 进程适配器

WeClaw 定义统一 `Agent.Chat(conversationID, message)` 接口，`conversationID` 用于按用户保持历史，见 [`agent.go` L78-L94](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/agent.go#L78-L94)。启动时它加载自己的 `~/.weclaw/config.json`，按配置创建 ACP、CLI 或 HTTP Agent，并另启账号 monitor，见 [`config.go` L11-L33、L74-L109](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/config/config.go#L11-L33)、[`start.go` L100-L181](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/cmd/start.go#L100-L181)。

它不是“控制已打开的 Codex Desktop”：

- ACP 模式自己用 `exec.CommandContext` 启动一个长期子进程，见 [`acp_agent.go` L186-L259](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/acp_agent.go#L186-L259)。
- Codex app-server 模式把 `conversationID -> threadID` 只保存在当前进程的内存 map，见 [`acp_agent.go` L19-L47、L477-L515](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/acp_agent.go#L19-L47)。服务重启后这张映射不会恢复。
- Codex CLI 模式每条消息直接执行一次 `codex exec`，而且忽略 `conversationID`，没有 resume，见 [`cli_agent.go` L105-L113、L242-L279](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/cli_agent.go#L105-L113)。

### 3.2 没有同会话 FIFO 或 turn-completion watchdog

Monitor 对每条入站消息直接 `go m.handler(...)`，明确选择“不阻塞 poll loop”，见 [`monitor.go` L115-L125](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/ilink/monitor.go#L115-L125)。Handler 随后同步等待 `ag.Chat` 返回，再发送回复，见 [`handler.go` L411-L454、L540-L555](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/messaging/handler.go#L411-L454)。源码没有按用户/线程串行的队列。

Codex app-server Chat 在 `turn/start` 后一直等事件 channel 中的 `turn/completed`；只有传入的 context 取消才返回，见 [`acp_agent.go` L518-L590](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/acp_agent.go#L518-L590)。但 Monitor 传入的是整个服务的 root context，没有每消息 deadline。该文件唯一明确的固定超时是启动握手 30 秒，见 [`acp_agent.go` L264-L306](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/acp_agent.go#L264-L306)。

并发时风险更具体：每个 thread 只有一个 `turnCh`，新 Chat 会覆盖旧 channel；事件 thread id 对不上时实现还会回退到“任意一个 active turn channel”，见 [`acp_agent.go` L537-L547、L866-L885](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/acp_agent.go#L537-L547)。所以 WeClaw 不能作为同一会话并发仲裁的参考实现。

另一个可见边界是 `/new`：`ResetSession` 只删除 legacy ACP 的 `sessions` map，没有删除 Codex app-server 的 `threads` map，见 [`acp_agent.go` L330-L342](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/acp_agent.go#L330-L342)。在该固定版本中，不能据此保证 Codex app-server `/new` 真正创建了新 thread。

### 3.3 权限和运行环境

WeClaw 对 Codex app-server 的 `thread/start` 与 `turn/start` 都发送 `approvalPolicy: "never"` 和 full-access sandbox，见 [`acp_agent.go` L477-L515、L549-L558](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/acp_agent.go#L477-L515)。如果 Agent 仍发权限请求，它会自动选择第一个 allow option，见 [`acp_agent.go` L888-L930](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/acp_agent.go#L888-L930)。这能避免微信等待本机批准，却把安全决策直接删掉了。

WeClaw 可为每个 Agent 配置 `cwd` 和环境变量，缺省工作区是 `~/.weclaw/workspace`，见 [`config.go` L19-L33](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/config/config.go#L19-L33)、[`agent.go` L30-L39](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/agent.go#L30-L39)。但 ACP 启动默认继承当前进程环境，只在用户显式配置时 merge env；源码没有像 OpenClaw 一样自动建立每 Agent `CODEX_HOME/HOME`，见 [`acp_agent.go` L219-L228](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/agent/acp_agent.go#L219-L228)。因此它不能自动保证个人 Codex 插件/config 不被继承。

### 3.4 媒体和主动发送

- 入站正文支持普通文本和微信 wire 自带的语音转写；无正文时只会在配置了 saveDir 后把图片保存到磁盘，文件、视频和无转写语音会跳过，不会作为 Agent 输入，见 [`handler.go` L260-L301、L708-L785](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/messaging/handler.go#L260-L301)。
- Agent 回复可提取 Markdown 图片 URL，也可识别独占一行、位于默认 workspace 或 Agent cwd 下的绝对附件路径，再上传为图片、视频或普通文件，见 [`handler.go` L491-L537](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/messaging/handler.go#L491-L537)、[`attachment.go` L10-L74](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/messaging/attachment.go#L10-L74)。
- 主动发送通过本机 HTTP `POST /api/send` 实现，支持 text/media_url，默认只监听 `127.0.0.1:18011`，见 [`server.go` L14-L55、L58-L118](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/api/server.go#L14-L55)。它仍需要外部任务明确调用 API；没有监视 Codex Desktop 回合结束并自动推送的实现。

## 4. 对照表

| 维度 | 腾讯插件 + OpenClaw | WeClaw v0.7.1 |
| --- | --- | --- |
| 微信边界 | Channel/transport 插件 | Bridge 内置 iLink client |
| Agent 工具循环 | OpenClaw 宿主完整持有 | 启动的 ACP/CLI/HTTP Agent 持有；WeClaw 只适配事件 |
| 会话标识 | OpenClaw route 的 `sessionKey`，宿主 session store | 微信 user id -> 内存 session/thread map |
| 同会话并发 | 宿主 session lane 串行；busy message 可 steer/followup/collect/interrupt | 每消息 goroutine；无同用户 FIFO |
| 卡住治理 | Agent、model idle、tool、Codex turn-completion 分层 watchdog | 启动握手有 30 秒；正常 Chat 无每回合 watchdog |
| 审批 | host policy 真正门禁，channel 只路由展示/决定 | `never` + full access + auto-allow |
| 与个人 Codex 隔离 | 每 Agent 独立 `CODEX_HOME/HOME`，native plugins/Computer Use 默认关闭 | 默认继承进程环境；需用户自己配置隔离 |
| 入站媒体 | 图片/视频/文件/语音中取一个交给宿主 | 语音转写作文本；图片只保存；其他跳过 |
| 主动推送 | message tool / cron 在宿主任务终态调用 channel outbound | 外部调用本机 `/api/send` |
| 是否共享 Desktop 任务 | 否，默认隔离 thread state | 否，自己启动 Agent 并使用内存映射 |

## 5. 对 Codex_iLink 的架构含义（不涉及本次实施）

### 5.1 可以直接借鉴

1. **Channel 与 Agent runtime 分层。** iLink 收发、游标、媒体、错误映射保持为 transport；只有一个 runtime owner 负责从 `turn/start` 经所有工具直到 terminal event。
2. **按任务/会话串行，而不是按“进程看起来空闲”猜测。** 当前回合必须有稳定 operation id、明确 owner、progress timestamp 和 terminal state；新消息采用可解释的 FIFO/followup 策略。
3. **为“工具返回后无终态”单设 watchdog。** 这是 Agent 协议层故障，不应伪装成网络错误；应 best-effort interrupt、标记确定的 timeout/interrupted 结果并释放 lane。带副作用的工具完成后不能盲目重跑整条消息。
4. **远程 runtime 使用独立配置域是上游的隔离方案。** OpenClaw 采用独立 `CODEX_HOME/HOME`、显式工具白名单，并默认关闭 Codex native plugins 和 Computer Use；这适合不共享 Desktop 任务的产品。Codex_iLink 当前选择共享 Desktop 任务，因此不采用能力白名单或功能覆盖，只借鉴其生命周期、串行与 watchdog 设计。
5. **主动推送由 operation 终态触发。** 保存明确的微信 route（account、to、context token/可替代路由信息），由完成事件写 Outbox；不要依赖 GUI 重开、UI 刷新或再次读取 Desktop 渲染状态。

### 5.2 必须明确接受的取舍

- **强隔离与原生共享 Desktop thread state 天然冲突。** OpenClaw 选择独立 Home，所以不共享个人 thread；WeClaw 选择自己启动 app-server，也不共享 Desktop。若 Codex_iLink 两者都要，需要自己定义“哪些历史/任务元数据可共享、谁是唯一写者、怎样同步”，不能继续把“继承整个个人 Codex Home”当作共享协议。
- **腾讯插件的顺序消费不等于持久队列。** 如果要求重启后不丢、不重复，就需要自己的 durable inbox/outbox 和幂等 operation，而不是只保存 `get_updates_buf`。
- **审批不能用自动允许来消除等待。** 应选择可在微信安全完成的稳定 approval-id 流程，或为微信 runtime 预设受限、无需逐次批准的工具集；高风险能力仍留给 Desktop。

## 6. 最重要的判断

对当前“微信发了继续，工具已经返回但没有最终回复”的问题，上游给出的最接近答案不是修改微信发送逻辑，而是：**让持有 Codex 工具循环的 runtime 同时持有同会话 lane 和 `turn/completed` watchdog。**

对“Hook/插件不应影响所有 Desktop 项目”的问题，上游最强隔离答案是独立 Codex Home，但代价是不再原生共享 Desktop 任务。Codex_iLink 当前采用的边界是：**不覆盖 Codex 能力配置；Hook 只观察当前微信所选项目，并只对明确受管任务执行门禁，其他 Desktop 项目直接放行且不记录。**
