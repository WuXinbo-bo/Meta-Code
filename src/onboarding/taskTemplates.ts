/**
 * Small, opinionated task starters for the first successful workspace run.
 * Keep prompts explicit about scope and verification so a new user gets a
 * reviewable result instead of an open-ended conversation.
 */
export type TaskTemplateId = "code-review" | "bug-fix" | "test-coverage" | "dependency-upgrade";

export type TaskTemplate = {
  id: TaskTemplateId;
  label: string;
  description: string;
  prompt: string;
};

export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    id: "code-review",
    label: "代码审查",
    description: "找出风险、回归和缺少的测试",
    prompt: "请审查当前工作区最近的代码变更。先阅读相关上下文，再按严重程度列出具体问题（包含文件和行号），重点检查正确性、回归风险、边界条件与测试覆盖。不要直接修改文件，最后给出建议的验证步骤。"
  },
  {
    id: "bug-fix",
    label: "修复 Bug",
    description: "定位原因、修复并运行验证",
    prompt: "请在当前工作区定位并修复这个问题：\n\n请先复现或确认根因，再用最小范围修改实现修复，补充必要的回归测试，并运行相关测试或静态检查。最后说明修改文件、验证结果和仍存在的风险。"
  },
  {
    id: "test-coverage",
    label: "补全测试",
    description: "围绕真实行为补回归测试",
    prompt: "请检查当前工作区中最重要但测试不足的行为，优先选择近期变更或高风险边界。补充能复现真实用户场景的测试，避免只测试实现细节；运行新增和相关测试，并报告覆盖了哪些风险。"
  },
  {
    id: "dependency-upgrade",
    label: "升级依赖",
    description: "评估兼容性、更新并验证",
    prompt: "请评估当前工作区可安全升级的依赖。先查看锁文件、发布说明和现有约束，说明升级理由与潜在破坏性变化；只在兼容性明确时修改依赖，更新锁文件并运行相关测试或构建，最后汇报变更和风险。"
  }
] as const;
