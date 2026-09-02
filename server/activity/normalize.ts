import crypto from "node:crypto";
import { compactActivityDetail } from "./redaction.js";
import { CURRENT_ACTIVITY_SCHEMA_VERSION, type ActivityActor, type ActivityPhase, type ActivityProvider, type ActivityRecordInput, type ActivitySemanticType, type CanonicalActivityRecord } from "./types.js";

const SEMANTIC_TYPES = new Set<ActivitySemanticType>(["message", "reasoning", "command", "file", "read", "search", "mcp", "tool", "todo", "status", "result", "error", "unknown"]);
const PHASES = new Set<ActivityPhase>(["started", "running", "completed", "failed"]);
const ACTOR_KINDS = new Set<ActivityActor["kind"]>(["main", "native", "delegated", "workflow", "unknown"]);

function validTime(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** Runtime boundary used for new events and legacy persisted records. Never throws on malformed input. */
export function normalizeCanonicalActivity(value: ActivityRecordInput | unknown): CanonicalActivityRecord {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const semantic = SEMANTIC_TYPES.has(source.semanticType as ActivitySemanticType) ? source.semanticType as ActivitySemanticType : "unknown";
  const providerValue = typeof source.provider === "string" ? source.provider.trim().toLowerCase() : "";
  const provider = (/^[a-z][a-z0-9._-]{0,63}$/.test(providerValue) ? providerValue : "unknown") as ActivityProvider;
  const phase = PHASES.has(source.phase as ActivityPhase) ? source.phase as ActivityPhase : semantic === "error" ? "failed" : "started";
  const actorSource = source.actor && typeof source.actor === "object" && !Array.isArray(source.actor) ? source.actor as Record<string, unknown> : {};
  const actorKind = ACTOR_KINDS.has(actorSource.kind as ActivityActor["kind"]) ? actorSource.kind as ActivityActor["kind"] : "unknown";
  const rawType = text(source.rawType, "unknown");
  const title = text(source.title, semantic === "error" ? "执行失败" : semantic === "unknown" ? "未识别活动" : "状态更新");
  return {
    schemaVersion: CURRENT_ACTIVITY_SCHEMA_VERSION,
    id: text(source.id, `activity-${crypto.randomUUID()}`),
    ...(typeof source.sourceId === "string" && source.sourceId ? { sourceId: source.sourceId } : {}),
    rawType,
    provider,
    actor: {
      kind: actorKind,
      ...(typeof actorSource.id === "string" && actorSource.id ? { id: actorSource.id } : {}),
      ...(typeof actorSource.parentId === "string" && actorSource.parentId ? { parentId: actorSource.parentId } : {}),
      ...(typeof actorSource.name === "string" && actorSource.name ? { name: actorSource.name } : {})
    },
    ...(source.scope && typeof source.scope === "object" && !Array.isArray(source.scope) ? { scope: source.scope as CanonicalActivityRecord["scope"] } : {}),
    semanticType: semantic,
    phase,
    ...(typeof source.sequence === "number" && Number.isFinite(source.sequence) ? { sequence: source.sequence } : {}),
    occurredAt: validTime(source.occurredAt),
    title,
    summary: text(source.summary, title),
    ...(source.detail !== undefined ? { detail: compactActivityDetail(source.detail) } : {}),
    ...(Array.isArray(source.artifactRefs) ? { artifactRefs: source.artifactRefs as CanonicalActivityRecord["artifactRefs"] } : {}),
    ...(Array.isArray(source.diagnostics) ? { diagnostics: source.diagnostics as CanonicalActivityRecord["diagnostics"] } : {})
  };
}

export function canonicalActivity(input: ActivityRecordInput) {
  return normalizeCanonicalActivity(input);
}
