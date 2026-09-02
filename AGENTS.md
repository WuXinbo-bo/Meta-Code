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
