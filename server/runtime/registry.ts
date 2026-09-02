import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveClaudeCommand } from "../engines/claude/runtime.js";
import type { CliDefinition } from "./types.js";

const execFileAsync = promisify(execFile);

function globalCommandCandidates(command: string) {
  const prefixes = [
    process.env.npm_config_prefix || "",
    process.env.NPM_CONFIG_PREFIX || "",
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".npm-global", "bin") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".local", "bin") : "",
    process.platform === "win32" ? path.dirname(process.execPath) : ""
  ].filter(Boolean);
  return prefixes.flatMap((prefix) => process.platform === "win32"
    ? [path.join(prefix, `${command}.exe`), path.join(prefix, `${command}.cmd`)]
    : [path.join(prefix, command)]);
}

async function commandOnPath(command: string) {
  const candidates = globalCommandCandidates(command);
  try {
    const resolver = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(resolver, [command], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    candidates.push(...stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
  } catch {
    // GUI-launched applications often have a smaller PATH; known user npm
    // locations above remain valid fallback candidates.
  }
  return [...new Set(candidates)];
}

function codexCandidates(root: string) {
  const base = path.join(root, "node_modules", "@openai");
  if (process.platform === "win32") return [
    path.join(base, "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
    path.join(base, "codex-win32-arm64", "vendor", "aarch64-pc-windows-msvc", "bin", "codex.exe"),
    path.join(root, "node_modules", ".bin", "codex.cmd")
  ];
  if (process.platform === "darwin") return [
    path.join(base, "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "codex", "codex"),
    path.join(base, "codex-darwin-x64", "vendor", "x86_64-apple-darwin", "codex", "codex")
  ];
  return [
    path.join(root, "node_modules", ".bin", "codex"),
    path.join(base, "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex"),
    path.join(base, "codex-linux-arm64", "vendor", "aarch64-unknown-linux-musl", "bin", "codex")
  ];
}

function claudeCandidates(root: string) {
  const packageRoot = path.join(root, "node_modules", "@anthropic-ai", "claude-code");
  return process.platform === "win32"
    ? [path.join(packageRoot, "bin", "claude.exe"), path.join(root, "node_modules", ".bin", "claude.exe"), path.join(root, "node_modules", ".bin", "claude.cmd"), path.join(packageRoot, "cli.js")]
    : [path.join(packageRoot, "bin", "claude"), path.join(root, "node_modules", ".bin", "claude"), path.join(packageRoot, "cli.js")];
}

async function finalizeClaudeInstallation(root: string) {
  const platformPackage = `claude-code-${runtimePlatform()}`;
  const source = path.join(root, "node_modules", "@anthropic-ai", platformPackage, process.platform === "win32" ? "claude.exe" : "claude");
  const target = path.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  if (!fs.existsSync(source)) throw new Error(`Claude 平台程序缺失：@anthropic-ai/${platformPackage}`);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(source, target);
  if (process.platform !== "win32") await fs.promises.chmod(target, 0o755);
}

async function probeExecutable(candidate: string, resolver?: (path: string) => { executable: string; args: string[] }) {
  if (!candidate || !fs.existsSync(candidate)) return "";
  try {
    const command = resolver ? resolver(candidate) : { executable: candidate, args: [] };
    const { stdout, stderr } = await execFileAsync(command.executable, [...command.args, "--version"], { encoding: "utf8", timeout: 8_000, windowsHide: true });
    return `${stdout || ""} ${stderr || ""}`.trim() || "可用";
  } catch {
    return "";
  }
}

export const CLI_REGISTRY: Record<string, CliDefinition> = {
  codex: {
    id: "codex",
    providerId: "codex",
    adapterId: "codex-app-server-sdk",
    label: "Codex CLI",
    displayOrder: 20,
    command: "codex",
    distribution: { kind: "npm", packageName: "@openai/codex", defaultVersion: "latest" },
    executableCandidates: codexCandidates,
    bundledRoots: (projectRoot) => [projectRoot],
    systemCandidates: () => commandOnPath("codex"),
    probe: (candidate) => probeExecutable(candidate)
  },
  claude: {
    id: "claude",
    providerId: "claude",
    adapterId: "claude-cli-stream-json",
    label: "Claude CLI",
    displayOrder: 10,
    command: "claude",
    distribution: { kind: "npm", packageName: "@anthropic-ai/claude-code", defaultVersion: "latest" },
    executableCandidates: claudeCandidates,
    bundledRoots: () => [],
    systemCandidates: () => commandOnPath("claude"),
    probe: (candidate) => probeExecutable(candidate, resolveClaudeCommand),
    finalizeInstallation: finalizeClaudeInstallation
  }
};

export function runtimePlatform() {
  return `${process.platform}-${process.arch}`;
}
