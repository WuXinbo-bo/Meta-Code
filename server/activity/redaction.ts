const MAX_DETAIL_TEXT = 24_000;
const SECRET_KEY = /(?:api[-_]?key|authorization|cookie|password|secret|token)/i;

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return value.length > MAX_DETAIL_TEXT
    ? `${value.slice(0, MAX_DETAIL_TEXT)}\n\n[活动详情过长，已截断]`
    : value;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[循环引用]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((entry) => redact(entry, seen));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    result[key] = SECRET_KEY.test(key) ? "[已隐藏]" : redact(entry, seen);
  }
  return result;
}

/** Keeps persisted activity details bounded and prevents common credentials leaking into logs. */
export function compactActivityDetail(value: unknown) {
  return value === undefined ? undefined : redact(value, new WeakSet());
}

type StoredActivityMessage = {
  activityDetail?: unknown;
  activity?: { detail?: unknown };
};

function serialized(value: unknown) {
  try { return JSON.stringify(value); }
  catch { return undefined; }
}

/**
 * Bounds persisted activity details and removes the legacy duplicate when the
 * canonical activity owns the same information. Unequal legacy details remain
 * available as a rendering fallback during migration.
 */
export function compactStoredActivityDetails(message: StoredActivityMessage) {
  let changed = false;
  const canonicalBefore = message.activity?.detail;
  if (canonicalBefore !== undefined && message.activity) {
    const before = serialized(canonicalBefore);
    const compacted = compactActivityDetail(canonicalBefore);
    const after = serialized(compacted);
    if (before !== after) changed = true;
    message.activity.detail = compacted;
  }

  const legacyBefore = message.activityDetail;
  if (legacyBefore !== undefined) {
    const before = serialized(legacyBefore);
    const compacted = compactActivityDetail(legacyBefore);
    const after = serialized(compacted);
    if (before !== after) changed = true;
    message.activityDetail = compacted;
  }

  if (message.activity?.detail !== undefined && message.activityDetail !== undefined) {
    const canonical = serialized(message.activity.detail);
    if (canonical !== undefined && canonical === serialized(message.activityDetail)) {
      delete message.activityDetail;
      changed = true;
    }
  }
  return changed;
}
