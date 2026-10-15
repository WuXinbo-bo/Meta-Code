import type { RuntimeExecutionIdentity } from "./types.js";

/** Native CLIs own their persisted transcripts. A workbench capability/UI
 * declaration update does not invalidate that transcript format. ACP keeps
 * the stricter negotiated-capability boundary; actual CLI/adapter changes
 * also retain the existing reset policy.
 */
export function canResumeNativeSession(previous: RuntimeExecutionIdentity, current: RuntimeExecutionIdentity) {
  return ["codex", "claude"].includes(current.providerId)
    && previous.providerId === current.providerId
    && previous.runtimeId === current.runtimeId
    && previous.adapterId === current.adapterId
    && Boolean(previous.path && previous.version)
    && previous.path === current.path
    && previous.version === current.version;
}
