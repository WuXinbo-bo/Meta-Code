import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readActivityArtifact } from "../server/activity/artifacts.ts";
import {
  advanceActivityTurnFileBaseline,
  createActivityTurnFileBaseline,
  createEventFileDiff,
  readActivityFileSnapshot,
  readActivityTurnFileBaseline
} from "../server/activity/fileDiff.ts";

const execFileAsync = promisify(execFile);

const temporary = await mkdtemp(path.join(os.tmpdir(), "metacode-activity-diff-"));
const context = { artifactRoot: temporary, ownerUserId: "owner-1", sessionId: "session-1" };
try {
  const original = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
  const changed = [...original];
  changed[1] = "line 2 changed";
  changed[20] = "line 21 changed";
  const multiHunk = await createEventFileDiff({ pathname: "src/example.ts", before: { kind: "text", content: original.join("\n") }, after: { kind: "text", content: changed.join("\n") }, ...context });
  assert.equal(multiHunk.preview.additions, 2);
  assert.equal(multiHunk.preview.deletions, 2);
  assert.ok(multiHunk.preview.lines.filter((line) => line.startsWith("@@")).length >= 2);

  const first = await createEventFileDiff({ pathname: "same.txt", before: { kind: "text", content: "one\ntwo\n" }, after: { kind: "text", content: "one\nsecond\n" }, ...context });
  const second = await createEventFileDiff({ pathname: "same.txt", before: { kind: "text", content: "one\nsecond\n" }, after: { kind: "text", content: "one\nthird\n" }, ...context });
  assert.ok(first.preview.lines.some((line) => line === "+second"));
  assert.ok(second.preview.lines.some((line) => line === "-second"));
  assert.ok(second.preview.lines.some((line) => line === "+third"));

  const added = await createEventFileDiff({ pathname: "new.txt", before: { kind: "missing" }, after: { kind: "text", content: "new\n" }, ...context });
  const deleted = await createEventFileDiff({ pathname: "old.txt", before: { kind: "text", content: "old\n" }, after: { kind: "missing" }, ...context });
  assert.equal(added.preview.additions, 1);
  assert.equal(deleted.preview.deletions, 1);
  assert.match(added.preview.lines.join("\n"), /\/dev\/null/);

  const binary = await createEventFileDiff({ pathname: "image.png", before: { kind: "binary" }, after: { kind: "binary" }, ...context });
  assert.equal(binary.preview.available, false);
  assert.equal(binary.preview.binary, true);
  const unchanged = await createEventFileDiff({ pathname: "same.txt", before: { kind: "text", content: "same\n" }, after: { kind: "text", content: "same\n" }, ...context });
  assert.equal(unchanged.preview.available, false);
  assert.equal(unchanged.preview.additions, 0);
  assert.equal(unchanged.preview.deletions, 0);
  assert.match(unchanged.preview.reason, /没有产生可见的文本差异/);
  const largeUnavailable = await createEventFileDiff({ pathname: "large.txt", before: { kind: "large", size: 2_000_000 }, after: { kind: "large", size: 2_000_001 }, ...context });
  assert.equal(largeUnavailable.preview.available, false);

  const manyBefore = Array.from({ length: 400 }, (_, index) => `before ${index}`).join("\n");
  const manyAfter = Array.from({ length: 400 }, (_, index) => `after ${index}`).join("\n");
  const artifactDiff = await createEventFileDiff({ pathname: "large-change.txt", before: { kind: "text", content: manyBefore }, after: { kind: "text", content: manyAfter }, ...context });
  assert.equal(artifactDiff.preview.truncated, true);
  assert.ok(artifactDiff.preview.artifactId);
  const artifact = await readActivityArtifact(temporary, artifactDiff.preview.artifactId, "owner-1");
  assert.match(artifact.content, /after 399/);
  await assert.rejects(readActivityArtifact(temporary, artifactDiff.preview.artifactId, "other-owner"), /活动工件不存在/);

  const repository = path.join(temporary, "repository");
  await mkdir(repository);
  const git = (...args) => execFileAsync("git", ["-C", repository, ...args], { encoding: "utf8" });
  await git("init");
  await git("config", "user.email", "activity-test@example.invalid");
  await git("config", "user.name", "Activity Test");
  await writeFile(path.join(repository, "tracked.txt"), "committed\n", "utf8");
  await writeFile(path.join(repository, "committed-during-turn.txt"), "before commit\n", "utf8");
  await git("add", ".");
  await git("commit", "-m", "baseline");

  await writeFile(path.join(repository, "tracked.txt"), "prepared before task\n", "utf8");
  await writeFile(path.join(repository, "untracked.txt"), "untracked before task\n", "utf8");
  const baseline = await createActivityTurnFileBaseline(repository);

  assert.deepEqual(await readActivityTurnFileBaseline(baseline, "tracked.txt"), { kind: "text", content: "prepared before task\n" });
  assert.deepEqual(await readActivityTurnFileBaseline(baseline, "untracked.txt"), { kind: "text", content: "untracked before task\n" });
  assert.deepEqual(await readActivityTurnFileBaseline(baseline, "created-by-agent.txt"), { kind: "missing" });

  await writeFile(path.join(repository, "tracked.txt"), "first agent edit\n", "utf8");
  const firstAfter = await readActivityFileSnapshot(repository, "tracked.txt");
  const trackedDiff = await createEventFileDiff({ pathname: "tracked.txt", before: await readActivityTurnFileBaseline(baseline, "tracked.txt"), after: firstAfter, ...context });
  assert.ok(trackedDiff.preview.lines.includes("-prepared before task"));
  assert.ok(trackedDiff.preview.lines.includes("+first agent edit"));
  advanceActivityTurnFileBaseline(baseline, "tracked.txt", firstAfter);

  await writeFile(path.join(repository, "tracked.txt"), "second agent edit\n", "utf8");
  const secondAfter = await readActivityFileSnapshot(repository, "tracked.txt");
  const rollingDiff = await createEventFileDiff({ pathname: "tracked.txt", before: await readActivityTurnFileBaseline(baseline, "tracked.txt"), after: secondAfter, ...context });
  assert.ok(rollingDiff.preview.lines.includes("-first agent edit"));
  assert.ok(rollingDiff.preview.lines.includes("+second agent edit"));

  await writeFile(path.join(repository, "untracked.txt"), "untracked agent edit\n", "utf8");
  const untrackedDiff = await createEventFileDiff({ pathname: "untracked.txt", before: await readActivityTurnFileBaseline(baseline, "untracked.txt"), after: await readActivityFileSnapshot(repository, "untracked.txt"), ...context });
  assert.ok(untrackedDiff.preview.lines.includes("-untracked before task"));
  assert.ok(untrackedDiff.preview.lines.includes("+untracked agent edit"));

  await writeFile(path.join(repository, "committed-during-turn.txt"), "agent edit committed\n", "utf8");
  await git("add", "committed-during-turn.txt");
  await git("commit", "-m", "agent commit");
  const committedDuringTurnDiff = await createEventFileDiff({ pathname: "committed-during-turn.txt", before: await readActivityTurnFileBaseline(baseline, "committed-during-turn.txt"), after: await readActivityFileSnapshot(repository, "committed-during-turn.txt"), ...context });
  assert.ok(committedDuringTurnDiff.preview.lines.includes("-before commit"));
  assert.ok(committedDuringTurnDiff.preview.lines.includes("+agent edit committed"));
  assert.equal(await readFile(path.join(repository, "committed-during-turn.txt"), "utf8"), "agent edit committed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("Event-scoped file diff, multi-hunk previews and lazy artifacts OK");
