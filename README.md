# Codex iLink

把微信作为 Windows 本机 Codex 的另一个入口。微信和 Codex Desktop 访问同一份持久化任务历史；Bridge 只负责传输、路由、并发仲裁和可靠送达，不复制对话，也不创建第二个 Agent 身份。

> 当前为可运行的开发版。新版 Hook、Codex/App Server 与 Desktop 同任务可见性、真实微信扫码绑定及双向文本收发已验证；微信入站媒体与 Codex 回复中的本地附件出站链路已实现，仍需完成真实微信媒体、离开状态主动推送和长期后台运行的最终验收。

## 已实现

- 单一微信控制者、单聊文本，以及受控的入站图片、语音转写、文件和视频
- `p` 按 Desktop 当前保存顺序只显示项目名，`s` 浏览任务，`s<n>` 进入任务
- `new` 新建任务，`exit` 返回微信主任务，`st` 查看状态，`perm` 查看或切换当前任务的 Codex 原生权限 Profile
- App Server 可按 `thread_id` 恢复任务，持久化的继续记录可由 Desktop 任务记录读取
- 30 分钟滑动任务绑定；项目或任务列表显示后，其编号映射固定 10 分钟
- 同一 `thread_id` 的 Desktop/Bridge SQLite 原子租约；Bridge 停止时 Hook 仍以 fail-open 方式记录在途 Desktop 回合，关闭启动并发窗
- iLink 游标、去重、FIFO、Dispatch Intent、Outbox 持久化
- Bridge App Server 单次 `ok`、`no` 审批；多个待审批时使用不可复用的随机短码，通知网络失败时使用同一短码退避重试，请求失效或 30 分钟超时才自动拒绝
- DPAPI CurrentUser 加密 iLink Token
- Named Pipe Hook 与 7 天/5MB 有界 Spool，启动及运行期持续恢复
- 离开电脑后的 Desktop 最后一轮摘要与最终回答通知、延迟离开复查，以及送达后 30 分钟回复路由
- 活动任务期间保持系统唤醒，任务结束后恢复原电源行为
- 微信最终回复每条最多 2000 UTF-8 字节、最多 3 条，超长时截断并提示到 Desktop 查看
- Codex 网络或上游请求失败时向微信返回脱敏错误及可用的 HTTP 状态；失败前的部分文本不会伪装成成功回复
- Windows 前台 Host、单实例控制管道、串行长轮询和优雅停止
- 官方 iLink `notifyStart/notifyStop` 生命周期，以及 64 位 `message_id` 的无损解析和稳定去重
- 微信回合确认开始后发送“正在输入”状态并每 5 秒续期；排队期间不显示，最后一个活动微信回合结束或 Bridge 关闭时取消
- 微信入站图片下载、解密并持久化后作为 Codex `localImage` 输入；文件和视频同时作为本地 `mention` 与明确的本机路径上下文输入，避免附件静默变成空回合
- iLink 新建任务注册显式 `send_file(path)` 工具；登记的本机文件会经微信 CDN 加密上传，作为图片、视频或普通附件发送
- 语音优先使用微信 wire 中的 `voice_item.text` 作为文本；没有转写时明确拒绝，不把 SILK 转 WAV 冒充语音识别

## 安装与启动

要求：Windows、Node.js 24+、pnpm 11.7、已登录的 Codex Desktop。

```powershell
pnpm install --frozen-lockfile
codex plugin add codex-ilink-probe@personal
pnpm ilink doctor
pnpm ilink login
pnpm ilink start
```

插件安装或版本变化后，请在 Codex Desktop 审核并信任 Hooks。信任页显示内部 ID `codex-ilink-probe`，插件显示名为 `Codex iLink Guard`，二者是同一个插件。Bridge 运行时，只对微信主任务、微信当前进入的任务以及仍有微信排队/执行工作的任务启用 fail-closed 租约。当前微信所选项目中的其他任务只留下最小活动 turn 观察，用于稍后通过 `s<n>` 进入时避免双写；其他 Desktop 项目始终放行且不记录活动观察，即使状态库正被瞬时写锁占用也不会停止或写入这些项目。所有经 App Server 确认为 `source=vscode` 的 Desktop 项目 Stop 完成事件仍通过独立的 fail-open 生命周期通道上报，仅用于用户锁屏或空闲时的完成通知；CLI 任务不会推送。项目选择、并发门禁和系统保活不受影响。活动观察无法直接入库时先写入本机 Spool，Bridge 会在每条同批微信消息执行前恢复它。观察不会显示为微信活动任务、不会触发系统保活，也不会成为门禁；精确 Stop 后保留 7 天最小 tombstone，防止迟到的重复 Prompt 重新制造永久 `Queued`。

关闭插件后，微信仍可通过 App Server 执行任务，但 Desktop 回合不再参与租约、Desktop 生命周期通知也会丢失；此时如果 Desktop 与微信同时写同一个共享任务，可能发生并发错组。因此仅在排障或确认不会双端同时操作时临时关闭，并且必须在关闭前确认没有正在运行的 Desktop 回合。若在 Desktop 回合中途关闭，精确 `Stop` 会丢失，已有消息会保守保持 `Queued`，不能仅凭独立 App Server 的 `interrupted` 状态自动解锁。

扫码成功后可使用：

```powershell
pnpm ilink status
pnpm ilink stop
```

`start` 在当前用户会话中后台运行并写入 `%LOCALAPPDATA%\Codex_iLink\logs\bridge.log`。当前版本尚未自动注册 Windows 登录启动任务。

## 微信命令

```text
p               projects
p<n>            select project
s               sessions
s<n>            enter session
s+              next page
sarc            archived sessions
new             new session
clear           start a fresh session with empty context
compact         compact the current session context
stop            interrupt the current WeChat turn
exit            return to main
st              status
perm            list current Codex permission profiles
perm<n>         select a Codex permission profile
ok | no         decide the only pending approval
ok<code>        approve one of multiple pending requests
no<code>        deny one of multiple pending requests
help            commands
```

`p<n>`、`s<n>` 可以直接使用；没有有效列表快照时，Bridge 会按当前项目列表或当前项目未归档任务第一页解释编号。执行 `p`、`s`、`s+` 或 `sarc` 后，刚显示的编号从该列表或页面生成时起固定 10 分钟；进入任务后使用的是另一套 30 分钟滑动绑定。命令不使用 `/` 或空格；旧斜杠形式会明确返回未知命令。

`stop` 只中断当前会话里由微信 Bridge 发起且已取得 Turn ID 的活动回合，不停止后台 Bridge，也不回滚已经完成的文件修改；Desktop 发起的回合仍需回到电脑端停止。`clear` 仅在当前会话没有执行中或排队任务时创建并绑定一个全新会话；项目会话的原历史可通过 `s` 找回，微信主会话则可通过 `exit` 返回。`compact` 通过 Codex 原生 `thread/compact/start` 压缩当前会话上下文，并在压缩完成前持有同一会话租约；期间收到的新消息会排队。

微信不能切换模型或 reasoning effort。`perm` 通过 Codex 原生 `permissionProfile/list` 展示当前项目实际允许的 Profile；`perm<n>` 对已加载任务使用 `thread/settings/update.permissions`，首次加载或重连时使用 `thread/resume.permissions`。Bridge 只保存任务 ID 到原生 Profile ID 的映射，以便自身重连后重新桥接，不自建 Sandbox 或审批规则，也不修改 Desktop 全局设置、其他任务或已经开始的回合。微信主任务首次创建时采用当时 Codex 运行时的默认配置；之后 `exit` 只返回这个持久化任务，不会重建或改写其模型。`new` 只显式传入所选项目的 `cwd`，采用创建时的 Codex 运行时默认配置，不读取该项目其他任务或 Desktop 最近选择的模型；`s<n>` 恢复目标旧任务及 Bridge 已为该任务选择的原生权限 Profile。Desktop 回合的审批仍只能在 Desktop 完成；控制者离开电脑时，同一 Desktop 回合最多向微信提醒一次，微信只处理 Bridge 自己发起且仍在线等待的单次审批。

Bridge 启动 App Server 时只声明 Codex 权限 Profile API 所要求的 `experimentalApi` 客户端能力，不覆盖 Codex 的功能开关、模型、插件配置，也不实现权限判定；微信回合使用 Codex 原生 Profile 解析出的 Sandbox 和审批策略。仅由 Desktop UI 宿主提供的能力在后台 App Server 中仍可能不可用。状态读取超时只结束本次读取，不会杀掉仍在执行任务的 App Server；回合超过约 2 分钟仍未结束时，微信只收到一次“仍在执行”提示，任务不会因此被自动取消或重试，控制者可显式发送 `stop`。

## 媒体能力与边界

媒体协议、加解密与上传行为参照腾讯官方 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) `v2.4.6` 的固定提交 [`cef0bfc390393f716903e16d50408118047f87e0`](https://github.com/Tencent/openclaw-weixin/commit/cef0bfc390393f716903e16d50408118047f87e0)，不是跟随远端 `main` 漂移：

- 图片保存到 `%LOCALAPPDATA%\Codex_iLink\media\inbound` 后，通过 Codex App Server 的 `localImage` 输入提交。
- 文件和视频通过本地 `mention` 提交，并同时加入明确的本机路径上下文，使 Codex 即使未展开 `mention` 也能识别并按需读取附件。路径读取仍受目标任务的 Sandbox 和审批策略约束，也不承诺任意附件格式都能解析。
- 与官方固定版本一致，每条微信消息只选择一个媒体：主消息在带 CDN 下载引用的媒体中按 `图片 > 视频 > 文件 > 无转写语音` 选择，主消息没有可下载媒体时才回退到引用媒体；不会把同一条消息里的多个附件全部提交。
- 语音有 `voice_item.text` 时按微信提供的转写文本提交，引用语音的已有转写也会保留为引用上下文；没有转写时明确回复暂不支持。官方项目的 SILK → WAV 仅是音频转码，不是 ASR，不能产生文字。
- 每个媒体文件最多 100 MiB；只接受 HTTPS 微信 CDN 白名单地址。加密媒体按官方格式使用 AES-128-ECB + PKCS#7 解密，图片也兼容官方允许的明文载荷。
- 下载、URL/大小/密钥/路径校验、解密或落盘失败时，微信会收到明确错误且不会提交空回合；若已排队的本地媒体后来被外部删除，Codex 的确定性拒绝也会明确返回微信，不会误报成“结果未知”。当前不宣称校验 wire MD5 或真实文件类型。
- iLink 新建任务通过 App Server `dynamicTools` 获得显式 `send_file(path)`；`developerInstructions` 要求模型优先调用工具。Bridge 只接受当前实例持有的微信回合，将附件意图持久化，并在成功终态与最终正文原子写入 Outbox。旧任务无法在 `thread/resume` 时补装动态工具，因此继续兼容**独占一行**的标准 Markdown 本地文件链接 `[名称](<C:\...>)` 或 `![名称](<C:\...>)`。正文普通路径、HTTP 链接、链接后的普通文字和其他非独占行链接不会触发文件读取。两种来源按 Windows 路径去重，每个文件在登记和最终提交时都必须是存在的绝对普通文件且不超过 100 MiB；单次最多发送 2 个附件。
- 出站链路按官方格式执行 `getuploadurl → AES-128-ECB 加密 → HTTPS CDN POST → x-encrypted-param → IMAGE/VIDEO/FILE sendmessage`。图片和视频按扩展名分类，其他格式（包括音频）作为普通文件；媒体在说明文字之前发送，避免上传失败时先出现“已发给你”的假成功文本。
- 官方固定版本没有语音气泡发送、位置/附近或出站引用消息 schema，本项目也不猜造这些能力。

## 数据与安全边界

- 状态目录：`%LOCALAPPDATA%\Codex_iLink`
- 对话事实源：Codex 持久化任务；SQLite 不保存完整 Transcript
- 文本和附件路径使用版本化 payload 穿过入站、队列和 Dispatch Intent；SQLite 不保存媒体二进制。出站媒体上传成功后，Outbox 会短暂保存 CDN 加密引用和 AES key，以便用同一 `client_id` 稳定重试；微信确认接收后立即清除正文
- 入站媒体二进制只落在 `%LOCALAPPDATA%\Codex_iLink\media\inbound`，至少保留到对应回合终态或状态未知完成对账，再安全清理
- 入站/出站正文在明确接受或确认发送后清除
- Token 仅以 Windows 当前用户 DPAPI 密文保存
- 其他微信用户和群消息静默忽略，其文本和媒体均不下载、不执行
- Bridge 未运行时，Hook 只记录在途回合而不阻止普通 Codex；若 Bridge 异常退出且仲裁仍处于安全关闭状态，冲突任务会被保守阻止
- `p` 只读 `%USERPROFILE%\.codex\.codex-global-state.json` 的已保存工作区及排序字段；解析失败时关闭项目列表，不回退为全部历史任务目录

如异常退出后 Desktop 提示 `CODEX_ILINK_THREAD_BUSY`，先确认 Bridge 已停止且 Desktop 没有活动回合；必要时再临时禁用 `Codex iLink Guard`，不要直接删除整个 SQLite 状态库。

若 `st` 长时间显示“微信任务（租约活动）”并持续出现 `Queued`，表示持有该回合的 Bridge App Server 仍报告任务活动；独立 App Server 对同一回合显示的 `notLoaded` 或 `interrupted` 不能证明它已经结束。Bridge 不会据此自动解锁或重试，以免同一任务被并发写入。可先在微信当前会话发送 `stop`；若停止结果未知且确认回合确实卡住，再使用 `pnpm ilink stop` 后执行 `pnpm ilink start`，由新持有进程完成中断对账。前者停止当前微信回合，后者停止整个后台 Bridge；已排队消息默认保留并继续执行。

## 开发验证

```powershell
pnpm typecheck
pnpm test
```

`pnpm probe:lease` 和 `pnpm probe:resume` 是开发探针，会创建真实 Codex 任务并产生模型用量，不属于普通安装流程。

详细设计与已验证事实见 [SPEC.md](./SPEC.md) 和 [docs/feasibility.md](./docs/feasibility.md)；官方媒体实现的固定源码核对见 [docs/research/tencent-openclaw-weixin-media.md](./docs/research/tencent-openclaw-weixin-media.md)。
