# Meta Code Repository Instructions

## Product boundaries

- Meta Code is a local-first, single-user workbench. Do not add login, multi-user administration, or a separate administrator application without an explicit product decision.
- User data belongs under `~/.metacode`, never in the source repository. Do not commit databases, credentials, transcripts, downloaded CLIs, logs, backups, or workspace task artifacts.
- Keep the repository portable. Source, tests, and documentation must not depend on machine-specific absolute paths.

## Agent architecture

- Codex and Claude use native enhanced adapters where upstream capabilities exceed ACP.
- New third-party Agent integrations should prefer ACP and implement the shared Provider contracts. Do not add Provider-specific UI branches when capability negotiation can drive the interface.
- Delegation and task orchestration share lower-level Agent execution but have separate state machines. Read `docs/architecture/task-orchestration.md` and `docs/architecture/task-orchestration-ui.md` before changing workflow behavior.
- MCP provides tools and data; it is not a replacement for the Agent session protocol.

## Development

- Preserve existing user changes in a dirty worktree.
- Keep secrets out of source, logs, fixtures, prompts, and task files.
- Prefer focused modules and tests over expanding `server/index.ts` with new Provider-specific logic.
- Run at least `npm run typecheck` and the tests relevant to the changed boundary. Run `npm run build` before release-facing commits.
- For user-requested real Agent/workflow validation, use the currently running workbench and its visible UI/ports. Create test workspaces in the user's designated test directory, retain tasks and logs for live inspection, and do not start an isolated backend or data profile unless the user explicitly requests one. Offline automated boundary tests may continue using temporary fixtures.
- After project adjustments and verification, reload or restart the current platform branch so the running workbench uses the updated source; check health and report where the user can inspect live tests.

## Cross-platform branch maintenance

Meta Code is maintained on both the Mac branch (`mac版`) and the Windows branch or Windows baseline. Every change must be classified as shared, Mac-specific, Windows-specific, or mixed before editing.

- Shared behavior, provider contracts, protocol changes, UI behavior, data formats, tests, and platform-neutral fixes must be implemented in the shared source and synchronized to both branches.
- Mac-only changes include macOS process launching, shell/runtime discovery, filesystem conventions, signing, packaging, and macOS-specific desktop integration. Windows-only changes include PowerShell or Windows process launching, Windows path handling, installer behavior, and Windows desktop integration. Keep these changes in the appropriate platform paths and do not force them into the other branch.
- Mixed work must be split into a shared commit and one or more platform commits whenever practical. Shared commits should be applied to the other branch by cherry-pick or an equivalent focused backport, followed by that branch's own checks.
- Before synchronizing or committing, inspect both branch names and their divergence. Never switch branches or overwrite a dirty worktree without preserving the user's changes. Do not assume a branch name that has not been verified locally.
- A platform-specific change must be called out separately in the task report, including the affected branch, files or subsystem, reason it cannot be shared, and whether the counterpart branch needs a follow-up adaptation.
- A shared change must be reported as synchronized only after the counterpart branch has been updated and its relevant type checks and tests have passed. If only the current branch was changed, report it as pending synchronization.
- Use commit messages that make scope clear, such as `shared: ...`, `macos: ...`, or `windows: ...`, and avoid combining unrelated platform work in one commit.
- At the start of each repository task, read this file and verify the current branch and worktree state. After each adjustment, re-check the diff, branch status, and synchronization impact before loading or restarting the project.
