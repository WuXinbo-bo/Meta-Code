# Repository boundaries

The Git repository contains application source, tests, documentation, and
build inputs only. It does not own user state.

## Source repository

- `src/`: web interface.
- `server/`: local API and domain services.
- `server/engines/`: native Claude and Codex conversation adapters.
- `server/runtime/`: provider-neutral CLI discovery and installation.
- `skills/`: built-in skill source copied into the user data root on startup.
- `scripts/`, `native/`, and `public/`: build, test, and product assets.

## User-owned state

All mutable personal state lives below `~/.metacode`. The repository must not
contain databases, credentials, transcripts, installed CLIs, downloaded skills,
logs, backups, or directory links to that data.

An application uninstall or a fresh Git clone may remove source/build files,
but it must never remove `~/.metacode`. Data removal is a separate explicit
user action.
