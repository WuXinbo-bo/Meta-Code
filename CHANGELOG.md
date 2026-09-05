# Changelog

All notable changes to Meta Code are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] - 2026-09-05

### Added

- A private, verified Node/npm toolchain bundled with Windows packages, with automatic bootstrap when missing.
- Unified install and same-version repair actions for native Claude, Codex, and supported ACP Agents.
- Verified automatic personal-data backups with two-snapshot retention and restore-point controls.

### Changed

- Conversation actions and completed activity summaries use a more compact layout while keeping detailed command and file changes accessible.
- Conversation tabs display the actual lead Agent icon; community and contribution documentation has been refreshed.
- Provider discovery runs outside the critical bootstrap path, and navigation snapshots avoid unnecessary heavy scans.

### Fixed

- Fresh computers no longer report native CLIs as already installed or require a separately configured npm before installation.
- CLI repair restores the previous installation if certification fails; installing a CLI no longer falsely verifies an account connection.
- Follow-up guidance, pause, resume, and cancellation preserve the user's intent through session transitions.
- Task deletion coordinates active execution and persisted state before removing a task.
- Backup publication and restore moves tolerate transient Windows file locks without deleting the destination or bypassing verification.
- Development hot reload excludes generated packages and test data, avoiding unnecessary scans and Windows directory locks during release validation.
- Provider configuration remains visible across bootstrap refreshes; reasoning activity and context-compaction notices have consistent lifecycles.

## [0.1.3] - 2026-09-04

### Added

- Curated Agent market states with a DeepSeek entry and clearer runtime, connection, and repair actions.
- Unified Codex and Claude connection profiles for system accounts, workbench accounts, official APIs, and compatible endpoints.
- Provider readiness checks across conversations, delegation, planning, approval, resume, and workflow execution.
- A background operation center, accessible confirmation dialogs, backup verification, and redacted diagnostics export.
- Product-focused README visuals, contribution guidance, and sponsor information.

### Changed

- Agent workflows now validate runtime availability, connection health, workspace access, and required capabilities before starting.
- ACP collaboration is offered only when the Agent reports the terminal capability required by the delegation bridge.
- Session inventory, workspace folder drop guidance, responsive layouts, and failure recovery actions provide clearer feedback.
- Update results use concise user-facing dialogs while retaining cached release information separately from fresh checks.

### Fixed

- App update checks no longer probe an undeclared manifest URL or remain in the checking state during prolonged retries.
- The complete update check has a bounded deadline and records real attempt durations before returning success or failure.
- Native Provider profile changes now propagate consistently to task, model discovery, authentication, and workflow execution paths.
- Packaged application and signed update manifests now share the same immutable build identity, preventing false same-version update prompts.

## [0.1.2] - 2026-09-03

### Added

- Complete personal-data snapshots, self-healing scheduled backups, storage governance, and safe workspace folder drag-and-drop.
- Local API token and origin protection, desktop backend crash recovery, and responsive workspace-file drawers.
- Release compatibility contracts for signed manifests, transactional CLI activation, and pinned workflow runtime identities.

### Changed

- Session navigation, Provider filters, and UI failure boundaries now use isolated, reusable state contracts.
- Release, runtime, data ownership, and recovery documentation now describe the hardened lifecycle.

### Fixed

- State upgrades create a consistent pre-migration backup, run transactionally, and reject unsupported future schemas before writing.
- Live follow-up input, revision reconciliation, generation saves, and recovered task rendering no longer require a manual refresh.
- CLI updates and invalid app-update manifests fail safely without corrupting the active runtime or current update state.
- Narrow-screen workspace files remain accessible and can be dismissed without overlapping the workbench.

## [0.1.1] - 2026-09-02

### Added

- Branded Windows installer flow with reproducible Meta Code assets and real installation progress.
- Independent installer, portable, and unpacked desktop artifacts with SHA-256 package summaries.
- Public repository documentation, local first-run guidance, and contextual help.

### Changed

- Release metadata and native Agent client identities now report version 0.1.1.

## [0.1.0] - Unreleased

### Added

- Local workbench for Codex, Claude, and ACP-capable Agents.
- Native and collaborative conversation modes with cross-Provider delegation.
- Approval-based task orchestration with static DAG scheduling, node recovery, machine checks, and final delivery.
- Agent market, managed CLI runtimes, connection profiles, model discovery, and session configuration.
- Skill Center, capability profiles, MCP management, session management, workspace browser, file previews, and activity Diff rendering.
- SSE updates with revision reconciliation and adaptive polling recovery.
- User data separation under `~/.metacode`, encrypted secret storage, backup/restore, release checks, and desktop packaging groundwork.
