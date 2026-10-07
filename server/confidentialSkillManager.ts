import type { DatabaseSync } from "node:sqlite";

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

/** Read-only archive of releases from the retired Skill protocol. */
export class ConfidentialSkillManager {
  constructor(_root: string, _runtimeDir: string, private readonly db: DatabaseSync) {}

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

}
