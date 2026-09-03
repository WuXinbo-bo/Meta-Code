# Data and runtime layout

Application source and personal data are intentionally separate.

## Default data directory

- Installed application and normal repository development:
  `%USERPROFILE%\.metacode` on Windows and `~/.metacode` on macOS/Linux.
- Explicitly isolated development or compatibility profiles:
  `~/.metacode-<profile>`.

This mirrors Codex's `~/.codex` ownership model: deleting or replacing the
application source does not delete the user's conversations, settings, skills,
or managed runtimes. Set `METACODE_HOME` to override the root.
`WORKBENCH_DATA_DIR` and `WORKBENCH_RUNTIME_DIR` remain compatibility aliases.
The data-owner lease prevents installed and development backends from writing
the same directory concurrently. Set `METACODE_PROFILE=development` or an
explicit `METACODE_HOME` when deliberate isolation is required. Tests must
always use a disposable explicit directory. Entry points must not silently
select an empty profile when the canonical directory contains user data.

The first normal start copies a legacy repository `.runtime` directory into
the default data directory when the destination has no existing database. An
unaltered recovery copy is retained under `migration-backups`, then the legacy
repository directory is removed. No directory link or shared live database is
created.

## Ownership

- `workbench-state.db`, `auth.db`, and `codex-link.db`: application databases.
- `profiles/`: isolated Claude and Codex configuration homes.
- `runtimes/`: product-managed CLI installations.
- `skills/`, `mcp/`, and `sessions/`: user-installed capabilities and history.
- `logs/`, `backups/`, and `transactions/`: diagnostics and recovery state.
- `credentials/secrets.dat`: API and MCP secrets encrypted for the current
  Windows user with DPAPI (authenticated AES-GCM fallback on other platforms).
- `security/api-token`: an ephemeral local transport token. It is generated per
  installed launch or persisted only for the paired development server/Vite
  processes in their selected data root. It is not personal data and is
  intentionally excluded from backup.

Only one backend may own a data directory. `owner.json` records the owning PID,
role, port, and heartbeat. A live owner blocks a second process; a dead PID is
reclaimed immediately so a crash cannot leave the application unusable for a
heartbeat grace period. Port-listen failures and orderly shutdown both release
the lease.

API keys, MCP environment variables, and MCP request headers are removed from
the ordinary state database during migration. They remain available in memory
to native CLI sessions but are persisted only through the secret vault.

Workspace source files remain in user-selected project directories. The
Workbench data directory stores references to those directories, not copies.

## Backup and restore

A complete personal-data snapshot contains all application databases plus
credentials, Skills, profiles, provider settings, MCP configuration, sessions,
recovery records, activity artifacts, workflow transactions, and signed Skill
releases. Databases are copied with SQLite `VACUUM INTO`; every file is recorded
with size and SHA-256, and restore verifies the manifest and database integrity
before atomically replacing live data. The pre-restore state is retained for
rollback.

Managed CLI binaries, download caches, logs, and `security/api-token` are not
portable personal data. They are detected or regenerated after restore. A
restore is rejected while a backend still owns the target data directory.

## Retention

`server/storageGovernance.ts` is the single retention policy. Its dry-run report
lists inventory, protected objects, deletion reasons, and reclaimable bytes.
Execution is allowed only while tasks are idle and is also run after the daily
complete backup.

| Class | Retention | Protection |
| --- | --- | --- |
| Complete personal snapshots | latest 3, 90 days, 8 GiB soft budget | latest 3 always survive |
| Database/migration/pre-restore copies | bounded count, age, and 4-8 GiB budget | at least one complete recovery point |
| Managed CLI versions | active version plus one rollback | every active task runtime binding |
| Runtime download cache | 30 days, 2 GiB | none; it is reproducible |
| Session recovery/activity artifacts | 30/90 days and bounded capacity | every existing session reference |
| Workflow runtime directories | 30 days, 2 GiB | active node attempts |
| Diagnostic logs | 14 days, 256 MiB | files written in the last day |

Personal databases, credentials, Skills, MCP configuration, provider profiles,
workspace references, and the active local API token are never maintenance
candidates.
