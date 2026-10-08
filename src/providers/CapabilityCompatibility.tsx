import { CheckCircle2, CircleAlert, LoaderCircle, ShieldCheck, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProviderCapabilityMode, ProviderCapabilityRestriction, ProviderCapabilitySnapshot, ProviderControlSnapshot } from "./types";

const MODE_LABELS: Record<ProviderCapabilityMode, string> = {
  native: "原生能力",
  managed: "工作台托管",
  degraded: "能力受限"
};

const MODE_DESCRIPTIONS: Record<ProviderCapabilityMode, string> = {
  native: "直接使用 Provider 的原生会话、工具和权限能力",
  managed: "由工作台统一管理会话或协作能力，Provider 能力仍按协商结果开放",
  degraded: "运行时或传输能力未满足要求，部分能力暂不可用"
};

type CapabilityState = {
  snapshot: ProviderCapabilitySnapshot | null;
  loading: boolean;
  error: string;
};

function restrictionText(item: ProviderCapabilityRestriction) {
  if (typeof item === "string") return item;
  return item.reason || item.capability || "当前能力受限";
}

function runtimeMessage(snapshot: ProviderCapabilitySnapshot | null) {
  const probe = snapshot?.runtimeProbe;
  if (!probe) return "";
  if (probe.available === false) return probe.error || probe.message || "运行时不可用";
  return [probe.version, probe.source].filter(Boolean).join(" · ");
}

/** Keep a usable fallback while the runtime capability handshake is loading. */
export function capabilitySnapshotForControl(control: ProviderControlSnapshot): ProviderCapabilitySnapshot {
  const degraded = !control.lifecycle.runtimeAvailable || control.connection.status === "unavailable";
  const mode: ProviderCapabilityMode = degraded ? "degraded" : control.identity.transport === "acp" ? "managed" : "native";
  const reasons = degraded ? [control.lifecycle.message || control.connection.message || "Provider 运行时不可用"] : [];
  return {
    schemaVersion: 1,
    providerId: control.providerId,
    mode,
    requestedMode: mode === "degraded" ? "native" : mode,
    effectiveCapabilities: control.capabilities,
    runtimeProbe: { available: !degraded, status: degraded ? "unavailable" : "unknown", version: control.lifecycle.version, source: control.lifecycle.source },
    degradedReasons: reasons,
    restrictions: reasons.map((reason) => ({ capability: "runtime", reason, scope: "runtime" })),
    modes: {
      native: { available: !degraded, restrictions: [], reasons: [] },
      managed: { available: !degraded, restrictions: [], reasons: [] },
      degraded: { available: degraded, restrictions: reasons, reasons }
    }
  };
}

function normalizeSnapshot(value: unknown, providerId: string): ProviderCapabilitySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as ProviderCapabilitySnapshot;
  const legacy = value as { descriptor?: { capabilities?: ProviderCapabilitySnapshot["nativeCapabilities"] } };
  const mode: ProviderCapabilityMode = candidate.mode
    || (candidate.runtimeProbe?.available === false ? "degraded" : undefined)
    || (candidate.modes?.native?.available ? "native" : undefined)
    || (candidate.modes?.managed?.available ? "managed" : "degraded");
  return {
    ...candidate,
    providerId: String(candidate.providerId || providerId),
    mode,
    nativeCapabilities: candidate.nativeCapabilities || legacy.descriptor?.capabilities,
    effectiveCapabilities: candidate.effectiveCapabilities || candidate.nativeCapabilities || legacy.descriptor?.capabilities
  };
}

/** Fetch the negotiated capability snapshot only while its owning surface is visible. */
export function useProviderCapabilitySnapshot(providerId: string, enabled = true, fallback: ProviderCapabilitySnapshot | null = null): CapabilityState {
  const [state, setState] = useState<CapabilityState>({ snapshot: fallback, loading: false, error: "" });
  const fallbackKey = fallback ? [fallback.providerId, fallback.mode, fallback.runtimeProbe?.available, fallback.runtimeProbe?.version, ...(fallback.degradedReasons || [])].join("|") : "";
  useEffect(() => {
    if (!enabled || !providerId) {
      setState((current) => ({ ...current, snapshot: fallback, loading: false }));
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, snapshot: fallback || current.snapshot, loading: true, error: "" }));
    fetch(`/api/agent-providers/${encodeURIComponent(providerId)}/capabilities`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `能力协商失败（HTTP ${response.status}）`);
        return payload;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setState({ snapshot: normalizeSnapshot(payload, providerId) || fallback, loading: false, error: "" });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setState((current) => ({ snapshot: current.snapshot || fallback, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
      });
    return () => controller.abort();
  }, [providerId, enabled, fallbackKey]);
  return state;
}

export function CapabilityModeBadge({ snapshot, loading = false }: { snapshot: ProviderCapabilitySnapshot | null; loading?: boolean }) {
  const mode = snapshot?.mode || "degraded";
  const Icon = mode === "native" ? ShieldCheck : mode === "managed" ? Workflow : CircleAlert;
  const reasons = snapshot?.degradedReasons || snapshot?.modes?.[mode]?.reasons || [];
  const title = loading ? "正在读取能力协商结果" : [MODE_LABELS[mode], MODE_DESCRIPTIONS[mode], ...reasons].join(" · ");
  return <span className={`capability-mode-badge mode-${mode}`} title={title} aria-label={title}>
    {loading ? <LoaderCircle className="spin" size={12} /> : <Icon size={12} />}
    <span>{loading ? "检测能力" : MODE_LABELS[mode]}</span>
  </span>;
}

function capabilitySummary(snapshot: ProviderCapabilitySnapshot) {
  const capabilities = snapshot.effectiveCapabilities || snapshot.nativeCapabilities || snapshot.workbenchCapabilities;
  if (!capabilities) return [];
  const labels: Array<[string, boolean]> = [
    ["会话", Boolean(capabilities.sessions?.create)],
    ["流式执行", Boolean(capabilities.execution?.stream)],
    ["读取工作区", Boolean(capabilities.workspace?.read)],
    ["写入工作区", Boolean(capabilities.workspace?.write)],
    ["终端", Boolean(capabilities.tools?.shell)],
    ["联网", Boolean(capabilities.tools?.web)],
    ["MCP", Boolean(capabilities.tools?.mcp)],
    ["委派", Boolean(capabilities.delegation?.worker || capabilities.delegation?.nativeSubagents)],
    ["任务编排", Boolean(capabilities.workflow?.planner || capabilities.workflow?.worker)]
  ];
  return labels;
}

export function CapabilityCompatibilityPanel({ snapshot, loading = false, error = "" }: { snapshot: ProviderCapabilitySnapshot | null; loading?: boolean; error?: string }) {
  const summary = useMemo(() => snapshot ? capabilitySummary(snapshot) : [], [snapshot]);
  const restrictions = snapshot?.restrictions || snapshot?.modes?.[snapshot.mode || "degraded"]?.restrictions || [];
  const reasons = [...new Set([...(snapshot?.degradedReasons || []), ...restrictions.map(restrictionText)])].filter(Boolean);
  if (!snapshot && loading) return <div className="capability-compat-panel capability-compat-loading"><LoaderCircle className="spin" size={13} />正在读取能力协商结果</div>;
  return <section className="capability-compat-panel" aria-label="Provider 能力兼容">
    <header>
      <div><strong>能力兼容</strong><small>按当前运行时与传输协议协商</small></div>
      <CapabilityModeBadge snapshot={snapshot} loading={loading} />
    </header>
    {runtimeMessage(snapshot) && <p className="capability-compat-runtime">运行时 {runtimeMessage(snapshot)}</p>}
    {summary.length > 0 && <div className="capability-compat-grid">{summary.map(([label, available]) => <span className={available ? "available" : "unavailable"} key={label}>{available ? <CheckCircle2 size={11} /> : <CircleAlert size={11} />}{label}</span>)}</div>}
    {reasons.length > 0 && <ul className="capability-compat-restrictions">{reasons.slice(0, 4).map((reason) => <li key={reason}><CircleAlert size={11} />{reason}</li>)}</ul>}
    {error && !reasons.length && <p className="capability-compat-error">暂时无法刷新能力状态：{error}</p>}
  </section>;
}
