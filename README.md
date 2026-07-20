# Codex iLink

Codex iLink 让你在微信里使用 Windows 电脑上的 Codex。

“微信主会话”是总入口，可以查看项目、任务和运行状态。选择项目后，就能新建任务，或继续 Codex Desktop 里的旧任务。微信和电脑看到的是同一个任务、同一份聊天记录。

除了文字，你还可以把图片、文件或视频发给 Codex，也可以让 Codex 把生成的文件发回微信。

任务跑起来后，你可以锁屏、关显示器或离开电脑。只要电脑还开机联网，Codex 就会继续工作，并把进度和结果发到微信。

Codex 能自己审核的操作不会打扰你；只有确实需要你决定时，才会发微信审批。回复 `ok` 或 `no` 就能批准或拒绝。

Codex iLink 不是云电脑。电脑关机、休眠或断网后，本机任务不能继续运行。

> 当前为预览版，仅支持 Windows 10/11 x64。任务和权限仍由 Codex 管理，iLink 只负责连接微信和电脑。

## 安装并启动

安装前请确认：

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10/11 x64；暂不支持 Windows on Arm |
| Codex | 已安装并登录 Codex Desktop，最低 `0.144.2` |
| Node.js | `>=22.13.0`，支持 Node.js 22 LTS 系列 |
| 终端 | PowerShell |

Codex `0.144.x` 已通过兼容性验证。更高版本可继续尝试，`ilink doctor` 会提示“尚未验证”但不会阻止 `setup` 或 `start`；低于 `0.144.2` 不受支持。

安装前先选择发布通道：

| 通道 | npm 标签 | 用途 |
| --- | --- | --- |
| 稳定版 | `latest` | 已完成正式发布验收，推荐日常使用 |
| 预览版 | `next` | 提前验收新功能，可能仍有已列明的实机门禁 |

预发布版本只进入 `next`，不会移动 `latest`；稳定版本才进入 `latest`。

### npm 安装

已经安装 Node.js 22 的用户可以使用标准 npm 全局安装：

```powershell
node --version
npm install --global codex-ilink
ilink setup
```

npm 默认安装稳定版 `latest`。安装预览版时显式使用：

```powershell
npm install --global codex-ilink@next
ilink setup
```

`ilink setup` 会自动完成：

1. 安装或更新 `Codex iLink Guard` 插件。
2. 打开微信二维码并等待扫码绑定。
3. 注册当前 Windows 用户的登录启动任务。
4. 启动后台 Bridge。
5. 输出 Codex Hooks 的人工审核指引。

### 完成 Hooks 人工信任

Codex 要求非托管命令 Hook 按当前定义的 hash 由用户审核。为保留这条安全边界，`ilink setup` 不会修改 Codex 的信任存储，也不会使用危险参数绕过审核。

安装完成后还需要执行一次人工操作：

1. 刷新或重启 Codex Desktop。
2. 打开 Hooks 信任页面；使用 Codex CLI 时也可以输入 `/hooks`。
3. 找到内部 ID 为 `codex-ilink-probe`、显示名为 `Codex iLink Guard` 的插件。
4. 审核 Hook 来源和命令后，信任该插件需要的 Hooks。

完成信任后，Guard 才会捕获 Desktop 生命周期事件，随后即可在微信使用。`ilink doctor` 会检查 Guard 是否已经安装并启用，但 Codex 没有提供公开的持久信任状态查询接口，因此 `Hooks 信任` 一项只显示人工确认说明，不会声称已经自动验证。

不要在普通安装或日常启动中使用 `--dangerously-bypass-hook-trust`。该参数只绕过当前一次 Codex 调用，不会持久化信任；本项目仅曾在隔离探针中使用，生产安装和运行流程均不使用。

### 开始使用

向已绑定的微信机器人发送：

```text
查看项目
```

也可以发送短命令 `p`。收到项目列表后即可选择项目和任务。

## 常用管理命令

```powershell
ilink setup    # 首次安装或修复配置
ilink status   # 查看 Bridge 状态
ilink doctor   # 检查环境、Guard、绑定和状态库；Hooks 信任需人工确认
ilink login --force   # 微信登录失效后重新扫码
ilink stop     # 停止 Bridge
ilink start    # 启动 Bridge
ilink startup status   # 查看当前用户登录启动状态
ilink startup enable   # 启用当前用户登录启动
ilink startup disable  # 禁用当前用户登录启动
ilink config   # 查看新任务默认权限与超时配置
```

Bridge 在当前 Windows 用户会话中后台运行，日志位于：

```text
%LOCALAPPDATA%\Codex_iLink\logs\bridge.log
```

`ilink setup` 会注册当前 Windows 用户的登录启动任务，不安装系统级 Service；可用 `ilink startup status|enable|disable` 管理。

## 升级

稳定版使用：

```powershell
ilink stop
npm install --global codex-ilink@latest
ilink setup
```

npm 预览版把 `@latest` 替换为 `@next`。

升级后需要刷新或重启 Codex Desktop。如果 Hook 定义发生变化，Codex 会因 hash 变化把它重新标记为待审核，此时需要在 Hooks 页面再次人工确认；仅应用版本变化而 Hook 定义未变时，以 Codex 页面显示的实际状态为准。

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
| 模型 | `model`、`model<n>`、`model:<id>` | `model2` |
| 推理强度 | `effort`、`effort:<level>` | `effort:high` |
| 审批 | `ok[code]`、`no[code]` | `okA7C9E2` |
| 帮助 | `help` | `help` |

短命令不带 `/`，命令和编号之间不加空格。

`clear` 会用空白 Codex 会话替换当前上下文，并把原会话归档；在微信主会话执行时会替换内部主会话，但仍停留在微信主会话。`exit` 会返回微信主会话并取消当前项目选择。`new` 只使用此时明确选择的项目；没有选择项目时创建无项目会话。

`perm` 每次都从 Codex 读取当前任务的实际 Profile、审批策略、审批人和 Sandbox。已有任务的权限只能在 Codex Desktop 中修改；同一任务在 Desktop 修改后，下一次 `perm` 会显示新值。旧版 `perm<n>` 输入也只会返回当前权限，不会切换或提升权限。

审批规则可以简单理解为：

- `auto_review`：由 Codex 自己判断，iLink 不会再发一条重复的微信审批。
- `user`：Codex 确实在等待用户决定时，iLink 才把审批发到微信；回复 `ok` 或 `no` 会真正批准或拒绝这一次操作。
- Bridge 断开、审批信息不完整或微信没有可回复的会话时，iLink 不会伪造审批，而是交回 Codex Desktop 处理。

## 图片和文件

- **发给 Codex**：直接在微信发送图片、文件或视频，也可以附一句要求，例如“帮我看看这张图哪里有问题”。一条消息处理一个附件，单个最大 100 MB。
- **让 Codex 发给你**：可以直接说“把生成的报告发给我”。iLink 新建的任务可以把当前任务目录里的图片、视频或普通文件发回微信；单次回复最多 2 个附件，单个最大 100 MB。
- **语音**：微信有转写文字时按文字处理；没有转写时暂不支持，也不能让 Codex 发送语音消息。

文件和视频能否被 Codex 读取，仍取决于文件格式和当前任务权限。为了避免误发本机文件，iLink 只发送当前任务目录里的真实文件，不会把普通文字中的路径或链接自动当成附件。旧任务如果提示无法发送附件，请用 `new` 新建 iLink 任务后再试。

## 全局默认配置

新建任务默认使用 `workspace + on-request + auto_review`：Codex 可以修改当前项目，需要额外权限时再发起请求，并优先由 Codex 自动审查。这样通常不需要每次新建任务后再手动改掉“只读”。

这些设置只用于 iLink 之后创建的微信主会话、`new` 和 `clear`；进入或恢复已有任务时不会覆盖它原来的权限：

```powershell
ilink config set default-permission workspace  # read-only / workspace / full-access
ilink config set default-approval on-request   # on-request / never
ilink config set default-reviewer auto_review  # auto_review / user
ilink config set session-timeout 60m
ilink config set away-timeout 10m
ilink config reset
```

默认会话绑定保持 30 分钟；未锁屏时连续 5 分钟没有键鼠输入会判定为离开。锁屏会立即判定为离开，不受 `away-timeout` 影响。

## 常见问题

### 人离开电脑后，项目还能继续运行吗？

可以。任务运行期间，Codex iLink 会临时阻止 Windows 自动进入睡眠；电脑可以锁屏或关闭显示器。只要电脑保持开机、联网，当前 Windows 用户会话和 Bridge 仍在运行，Codex 就能继续工作，并在你离开时把完成结果发到微信。

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

先执行 `ilink doctor`，确认 `Codex iLink Guard` 显示为“已安装并启用”。然后刷新或重启 Codex Desktop，在 Hooks 信任页面确认内部 ID `codex-ilink-probe` 已人工允许。`doctor` 无法读取或代替这项人工信任。

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

失效登录会按账号暂停请求一小时，避免每 30 秒无效重试；重新扫码成功后立即恢复。若微信分配了新 Bot，iLink 会自动换绑并清掉旧账号的待发消息，项目选择、微信主会话和默认权限不会丢。

### Node.js 版本不兼容

npm 安装要求 Node.js `>=22.13.0`，并已在 Node.js 22 上通过完整测试。

### Codex 版本提示“尚未验证”

Codex iLink 最低支持 `0.144.2`，已验证 `0.144.x`。更高版本出现该提示时仍可继续 `setup` 或 `start`，建议先完成一次文本、审批和共享会话冒烟测试；若出现协议不兼容，请附上 `ilink doctor` 的脱敏输出反馈。低于 `0.144.2` 时请先升级 Codex Desktop。

## 卸载

先在 Codex Desktop 的插件管理中移除 `Codex iLink Guard` 和 `codex-ilink` Marketplace。

执行：

```powershell
ilink startup disable
ilink stop
npm uninstall --global codex-ilink
```

先禁用启动任务，避免卸载后留下失效的登录启动入口。卸载不会自动删除 `%LOCALAPPDATA%\Codex_iLink` 中的绑定、状态和日志。

## 安全与隐私

- 只接受扫码绑定的单一微信控制者。
- 微信凭证使用当前 Windows 用户的 DPAPI 加密。
- Codex 持久化任务是唯一对话与权限事实源，Bridge 不保存完整聊天历史或可回灌的权限快照。
- Codex Hooks 始终由用户按定义 hash 人工审核；安装器不写入信任状态，也不在生产流程中绕过 Hook 信任。
- 不要向他人发送 npm 密码、OTP、恢复码或本机凭证。

安全漏洞请按 [安全政策](./SECURITY.md) 私下报告，不要先在公开 Issue 中披露。

## 源码开发

源码开发最低需要 Node.js 22.13，CI 与独立版发布固定使用 Node.js 22.23.1 和 pnpm 11.7：

```powershell
git clone https://github.com/Obito-404/Codex_iLink.git
cd Codex_iLink
corepack pnpm install --frozen-lockfile
npm run typecheck
npm test
npm run build:sea
```

`build:sea` 仅在 Windows x64 上构建，并在 `artifacts/` 生成独立 exe 与 SHA-256 文件。

实现细节与发布流程见 [SPEC](./SPEC.md)、[ADR](./docs/adr)、[可行性说明](./docs/feasibility.md)、[正式发布验收清单](./docs/release-acceptance.md) 和 [发布与分发流程](./docs/npm-publishing.md)。

本项目采用 [MIT License](./LICENSE)。
