import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadProtectedSkill, type ProtectedSkillRuntime } from "./protectedSkillRuntime.js";

export type SkillReleaseSummary = {
  id: string;
  version: string;
  contentSha256: string;
  signatureVerified: boolean;
  encryptionKeyId: string;
  status: "draft" | "validating" | "staged" | "active" | "retired" | "failed";
  fileSize: number;
  uploadedBy: string;
  notes: string;
  createdAt: string;
  activatedAt: string | null;
  rollbackFrom: string | null;
};

type ReleaseRow = {
  id: string; version: string; encrypted_object_path: string; content_sha256: string; signature: string;
  encryption_key_id: string; status: SkillReleaseSummary["status"]; file_size: number; uploaded_by: string;
  notes: string | null; created_at: string; activated_at: string | null; rollback_from: string | null;
};

export class ConfidentialSkillManager {
  private readonly releaseDir: string;
  private readonly activePath: string;

  constructor(private readonly root: string, private readonly runtimeDir: string, private readonly db: DatabaseSync) {
    this.releaseDir = path.join(runtimeDir, "skill-releases");
    this.activePath = path.join(root, "skills", "claude-codex-workflow", "SKILL.md");
    fs.mkdirSync(this.releaseDir, { recursive: true, mode: 0o700 });
  }

  private publicKey() {
    const keyFile = process.env.SKILL_SIGNING_PUBLIC_KEY_FILE ||
      (process.platform === "win32" ? path.join(this.runtimeDir, "skill-signing-public.pem") : "/etc/meta-workbench/skill-signing-public.pem");
    if (!fs.existsSync(keyFile)) throw new Error("尚未配置 Skill 签名公钥，不能发布新版本");
    return fs.readFileSync(keyFile, "utf8");
  }

  private ensureLegacyRelease() {
    const active = this.db.prepare("SELECT id FROM skill_releases WHERE status = 'active' LIMIT 1").get();
    if (active || !fs.existsSync(this.activePath)) return;
    const payload = fs.readFileSync(this.activePath);
    const hash = crypto.createHash("sha256").update(payload).digest("hex");
    const id = `skill_${crypto.randomUUID()}`;
    const stored = path.join(this.releaseDir, `${id}.enc`);
    fs.copyFileSync(this.activePath, stored);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO skill_releases
      (id, version, encrypted_object_path, content_sha256, signature, encryption_key_id, status, file_size, uploaded_by, notes, created_at, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
      .run(id, `legacy-${now.slice(0, 10)}`, stored, hash, "legacy", "builtin-v1", payload.length, "system", "部署前已有版本", now, now);
  }

  private summary(row: ReleaseRow): SkillReleaseSummary {
    return {
      id: row.id, version: row.version, contentSha256: row.content_sha256,
      signatureVerified: row.signature !== "legacy", encryptionKeyId: row.encryption_key_id,
      status: row.status, fileSize: row.file_size, uploadedBy: row.uploaded_by, notes: row.notes || "",
      createdAt: row.created_at, activatedAt: row.activated_at, rollbackFrom: row.rollback_from
    };
  }

  listReleases() {
    return (this.db.prepare("SELECT * FROM skill_releases ORDER BY created_at DESC").all() as unknown as ReleaseRow[]).map((row) => this.summary(row));
  }

  getActiveRelease() {
    const row = this.db.prepare("SELECT * FROM skill_releases WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1").get() as unknown as ReleaseRow | undefined;
    return row ? this.summary(row) : null;
  }

  async uploadEncryptedRelease(input: { version: string; payload: Buffer; signature: string; expectedSha256?: string; encryptionKeyId?: string; uploadedBy: string; notes?: string }) {
    const version = input.version.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(version)) throw new Error("版本号格式无效");
    if (input.payload.length < 36 || input.payload.length > 100 * 1024 * 1024) throw new Error("加密包大小无效");
    if (input.payload.subarray(0, 8).toString("ascii") !== "MMSKILL1") throw new Error("不是有效的加密 Skill 包");
    const hash = crypto.createHash("sha256").update(input.payload).digest("hex");
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== hash) throw new Error("上传文件 SHA-256 与声明不一致");
    const signature = Buffer.from(input.signature, "base64");
    if (!signature.length || !crypto.verify(null, input.payload, this.publicKey(), signature)) throw new Error("Skill 发布签名无效");
    const id = `skill_${crypto.randomUUID()}`;
    const target = path.join(this.releaseDir, `${id}.enc`);
    await fsp.writeFile(target, input.payload, { mode: 0o600, flag: "wx" });
    const now = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO skill_releases
        (id, version, encrypted_object_path, content_sha256, signature, encryption_key_id, status, file_size, uploaded_by, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
        .run(id, version, target, hash, input.signature, input.encryptionKeyId || "builtin-v1", input.payload.length, input.uploadedBy, input.notes || "", now);
    } catch (error) {
      await fsp.rm(target, { force: true });
      if (String(error).includes("UNIQUE")) throw new Error("该版本号已经存在");
      throw error;
    }
    return this.validateRelease(id);
  }

  async validateRelease(releaseId: string) {
    const row = this.db.prepare("SELECT * FROM skill_releases WHERE id = ?").get(releaseId) as unknown as ReleaseRow | undefined;
    if (!row) throw new Error("Skill 版本不存在");
    this.db.prepare("UPDATE skill_releases SET status = 'validating' WHERE id = ?").run(releaseId);
    let loaded: ProtectedSkillRuntime | null = null;
    try {
      loaded = await loadProtectedSkill(this.root, row.encrypted_object_path);
      if (!loaded.instructions.trim()) throw new Error("SKILL.md 为空");
      this.db.prepare("UPDATE skill_releases SET status = 'staged' WHERE id = ?").run(releaseId);
      return this.summary({ ...row, status: "staged" });
    } catch (error) {
      this.db.prepare("UPDATE skill_releases SET status = 'failed' WHERE id = ?").run(releaseId);
      throw new Error(`Skill 验证失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      loaded?.cleanup();
    }
  }

  async activateRelease(releaseId: string, rollbackFrom?: string) {
    const row = this.db.prepare("SELECT * FROM skill_releases WHERE id = ?").get(releaseId) as unknown as ReleaseRow | undefined;
    if (!row) throw new Error("Skill 版本不存在");
    if (!['staged', 'retired', 'active'].includes(row.status)) throw new Error("只有验证通过的版本可以激活");
    const temporary = `${this.activePath}.next`;
    await fsp.copyFile(row.encrypted_object_path, temporary);
    const checked = await loadProtectedSkill(this.root, temporary);
    checked.cleanup();
    await fsp.rename(temporary, this.activePath);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE skill_releases SET status = 'retired' WHERE status = 'active' AND id <> ?").run(releaseId);
      this.db.prepare("UPDATE skill_releases SET status = 'active', activated_at = ?, rollback_from = ? WHERE id = ?")
        .run(now, rollbackFrom || null, releaseId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.summary({ ...row, status: "active", activated_at: now, rollback_from: rollbackFrom || null });
  }

  async rollback(releaseId: string) {
    const current = this.getActiveRelease();
    return this.activateRelease(releaseId, current?.id);
  }
}
