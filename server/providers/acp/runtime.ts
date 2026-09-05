import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliDefinition } from "../../runtime/types.js";
import { runtimePlatform } from "../../runtime/registry.js";
import { AGENT_ADAPTER_SDK_VERSION, type AgentProviderManifestV1 } from "../../agents/types.js";
import { acpRegistryPlatform, type AcpRegistryAgent } from "./registry.js";
import type { AcpLaunchSpec } from "../types.js";
import { providerBrandAccent } from "../branding.js";
import { agentNodeExecutable } from "../../runtime/nodeEnvironment.js";

const execFileAsync = promisify(execFile);
const COMMAND_NAMES: Record<string, string> = {
  gemini: "gemini", "github-copilot-cli": "copilot", "grok-build": "grok", "qwen-code": "qwen",
  kimi: "kimi", opencode: "opencode", "mistral-vibe": "vibe-acp", goose: "goose", cline: "cline", kilo: "kilo"
  , "deepseek-harness": "dsh"
};
const BLOCKED_ENV = new Set(["PATH", "PATHEXT", "COMSPEC", "HOME", "USERPROFILE", "NODE_OPTIONS", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]);

export function acpDelegationEnvironment(input: { enabled: boolean; bridgeUrl?: string; bridgeToken?: string; parentTaskId?: string }): Record<string, string> {
  if (!input.enabled) return { WORKBENCH_AGENT_DEPTH: "1" };
  if (!input.bridgeUrl || !input.bridgeToken || !input.parentTaskId) throw new Error("ACP 协作会话缺少工作台委派桥接配置");
  return {
    WORKBENCH_AGENT_BRIDGE_URL: input.bridgeUrl,
    WORKBENCH_AGENT_BRIDGE_TOKEN: input.bridgeToken,
    WORKBENCH_PARENT_TASK_ID: input.parentTaskId,
    WORKBENCH_AGENT_DEPTH: "0"
  };
}

function packageSpec(value: string) {
  const splitAt = value.lastIndexOf("@");
  if (splitAt <= 0) throw new Error(`ACP npm 包未锁定版本：${value}`);
  return { packageName: value.slice(0, splitAt), version: value.slice(splitAt + 1) };
}

function packageRoot(root: string, packageName: string) {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

function npmBinCandidates(root: string, packageName: string) {
  const base = packageRoot(root, packageName);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const values = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin || {});
    return values.map((value) => path.resolve(base, value));
  } catch { return []; }
}

async function systemCandidates(command: string) {
  try {
    const resolver = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(resolver, [command], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    return stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  } catch { return []; }
}

export function safeAcpRegistryEnv(input: Record<string, string> | undefined) {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/i.test(key) || BLOCKED_ENV.has(key.toUpperCase()) || key.toUpperCase().startsWith("WORKBENCH_")) continue;
    if (typeof value === "string" && value.length <= 2_048 && !value.includes("\0")) output[key] = value;
  }
  return output;
}

export function createAcpRuntimeDefinition(agent: AcpRegistryAgent): CliDefinition | null {
  const npx = agent.distribution.npx;
  if (npx) {
    const spec = packageSpec(npx.package);
    const command = COMMAND_NAMES[agent.id] || agent.id;
    return {
      id: agent.id,
      providerId: agent.id,
      adapterId: `acp-v1:${agent.id}`,
      label: agent.name,
      command,
      distribution: { kind: "npm", packageName: spec.packageName, defaultVersion: spec.version },
      executableCandidates: (root) => npmBinCandidates(root, spec.packageName),
      bundledRoots: () => [],
      systemCandidates: () => systemCandidates(command),
      probe: async (candidate) => fs.existsSync(candidate) ? agent.version : ""
    };
  }
  const binary = agent.distribution.binary?.[acpRegistryPlatform()];
  if (!binary?.sha256) return null;
  const executable = binary.cmd.replace(/^\.\//, "").replace(/\\/g, "/");
  return {
    id: agent.id,
    providerId: agent.id,
    adapterId: `acp-v1:${agent.id}`,
    label: agent.name,
    command: COMMAND_NAMES[agent.id] || path.basename(executable, path.extname(executable)),
    distribution: {
      kind: "binary",
      version: agent.version,
      platforms: {
        [runtimePlatform()]: {
          url: binary.archive,
          sha256: binary.sha256,
          executable,
          args: binary.args,
          env: safeAcpRegistryEnv(binary.env)
        }
      }
    },
    executableCandidates: (root) => [path.resolve(root, executable)],
    bundledRoots: () => [],
    systemCandidates: () => systemCandidates(COMMAND_NAMES[agent.id] || path.basename(executable, path.extname(executable))),
    probe: async (candidate) => fs.existsSync(candidate) ? agent.version : ""
  };
}

export function acpLaunchSpecForRuntime(agent: AcpRegistryAgent, executable: string): AcpLaunchSpec {
  const distribution = agent.distribution.npx || agent.distribution.binary?.[acpRegistryPlatform()];
  if (!distribution) throw new Error(`${agent.name} 不支持当前平台`);
  const args = [...(distribution.args || [])];
  const env = safeAcpRegistryEnv(distribution.env);
  const isNodeScript = Boolean(agent.distribution.npx) && !/\.(?:exe|cmd|bat)$/i.test(executable);
  return {
    command: isNodeScript ? agentNodeExecutable() : executable,
    args: isNodeScript ? [executable, ...args] : args,
    ...(Object.keys(env).length ? { env } : {}),
    registryId: agent.id,
    package: agent.distribution.npx?.package,
    version: agent.version
  };
}

export function acpProviderManifest(agent: AcpRegistryAgent): AgentProviderManifestV1 {
  return {
    sdkVersion: AGENT_ADAPTER_SDK_VERSION,
    id: agent.id,
    adapterId: `acp-v1:${agent.id}`,
    runtimeId: agent.id,
    displayName: agent.name,
    shortName: agent.name,
    description: agent.description || `${agent.name} ACP Agent`,
    displayOrder: 100,
    branding: { icon: agent.icon || "agent", accent: providerBrandAccent(agent.id) },
    capabilities: {
      sessions: { create: true, resume: true, fork: false },
      execution: { stream: true, cancel: true, steer: false },
      workspace: { read: true, write: true },
      tools: { shell: true, web: false, mcp: true },
      delegation: { worker: true, nativeSubagents: false },
      workflow: { planner: false, worker: false },
      configuration: { models: false, reasoningEffort: false, reasoningEffortValues: [], permissionProfile: true }
    },
    configurationSchema: { modelSource: "none", reasoning: { type: "none" } },
    skillProjection: { strategy: "prompt", invocationPrefix: "$" }
  };
}
