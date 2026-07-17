# 腾讯官方 iLink 协议核对（2026-07-16）

## 结论

腾讯官方 `openclaw-weixin` v2.4.6 已经给出一条完整、可复用的 iLink 客户端链路：固定入口扫码，`notifyStart` 后持续 `getUpdates`，使用游标恢复，`sendMessage` 回复，退出时 `notifyStop`。本项目的端点、版本号、鉴权头、`base_info`、生命周期通知和 64 位消息 ID 防精度丢失已经基本对齐。

当前最值得优先修正的协议差异有三项：

1. 本项目仍要求入站 `context_token` 非空，并把包含任何非文本 item 的整条消息判为媒体；官方实现允许没有 context，且会从混合 item 中提取第一段文本。这会让合法消息被静默过滤，同时游标仍然前移。
2. 本项目虽然读出了服务端 `longpolling_timeout_ms`，但 Daemon 没把它用于下一轮长轮询。
3. 服务端返回 `ret=-14` 或 `errcode=-14` 时，官方按账号暂停常规入站/出站请求一小时；本项目仅分类为 `auth-expired`，随后仍进入通用的最高 30 秒退避。

扫码登录的验证码、二维码自动刷新、最近本地 token 列表也尚未接入本项目的 CLI 流程，但不影响已经完成绑定的账号继续验证收发。

## 调查范围与证据等级

- 官方仓库：[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)
- 固定提交：[`cef0bfc390393f716903e16d50408118047f87e0`](https://github.com/Tencent/openclaw-weixin/tree/cef0bfc390393f716903e16d50408118047f87e0)
- 版本：`2.4.6`，见 [package.json L1-L6](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/package.json#L1-L6)
- 方法：只读取该固定提交中的第一方源码，并与当前工作区源码逐项对照。

该仓库没有在本次范围内提供独立的公开 iLink 服务端规范或 proto 文件；因此下文是“腾讯官方客户端在该提交中的实现事实”，不是对未公开服务端契约的额外推断。官方类型文件明确说明它镜像 proto，并使用 HTTP JSON、以 Base64 字符串承载 bytes 字段，见 [`src/api/types.ts` L1-L4](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L1-L4)。

本文没有记录或复述任何真实 token、用户 ID、context token、消息正文或游标内容。

## 官方请求流程总览

| 阶段 | 方法与端点 | 官方行为 |
|---|---|---|
| 创建二维码 | `POST ilink/bot/get_bot_qrcode?bot_type=3` | 固定登录主机；请求体携带最多十个最近本地 token |
| 查询扫码状态 | `GET ilink/bot/get_qrcode_status` | 35 秒客户端长轮询；可带验证码；支持 IDC redirect |
| 启动通知 | `POST ilink/bot/msg/notifystart` | 启动监控前调用；失败只警告 |
| 拉取消息 | `POST ilink/bot/getupdates` | 发送持久化游标与 `base_info`；采用服务端建议的下一轮超时 |
| 发送消息 | `POST ilink/bot/sendmessage` | 发送 BOT/FINISH 消息、item list、client ID，可选 context/run ID |
| 停止通知 | `POST ilink/bot/msg/notifystop` | 账号停止时调用；失败只警告 |

端点实现见 [GetUpdates L430-L470](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L430-L470)、[SendMessage L502-L520](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L502-L520) 与 [NotifyStart/Stop L556-L585](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L556-L585)。

## 1. 扫码登录

### 官方事实

- 登录固定主机为 `https://ilinkai.weixin.qq.com`，`bot_type` 为 `3`；创建二维码始终使用固定主机，而不是账号保存的业务 API 地址，见 [`login-qr.ts` L23-L31](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/auth/login-qr.ts#L23-L31) 与 [L197-L215](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/auth/login-qr.ts#L197-L215)。
- 创建二维码时从最近注册的账号倒序选取最多十个非空本地 bot token，放入 `local_token_list`，见 [L64-L89](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/auth/login-qr.ts#L64-L89)。
- 状态查询使用 GET，默认 35 秒客户端超时；`verify_code` 存在时作为查询参数。客户端超时和一般网络/网关错误都转成 `wait`，继续轮询，见 [L112-L135](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/auth/login-qr.ts#L112-L135)。
- `need_verifycode` 会提示用户输入数字；错误后可重输。`expired` 和 `verify_code_blocked` 会执行有上限的二维码刷新。常量上限为 3，但计数从 1 开始并在刷新前自增，因此原始二维码之后最多实际请求两次新二维码，见 [L231-L257](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/auth/login-qr.ts#L231-L257)、[L287-L290](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/auth/login-qr.ts#L287-L290) 与 [L321-L387](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/auth/login-qr.ts#L321-L387)。
- `scaned_but_redirect` 把后续状态轮询切换到 `redirect_host`；`confirmed` 返回业务 API 地址和账号凭据字段；`binded_redirect` 被视为“已经连接”的成功结果，见 [L389-L434](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/auth/login-qr.ts#L389-L434)。

### 本项目差异

- `src/ilink/ilink-client.ts:70-177` 已对齐固定主机、`bot_type=3`、35 秒状态轮询、验证码参数、redirect 和 confirmed 字段。
- `src/cli/login-flow.ts:41-44` 始终发送空 `localTokenList`；当前状态库也没有“最多十个历史登录 token”的产品需求。这对首次绑定没有影响，但与官方重连体验不同。
- `src/cli/login-flow.ts:48-103` 没有验证码输入与二维码自动刷新：`verify-required`、`verify-blocked`、`expired`、`already-bound` 都直接终止。`pollQr` 的普通网络错误也会向上抛出，而官方把它当作等待。
- 当前 confirmed 校验要求 token、bot ID、扫描用户 ID 都非空，比官方仅显式检查 bot ID 更保守；这一点应保留。

## 2. Headers 与 base_info

### 官方事实

官方 POST 请求头由统一封装生成：

| 字段 | 规则 |
|---|---|
| `Content-Type` | 固定 `application/json` |
| `AuthorizationType` | 固定 `ilink_bot_token` |
| `Authorization` | 有非空 token 时为 `Bearer <token>` |
| `X-WECHAT-UIN` | 每次请求生成随机 uint32，转十进制字符串后再 Base64 |
| `iLink-App-Id` | 来自包字段 `ilink_appid`；该版本为 `bot` |
| `iLink-App-ClientVersion` | 版本编码为 `major<<16 | minor<<8 | patch`；`2.4.6` 对应 `132102` |
| `SKRouteTag` | 配置存在时才添加 |

证据见 [版本编码 L89-L107](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L89-L107)、[请求头 L221-L253](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L221-L253) 和 [包内 `ilink_appid` L60-L66](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/package.json#L60-L66)。二维码状态 GET 只使用公共 App 头，见 [`api.ts` L290-L318](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L290-L318)。

`base_info` 只有两个字段：

- `channel_version`：包版本；
- `bot_agent`：经过清洗的自声明客户端身份，仅用于可观测性，不参与鉴权或路由。

证据见 [`types.ts` L6-L21](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L6-L21) 与 [`api.ts` L202-L208](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L202-L208)。

### 本项目差异

- `src/ilink/protocol.ts:1-6` 的主机、`bot_type`、App ID、客户端版本和 channel 版本与官方提交一致。
- `src/ilink/ilink-client.ts:469-486` 已包含 `X-WECHAT-UIN`、AuthorizationType、Bearer 与公共 App 头；GET 状态查询只使用公共头，也与官方一致。
- 当前没有可选 `SKRouteTag`。它只在部署环境明确提供路由标签时才需要，不是普通账号的必填字段。
- 当前 `bot_agent` 固定为 `Codex-iLink/0.0.0`，而官方允许配置并清洗；协议字段本身已经对齐。

## 3. notifyStart、getUpdates、游标与 notifyStop

### 官方事实

1. 账号启动时，官方先调用 `notifyStart`，即使 HTTP、解析或非零 `ret` 失败也只记录警告，然后才启动 monitor，见 [`channel.ts` L400-L468](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L400-L468)。
2. `getUpdates` POST 请求体为 `get_updates_buf` 加 `base_info`，默认客户端超时 35 秒；超时返回空消息并保留原游标，见 [`api.ts` L424-L470](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L424-L470)。
3. monitor 启动时从账号文件恢复游标；服务端给出正数 `longpolling_timeout_ms` 后，下一轮使用该值，见 [`monitor.ts` L70-L109](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/monitor/monitor.ts#L70-L109)。
4. 成功响应里只有非空的新游标才会持久化。官方先保存游标，再按顺序处理 `msgs`，见 [`monitor.ts` L150-L183](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/monitor/monitor.ts#L150-L183)。游标文件的读取兼容与写入实现见 [`sync-buf.ts` L32-L80](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/storage/sync-buf.ts#L32-L80)。
5. 账号停止时调用 `notifyStop`，失败同样只警告，见 [`channel.ts` L470-L487](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L470-L487)。

### 本项目差异

- `src/daemon/bridge-daemon.ts:158` 已在 Hook、Outbox 和恢复处理之前调用 `notifyStart`；停止流程在关闭入站与 Codex 事件后调用 `notifyStop`。生命周期语义已对齐，且停止顺序更保守。
- `src/ilink/ilink-client.ts:180-234` 已返回 `nextPollTimeoutMs`，但 `src/daemon/bridge-daemon.ts:169-192` 每轮仍未保存该值，也没有把 `timeoutMs` 传入下一次 `getUpdates`。这会造成不必要的客户端超时与连接抖动。
- `src/bridge/sqlite-state.ts:196-247` 把“可接受入站消息”和新游标放在同一个 SQLite 事务中，强于官方普通文件“先保存游标、再处理消息”的崩溃一致性。
- 但 `src/bridge/bridge.ts:133-158` 会在严格过滤后仍提交新游标。如果某条合法消息因为缺 context 或混合 item 被过滤，它不会进入 durable inbox，却已经无法从旧游标重新获取。这是当前真实收消息验证的最高优先级风险。

## 4. 消息结构、context 与 64 位 message_id

### 官方消息模型

官方 `WeixinMessage` 的字段都是可选的，包含 `seq`、`message_id`、收发用户、`client_id`、多个时间戳、`session_id`、`group_id`、消息类型/状态、`item_list`、`context_token` 和 `run_id`，见 [`types.ts` L179-L218](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L179-L218)。

item 支持文本、图片、语音、文件、视频、引用以及工具调用状态，类型常量与字段见 [`types.ts` L64-L85](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L64-L85) 和 [L147-L177](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L147-L177)。

官方解析策略不是“整条必须纯文本”：

- 从 item list 中返回第一段 TEXT，支持引用文本；没有文本时还可使用语音转文字，见 [`inbound.ts` L162-L196](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L162-L196)。
- `context_token` 只有存在时才写入内部上下文，不是接收入站消息的前置条件，见 [`inbound.ts` L220-L240](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L220-L240)。
- Slash command 同样只扫描第一段 TEXT；媒体可独立下载处理，见 [`process-message.ts` L54-L101](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L54-L101) 与 [L113-L145](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L113-L145)。

### 64 位 message_id 边界

固定提交中能确认的第一方事实是：顶层 `message_id` 被 TypeScript 建模为 `number`，见 [`types.ts` L179-L195](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L179-L195)。该提交没有在客户端中把它转换成 `bigint` 或十进制字符串；普通 JavaScript `number` 只能精确表示到 `2^53-1`。

因此，若服务端 proto 的实际字段可覆盖完整 uint64，官方这份 TypeScript 实现本身不能证明大整数是无损的。本文不把仓库中不存在的 proto 声明当作事实补写。

本项目在这一点更稳健：

- `src/ilink/ilink-client.ts:411-465` 使用 JSON reviver 的原始 token source，把超出安全整数范围的十进制 `message_id` 保留成字符串；
- `src/bridge/inbound-message.ts:64-73` 接受非负安全整数或规范十进制字符串，并把上限限制到 `2^64-1`；
- `src/ilink/protocol.ts:78-90` 明确把 wire 类型声明为 `number | string`。

这项差异应保留。它既避免精度碰撞，也不会像“只接受安全整数”那样直接丢弃合法的 64 位 ID。

### 仍存在的本项目差异

- `src/bridge/inbound-message.ts:23-30` 要求消息必须来自唯一控制者、不是群聊、ID 合法且 context 非空。单控制者与群聊拒绝是产品安全策略，应保留；context 必填不是官方协议要求。
- `src/bridge/inbound-message.ts:33-48` 只要出现一个非 TEXT item，就把整条消息视为不支持媒体；官方会先提取可用文本。最小修复应是“不下载媒体，但仍处理第一段文本”，而不是扩大媒体权限。
- 当前忽略分支没有按原因计数。建议只记录聚合计数，如 `other_sender`、`group`、`missing_context`、`invalid_id`、`no_text`，绝不记录 ID、context 或正文，才能判断真实消息究竟停在哪一层。

## 5. sendMessage

### 官方事实

官方文本发送构造如下：

- 生成 client ID；
- `from_user_id` 为空字符串，`to_user_id` 为目标用户；
- `message_type=BOT(2)`、`message_state=FINISH(2)`；
- 文本 item 为 `type=TEXT(1)`；
- `context_token` 与 `run_id` 都是可选字段，缺失时省略。

证据见 [`send.ts` L13-L45](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L13-L45) 与 [L66-L97](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L66-L97)。API 层向 `ilink/bot/sendmessage` POST，并追加 `base_info`，默认超时 15 秒，见 [`api.ts` L502-L520](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L502-L520)。

### 本项目差异

- `src/ilink/ilink-client.ts:295-338` 的端点和消息类型字段已对齐。
- 本项目由 durable Outbox 生成并复用稳定 client ID，且同一进程内对相同 ID 做 single-flight 与负载碰撞检查；这比官方每次调用新生成 ID 更适合不确定送达后的安全重试，应保留。
- 当前 `SendTextInput` 要求 context 字符串，并始终发送 `context_token`。官方允许缺失并省略字段。若放宽无 context 入站，发送层也应同步改为可选字段；需要 context 的回复路由可以 defer，但不能在持久化前丢掉整条入站。

## 6. -14 会话暂停

### 官方事实

- `-14` 被定义为 stale/expired token 错误；会话守卫为每个账号维护一小时的内存暂停窗口，见 [`session-guard.ts` L3-L16](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/session-guard.ts#L3-L16) 与 [L19-L49](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/session-guard.ts#L19-L49)。
- `getUpdates` 的 `ret` 或 `errcode` 为 `-14` 时，monitor 暂停账号并等待剩余时间，而不是走普通快速重试，见 [`monitor.ts` L111-L127](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/monitor/monitor.ts#L111-L127)。
- 常规出站文本和媒体在发请求前也调用同一账号守卫，见 [`channel.ts` L109-L124](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L109-L124) 与 [L231-L240](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L231-L240)。

### 本项目差异

`src/ilink/ilink-client.ts:364-378` 会把 `ret=-14` 或 `errcode=-14` 正确分类为 `auth-expired`，但 `src/windows/host.ts:274-300` 仍使用通用 `1s, 2s, 4s, 8s, 16s, 30s` 退避，并在此后每 30 秒继续请求。

最低修复是按账号在内存中冷却一小时，并阻止 getUpdates、Outbox 与生命周期外的普通 API 重复打服务端。更易理解的产品状态是同时标记“微信登录已失效，需要重新执行 login”；重新登录成功后清除暂停。若把暂停持久化，应明确它比官方的一小时内存守卫更严格。

## 差异与风险排序

| 优先级 | 差异 | 影响 | 建议 |
|---|---|---|---|
| P0/P1 | 缺 context 或混合 item 被过滤，但游标仍提交 | 合法 `/st` 或文本可能永久不可见 | 先 durable 入箱；context 可空；混合 item 提取第一段 TEXT；增加无敏感值原因计数 |
| P1 | `-14` 继续通用重试 | 失效会话每 30 秒请求，形成长期噪声 | 一小时账号暂停，并显示需重新登录 |
| P1 | 服务端长轮询超时未传入下一轮 | 不必要超时和重连 | Daemon 保存并使用 `nextPollTimeoutMs` |
| P1/P2 | 扫码 CLI 无验证码、自动刷新和本地 token 列表 | 重绑流程脆弱 | 按官方状态机补齐，历史 token 最多十个 |
| 已对齐 | POST 鉴权头、`X-WECHAT-UIN`、App 头、`base_info` | 核心请求格式一致 | 保持测试 |
| 已对齐 | notifyStart/notifyStop | 上下线生命周期一致 | 保持“失败警告但不阻断” |
| 优于官方 | SQLite 原子 inbox+cursor | 已接受消息的崩溃恢复更可靠 | 保留，但修复过滤发生在事务前的问题 |
| 优于官方 | 64 位 ID 无损保存、稳定 Outbox client ID | 避免 ID 精度碰撞与重复发送 | 保留 |
| 产品差异 | 单控制者、群聊拒绝、媒体不下载 | 降低权限与攻击面 | 保留；仅从混合消息提取文本 |

## 最小修复顺序

1. 先让解析器返回明确但无敏感值的过滤原因；实机发送一次 `/st`，确认是服务端没有投递，还是被本地 context/item 规则过滤。
2. 允许合法 ID 的控制者单聊先进入 durable inbox，即使 context 缺失；回复时可省略 context 或等待后续可用 context。
3. 对混合 item 提取第一段 TEXT，继续拒绝下载媒体。
4. 在 Daemon 中保存服务端建议的下一轮超时。
5. 对 `-14` 实施一小时账号暂停并暴露“需要重新登录”状态。
6. 最后补扫码验证码、自动刷新和可选历史 token 列表。

以上顺序不要求改变单用户、禁止群聊、默认纯文本和 Desktop/Bridge 并发仲裁等产品安全边界。

## 官方永久链接索引

- [扫码登录：`src/auth/login-qr.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/auth/login-qr.ts)
- [请求头、`base_info` 与 API：`src/api/api.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts)
- [消息与 GetUpdates 类型：`src/api/types.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts)
- [启动与停止调用顺序：`src/channel.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts)
- [长轮询与游标消费：`src/monitor/monitor.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/monitor/monitor.ts)
- [游标持久化：`src/storage/sync-buf.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/storage/sync-buf.ts)
- [`-14` 会话守卫：`src/api/session-guard.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/session-guard.ts)
- [入站解析：`src/messaging/inbound.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts)
- [单条消息处理：`src/messaging/process-message.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts)
- [发送消息结构：`src/messaging/send.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts)
