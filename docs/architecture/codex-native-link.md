# Codex 联动架构

## 目标

在不改变现有 Codex 普通模式运行目录和稳定行为的前提下，为 Meta Code 增加一个独立的官方 Codex 联动域：

- 按工作区发现官方 Codex CLI、IDE 或 App Server 线程。
- 将工作台普通任务与官方 `codexThreadId` 建立持久映射。
- 只读取有限历史摘要，避免完整工具日志冲击前端渲染预算。
- 从官方线程创建历史支线，不修改原线程。
- 后续允许工作台通过同一个 App Server 顺序接管线程。

## 边界

- 现有普通模式继续使用 `~/.metacode/profiles/codex`，不覆盖用户的官方 Codex 数据目录。
- 联动连接器使用用户级 Codex 目录；可通过 `META_CODEX_LINK_HOME` 显式覆盖。
- 不读取或修改 Codex 内部数据库、JSONL 文件。
- 旧工作台对话不伪装成官方原生历史；后续通过结构化交接创建新官方线程。
- 官方桌面端是否展示第三方 App Server 创建的线程取决于官方客户端能力，不作为当前稳定承诺。

## 模块

```text
src/codex-link/CodexLinkView
              |
              v
/api/codex-link/*
              |
              +--> CodexLinkRepository (独立 codex-link.db)
              |
              +--> CodexAppServerClient (JSON-RPC / stdio)
                            |
                            v
                    用户级 Codex 会话存储
```

`server/index.ts` 只注入当前用户、工作区、普通任务和 Codex CLI 路径，不承载联动协议逻辑。

## 已落地接口

- `GET /api/codex-link/status`：检查官方连接器状态。
- `GET /api/codex-link/threads?workspaceId=...`：按 `cwd` 发现项目线程。
- `GET /api/codex-link/threads/:threadId?workspaceId=...`：读取最近 20 轮轻量摘要。
- `POST /api/codex-link/threads/:threadId/fork`：创建官方历史支线。
- `POST /api/codex-link/bindings`：建立工作台任务与官方线程映射。
- `DELETE /api/codex-link/bindings/:bindingId`：解除映射。
- `POST /api/codex-link/leases`：在确认官方线程非活动状态后取得短时租约。
- `DELETE /api/codex-link/leases/:threadId`：释放当前工作台任务持有的租约。

所有线程操作必须通过服务端工作区归属检查；浏览器不会接触官方目录路径和内部存储。

## 后续实施阶段

### 第二阶段：顺序接管

- 为映射线程加入 `thread/read` 状态门禁。
- 工作台只在目标线程非 `active` 时调用 `thread/resume` 和 `turn/start`。
- 运行期间显示执行端、活动回合和等待审批状态。
- 同一个 App Server 内依赖线程状态阻止并发回合；工作台映射库只承担辅助租约和异常恢复。

### 第三阶段：旧任务交接

- 从旧工作台任务提取用户目标、最终回复、Git 提交和文件变更清单。
- 用户确认后创建新的官方线程，并以一条明确的交接消息继续，而不是导入伪造历史。
- 保存来源任务、目标线程和交接提交的映射，支持回到原任务。

### 第四阶段：Git 双向回流

- 在联动面板展示当前分支、HEAD 和工作树差异。
- 接管前检查脏工作树；完成后记录提交或差异快照。
- 支线默认配合 Git 分支或 worktree，避免只分叉对话但共享冲突文件状态。

## 并发规则

1. 同一线程只允许一个活动回合。
2. 发现 `active` 状态时，工作台只读并禁止接管和分支。
3. 对话分支与 Git 分支是两个维度；需要修改同一项目时必须同时明确文件分支策略。
4. 外部客户端不受工作台本地锁强制约束，因此最终以共享 App Server 的线程状态为准。
