# Codex iLink

把微信变成 Windows 本机 Codex 的远程入口。微信与 Codex Desktop 使用同一份任务历史，可以查看项目、进入任务、继续对话、切换模型与权限，以及收发图片和文件。

> 当前为开发预览版，仅支持 Windows。Bridge 只负责连接和路由，不复制 Codex 对话。

## 安装并启动

只需满足以下公共要求：

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10/11 |
| Codex | 已安装并登录 Codex Desktop |
| 终端 | PowerShell |

安装方式任选一种即可。

### 方式一：PowerShell 安装（推荐，无需 Node.js）

与 Codex CLI 的安装方式相同，一条命令下载最新 GitHub Release、校验 SHA-256，并安装为当前用户命令：

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/Obito-404/Codex_iLink/main/scripts/install.ps1 | iex"
```

安装脚本会把独立的 `ilink.exe` 放入 `%LOCALAPPDATA%\Programs\Codex-iLink` 并加入用户 `PATH`。该版本自带 Node.js 运行时，用户电脑不需要安装 Node.js 或 pnpm。

### 方式二：npm 安装

已经安装 Node.js 22 的用户可以使用标准 npm 全局安装：

```powershell
node --version
npm install --global codex-ilink
ilink setup
```

npm 版本要求 Node.js `>=22.13.0`，支持 Node.js 22 LTS 系列，不要求 Node.js 24。预览版本可使用 `npm install --global codex-ilink@next`。

### 方式三：GitHub Release

也可以从项目的 [GitHub Releases](https://github.com/Obito-404/Codex_iLink/releases) 手动下载：

1. 下载 `codex-ilink-x86_64-pc-windows-msvc.exe` 和对应的 `.sha256` 文件。
2. 校验 SHA-256 后把程序重命名为 `ilink.exe`。
3. 将其放入一个已加入 `PATH` 的目录。

然后运行：

```powershell
ilink setup
```

`ilink setup` 会自动完成：

1. 安装或更新 `Codex iLink Guard` 插件。
2. 打开微信二维码并等待扫码绑定。
3. 启动后台 Bridge。

安装完成后，刷新或重启 Codex Desktop，在信任页面审核并允许 `Codex iLink Guard` Hooks。

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
ilink doctor   # 检查环境、绑定和状态库
ilink stop     # 停止 Bridge
ilink start    # 启动 Bridge
ilink config   # 查看超时配置
```

Bridge 在当前 Windows 用户会话中后台运行，日志位于：

```text
%LOCALAPPDATA%\Codex_iLink\logs\bridge.log
```

当前版本不会自动设置开机启动。

## 升级

PowerShell / 独立版直接重新运行安装命令：

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/Obito-404/Codex_iLink/main/scripts/install.ps1 | iex"
ilink setup
```

npm 版本使用：

```powershell
ilink stop
npm install --global codex-ilink@latest
ilink setup
```

升级或插件发生变化后，需要刷新 Codex Desktop，并重新审核 Hooks。

## 微信命令

微信支持自然语言，也支持以下短命令：

| 功能 | 命令 | 示例 |
| --- | --- | --- |
| 项目 | `p`、`p<n>` | `p`、`p2` |
| 任务 | `s`、`s+`、`sarc`、`s<n>` | `s`、`s3` |
| 新建/清理 | `new`、`clear`、`compact` | `new` |
| 停止/退出 | `stop`、`exit` | `stop` |
| 状态 | `st` | `st` |
| 权限 | `perm`、`perm<n>` | `perm2` |
| 模型 | `model`、`model<n>`、`model:<id>` | `model2` |
| 推理强度 | `effort`、`effort:<level>` | `effort:high` |
| 审批 | `ok[code]`、`no[code]` | `okA7C9E2` |
| 帮助 | `help` | `help` |

短命令不带 `/`，命令和编号之间不加空格。

## 超时配置

默认会话绑定保持 30 分钟，未锁屏时连续 5 分钟没有键鼠输入会判定为离开：

```powershell
ilink config set session-timeout 60m
ilink config set away-timeout 10m
ilink config reset
```

锁屏会立即判定为离开，不受 `away-timeout` 影响。

## 常见问题

### `ilink` 命令不存在

关闭并重新打开 PowerShell，然后检查：

```powershell
Get-Command ilink
ilink --help
```

如果刚运行过 PowerShell 安装脚本，请重新打开终端，让新的用户 `PATH` 生效。

### Bridge 无法启动

```powershell
ilink doctor
ilink status
```

然后查看 `%LOCALAPPDATA%\Codex_iLink\logs\bridge.log`。

### 微信消息无法进入 Codex

刷新或重启 Codex Desktop，确认 `Codex iLink Guard` 已安装并启用，并在信任页面允许其 Hooks。随后重新执行：

```powershell
ilink setup
```

### Node.js 版本不兼容

npm 安装要求 Node.js `>=22.13.0`，并已在 Node.js 22 上通过完整测试。PowerShell 安装和 GitHub Release 独立版自带运行时，不受用户电脑 Node.js 版本影响。

## 卸载

先在 Codex Desktop 的插件管理中移除 `Codex iLink Guard` 和 `codex-ilink` Marketplace。

npm 安装的版本执行：

```powershell
ilink stop
npm uninstall --global codex-ilink
```

独立版执行：

```powershell
ilink stop
Remove-Item -LiteralPath "$env:LOCALAPPDATA\Programs\Codex-iLink" -Recurse -Force
```

然后从当前用户的 `PATH` 中移除 `%LOCALAPPDATA%\Programs\Codex-iLink`。

卸载不会自动删除 `%LOCALAPPDATA%\Codex_iLink` 中的绑定、状态和日志。

## 安全与隐私

- 只接受扫码绑定的单一微信控制者。
- 微信凭证使用当前 Windows 用户的 DPAPI 加密。
- Codex 持久化任务是唯一对话事实源，Bridge 不保存完整聊天历史。
- 不要向他人发送 npm 密码、OTP、恢复码或本机凭证。

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

实现细节与发布流程见 [SPEC](./SPEC.md)、[ADR](./docs/adr)、[可行性说明](./docs/feasibility.md) 和 [发布与分发流程](./docs/npm-publishing.md)。

本项目采用 [MIT License](./LICENSE)。
