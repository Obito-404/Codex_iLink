# Codex iLink 用户指南

本文档适用于当前预览版。Codex iLink 只支持 Windows 10/11 x64；首次使用前，请先完成 README 中的[快速开始](../README.md#快速开始)。

## 发布通道

| 通道 | npm 标签 | 当前用途 |
| --- | --- | --- |
| 预览版 | `next` | 当前受支持通道；用于完成真实设备与微信验收 |
| 稳定版 | `latest` | 正式发布验收完成后使用 |

预发布版本只进入 `next`，不会移动 `latest`。当前安装命令：

```powershell
npm install --global codex-ilink@next
ilink setup
```

## 安装细节

`ilink setup` 会：

1. 安装或更新 `Codex iLink Guard` 插件。
2. 打开微信二维码并等待扫码绑定。
3. 注册当前 Windows 用户的登录启动任务。
4. 启动后台 Bridge。
5. 输出 Codex Hooks 的人工审核指引。

### 完成 Hooks 人工信任

Codex 要求非托管命令 Hook 按当前定义的 hash 由用户审核。`ilink setup` 不会修改 Codex 的信任存储，也不会绕过审核。

1. 刷新或重启 Codex Desktop。
2. 打开 Hooks 信任页面；使用 Codex CLI 时也可以输入 `/hooks`。
3. 找到内部 ID 为 `codex-ilink-probe`、显示名为 `Codex iLink Guard` 的插件。
4. 检查 Hook 来源和命令后，信任该插件需要的 Hooks。

Guard 获得信任后才会捕获 Desktop 生命周期事件。`ilink doctor` 能检查 Guard 是否已经安装并启用，但 Codex 没有提供公开的持久信任状态查询接口，因此这一步仍需人工确认。

不要在普通安装或日常启动中使用 `--dangerously-bypass-hook-trust`。该参数只绕过当前一次 Codex 调用，不会持久化信任；生产安装和运行流程不使用它。

## 日常管理

```powershell
ilink setup              # 首次安装或修复配置
ilink status             # 查看 Bridge 状态
ilink doctor             # 检查环境、Guard、绑定和状态库
ilink login --force      # 微信登录失效后重新扫码
ilink stop               # 停止 Bridge
ilink start              # 启动 Bridge
ilink startup status     # 查看当前用户登录启动状态
ilink startup enable     # 启用当前用户登录启动
ilink startup disable    # 禁用当前用户登录启动
ilink config             # 查看 Desktop 当前新任务权限与超时配置
```

Bridge 在当前 Windows 用户会话中后台运行，不安装系统级 Service。日志位置：

```text
%LOCALAPPDATA%\Codex_iLink\logs\bridge.log
```

### 升级

预览版使用：

```powershell
ilink stop
npm install --global codex-ilink@next
ilink setup
```

首个稳定版发布后，把 `@next` 替换为 `@latest`。

升级后需要刷新或重启 Codex Desktop。如果 Hook 定义发生变化，Codex 会因 hash 变化将它重新标记为待审核，此时需要在 Hooks 页面再次确认。

## 微信命令

微信支持自然语言，也支持以下短命令：

| 功能 | 命令 | 示例 |
| --- | --- | --- |
| 项目 | `p`、`p<n>` | `p`、`p2` |
| 任务 | `s`、`s+`、`sarc`、`s<n>` | `s`、`s3` |
| 新建/清理 | `new`、`clear`、`compact` | `new` |
| 停止/退出 | `stop`、`exit` | `stop` |
| 状态 | `st` | `st` |
| 权限 | `perm`（只读） | `perm` |
| 模型 | `model`、`model<n>` | `model2` |
| 强度 | `effort`、`effort<n>` | `effort2` |
| 审批 | `y[code]`、`n[code]`、`ya`、`na` | `yA7C9E2`、`ya` |
| 帮助 | `help` | `help` |

短命令不带 `/`，命令和编号之间不加空格；英文字母不区分大小写。

`clear` 会用空白 Codex 任务替换当前上下文，并把原任务归档。`exit` 会返回微信主会话并取消当前项目选择。`new` 只使用此时明确选择的项目；没有选择项目时创建无项目任务。

`perm` 每次都从 Codex 读取当前任务的实际审批人，并精简显示为 `权限：auto_review` 这类结果。已有任务的权限只能在 Codex Desktop 中修改；旧版 `perm<n>` 输入也只会查询，不会切换或提升权限。

审批规则：

- `auto_review`：由 Codex 自己判断，iLink 不重复发送微信审批。
- `user`：Codex 确实在等待用户决定、策略为 `on-request`，且命令或权限范围能够完整核验时，iLink 才发送微信审批；回复 `y` 或 `n` 会批准或拒绝这一次操作。
- 多个待审批可以用 `y<code>`、`n<code>` 逐条处理。发送 `ya` 或 `na` 会先列出清单和确认码；两分钟内按提示回复（如 `ya#B12345`）才会批量处理。
- Bridge 断开、审批信息不完整、检测到凭证/隐藏操作/未知字段，或微信没有可回复上下文时，iLink 不伪造审批，而是交回 Codex Desktop 处理。可审批命令只显示经验证的项目名，不发送完整本机路径；命令包含完整本机绝对路径时整条留在原生客户端，不会脱敏后继续批准。App Server 的原生文件变更请求不含实际 patch/目标，也保留在原生客户端；Desktop Hook 只有严格白名单请求或完整解析并绑定原始请求的 `apply_patch` 才能进入微信。

## 图片和文件

- 发给 Codex：直接在微信发送图片、文件或视频，也可以附一句要求。一条消息处理一个附件，单个最大 100 MB。
- 让 Codex 发给你：可以说“把生成的报告发给我”。iLink 新建的任务可以发送当前任务目录内的图片、视频或普通文件；单次回复最多 2 个附件，单个最大 100 MB。
- 语音：微信有转写文字时按文字处理；没有转写时暂不支持，也不能让 Codex 发送语音消息。

文件和视频能否被 Codex 读取，取决于文件格式和当前任务权限。为了避免误发本机文件，iLink 只发送当前任务目录里的真实文件，不会把普通文字中的路径或链接自动当成附件。旧任务如果提示无法发送附件，请用 `new` 新建 iLink 任务后再试。

## 权限与超时

iLink 不保存独立的新任务权限。微信主会话首次创建，以及每次执行 `new` 或 `clear` 时，都会即时读取 Codex Desktop 当前权限选择：

| Codex Desktop 选择 | `permissions` | `approvalPolicy` | `approvalsReviewer` |
| --- | --- | --- | --- |
| 请求批准 | `:workspace` | `on-request` | `user` |
| 替我审批 | `:workspace` | `on-request` | `auto_review` |
| 完全访问权限 | `:danger-full-access` | `never` | `user` |

Desktop 权限切换只影响之后创建的新任务；已有任务继续使用自身已持久化的权限。`ilink config` 只显示 Desktop 当前选择，权限只能在 Desktop 权限菜单修改。Desktop 状态不可读或模式未知时，iLink 不创建任务，也不更换当前绑定。

```powershell
ilink config
ilink config set session-timeout 60m
ilink config set away-timeout 10m
ilink config reset
```

`config reset` 只恢复两个超时，不修改 Desktop 权限。默认任务绑定保持 30 分钟；未锁屏时连续 5 分钟没有键鼠输入会判定为离开。锁屏会立即判定为离开，不受 `away-timeout` 影响。

## 故障排查

### 人离开电脑后，任务还能继续运行吗？

可以。任务运行期间，Codex iLink 会临时阻止 Windows 自动进入睡眠；电脑可以锁屏或关闭显示器。只要电脑保持开机、联网，当前 Windows 用户会话和 Bridge 仍在运行，Codex 就能继续工作并把结果发到微信。

电脑关机、休眠、断网或退出当前 Windows 用户后，本机任务无法继续；Codex iLink 不会把项目上传到云端代跑。

### `ilink` 命令不存在

关闭并重新打开 PowerShell，然后检查：

```powershell
Get-Command ilink
ilink --help
```

如果刚完成 npm 全局安装，请重新打开终端，让 npm 全局命令目录的 `PATH` 生效。

### Bridge 无法启动

```powershell
ilink doctor
ilink status
```

然后查看 `%LOCALAPPDATA%\Codex_iLink\logs\bridge.log`。

### 微信消息无法进入 Codex

先执行 `ilink doctor`，确认 `Codex iLink Guard` 显示为“已安装并启用”。刷新或重启 Codex Desktop，并在 Hooks 信任页面确认内部 ID `codex-ilink-probe` 已人工允许。`doctor` 无法读取或代替这项人工信任。

如果插件缺失或未启用，再执行：

```powershell
ilink setup
```

如果日志出现 `errcode=-14` 或“微信登录已失效”，重新扫码：

```powershell
ilink stop
ilink login --force
ilink start
```

失效登录会按账号暂停请求一小时，避免持续无效重试；重新扫码成功后立即恢复。若微信分配了新 Bot，iLink 会自动换绑并清掉旧账号的待发消息，项目选择、微信主会话和超时配置不会丢。

### Node.js 版本不兼容

npm 安装要求 Node.js `>=22.13.0`，并已在 Node.js 22 上通过完整测试。

### Codex 版本提示“尚未验证”

Codex iLink 最低支持 `0.144.2`，已验证 `0.144.x`。更高版本仍可继续 `setup` 或 `start`，建议先完成一次文本、审批和共享任务冒烟测试。低于 `0.144.2` 时请先升级 Codex Desktop。

## 卸载

先在 Codex Desktop 的插件管理中移除 `Codex iLink Guard` 和 `codex-ilink` Marketplace，然后执行：

```powershell
ilink startup disable
ilink stop
npm uninstall --global codex-ilink
```

先禁用启动任务，避免卸载后留下失效的登录启动入口。卸载不会自动删除 `%LOCALAPPDATA%\Codex_iLink` 中的绑定、状态和日志。

## 获取帮助

普通 Bug 和功能建议请提交到 [GitHub Issues](https://github.com/Obito-404/Codex_iLink/issues)。安全漏洞请按[安全政策](../SECURITY.md)私下报告。

提交日志、截图或复现信息前，请移除 Token、二维码、微信标识、媒体密钥和完整本机路径。
