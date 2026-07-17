---
status: superseded by ADR-0012
---

# 项目发现只使用公开会话数据

微信入口通过 App Server 的公开会话列表和插件观察到的会话目录构建项目列表，不读取 Codex Desktop 私有数据库。这样会暂时看不到从未产生过会话的空项目，但避免绑定未公开且可能随版本变化的 Desktop 存储格式；空项目在 Desktop 首次创建任务后即可被发现。
