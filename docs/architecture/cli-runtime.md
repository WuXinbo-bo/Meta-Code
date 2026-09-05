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
directory, must pass an executable probe and provider compatibility
certification, and only then become active. Activation, verification, and
rollback form one transaction: any post-switch failure restores the previous
pointer and configuration. The active version and one rollback version are
retained; versions referenced by running or resumable work are never pruned.

Binary distributions require HTTPS and an exact SHA-256. Npm distributions use
npm's package integrity verification and install into the same versioned layout.

## Source selection

System, explicit path, and managed are separate user selections. Discovery lists
all candidates, but execution respects the selected source. A missing active
managed version is reported as damaged instead of silently selecting an older
version. Installing from any source selection creates a managed copy and changes
the selection only after certification; it never updates the external CLI.

The API exposes detection, install/update, diagnostics, version activation, and
rollback. Install phases are published as `runtime.install` events and terminal
changes as `runtime.changed`.

## First installation and repair

Native enhancement describes the execution transport, not installation state.
The market derives native installation state from runtime detection, offers the
same install and repair actions as ACP entries, and remains usable for built-in
Agents when the external Registry is unavailable. Installing a CLI never marks
an account or API connection as verified.

`server/runtime/toolchain.ts` provides a private Node/npm toolchain. Windows x64
and arm64 bootstrap archives are pinned to Node 24.13.0 and official SHA-256
checksums. Automatic download mode can use the mirror with the same checksum;
official mode uses nodejs.org. The existing downloader supplies proxy handling,
partial download recovery and integrity verification. Other development
platforms can reuse a system Node 24+ installation.

Desktop packaging runs `scripts/prepare-node-toolchain.mjs` and includes the
complete toolchain under `resources/workbench/toolchains/node`. It does not rely
on the user's PATH or on Electron supplying npm. If unavailable, the installer
prepares a copy under the personal runtime directory. npm runs with the matching
Node executable, a private cache/config path and a child PATH containing Node;
Electron's Node-mode flag is removed from npm's environment. JS Agent launchers
reuse this runtime without changing the system PATH.

`RuntimeStatus.installation` distinguishes ready, automatically preparable and
unsupported dependencies, including binary distributions that do not need npm.
`managed.healthy` distinguishes installation records from working executables.
An explicit repair request reinstalls the active version, even when it is the
latest. Candidate replacement retains the old directory until certification
and activation succeed; a verification failure restores it. Cleanup failure must
not roll back a valid install to a partially deleted backup.

## Release verification

- `npm run test:cli-installation`: offline catalog, dependency actions, repair,
  failed replacement rollback and native connection state regressions.
- `npm run test:cli-clean-desktop`: builds and launches an isolated Electron
  backend without system Node/npm/CLI discovery, installs real Claude and Codex,
  damages and repairs the Codex executable at the same version. No model calls.
- Run `node --import tsx scripts/prepare-node-toolchain.mjs output/cli-install-validation/toolchains/node`
  followed by `node scripts/test-cli-clean-desktop.mjs --bundled` to verify the
  bundled-toolchain path. Outputs remain under ignored `output/`.

The real download test is excluded from offline CI. These isolated-process tests
do not replace final Windows Sandbox/VM installation and authenticated task
acceptance on the distributable. Keep the native/ACP execution regression suites.

## Execution identity

Every main session, delegated task, workflow planner, workflow node attempt,
integrator, and validator captures a versioned runtime binding:

- runtime/provider/adapter IDs;
- transport source and absolute executable path;
- CLI version and adapter SDK version;
- a capability fingerprint.

Resume is allowed only when the current capability fingerprint matches the
captured identity. If a CLI update changes the adapter, path, version, or
negotiated capabilities, the old engine thread is not silently reused. Workflow
attempt history remains readable, while the affected attempt is marked
abandoned and a fresh context is required. This prevents an apparently
successful CLI update from corrupting delegation or orchestration state.
