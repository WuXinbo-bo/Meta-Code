import type { AgentProviderId } from "../agents/types.js";

/** Provider ids are open so a new CLI does not require widening every union. */
export type EngineName = AgentProviderId;

export type EngineUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export type EngineRuntimeStatus = {
  available: boolean;
  source: "configured" | "bundled" | "runtime" | "system" | "missing";
  path: string;
  version: string;
  npmAvailable: boolean;
  networkRequired: boolean;
  message: string;
};

export type NormalizedEngineEvent = {
  type: "session.started" | "turn.started" | "assistant" | "reasoning" | "tool.started" | "tool.completed" | "turn.completed" | "status" | "error";
  sourceId?: string;
  text: string;
  toolName?: string;
  sessionId?: string;
  usage?: EngineUsage;
  payload?: unknown;
  category?: string;
  phase?: "started" | "running" | "completed" | "failed";
  detail?: unknown;
  /** Open provider event name retained for forward compatibility. */
  rawType?: string;
};
