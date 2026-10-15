# Provider capability compatibility

Meta Code keeps the complete native Claude and Codex experience as its baseline.
The workbench layers collaboration and orchestration on top of that baseline;
they never silently replace a provider feature. Capability information is
resolved at runtime because a CLI version, transport, installation and
permission profile can all change the available surface.

## Four capability layers

| Layer | Purpose | Typical examples |
| --- | --- | --- |
| P0 | Provider compatibility and safe execution | Native sessions, resume/fork, streaming, cancellation, runtime probes, permission profile, worktree/write isolation, trace IDs |
| P1 | Native integration depth | Hooks, custom agents from `.claude/agents` and `.codex/agents`, provider agent files, scheduled work and session lifecycle controls |
| P2 | Workbench reach | Artifacts, browser/computer tools, MCP/connectors/channels, cost/latency telemetry and reusable policy profiles |
| P3 | Meta Code value | Cross-provider planning/review, routing and fallback, durable evidence, replay/retry, approvals and auditable delivery |

P0 is required before a task is presented as reliable. P1 and P2 expose
provider-native extension points through provider-neutral contracts. P3 is the
reason to use Meta Code instead of opening either CLI on its own.

## Runtime modes

Each session has a capability snapshot and one of these modes:

* **Native** — the provider owns the session and its native tools, subagents and
  workflows are available according to its runtime probe.
* **Managed** — Meta Code owns delegation, approvals, concurrency, logs,
  retries and write isolation. Claude's native `Task`, `Agent` and `Workflow`
  entry points are intentionally intercepted in this mode so they cannot evade
  the workbench protocol.
* **Degraded** — a missing runtime, old CLI, unavailable transport or denied
  permission removes a capability. The reason is retained in the snapshot and
  shown to the user; the workbench never advertises a disabled feature as
  working.

The mode is a policy decision, not a provider identity. A Claude session and a
Codex session can each run in any mode supported by their current capability
snapshot.

## Capability snapshot contract

Adapters should report four groups:

```ts
type CapabilitySnapshot = {
  nativeCapabilities: AgentCapabilities;
  workbenchCapabilities: AgentCapabilities;
  transportCapabilities: Record<string, unknown>;
  versionRequirements: { runtimeId: string; minimum?: string; detectedVersion?: string };
  runtimeProbe: { available: boolean; source: string; message?: string };
  restrictions: Array<{ capability: string; reason: string; scope: string }>;
  degradedReasons: string[];
  modes: Record<"native" | "managed" | "degraded", { available: boolean; restrictions: unknown[]; reasons: string[] }>;
};
```

The snapshot is captured when a session starts and compared before resume. A
changed fingerprint requires a fresh probe, preventing a stale session from
claiming access to a removed tool or writing outside its approved workspace.

## Hooks and custom Agent files

`server/agents/hooks.ts` provides one bounded hook registry for `session`,
`tool`, `permission`, `subagent` and `compact` events. Handlers are ordered by
priority, receive an abort signal, and are isolated: one handler's exception or
timeout is reported in the dispatch result and cannot prevent later handlers
from running. Hook implementations should keep side effects idempotent and
must never put credentials in a payload or diagnostic.

`server/agents/customAgents.ts` reads user and project definitions from:

* `~/.claude/agents/*.md` and `<project>/.claude/agents/*.md` (front matter plus
  Markdown instructions);
* `~/.codex/agents/*.toml` and `<project>/.codex/agents/*.toml` (safe scalar,
  array, table and multiline string subset).

Project definitions override user definitions with the same provider and Agent
ID. Invalid, oversized or unreadable files are skipped with a diagnostic, so a
single malformed file cannot prevent a session from starting. Symlink entries
and paths outside the expected directory are ignored. Parsing does not execute
code or interpolate shell expressions.

## Native and Meta Code responsibilities

Provider adapters remain responsible for native protocol details, model
selection and provider-specific installation. The workbench is responsible for
normalizing events, enforcing capability requirements, permission boundaries,
delegation/orchestration state machines, evidence and recovery. New providers
should implement the shared contracts and capability negotiation instead of
adding provider branches to the UI.
