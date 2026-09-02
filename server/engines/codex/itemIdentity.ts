export function codexItemSourceId(turnId: string, itemId: string) {
  const normalizedTurnId = String(turnId || "").trim();
  const normalizedItemId = String(itemId || "").trim();
  if (!normalizedTurnId) throw new Error("Codex turnId is required for item identity");
  if (!normalizedItemId) throw new Error("Codex itemId is required for item identity");
  return `codex:${normalizedTurnId}:${normalizedItemId}`;
}

