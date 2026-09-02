import { AGENT_ADAPTER_SDK_VERSION, type AgentProviderManifestV1 } from "./types.js";

const enumReasoning = (values: string[], defaultValue: string) => ({
  type: "enum" as const,
  defaultValue,
  options: values.map((value, rank) => ({ value, label: value, rank }))
});

export const BUILTIN_AGENT_DESCRIPTORS: AgentProviderManifestV1[] = [
  {
    sdkVersion: AGENT_ADAPTER_SDK_VERSION,
    id: "claude",
    adapterId: "claude-cli-stream-json",
    runtimeId: "claude",
    displayName: "Claude CLI",
    shortName: "Claude",
    description: "Claude Code 原生会话与工作台委派执行",
    displayOrder: 10,
    branding: { icon: "claude", accent: "#d97757" },
    capabilities: {
      sessions: { create: true, resume: true, fork: false },
      execution: { stream: true, cancel: true, steer: true },
      workspace: { read: true, write: true },
      tools: { shell: true, web: true, mcp: true },
      delegation: { worker: true, nativeSubagents: true },
      workflow: { planner: true, worker: true },
      configuration: { models: true, reasoningEffort: true, reasoningEffortValues: ["low", "medium", "high", "xhigh", "max"], permissionProfile: true }
    },
    configurationSchema: {
      modelSource: "adapter",
      defaultModel: "claude-sonnet-4-5",
      reasoning: enumReasoning(["low", "medium", "high", "xhigh", "max"], "high"),
      fields: [
        { key: "baseUrl", label: "Base URL", type: "text", placeholder: "https://api.anthropic.com" },
        { key: "apiKey", label: "API Key", type: "secret" },
        { key: "permissionMode", label: "权限模式", type: "select", options: [
          { value: "bypassPermissions", label: "完全访问" }, { value: "acceptEdits", label: "自动接受编辑" },
          { value: "default", label: "默认询问" }, { value: "plan", label: "仅计划" }
        ] }
      ]
    },
    skillProjection: { strategy: "claude-home", invocationPrefix: "/", workspacePath: ".claude/skills" }
  },
  {
    sdkVersion: AGENT_ADAPTER_SDK_VERSION,
    id: "codex",
    adapterId: "codex-app-server-sdk",
    runtimeId: "codex",
    displayName: "Codex CLI",
    shortName: "Codex",
    description: "Codex 原生线程与工作台委派执行",
    displayOrder: 20,
    branding: { icon: "openai", accent: "#111111" },
    capabilities: {
      sessions: { create: true, resume: true, fork: true },
      execution: { stream: true, cancel: true, steer: true },
      workspace: { read: true, write: true },
      tools: { shell: true, web: true, mcp: true },
      delegation: { worker: true, nativeSubagents: true },
      workflow: { planner: true, worker: true },
      configuration: { models: true, reasoningEffort: true, reasoningEffortValues: ["minimal", "low", "medium", "high", "xhigh"], permissionProfile: true }
    },
    configurationSchema: {
      modelSource: "adapter",
      defaultModel: "gpt-5.4",
      reasoning: enumReasoning(["minimal", "low", "medium", "high", "xhigh"], "high"),
      fields: [
        { key: "baseUrl", label: "Base URL", type: "text" },
        { key: "apiKey", label: "API Key", type: "secret" },
        { key: "sandboxMode", label: "项目权限", type: "select", options: [
          { value: "danger-full-access", label: "完全访问" }, { value: "workspace-write", label: "仅工作区" },
          { value: "read-only", label: "只读" }
        ] },
        { key: "approvalPolicy", label: "审批", type: "select", options: [
          { value: "never", label: "自动执行" }, { value: "on-request", label: "按需询问" },
          { value: "on-failure", label: "失败时询问" }, { value: "untrusted", label: "仅可信命令自动执行" }
        ] }
      ]
    },
    skillProjection: { strategy: "codex-home", invocationPrefix: "$", workspacePath: ".agents/skills" }
  }
];

export function builtinAgentDescriptor(providerId: string) {
  return BUILTIN_AGENT_DESCRIPTORS.find((item) => item.id === providerId);
}
