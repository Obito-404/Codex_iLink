# 同会话跨进程并发探针（2026-07-15）

## 结论

原方案门禁不通过。Codex `0.144.4` 的两个独立 App Server 会同时接受同一 `thread_id` 的 `turn/start`，没有 Busy、拒绝或排队信号，而且持久化历史发生语义错组。共享写入实现已暂停，不能继续使用 `idle` 预检。

## 证据

专用任务为 `019f6663-3fa7-7581-93d6-f8a5aee9a067`。两个进程均先恢复到 idle，两次请求仅相差 `0.203ms`，分别返回不同 `turn_id` 且最终都 completed。

原始 JSONL 的 23 行均能正常解析，顺序为：

```text
task_started(A)
task_started(B)
turn_context(A)
turn_context(B)
user(A)
user(B)
assistant(A)
task_complete(A)
assistant(B)
task_complete(B)
```

第三个全新 App Server 执行 `thread/read includeTurns:true` 后，Turn A 为 `items=[]`，Turn B 却错误聚合 A 用户消息、B 用户消息、A 回复和 B 回复。这不是 JSONL 行写入撕裂，而是 legacy loader 无法表达重叠回合边界。

## 仲裁能力补充验证

Desktop 内置 Codex `0.144.2` 已用 session flag Hook 实测：`UserPromptSubmit` 返回以下输出时，本回合以 0 input/output token 完成，模型没有运行。

```json
{"continue":false,"stopReason":"CODEX_ILINK_CONCURRENCY_GUARD"}
```

这与官方 Hooks 文档的 Common output fields 一致。因此下一门禁改为本地原子租约：Desktop Hook 与 Bridge 都在提交前竞争同一租约，失败方在进入 Codex 之前阻止或排队。

官方参考：[Codex Hooks / Common output fields](https://learn.chatgpt.com/docs/hooks#common-output-fields)。
