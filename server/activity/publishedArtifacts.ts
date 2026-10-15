import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export type PublishedArtifact = {
  schemaVersion: 1;
  id: string;
  ownerUserId: string;
  sessionId: string;
  title: string;
  description: string;
  mediaType: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  published: boolean;
};

const ID = /^[a-f0-9]{32}$/;
function safeId(value: string) { if (!ID.test(value)) throw new Error("Artifact ID 无效"); return value; }
function file(root: string, id: string) { return path.join(root, `${safeId(id)}.json`); }
function cleanText(value: unknown, max: number) { return String(value || "").trim().slice(0, max); }

export async function createPublishedArtifact(root: string, input: Pick<PublishedArtifact, "ownerUserId" | "sessionId" | "title" | "description" | "mediaType" | "content">) {
  if (!input.ownerUserId || !input.sessionId) throw new Error("Artifact 必须关联用户和任务");
  if (!input.content || Buffer.byteLength(input.content, "utf8") > 5 * 1024 * 1024) throw new Error("Artifact 内容为空或超过 5MB");
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const artifact: PublishedArtifact = {
    schemaVersion: 1, id: crypto.randomBytes(16).toString("hex"), ownerUserId: input.ownerUserId,
    sessionId: input.sessionId, title: cleanText(input.title, 160) || "未命名 Artifact", description: cleanText(input.description, 1_000),
    mediaType: cleanText(input.mediaType, 120) || "text/plain", content: input.content, version: 1, createdAt: now, updatedAt: now, published: false
  };
  await fsp.writeFile(file(root, artifact.id), JSON.stringify(artifact), { encoding: "utf8", mode: 0o600 });
  return structuredClone(artifact);
}

export async function readPublishedArtifact(root: string, id: string, ownerUserId: string) {
  const artifact = JSON.parse(await fsp.readFile(file(root, id), "utf8")) as PublishedArtifact;
  if (artifact.ownerUserId !== ownerUserId) throw new Error("Artifact 不存在");
  return artifact;
}

export async function updatePublishedArtifact(root: string, id: string, ownerUserId: string, patch: Partial<Pick<PublishedArtifact, "title" | "description" | "mediaType" | "content" | "published">>) {
  const artifact = await readPublishedArtifact(root, id, ownerUserId);
  const content = patch.content === undefined ? artifact.content : String(patch.content);
  if (!content || Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) throw new Error("Artifact 内容为空或超过 5MB");
  const next: PublishedArtifact = {
    ...artifact,
    title: patch.title === undefined ? artifact.title : cleanText(patch.title, 160) || artifact.title,
    description: patch.description === undefined ? artifact.description : cleanText(patch.description, 1_000),
    mediaType: patch.mediaType === undefined ? artifact.mediaType : cleanText(patch.mediaType, 120) || artifact.mediaType,
    content, published: patch.published === undefined ? artifact.published : Boolean(patch.published),
    version: artifact.version + 1, updatedAt: new Date().toISOString()
  };
  const temporary = `${file(root, id)}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporary, file(root, id));
  return structuredClone(next);
}

export async function listPublishedArtifacts(root: string, ownerUserId: string, sessionId?: string) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const result: PublishedArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const artifact = JSON.parse(await fsp.readFile(path.join(root, entry.name), "utf8")) as PublishedArtifact;
      if (artifact.ownerUserId === ownerUserId && (!sessionId || artifact.sessionId === sessionId)) result.push(artifact);
    } catch { /* invalid artifacts are ignored and handled by diagnostics */ }
  }
  return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
