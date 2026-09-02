# Provider Host

The Provider Host is a thin internal boundary with two transports:

```text
Workbench session / activity / permission state
  |- Native enhanced provider
  |    |- Codex SDK and app-server semantics
  |    `- Claude Stream JSON and native session semantics
  `- ACP v1 provider
       `- JSON-RPC 2.0 over NDJSON stdio
```

Codex and Claude intentionally stay native so thread linking, fork/resume,
native subagents, permissions and upstream event fidelity are not reduced to a
lowest common denominator. They still bind the same internal Provider Host and
write the same canonical session/activity records as ACP providers.

## ACP policy

- ACP v1 is the stable third-party integration contract.
- The official `@agentclientprotocol/sdk` owns wire types and negotiation.
- The official Registry is discovery metadata. Registry entries are validated,
  version locked and never executed merely by listing them.
- Session config options come from `session/new`, `session/resume` and
  `config_option_update`; the workbench supports standard `select` and
  `boolean` controls without hardcoding model-specific effort names.
- Unknown session updates become status activity instead of failing rendering.
- File, terminal and permission requests remain bounded by workbench policy.
- ACP v2 is draft and must remain behind an explicit future feature flag.

## Workbench extensions

ACP does not own CLI installation, Skill policy, delegation admission, workflow planning,
official Codex thread linking, session management or UI performance controls.
Those remain workbench services layered above either transport.

An installed ACP Agent can run as a workbench-delegated worker through an
isolated ACP session. This does not advertise native subagents: admission,
workspace boundaries, cancellation, logs and lifecycle remain owned by the
workbench bridge.

## Provider lifecycle

1. Resolve or install a Registry entry through the runtime manager.
2. Launch the version-locked command and negotiate ACP capabilities.
3. Register the conservative provider manifest plus standard main-session and
   isolated delegated-worker runners.
4. Create/resume the ACP session with workspace roots and enabled MCP servers.
5. Normalize streaming updates into canonical activity records.
6. Send `session/cancel` on pause/stop; close a non-cooperative transport so the
   workbench is never blocked by it.
7. Reclaim idle transports and resume by ACP session id when supported.

The fixture tests exercise real subprocess I/O, resume, cancellation, crash
isolation, config options, MCP negotiation, filesystem boundaries and terminal
output limits.
