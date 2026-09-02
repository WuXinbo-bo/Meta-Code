# CLI runtime architecture

CLI distribution and CLI conversation semantics are separate concerns.
Claude and Codex continue to run through their native adapters; the runtime
manager only owns discovery, installation, activation, rollback, and health
diagnostics.

## Registry

`server/runtime/registry.ts` is the built-in CLI registry. A definition owns:

- stable id, label, and command name;
- distribution metadata (`npm` or signed/checksummed `binary`);
- platform-specific executable candidates;
- system PATH discovery and a version/health probe.

Adding a third-party coding CLI should add or consume a runtime definition and
connect it through ACP v1. It must not add provider-specific installation routes
to `server/index.ts` or implement the workbench's internal adapter types. Native
enhanced adapters are reserved for integrations that need upstream capabilities
not covered by ACP, currently Codex and Claude.

## Managed installations

Managed versions live below `runtimes/<id>/versions/<version>`. `current.json`
is atomically replaced to activate a version. Downloads install into a staging
directory, must pass an executable probe, and only then become active. Previous
versions remain available for rollback.

Binary distributions require HTTPS and an exact SHA-256. Npm distributions use
npm's package integrity verification and install into the same versioned layout.

## Resolution order

1. Explicit user path.
2. Active workbench-managed runtime.
3. Product-bundled runtime.
4. System/user PATH installation.

The API exposes detection, install/update, diagnostics, version activation, and
rollback. Install phases are published as `runtime.install` events and terminal
changes as `runtime.changed`.
