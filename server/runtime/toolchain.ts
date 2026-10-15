import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractTarSafely, extractZipSafely } from "./archive.js";
import { downloadArtifact, type ArtifactDownloadProgress } from "./downloader.js";
import type { RuntimeNetworkConfig } from "./config.js";
import { nodeToolchainEnvironment } from "./nodeEnvironment.js";

const exec = promisify(execFile);
// Official https://nodejs.org/dist/v24.13.0/SHASUMS256.txt; update together with package certification.
export const NODE_TOOLCHAIN_VERSION = "24.13.0";
export type NodeToolchainArtifact = {
  folder: string;
  archive: "zip" | "tar.gz";
  sha256: string;
};

const artifacts: Record<string, NodeToolchainArtifact> = {
  "win32-x64": { folder: `node-v${NODE_TOOLCHAIN_VERSION}-win-x64`, archive: "zip", sha256: "ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88" },
  "win32-arm64": { folder: `node-v${NODE_TOOLCHAIN_VERSION}-win-arm64`, archive: "zip", sha256: "92b9f9b0c0c123e11e4afc535f0ec19cd987465eea506427553a49971364158a" },
  "darwin-x64": { folder: `node-v${NODE_TOOLCHAIN_VERSION}-darwin-x64`, archive: "tar.gz", sha256: "6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3" },
  "darwin-arm64": { folder: `node-v${NODE_TOOLCHAIN_VERSION}-darwin-arm64`, archive: "tar.gz", sha256: "d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8" },
  "linux-x64": { folder: `node-v${NODE_TOOLCHAIN_VERSION}-linux-x64`, archive: "tar.gz", sha256: "6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8" },
  "linux-arm64": { folder: `node-v${NODE_TOOLCHAIN_VERSION}-linux-arm64`, archive: "tar.gz", sha256: "0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081" }
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

function addToolchainRoot(roots: Set<string>, candidate: string) {
  if (!candidate) return;
  const resolved = path.resolve(candidate);
  const basename = path.basename(resolved).toLowerCase();
  if (basename === "node" || basename === "node.exe") {
    roots.add(path.dirname(path.dirname(resolved)));
    return;
  }
  roots.add(resolved);
  if (path.basename(resolved) === "bin") roots.add(path.dirname(resolved));
}

function toolchainSearchRoots() {
  const roots = new Set<string>();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  addToolchainRoot(roots, path.dirname(process.execPath));
  addToolchainRoot(roots, process.env.npm_execpath || "");
  const pathEntry = Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  for (const entry of pathEntry.split(path.delimiter)) addToolchainRoot(roots, entry);
  if (process.env.ProgramFiles) addToolchainRoot(roots, path.join(process.env.ProgramFiles, "nodejs"));
  if (process.env.LOCALAPPDATA) addToolchainRoot(roots, path.join(process.env.LOCALAPPDATA, "Programs/nodejs"));
  if (home) {
    addToolchainRoot(roots, path.join(home, ".nvm", "current"));
    try {
      for (const entry of fs.readdirSync(path.join(home, ".nvm", "versions", "node"), { withFileTypes: true })) {
        if (entry.isDirectory()) addToolchainRoot(roots, path.join(home, ".nvm", "versions", "node", entry.name));
      }
    } catch { /* nvm is optional. */ }
    addToolchainRoot(roots, path.join(home, ".local", "share", "mise", "installs", "node"));
    addToolchainRoot(roots, path.join(home, ".asdf", "installs", "nodejs"));
  }
  if (process.platform === "darwin") {
    for (const prefix of ["/opt/homebrew/opt/node", "/usr/local/opt/node", "/opt/homebrew", "/usr/local"]) addToolchainRoot(roots, prefix);
  }
  return [...roots];
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
    for (const root of toolchainSearchRoots()) {
      const found = toolchainAt(root);
      if (found) return found;
    }
    return null;
  }

  canPrepare() { return Boolean(this.discover() || artifacts[`${process.platform}-${process.arch}`]); }

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
    const artifactDefinition = artifacts[`${process.platform}-${process.arch}`];
    if (!artifactDefinition) throw new Error("当前平台需要先安装 Node.js 24 或更高版本，再重试 CLI 安装");
    const artifact = { packageName: "node-toolchain", installName: "node", version: NODE_TOOLCHAIN_VERSION,
      url: `https://nodejs.org/dist/v${NODE_TOOLCHAIN_VERSION}/${artifactDefinition.folder}.${artifactDefinition.archive}`,
      integrity: `sha256-${Buffer.from(artifactDefinition.sha256, "hex").toString("base64")}` };
    const urls = network.registryMode === "auto"
      ? [`https://registry.npmmirror.com/-/binary/node/v${NODE_TOOLCHAIN_VERSION}/${artifactDefinition.folder}.${artifactDefinition.archive}`, artifact.url]
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
      if (artifactDefinition.archive === "zip") await extractZipSafely(archive, staging);
      else await extractTarSafely(archive, staging, { allowSafeSymlinks: true });
      const extracted = toolchainAt(path.join(staging, artifactDefinition.folder));
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
