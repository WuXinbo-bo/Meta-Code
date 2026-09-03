import type { SessionInventoryItem, SessionSource } from "./types.js";

export type SessionManagementFacet = { id: string; label: string; count: number };

export function sessionManagementFacets(
  items: SessionInventoryItem[],
  providerLabel: (providerId: string) => string,
  sourceLabel: (source: SessionSource) => string
) {
  const summarize = (values: string[], label: (id: string) => string): SessionManagementFacet[] => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts].map(([id, count]) => ({ id, label: label(id), count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  };
  return {
    providers: summarize(items.map((item) => item.provider), providerLabel),
    sources: summarize(items.map((item) => item.source), (source) => sourceLabel(source as SessionSource))
  };
}
