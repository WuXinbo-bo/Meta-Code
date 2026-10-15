/** Native Workflow agents can finish through StructuredOutput instead of end_turn. */
export function claudeTranscriptTerminalState(record: Record<string, unknown>): "completed" | "failed" | undefined {
  const message = record.message as { stop_reason?: unknown; content?: unknown } | undefined;
  if (record.type === "assistant" && message?.stop_reason === "end_turn") return "completed";
  if (record.type === "user" && record.toolEndsTurn === true && Array.isArray(message?.content)) {
    const results = message.content.filter((block) => block && block.type === "tool_result");
    if (results.length) return results.some((block) => block.is_error === true) ? "failed" : "completed";
  }
  return undefined;
}
