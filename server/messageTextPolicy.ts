/** Narrative Markdown must reach the shared paged renderer intact. Tool payloads
 * have a separate bounded-detail/artifact policy and are not narrative messages. */
export function isNarrativeMessage(value: { role?: unknown; eventType?: unknown; activityCategory?: unknown }) {
  return value.role === "user" || value.role === "assistant" || value.eventType === "reasoning"
    || value.activityCategory === "reasoning" || value.activityCategory === "message";
}

export function normalizedEventTextLimit(type: string) {
  return type === "assistant" || type === "reasoning" ? Infinity : type === "tool.completed" ? 100_000 : 80_000;
}
