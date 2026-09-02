import type { AgentReasoningControl } from "../agents/types";
import type { AcpConfigChoice, AcpConfigOption } from "./types";

const CATEGORY_ORDER: Record<string, number> = {
  model: 0,
  thought_level: 1,
  reasoning: 1,
  mode: 2
};

export function flattenAcpConfigChoices(option: AcpConfigOption): AcpConfigChoice[] {
  return (option.options || []).flatMap((item) => "options" in item ? item.options : [item]);
}

export function orderedAcpConfigOptions(options: AcpConfigOption[]) {
  return [...options].sort((left, right) => {
    const leftOrder = CATEGORY_ORDER[left.category || ""] ?? 10;
    const rightOrder = CATEGORY_ORDER[right.category || ""] ?? 10;
    return leftOrder - rightOrder || left.name.localeCompare(right.name);
  });
}

export function reasoningChoices(control: AgentReasoningControl): Array<{ value: string; label: string }> {
  if (control.type !== "enum") return [];
  return [...control.options]
    .sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0))
    .map((option) => ({ value: option.value, label: option.label }));
}

export function acpConfigurationSummary(options: AcpConfigOption[], fallback: string) {
  const primary = orderedAcpConfigOptions(options)
    .filter((option) => ["model", "thought_level", "reasoning", "mode"].includes(option.category || ""))
    .slice(0, 2)
    .map((option) => {
      if (option.type === "boolean") return option.currentValue ? option.name : "";
      return flattenAcpConfigChoices(option).find((choice) => choice.value === option.currentValue)?.name || String(option.currentValue || "");
    })
    .filter(Boolean);
  return primary.length ? primary.join(" · ") : fallback;
}
