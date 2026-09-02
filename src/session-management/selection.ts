export type RangeSelectionInput = {
  orderedIds: string[];
  selectedIds: ReadonlySet<string>;
  clickedId: string;
  anchorId: string | null;
  toggle: boolean;
  range: boolean;
};

export type RangeSelectionResult = {
  selectedIds: Set<string>;
  anchorId: string | null;
};

export function updateRangeSelection(input: RangeSelectionInput): RangeSelectionResult {
  const { orderedIds, clickedId, toggle, range } = input;
  if (!orderedIds.includes(clickedId)) return { selectedIds: new Set(input.selectedIds), anchorId: input.anchorId };

  if (range) {
    const anchor = input.anchorId && orderedIds.includes(input.anchorId) ? input.anchorId : clickedId;
    const start = orderedIds.indexOf(anchor);
    const end = orderedIds.indexOf(clickedId);
    const rangeIds = orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1);
    return {
      selectedIds: toggle ? new Set([...input.selectedIds, ...rangeIds]) : new Set(rangeIds),
      anchorId: anchor
    };
  }

  if (toggle) {
    const selectedIds = new Set(input.selectedIds);
    if (selectedIds.has(clickedId)) selectedIds.delete(clickedId);
    else selectedIds.add(clickedId);
    return { selectedIds, anchorId: clickedId };
  }

  return { selectedIds: new Set([clickedId]), anchorId: clickedId };
}

export function retainAvailableSelection(selectedIds: ReadonlySet<string>, availableIds: ReadonlySet<string>) {
  return new Set([...selectedIds].filter((id) => availableIds.has(id)));
}
