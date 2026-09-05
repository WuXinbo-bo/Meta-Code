import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AcpRegistryClient, parseAcpRegistry, type AcpRegistryAgent, type AcpRegistryDocument } from "./acp/registry.js";
import { acpRegistryPlatform } from "./acp/registry.js";
import { createAcpRuntimeDefinition } from "./acp/runtime.js";
import { providerBrandAccent } from "./branding.js";

export type InstalledAcpProvider = {
  agent: AcpRegistryAgent;
  installedAt: string;
  updatedAt: string;
};

type InstalledDocument = { schemaVersion: 1; items: InstalledAcpProvider[] };

export type AgentMarketCatalogItem = {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors: string[];
  license: string;
  icon?: string;
  accent: string;
  transport: "native" | "acp";
  native: boolean;
  installed: boolean;
  installable: boolean;
  installReason: string;
  distributionTypes: string[];
  rank: number;
  tier: "featured" | "recommended" | "ecosystem" | "experimental";
  region: "global" | "china";
  verified: boolean;
  maturity: "stable" | "preview" | "community";
  hiddenByDefault: boolean;
};

const NATIVE_IDS = new Set(["codex", "claude"]);
const NATIVE_WRAPPER_IDS = new Set(["codex-acp", "claude-acp"]);

const DEEPSEEK_HARNESS: AcpRegistryAgent = {
  id: "deepseek-harness",
  name: "DeepSeek Harness",
  version: "0.1.1-rc.2",
  description: "DeepSeek 官方开源 Agent Harness，使用 ACP 标准接入（开发者预览版）",
  repository: "https://github.com/deepseek-ai/deepseek-harness",
  website: "https://deepseek-harness.github.io/deepseek-harness/",
  authors: ["DeepSeek AI"],
  license: "MIT",
  icon: "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/apps/web/public/favicon.svg",
  distribution: { npx: { package: "@deepseek-ai/dsh@0.1.1-rc.2", args: ["--profile", "acp"] } }
};

const CURATION: Record<string, Partial<Pick<AgentMarketCatalogItem, "rank" | "tier" | "region" | "verified" | "maturity" | "hiddenByDefault">>> = {
  codex: { rank: 10, tier: "featured", verified: true, maturity: "stable" },
  claude: { rank: 20, tier: "featured", verified: true, maturity: "stable" },
  gemini: { rank: 30, tier: "featured", verified: true, maturity: "stable" },
  "codebuddy-code": { rank: 40, tier: "featured", region: "china", verified: true, maturity: "stable" },
  "deepseek-harness": { rank: 50, tier: "featured", region: "china", verified: true, maturity: "preview" },
  "github-copilot-cli": { rank: 60, tier: "recommended", verified: true, maturity: "stable" },
  opencode: { rank: 70, tier: "recommended", verified: true, maturity: "stable" },
  cline: { rank: 80, tier: "recommended", verified: true, maturity: "stable" },
  "grok-build": { rank: 90, tier: "recommended", verified: true, maturity: "stable" },
  goose: { rank: 100, tier: "recommended", verified: true, maturity: "stable" },
  kimi: { rank: 110, tier: "recommended", region: "china", verified: true, maturity: "stable" },
  "qwen-code": { rank: 120, tier: "recommended", region: "china", verified: true, maturity: "stable" },
  "glm-acp-agent": { rank: 130, tier: "recommended", region: "china", verified: false, maturity: "community" },
  qoder: { rank: 140, tier: "recommended", region: "china", verified: true, maturity: "stable" },
  kilo: { rank: 150, tier: "recommended", verified: true, maturity: "stable" }
};

function withWorkbenchAgents(document: AcpRegistryDocument): AcpRegistryDocument {
  if (document.agents.some((agent) => agent.id === DEEPSEEK_HARNESS.id)) return document;
  return { ...document, agents: [...document.agents, DEEPSEEK_HARNESS] };
}

function curation(id: string) {
  const configured = CURATION[id] || {};
  return {
    rank: configured.rank ?? 1_000,
    tier: configured.tier ?? "ecosystem" as AgentMarketCatalogItem["tier"],
    region: configured.region ?? "global" as AgentMarketCatalogItem["region"],
    verified: configured.verified ?? false,
    maturity: configured.maturity ?? "community" as AgentMarketCatalogItem["maturity"],
    hiddenByDefault: configured.hiddenByDefault ?? !CURATION[id]
  };
}

function writeJsonAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function installability(agent: AcpRegistryAgent) {
  if (NATIVE_WRAPPER_IDS.has(agent.id)) return { installable: false, reason: "工作台保留 Codex/Claude 原生增强传输" };
  if (createAcpRuntimeDefinition(agent)) return { installable: true, reason: "可安装到工作台托管目录" };
  if (agent.distribution.uvx) return { installable: false, reason: "当前条目需要 uvx，工作台尚未提供托管安装" };
  if (agent.distribution.binary && !agent.distribution.binary[acpRegistryPlatform()]) return { installable: false, reason: "当前系统或架构没有可用安装包" };
  return { installable: false, reason: "Registry 未提供可验证的安装包" };
}

export class AgentMarketStore {
  private installedCache: InstalledAcpProvider[] | null = null;

  constructor(
    private readonly root: string,
    private readonly registryClient = new AcpRegistryClient()
  ) {}

  private registryFile() { return path.join(this.root, "registry.json"); }
  private installedFile() { return path.join(this.root, "installed.json"); }

  async registry(force = false): Promise<{ document: AcpRegistryDocument; source: "network" | "cache" }> {
    try {
      const document = withWorkbenchAgents(await this.registryClient.list(force));
      writeJsonAtomic(this.registryFile(), document);
      return { document, source: "network" };
    } catch (error) {
      try {
        const document = withWorkbenchAgents(parseAcpRegistry(JSON.parse(await fsp.readFile(this.registryFile(), "utf8"))));
        return { document, source: "cache" };
      } catch {
        throw error;
      }
    }
  }

  installed() {
    if (this.installedCache) return structuredClone(this.installedCache);
    try {
      const raw = JSON.parse(fs.readFileSync(this.installedFile(), "utf8")) as Partial<InstalledDocument>;
      const items = Array.isArray(raw.items) ? raw.items : [];
      this.installedCache = items.flatMap((item) => {
        try {
          const agent = parseAcpRegistry({ version: "1.0.0", agents: [item.agent] }).agents[0];
          if (NATIVE_IDS.has(agent.id) || NATIVE_WRAPPER_IDS.has(agent.id) || !createAcpRuntimeDefinition(agent)) return [];
          return [{ agent, installedAt: String(item.installedAt || new Date().toISOString()), updatedAt: String(item.updatedAt || item.installedAt || new Date().toISOString()) }];
        } catch { return []; }
      });
    } catch { this.installedCache = []; }
    return structuredClone(this.installedCache);
  }

  rememberInstalled(agent: AcpRegistryAgent) {
    if (NATIVE_IDS.has(agent.id) || NATIVE_WRAPPER_IDS.has(agent.id)) throw new Error("Codex 和 Claude 使用工作台原生传输，不安装 ACP Wrapper");
    if (!createAcpRuntimeDefinition(agent)) throw new Error(`${agent.name} 当前不可由工作台托管安装`);
    const now = new Date().toISOString();
    const current = this.installed();
    const existing = current.find((item) => item.agent.id === agent.id);
    const next = current.filter((item) => item.agent.id !== agent.id);
    next.push({ agent: structuredClone(agent), installedAt: existing?.installedAt || now, updatedAt: now });
    next.sort((left, right) => left.agent.name.localeCompare(right.agent.name));
    this.installedCache = next;
    writeJsonAtomic(this.installedFile(), { schemaVersion: 1, items: next } satisfies InstalledDocument);
    return structuredClone(next.find((item) => item.agent.id === agent.id)!);
  }

  async agent(id: string, force = false) {
    const normalized = String(id || "").trim().toLowerCase();
    const { document } = await this.registry(force);
    const agent = document.agents.find((item) => item.id === normalized);
    if (!agent) throw new Error(`Agent 市场不存在：${normalized}`);
    return agent;
  }

  async catalog(native: Array<{ id: "codex" | "claude"; name: string; version: string; description: string; icon?: string; installed?: boolean }>, force = false) {
    let registryWarning = "";
    const { document, source } = await this.registry(force).catch(() => {
      registryWarning = "暂时无法连接市场，仍可安装内置 Agent；请稍后刷新其他条目";
      return { document: { version: "local", agents: this.installed().map((item) => item.agent) }, source: "cache" as const };
    });
    const installedIds = new Set(this.installed().map((item) => item.agent.id));
    const nativeItems: AgentMarketCatalogItem[] = native.map((item) => ({
      ...item, authors: [], license: "native", transport: "native", native: true, installed: Boolean(item.installed),
      accent: item.id === "claude" ? "#d97757" : "#111111",
      installable: true, installReason: "安装官方 CLI，保留原生增强能力", distributionTypes: ["npm"], ...curation(item.id)
    }));
    const registryItems = document.agents.filter((agent) => !NATIVE_WRAPPER_IDS.has(agent.id) && !NATIVE_IDS.has(agent.id)).map((agent): AgentMarketCatalogItem => {
      const availability = installability(agent);
      return {
        id: agent.id, name: agent.name, version: agent.version, description: agent.description,
        repository: agent.repository, website: agent.website, authors: agent.authors, license: agent.license,
        icon: agent.icon, accent: providerBrandAccent(agent.id), transport: "acp", native: false, installed: installedIds.has(agent.id),
        installable: availability.installable, installReason: availability.reason,
        distributionTypes: Object.keys(agent.distribution), ...curation(agent.id)
      };
    });
    const items = [...nativeItems, ...registryItems].sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));
    return { schemaVersion: 2 as const, registryVersion: document.version, registrySource: source, registryWarning, items };
  }
}
