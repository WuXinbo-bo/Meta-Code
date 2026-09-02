export type MessageWindow = {
  start: number;
  end: number;
  total: number;
  hasMore: boolean;
};

export function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function safeMessageText(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

export function sliceMessageWindow<T>(messages: T[], before: unknown, limit: unknown, defaultLimit = 80) {
  const total = messages.length;
  const end = boundedInteger(before, total, 0, total);
  const size = boundedInteger(limit, defaultLimit, 1, 500);
  const start = Math.max(0, end - size);
  return {
    messages: messages.slice(start, end),
    window: { start, end, total, hasMore: start > 0 } satisfies MessageWindow
  };
}
