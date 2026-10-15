# 原生会话控制

Codex 与 Claude 的工作台普通对话支持按任务保存原生模式、审批策略和自定义 Agent。普通对话使用 Provider 官方协议运行：Codex 通过 App Server，Claude 通过 stream-json 与官方 permission callback。工作台只负责展示请求并把用户决定回传给当前活跃进程，不保存审批答案或秘密问题内容。

- `execute` 使用当前任务权限；`plan` 使用只读/计划模式。
- `ask` 将命令、文件修改、权限请求或官方问题显示为可回答卡片。
- Codex 原生历史分支调用官方 `thread/fork`；Claude 使用官方 `--resume --fork-session` 在首次发送时 materialize。
- 自定义 Agent 来源于当前项目和对应原生配置目录；工作台不会把自定义 Agent 指令复制到持久化聊天。
- Claude Agent 使用原文件和官方 `--agent`，保留 Hooks、Skills、Memory、MCP 和工具限制；支持 `.claude/agents/` 内的子目录。工作台只解析 YAML 数据，不执行 YAML 标签。
- 请求绑定任务和用户，任务停止、进程退出或取消后请求立即失效。

Claude 项目 Agent 的 Hooks 和内联 MCP 受官方目录信任检查约束。新目录需从任务的“原生 CLI 终端”进入并确认官方信任提示。仅运行普通非交互对话、信任父目录或打开工作台不等同于此授权；未确认时 Agent 仍可运行，但 Claude 会跳过这些扩展。工作台不会自动修改官方信任记录。用户级 Agent 的规则由官方 CLI 决定。

开启网关旧版搜索兼容后，独立搜索仍优先尝试网关原生 `/alpha/search`。仅在确认接口缺失时回退到旧版托管搜索。请求、引用 ID、加密状态和过滤参数在原生路径中原样保留；认证、配额和原生参数错误不会触发第二次模型请求。网关若将“路由不存在”包装在 HTTP 200 中，也不算原生成功。模型根路径为 `/v1` 时可尝试同源对应的独立搜索路径，成功后优先使用已验证路径。

能力声明不等于端点支持。Provider 新协议、专用联网搜索、实验性功能和 Windows ConPTY 仍需按官方版本与实际环境单独验收。
