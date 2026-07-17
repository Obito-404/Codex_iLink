# 微信出站媒体、附件、位置与引用消息：官方实现核对

## 范围

- 第一方基线：腾讯官方 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) `v2.4.6`，固定提交 [`cef0bfc390393f716903e16d50408118047f87e0`](https://github.com/Tencent/openclaw-weixin/commit/cef0bfc390393f716903e16d50408118047f87e0)。版本证据见 [`package.json` L1-L6](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/package.json#L1-L6)。
- 本文描述该固定提交的实际代码，不把 README 中没有落到实现的描述当作协议事实。官方 README 把 CDN 上传写成 `PUT`，实际代码是 `POST`，见 [`README.md` L311-L318](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/README.md#L311-L318) 与 [`cdn-upload.ts` L40-L46](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-upload.ts#L40-L46)。
- `openclaw-weixin` 是 OpenClaw 的微信 Channel；OpenClaw 把结构化回复交给 Channel，微信插件负责 iLink/CDN，不负责解释 Codex Desktop 的 Markdown 渲染语法。

## 结论

用户看到的：

```md
[到账凭证.png](<C:\\Users\\obito_li\\Desktop\\报销\\到账凭证.png>)
```

只是**文本消息中的 Markdown 链接**，不是微信图片。Windows 本地路径只在发送它的那台电脑上有意义；微信客户端既拿不到该文件的字节，也不能访问 `C:\...`，所以点击后空白或无法打开是预期结果。

腾讯官方插件也不会扫描一段 Markdown，把其中的本地路径自动转换成图片或附件。它的两条出站路径是分开的：

1. `text` 作为 `TEXT` item 直接发送；
2. OpenClaw 明确提供结构化 `mediaUrl` 时，插件才读取本地文件或下载 HTTP(S) 内容，上传微信 CDN，再发送 `IMAGE`、`VIDEO` 或 `FILE` item。

证据是 Channel 分别实现文本发送和媒体发送，媒体入口拿到的是独立的 `mediaUrl`，见 [`channel.ts` L109-L124](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L109-L124) 与 [`channel.ts` L231-L282](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L231-L282)；回复投递代码也是按结构化媒体字段选择媒体发送，而不是解析正文中的 Markdown，见 [`process-message.ts` L271-L445](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L271-L445)。

官方发送前确实有一个 Markdown 过滤器，但它只负责把不适合微信文本展示的语法过滤掉，不负责读取或上传链接目标；其中 `![alt](url)` 图片语法会被**整体删除**，见 [`markdown-filter.ts` L1-L24](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/markdown-filter.ts#L1-L24) 与 [`markdown-filter.test.ts` L49-L57](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/markdown-filter.test.ts#L49-L57)。用户示例是普通链接 `[name](path)`，不是 `![alt](url)`，但无论过滤器是否保留其文本，都不会进入媒体上传路径。

因此，若 Codex_iLink 要让微信真正显示图片，正确边界是：Bridge 从**可信、明确、结构化的本地文件引用**取得路径，校验后走微信 CDN 上传；不能把所有 Markdown 链接或自然语言里看起来像路径的字符串都自动读取并上传。

## 1. `sendmessage` 的公共消息外壳

普通文本和媒体最终都调用 `POST ilink/bot/sendmessage`。消息外壳包含：

```text
msg.from_user_id = ""
msg.to_user_id = <微信用户>
msg.client_id = <新生成的 client id>
msg.message_type = BOT (2)
msg.message_state = FINISH (2)
msg.item_list = [<TEXT / IMAGE / VIDEO / FILE item>]
msg.context_token = <可选>
msg.run_id = <可选>
```

文本 item 为 `type=TEXT(1)` 和 `text_item.text`。构造过程见 [`send.ts` L13-L45](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L13-L45)、[`send.ts` L66-L97](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L66-L97)；API 层追加 `base_info` 后 POST，见 [`api.ts` L502-L520](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L502-L520)。

## 2. 图片、视频和文件怎样真正发出去

### 2.1 支持的来源与类型选择

官方 `sendWeixinMediaFile` 接受本地路径；Channel 还接受 HTTP(S) URL，远程内容先下载到 OpenClaw 临时目录，再走同一上传流程，见 [`channel.ts` L231-L282](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L231-L282)。

文件类型按扩展名推导 MIME：

- `image/*` → 微信 `IMAGE`；
- `video/*` → 微信 `VIDEO`；
- 其他一律 → 微信 `FILE`。

见 [`send-media.ts` L8-L25](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send-media.ts#L8-L25) 与 [`send-media.ts` L28-L71](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send-media.ts#L28-L71)。所以 `.wav`、`.mp3` 等在该版本会作为普通文件发送，不是微信语音气泡；虽然上传类型枚举存在 `VOICE=4`，源码没有对应语音发送实现，枚举见 [`types.ts` L24-L30](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L24-L30)。

### 2.2 CDN 上传链路

官方流程不是“把本地路径发给微信”，而是：

1. 读取整个明文文件，计算长度和 MD5；生成随机 16-byte `filekey` 与随机 16-byte AES key，并计算 PKCS#7 后的密文长度，见 [`upload.ts` L60-L82](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/upload.ts#L60-L82)。
2. 调 `getUploadUrl`，请求携带媒体类型、收件人、明文/密文尺寸、MD5、`no_need_thumb: true` 和 hex AES key；当前实现不生成缩略图，见 [`upload.ts` L84-L103](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/upload.ts#L84-L103) 与 [`api.ts` L473-L499](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts#L473-L499)。
3. 优先使用服务端的 `upload_full_url`；否则用 `upload_param + filekey` 组成上传 URL。文件经 AES-128-ECB 加密后，以 `POST application/octet-stream` 上传，见 [`cdn-upload.ts` L14-L35](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-upload.ts#L14-L35) 与 [`cdn-upload.ts` L40-L69](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-upload.ts#L40-L69)。
4. CDN 响应必须带 `x-encrypted-param`。插件把它作为后续下载凭据写进媒体 item 的 `media.encrypt_query_param`；AES key 则以“32 个 ASCII hex 字符的 bytes，再 Base64”写入 `media.aes_key`，并设置 `encrypt_type`，见 [`cdn-upload.ts` L57-L69](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-upload.ts#L57-L69) 与三个 item 构造函数 [`send.ts` L195-L293](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L195-L293)。
5. 最后调用 `sendmessage`：图片 item 写 `mid_size`，视频 item 写 `video_size`，文件 item 写 `file_name` 和明文 `len`，见同一组 [`send.ts` L195-L293](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L195-L293)。

媒体引用的 schema 是：

```ts
type CDNMedia = {
  encrypt_query_param?: string;
  aes_key?: string;       // HTTP JSON 中的 bytes，以 Base64 表示
  encrypt_type?: number;
  full_url?: string;
};
```

见 [`types.ts` L1-L4](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L1-L4) 与 [`types.ts` L91-L99](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L91-L99)。

### 2.3 `media_id`、`download_param` 与 `encrypt_query_param`

在这个固定提交的 iLink schema 和三个出站 item 构造函数中，**没有使用 `media_id`，也没有名为 `download_param` 的出站字段**。实际使用的是：

- 申请上传地址时：`upload_param` / `upload_full_url`；
- CDN 上传成功后：响应 header `x-encrypted-param`；
- `sendmessage` 媒体 item 中：`media.encrypt_query_param`；
- 收件端下载时：优先 `media.full_url`，否则拼成 `/download?encrypted_query_param=...`。

上传 URL 拼装见 [`cdn-url.ts` L5-L20](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-url.ts#L5-L20)，下载 URL 与 `encrypt_query_param` 见 [`pic-decrypt.ts` L58-L79](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/pic-decrypt.ts#L58-L79)，出站 item 见 [`send.ts` L195-L293](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L195-L293)。因此不能把其他微信 SDK/公众号接口中的 `media_id` 格式套到这个 iLink 实现上。

### 2.4 Caption 不是一个原子消息

媒体带说明文字时，官方先发一个独立 TEXT request，再发一个独立媒体 request；并非一个 `item_list` 同时装文字和媒体。任一步失败都会抛错，见 [`send.ts` L141-L192](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L141-L192)。

## 3. Markdown 本地路径为什么不会变成图片

官方实现没有“扫描 `text` 中的 Markdown 链接并读取本地文件”的步骤：

- 文本路径只构造 `TEXT` item，见 [`send.ts` L66-L97](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L66-L97)。
- 媒体路径必须从 OpenClaw 的结构化 `mediaUrl` 进入 Channel，见 [`channel.ts` L231-L282](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts#L231-L282)。
- 只有进入 `sendWeixinMediaFile` 后才会按 MIME 选择图片/视频/文件并上传，见 [`send-media.ts` L28-L71](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send-media.ts#L28-L71)。

这一区分也是必要的安全边界：Markdown 可以包含用户提供的任意文本。若 Bridge 自动读取其中所有 `C:\...`，模型输出一条链接就可能把电脑上的任意文件上传到微信。

对 Codex_iLink 的直接含义：若只把 Codex 最终文本写入 Outbox，`[name](<C:\\path>)` 必然仍是文本。要支持真正媒体，必须先把受限且明确的文件约定提升为结构化出站媒体对象，再进入独立的校验、上传和 Outbox 状态；不能只调整 Markdown 转义。

## 4. 附件、引用与位置能力矩阵

| 能力 | 入站（微信 → Agent） | 出站（Agent → 微信） | 固定提交的实际行为 |
| --- | --- | --- | --- |
| 图片 | 支持 | 支持 | 入站下载/解密后保存本地；出站上传 CDN 后发 `IMAGE` |
| 视频 | 支持 | 支持 | 入站下载/解密；出站上传 CDN 后发 `VIDEO` |
| 普通文件/附件 | 支持 | 支持 | 出站未知 MIME 也按 `FILE`；不是本地路径文本链接 |
| 语音 | 支持下载；有 wire 转写时可直接作为文本 | 不支持语音气泡 | 音频出站落为普通 `FILE` |
| 引用文本 | 支持读取 | 未实现引用式回复 | 引用内容只作为入站上下文 |
| 引用媒体 | 支持有限回退 | 未实现引用式回复 | 主消息没有媒体时才取第一个引用媒体 |
| 位置/附近 | 未实现 | 未实现 | item 枚举/schema 和收发构造都没有 location payload |
| Markdown 本地路径 | 不适用 | 不转换 | 作为普通 `TEXT` 发送 |

### 4.1 入站附件

媒体 item 类型包括 `IMAGE(2)`、`VOICE(3)`、`FILE(4)` 和 `VIDEO(5)`；`ref_msg` 不是独立的 type 常量，而是 `MessageItem` 上可选的引用字段。字段结构见 [`types.ts` L64-L85](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L64-L85)、[`types.ts` L101-L150](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L101-L150) 与 [`types.ts` L163-L177](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L163-L177)。

官方每条消息只交给 Agent 一个媒体：主消息按 `IMAGE > VIDEO > FILE > VOICE` 选择；主消息没有可下载媒体时，才回退到一个引用媒体，见 [`process-message.ts` L113-L148](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L113-L148)。下载后只把本地 `MediaPath` 和 MIME 类型交给 OpenClaw，不暴露带下载凭据的 CDN URL，见 [`inbound.ts` L199-L219](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L199-L219) 与 [`inbound.ts` L242-L256](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L242-L256)。

### 4.2 引用消息

`ref_msg.message_item` 可嵌一个原始 item，见 [`types.ts` L147-L150](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L147-L150)。官方正文解析能读取引用文本或引用语音已有的文字，见 [`inbound.ts` L162-L196](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts#L162-L196)；引用媒体只参与上述回退选择。

出站代码只构造 TEXT、IMAGE、VIDEO、FILE 四类 item，见 [`send.ts` L66-L97](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L66-L97) 与 [`send.ts` L195-L293](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts#L195-L293)，没有构造 `ref_msg`，所以“理解用户引用了什么”是入站能力，“回复时生成微信引用气泡”不是该版本能力。

### 4.3 位置与“附近”

固定提交的 `MessageItemType` 与 `MessageItem` schema 没有位置类型，也没有经纬度、地址、POI 或附近地点字段，见 [`types.ts` L64-L85](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L64-L85) 和 [`types.ts` L163-L177](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts#L163-L177)。入站处理分支只处理文字、图片、语音、文件、视频与引用，见 [`process-message.ts` L54-L156](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts#L54-L156)；出站同样只有上述四类构造。

所以该官方固定版本不能作为“微信位置/附近”实现依据。若真实 iLink wire 投递未知位置 item，它在此版本没有可用 payload schema 和 handler；若要新增，必须先通过一手 wire 样本或后续官方源码确认，而不能猜字段。

## 5. WeClaw 为什么看起来能“从回答里发附件”

WeClaw `v0.7.1` 的固定提交 [`b48cc9737319d77724d3f65f1ce4cd4d1370a1f6`](https://github.com/fastclaw-ai/weclaw/commit/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6) 在 Agent 最终文本之后额外做了一层约定解析：

- 从 Markdown **图片**语法中提取 URL，再交给媒体发送路径，见 [`messaging/handler.go` L491-L537](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/messaging/handler.go#L491-L537)。
- 识别“独占一行的绝对本地路径”，且只允许默认 workspace 或 Agent cwd 下的文件，把它当普通附件；解析和根目录限制见 [`messaging/attachment.go` L10-L74](https://github.com/fastclaw-ai/weclaw/blob/b48cc9737319d77724d3f65f1ce4cd4d1370a1f6/messaging/attachment.go#L10-L74)。

这不是腾讯 Channel 的协议行为，而是 WeClaw 在 Agent 输出文本之上自定义的约定。用户示例 `[到账凭证.png](<C:\\...>)` 是普通 Markdown 文件链接，不是图片语法，也不是独占一行的裸绝对路径，因此不符合 WeClaw 这条附件识别规则。

WeClaw 的方式说明“文本约定也能做”，但它仍必须把解析出的本地文件真正上传，绝不是把本地路径链接直接交给微信。对 Codex_iLink 来说，更稳妥的是结构化附件对象；若将来为了易用性兼容文本约定，也至少应像 WeClaw 一样限定根目录和格式，不能匹配任意 Markdown 链接。

## 6. Codex_iLink 本轮落地边界

1. Bridge 只把 Codex 最终回复中**独占一行**的标准本地文件链接 `[名称](<C:\...>)` / `![名称](<C:\...>)` 提升为结构化附件对象；普通自然语言路径、HTTP URL 和行内链接仍是文本。
2. 提交 Outbox 前要求 Windows 绝对路径、当时存在的普通文件和不超过 100 MiB；单次最多两个附件。这个约定用于适配 Codex Desktop 的本地文件输出格式，不是腾讯协议本身。
3. Outbox 先持久化本地附件对象；CDN 上传成功后，在发送前原子替换为固定 `encrypt_query_param + AES key + kind + name + size`，从而让结果未知的 `sendmessage` 使用同一 `client_id` 和同一媒体 item 重试。
4. 上传只接受 HTTPS 微信 CDN 白名单主机且禁止重定向；实际 wire 和加密格式按官方固定提交实现。
5. 媒体先于说明文字发送；上传或媒体发送未确认时，同组后续文字不会先发，避免“已发给你”成为假成功。
6. 首期支持图片、视频和普通文件；音频作为普通文件。语音气泡、位置/附近和出站引用没有官方 schema，未实现。

## 永久链接索引

- [消息 schema：`src/api/types.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts)
- [上传 URL API：`src/api/api.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/api.ts)
- [CDN URL 拼装：`src/cdn/cdn-url.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-url.ts)
- [CDN 上传：`src/cdn/cdn-upload.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/cdn-upload.ts)
- [上传准备：`src/cdn/upload.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/upload.ts)
- [媒体类型选择：`src/messaging/send-media.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send-media.ts)
- [媒体 item 与消息发送：`src/messaging/send.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts)
- [Channel 出站接口：`src/channel.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/channel.ts)
- [入站解析：`src/messaging/inbound.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts)
- [单条消息处理与回复投递：`src/messaging/process-message.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts)
