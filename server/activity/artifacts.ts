import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ActivityArtifactRef } from "./types.js";

const ARTIFACT_ID = /^[a-f0-9]{32}$/;
const MAX_ARTIFACTS = 1_000;

type StoredActivityArtifact = {
  schemaVersion: 1;
  id: string;
  ownerUserId: string;
  sessionId: string;
  kind: ActivityArtifactRef["kind"];
  mediaType: string;
  content: string;
  createdAt: string;
};

function artifactPath(root: string, id: string) {
  if (!ARTIFACT_ID.test(id)) throw new Error("活动工件 ID 无效");
  return path.join(root, `${id}.json`);
}

async function pruneArtifacts(root: string) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && ARTIFACT_ID.test(path.basename(entry.name, ".json")) && entry.name.endsWith(".json"));
  if (files.length <= MAX_ARTIFACTS) return;
  const stats = await Promise.all(files.map(async (entry) => ({ entry, stat: await fsp.stat(path.join(root, entry.name)) })));
  stats.sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
  await Promise.all(stats.slice(0, files.length - MAX_ARTIFACTS).map(({ entry }) => fsp.unlink(path.join(root, entry.name)).catch(() => undefined)));
}

export async function storeActivityArtifact(root: string, input: Omit<StoredActivityArtifact, "schemaVersion" | "id" | "createdAt">): Promise<ActivityArtifactRef> {
  await fsp.mkdir(root, { recursive: true });
  const id = crypto.randomBytes(16).toString("hex");
  const artifact: StoredActivityArtifact = { schemaVersion: 1, id, createdAt: new Date().toISOString(), ...input };
  const target = artifactPath(root, id);
  const temporary = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(artifact), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporary, target);
  void pruneArtifacts(root).catch(() => undefined);
  return { id, kind: input.kind, mediaType: input.mediaType, size: Buffer.byteLength(input.content) };
}

export async function readActivityArtifact(root: string, id: string, ownerUserId: string) {
  const artifact = JSON.parse(await fsp.readFile(artifactPath(root, id), "utf8")) as StoredActivityArtifact;
  if (artifact.ownerUserId !== ownerUserId) throw new Error("活动工件不存在");
  return artifact;
}

export async function deleteActivityArtifactsForSession(root: string, ownerUserId: string, sessionId: string) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  let deleted = 0;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) return;
    const file = path.join(root, entry.name);
    try {
      const artifact = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<StoredActivityArtifact>;
      if (artifact.ownerUserId !== ownerUserId || artifact.sessionId !== sessionId) return;
      await fsp.rm(file, { force: true });
      deleted += 1;
    } catch {
      // Invalid artifacts are handled by the health scanner, not a session purge.
    }
  }));
  return deleted;
}
