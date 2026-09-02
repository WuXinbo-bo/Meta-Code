import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const managedRoot = path.resolve(scriptDir, "..", "..");
const maxFiles = 5_000;
const maxTotalBytes = 200 * 1024 * 1024;

function argsOf(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) result._.push(value);
    else {
      const key = value.slice(2);
      const next = values[index + 1];
      if (!next || next.startsWith("--")) result[key] = true;
      else { result[key] = next; index += 1; }
    }
  }
  return result;
}

function skillName(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized.length > 64) throw new Error("Skill 名称必须是 1-64 位小写字母、数字或连字符");
  return normalized;
}

function safeRelative(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`无效文件路径：${value}`);
  return normalized;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function run(command, values, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, values, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} 执行失败（${code}）：${stderr.trim() || stdout.trim()}`)));
  });
}

async function retry(action, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(attempt); }
    catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  throw lastError;
}

function githubSource(rawUrl, options) {
  const url = new URL(String(rawUrl || ""));
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") throw new Error("目前只支持 HTTPS GitHub 仓库地址");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("GitHub 地址缺少 owner/repository");
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  let ref = String(options.ref || "main");
  let subdirectory = String(options.path || "");
  if (parts[2] === "tree" && parts[3]) {
    ref = String(options.ref || parts[3]);
    subdirectory = String(options.path || parts.slice(4).join("/"));
  }
  return { cloneUrl: `https://github.com/${owner}/${repository}.git`, ref, subdirectory };
}

async function skillRoots(root, depth = 0) {
  if (depth > 6) return [];
  if (fs.existsSync(path.join(root, "SKILL.md"))) return [root];
  const found = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
    found.push(...await skillRoots(path.join(root, entry.name), depth + 1));
  }
  return found;
}

async function validateAndCopy(source, temporary) {
  let files = 0;
  let totalBytes = 0;
  async function copy(current, destination) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const from = path.join(current, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await fsp.mkdir(to, { recursive: true }); await copy(from, to); }
      else if (entry.isFile()) {
        const stat = await fsp.stat(from);
        files += 1;
        totalBytes += stat.size;
        if (files > maxFiles || totalBytes > maxTotalBytes) throw new Error("Skill 超过工作台允许的文件数量或总体积");
        await fsp.copyFile(from, to);
      }
    }
  }
  if (!fs.existsSync(path.join(source, "SKILL.md"))) throw new Error("Skill 根目录缺少 SKILL.md");
  await fsp.mkdir(temporary, { recursive: true });
  await copy(source, temporary);
}

async function commit(name, prepare) {
  await fsp.mkdir(managedRoot, { recursive: true });
  const target = path.join(managedRoot, name);
  if (fs.existsSync(target)) throw new Error(`同名 Skill 已存在：${name}`);
  const temporary = path.join(managedRoot, `.skill-${crypto.randomUUID()}`);
  try {
    await prepare(temporary);
    await fsp.rename(temporary, target);
    await fsp.writeFile(path.join(managedRoot, ".revision"), new Date().toISOString(), "utf8");
    return target;
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function install(options) {
  const source = githubSource(options.url, options);
  const checkout = path.join(managedRoot, `.git-${crypto.randomUUID()}`);
  try {
    await retry(async () => {
      await fsp.rm(checkout, { recursive: true, force: true });
      return run("git", ["clone", "--depth", "1", "--filter=blob:none", "--branch", source.ref, "--", source.cloneUrl, checkout], managedRoot);
    });
    let selected;
    if (source.subdirectory) {
      selected = path.resolve(checkout, safeRelative(source.subdirectory));
      if (!inside(checkout, selected)) throw new Error("GitHub Skill 子目录越界");
    } else {
      const candidates = await skillRoots(checkout);
      if (!candidates.length) throw new Error("仓库中没有找到 SKILL.md");
      if (candidates.length > 1) throw new Error(`仓库包含多个 Skill，请用 --path 指定：${candidates.map((item) => path.relative(checkout, item).replace(/\\/g, "/") || ".").join(", ")}`);
      [selected] = candidates;
    }
    const name = skillName(options.name || path.basename(selected));
    const target = await commit(name, (temporary) => validateAndCopy(selected, temporary));
    return { ok: true, action: "installed", name, target, source: source.cloneUrl, ref: source.ref };
  } finally {
    await fsp.rm(checkout, { recursive: true, force: true });
  }
}

async function create(options) {
  const specPath = path.resolve(String(options.spec || ""));
  const spec = JSON.parse(await fsp.readFile(specPath, "utf8"));
  const name = skillName(spec.name);
  const description = String(spec.description || "").trim();
  const instructions = String(spec.instructions || "").trim();
  if (!description || !instructions) throw new Error("规格文件必须包含 description 和 instructions");
  const files = spec.files && typeof spec.files === "object" && !Array.isArray(spec.files) ? spec.files : {};
  const skillMd = `---\nname: ${name}\ndescription: ${JSON.stringify(description.replace(/\r?\n/g, " "))}\n---\n\n${instructions}\n`;
  const target = await commit(name, async (temporary) => {
    await fsp.mkdir(temporary, { recursive: true });
    await fsp.writeFile(path.join(temporary, "SKILL.md"), skillMd, "utf8");
    for (const [relative, content] of Object.entries(files)) {
      const destination = path.resolve(temporary, safeRelative(relative));
      if (!inside(temporary, destination) || path.basename(destination).toLowerCase() === "skill.md") throw new Error(`规格文件包含无效路径：${relative}`);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, String(content), "utf8");
    }
  });
  return { ok: true, action: "created", name, target };
}

async function list() {
  await fsp.mkdir(managedRoot, { recursive: true });
  const skills = [];
  for (const entry of await fsp.readdir(managedRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && fs.existsSync(path.join(managedRoot, entry.name, "SKILL.md"))) skills.push(entry.name);
  }
  return { ok: true, action: "listed", skills: skills.sort() };
}

const options = argsOf(process.argv.slice(2));
const command = options._[0];
try {
  const result = command === "install" ? await install(options) : command === "create" ? await create(options) : command === "list" ? await list() : null;
  if (!result) throw new Error("用法：manage-skill.mjs <install|create|list> [options]");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
