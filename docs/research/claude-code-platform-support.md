# Claude Code CLI 跨平台适配核查

核查日期：2026-07-20
固定 npm 版本：`@anthropic-ai/claude-code@2.1.215`

## 结论先行

**是，Claude Code CLI 确实做了不同平台的适配。** 它不是把同一个 Windows 程序交给所有系统，也不是因为用了 npm 就自然跨平台。

当前官方实现的准确描述是：

1. Claude Code 官方支持 macOS、Windows 和多种 Linux 发行版，并覆盖 x64、ARM64；Linux 还区分 glibc 与 musl。
2. 官方目前优先推荐原生安装器。macOS/Linux/WSL、Windows PowerShell、Windows CMD 使用不同安装脚本；另有 Homebrew、WinGet、apt、dnf、apk。
3. npm 仍是受支持的安装方式，但在当前版本中主要承担“识别当前平台、安装对应可选依赖、通过 postinstall 链接可执行文件”的工作。
4. npm 安装得到的就是与独立安装器相同的原生二进制；安装后的 `claude` 运行时不会再调用 Node.js。
5. 所以，**npm 在这里是跨平台分发与安装入口，不是跨平台能力本身**。真正的跨平台能力来自 Anthropic 针对 OS、CPU 架构和 Linux libc 发布的不同原生产物，以及 Windows/Linux/macOS 各自的运行适配。

## 1. 官方支持哪些平台

Anthropic 的[系统要求](https://code.claude.com/docs/en/setup#system-requirements)列出：

- macOS 13.0+
- Windows 10 1809+ 或 Windows Server 2019+
- Ubuntu 20.04+
- Debian 10+
- Alpine Linux 3.19+
- x64 或 ARM64 处理器
- Bash、Zsh、PowerShell 或 CMD

Windows 也不是简单复用 Linux 版本。官方[单独说明 Native Windows 与 WSL](https://code.claude.com/docs/en/setup#set-up-on-windows)：原生 Windows 可使用 PowerShell 工具；安装 Git for Windows 后则可使用 Git Bash/Bash 工具。WSL 内使用的是 Linux 安装器。

## 2. 当前推荐安装方式与 npm 的位置

官方[安装章节](https://code.claude.com/docs/en/setup#install-claude-code)把 **Native Install 标为 Recommended**，并按平台给出不同入口：

- macOS、Linux、WSL：`install.sh`
- Windows PowerShell：`install.ps1`
- Windows CMD：`install.cmd`
- macOS 另有 Homebrew；Windows 另有 WinGet；Linux 另有 apt、dnf、apk

npm 被放在[高级安装选项](https://code.claude.com/docs/en/setup#install-with-npm)中，仍然受官方支持：

```bash
npm install -g @anthropic-ai/claude-code
```

但官方对 npm 包的说明非常明确：

- npm 包安装的是“与独立安装器相同的原生二进制”；
- npm 通过每个平台的 optional dependency 拉取二进制；
- postinstall 步骤把二进制链接到位；
- 安装后的 `claude` 二进制自身不调用 Node。

因此，当前 npm 方案可理解为：

```text
npm install
  -> 根据 OS / CPU / libc 选择平台子包
  -> 下载对应原生二进制
  -> postinstall 链接 claude 可执行文件
  -> 后续直接运行原生 claude，不经过 Node
```

## 3. npm 元数据如何证明存在平台专用产物

固定版本 [`@anthropic-ai/claude-code@2.1.215`](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.215) 的[原始 npm 元数据](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/2.1.215)声明了八个同版本 optional dependencies：

| 平台键 | npm 子包 |
| --- | --- |
| `darwin-arm64` | `@anthropic-ai/claude-code-darwin-arm64` |
| `darwin-x64` | `@anthropic-ai/claude-code-darwin-x64` |
| `linux-arm64` | `@anthropic-ai/claude-code-linux-arm64` |
| `linux-x64` | `@anthropic-ai/claude-code-linux-x64` |
| `linux-arm64-musl` | `@anthropic-ai/claude-code-linux-arm64-musl` |
| `linux-x64-musl` | `@anthropic-ai/claude-code-linux-x64-musl` |
| `win32-arm64` | `@anthropic-ai/claude-code-win32-arm64` |
| `win32-x64` | `@anthropic-ai/claude-code-win32-x64` |

这些不是仅靠包名区分。各子包元数据本身也声明平台约束：

- [`darwin-arm64`](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code-darwin-arm64/2.1.215)：`os: ["darwin"]`、`cpu: ["arm64"]`
- [`linux-x64`](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code-linux-x64/2.1.215)：`os: ["linux"]`、`cpu: ["x64"]`、`libc: ["glibc"]`
- [`linux-x64-musl`](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code-linux-x64-musl/2.1.215)：`os: ["linux"]`、`cpu: ["x64"]`、`libc: ["musl"]`
- [`win32-x64`](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code-win32-x64/2.1.215)：`os: ["win32"]`、`cpu: ["x64"]`

主包元数据还声明 `postinstall: node install.cjs`；这与官方文档所说“postinstall 将平台二进制链接到位”一致。

官方文档列出的 npm 支持矩阵与元数据相同：`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`linux-x64-musl`、`linux-arm64-musl`、`win32-x64`、`win32-arm64`。可选依赖若被包管理器禁用，平台二进制就可能缺失。

## 4. 不只是安装脚本不同

官方[二进制完整性与代码签名](https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing)章节进一步证明每次发布包含“每个平台的二进制”：

- 每个 release 的 `manifest.json` 为每个平台二进制记录 SHA256；
- macOS 二进制由 “Anthropic PBC” 签名，并经过 Apple notarization；
- Windows 二进制由 “Anthropic, PBC” Authenticode 签名；
- Linux 二进制不单独代码签名，通过 Anthropic 签名的 manifest 或软件仓库签名验证。

固定版本的 [2.1.215 官方 release manifest](https://downloads.claude.ai/claude-code-releases/2.1.215/manifest.json)也实际列出了上述八个平台键、二进制文件名、文件大小和 SHA256；Windows 产物名为 `claude.exe`，其余平台产物名为 `claude`。

这说明平台差异存在于最终原生产物本身，而不仅是外层安装命令。

## 5. 对“npm 安装为何能跨平台”的准确回答

`npm install -g` 看起来在所有系统上是同一条命令，是因为 npm 提供了统一入口。背后实际发生的是不同平台下载不同包：

```text
Mac M 系列       -> darwin-arm64 原生二进制
Mac Intel        -> darwin-x64 原生二进制
Windows x64      -> win32-x64 原生二进制
Windows ARM64    -> win32-arm64 原生二进制
Linux x64/glibc  -> linux-x64 原生二进制
Alpine x64/musl  -> linux-x64-musl 原生二进制
```

因此，对普通项目来说，仅把发布方式改成 npm 并不能获得同样效果。要做到类似 Claude Code，需要至少具备：

- 跨平台核心逻辑或明确的平台抽象层；
- 对每种目标 OS/CPU/libc 构建产物；
- 对系统特有能力分别实现或降级；
- 让 npm/安装脚本正确选择、校验并安装对应产物。

## 证据边界

本文只确认 **2026-07-20 的官方文档和当前 npm 版本 2.1.215**。它不反推所有历史版本都采用完全相同的包装结构。官方文档明确注明：从 npm 版 `2.1.198` 起要求 Node.js 22+；较旧 Node 只会触发 `EBADENGINE` 警告，因为最终运行的是不依赖 Node 的原生二进制。当前最可靠的结论是：**原生安装器为推荐路径，npm 是受支持的按平台原生二进制分发入口。**
