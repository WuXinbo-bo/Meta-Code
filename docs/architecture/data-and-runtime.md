# Data and runtime layout

Application source and personal data are intentionally separate.

## Default data directory

- Windows: `%USERPROFILE%\.metacode`
- macOS/Linux: `~/.metacode`

This mirrors Codex's `~/.codex` ownership model: deleting or replacing the
application source does not delete the user's conversations, settings, skills,
or managed runtimes. Set `METACODE_HOME` to override the root.
`WORKBENCH_DATA_DIR` and `WORKBENCH_RUNTIME_DIR` remain compatibility aliases.

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

API keys, MCP environment variables, and MCP request headers are removed from
the ordinary state database during migration. They remain available in memory
to native CLI sessions but are persisted only through the secret vault.

Workspace source files remain in user-selected project directories. The
Workbench data directory stores references to those directories, not copies.
