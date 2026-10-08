import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AGENT_ADAPTER_SDK_VERSION,
  type AgentCapabilityMode,
  type AgentCapabilityPatch,
  type AgentCapabilityRestriction,
  type AgentCapabilities,
  type AgentDescriptor,
  type AgentRuntimeProbe,
  type AgentTransportCapabilities,
  type AgentVersionRequirements,
  type AgentCapabilitySnapshot
} from "./types.js";

const execFileAsync = promisify(execFile);

export type AgentRuntimeProbeInput = Partial<AgentRuntimeProbe> & {
  /** Executable to invoke when a runtime probe is required. */
  command?: string;
  args?: string[];
  timeoutMs?: number;
};

export type AgentCapabilitySnapshotOptions = {
  mode?: Exclude<AgentCapabilityMode, "degraded">;
  requestedMode?: Exclude<AgentCapabilityMode, "degraded">;
  transportCapabilities?: Partial<AgentTransportCapabilities>;
  runtimeProbe?: AgentRuntimeProbeInput;
  /** Alias accepted by callers that keep runtime and probe data separate. */
  runtime?: AgentRuntimeProbeInput;
  now?: () => Date;
};

const emptyCapabilities = (): AgentCapabilities => ({
  sessions: { create: false, resume: false, fork: false },
  execution: { stream: false, cancel: false, steer: false },
  workspace: { read: false, write: false },
  tools: { shell: false, web: false, mcp: false },
  delegation: { worker: false, nativeSubagents: false },
  workflow: { planner: false, worker: false },
  configuration: { models: false, reasoningEffort: false, reasoningEffortValues: [], permissionProfile: false }
});

/** Convert a legacy/full capability object plus an optional patch to a safe, complete object. */
export function mergeAgentCapabilities(base: Partial<AgentCapabilities> | undefined, patch?: AgentCapabilityPatch): AgentCapabilities {
  const value = base || {};
  const next = patch || {};
  return {
    sessions: { ...emptyCapabilities().sessions, ...(value.sessions || {}), ...(next.sessions || {}) },
    execution: { ...emptyCapabilities().execution, ...(value.execution || {}), ...(next.execution || {}) },
    workspace: { ...emptyCapabilities().workspace, ...(value.workspace || {}), ...(next.workspace || {}) },
    tools: { ...emptyCapabilities().tools, ...(value.tools || {}), ...(next.tools || {}) },
    delegation: { ...emptyCapabilities().delegation, ...(value.delegation || {}), ...(next.delegation || {}) },
    workflow: { ...emptyCapabilities().workflow, ...(value.workflow || {}), ...(next.workflow || {}) },
    configuration: {
      ...emptyCapabilities().configuration,
      ...(value.configuration || {}),
      ...(next.configuration || {}),
      reasoningEffortValues: next.configuration?.reasoningEffortValues
        ? [...new Set(next.configuration.reasoningEffortValues)]
        : [...(value.configuration?.reasoningEffortValues || [])]
    }
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(now: () => Date) {
  return now().toISOString();
}

function parseVersion(value: string | undefined) {
  const match = String(value || "").match(/(?:^|[^0-9])v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] as const;
}

function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function mergeTransportCapabilities(
  descriptor: AgentDescriptor,
  override?: Partial<AgentTransportCapabilities>
): AgentTransportCapabilities {
  const source = descriptor.transportCapabilities || {};
  const transport = { ...source, ...(override || {}) };
  return {
    kind: transport.kind || "unknown",
    enhanced: Boolean(transport.enhanced),
    standard: transport.standard || "unknown",
    ...(transport.protocolVersion !== undefined ? { protocolVersion: transport.protocolVersion } : {}),
    ...(transport.capabilities ? { capabilities: clone(transport.capabilities) } : {}),
    ...Object.fromEntries(Object.entries(transport).filter(([key]) => !["kind", "enhanced", "standard", "protocolVersion", "capabilities"].includes(key)))
  };
}

function restrictionsFromTransport(
  source: AgentCapabilities,
  effective: AgentCapabilities,
  transport: AgentTransportCapabilities
): AgentCapabilityRestriction[] {
  const restrictions: AgentCapabilityRestriction[] = [];
  const negotiated = transport.capabilities;
  if (!negotiated) return restrictions;
  const sections = ["sessions", "execution", "workspace", "tools", "delegation", "workflow", "configuration"] as const;
  for (const section of sections) {
    const values = negotiated[section];
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      if (value !== false) continue;
      const path = `${section}.${key}`;
      if (source[section][key as never] === true && effective[section][key as never] === false) {
        restrictions.push({ capability: path, reason: "当前传输握手未提供该能力", scope: "transport" });
      }
    }
  }
  return restrictions;
}

function evaluateVersionRequirements(
  descriptor: AgentDescriptor,
  runtime: AgentRuntimeProbe,
  requirements: AgentVersionRequirements
) {
  const reasons: string[] = [];
  if (requirements.minAdapterSdkVersion !== undefined && AGENT_ADAPTER_SDK_VERSION < requirements.minAdapterSdkVersion) {
    reasons.push(`需要 Agent Adapter SDK ${requirements.minAdapterSdkVersion} 或更高版本`);
  }
  if (requirements.runtimeId && requirements.runtimeId !== descriptor.runtimeId) {
    reasons.push(`运行时标识不匹配（需要 ${requirements.runtimeId}）`);
  }
  const minimumRuntimeVersion = requirements.minRuntimeVersion || requirements.minimum;
  if (runtime.version && minimumRuntimeVersion) {
    const comparison = compareVersions(runtime.version, minimumRuntimeVersion);
    if (comparison !== null && comparison < 0) reasons.push(`运行时版本 ${runtime.version} 低于要求的 ${minimumRuntimeVersion}`);
  }
  if (runtime.version && requirements.maxRuntimeVersion) {
    const comparison = compareVersions(runtime.version, requirements.maxRuntimeVersion);
    if (comparison !== null && comparison > 0) reasons.push(`运行时版本 ${runtime.version} 高于支持上限 ${requirements.maxRuntimeVersion}`);
  }
  const features = runtime.details?.features;
  if (Array.isArray(features) && requirements.requiredFeatures?.length) {
    const supported = new Set(features.map((feature) => String(feature)));
    for (const feature of requirements.requiredFeatures) {
      if (!supported.has(feature)) reasons.push(`运行时缺少能力 ${feature}`);
    }
  }
  return reasons;
}

function normalizeRuntimeProbe(input: AgentRuntimeProbeInput | undefined, now: () => Date): AgentRuntimeProbe {
  if (!input) {
    // A descriptor without a probe is a legacy manifest. Keep it usable while
    // making the missing probe visible to callers and the diagnostics UI.
    return {
      status: "unknown",
      available: true,
      checkedAt: nowIso(now),
      details: { assumed: true }
    };
  }
  const available = input.available !== false;
  const status = input.status || (available ? "ready" : "unavailable");
  return {
    status,
    available,
    ...(input.command ? { command: input.command } : {}),
    ...(input.executablePath ? { executablePath: input.executablePath } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(input.source ? { source: input.source } : {}),
    checkedAt: input.checkedAt || nowIso(now),
    ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.details ? { details: clone(input.details) } : {})
  };
}

/** Build a capability snapshot without invoking external processes. */
export function createAgentCapabilitySnapshot(
  descriptor: AgentDescriptor,
  options: AgentCapabilitySnapshotOptions = {}
): AgentCapabilitySnapshot {
  const now = options.now || (() => new Date());
  const requestedMode = options.requestedMode || options.mode || "native";
  const runtime = normalizeRuntimeProbe(options.runtimeProbe || options.runtime, now);
  const transport = mergeTransportCapabilities(descriptor, options.transportCapabilities);
  const nativeCapabilities = mergeAgentCapabilities(descriptor.capabilities, descriptor.nativeCapabilities);
  const workbenchCapabilities = mergeAgentCapabilities(descriptor.capabilities, descriptor.workbenchCapabilities);
  const selected = requestedMode === "managed" ? workbenchCapabilities : nativeCapabilities;
  const negotiatedCapabilities = mergeAgentCapabilities(selected, transport.capabilities);
  const restrictions = [
    ...(descriptor.restrictions ? clone(descriptor.restrictions) : []),
    ...restrictionsFromTransport(selected, negotiatedCapabilities, transport)
  ];
  const degradedReasons = [...(descriptor.degradedReasons || [])];
  if (!runtime.available || runtime.status === "unavailable" || runtime.status === "error") {
    degradedReasons.push(runtime.error || "所选 Agent 运行时不可用");
    restrictions.push({ capability: "runtime", reason: runtime.error || "运行时不可用", scope: "runtime" });
  }
  const versionReasons = evaluateVersionRequirements(descriptor, runtime, descriptor.versionRequirements || {});
  for (const reason of versionReasons) {
    degradedReasons.push(reason);
    restrictions.push({ capability: "runtime.version", reason, scope: "version" });
  }
  const uniqueReasons = [...new Set(degradedReasons.filter(Boolean))];
  const mode: AgentCapabilityMode = uniqueReasons.length ? "degraded" : requestedMode;
  // `effectiveCapabilities` is the admission surface. Once the runtime or a
  // required version is known to be invalid, expose no executable capability;
  // callers can still inspect the native/workbench baselines and reasons.
  const effectiveCapabilities = uniqueReasons.length ? emptyCapabilities() : negotiatedCapabilities;
  const modeRestrictions = (candidate: AgentCapabilityMode) => restrictions.filter((item) => item.scope === candidate || item.scope === "runtime" || item.scope === "version" || item.scope === "transport");
  const modeState = (candidate: AgentCapabilityMode) => ({
    available: candidate === "degraded" ? uniqueReasons.length > 0 : uniqueReasons.length === 0,
    restrictions: modeRestrictions(candidate),
    reasons: candidate === "degraded" ? uniqueReasons : []
  });
  return {
    schemaVersion: 1,
    providerId: descriptor.id,
    mode,
    requestedMode,
    nativeCapabilities,
    workbenchCapabilities,
    transportCapabilities: transport,
    versionRequirements: clone(descriptor.versionRequirements || {}),
    runtimeProbe: runtime,
    restrictions,
    degradedReasons: uniqueReasons,
    modes: {
      native: modeState("native"),
      managed: modeState("managed"),
      degraded: modeState("degraded")
    },
    effectiveCapabilities,
    capturedAt: nowIso(now)
  };
}

async function invokeRuntimeProbe(
  descriptor: AgentDescriptor,
  input: AgentRuntimeProbeInput,
  now: () => Date
): Promise<AgentRuntimeProbe> {
  const started = Date.now();
  const command = input.command || input.executablePath;
  if (!command) return normalizeRuntimeProbe(input, now);
  try {
    const result = await execFileAsync(command, input.args || ["--version"], {
      encoding: "utf8",
      timeout: input.timeoutMs || 8_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const output = `${result.stdout || ""} ${result.stderr || ""}`.trim();
    return normalizeRuntimeProbe({
      ...input,
      command,
      executablePath: input.executablePath || command,
      status: "ready",
      available: true,
      version: input.version || output.match(/\bv?\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?\b/)?.[0] || output || "unknown",
      checkedAt: nowIso(now),
      latencyMs: Date.now() - started,
      details: { ...(input.details || {}), descriptorRuntimeId: descriptor.runtimeId }
    }, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return normalizeRuntimeProbe({
      ...input,
      command,
      executablePath: input.executablePath || command,
      status: "error",
      available: false,
      checkedAt: nowIso(now),
      latencyMs: Date.now() - started,
      error: message,
      details: { ...(input.details || {}), descriptorRuntimeId: descriptor.runtimeId }
    }, now);
  }
}

/** Probe a provider runtime and return a complete, mode-aware snapshot. */
export async function probeAgentCapabilities(
  descriptor: AgentDescriptor,
  options: AgentCapabilitySnapshotOptions = {}
): Promise<AgentCapabilitySnapshot> {
  const now = options.now || (() => new Date());
  const input = options.runtimeProbe || options.runtime;
  const runtime = input?.command || input?.executablePath
    ? await invokeRuntimeProbe(descriptor, input, now)
    : normalizeRuntimeProbe(input, now);
  return createAgentCapabilitySnapshot(descriptor, { ...options, runtimeProbe: runtime, now });
}
