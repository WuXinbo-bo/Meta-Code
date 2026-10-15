---
name: metacode-manager
title: Meta Code 管家
description: Manage project Skills, MCP servers, and Plugins through natural-language requests. Use when the user asks to create, install, inspect, enable, test, update, or remove a Skill, MCP server, or Plugin. Store in the workbench-managed data directory, never in a user project.
---

# Meta Code 管家

Manage Skills stored by the current Meta Code workbench. Use the bundled script for filesystem mutations; do not reproduce its installation logic with ad hoc shell commands.

## Commands

The script is `scripts/manage-skill.mjs` relative to this Skill root.

List managed Skills:

```powershell
node scripts/manage-skill.mjs list
```

Install a GitHub Skill:

```powershell
node scripts/manage-skill.mjs install --url "https://github.com/owner/repo/tree/main/path/to/skill"
```

Use `--path path/to/skill` when the URL identifies only a repository. Use `--ref branch-or-tag` when needed. Use `--name skill-name` only when the destination name must differ from the source folder.

Create a Skill from a JSON specification:

```powershell
node scripts/manage-skill.mjs create --stdin
```

Send the following JSON through standard input using a quoted here-document or PowerShell here-string:

Specification:

```json
{
  "name": "example-skill",
  "description": "What the Skill does and the situations that should trigger it.",
  "instructions": "# Example Skill\n\nImperative workflow instructions.",
  "files": {
    "references/example.md": "Optional supporting material",
    "scripts/example.mjs": "Optional deterministic helper"
  }
}
```

## Workflow

1. Determine whether the user wants installation or creation. Ask only when a repository contains multiple Skills and the intended one cannot be inferred.
2. For installation, pass the exact GitHub URL to `install`. Never execute code from the downloaded repository.
3. For creation, convert the user's requirements into a concise Skill following progressive disclosure. Pass the JSON specification through standard input to `create --stdin`; do not create internal directories or specification files in the workspace.
4. Use lowercase letters, digits, and hyphens for Skill names. Keep `SKILL.md` focused and place detailed material in `references/` or deterministic helpers in `scripts/`.
5. Treat an existing destination as a conflict. Do not delete or replace an installed Skill unless the user explicitly requests replacement and the workbench exposes a dedicated replacement command.
6. Read the script's JSON result. Report the installed or created Skill name and state that the Agent page refreshes automatically.

The destination is always the workbench managed-skills data directory. Do not install into `~/.codex/skills` or another global directory.
