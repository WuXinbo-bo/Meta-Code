import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractZipSafely } from "./archive.js";
import { downloadArtifact, type ArtifactDownloadProgress } from "./downloader.js";
import type { RuntimeNetworkConfig } from "./config.js";
import { nodeToolchainEnvironment } from "./nodeEnvironment.js";

const exec = promisify(execFile);
// Official https://nodejs.org/dist/v24.13.0/SHASUMS256.txt; update together with package certification.
export const NODE_TOOLCHAIN_VERSION = "24.13.0";
const checksums: Record<string, string> = {
  "win32-x64": "ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88",
  "win32-arm64": "92b9f9b0c0c123e11e4afc535f0ec19cd987465eea506427553a49971364158a"
};
export type NodeToolchain = { root: string; node: string; npm: string };

async function renameToolchain(source: string, target: string) {
  for (let attempt = 0; ; attempt += 1) {
    try { await fsp.rename(source, target); return; }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(String((error as NodeJS.ErrnoException).code)) || attempt >= 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200 * 2 ** attempt, 2000)));
    }
  }
}

export function toolchainAt(root: string): NodeToolchain | null {
  const node = path.join(root, process.platform === "win32" ? "node.exe" : "bin/node");
  const npm = path.join(root, process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js");
  return fs.existsSync(node) && fs.existsSync(npm) ? { root, node, npm } : null;
}

export async function verifyNodeToolchain(toolchain: NodeToolchain) {
  const env = nodeToolchainEnvironment(toolchain.node);
  delete env.NODE_OPTIONS;
  const { stdout } = await exec(toolchain.node, ["--version"], { env, timeout: 10_000, windowsHide: true });
  if (!/^v(?:2[4-9]|[3-9]\d)\./.test(stdout.trim())) throw new Error("CLI 安装环境需要 Node.js 24 或更高版本");
  const npm = await exec(toolchain.node, [toolchain.npm, "--version"], { env, timeout: 15_000, windowsHide: true });
  if (!/^\d+\./.test(npm.stdout.trim())) throw new Error("CLI 安装工具校验失败");
  return toolchain;
}

export class NodeToolchainManager {
  private pending: Promise<NodeToolchain> | null = null;
  constructor(private readonly bundledRoot: string, private readonly managedRoot: string) {}

  private target() { return path.join(this.managedRoot, `node-${NODE_TOOLCHAIN_VERSION}-${process.platform}-${process.arch}`); }
  discover(): NodeToolchain | null {
    for (const root of [this.target(), this.bundledRoot]) {
      const found = toolchainAt(root);
      if (found) return found;
    }
    // GUI processes do not inherit npm_execpath. Search actual Node installations as well.
    const pathEntry = Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
    const roots = [path.dirname(process.execPath), ...pathEntry.split(path.delimiter),
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : "",
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs/nodejs") : ""];
    for (const root of roots.filter(Boolean)) {
      const found = toolchainAt(root);
      if (found) return found;
    }
    return null;
  }

  canPrepare() { return Boolean(this.discover() || checksums[`${process.platform}-${process.arch}`]); }

  ensure(network: RuntimeNetworkConfig, progress: (value: ArtifactDownloadProgress) => void = () => {}) {
    if (this.pending) return this.pending;
    this.pending = this.prepare(network, progress).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async prepare(network: RuntimeNetworkConfig, progress: (value: ArtifactDownloadProgress) => void) {
    const candidates = [this.discover(), toolchainAt(this.bundledRoot), toolchainAt(this.target())];
    for (const found of candidates) {
      if (!found) continue;
      try { return await verifyNodeToolchain(found); } catch { /* Try another installed toolchain before downloading. */ }
    }
    const sha256 = checksums[`${process.platform}-${process.arch}`];
    if (!sha256) throw new Error("当前平台需要先安装 Node.js 24 或更高版本，再重试 CLI 安装");
    const folder = `node-v${NODE_TOOLCHAIN_VERSION}-win-${process.arch}`;
    const artifact = { packageName: "node-toolchain", installName: "node", version: NODE_TOOLCHAIN_VERSION,
      url: `https://nodejs.org/dist/v${NODE_TOOLCHAIN_VERSION}/${folder}.zip`,
      integrity: `sha256-${Buffer.from(sha256, "hex").toString("base64")}` };
    const urls = network.registryMode === "auto"
      ? [`https://registry.npmmirror.com/-/binary/node/v${NODE_TOOLCHAIN_VERSION}/${folder}.zip`, artifact.url]
      : [artifact.url];
    let archive = "";
    let failure: unknown;
    for (const url of urls) {
      try { archive = await downloadArtifact({ ...artifact, url }, path.join(this.managedRoot, "cache"), network, progress); break; }
      catch (error) { failure = error; }
    }
    if (!archive) throw failure;
    const staging = await fsp.mkdtemp(path.join(this.managedRoot, ".node-staging-"));
    try {
      await extractZipSafely(archive, staging);
      const extracted = toolchainAt(path.join(staging, folder));
      if (!extracted) throw new Error("下载的 CLI 安装环境不完整");
      await verifyNodeToolchain(extracted);
      const target = this.target();
      const displaced = `${target}.previous-${Date.now()}`;
      const hadTarget = fs.existsSync(target);
      if (hadTarget) await renameToolchain(target, displaced);
      try { await renameToolchain(extracted.root, target); }
      catch (error) { if (hadTarget) await renameToolchain(displaced, target); throw error; }
      if (hadTarget) await fsp.rm(displaced, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }).catch(() => undefined);
      return toolchainAt(target)!;
    } finally { await fsp.rm(staging, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }); }
  }
}
