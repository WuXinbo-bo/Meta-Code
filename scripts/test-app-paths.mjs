import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWorkbenchDataDir, prepareWorkbenchDataDir, remapLegacyRuntimePath, resolveWorkbenchPaths } from "../server/appPaths.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-paths-"));
const project = path.join(sandbox, "project");
const destination = path.join(sandbox, "personal-data");
fs.mkdirSync(path.join(project, ".runtime", "codex-home", "sessions"), { recursive: true });
fs.mkdirSync(path.join(project, ".runtime", "managed-skills", "example"), { recursive: true });
fs.writeFileSync(path.join(project, ".runtime", "workbench-state.db"), "state");
fs.writeFileSync(path.join(project, ".runtime", "state.json"), JSON.stringify({ apiKey: "legacy-secret" }));
fs.writeFileSync(path.join(project, ".runtime", "codex-home", "sessions", "thread.jsonl"), "thread");
fs.writeFileSync(path.join(project, ".runtime", "managed-skills", "example", "SKILL.md"), "skill");

const previousDataDir = process.env.WORKBENCH_DATA_DIR;
const previousRuntimeDir = process.env.WORKBENCH_RUNTIME_DIR;
const previousMetaCodeHome = process.env.METACODE_HOME;
const previousProfile = process.env.METACODE_PROFILE;
delete process.env.METACODE_HOME;
delete process.env.WORKBENCH_RUNTIME_DIR;
process.env.WORKBENCH_DATA_DIR = destination;
const explicit = resolveWorkbenchPaths(project);
assert.equal(explicit.dataDir, destination);
assert.equal(prepareWorkbenchDataDir(explicit).migrated, false, "explicit test directories must never import repository data");

delete process.env.WORKBENCH_DATA_DIR;
delete process.env.METACODE_PROFILE;
assert.equal(resolveWorkbenchPaths(project).dataDir, defaultWorkbenchDataDir(), "development and installed entrypoints share the canonical personal data root unless isolation is explicit");
process.env.METACODE_PROFILE = "development-test";
assert.equal(resolveWorkbenchPaths(project).dataDir, `${defaultWorkbenchDataDir()}-development-test`);
delete process.env.METACODE_PROFILE;
const automatic = { ...resolveWorkbenchPaths(project), dataDir: destination };
// Exercise the automatic migration branch without writing to the machine's
// real application-data directory.
const originalData = process.env.WORKBENCH_DATA_DIR;
delete process.env.WORKBENCH_DATA_DIR;
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.join(destination, "logs"), { recursive: true });
fs.writeFileSync(path.join(destination, "logs", "launcher.log"), "started");
assert.equal(prepareWorkbenchDataDir(automatic).migrated, true);
assert.equal(fs.readFileSync(path.join(destination, "profiles", "codex", "sessions", "thread.jsonl"), "utf8"), "thread");
assert.equal(fs.readFileSync(path.join(destination, "skills", "example", "SKILL.md"), "utf8"), "skill");
assert.ok(!fs.existsSync(path.join(project, ".runtime")), "personal runtime data must leave the repository");
assert.ok(fs.existsSync(path.join(destination, "migration-backups", "repository-runtime-original", "workbench-state.db")), "a recovery copy must be retained outside the repository");
assert.ok(fs.existsSync(path.join(destination, "migration-backups", "repository-runtime-original", "state.json")));
assert.ok(!fs.existsSync(path.join(destination, "state.json")), "legacy plaintext state must not remain in the live data root");
assert.equal(JSON.parse(fs.readFileSync(path.join(destination, "data-location.json"), "utf8")).migrated, true);
assert.equal(fs.readFileSync(path.join(destination, "logs", "launcher.log"), "utf8"), "started");
assert.equal(
  remapLegacyRuntimePath(path.join(project, ".runtime", "codex-cli", "node_modules", ".bin", "codex.cmd"), automatic),
  path.join(automatic.codexRuntimeDir, "node_modules", ".bin", "codex.cmd")
);

if (previousDataDir === undefined) delete process.env.WORKBENCH_DATA_DIR;
else process.env.WORKBENCH_DATA_DIR = previousDataDir;
if (previousRuntimeDir === undefined) delete process.env.WORKBENCH_RUNTIME_DIR;
else process.env.WORKBENCH_RUNTIME_DIR = previousRuntimeDir;
if (previousMetaCodeHome === undefined) delete process.env.METACODE_HOME;
else process.env.METACODE_HOME = previousMetaCodeHome;
if (previousProfile === undefined) delete process.env.METACODE_PROFILE;
else process.env.METACODE_PROFILE = previousProfile;
if (originalData !== undefined) process.env.WORKBENCH_DATA_DIR = originalData;
fs.rmSync(sandbox, { recursive: true, force: true });
console.log("application path and legacy migration tests passed");
