# Engine Boundary

The product persists engine-neutral sessions and dispatches each turn by the
open `session.engine` provider id. Provider metadata and capabilities live in
`server/agents`; this directory contains only provider-specific runners and
event normalization.

- `types.ts` defines the normalized runtime, usage, and event contracts consumed by the server.
- `claude/` owns Claude CLI discovery, installation, process execution, UTF-8 stdin, and Stream JSON normalization.
- Codex remains backed by `@openai/codex-sdk`; its existing runtime and rollout readers are intentionally preserved while sessions migrate through the same `engine` and `engineSessionId` contract.
- Third-party CLI session transport lives in `server/providers/acp` and uses the official ACP v1 SDK. Provider-specific engines are not added here when ACP covers the integration.

Provider credentials, homes, native session identifiers, and child processes must never be shared between engines.
