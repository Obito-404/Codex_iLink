# Codex iLink

把微信变成 Windows 本机 Codex 的远程入口。微信与 Codex Desktop 使用同一份任务历史和实际权限设置，可以查看项目、进入任务、继续对话、查看当前任务的实际权限、切换模型，以及收发图片和文件。

> 当前为开发预览版，仅支持 Windows 10/11 x64。Codex 持久化任务及其权限设置是唯一事实源；Bridge 只负责连接、路由和 Codex 原生审批的安全转发，不复制对话，也不保存或恢复一套 iLink 权限。

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
ilink stop     # 停止 Bridge
ilink start    # 启动 Bridge
ilink startup status   # 查看当前用户登录启动状态
ilink startup enable   # 启用当前用户登录启动
ilink startup disable  # 禁用当前用户登录启动
ilink config   # 查看超时配置
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

`perm` 每次都从 Codex 读取当前任务的实际 Profile、审批策略、审批人和 Sandbox。已有任务的权限只能在 Codex Desktop 中修改；同一任务在 Desktop 修改后，下一次 `perm` 会显示新值。旧版 `perm<n>` 输入也只会返回当前权限，不再切换或提升权限。`ok/no` 只回应仍在线的单次 Codex 审批请求，包括审批人为 `user` 的 Desktop Hook 请求；`auto_review` 不会触发微信审批。

## 全局默认配置

新建任务默认使用 `workspace + on-request + auto_review`。这些设置只用于 iLink 之后创建的微信主会话、`new` 和 `clear`；恢复已有任务时不会覆盖其权限：

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
