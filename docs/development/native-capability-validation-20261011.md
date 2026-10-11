# Codex / Claude 原生能力实测与修复（2026-10-11）

## 结论

核心原生执行、子 Agent、会话恢复、Skill、项目指令、MCP、Hooks 和运行控制已有真实验证。Claude 原生 Dynamic Workflow 也已完成后台通知、自动唤醒及成果交付。Meta Code 的协作插件和编排插件另行回归通过。

**不能据此宣称所有官方功能完整可用。** 本轮已在可见工作台中真实验证 Codex `search_query`（通过明确标注边界的兼容桥）和 Claude 原生 fork；Claude Agent Teams 结构、通信和普通停止请求已进入真实验证，但官方结构化单成员关闭仍受 CLI schema 限制。实验性能力、官方服务、版本和兼容接口限制需要逐项验证，manifest 声明不等于实测结果。工作台的原生适配、Provider 原生 Workflow、Meta 编排插件和 Agent Teams 是不同能力。

## 测试方法与证据

使用用户当前可见工作台：API 4338、UI 4339。全部真实项目在用户指定桌面测试工作区的 `04-native-capabilities-20261011` 下；没有新建隔离的真实 Agent 后端或数据 profile。任务、原生子 Agent 日志、脱敏会话快照、终端回放及项目成果保留在工作台与本地测试目录，未提交源码仓库。

- Codex CLI：`0.162.0-alpha.17.2`。不同轮次按当时账号设置执行；终端复测实际显示 `gpt-6-astra · high`。
- Claude CLI：`2.1.291`，实际模型 `claude-opus-5-5`。
- 基础 Codex 任务：`task_28765943-8053-45a4-998a-ac06665b5573`。
- 基础 Claude 任务：`task_9eb5297b-184a-4d89-b11c-6bf00ea25fc0`。
- 控制任务：Codex `task_14afc163-e315-4ef2-8485-cd31ade72103`；Claude `task_f0996c41-b794-4de4-9300-753a46dcaedc`。

验收不只看模型的“成功”陈述：核对工具事件、子 Agent 终态与实际日志、项目文件、原生命令退出码、Hook 落盘事件、后台通知、会话标记和中断后的文件状态。测试目录凭据扫描检查 71 个文件，未发现配置中的 Provider Key。

## 原生验收矩阵

| 能力 | Codex | Claude | 真实证据 / 边界 |
| --- | --- | --- | --- |
| 项目文件读取、修改 | 通过 | 通过 | 将 `sum(a,b)=a-b` 修复为 `a+b`，实际检查最终源码 |
| 原生命令与测试执行 | 通过 | 通过 | `node --test` 退出 0，正数、负数、零值断言通过 |
| 两个原生前台子 Agent | 通过 | 通过（修复后） | 独立检查实现和测试；详情日志可读，主 Agent 收到真实结果 |
| 原生后台子 Agent | 本轮未单独覆盖 | 通过（修复后） | 两个 `run_in_background` 子 Agent 完成；普通后台轮有 sleep，空闲自动唤醒另由 Workflow 轮验证 |
| 原生 Dynamic Workflow | 无与 Claude 同名的官方接口，不作对等宣称 | 通过（修复后） | `wf_44a612b0-be8`；`parallel` 两个 Explore Agent、结构化输出、后台通知后自动继续写报告 |
| 自定义原生 Agent | 官方终端通过；普通适配会话未暴露类型选择 | 通过 | `audit-reviewer` 返回各自 `CUSTOM-*` marker；Codex 在官方项目 trust 后复测通过 |
| 原生 Skill | 通过 | 通过 | `native-audit` 与独立 marker；Claude 实际 Skill 调用，Codex 实际读取 Skill 指令并执行 |
| 项目 AGENTS.md / CLAUDE.md | 通过 | 通过 | 不同项目指令 marker 返回且与文件一致 |
| 自定义 MCP | 通过 | 通过 | 真实 `native_add(-2,5)` 返回 3 与 MCP marker |
| 项目 Hook | 官方终端通过 | 通过 | Codex SessionStart、Claude PostToolUse 均生成测试事件文件；Codex 按官方 exact-definition trust 审阅，不绕过信任 |
| 联网搜索 | **通过（兼容边界）** | 通过 | Codex 真实 `search_query` 从可见工作台返回官方 URL；旧网关使用 `/alpha/search` → hosted `web_search_preview`，明确拒绝未实现的域名/时效/专用搜索控制。Claude 真正 WebSearch 获得官方文档。没有用 curl 冒充 |
| 原生会话记忆与恢复 | 通过 | 通过 | 后续轮及重启后恢复同一会话，返回原标记 |
| 排队输入 | 通过 | 通过 | QUEUE-FIRST 完成后执行 QUEUE-SECOND，记忆标记正确，队列为空 |
| 暂停 → 恢复 | 通过 | 通过 | 观察真实 `sleep 30` 启动后暂停；没有延迟写文件；恢复仍返回原标记 |
| 运行中引导 | 通过 | 通过 | 真正运行延迟命令后 steer，完成 STEER-OK；无旧目标文件副作用 |
| 停止 → 继续对话 | 通过 | 通过 | stopped 终态，原延迟文件不存在，后续 RESUME-OK 成功 |
| 官方交互 CLI 入口 | 通过 | 通过（认证修复后） | 使用 PTY 与官方可执行文件；Claude 保留网关 Bearer 认证后进入交互；同一工作台账号、模型、MCP、执行目录和互斥锁 |
| 官方终端关闭 / 回放 / 停止 | 通过 | 退出记录可读 | 关闭视图保留进程；重开同一实例回放，停止释放执行锁；不将终端对话冒充工作台普通时间线 |
| Claude Agent Teams | 不适用 | **创建与通信通过；结构化关闭受限** | 官方 CLI named Agent 创建 math-reader/test-reader，lead 与成员及成员之间 SendMessage 真实成功；普通停止文字获确认但成员仍 available，结构化 shutdown 受官方 schema 冲突阻断。退出 lead 终端为 exit 0 |
| 原生 fork / review | 官方终端通过 | **通过** | Codex `/fork` 选择当前 Git 目录，官方显示 Fork created；`/review` 对测试仓库真实完成。Claude 官方 `--resume <id> --fork-session` 保留原上下文、写入分支专属标记、读取源码并执行 `node --test`，源会话未出现分支标记。工作台“从回复创建分支”仍是上下文重建，两者不混淆 |
| 所有斜杠命令 | 未逐一验证 | 未逐一验证 | 终端提供官方命令入口不等于每条命令已验证；登录、官方远程服务和实验功能仍受外部条件约束 |
| 交互权限审批、计划模式全部转换 | 本轮未完整验证 | 本轮未完整验证 | 当前测试沿用已配置权限。未通过放宽保护或伪造 onboarding 达成验收 |
| Windows 原生 ConPTY / 打包执行 | 本机无法真实执行 | 本机无法真实执行 | 共享源码同步与边界检查另行执行，不把 Mac PTY 测试当作 Windows 实机结果 |

## 本轮真实可用性修复（2026-10-11）

1. **能力声明不再等同于端点实测。** 新增原生功能诊断接口数据，能力面板不再把 manifest 的 `tools.web=true` 当成当前端点已提供搜索工具。Codex 搜索只有在真实搜索事件和来源 URL 都返回后才标记为通过。
2. **官方启动错误可定位。** 原生终端捕获 Claude 官方启动输出中的 `api.anthropic.com: Status 403`，显示“官方初始化阻断”，并提示网络、代理、服务区域和认证检查；不会伪造 Teams 成功状态，也不会把普通插件会话判为不可用。
3. **Claude 原生 fork 使用官方协议。** 原生终端对已有 Claude 会话提供 `--resume <id> --fork-session` 选项；实测会话 ID 与源不同，分支标记只存在于分支 transcript，且源码测试通过；没有会话时拒绝创建空分支。该选项复用官方 CLI，会话 ID 与工作台任务保持隔离。
4. **Windows ConPTY 验证门槛前移。** 原生终端边界测试增加 `.cmd/.bat` 拒绝、官方 `.exe` 接受、输入、缩放、退出和租约释放；Windows CI 使用 Node 24，Windows 实机仍需安装包级验收。

本轮可见工作台复测：Claude 网关 Bearer 认证已真实进入官方交互 CLI、Teams 创建与通信；fork 也已真实完成。官方结构化 shutdown schema 仍被 CLI 拒绝，普通文字停止后成员保持 `available`，因此该项保留受限结论。Codex `search_query` 经 `/alpha/search` 兼容桥真实返回官方 URL，并在重启后的第二轮复测通过。基础任务与业务文件没有改动，终端回放和搜索结果留在指定测试目录。

### 真实回归补充

- `reports/codex-search-final-check.json`：工作台重启后，Codex `search_query` 返回 `developers.openai.com/codex/config-reference`，并完成 `node --test`（1/1）。
- `reports/claude-fork-isolation-check.json`：Claude fork 退出码 0，分支专属 marker 不在源会话 transcript 中。
- `claude/native-auth-final-regression.md`：重启后 Claude 普通会话真实读取源码并通过测试；本轮新会话没有前一轮 marker，报告明确记录 `NOT RECALLED`，没有读取私有 transcript 冒充恢复成功。
- 原生 Codex Responses 兼容桥对 `/responses/compact` 做透明透传，避免搜索适配削弱长会话；认证、SSE、取消、大小限制和上游错误均有边界测试。
- 原生 Claude 认证在 process、session、委派、编排和终端路径统一保留 Bearer/API Key 选择；子进程实测不存在旧环境凭据串用。
- 原生会话在同一 CLI 路径、版本、适配器下只因能力声明变化不会清空上下文；CLI、路径、适配器或 ACP 变化仍触发安全重建。
- `reports/claude-capability-resume-before.json` / `after.json`：旧控制任务在修复后的可见工作台继续运行，原生会话 ID 保持不变，真实召回 `CONTROL-CLAUDE-20261011`，无文件/私有 transcript 读取。这是原生恢复验收，前述新建上下文失败轮继续保留。

Mac `npm run typecheck`、`npm run build` 与完整离线回归通过，新增 PTY 测试实际完成输入、缩放和退出；Windows ConPTY 本机无法执行，不能因此标为通过。当前工作台模型目录探测返回 Claude 11 个、Codex 10 个模型；兼容网关仍有偶发上游重试/超时，不将某次健康状态等同于永久服务保证。

Codex 连接验证的旧 30 秒超时也会阻挡实际可用账号：本轮真实业务已成功，短探测却两次超时。探测改用低推理预算（支持该参数的模型）和 60 秒超时后，真实请求在约 35.2 秒返回成功，账号恢复 ready。业务任务仍使用用户自己的模型/推理强度；没有放宽权限，也没有伪造连接健康状态。

## 发现与修复

1. **Claude 中间 result 提前结束后台工作。** 旧逻辑把一次模型 turn 的 result 当成整个执行完成，后台子 Agent 未返回就释放主进程。新增后台任务跟踪，处理 authoritative snapshot、task notification、queued turn，排除 ambient watcher；等待真实通知后的最终 result。
2. **子 Agent 流污染主任务工具计数。** 新 CLI 混合输出子 Agent 的 assistant、工具与流事件，导致主任务误判工具未完成并触发额外补救。按 parent tool / agent 标识隔离，子 Agent 内容仍从自己的 transcript 读取。
3. **用户消息缺少来源标识。** 真实用户输入带 `origin.kind=human`，允许原生 Workflow 的 human opt-in；工作台自动续接、自动验收、定时运行保留 auto-continuation，不伪装用户意图。
4. **结构化 Workflow 子 Agent 被显示为已中断。** 成功的 `toolEndsTurn` 结构化工具结果也是官方终态，不能只看 `end_turn`。失败结果仍区分为失败，普通工具结果不据此推断完成。
5. **启动工具卡和 transcript 卡竞争。** 通过 tool-use / Agent identity 复用卡片，清理重复的紧凑启动卡；迟到工具结果不覆盖权威原生生命周期。近期历史卡在后台有限回填，读取 GET 不产生状态写入。更新身份后重建消息索引。
6. **官方交互能力没有入口。** 新增按 capability 开放的官方 CLI 终端，支持 Claude 实验 Teams 入口及 Codex 原生命令。终端不依赖 Meta 委派或编排协议；不允许 HTTP 传入可执行程序、任意 argv 或环境配置。
7. **原生 PTY 与终端稳定性。** 修复可信安装包 spawn-helper 的执行位；生产安装在签名前准备。终端带 owner 隔离、实例校验、顺序输入、有限回放、四实例上限、结束记录上限、慢 SSE 客户端断开重放与关闭期间启动处理。MCP 凭据从 argv 移至环境变量，冲突拒绝，避免覆盖 Provider 配置。
8. **视觉与声明准确性。** 修复窄屏关闭按钮溢出、终端效果清理和回放游标；升级 xterm 6，清理旧 Vite 预构建后复查。将“原生能力”改为“原生适配”，明确声明与实测的区别；原生子 Agent、协作插件、编排插件分别展示。Agent 抽屉辅助字号符合既有 11px 基线。
9. **编排首次切回对话误报任务不存在。** 后端已创建会话，前端刷新完成后仍使用 React 尚未提交的旧任务列表。导航直接接收本次刷新响应中的目标摘要，保留原有导航代次检查。全新任务首次切换真实通过，显示编排交接卡，再切回原编排成功。

## 特色插件独立回归

- **Codex 主脑 → Codex / Claude 子 Agent**：`task_c0530973-82ff-418c-a959-a6ceee7656ae`，两个桥接任务完成，真实读取同一 README marker，工作台自动恢复并验收。
- **Claude 主脑 → Codex / Claude 子 Agent**：`task_322ad661-a5e5-4f16-bae6-583c176ab558`，两个桥接任务完成，自动验收通过。此类自动续接带 auto-continuation。
- 首次回归测试仅在 `/run` 请求体传 mode，而真实接口由工作区配置决定，因此首次运行仍是原生模式、没有桥接。纠正测试设置后再测通过，未将错误设置当作插件缺陷。
- **Meta 编排插件**：`workflow_baeaf871-1638-4067-ad8d-c3cd2307010a`，Claude 只读规划，Codex 修复，Claude 只读审查，标准整合验收完成。业务 `executionRoot` 为原项目根，无额外任务目录；此测试与 Claude 原生 Workflow 不是同一能力。
- 测试主机保持 Mac 分支，4339 可看到全部保留任务与日志。
- 新增 `首次模式衔接回归` 可见任务，在未规划、没有模型调用的状态下验证首次创建对话的导航边界；已完成业务编排另行验证成果交接。

## 自动验证与提交范围

- `npm run test:ci`：136 项完整离线测试通过，包含构建、原有 Provider / 编排 / 插件边界及新增后台生命周期、原生终端、搜索兼容、原生会话连续性测试。
- 新后台 fixture 实际启动子进程，覆盖中间 result、后台通知、最终 result、子工具隔离、用户来源和结构化终态。
- 新终端测试覆盖 owner 隔离、缺失请求 body、替换实例 SSE、回放截断、容量与关闭期间启动；并实际运行已安装 PTY 执行 Node。
- 最终 `npm run typecheck`、`npm run build` 与相关边界复测需通过后提交。变更为 shared，Windows main 应 cherry-pick 后独立检查；Windows 实机运行另行记录。
- 提交前扫描 110 个源文件和本地实测文件，与现有凭据库比对，配置中的凭据匹配数为 0。真实任务数据、日志、终端回放和截图保留在用户测试目录，不进入仓库。

## 官方参考与后续验收门槛

- [Codex 配置基础（官方 OpenAI Docs）](https://developers.openai.com/codex/config-advanced/)
- [Codex 配置参考（官方 OpenAI Docs）](https://developers.openai.com/codex/config-reference/)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Agent Teams](https://code.claude.com/docs/en/agent-teams)：实验性，仅交互式 CLI，不能用 headless 子 Agent 冒充。
- [Claude Dynamic Workflows](https://code.claude.com/docs/en/workflows)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript)

下一轮完整验收需要：验证 Claude Agent Teams 官方结构化成员关闭协议；在官方 Provider 直接暴露新版搜索协议时取消兼容桥并复测新版 filters/专用命令；完整计划/权限审批、长期后台能力与 Windows ConPTY 实机测试仍需逐项验证。当前无法消除的外部限制保持受限结论，不能靠伪造状态或降低权限要求标记成功。
