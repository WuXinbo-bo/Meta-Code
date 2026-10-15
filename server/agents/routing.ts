import type { AgentDescriptor, AgentProviderId } from "./types.js";

/** A provider selection policy used by cross-provider delegation and review. */
export type AgentRoutingPolicy = {
  strategy: "explicit" | "balanced" | "reliability" | "latency" | "cost";
  preferredProviders?: AgentProviderId[];
  fallbackProviders?: AgentProviderId[];
  requiredCapabilities?: string[];
};

export type AgentRouteCandidate = {
  providerId: AgentProviderId;
  score: number;
  reasons: string[];
};

export type AgentRouteResult = {
  requestedProvider: AgentProviderId | "auto";
  selectedProvider: AgentProviderId;
  candidates: AgentRouteCandidate[];
  policy: AgentRoutingPolicy;
};

function unique(values: readonly string[]) {
  return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
}

/**
 * Resolve an explicit provider or choose a healthy capability-compatible
 * provider. The deterministic score makes automatic routing reproducible and
 * keeps provider selection visible in task receipts.
 */
export function resolveAgentRoute(
  requestedProvider: AgentProviderId | "auto",
  descriptors: readonly AgentDescriptor[],
  policy: AgentRoutingPolicy = { strategy: "balanced" }
): AgentRouteResult {
  const required = unique(policy.requiredCapabilities || []);
  const preferred = unique(policy.preferredProviders || []);
  const fallback = unique(policy.fallbackProviders || []);
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id.toLowerCase(), descriptor]));
  const explicit = requestedProvider !== "auto" ? byId.get(String(requestedProvider).toLowerCase()) : undefined;
  if (requestedProvider !== "auto") {
    if (!explicit) throw new Error(`未注册的 Agent Provider：${requestedProvider}`);
    return {
      requestedProvider,
      selectedProvider: explicit.id,
      policy: structuredClone(policy),
      candidates: [{ providerId: explicit.id, score: 1_000, reasons: ["用户明确指定"] }]
    };
  }
  const candidates = descriptors
    .filter((descriptor) => descriptor.capabilities.sessions.create && descriptor.capabilities.execution.stream)
    .map((descriptor) => {
      let score = descriptor.capabilities.workspace.write ? 20 : 0;
      const reasons: string[] = [];
      if (descriptor.capabilities.workspace.write) reasons.push("支持工作区写入");
      for (const requirement of required) {
        const value = requirement.split(".").filter(Boolean).reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, descriptor.capabilities);
        if (value !== true) score -= 10_000;
        else { score += 30; reasons.push(`满足 ${requirement}`); }
      }
      const preferenceIndex = preferred.indexOf(descriptor.id.toLowerCase());
      if (preferenceIndex >= 0) { score += 500 - preferenceIndex; reasons.push("符合首选 Provider"); }
      const fallbackIndex = fallback.indexOf(descriptor.id.toLowerCase());
      if (fallbackIndex >= 0) { score += 100 - fallbackIndex; reasons.push("符合备用 Provider"); }
      if (policy.strategy === "reliability" && descriptor.capabilities.execution.cancel) { score += 25; reasons.push("支持可靠取消"); }
      if (policy.strategy === "latency" && descriptor.capabilities.execution.stream) { score += 25; reasons.push("支持流式输出"); }
      if (policy.strategy === "cost" && descriptor.capabilities.configuration.reasoningEffort) { score += 10; reasons.push("支持精细推理档位"); }
      return { providerId: descriptor.id, score, reasons };
    })
    .filter((candidate) => candidate.score > -1_000)
    .sort((left, right) => right.score - left.score || left.providerId.localeCompare(right.providerId));
  const selected = candidates[0];
  if (!selected) throw new Error("没有满足当前能力要求的 Agent Provider");
  return { requestedProvider, selectedProvider: selected.providerId, candidates, policy: structuredClone(policy) };
}

export function crossProviderReviewPair(
  primary: AgentProviderId,
  descriptors: readonly AgentDescriptor[],
  preferredReviewer?: AgentProviderId
) {
  const reviewer = resolveAgentRoute(preferredReviewer || "auto", descriptors, {
    strategy: "reliability",
    preferredProviders: preferredReviewer ? [preferredReviewer] : descriptors.map((item) => item.id).filter((id) => id !== primary),
    requiredCapabilities: ["sessions.create", "execution.stream"]
  });
  if (reviewer.selectedProvider === primary) {
    const alternative = descriptors.find((descriptor) => descriptor.id !== primary && descriptor.capabilities.sessions.create);
    if (!alternative) throw new Error("交叉审查至少需要两个可创建主任务的 Provider");
    return { primary, reviewer: alternative.id };
  }
  return { primary, reviewer: reviewer.selectedProvider };
}
