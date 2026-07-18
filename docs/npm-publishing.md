# npm 发布流程

本文档面向 Codex iLink 的维护者。普通用户只需参考 README 的安装章节。

## 1. 首次发布前的人工作业

以下步骤涉及身份、法律授权和安全凭证，必须由项目负责人本人完成：

1. 在 <https://www.npmjs.com/signup> 注册 npm 账号并验证邮箱。
2. 为 npm 账号启用双重验证（2FA），妥善保存恢复码。
3. 决定发布者名称，并填写 `package.json` 的 `author`。
4. 创建公开 Git 仓库，填写 `repository`、`homepage` 和 `bugs`。
5. 选择许可证。未完成法律确认前保留 `UNLICENSED`，不要发布。
6. 上述信息完成后删除 `private: true`，这是解除发布硬保险的显式动作。
7. 在发布电脑执行 `npm login --registry=https://registry.npmjs.org/`。

Codex 不能代替负责人注册账号、设置密码、处理验证码或保存 2FA 恢复码。

## 2. 版本策略

- 首次外部验收使用预览版本，例如 `0.1.0-beta.1`。
- 预览版本发布到 `next` 标签，不直接覆盖 `latest`。
- 验收通过后再发布稳定版本，或将经过验证的版本提升为 `latest`。
- 每个已发布版本号不可重复使用。

## 3. 发布门禁

从干净工作树开始：

```powershell
git status --short
pnpm install --frozen-lockfile
pnpm release:check
```

`pnpm release:check` 会检查：

- 发布者、仓库和许可证元数据已经填写
- `private: true` 已由负责人显式解除，Git 工作树干净
- TypeScript 类型检查通过
- 完整测试套件通过
- npm 打包清单可以生成

任何一步失败都不得继续发布。

## 4. 检查打包内容

```powershell
npm pack --dry-run --ignore-scripts
npm pack --ignore-scripts
```

发布包应只包含：

- `dist/` 编译后的 CLI、运行时代码和数据库迁移
- `plugins/` 与 `.agents/plugins/marketplace.json`
- README、SPEC 和面向用户的必要文档

不得包含 `tmp/`、测试、探针输出、凭证、日志或本机状态数据库。

## 5. 干净目录安装验收

下面的命令把 tarball 安装到临时前缀，不覆盖正式全局安装：

```powershell
$smoke = Join-Path $env:TEMP "codex-ilink-smoke"
npm install --global --prefix $smoke .\codex-ilink-0.1.0-beta.1.tgz
& "$smoke\ilink.cmd" --help
```

还应在一台干净 Windows 环境验证：

```powershell
& "$smoke\ilink.cmd" setup
```

验收完成后移除测试插件与 marketplace，避免影响日常 Codex 配置。

## 6. 发布预览版

```powershell
npm publish --access public --tag next --registry=https://registry.npmjs.org/
npm view codex-ilink version dist-tags --registry=https://registry.npmjs.org/
```

随后从 npm 官方源重新安装验证：

```powershell
npm install --global codex-ilink@next --registry=https://registry.npmjs.org/
ilink setup
```

## 7. 发布稳定版

稳定版本应使用不带预发布后缀的版本号，并在完整验收后发布：

```powershell
npm version 0.1.0
npm publish --access public --tag latest --registry=https://registry.npmjs.org/
```

发布后核对 npm 页面、README、安装命令、`ilink doctor` 和插件安装流程。

早期本地预览版的 marketplace 名称是 `personal`。升级验收必须覆盖旧插件移除和新插件安装，并确认不会删除用户已有的其他 `personal` marketplace 内容。

## 8. 发布错误处理

- 发现严重问题时优先发布修复版本，并对旧版本执行 `npm deprecate`。
- 不把 `unpublish` 当作常规回滚手段。
- 不共享 npm 密码、OTP、恢复码或长期访问 Token。
- CI 发布优先使用 npm 官方支持的可信发布或短期凭证，避免长期 Token。
