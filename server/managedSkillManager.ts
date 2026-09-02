import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Response } from "express";

export type PublicSkillSummary = {
  name: string;
  title: string;
  description: string;
  builtIn: boolean;
};

export type AdminSkillSummary = PublicSkillSummary & {
  fileCount: number;
  totalSize: number;
  updatedAt: string;
};

export type SkillPromptContext = PublicSkillSummary & {
  root: string;
  instructions: string;
  files: string[];
};

type UploadFile = { path: string; content: string };

const MAX_FILES = 5_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_EDITABLE_FILE_SIZE = 1024 * 1024;
const MAX_TOTAL_SIZE = 200 * 1024 * 1024;
const DIRECTORY_RENAME_ATTEMPTS = 10;
export const BUILTIN_DELEGATION_SKILL_NAME = "claude-codex-planner";
export const BUILTIN_SKILL_MANAGER_NAME = "metacode-manager";
const LEGACY_SKILL_MANAGER_NAME = "workbench-skill-manager";
const BUILTIN_SKILL_NAMES = new Set([BUILTIN_DELEGATION_SKILL_NAME, BUILTIN_SKILL_MANAGER_NAME, "workbench-skill-manager"]);

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isTransientWindowsFsError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function safeSkillName(value: string) {
  const name = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error("Skill 文件夹名称格式无效");
  return name;
}

function safeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Skill 文件路径无效");
  }
  return normalized;
}

function metadata(content: string, fallback: string) {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/m)?.[1] || "";
  const read = (key: string) => {
    const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "mi"))?.[1]?.trim() || "";
    return value.replace(/^(["'])(.*)\1$/, "$2");
  };
  return { title: read("title") || read("name") || fallback, description: read("description") };
}

function safeDisplayName(value: string) {
  const name = value.trim().replace(/[\u0000-\u001f]/g, "").slice(0, 80);
  if (!name) throw new Error("显示名不能为空");
  return name;
}

async function walk(root: string, current = root): Promise<Array<{ path: string; size: number; updatedAt: string }>> {
  const result: Array<{ path: string; size: number; updatedAt: string }> = [];
  for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...await walk(root, absolute));
    else if (entry.isFile()) {
      const stat = await fsp.stat(absolute);
      result.push({ path: path.relative(root, absolute).replace(/\\/g, "/"), size: stat.size, updatedAt: stat.mtime.toISOString() });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function walkSync(root: string, current = root): Array<{ path: string; size: number }> {
  const result: Array<{ path: string; size: number }> = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...walkSync(root, absolute));
    else if (entry.isFile()) {
      const stat = fs.statSync(absolute);
      result.push({ path: path.relative(root, absolute).replace(/\\/g, "/"), size: stat.size });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export class ManagedSkillManager {
  readonly root: string;
  private readonly mutationQueues = new Map<string, Promise<void>>();

  constructor(root: string, directRoot = false) {
    this.root = directRoot ? root : path.join(root, "managed-skills");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private skillRoot(name: string) {
    return path.join(this.root, safeSkillName(name));
  }

  folderPath(name: string) {
    const safeName = safeSkillName(name);
    const target = this.skillRoot(safeName);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error("Skill 不存在");
    return target;
  }

  private filePath(name: string, relative: string) {
    const root = this.skillRoot(name);
    const target = path.resolve(root, safeRelativePath(relative));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Skill 文件路径越界");
    return target;
  }

  private async withSkillMutationLock<T>(name: string, action: () => Promise<T>) {
    const previous = this.mutationQueues.get(name) || Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.mutationQueues.set(name, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.mutationQueues.get(name) === tail) this.mutationQueues.delete(name);
    }
  }

  private async commitDirectory(temporary: string, target: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < DIRECTORY_RENAME_ATTEMPTS; attempt += 1) {
      if (fs.existsSync(target)) throw new Error("同名 Skill 已存在，请删除后重新导入");
      try {
        await fsp.rename(temporary, target);
        return;
      } catch (error) {
        lastError = error;
        if (fs.existsSync(target)) throw new Error("同名 Skill 已存在，请删除后重新导入");
        if (!isTransientWindowsFsError(error)) throw error;
        await delay(Math.min(100 * 2 ** attempt, 1_000));
      }
    }
    const detail = (lastError as NodeJS.ErrnoException)?.code || "unknown";
    throw new Error(`Skill 导入提交失败：目录正被其他程序占用，请稍后重试（${detail}）`);
  }

  private readMetadata(name: string): PublicSkillSummary | null {
    try {
      const content = fs.readFileSync(this.filePath(name, "SKILL.md"), "utf8");
      let displayName = "";
      try { displayName = fs.readFileSync(this.filePath(name, ".workbench-display-name"), "utf8").trim(); } catch { /* optional metadata */ }
      return { name, ...metadata(content, name), ...(displayName ? { title: displayName } : {}), builtIn: BUILTIN_SKILL_NAMES.has(name) };
    } catch {
      return null;
    }
  }

  async renameDisplayName(name: string, displayName: string) {
    const safeName = safeSkillName(name);
    const target = this.skillRoot(safeName);
    if (!fs.existsSync(target)) throw new Error("Skill 不存在");
    const value = safeDisplayName(displayName);
    await this.withSkillMutationLock(safeName, async () => {
      const file = this.filePath(safeName, ".workbench-display-name");
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temporary, file);
    });
    const summary = this.readMetadata(safeName);
    if (!summary) throw new Error("Skill 显示名更新后无法读取");
    return summary;
  }

  listPublic(): PublicSkillSummary[] {
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== LEGACY_SKILL_MANAGER_NAME)
      .map((entry) => this.readMetadata(entry.name))
      .filter((item): item is PublicSkillSummary => Boolean(item))
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  }

  async listAdmin(): Promise<AdminSkillSummary[]> {
    return Promise.all(this.listPublic().map(async (skill) => {
      const files = await walk(this.skillRoot(skill.name));
      return {
        ...skill,
        fileCount: files.length,
        totalSize: files.reduce((sum, file) => sum + file.size, 0),
        updatedAt: files.reduce((latest, file) => file.updatedAt > latest ? file.updatedAt : latest, "")
      };
    }));
  }

  async tree(name: string) {
    const root = this.skillRoot(name);
    if (!fs.existsSync(root)) throw new Error("Skill 不存在");
    return walk(root);
  }

  async uploadFolder(input: { name: string; files: UploadFile[] }) {
    const name = safeSkillName(input.name);
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > MAX_FILES) throw new Error("Skill 文件数量无效");
    const decoded = input.files.map((file) => ({ path: safeRelativePath(String(file.path || "")), content: Buffer.from(String(file.content || ""), "base64") }));
    if (decoded.some((file) => file.content.length > MAX_FILE_SIZE)) throw new Error("单个 Skill 文件不能超过 50 MB");
    if (decoded.reduce((sum, file) => sum + file.content.length, 0) > MAX_TOTAL_SIZE) throw new Error("Skill 文件夹不能超过 200 MB");
    if (!decoded.some((file) => file.path.toLowerCase() === "skill.md")) throw new Error("Skill 文件夹根目录必须包含 SKILL.md");

    return this.withSkillMutationLock(name, async () => {
      const target = this.skillRoot(name);
      if (fs.existsSync(target)) throw new Error("同名 Skill 已存在，请删除后重新上传或直接编辑文件");
      const temporary = path.join(this.root, `.upload-${crypto.randomUUID()}`);
      await fsp.mkdir(temporary, { recursive: true, mode: 0o700 });
      try {
        for (const file of decoded) {
          const destination = path.resolve(temporary, file.path);
          if (!destination.startsWith(`${temporary}${path.sep}`)) throw new Error("Skill 文件路径越界");
          await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await fsp.writeFile(destination, file.content, { mode: 0o600 });
          file.content.fill(0);
        }
        await this.commitDirectory(temporary, target);
      } catch (error) {
        await fsp.rm(temporary, { recursive: true, force: true });
        throw error;
      }
      const summary = this.readMetadata(name);
      if (!summary) throw new Error("SKILL.md 无法读取");
      return summary;
    });
  }

  async importFolder(sourcePath: string) {
    const source = path.resolve(String(sourcePath || "").trim());
    const stat = await fsp.stat(source);
    if (!stat.isDirectory()) throw new Error("请选择 Skill 文件夹");
    const relativeToManaged = path.relative(this.root, source);
    if (!relativeToManaged.startsWith("..") && !path.isAbsolute(relativeToManaged)) throw new Error("不能从 Skill 托管目录内部重复导入");
    const files = await walk(source);
    if (!files.length || files.length > MAX_FILES) throw new Error("Skill 文件数量无效");
    if (!files.some((file) => file.path.toLowerCase() === "skill.md")) throw new Error("Skill 文件夹根目录必须包含 SKILL.md");
    if (files.some((file) => file.size > MAX_FILE_SIZE)) throw new Error("单个 Skill 文件不能超过 50 MB");
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_SIZE) throw new Error("Skill 文件夹不能超过 200 MB");
    const uploadFiles = await Promise.all(files.map(async (file) => ({
      path: file.path,
      content: (await fsp.readFile(path.join(source, file.path))).toString("base64")
    })));
    return this.uploadFolder({ name: path.basename(source), files: uploadFiles });
  }

  async readFile(name: string, relative: string) {
    const target = this.filePath(name, relative);
    const stat = await fsp.stat(target);
    if (!stat.isFile() || stat.size > MAX_EDITABLE_FILE_SIZE) throw new Error("文件不存在或超过 1 MB 编辑安全预算，请下载后使用本地编辑器处理");
    return fsp.readFile(target, "utf8");
  }

  async writeFile(name: string, relative: string, content: string) {
    const target = this.filePath(name, relative);
    if (!fs.existsSync(this.skillRoot(name))) throw new Error("Skill 不存在");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_SIZE) throw new Error("单个 Skill 文件不能超过 50 MB");
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporary, content, { mode: 0o600 });
    await fsp.rename(temporary, target);
  }

  async remove(name: string) {
    if (BUILTIN_SKILL_NAMES.has(safeSkillName(name))) throw new Error("系统内置 Skill 不能删除");
    const target = this.skillRoot(name);
    if (!fs.existsSync(target)) throw new Error("Skill 不存在");
    await fsp.rm(target, { recursive: true, force: true });
  }

  promptContext(name: string): SkillPromptContext {
    const summary = this.readMetadata(name);
    if (!summary) throw new Error("所选 Skill 不存在");
    const root = this.skillRoot(name);
    const instructions = fs.readFileSync(this.filePath(name, "SKILL.md"), "utf8");
    const files = walkSync(root)
      .map((file) => file.path)
      .filter((file) => file.toLowerCase() !== "skill.md");
    return { ...summary, root, instructions, files };
  }

  download(name: string, res: Response) {
    const root = this.skillRoot(name);
    if (!fs.existsSync(root)) throw new Error("Skill 不存在");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeSkillName(name)}.tar.gz"`);
    const child = spawn("tar", ["-czf", "-", "-C", this.root, safeSkillName(name)], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(res);
    child.once("error", (error) => { if (!res.headersSent) res.status(500).json({ error: error.message }); else res.destroy(error); });
    child.once("close", (code) => { if (code !== 0 && !res.writableEnded) res.destroy(new Error("Skill 下载打包失败")); });
  }
}
