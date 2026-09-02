# Security policy

## Supported versions

Meta Code is currently preparing its first public `0.1.x` release. Security fixes target the latest source revision and the latest published release once releases begin.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities involving command execution, path traversal, credential exposure, update verification, authentication boundaries, or workspace escape. After the GitHub repository is published, use its private Security Advisory reporting channel. Include affected versions, reproduction steps, impact, and any suggested mitigation.

Do not attach real API keys, personal databases, transcripts, or private project files. Use minimal synthetic fixtures.

## Security boundaries

- The API binds to `127.0.0.1` by default and is intended for a local single user.
- Workspace file operations must enforce resolved path boundaries.
- Secrets belong in the local credential vault, not ordinary state, logs, prompts, or task files.
- Managed CLI downloads require verified sources; binary distributions require HTTPS and SHA-256 validation.
- Future application updates must be verified before atomic activation and must preserve rollback.
- `~/.metacode` contains sensitive personal state and should be protected like an IDE or coding-Agent profile.
