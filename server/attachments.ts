import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertPathInsideRoot } from "./pathBoundary.js";

export const MAX_ATTACHMENT_SIZE = 64 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENTS_TOTAL_SIZE = 200 * 1024 * 1024;

export type Attachment = {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string;
  size: number;
  sha256: string;
};

function safeFileName(value: string) {
  const base = path.basename(value.replaceAll("\0", "")).trim();
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return cleaned || "attachment";
}

let storageRoot: string | undefined;
export function configureAttachmentStorage(root: string) {
  storageRoot = path.resolve(root);
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
}
function safeSessionId(sessionId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(sessionId)) throw new Error("附件任务 ID 无效");
  return sessionId;
}
export function attachmentDirectory(workspaceRoot: string, sessionId: string) {
  return path.join(storageRoot || path.join(workspaceRoot, ".claude-codex", "attachments"), safeSessionId(sessionId));
}
export function attachmentReference(reference: string) {
  let normalized = reference.replaceAll("\\", "/");
  if (storageRoot && normalized.startsWith(`${storageRoot.replaceAll("\\", "/")}/`)) normalized = `@attachments/${normalized.slice(storageRoot.length + 1)}`;
  const match = normalized.match(/^(?:@attachments|\.claude-codex\/attachments)\/([a-zA-Z0-9_-]+)\/([^/]+)$/);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return { sessionId: safeSessionId(match[1]), name: match[2], managed: normalized.startsWith("@attachments/") };
}
export function resolveAttachmentPath(workspaceRoot: string, sessionId: string, reference: string) {
  const parsed = attachmentReference(reference);
  if (!parsed || parsed.sessionId !== sessionId) throw new Error("附件路径不属于当前任务");
  const managed = path.join(attachmentDirectory(workspaceRoot, sessionId), parsed.name);
  if (storageRoot && (parsed.managed || fs.existsSync(managed))) return assertPathInsideRoot(storageRoot, managed, { allowRoot: false });
  if (parsed.managed) throw new Error("附件存储尚未配置");
  return assertPathInsideRoot(workspaceRoot, path.join(workspaceRoot, ".claude-codex", "attachments", sessionId, parsed.name), { allowRoot: false });
}

/** Migrate only attachments referenced by durable session messages, verified by hash. */
export async function migrateSessionAttachments(workspaceRoot: string, sessionId: string, attachments: Attachment[]) {
  if (!storageRoot) return;
  for (const item of attachments) {
    const parsed = attachmentReference(item.relativePath);
    if (!parsed || parsed.managed || parsed.sessionId !== sessionId) continue;
    const source = path.join(workspaceRoot, ".claude-codex", "attachments", sessionId, parsed.name);
    if (!fs.existsSync(source)) continue;
    assertPathInsideRoot(workspaceRoot, source, { allowRoot: false });
    const data = await fsp.readFile(source);
    if (data.length !== item.size || crypto.createHash("sha256").update(data).digest("hex") !== item.sha256) throw new Error(`附件迁移校验失败：${item.name}`);
    const destination = path.join(attachmentDirectory(workspaceRoot, sessionId), parsed.name);
    assertPathInsideRoot(storageRoot, destination, { allowMissing: true });
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(destination)) await fsp.writeFile(destination, data, { flag: "wx", mode: 0o600 });
    if (!(await fsp.readFile(destination)).equals(data)) throw new Error(`附件迁移目标已存在不同内容：${item.name}`);
    // Preserve old bytes for rollback before removing the verified source.
    const backup = path.join(storageRoot, 'legacy-backup', sessionId, parsed.name);
    assertPathInsideRoot(storageRoot, backup, { allowMissing: true });
    await fsp.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(backup)) await fsp.writeFile(backup, data, { flag: "wx", mode: 0o600 });
    if (!(await fsp.readFile(backup)).equals(data)) throw new Error("附件迁移备份校验失败");
    if ((await fsp.readFile(source)).equals(data)) await fsp.unlink(source);
    for (const directory of [path.dirname(source), path.dirname(path.dirname(source)), path.join(workspaceRoot, '.claude-codex')]) {
      try { await fsp.rmdir(directory); } catch { break; }
    }
  }
}

export async function storeAttachment(input: {
  workspaceRoot: string;
  sessionId: string;
  originalName: string;
  mimeType?: string;
  data: Buffer;
}): Promise<Attachment> {
  if (!Buffer.isBuffer(input.data) || input.data.length === 0) throw new Error("附件内容为空");
  if (input.data.length > MAX_ATTACHMENT_SIZE) throw new Error("单个附件不能超过 64 MB");

  const id = `att_${crypto.randomUUID()}`;
  const name = safeFileName(input.originalName);
  const extension = path.extname(name);
  const stem = path.basename(name, extension).slice(0, Math.max(1, 150 - extension.length));
  const storedName = `${stem}-${id.slice(-8)}${extension}`;
  const directory = attachmentDirectory(input.workspaceRoot, input.sessionId);
  const target = path.join(directory, storedName);
  assertPathInsideRoot(storageRoot || input.workspaceRoot, target, { allowMissing: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(directory, { recursive: true });
  try {
    await fsp.writeFile(temporary, input.data, { flag: "wx" });
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const relativePath = storageRoot ? `@attachments/${input.sessionId}/${storedName}` : path.relative(input.workspaceRoot, target).replaceAll("\\", "/");
  return {
    id,
    name,
    relativePath,
    mimeType: String(input.mimeType || "application/octet-stream").slice(0, 200),
    size: input.data.length,
    sha256: crypto.createHash("sha256").update(input.data).digest("hex")
  };
}

export async function validateAttachments(input: {
  workspaceRoot: string;
  sessionId: string;
  value: unknown;
}): Promise<Attachment[]> {
  if (input.value === undefined || input.value === null) return [];
  if (!Array.isArray(input.value)) throw new Error("附件清单格式无效");
  if (input.value.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error("每轮最多附加 10 个文件");
  const seen = new Set<string>();
  const attachments: Attachment[] = [];
  let totalSize = 0;

  for (const raw of input.value) {
    if (!raw || typeof raw !== "object") throw new Error("附件清单格式无效");
    const item = raw as Partial<Attachment>;
    const attachment: Attachment = {
      id: String(item.id || ""),
      name: safeFileName(String(item.name || "attachment")),
      relativePath: String(item.relativePath || "").replaceAll("\\", "/"),
      mimeType: String(item.mimeType || "application/octet-stream").slice(0, 200),
      size: Number(item.size || 0),
      sha256: String(item.sha256 || "")
    };
    if (!attachment.id || seen.has(attachment.id)) throw new Error("附件清单包含重复或无效项目");
    if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > MAX_ATTACHMENT_SIZE) throw new Error("附件大小无效");
    if (!/^[a-f0-9]{64}$/i.test(attachment.sha256)) throw new Error("附件校验信息无效");
    const absolute = resolveAttachmentPath(input.workspaceRoot, input.sessionId, attachment.relativePath);
    const stat = await fsp.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size !== attachment.size) throw new Error(`附件不存在或已损坏：${attachment.name}`);
    if (crypto.createHash("sha256").update(await fsp.readFile(absolute)).digest("hex") !== attachment.sha256) throw new Error(`附件校验失败：${attachment.name}`);
    totalSize += attachment.size;
    if (totalSize > MAX_ATTACHMENTS_TOTAL_SIZE) throw new Error("单轮附件总大小不能超过 200 MB");
    seen.add(attachment.id);
    attachments.push(attachment);
  }
  return attachments;
}

export async function deleteSessionAttachments(workspaceRoot: string, sessionId: string) {
  const target = attachmentDirectory(workspaceRoot, sessionId);
  assertPathInsideRoot(storageRoot || workspaceRoot, target, { allowMissing: true, allowRoot: false });
  await fsp.rm(target, { recursive: true, force: true });
  if (storageRoot) {
    const backup = path.join(storageRoot, "legacy-backup", safeSessionId(sessionId));
    assertPathInsideRoot(storageRoot, backup, { allowMissing: true, allowRoot: false });
    await fsp.rm(backup, { recursive: true, force: true });
  }
}

function attachmentAgentPath(item: Attachment) {
  const parsed = attachmentReference(item.relativePath);
  if (storageRoot && parsed) {
    const target = path.join(storageRoot, parsed.sessionId, parsed.name);
    if (fs.existsSync(target)) return assertPathInsideRoot(storageRoot, target, { allowRoot: false });
  }
  return item.relativePath;
}

export function attachmentPrompt(text: string, attachments: Attachment[]) {
  if (!attachments.length) return text;
  const list = attachments.map((item, index) =>
    `${index + 1}. ${item.name} | 路径：${attachmentAgentPath(item)} | 类型：${item.mimeType} | 大小：${item.size} bytes | SHA-256：${item.sha256}`
  );
  return [
    text || "请处理以下附件。",
    "本轮附件已保存到工作台的任务附件目录。请按任务需要直接读取这些路径；不要假设附件内容已被嵌入对话上下文。",
    ...list
  ].join("\n\n");
}
