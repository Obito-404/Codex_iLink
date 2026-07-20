# 新任务权限即时跟随 Codex Desktop

## 状态

已接受，取代 [ADR 0016](./0016-new-task-permission-defaults-and-live-desktop-approval.md) 的决策 1–3。

## 背景

iLink 自己保存新任务默认权限，会形成第二个配置入口，用户在 Desktop 菜单切换后仍可能得到不同的新任务权限。已有任务与新任务的边界不同：已有任务必须以 Codex 持久化结果为准；新任务需要在创建瞬间复制用户当前的 Desktop 选择。

## 决策

1. 新任务权限唯一选择源是 `%USERPROFILE%\.codex\.codex-global-state.json` 中的 `electron-persisted-atom-state.agent-mode-by-host-id.local`；配置 `CODEX_HOME` 时从该目录读取同名文件。
2. `auto` 或缺失 `local` 映射为 `:workspace + on-request + user`；`guardian-approvals` 映射为 `:workspace + on-request + auto_review`；`full-access` 映射为 `:danger-full-access + never + user`。
3. 微信主会话首次创建、`new` 和 `clear` 每次调用 `thread/start` 前即时读取，不在进程或 SQLite 中缓存。
4. 主文件读取失败或 JSON 损坏时才尝试固定 `.bak`；合法 JSON 中模式未知或结构畸形时失败关闭，不回退可能陈旧的备份。单文件上限 1 MiB。
5. 权限状态不可用时不创建新任务、不更换当前绑定；已有任务的 `thread/resume` 始终不提交权限覆盖。
6. `ilink config` 只显示 Desktop 当前选择；旧 `default-permission`、`default-approval`、`default-reviewer` setter 明确拒绝，`config reset` 只恢复超时。
7. 已部署的 schema v15 权限三列保留原 migration 和结构，但成为惰性遗留列，业务不读、不写、不重置。

## 结果

- Desktop 菜单成为新任务唯一权限选择入口，切换后下一次创建立即生效。
- iLink 不再持有可能与 Desktop 分叉的权限默认值。
- 已有任务继续由 Codex 持久化状态决定，不受 Desktop 后续切换影响。
- 未识别的新模式不会被猜成较高权限。
