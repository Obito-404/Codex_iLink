# Tencent/openclaw-weixin：iLink 非文本与审批交互

## 结论

- 研究快照：腾讯官方仓库 `main` 的 [`cef0bfc390393f716903e16d50408118047f87e0`](https://github.com/Tencent/openclaw-weixin/commit/cef0bfc390393f716903e16d50408118047f87e0)，对应包版本 `2.4.6`（[`package.json` L1-L6](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/package.json#L1-L6)）。本文只把这个固定提交的 README、协议镜像和实现源码作为当前能力依据。
- **没有审批按钮、快捷选项、交互卡片、菜单、投票或按钮回调。** 当前公开的 `MessageItem` 只定义文本、图片、语音、文件、视频、工具开始/结果；结构中没有 `button`、`action`、`callback`、`select` 一类字段（[`types.ts` L64-L79](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L64-L79)、[L147-L177](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L147-L177)）。官方 README 列出的 iLink 后端接口也只有收消息、发消息、媒体上传、取配置和 typing，没有按钮点击回调接口（[`README.zh_CN.md` L110-L132](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/README.zh_CN.md#L110-L132)）。因此，**仅凭这个 iLink 接口无法在微信里弹出可点击的“批准 / 拒绝”按钮并把点击结果回传**。
- 能不用纯文本展示的现成能力是：**图片、视频、文件、输入中状态、工具调用进度**；用户发给 Bot 的**语音和引用回复**也能被插件接收。它们都不是通用的可点击审批控件。
- 审批的现实路径仍是**文本命令或外部 WebUI**。未合并的 PR [#228](https://github.com/Tencent/openclaw-weixin/pull/228) 正在为 `/approve plugin:...` 文本消息开独立处理通道；它没有新增按钮协议，而且截至 `2026-07-17` 仍未进入 `main`。

## 能力分层

| 能力 | 状态 | 能否用于无文本审批 |
| --- | --- | --- |
| 图片、视频、文件出站 | **已实现** | 只能展示/附加内容，不能提交批准或拒绝 |
| typing 输入状态 | **已实现** | 只表示 Bot 正在输入，不可点击 |
| `TOOL_CALL_START` / `TOOL_CALL_RESULT` | **已实现的结构化进度** | 只有工具名、调用 ID、状态；没有 action/callback，不能审批 |
| 入站语音 | **已实现** | 用户可用语音输入；是否有 wire 转写文本取决于上游，仍不是按钮 |
| `ref_msg` 引用回复 | **入站已实现** | 可读到用户引用的消息，不能由 Bot 创建审批按钮 |
| 出站语音气泡 | **协议暴露、插件未实现** | 音频当前作为普通文件发送 |
| 审批按钮、交互卡片、快捷选项、投票、reaction、位置、联系人、小程序卡片 | **公开协议镜像和插件均未实现** | 不可用 |
| 工具进度在不同微信客户端上的确切视觉样式 | **客户端表现未知** | 即使渲染成特殊状态，也没有可点击回传字段 |

## 1. 已实现的非纯文本能力

### 图片、视频、文件

频道声明 `media: true`，但没有声明 reaction、poll 或 interaction 一类能力（[`channel.ts` L179-L183](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L179-L183)）。实际出站路由为：`video/*` 发 `VIDEO`，`image/*` 发 `IMAGE`，其余都发 `FILE`（[`send-media.ts` L8-L25](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send-media.ts#L8-L25)、[L28-L71](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send-media.ts#L28-L71)）。三种 item 的实际构造分别见 [`send.ts` L195-L230](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L195-L230)、[L233-L261](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L233-L261)、[L264-L293](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L264-L293)。

这三种消息可以替代长文本展示说明、截图、报告或附件，但协议中没有给媒体绑定点击 action 的字段，不能把它们变成审批控件。

### typing 输入状态

iLink 暴露 `sendtyping`；`status=1` 表示正在输入，`status=2` 表示取消（[`README.zh_CN.md` L229-L267](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/README.zh_CN.md#L229-L267)）。插件在回复生命周期开始/结束时确实调用该接口（[`process-message.ts` L289-L318](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L289-L318)）。这是微信客户端的状态提示，不是消息，也不能接收用户操作。

### 工具调用进度：type 11 / 12

协议镜像定义了 `11=TOOL_CALL_START`、`12=TOOL_CALL_RESULT`（[`types.ts` L70-L79](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L70-L79)）。载荷很窄：开始项只有 `tool_name`、`tool_call_id`，结果项再多一个 `status`（[`types.ts` L152-L161](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L152-L161)）。

插件已把 OpenClaw 的 tool start/end 事件映射成这两类 item 并发到 `sendmessage`（[`reply-progress-sender.ts` L73-L110](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/reply-progress-sender.ts#L73-L110)），开关 `replyProgressMessages` 默认开启（[`channel.ts` L166-L176](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L166-L176)）；官方 changelog 也把它标为已新增能力（[`CHANGELOG.zh_CN.md` L34-L39](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/CHANGELOG.zh_CN.md#L34-L39)）。

它最接近“非文本状态卡片”，但**不是审批卡片**：没有按钮列表、动作 ID、回调 payload 或点击事件。仓库没有说明 iOS/Android/桌面微信分别如何渲染 type 11/12，因此只能确认 wire 与发送实现，不能确认确切 UI。

### 用户入站语音与引用回复

插件把 IMAGE、VIDEO、FILE、VOICE 都视为入站媒体（[`inbound.ts` L162-L169](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L162-L169)）；语音若自带 `voice_item.text` 就直接作为正文，否则下载音频交给宿主（[`inbound.ts` L172-L196](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L172-L196)、[`process-message.ts` L113-L148](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L113-L148)）。所以用户可以不用打字，直接发语音，但审批语义仍需应用层自行识别和授权。

`ref_msg` 可携带被引用 item 与摘要（[`types.ts` L147-L150](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L147-L150)）；插件会把入站引用文本拼成 `[引用: ...]` 上下文，引用媒体则走媒体下载（[`inbound.ts` L172-L190](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L172-L190)、[`process-message.ts` L115-L148](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L115-L148)）。当前出站构造器没有设置 `ref_msg`，所以这主要是“读取用户的微信引用回复”，不是 Bot 主动生成的交互控件。

## 2. 协议暴露但插件未实现

`MessageItemType` 定义 `VOICE=3`，上传类型也定义 `VOICE=4`（[`types.ts` L24-L30](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L24-L30)、[L70-L79](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L70-L79)），但出站路由只有 video、image、fallback file；仓库没有 `sendVoice...` 实现（[`send-media.ts` L28-L71](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send-media.ts#L28-L71)）。所以 `.wav`、`.mp3`、`.ogg` 等会作为文件附件，而不是微信语音气泡。

同理，类型中虽有 `MessageState.GENERATING`，插件的文本和结构化 item 发送都固定使用 `FINISH`（[`types.ts` L81-L85](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L81-L85)、[`send.ts` L22-L45](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L22-L45)、[L100-L124](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L100-L124)）；不能把这个枚举单独视为客户端可交互能力。

## 3. 审批现状与 PR #228

当前 `main` 没有审批按钮或审批 item。仓库中的未合并 PR [#228](https://github.com/Tencent/openclaw-weixin/pull/228) 处理的是**文本审批命令在长回合中被轮询阻塞**，不是新增客户端 UI：

- PR head 用正则识别以 `/approve plugin:` 开头的文本（[`monitor.ts` PR #228 L15-L20](https://github.com/Tencent/openclaw-weixin/blob/0e3e5868d8a2b2856d5b58cf5be8dc114a4d7cec/src/monitor/monitor.ts#L15-L20)、[L256-L258](https://github.com/Tencent/openclaw-weixin/blob/0e3e5868d8a2b2856d5b58cf5be8dc114a4d7cec/src/monitor/monitor.ts#L256-L258)）。
- 它让审批文本走独立 lane，随后仍交给 OpenClaw Core 做鉴权和解析（[`monitor.ts` PR #228 L119-L148](https://github.com/Tencent/openclaw-weixin/blob/0e3e5868d8a2b2856d5b58cf5be8dc114a4d7cec/src/monitor/monitor.ts#L119-L148)）。
- 测试示例是 `/approve plugin:test approve`，并验证该文本能绕过正在运行的普通回合（[`monitor.test.ts` PR #228 L61-L84](https://github.com/Tencent/openclaw-weixin/blob/0e3e5868d8a2b2856d5b58cf5be8dc114a4d7cec/src/monitor/monitor.test.ts#L61-L84)、[L102-L138](https://github.com/Tencent/openclaw-weixin/blob/0e3e5868d8a2b2856d5b58cf5be8dc114a4d7cec/src/monitor/monitor.test.ts#L102-L138)）。

因此可以确认的方向是：**微信端发文本命令 → iLink 当普通 TEXT 上送 → OpenClaw Core 完成审批**。PR 尚未合并，不能算 `2.4.6/main` 已交付能力；它也不能作为 iLink 原生审批协议的证据。

## 4. 对 Codex_iLink 的可执行判断

1. 若目标是微信内“点一下批准/拒绝”，当前公开 iLink 协议没有可复用的控件或回调，不能只靠 `openclaw-weixin` 实现。
2. 最小可靠方案仍是文本：发送明确的审批编号和一次性命令，例如“回复 `批准 A17` / `拒绝 A17`”，服务端做身份、会话、过期时间和幂等校验。不要把 type 11/12 当作授权输入。
3. 若允许离开微信会话，可发普通 HTTPS URL 打开自有审批页；但 URL 仍是文本消息，微信是否自动变成可点击链接、是否弹风险提示属于客户端行为，本仓库没有保证。真正批准动作必须在受控 WebUI 中完成。
4. 图片、文件、工具进度和 typing 可改善展示体验；用户语音可作为输入补充。它们不能替代有审计、可鉴权、可撤销的审批通道。
