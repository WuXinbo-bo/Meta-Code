# Agent 对话与抽屉呈现规范

主对话、原生子 Agent、委派 Agent 与编排节点共用回复和活动组件；各自的执行状态机、数据获取方式与操作权限保持独立。

## 组件职责

- `AssistantReply`：回复行、头像插槽、可选身份信息、正文和操作插槽。主对话继续提供复制与分支操作；子 Agent 不伪造独立会话分支能力。
- `AgentReplyContent` / `MarkdownBody`：正文、安全降级、代码、公式和文件链接。字体、行高、段落间距由 `--mc-reply-*` 统一管理。
- `ActivityTimeline`：统一事件归一化、执行顺序、相邻活动汇总和长列表虚拟化。消息和不同类别的活动都是汇总边界。
- `ActivityRenderer`：命令、Diff、MCP、计划和未知事件的公共呈现入口。已完成命令默认仅显示摘要，展开后保留原来的详情层级。
- `AgentConversation`：统一加载、空态和恢复提示。刷新过程中保留已有日志；失败与空日志不能混为一谈。
- `AgentDrawer`：标题、Agent 切换区、单一正文滚动容器、键盘焦点和关闭交互。编排成果、修复结果与执行操作由调用方提供。

运行时只轮播当前未结束活动片段的最新内容；已经结束的回复和工具摘要仍留在原位。模型身份集中在抽屉顶部，`showProvider=false` 时不再逐条重复消息头。

详情必须匹配当前选中 Agent 的 ID。头部活动数量采用总数，不能用尚未加载的空数组覆盖总数。任务说明默认单行预览，可展开全文，不再独立滚动。

## 回归方式

1. 运行 `npm run typecheck`、`npm run build`、`npm run test:agent-conversation`、`npm run test:agent-stream` 和 `npm run test:agent-realtime`。
2. 在开发服务打开 `/scripts/fixtures/agent-conversation-ui.html`，通过真实生产组件显示无个人数据的测试日志；测试页不进入生产构建。
3. 使用 Playwright CLI 的 `run-code --filename=scripts/check-agent-conversation-browser.js` 执行浏览器检查。先打开或重新加载上述页面，截图输出到忽略的 `output/playwright/`。
4. 浏览器检查覆盖首次打开长日志、一万条日志、多 Provider 切换、运行中追加、停止轮播、阅读历史不被打断、命令二级详情、浅深主题、1440/760/390 像素窗口及焦点限制。
5. 用真实已有的主对话、Codex/Claude 子 Agent 和编排规划历史逐页对照。无需启动或恢复用户的实际任务。

本次验证还运行了活动合同、生命周期、Diff、状态存储、SSE、后端重启恢复、委派 CLI 和工作流审批门禁测试。浏览器流式验证使用测试数据追加，不等同于重新调用真实 CLI 的端到端任务测试。
