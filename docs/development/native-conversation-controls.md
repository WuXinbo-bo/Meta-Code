# 原生会话控制

Codex 与 Claude 的工作台普通对话支持按任务保存原生模式、审批策略和自定义 Agent。普通对话使用 Provider 官方协议运行：Codex 通过 App Server，Claude 通过 stream-json 与官方 permission callback。工作台只负责展示请求并把用户决定回传给当前活跃进程，不保存审批答案或秘密问题内容。

- `execute` 使用当前任务权限；`plan` 使用只读/计划模式。
- `ask` 将命令、文件修改、权限请求或官方问题显示为可回答卡片。
- Codex 原生历史分支调用官方 `thread/fork`；Claude 使用官方 `--resume --fork-session` 在首次发送时 materialize。
- 自定义 Agent 来源于当前项目和对应原生配置目录；工作台不会把自定义 Agent 指令复制到持久化聊天。
- 请求绑定任务和用户，任务停止、进程退出或取消后请求立即失效。

能力声明不等于端点支持。Provider 新协议、专用联网搜索、实验性功能和 Windows ConPTY 仍需按官方版本与实际环境单独验收。
