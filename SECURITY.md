# 安全政策

## 支持版本

Codex iLink 只为当前发布通道提供安全更新：

| 发布通道 | 支持范围 |
| --- | --- |
| npm `latest` / 最新稳定 GitHub Release | 完整安全支持，安全修复以新的补丁版本发布 |
| npm `next` / 最新 GitHub Pre-release | 仅支持最新预览版本；可能直接由后续预览版本替代 |
| 更早的稳定版或预览版 | 不再支持，请先升级后复现 |

首个稳定版发布前，只支持 npm `next` 对应的最新预览版本。严重问题可能导致受影响版本被弃用或撤下下载入口，但不会复用已经发布的版本号。

## 私下报告漏洞

请把未公开的漏洞发送到 <tipturengufersan@gmail.com>，邮件主题以 `[Codex iLink Security]` 开头。若仓库的 Security 页面提供 **Report a vulnerability**，也可以使用 GitHub 的私密漏洞报告入口。

不要在公开 Issue、Discussion、PR 或日志附件中披露尚未修复的漏洞、访问令牌、微信凭证、二维码、媒体密钥或本机路径。报告中请提供：

- 受影响的 Codex iLink、Codex Desktop 和 Windows 版本；
- 最小复现步骤、影响范围和攻击前提；
- 已脱敏的日志、截图或概念验证；
- 你是否已经对外披露，以及期望的协调时间。

维护者会尽量在 5 个工作日内确认收到，并在完成影响判断后协调修复与披露时间。请不要发送真实 Token 或其他人的数据；如确需交换敏感附件，先在邮件中约定安全传输方式。

## 披露与修复

在修复版本可用前，请为维护者保留合理的协调时间。修复会发布到仍受支持的通道；必要时会在 GitHub Security Advisory、Release Notes 和 npm deprecation 信息中说明受影响版本与升级路径。
