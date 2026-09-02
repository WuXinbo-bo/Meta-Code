import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
import { storeActivityArtifact } from "./artifacts.js";
import { assertPathInsideRoot } from "../pathBoundary.js";

const FILE_SNAPSHOT_LIMIT = 1_000_000;
const INLINE_DIFF_LINES = 240;
const INLINE_DIFF_CHARACTERS = 64_000;
const TURN_UNTRACKED_SNAPSHOT_BUDGET = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export type ActivityFileSnapshot =
  | { kind: "text"; content: string }
  | { kind: "missing" }
  | { kind: "binary" }
  | { kind: "large"; size: number }
  | { kind: "unavailable"; reason: string };

export type EventFileDiffPreview = {
  available: boolean;
  reason: string;
  lines: string[];
  additions: number;
  deletions: number;
  truncated: boolean;
  binary: boolean;
  scope: "event";
  artifactId?: string;
};

export type ActivityTurnFileBaseline = {
  workspaceRoot: string;
  gitTreeish: string;
  gitUnavailableReason: string;
  untracked: Map<string, ActivityFileSnapshot>;
  rolling: Map<string, ActivityFileSnapshot>;
};

function baselinePath(workspaceRoot: string, requestedPath: string) {
  const root = path.resolve(workspaceRoot);
  const target = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(root, requestedPath);
  assertPathInsideRoot(root, target, { allowRoot: false, allowMissing: true });
  const relative = path.relative(root, target).replaceAll("\\", "/");
  return { relative, key: process.platform === "win32" ? relative.toLowerCase() : relative };
}

export async function createActivityTurnFileBaseline(workspaceRoot: string): Promise<ActivityTurnFileBaseline> {
  const baseline: ActivityTurnFileBaseline = { workspaceRoot: path.resolve(workspaceRoot), gitTreeish: "", gitUnavailableReason: "", untracked: new Map(), rolling: new Map() };
  try {
    const created = await execFileAsync("git", ["-C", baseline.workspaceRoot, "stash", "create"], { encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    baseline.gitTreeish = String(created.stdout || "").trim();
    if (!baseline.gitTreeish) {
      const head = await execFileAsync("git", ["-C", baseline.workspaceRoot, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", timeout: 8_000, windowsHide: true, maxBuffer: 1024 * 1024 });
      baseline.gitTreeish = String(head.stdout || "").trim();
    }
    const listed = await execFileAsync("git", ["-C", baseline.workspaceRoot, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    let remaining = TURN_UNTRACKED_SNAPSHOT_BUDGET;
    for (const relative of String(listed.stdout || "").split("\0").filter(Boolean)) {
      const normalized = baselinePath(baseline.workspaceRoot, relative);
      const snapshot = await readActivityFileSnapshot(baseline.workspaceRoot, relative);
      if (snapshot.kind === "text") {
        const bytes = Buffer.byteLength(snapshot.content);
        if (bytes > remaining) {
          baseline.untracked.set(normalized.key, { kind: "unavailable", reason: "任务开始时的未跟踪文件快照超过总预算" });
          continue;
        }
        remaining -= bytes;
      }
      baseline.untracked.set(normalized.key, snapshot);
    }
  } catch (error) {
    baseline.gitUnavailableReason = `无法建立任务开始前的 Git 文件基线：${error instanceof Error ? error.message : String(error)}`;
  }
  return baseline;
}

export async function readActivityTurnFileBaseline(baseline: ActivityTurnFileBaseline, requestedPath: string): Promise<ActivityFileSnapshot> {
  let normalized: ReturnType<typeof baselinePath>;
  try { normalized = baselinePath(baseline.workspaceRoot, requestedPath); }
  catch (error) { return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
  const rolling = baseline.rolling.get(normalized.key);
  if (rolling) return rolling;
  const untracked = baseline.untracked.get(normalized.key);
  if (untracked) return untracked;
  if (!baseline.gitTreeish) return baseline.gitUnavailableReason ? { kind: "unavailable", reason: baseline.gitUnavailableReason } : { kind: "missing" };
  try {
    const result = await execFileAsync("git", ["-C", baseline.workspaceRoot, "show", `${baseline.gitTreeish}:${normalized.relative}`], { encoding: "buffer", timeout: 8_000, windowsHide: true, maxBuffer: FILE_SNAPSHOT_LIMIT + 1 });
    const buffer = Buffer.from(result.stdout);
    if (buffer.length > FILE_SNAPSHOT_LIMIT) return { kind: "large", size: buffer.length };
    return buffer.includes(0) ? { kind: "binary" } : { kind: "text", content: buffer.toString("utf8") };
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr || "");
    return /does not exist|exists on disk, but not in|invalid object name|Path .* does not exist/i.test(stderr)
      ? { kind: "missing" }
      : { kind: "unavailable", reason: `无法读取任务开始前的文件：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function advanceActivityTurnFileBaseline(baseline: ActivityTurnFileBaseline, requestedPath: string, snapshot: ActivityFileSnapshot) {
  try { baseline.rolling.set(baselinePath(baseline.workspaceRoot, requestedPath).key, snapshot); }
  catch { /* The diff itself reports paths outside the workspace. */ }
}

export async function readActivityFileSnapshot(workspaceRoot: string, relativePath: string): Promise<ActivityFileSnapshot> {
  try {
    const root = path.resolve(workspaceRoot);
    const target = path.resolve(root, relativePath);
    assertPathInsideRoot(root, target, { allowRoot: false });
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return { kind: "unavailable", reason: "目标不是普通文件" };
    if (stat.size > FILE_SNAPSHOT_LIMIT) return { kind: "large", size: stat.size };
    const buffer = await fsp.readFile(target);
    return buffer.includes(0) ? { kind: "binary" } : { kind: "text", content: buffer.toString("utf8") };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function createEventFileDiff(input: {
  pathname: string;
  before: ActivityFileSnapshot;
  after: ActivityFileSnapshot;
  artifactRoot: string;
  ownerUserId: string;
  sessionId: string;
}) {
  const { pathname, before, after } = input;
  if (before.kind === "binary" || after.kind === "binary") return { preview: { available: false, reason: "二进制文件不提供文本差异", lines: [], additions: 0, deletions: 0, truncated: false, binary: true, scope: "event" as const } };
  if (before.kind === "large" || after.kind === "large") return { preview: { available: false, reason: `文件超过事件快照预算（${Math.max(before.kind === "large" ? before.size : 0, after.kind === "large" ? after.size : 0).toLocaleString()} bytes）`, lines: [], additions: 0, deletions: 0, truncated: false, binary: false, scope: "event" as const } };
  if (before.kind === "unavailable" || after.kind === "unavailable") return { preview: { available: false, reason: before.kind === "unavailable" ? before.reason : after.kind === "unavailable" ? after.reason : "无法读取事件快照", lines: [], additions: 0, deletions: 0, truncated: false, binary: false, scope: "event" as const } };
  const oldText = before.kind === "text" ? before.content : "";
  const newText = after.kind === "text" ? after.content : "";
  if (oldText === newText && before.kind === after.kind) return { preview: { available: false, reason: "本次文件事件没有产生可见的文本差异", lines: [], additions: 0, deletions: 0, truncated: false, binary: false, scope: "event" as const } };
  const patchText = createTwoFilesPatch(before.kind === "missing" ? "/dev/null" : `a/${pathname}`, after.kind === "missing" ? "/dev/null" : `b/${pathname}`, oldText, newText, "", "", { context: 3 });
  const allLines = patchText.trimEnd().split(/\r?\n/);
  const additions = allLines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = allLines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const truncated = allLines.length > INLINE_DIFF_LINES || patchText.length > INLINE_DIFF_CHARACTERS;
  if (!truncated) return { preview: { available: true, reason: "", lines: allLines, additions, deletions, truncated: false, binary: false, scope: "event" as const } };
  const artifact = await storeActivityArtifact(input.artifactRoot, { ownerUserId: input.ownerUserId, sessionId: input.sessionId, kind: "diff", mediaType: "text/x-diff", content: patchText });
  return { artifact, preview: { available: true, reason: "", lines: allLines.slice(0, INLINE_DIFF_LINES), additions, deletions, truncated: true, binary: false, scope: "event" as const, artifactId: artifact.id } };
}
