export type AgentProviderId = string;

export type AgentReasoningControl =
  | { type: "enum"; options: Array<{ value: string; label: string; rank?: number }>; defaultValue?: string }
  | { type: "number"; minimum: number; maximum: number; step: number; defaultValue?: number; unit?: string }
  | { type: "boolean"; defaultValue?: boolean; enabledLabel?: string; disabledLabel?: string }
  | { type: "none" };

export type AgentModelDescriptor = {
  id: string;
  displayName: string;
  description?: string;
  createdAt?: string;
  reasoning?: AgentReasoningControl;
  contextWindow?: number;
  capabilities?: { web?: boolean; mcp?: boolean };
};

export type AgentProviderDescriptor = {
  sdkVersion?: 1;
  id: AgentProviderId;
  adapterId: string;
  runtimeId: string;
  displayName: string;
  shortName: string;
  description: string;
  displayOrder: number;
  capabilities: {
    sessions: { create: boolean; resume: boolean; fork: boolean };
    execution: { stream: boolean; cancel: boolean; steer: boolean };
    workspace: { read: boolean; write: boolean };
    tools: { shell: boolean; web: boolean; mcp: boolean };
    delegation: { worker: boolean; nativeSubagents: boolean };
    workflow: { planner: boolean; worker: boolean };
    configuration: { models: boolean; reasoningEffort: boolean; reasoningEffortValues: string[]; permissionProfile: boolean };
  };
  branding: { icon: string; accent: string };
  skillProjection: { strategy: string; invocationPrefix: string; workspacePath?: string };
  configurationSchema?: {
    modelSource: "adapter" | "static" | "none";
    defaultModel?: string;
    reasoning: AgentReasoningControl;
    models?: AgentModelDescriptor[];
    fields?: Array<{ key: string; label: string; description?: string; type: "text" | "secret" | "boolean" | "select" | "number"; required?: boolean; placeholder?: string; options?: Array<{ value: string; label: string }> }>;
  };
};
