import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const TARGET_VERSION = "0.1.0";
const COPY_DIRECTORIES = ["agent-market", "credentials", "mcp", "profiles", "providers", "sessions", "skills"];
const COPY_FILES = ["auth-encryption.key", "data-location.json"];

function sqliteSnapshot(source, destination) {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    database.prepare("VACUUM INTO ?").run(destination);
  } finally {
    database.close();
  }
}

function integrityCheck(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA integrity_check").get();
    if (result?.integrity_check !== "ok") throw new Error(`SQLite integrity check failed: ${path.basename(file)}`);
  } finally {
    database.close();
  }
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function inlineSessionMessages(file) {
  const database = new DatabaseSync(file);
  let sessionCount = 0;
  let messageCount = 0;
  try {
    if (!tableExists(database, "sessions")) throw new Error("The source state database has no sessions table");
    const hasMessageTable = tableExists(database, "session_messages");
    database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      const sessions = database.prepare("SELECT id, json FROM sessions ORDER BY position ASC").all();
      const readMessages = hasMessageTable
        ? database.prepare("SELECT json FROM session_messages WHERE session_id = ? ORDER BY position ASC")
        : null;
      const update = database.prepare("UPDATE sessions SET json = ? WHERE id = ?");
      for (const row of sessions) {
        const session = JSON.parse(row.json);
        const messages = readMessages
          ? readMessages.all(row.id).map((message) => JSON.parse(message.json))
          : (Array.isArray(session.messages) ? session.messages : []);
        session.messages = messages;
        update.run(JSON.stringify(session), row.id);
        sessionCount += 1;
        messageCount += messages.length;
      }
      if (hasMessageTable) database.exec("DROP TABLE session_messages");
      if (tableExists(database, "state_meta")) {
        const upsert = database.prepare("INSERT INTO state_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        upsert.run("dataSchemaVersion", "1");
        upsert.run("lastWriterAppVersion", "0.1.0-compatibility-snapshot");
      }
      database.exec("PRAGMA user_version = 1; COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* The transaction already ended. */ }
      throw error;
    }
  } finally {
    database.close();
  }
  return { sessionCount, messageCount };
}

function writeLauncher(outputDir, dataHome, executable) {
  if (!executable) return null;
  const launcher = path.join(outputDir, "launch-meta-code-0.1.0.ps1");
  const escape = (value) => value.replaceAll("'", "''");
  const content = [
    "$ErrorActionPreference = 'Stop'",
    `$env:METACODE_HOME = '${escape(dataHome)}'`,
    `Start-Process -FilePath '${escape(executable)}' -WorkingDirectory '${escape(path.dirname(executable))}'`,
    ""
  ].join("\r\n");
  fs.writeFileSync(launcher, content, { encoding: "utf8", mode: 0o600 });
  return launcher;
}

export function createCompatibilitySnapshot(input = {}) {
  const sourceDir = path.resolve(input.sourceDir || path.join(os.homedir(), ".metacode"));
  const targetDir = path.resolve(input.targetDir || path.join(os.homedir(), ".metacode-compat", TARGET_VERSION));
  const stateFile = path.join(sourceDir, "workbench-state.db");
  if (!fs.existsSync(stateFile)) throw new Error(`Source state database does not exist: ${stateFile}`);
  if (sourceDir === targetDir || targetDir.startsWith(`${sourceDir}${path.sep}`)) throw new Error("Compatibility data must be outside the live data directory");

  const parent = path.dirname(targetDir);
  const staging = path.join(parent, `.${path.basename(targetDir)}.staging-${process.pid}-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  let previousDir = null;
  try {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".db")) continue;
      sqliteSnapshot(path.join(sourceDir, entry.name), path.join(staging, entry.name));
    }
    for (const name of COPY_FILES) {
      const source = path.join(sourceDir, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(staging, name));
    }
    for (const name of COPY_DIRECTORIES) {
      const source = path.join(sourceDir, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(staging, name), { recursive: true, force: false, errorOnExist: true });
    }

    const stateTarget = path.join(staging, "workbench-state.db");
    const counts = inlineSessionMessages(stateTarget);
    for (const name of fs.readdirSync(staging)) {
      if (name.endsWith(".db")) integrityCheck(path.join(staging, name));
    }
    const createdAt = new Date().toISOString();
    fs.writeFileSync(path.join(staging, "compatibility.json"), `${JSON.stringify({
      schemaVersion: 1,
      targetAppVersion: TARGET_VERSION,
      sourceDir,
      createdAt,
      ...counts
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const launcher = writeLauncher(staging, targetDir, input.executable);

    fs.mkdirSync(parent, { recursive: true });
    if (fs.existsSync(targetDir)) {
      previousDir = `${targetDir}.previous-${Date.now()}`;
      fs.renameSync(targetDir, previousDir);
    }
    fs.renameSync(staging, targetDir);
    return {
      sourceDir,
      targetDir,
      previousDir,
      launcher: launcher ? path.join(targetDir, path.basename(launcher)) : null,
      createdAt,
      ...counts
    };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (previousDir && !fs.existsSync(targetDir)) fs.renameSync(previousDir, targetDir);
    throw error;
  }
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--source") result.sourceDir = argv[++index];
    else if (current === "--target") result.targetDir = argv[++index];
    else if (current === "--executable") result.executable = argv[++index];
    else throw new Error(`Unknown argument: ${current}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = createCompatibilitySnapshot(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
