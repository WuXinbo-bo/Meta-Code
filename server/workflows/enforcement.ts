import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { registerProcessTree, terminateProcessTree, unregisterProcessTree } from "../processTree.js";
import type { WorkflowNodeCheck } from "./types.js";

const SNAPSHOT_IGNORES = new Set([".git", "node_modules", ".runtime", "dist", "build", ".workflow", ".claude-codex", ".playwright-mcp"]);
const SNAPSHOT_VOLATILE_DIRECTORY = /^\.?(?:chrome|chromium|edge|browser)-(?:profile|user-data)(?:[-_.].*)?$/i;
const SNAPSHOT_ACCESS_RETRY_DELAYS_MS = [40, 120, 300];
const MAX_HASH_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_CHARS = 32_000;
const VERIFICATION_TIMEOUT_MS = 5 * 60_000;
const ALLOWED_PROGRAMS = new Set(["node", "npm", "pnpm", "yarn", "bun", "python", "python3", "pytest", "cargo", "go", "dotnet"]);
const SNAPSHOT_FILE_CONCURRENCY = 16;

export type WorkspaceSnapshot = Map<string, string>;

function normalizedRelative(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

async function fileSignature(filePath: string, size: number, mtimeMs: number) {
  if (size > MAX_HASH_BYTES) return `${size}:${Math.round(mtimeMs)}`;
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

export function snapshotEntryIgnored(name: string, directory: boolean) {
  return directory && (SNAPSHOT_IGNORES.has(name) || SNAPSHOT_VOLATILE_DIRECTORY.test(name));
}

export function isTransientSnapshotAccessError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
  return ["EBUSY", "EPERM", "EACCES", "ETXTBSY"].includes(code);
}

function snapshotAccessCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "UNKNOWN") : "UNKNOWN";
}

async function snapshotFileSignature(filePath: string) {
  let lastStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  for (let attempt = 0; attempt <= SNAPSHOT_ACCESS_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      lastStat = await fs.stat(filePath);
      if (!lastStat.isFile()) return null;
      return await fileSignature(filePath, lastStat.size, lastStat.mtimeMs);
    } catch (error) {
      if (snapshotAccessCode(error) === "ENOENT") return null;
      if (!isTransientSnapshotAccessError(error)) throw error;
      if (attempt < SNAPSHOT_ACCESS_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_ACCESS_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      // Runtime tools can briefly hold SQLite/Cookie files open on Windows.
      // Metadata still lets the snapshot notice a later size/mtime change
      // without turning an unrelated node into a business execution failure.
      return `locked:${snapshotAccessCode(error)}:${lastStat?.size ?? "unknown"}:${lastStat ? Math.round(lastStat.mtimeMs) : "unknown"}`;
    }
  }
  return null;
}

export async function captureWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  const directories = [path.resolve(root)];
  const files: Array<{ absolute: string; relative: string }> = [];
  while (directories.length) {
    const directory = directories.shift()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || snapshotEntryIgnored(entry.name, entry.isDirectory())) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = normalizedRelative(path.relative(root, absolute));
      files.push({ absolute, relative });
    }
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(SNAPSHOT_FILE_CONCURRENCY, files.length) }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      const signature = await snapshotFileSignature(file.absolute);
      if (signature !== null) snapshot.set(file.relative, signature);
    }
  }));
  return snapshot;
}

export function changedWorkspaceFiles(before: WorkspaceSnapshot, after: WorkspaceSnapshot) {
  const changed = new Set<string>();
  for (const [filePath, signature] of after) if (before.get(filePath) !== signature) changed.add(filePath);
  for (const filePath of before.keys()) if (!after.has(filePath)) changed.add(filePath);
  return [...changed].sort((left, right) => left.localeCompare(right));
}

function globPattern(pattern: string) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$+.()|{}[\]]/g, "\\$&");
  }
  return new RegExp(`^${source}(?:/.*)?$`, "i");
}

function scopeCandidates(scope: string, workspaceRoot: string, workDirectory: string) {
  const normalized = normalizedRelative(scope);
  if (!normalized) return [];
  const taskRoot = normalizedRelative(path.relative(workspaceRoot, workDirectory));
  const candidates = new Set([normalized]);
  if (taskRoot && taskRoot !== "." && !normalized.toLowerCase().startsWith(`${taskRoot.toLowerCase()}/`)) {
    candidates.add(`${taskRoot}/${normalized}`);
  }
  return [...candidates];
}

export function filesOutsideWriteScope(changedFiles: string[], writeScope: string[], workspaceRoot: string, workDirectory: string) {
  const matchers = writeScope.flatMap((scope) => scopeCandidates(scope, workspaceRoot, workDirectory)).map(globPattern);
  if (!matchers.length) return [...changedFiles];
  return changedFiles.filter((filePath) => !matchers.some((matcher) => matcher.test(normalizedRelative(filePath))));
}

export function tokenizeVerificationCommand(command: string) {
  const raw = command.trim();
  if (!raw || /[\r\n;&|<>`]/.test(raw) || raw.includes("$(")) throw new Error("验收命令包含不允许的 Shell 语法");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < raw.length) current += raw[++index];
      else current += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) {
      if (current) tokens.push(current), current = "";
    } else current += char;
  }
  if (quote) throw new Error("验收命令引号未闭合");
  if (current) tokens.push(current);
  if (!tokens.length) throw new Error("验收命令为空");
  return tokens;
}

export function validateVerificationCommand(command: string) {
  const [programRaw, ...args] = tokenizeVerificationCommand(command);
  const program = path.basename(programRaw).replace(/\.(?:exe|cmd)$/i, "").toLowerCase();
  if (!ALLOWED_PROGRAMS.has(program)) throw new Error(`验收程序不在白名单：${programRaw}`);
  if ((program === "node" && args.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) || (["python", "python3"].includes(program) && args.includes("-c"))) {
    throw new Error("验收命令不允许执行内联脚本");
  }
  const packageCommand = args[0]?.toLowerCase();
  if (["npm", "pnpm", "yarn", "bun"].includes(program) && ["install", "add", "remove", "uninstall", "update", "upgrade", "link", "publish", "exec", "dlx", "x"].includes(packageCommand)) {
    throw new Error("验收命令不允许安装、删除或执行临时依赖");
  }
  const executable = process.platform === "win32" && ["npm", "pnpm", "yarn"].includes(program) ? `${program}.cmd` : programRaw;
  return { executable, args };
}

export function verificationSpawnSpec(executable: string, args: string[], platform = process.platform, comSpec = process.env.ComSpec || "cmd.exe") {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    return { executable: comSpec, args: ["/d", "/s", "/c", executable, ...args] };
  }
  return { executable, args };
}

function appendEvidence(current: string, chunk: Buffer | string) {
  if (current.length >= MAX_EVIDENCE_CHARS) return current;
  const next = current + chunk.toString();
  return next.length > MAX_EVIDENCE_CHARS ? `${next.slice(0, MAX_EVIDENCE_CHARS)}\n...[输出已截断]` : next;
}

export async function runVerificationCommand(command: string, cwd: string, signal: AbortSignal, ownerId: string): Promise<WorkflowNodeCheck> {
  let executable: string;
  let args: string[];
  try {
    ({ executable, args } = validateVerificationCommand(command));
  } catch (error) {
    return { name: command, command, status: "failed", exitCode: null, evidence: error instanceof Error ? error.message : String(error) };
  }
  return new Promise((resolve) => {
    let evidence = "";
    let settled = false;
    const launch = verificationSpawnSpec(executable, args);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.executable, launch.args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      resolve({ name: command, command, status: "failed", exitCode: null, evidence: error instanceof Error ? error.message : String(error) });
      return;
    }
    registerProcessTree(ownerId, child);
    child.stdout?.on("data", (chunk) => { evidence = appendEvidence(evidence, chunk); });
    child.stderr?.on("data", (chunk) => { evidence = appendEvidence(evidence, chunk); });
    const finish = (status: "passed" | "failed", exitCode: number | null, suffix?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      unregisterProcessTree(ownerId, child);
      resolve({ name: command, command, status, exitCode, evidence: [evidence.trim(), suffix].filter(Boolean).join("\n") });
    };
    const onAbort = () => { terminateProcessTree(child); finish("failed", null, "验收命令随节点执行取消"); };
    const timer = setTimeout(() => { terminateProcessTree(child); finish("failed", null, `验收命令超过 ${VERIFICATION_TIMEOUT_MS / 60_000} 分钟`); }, VERIFICATION_TIMEOUT_MS);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => finish("failed", null, error.message));
    child.once("close", (code) => finish(code === 0 ? "passed" : "failed", code));
  });
}

export async function runVerificationCommands(commands: string[], cwd: string, signal: AbortSignal, ownerId: string) {
  const checks: WorkflowNodeCheck[] = [];
  for (const command of commands) {
    if (signal.aborted) {
      checks.push({ name: command, command, status: "not_run", exitCode: null, evidence: "节点执行已取消" });
      continue;
    }
    checks.push(await runVerificationCommand(command, cwd, signal, ownerId));
  }
  return checks;
}
