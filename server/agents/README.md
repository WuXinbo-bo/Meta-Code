# Internal Agent Boundary

The workbench core uses open provider ids and never widens a global
`"claude" | "codex"` union when another CLI is added.

## Responsibilities

- `catalog.ts` describes built-in providers, branding, runtime linkage, Skill
  projection and capabilities.
- `registry.ts` is an internal binding registry for capability checks, execution
  dispatch and cancellation. It is not a third-party extension protocol.
- `types.ts` is the workbench's internal provider-neutral contract. The legacy
  `AgentAdapterV1` name remains for persisted compatibility only; new external
  CLIs must not implement it.
- Provider-specific event streams must be normalized into canonical activity
  records. Unknown event types are retained as `unknown`, not rejected.

## Adding a built-in native provider

1. Use this path only when the product intentionally owns native enhanced
   integration comparable to Codex or Claude.
2. Register its installation definition in `server/runtime/registry.ts`.
3. Add an `AgentDescriptor` whose `runtimeId` and `adapterId` match that
   definition.
4. Bind a delegation adapter. Advertise only capabilities that are implemented.
5. Bind optional main-session and workflow runners before setting the matching
   capabilities to `true`.
6. Add adapter contract fixtures for streaming, cancellation, errors and
   unknown upstream events.

Third-party coding Agents use ACP v1 through `server/providers/acp`. They do
not import or implement workbench internal types.

The UI reads the provider catalog and capabilities. It must not add
provider-specific conditionals for presence, icons or feature visibility;
provider-specific configuration transports remain inside their adapter.
