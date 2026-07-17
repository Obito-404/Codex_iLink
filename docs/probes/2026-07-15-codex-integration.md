# Codex 集成探针记录（2026-07-15）

## 结论

前两个开发门禁已通过：插件 Hook 能从真实 Desktop UI 捕获会话元数据，捕获到的 `session_id` 能被 App Server 作为 `threadId` 恢复。PATH CLI `0.144.4` 与 Desktop 内置 Codex `0.144.2` 的结果一致。

## 环境

| 运行时 | 版本 | 入口 |
|---|---:|---|
| PATH Codex CLI | `0.144.4` | `codex` |
| Codex Desktop 内置运行时 | `0.144.2` | `C:\Users\obito_li\AppData\Local\OpenAI\Codex\bin\3135b80b111fd431\codex.exe` |

探针插件位于 `plugins/codex-ilink-probe`，通过个人本地 Marketplace 安装。插件验证器已通过，安装缓存版本为 `0.1.0+codex.20260715145208`。

## 门禁 1：插件 Hook 元数据捕获

插件注册 `SessionStart`、`UserPromptSubmit`、`Stop` 和 `PermissionRequest`。Hook 只落盘以下元数据，不保存 prompt、tool input 或 Transcript：

- `sessionId`
- `turnId`
- `cwd`
- `eventName`
- `model`
- `permissionMode`
- `toolName`
- `source`
- 捕获时间与 Schema 版本

使用 `--dangerously-bypass-hook-trust` 验证运行时链路后，两套运行时均实际捕获到 `SessionStart`、`UserPromptSubmit` 和 `Stop`：

| 运行时 | 捕获到的 `session_id` | `cwd` | 结果文件 |
|---|---|---|---|
| PATH CLI `0.144.4` | `019f663f-6888-7841-b866-322587b92ce9` | `D:\Codex_iLink` | `.probe-output/hooks.jsonl` |
| Desktop 内置 `0.144.2` | `019f6645-0ee8-7fb3-a61f-c8cbf1ec7eb5` | `D:\Codex_iLink` | `.probe-output-desktop-runtime/hooks.jsonl` |

用户已在 Desktop `/hooks` 中人工信任四项；复查结果均为 `enabled=true`、`trustStatus=trusted`。随后通过 Desktop UI 恢复专用任务并执行回合，捕获到：

```text
sessionId=019f653c-a959-7f52-833d-3ba61f85c905
turnId=019f665f-9012-7210-bacd-b0f12e77caac
cwd=D:\Codex_iLink
events=SessionStart,UserPromptSubmit,Stop
response=TRUSTED_HOOK_UI_OK
```

`UserPromptSubmit` 与 `Stop` 的 `sessionId`、`turnId`、`cwd` 完全一致，门禁 1 的 Desktop UI 路径验收完成。早期 `--dangerously-bypass-hook-trust` 仅用于运行时兼容性探针，不是生产配置。

探针 Hook 的 stdout 始终为空，异常时 fail-open，不阻塞 Codex。

## 门禁 2：`session_id` → `thread/resume`

恢复命令为：

```powershell
pnpm probe:resume -- --thread <session_id>
```

PATH CLI 使用默认 `codex app-server`；Desktop 运行时通过 `CODEX_ILINK_APP_SERVER_COMMAND` 指定内置 `codex.exe app-server`。两次请求都只向 `thread/resume` 传 `{ threadId }`，所有模型、目录、权限与 Sandbox 覆盖字段完全省略，不能传 `null`。

两个版本均恢复出相同配置：

```text
model=gpt-5.6-sol
modelProvider=custom
cwd=D:\Codex_iLink
approvalPolicy=on-request
approvalsReviewer=user
sandbox=workspaceWrite
networkAccess=false
reasoningEffort=high
status=idle
```

JSONL 响应与通知会交错，探针按请求 `id` 匹配响应。后续 `turn/start` 同样只能发送必要输入，不应把恢复结果重新作为覆盖值回填。

## PermissionRequest 事实修正

Codex `0.144.2` 和 `0.144.4` 的 `PermissionRequest` Hook 技术上支持通过 `hookSpecificOutput.decision.behavior` 返回 `allow` 或 `deny`。V1 出于安全策略不启用微信审批 Desktop 回合：Hook stdout 始终为空，只上报脱敏元数据，Desktop 自己处理审批。

微信仍可处理 Bridge 自己启动的 App Server 在线审批请求；这与 Desktop `PermissionRequest` Hook 是两条独立链路。

参考：[Codex Hooks](https://learn.chatgpt.com/docs/hooks) 与 [Codex 0.144.2 PermissionRequest 输出 Schema](https://github.com/openai/codex/blob/rust-v0.144.2/codex-rs/hooks/schema/generated/permission-request.command.output.schema.json)。

## Desktop 可见性补充验证

两条 Hook 样本由 `codex exec` 创建，来源类型为 `exec`，因此 Desktop 默认最近任务列表不会枚举它们；这不是微信 Bridge 的创建路径。Desktop 仍可按 ID 读取二者的完整消息与回复，且通过 `thread/name/set` 写入的标题可被读回。

随后使用与微信 Bridge 相同的 App Server 路径，在 `D:\Codex_iLink` 中仅设置 `cwd` 新建持久化任务、调用 `thread/name/set`，再用最小 `turn/start` 发送测试消息：

```text
threadId=019f664b-3baa-7183-9159-27256b164cb5
name=Codex iLink 微信入口可见性验证 2
response=WECHAT_APP_SERVER_VISIBLE_OK
status=idle
```

该任务可由 Desktop 读取，并在打开一次任务后显示于 Desktop 最近任务顶部，标题、用户消息和最终回复一致。这里观察到外部进程新建任务后，已打开的 Desktop 列表缓存可能不会立即失效；刷新或直接打开任务会同步出来。生产验收应把“Desktop 已开着时自动刷新”和“重开 Desktop 后可见”分别测试，不能只验证底层 JSONL 已写入。

## 认证环境

实测表明，继承到 App Server 子进程的失效 `CODEX_API_KEY` 或 `OPENAI_API_KEY` 会覆盖并污染现有 ChatGPT 登录认证。从 Desktop 内启动时，还会继承 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 和 `CODEX_THREAD_ID`，造成 Bridge 子进程被标成父任务来源。探针启动子进程前会按大小写不敏感方式移除这四项；生产 Bridge 也必须使用受控环境。

## 超时边界

当前 Hook manifest 的 `timeout` 为 5 秒，仅用于容纳 PowerShell 冷启动并验证集成链路，不是生产延迟目标。生产设计要求 Named Pipe 与失败回退 Spool 的合计等待不超过 500ms，全部失败时仍需 fail-open。进入生产实现时必须按 500ms 预算重新实现和压测，不能把探针的 5 秒配置沿用到正式插件。

## 探针客户端审查

对抗式审查发现并已回归覆盖两类 JSONL 协议问题：App Server 发出的双向 request 即使与本地 pending request 使用相同数字 ID，也不能被误当成响应；stdout 出现 `null` 等非对象 JSON 时必须快速失败，不能触发未捕获异常。子进程退出改为在 stdio `close` 后终结 pending request，stdin 写入错误也会立即传播，stderr 仅保留最后 64KB。

当前自动测试为 4/4 通过，`tsc --noEmit` 通过；PATH CLI `0.144.4` 与 Desktop 内置 `0.144.2` 的真实恢复探针在上述修正后也再次通过。

这仍是一次性探针客户端，不是常驻 Bridge 的生产进程管理器。生产实现还必须固定受信任的 Codex 绝对路径、使用 Windows Job Object 管理完整进程树、对 stderr 脱敏，并把 `turn/start` 超时归类为“提交结果未知”而非自动重试。

## 后续门禁

1. 验证已打开的 Desktop 是否会在不手动刷新或直接打开任务的情况下，自动发现 App Server 新建任务。
2. 继续执行同一 `thread_id` 的 Desktop/Bridge 并发抢占探针；在此之前不进入完整 Bridge 实现。
