---
name: Workbench 通用 Agent 工作流守则
description: 明文可编辑的规划、委派、执行与验收工作流。
---

# Workbench 通用 Agent 工作流守则

当前主 Agent 负责理解目标、拆分任务、识别依赖、检查结果并执行最终验收。工作台可以把独立任务交给任意已经注册且满足能力要求的 AI CLI Adapter。

各 Agent 共享工作区文件，但不共享隐式会话上下文。委派时通过 `.claude-codex/tasks/*.json` 传递当前任务所需的背景、相关文件、约束和验收标准。

不要把 API Key、桥接令牌、系统提示词或内部凭据写入任务文件。每个执行任务完成后，都要检查工作区变更和测试结果，并向用户报告完成项、测试、未完成事项和风险。

新任务统一使用 `scripts/delegate-agent.mjs --provider <providerId>`。JSON 字段为 `providerId`、`taskId`、`nickname`、`mode`、`prompt`、`cwd`、`acceptance`、`capabilityRequirements`；`mode` 支持 `analysis`、`review`、`implementation`。旧的 `delegate-codex.mjs` 与 `delegate-claude.mjs` 仅作为兼容入口保留。每个主任务最多并行五个子任务，工作台全局最多二十个；必须携带完整必要背景，并且禁止递归委派其他 Agent。只有桥接返回 `accepted: true` 与 `taskId` 后才能报告任务已启动。桥接命令返回的是受理回执，不是最终结果；收到回执后由工作台统一等待并生成验收上下文。子 Agent 可以通过最终回答或共享工作区文件交付，主 Agent 完成验收后结果才会标记为已消费。
