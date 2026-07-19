# 发布与分发流程

本文档面向 Codex iLink 维护者，覆盖 npm 包和 Windows x64 独立 exe。普通用户只需参考 README 的安装章节。

## 1. 发布通道与版本映射

版本、Git 标签、GitHub Release 和 npm dist-tag 必须严格对应：

| `package.json` 版本 | Git 标签 | GitHub | npm | Authenticode |
| --- | --- | --- | --- | --- |
| `1.2.3-beta.1`、`1.2.3-rc.1` 等 SemVer 预发布 | `v1.2.3-beta.1`、`v1.2.3-rc.1` | Pre-release | `next` | 可选 |
| `1.2.3` 等无预发布后缀版本 | `v1.2.3` | 正式 Release | `latest` | 必须有效 |

标签必须严格等于 `v${package.json.version}`。发布策略拒绝 SemVer `+build` metadata，确保标签中的 `-` 只表示预发布通道。预发布版本不得移动 `latest`，稳定版本不得发布到 `next`；已经发布的版本号不得复用。

## 2. npm Trusted Publishing 与签名凭证

常规发布只使用 GitHub Actions OIDC 和 npm Trusted Publishing，不保存长期 npm Token。发布负责人必须先在 npm 的 `codex-ilink` 包设置中配置 GitHub Actions trusted publisher：

| 字段 | 值 |
| --- | --- |
| Organization / owner | `Obito-404` |
| Repository | `Codex_iLink` |
| Workflow filename | `release.yml` |
| Environment | 留空以覆盖两个通道；若 npm 侧绑定 Environment，必须与实际发布通道使用的环境精确一致 |

仓库使用两个 GitHub Environment：预发布标签进入 `preview-release`，稳定标签进入 `stable-release`。`stable-release` 应配置 required reviewers，并保存稳定签名所需的两个 Environment Secret：

| Secret | 用途 |
| --- | --- |
| `WINDOWS_SIGNING_PFX_BASE64` | Base64 编码的 Authenticode PFX |
| `WINDOWS_SIGNING_PFX_PASSWORD` | PFX 密码 |

### 首次包名引导

Trusted Publisher 需要从 npm 既有包的 Settings 页面配置；若 `npm view codex-ilink` 仍返回 `E404`，不能直接推送发布标签。发布负责人须先在仓库和 CI 之外完成一次性包名引导：

1. 用启用 2FA 的所有者账号和短时、最小权限凭证，从独立临时目录发布不含项目代码的 `0.0.0-bootstrap.0`，并显式使用 `--tag bootstrap`，不得移动 `latest` 或 `next`；
2. 立即在新建包的 Settings 页面配置本节所列 Trusted Publisher 与目标 Environment；
3. 将 bootstrap 版本标记为 deprecated，撤销临时凭证并确认 CI、仓库和本机配置未保存该凭证；
4. 通过 `npm owner ls codex-ilink` 和包设置页确认所有权后，才允许由本工作流发布第一个正式预览版本。

一次性引导不属于常规发布，不得把临时凭证加入 GitHub Secrets，也不得用 bootstrap 版本承载可执行代码或对外宣传。后续所有项目版本仍只走 OIDC Trusted Publishing。

工作流固定使用 npm `11.6.2` 并校验实际版本，保留 `permissions.id-token: write`，不设置 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。npm publish 自动附带 provenance；trusted publisher、OIDC 请求环境或 npm CLI 版本任一不符合预期时都 fail closed。

CI 与发布工作流引用的第三方 GitHub Actions 均固定到完整 commit SHA，行尾注释只标识其主版本；升级时必须通过受审 PR 更新 SHA，不能把不可变引用改回可移动的 `@vN` 标签。

npm 包所有权、首次包名引导、trusted publisher、GitHub Environment、required reviewers 和签名证书都属于发布前外部作业。仓库工作流不会注册账号、引导包名或创建证书。PFX、密码、npm Token、OTP 和恢复码不得写入仓库、日志、Release 附件或验收证据。

## 3. 候选版本门禁

先提交所有预期变更，从干净工作树执行：

```powershell
git status --short
corepack pnpm install --frozen-lockfile
npm run release:check
```

`npm run release:check` 会检查发布元数据、干净工作树、TypeScript、完整测试和 npm 打包清单。任何一步失败都不得创建发布标签。

再用候选版本和标签显式检查通道策略，例如：

```powershell
node scripts/release-policy.mjs --version 0.1.0-beta.1 --tag v0.1.0-beta.1 --json
```

输出必须显示预期的 `githubPrerelease`、`npmTag` 和 `requiresAuthenticode`。版本无效或标签不精确匹配时脚本返回失败。

稳定版还必须完成并签署 [正式发布验收清单](./release-acceptance.md)。预览版可以保留外部实机项，但必须在 Release Notes 中逐项列明，不能把它描述为已完成稳定验收。

## 4. 检查 npm 打包内容

```powershell
npm pack --dry-run --ignore-scripts
npm pack --ignore-scripts
```

发布包应只包含：

- `dist/` 编译后的 CLI、运行时代码和数据库迁移；
- `plugins/` 与 `.agents/plugins/marketplace.json`；
- README、SPEC、许可证和 `package.json` 明确列出的必要文档。

不得包含 `tmp/`、测试、探针输出、凭证、日志、本机状态数据库或入站/出站媒体。

## 5. 干净环境安装验收

在 Windows 10 x64 和 Windows 11 x64 干净环境验收；npm 路径使用 Node.js 22（最低 `22.13.0`）。下面的命令把 tarball 安装到临时前缀，不覆盖正式全局安装：

```powershell
$smoke = Join-Path $env:TEMP "codex-ilink-smoke"
npm install --global --prefix $smoke .\codex-ilink-0.1.0-beta.1.tgz
& "$smoke\ilink.cmd" --help
& "$smoke\ilink.cmd" doctor
& "$smoke\ilink.cmd" setup
& "$smoke\ilink.cmd" startup status
```

验收结束后先执行 `& "$smoke\ilink.cmd" startup disable`，再移除测试插件、Marketplace 和临时前缀，避免影响日常 Codex 配置。真实微信、共享会话、审批、媒体和通知必须按 [正式发布验收清单](./release-acceptance.md) 留证据。

## 6. Windows x64 独立版与签名

独立版使用 Node.js SEA 打包运行时和只读资源，最终用户不需要安装 Node.js。正式构建固定使用 Node.js `22.23.1`：

```powershell
npm run build:sea
& ".\artifacts\codex-ilink-x86_64-pc-windows-msvc.exe" --help
Get-FileHash -Algorithm SHA256 ".\artifacts\codex-ilink-x86_64-pc-windows-msvc.exe"
```

SEA 注入会使 Node.js 原始签名失效。稳定版必须在注入完成后调用：

```powershell
.\scripts\sign-windows-release.ps1 -ExecutablePath .\artifacts\codex-ilink-x86_64-pc-windows-msvc.exe
```

脚本使用 CI 注入的 PFX 凭证，校验 Authenticode 状态并在签名后重新生成 `.sha256`。也可以用 `-ChecksumPath` 指定校验文件。发布前再次确认：

```powershell
Get-AuthenticodeSignature ".\artifacts\codex-ilink-x86_64-pc-windows-msvc.exe"
Get-FileHash -Algorithm SHA256 ".\artifacts\codex-ilink-x86_64-pc-windows-msvc.exe"
```

稳定版签名必须为 `Valid`，且散列必须与 `.sha256` 一致。缺少 PFX、密码、签名工具或有效签名时脚本失败；工作流必须在创建 GitHub Release 和发布 npm 前停止。预览版可以产出未签名 exe，但 GitHub 必须明确标记为 Pre-release，Windows SmartScreen 可能显示“未知发布者”。

两个通道都会在最终 exe 上生成 GitHub build provenance attestation。验证公开 Release 时，工作流除校验 SHA-256 和稳定版 Authenticode 外，还要求 attestation 的仓库、签发工作流、source digest 与 source ref 分别匹配当前仓库、`.github/workflows/release.yml`、候选 commit 和 tag ref；旧产物没有这份证明时不得按幂等重跑放行。

## 7. 推送标签与 CI 发布

确认 `package.json` 版本、验收结果和目标通道后，推送精确标签：

```powershell
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

`.github/workflows/release.yml` 在干净的 Windows x64 runner 上按顺序执行：

1. 根据标签进入 `preview-release` 或 `stable-release` Environment，安装并精确校验 npm `11.6.2`；
2. `scripts/release-policy.mjs` 校验标签与包版本，并确定 GitHub/npm 通道和签名要求；
3. 使用锁文件安装依赖，运行 `release:check`；
4. 构建 Windows x64 独立 exe；稳定版注入 PFX、验证 Authenticode 并重算 SHA-256；两个通道都为最终 exe 生成绑定候选 SHA 的 build provenance；
5. 冒烟测试 exe，创建或更新 GitHub draft Release，并上传 exe 与 `.sha256`；已公开 Release 还必须通过既有产物的 provenance 复验；
6. 串行化同一通道的发布，确认目标 dist-tag 只前进不回拨，再通过 npm Trusted Publishing 和 provenance 将同一版本发布到 `latest` 或 `next`；
7. npm 成功或幂等确认后才公开 GitHub Release，并按策略设置 Pre-release / latest。

发布步骤支持安全重跑：npm/OIDC 失败只留下 draft；npm 同版本已存在时，只有 `version`、`gitHead` 和目标 dist-tag 都与当前标签一致才跳过，否则 fail closed。npm 成功但 GitHub 最终公开失败时，重跑会校验 npm 身份并继续完成同一 draft。工作流按 `latest` / `next` 分别串行，并在首次发布前比较 SemVer，禁止把已经前进的 dist-tag 回拨到旧版本。若 GitHub Release 已公开，只在既有 exe、SHA-256、build provenance、稳定版 Authenticode 均有效且 npm 已是同一提交时允许幂等结束；不会为已公开 Release 倒序补发缺失的 npm 版本。

不要在 CI 成功后再次手工执行 `npm publish`。稳定版缺少签名凭证时会 fail closed，不会降级为未签名稳定版；预览版和稳定版也不能通过手工参数改变由 SemVer 决定的 dist-tag。

## 8. 发布后验证

先核对远端版本与 dist-tag：

```powershell
npm view codex-ilink version dist-tags --registry=https://registry.npmjs.org/
```

稳定版验证：

```powershell
npm install --global codex-ilink@latest --registry=https://registry.npmjs.org/
ilink doctor
ilink setup
```

PowerShell 安装脚本默认跟随最新 GitHub 正式 Release，不会自动选择 Pre-release。预览 npm 包使用：

```powershell
npm install --global codex-ilink@next --registry=https://registry.npmjs.org/
ilink doctor
ilink setup
```

预览独立 exe 可以从 GitHub Releases 页面手动选择，也可以显式运行安装脚本；不允许用“最新预览”隐式漂移版本：

```powershell
$installer = irm https://raw.githubusercontent.com/Obito-404/Codex_iLink/main/scripts/install.ps1
& ([scriptblock]::Create($installer)) -Channel preview -Version 0.1.0-beta.1
```

预览安装必须提供不带 `v` 前缀的完整预发布版本，校验 SHA-256，并在签名无效时显示警告。稳定版安装默认使用 `-Channel stable`，且 Authenticode 无效时直接失败。稳定发布后还要从 GitHub 下载 exe 与 `.sha256`，重新验证 SHA-256 和 Authenticode，再完成一次真实安装冒烟。

## 9. 发布失败与安全事件

- `WINDOWS_SIGNING_PFX_BASE64` 或 `WINDOWS_SIGNING_PFX_PASSWORD` 缺失/无效时，稳定版在签名步骤失败，npm 与 GitHub 都不发布；不得改成预览策略绕过。
- npm CLI 不是精确的 `11.6.2`、Actions OIDC 请求环境缺失或 npm trusted publisher 不匹配时，npm 发布 fail closed，GitHub 只保留未公开 draft；修复外部配置后可安全重跑同一未变更候选。
- 任一门禁失败时停止发布。候选 commit 未改变且尚无外部产物时可重跑失败工作流；代码、包内容或版本发生变化，或 npm/GitHub 任一侧已经发布时，必须使用新版本和新标签，不能移动旧标签。
- 发现严重问题时发布新的修复版本，并对受影响 npm 版本执行 `npm deprecate`；不把 `unpublish` 当作常规回滚手段。
- 凭证疑似泄露时先撤销/轮换对应 Secret，再按 [安全政策](../SECURITY.md) 协调处置。
- 发布日志或产物出现 Token、PFX、密码、二维码或微信凭证时视为安全事件，不得继续分发。
