# Architecture overview

Meta Code separates product UI, workbench domain services, Agent transports, and mutable user data.

## Layers

1. The React client renders conversations, activity, files, settings, Skill/MCP controls, delegation, and workflow orchestration.
2. The local Node.js service owns state, permissions, process lifecycle, real-time events, file boundaries, and recovery.
3. Provider Host contracts normalize identity, connection state, session configuration, model controls, activity, and cancellation.
4. Native transports preserve Codex and Claude capabilities that are not yet fully represented by ACP.
5. The ACP client host is the preferred integration path for additional coding Agents.
6. Workbench extensions add CLI installation, Skill policy, delegation, orchestration, history linkage, and performance protection without inventing a competing Agent protocol.

## Runtime flow

```text
UI command
  -> local API
  -> Provider Host capability check
  -> native or ACP transport
  -> normalized session/activity events
  -> SSE revision stream
  -> client snapshot reconciliation
```

Unknown activity types must degrade to a generic event rather than fail rendering. Provider-specific options are exposed through negotiated configuration descriptors instead of hard-coded model names or reasoning levels.

## Boundaries

- Source repository: immutable code, tests, built-in assets, documentation.
- `~/.metacode`: mutable personal state, credentials, managed runtimes, logs, backups.
- Workspace directories: user project source and `.claude-codex` task artifacts.
- Desktop Launcher: application process lifecycle and future atomic version switching.

See also [CLI runtime](cli-runtime.md), [data layout](data-and-runtime.md), [task orchestration](task-orchestration.md), and [Codex native link](codex-native-link.md).
