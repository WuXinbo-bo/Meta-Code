import type { ActivityPhase, CanonicalActivityRecord } from "./types.js";

export type ActivityLifecycleEntry = {
  id?: string;
  sourceId?: string;
  eventType?: string;
  eventPhase?: "started" | "updated" | "completed";
  activityCategory?: string;
  activityPhase?: ActivityPhase;
  kind?: string;
  category?: string;
  phase?: ActivityPhase;
  activity?: CanonicalActivityRecord;
};

function entryIdentities(entry: ActivityLifecycleEntry) {
  return new Set([entry.id, entry.sourceId, entry.activity?.id, entry.activity?.sourceId].filter((value): value is string => Boolean(value)));
}

function isReasoningEntry(entry: ActivityLifecycleEntry) {
  return entry.activityCategory === "reasoning"
    || entry.category === "reasoning"
    || entry.activity?.semanticType === "reasoning"
    || entry.kind === "reasoning"
    || entry.eventType === "reasoning"
    || entry.eventType === "assistant.thinking";
}

function isOpenEntry(entry: ActivityLifecycleEntry) {
  const phase = entry.activityPhase ?? entry.phase ?? entry.activity?.phase;
  return phase === undefined || phase === "started" || phase === "running";
}

/**
 * Reasoning streams do not emit their own terminal event on every provider.
 * The next distinct activity is therefore the provider-neutral completion
 * boundary. Mutating the stored entry keeps every renderer and API consumer in
 * agreement while preserving the original reasoning record.
 */
export function settleSupersededReasoning(entries: ActivityLifecycleEntry[], incomingIdentity?: string) {
  let settled = 0;
  for (const entry of entries) {
    if (!isReasoningEntry(entry) || !isOpenEntry(entry)) continue;
    if (incomingIdentity && entryIdentities(entry).has(incomingIdentity)) continue;
    if ("activityPhase" in entry || "activityCategory" in entry || "eventType" in entry) entry.activityPhase = "completed";
    if ("phase" in entry || "category" in entry || "kind" in entry) entry.phase = "completed";
    if ("eventPhase" in entry) entry.eventPhase = "completed";
    if (entry.activity) entry.activity = { ...entry.activity, phase: "completed" };
    settled += 1;
  }
  return settled;
}
