# Bridge 在 Windows 用户会话中启动

Bridge 通过当前用户的任务计划程序在登录后静默启动，不安装为系统级 Windows Service。这样可以直接复用用户的 Codex 登录状态，并可靠读取锁屏和键鼠在场状态，同时避免管理员权限及 Session 0 的桌面隔离问题。
