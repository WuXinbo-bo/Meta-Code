# 工作台插件架构

协作委派和任务编排是两个独立插件，ID 分别为 `collaboration` 和 `orchestration`，均只依赖 core API 1。现有模式入口、Provider 执行器、日志协议和审批门禁继续保留。

## 边界

- 插件宿主管理 manifest、版本依赖、启停、健康状态和配置持久化。设置页通过 `/api/plugins` 管理，`plugins.changed` 更新其他页面。
- 协作插件拥有模式兼容迁移、委派协议、串行受理、幂等、并发限制和执行重试；通过宿主端口调用 Provider。
- 编排插件拥有独立 Repository、计划合同、结果事务、DAG 调度器、机器状态和维护分支。编排与自由对话不合并状态机。
- MCP 是编排插件与 CLI 之间的控制工具传输。启用插件不需要导入 Skill。
- 旧 `server/workflows` 入口仅保留 re-export，保证已打包工具和集成方路径兼容。

## 生命周期

启停在宿主中串行提交。启用失败不写入启用状态；停用前拒绝仍有运行任务的插件。停用后历史记录、日志和成果仍可读取，原生任务继续可用。协作和编排开关互不依赖。已排队输入保存自己的执行模式，恢复使用该快照，旧数据从原委派 Skill 策略兼容推导。

## 数据布局

所有路径相对配置的数据根目录（默认 `~/.metacode`）：

- `plugins/registry.json`：插件启停配置。
- `runtime/plugins/orchestration/runs/<workflowId>`：计划、结果、事件和节点检查点。
- `runtime/plugins/orchestration/transactions`：规划事务。
- `attachments/<sessionId>`：用户附件；UI 使用受会话权限约束的虚拟引用。
- 现有 SQLite 继续持久化委派和编排记录，不创建第二份权威数据库。

旧 `.workflow` 仅在 workflow ID 匹配时迁移已知协议文件；写入并校验备份后清理原文件，迁移标记支持中断后继续。未知文件和符号链接保留。附件仅迁移消息中已登记且 hash 匹配的文件。旧附件引用继续可预览和读取。

托管 Skill 通过每轮上下文中的入口和必要指令注入。工作台不再创建项目 `.agents/skills`、`.claude/skills` 投影；只清理指向工作台托管 Skill 的旧链接，保留用户自己的指令和 Skill。

## 验证

`test:plugin-host` 验证宿主启停与持久化；`test:plugin-boundaries` 验证迁移隔离、崩溃恢复、模式快照、幂等受理和停止期间的竞态。沿用编排、委派、队列、实时日志、附件和桌面回归。发布前运行 typecheck、build 和离线 CI，并在 Windows 基线同步后重复检查。
