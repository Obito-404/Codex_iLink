# Tencent/openclaw-weixin 媒体能力源码研究

## 研究范围与结论

- 第一方来源：腾讯官方仓库 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)。
- 固定快照：`main` 的 [`cef0bfc390393f716903e16d50408118047f87e0`](https://github.com/Tencent/openclaw-weixin/commit/cef0bfc390393f716903e16d50408118047f87e0)，tag `v2.4.6`；author date 为 `2026-06-25T14:50:12+08:00`，commit date 为 `2026-06-25T14:54:56+08:00`。包名和版本也见 [`package.json` L1-L6](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/package.json#L1-L6)。
- 本文只把该固定提交的源码视为“当前实际实现”。README 有两处已经落后于源码：它把上传写成 `PUT`，而实现使用 `POST`；它只列出上传类型 1/2/3，而源码还定义了 `VOICE=4`。证据分别见 [`README.md` L311-L318](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/README.md#L311-L318)、[`cdn-upload.ts` L40-L46](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-upload.ts#L40-L46)、[`types.ts` L24-L30](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L24-L30)。

结论：官方插件已经支持微信入站图片、语音、文件和视频的下载、AES 解密及交给 OpenClaw；出站实际支持图片、视频和普通文件。它没有实现“发微信语音气泡”：音频扩展名会落入普通文件路径。语音的 `text` 是 wire 字段，插件自身不调用语音识别服务；没有该字段时，它只把 SILK 转成 WAV（失败则保留 SILK）并交给 OpenClaw。

## 1. 入站 wire schema

API 是 HTTP JSON，proto 的 bytes 字段在 JSON 中表示为 base64 字符串，见 [`types.ts` L1-L4](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L1-L4)。`WeixinMessage.item_list` 是 `MessageItem[]`；媒体 type 为：

| type | 类型 | payload 字段 |
| --- | --- | --- |
| 2 | IMAGE | `image_item` |
| 3 | VOICE | `voice_item` |
| 4 | FILE | `file_item` |
| 5 | VIDEO | `video_item` |

常量和 `MessageItem` 联合结构见 [`types.ts` L64-L79](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L64-L79)、[`types.ts` L163-L177](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L163-L177)。完整消息还带 `message_id`、`from_user_id`、`session_id`、`group_id`、`context_token` 和 `run_id` 等字段，见 [`types.ts` L179-L196](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L179-L196)。

所有媒体通过 `CDNMedia` 引用内容：

```ts
type CDNMedia = {
  encrypt_query_param?: string;
  aes_key?: string;       // JSON 中为 base64
  encrypt_type?: number;  // 0 或 1
  full_url?: string;
};
```

定义见 [`types.ts` L91-L99](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L91-L99)。各媒体结构如下：

- 图片：`media`、`thumb_media`、优先用于入站解密的 32 位 hex `aeskey`、`url`、中图/缩略图/高清图大小和缩略图尺寸，见 [`types.ts` L101-L114](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L101-L114)。
- 语音：`media`、`encode_type`、`bits_per_sample`、`sample_rate`、`playtime`、转文字字段 `text`。编码枚举注释包含 SILK、MP3、PCM 等，见 [`types.ts` L116-L127](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L116-L127)。
- 文件：`media`、`file_name`、`md5`、字符串形式的 `len`，见 [`types.ts` L129-L134](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L129-L134)。
- 视频：`media`、`video_size`、`play_length`、`video_md5`、`thumb_media`、缩略图大小和尺寸，见 [`types.ts` L136-L145](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L136-L145)。
- 引用消息可在 `ref_msg.message_item` 中再携带一个媒体 item，见 [`types.ts` L147-L150](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L147-L150)。

## 2. CDN 下载、AES 和鉴权

### API 鉴权与 CDN URL

iLink API 请求使用 `AuthorizationType: ilink_bot_token`、随机 `X-WECHAT-UIN`，有 token 时再带 `Authorization: Bearer <token>`；日志会掩码 Bearer token，见 [`api.ts` L221-L253](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L221-L253)。`context_token` 不是 CDN header，而是收消息后回复时回传的会话字段。

CDN fetch 本身没有附加 Bearer header；授权信息位于服务端给出的 `full_url` 或 `encrypt_query_param` 中。下载优先使用 `full_url`，没有时回退为：

```text
{cdnBaseUrl}/download?encrypted_query_param={encodeURIComponent(param)}
```

上传回退 URL 为：

```text
{cdnBaseUrl}/upload?encrypted_query_param={encodeURIComponent(param)}&filekey={encodeURIComponent(filekey)}
```

见 [`cdn-url.ts` L5-L20](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-url.ts#L5-L20) 和 [`pic-decrypt.ts` L58-L79](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/pic-decrypt.ts#L58-L79)。

### AES 格式

- 算法是 AES-128-ECB，Node 默认 PKCS#7 padding；密文长度按 `ceil((plaintext + 1) / 16) * 16` 计算，见 [`aes-ecb.ts` L1-L20](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/aes-ecb.ts#L1-L20)。
- 入站 `aes_key` 存在两种 wire 编码：`base64(raw 16 bytes)`，或 `base64(32 个 ASCII hex 字符)`。`parseAesKey` 只接受这两种格式，见 [`pic-decrypt.ts` L30-L52](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/pic-decrypt.ts#L30-L52)。
- 图片优先使用 `image_item.aeskey`（hex）并转换成 base64；否则用 `media.aes_key`。图片没有 key 时允许按明文 CDN 内容保存，见 [`media-download.ts` L40-L65](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L40-L65)。
- 语音、文件和视频要求 `media.aes_key`；缺 key 时官方实现直接返回，不下载，见 [`media-download.ts` L71-L82](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L71-L82)、[L100-L111](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L100-L111)、[L127-L138](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L127-L138)。

### 文件名、MIME 和大小

- 文件 MIME 只按 `file_name` 扩展名映射，未知扩展名为 `application/octet-stream`；没有读取 magic bytes，见 [`mime.ts` L3-L30](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/mime.ts#L3-L30)、[`mime.ts` L55-L59](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/mime.ts#L55-L59)。
- 入站文件把 wire `file_name` 原样交给 OpenClaw 的 `saveMediaBuffer(..., originalFilename)`；插件仓库内没有进一步的文件名净化实现，因此不能从本仓库断言宿主最终如何净化，见 [`media-download.ts` L112-L122](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L112-L122)。
- 官方向 `saveMediaBuffer` 传入的上限是 100 MiB，适用于四类入站媒体，见 [`media-download.ts` L12-L21](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L12-L21) 和各保存调用 [L64-L65](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L64-L65)、[L84-L94](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L84-L94)、[L112-L119](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L112-L119)、[L132-L140](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L132-L140)。
- 但下载函数先执行 `res.arrayBuffer()`，再把完整内容变成 `Buffer`，之后才调用带上限的保存函数。也就是说，该 100 MiB 不是下载阶段的流式硬上限，不能防止超大响应先占满内存，见 [`pic-decrypt.ts` L8-L28](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/pic-decrypt.ts#L8-L28)。
- 入站没有用 `len`、`video_size`、`md5` 或 `video_md5` 校验实际明文。出站会计算 MD5 和尺寸用于申请上传 URL，但不是入站完整性校验。

## 3. 语音是否转写

官方插件没有本地/云端 ASR 调用：

1. 如果 `voice_item.text` 非空，`bodyFromItemList` 直接把它当消息正文；`processOneMessage` 还会因此跳过该语音的下载，见 [`inbound.ts` L172-L196](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L172-L196) 和 [`process-message.ts` L127-L134](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L127-L134)。源码没有说明这个文本由微信哪项服务生成，只能确认它来自入站 wire。
2. 没有 `text` 时，插件下载并解密语音，尝试用 `silk-wasm.decode` 按 24 kHz、单声道、16-bit PCM 转 WAV。这只是转码，不是语音识别，见 [`silk-transcode.ts` L3-L10](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/silk-transcode.ts#L3-L10)、[L50-L73](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/silk-transcode.ts#L50-L73)。
3. 解码不可用或失败时保存原始 `audio/silk`，见 [`media-download.ts` L83-L99](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L83-L99)。值得注意的是 `silk-wasm` 在该提交的 `package.json` 中是 `devDependency`，不是运行时 dependency；源码本身已经把动态导入失败视为正常回退，见 [`package.json` L30-L42](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/package.json#L30-L42)。

## 4. 媒体如何交给 OpenClaw agent

`processOneMessage` 的实际流程是：

1. 在主 `item_list` 里只选一个媒体，固定优先级 `IMAGE > VIDEO > FILE > VOICE`；有文本转写的语音不参与下载。如果主消息没有媒体，再找一个引用媒体，见 [`process-message.ts` L113-L148](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L113-L148)。这意味着多图或多附件不会全部交给 agent。
2. 调用 `downloadMediaFromItem`，通过 OpenClaw 注入的 `channelRuntime.media.saveMediaBuffer` 保存解密后的内容，见 [`process-message.ts` L149-L156](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L149-L156)。
3. `weixinMessageToMsgContext` 只设置本地 `MediaPath` 和 `MediaType`，从不把带鉴权信息的 CDN URL 作为 `MediaUrl` 交给 agent。图片为 `image/*`、视频固定 `video/mp4`、文件为扩展名推导的 MIME、语音为 `audio/wav` 或 `audio/silk`，见 [`inbound.ts` L199-L219](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L199-L219)、[L242-L256](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L242-L256)。
4. 上下文经 `finalizeInboundContext`、`recordInboundSession` 后送进 `dispatchReplyFromConfig`，见 [`process-message.ts` L219-L269](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L219-L269)、[L449-L465](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L449-L465)。Channel 声明 `media: true`，见 [`channel.ts` L179-L183](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L179-L183)。

这是 OpenClaw 专有的 `MsgContext + MediaPath` 宿主契约，不是 iLink wire 协议本身。

## 5. 出站媒体上传和发送

### 当前实现支持范围

`sendWeixinMediaFile` 根据本地文件扩展名推导 MIME：`video/*` 走视频，`image/*` 走图片，其余全部走文件，见 [`send-media.ts` L8-L25](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send-media.ts#L8-L25)、[L28-L71](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send-media.ts#L28-L71)。因此 `.wav`、`.mp3`、`.ogg` 目前被发送为 `FILE`，不是 `VOICE`。虽然协议常量有 `UploadMediaType.VOICE=4`，仓库里没有 `uploadVoice...` 或 `sendVoice...` 实现。

它接受本地路径或 HTTP(S) URL；远程内容先完整下载到 OpenClaw 临时目录，再进入相同上传流程，见 [`channel.ts` L231-L282](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L231-L282)。

### 上传流程

1. 整个文件读入内存，计算明文长度与 MD5；生成随机 16-byte `filekey` 和随机 16-byte AES key，并计算 PKCS#7 后的密文长度，见 [`upload.ts` L60-L82](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/upload.ts#L60-L82)。
2. 带 `media_type`、收件人、明文/密文尺寸、MD5、`no_need_thumb: true` 和 hex AES key 调 `getUploadUrl`，见 [`upload.ts` L84-L103](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/upload.ts#L84-L103)、[`api.ts` L473-L499](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L473-L499)。当前实现不生成或上传缩略图。
3. `upload_full_url` 优先，否则用 `upload_param + filekey` 拼 URL；AES-128-ECB 加密后，以 `POST application/octet-stream` 上传，成功必须从响应 header `x-encrypted-param` 取得之后下载用的参数，见 [`cdn-upload.ts` L14-L35](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-upload.ts#L14-L35)、[L40-L69](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-upload.ts#L40-L69)。
4. 把 `x-encrypted-param`、base64 编码的 32 个 ASCII hex key 和大小组成媒体 item，再调用 `sendmessage`：图片写 `mid_size`，视频写 `video_size`，文件写 `file_name` 和明文 `len`，见 [`send.ts` L195-L230](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L195-L230)、[L233-L261](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L233-L261)、[L264-L293](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L264-L293)。
5. caption 和媒体不是一个原子消息：有 caption 时先单独发送一个 TEXT request，再单独发送媒体 request；任一步失败会抛错，见 [`send.ts` L141-L192](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L141-L192)。

## 6. 错误、清理和安全策略

### 已实现

- 常规 iLink API 默认 15 秒超时，见 [`api.ts` L210-L215](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L210-L215)。
- CDN 上传最多 3 次：4xx 立即终止，网络/服务端错误可重试；上传 URL 日志使用 `redactUrl` 去掉 query，见 [`cdn-upload.ts` L6-L13](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-upload.ts#L6-L13)、[L47-L90](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-upload.ts#L47-L90)。
- 任意远程出站媒体 URL 的下载日志也会去掉 query，见 [`upload.ts` L31-L47](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/upload.ts#L31-L47)。
- OpenClaw agent 回复路径会把“远程下载失败”“CDN 上传失败”和其他发送失败映射成不同微信提示，见 [`process-message.ts` L410-L445](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L410-L445)。
- 入站媒体下载/解密失败被各分支捕获并记录，不会炸掉媒体函数，见 [`media-download.ts` L67-L70](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L67-L70)、[L96-L99](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L96-L99)、[L123-L145](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts#L123-L145)。代价是调用方拿到空媒体上下文，仍可能继续向 agent 分发空正文，并没有给用户明确的入站媒体错误。

### 不能原样照搬的风险

1. **无下载阶段硬限额、无 CDN 超时。** 入站 CDN、任意远程出站媒体及上传都用整块 Buffer；CDN fetch 没有 AbortSignal/timeout。100 MiB 只传给保存层，出站没有显式大小上限。证据见 [`pic-decrypt.ts` L8-L28](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/pic-decrypt.ts#L8-L28)、[`upload.ts` L31-L57](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/upload.ts#L31-L57)、[`upload.ts` L71-L76](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/upload.ts#L71-L76)。
2. **没有内容真实性校验。** 入站不校验声明的尺寸或 MD5；AES-ECB 也不提供认证标签。应把协议要求的 AES-ECB 仅视为传输兼容层，下载后仍需做长度、类型和策略校验。
3. **MIME 和文件名信任过多。** MIME 只看扩展名；wire `file_name` 未在插件层净化。Codex_iLink 不应直接把原名用于磁盘路径。
4. **URL/秘密日志存在不一致。** 通用 `redactUrl` 会剥离 query，见 [`redact.ts` L42-L53](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/util/redact.ts#L42-L53)；但入站 `pic-decrypt.ts` 会记录完整 CDN URL、错误响应 body，非法 key 时甚至把输入 key 放进错误字符串，见 [`pic-decrypt.ts` L8-L25](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/pic-decrypt.ts#L8-L25)、[L40-L51](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/pic-decrypt.ts#L40-L51)、[L74-L79](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/pic-decrypt.ts#L74-L79)。这些日志不可复制。
5. **任意 URL 获取。** `full_url` 和 agent 提供的 HTTP(S) URL 直接交给 `fetch`，没有 scheme 之外的主机/IP allowlist，也没有重定向后复检；在 Codex_iLink 中需要阻止 loopback、内网、link-local 等 SSRF 目标。
6. **临时文件生命周期未闭环。** 远程出站媒体写到 `weixin/media/outbound-temp`，发送路径没有 `finally unlink`；入站文件交由 OpenClaw media store，其清理周期不在本插件仓库中，见 [`channel.ts` L47-L54](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L47-L54)、[L258-L282](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L258-L282)。
7. **多媒体被静默丢弃。** 固定只取一个 item，不适合微信一次发多图/多附件的完整语义。

## 7. Codex_iLink 的最小可复用设计

可复用的是协议与 CDN 算法，不是 OpenClaw 的宿主适配层：

1. 扩展 iLink wire types，保留官方 `CDNMedia` 和四种 item 的字段；解析时允许 TEXT 与媒体共存，不再把整条消息判定为 `unsupportedMedia`。
2. 新建独立 `media` 边界：`resolve URL -> 有界下载 -> key 规范化 -> AES-128-ECB 解密 -> 类型/大小校验 -> 以随机名落盘`。不要让 Bridge/命令解析层直接接触 CDN query、AES key 或原始文件名。
3. 首版入站优先顺序建议：
   - 图片：下载后作为 Codex `turn/start` 的本地图片输入；文本仍作为同一回合的 text input。
   - 语音：优先使用官方 wire 的 `voice_item.text`。没有 text 时，SILK→WAV 只能完成转码；要真正得到文字必须另选明确的 ASR 服务/模型，不能声称官方代码已经提供转写。
   - 文件：保存到受控临时目录，把“原名、MIME、大小、受控本地路径”作为结构化上下文交给 Codex。是否可读取取决于该任务的权限/沙箱，必须在实现时验证。
   - 视频：先作为受控文件处理；当前普通 Codex turn 输入不能因为 OpenClaw 支持 `MediaPath` 就自动等价为原生视频附件。
4. 每个 item 独立记录成功/失败，保留原顺序并支持多个媒体；任一失败都要在微信明确说明类型和可重试性，不能静默降级为空消息。
5. 落地文件必须使用 Bridge 生成的随机名；原 `file_name` 只作显示元数据。设置下载前 `Content-Length` 检查、流式累计上限、超时、重定向次数/目标复检、CDN host allowlist，解密后再校验真实长度和允许类型。
6. 文件生命周期绑定到“回合终态 + 短暂保留窗口”，在 `finally` 和启动时垃圾回收；数据库只存路径/摘要/状态，不存媒体正文、AES key 或 CDN 鉴权 URL。
7. 出站仅在 Bridge 得到**明确且可信的本地文件路径**时复用官方 `getUploadUrl -> AES 加密 POST -> x-encrypted-param -> sendmessage`。不要从 Codex 自然语言中猜路径或自动抓任意 URL。首版可支持图片/视频/文件；真实语音气泡需另行确认 `VOICE` 的发送 item wire，官方当前代码不能作为实现依据。

## 8. 明确无法照搬之处

- `channelRuntime.media.saveMediaBuffer`、`MsgContext.MediaPath/MediaType`、`finalizeInboundContext` 和 `dispatchReplyFromConfig` 都是 OpenClaw SDK 契约；Codex App Server 没有这些接口。
- OpenClaw 把 WAV/SILK 文件交给具备媒体能力的宿主，并不等于 Codex 普通 `turn/start` 原生支持音频、视频或任意文件。
- 官方的“语音转文字”只是读取 wire `voice_item.text`；SILK 转 WAV不是 ASR。
- 官方只取一个媒体、吞掉入站下载错误、整块缓冲、缺少清理和严格校验的做法不应复制。
- 官方尚无真实出站 VOICE 实现；`UploadMediaType.VOICE=4` 只是类型常量，不能单凭它推导完整发送 schema。
