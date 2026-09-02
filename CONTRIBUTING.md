# Contributing to Meta Code

Thank you for improving Meta Code. The project is a local-first, single-user workbench; changes should preserve that product boundary and keep user data outside the repository.

## Before coding

1. Open an issue for large behavior, protocol, storage, or UI architecture changes.
2. Read `AGENTS.md` and the relevant documents under `docs/architecture/`.
3. Keep Provider-specific behavior behind shared capability contracts. New third-party Agents should prefer ACP.

## Development

```powershell
npm install
npm run dev
```

Use a disposable `METACODE_HOME` for migration, recovery, install, or destructive tests. Never include personal databases, credentials, logs, downloaded CLIs, or `.claude-codex` task artifacts in a change.

## Pull requests

- Keep the change focused and explain user-visible behavior.
- Add or update tests for changed contracts.
- Run `npm run typecheck`, relevant domain tests, and `npm run build`.
- Note any real CLI tests that could not be run.
- Include screenshots for visible UI changes.
- Do not mix generated build output or personal state into the commit.

## Commit style

Use concise conventional prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `refactor:`. A commit should leave the repository buildable and should not depend on an uncommitted local migration.
