---
status: accepted
---

# 项目列表镜像 Desktop 已保存工作区

App Server 没有公开的项目列表，而从会话 `cwd` 推导会暴露大量不再属于 Desktop 项目列表的历史目录。因此 `p` 改为只读 Codex Desktop 全局状态中的已保存工作区集合，并按 `project-order` 中的项目 ID 经 `local-projects[id].rootPaths` 解析顺序；旧版直接保存绝对路径的排序项也可按相同根目录规则解析。微信只显示根目录名称并把路径留作内部路由。代价是依赖一个未承诺跨版本稳定的 Desktop JSON 格式，所以读取或校验失败时必须关闭列表，不能回退为全部会话目录。
