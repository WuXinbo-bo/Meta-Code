import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

export type CustomAgentProvider = "claude" | "codex";
export type CustomAgentScope = "user" | "project";
export type CustomAgentSourceFormat = "markdown" | "toml";

export type CustomAgentDefinition = {
  id: string;
  name: string;
  displayName: string;
  provider: CustomAgentProvider;
  scope: CustomAgentScope;
  description?: string;
  instructions: string;
  model?: string;
  tools: string[];
  sourcePath: string;
  sourceFormat: CustomAgentSourceFormat;
  metadata: Readonly<Record<string, unknown>>;
};

export type CustomAgentDiagnostic = {
  sourcePath: string;
  code: "read-failed" | "parse-failed" | "invalid-agent" | "too-large" | "unsafe-path";
  message: string;
  scope: CustomAgentScope;
  provider: CustomAgentProvider;
};

export type CustomAgentLoadOptions = {
  projectRoot: string;
  userHome?: string;
  maxFileBytes?: number;
  maxAgents?: number;
  providerHomes?: Partial<Record<CustomAgentProvider, string>>;
};

export type CustomAgentLoadResult = {
  agents: CustomAgentDefinition[];
  diagnostics: CustomAgentDiagnostic[];
};

type ParsedRecord = Record<string, unknown>;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_AGENTS = 256;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedId(value: unknown, fallback: string) {
  const candidate = cleanText(value).toLowerCase().replace(/\s+/g, "-");
  const id = (candidate || fallback).replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  if (!ID_PATTERN.test(id)) throw new Error("Agent name 必须是 1-64 个字母、数字、点、下划线或短横线");
  return id;
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  if (typeof value === "string") return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const quote = trimmed[0];
    const body = trimmed.slice(1, -1);
    return quote === '"' ? body.replace(/\\([\\"nrt])/g, (_match, code: string) => ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" }[code] || code)) : body.replace(/''/g, "'");
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitTopLevel(trimmed.slice(1, -1), ",").map(parseScalar);
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const object: ParsedRecord = Object.create(null);
    for (const entry of splitTopLevel(trimmed.slice(1, -1), ",")) {
      const separator = findUnquoted(entry, "=");
      if (separator <= 0) continue;
      const key = entry.slice(0, separator).trim().replace(/^['"]|['"]$/g, "");
      if (/^[A-Za-z0-9_.-]+$/.test(key)) object[key] = parseScalar(entry.slice(separator + 1));
    }
    return object;
  }
  return trimmed;
}

function findUnquoted(value: string, token: string) {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (depth === 0 && value.startsWith(token, index)) return index;
  }
  return -1;
}

function splitTopLevel(value: string, separator: string) {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (depth === 0 && value.startsWith(separator, index)) { parts.push(value.slice(start, index).trim()); start = index + separator.length; index += separator.length - 1; }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function stripTomlComment(line: string) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) { if (char === quote && line[index - 1] !== "\\") quote = ""; continue; }
    if (char === "'" || char === '"') quote = char;
    else if (char === "#") return line.slice(0, index).trim();
  }
  return line.trim();
}

/** Parse the small, intentionally safe TOML subset used by Codex agent files. */
export function parseCodexAgentToml(source: string): ParsedRecord {
  const result: ParsedRecord = Object.create(null);
  let section = "";
  let multilineKey = "";
  let multilineValue = "";
  for (const rawLine of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (multilineKey) {
      const end = rawLine.indexOf("\"\"\"");
      if (end >= 0) {
        multilineValue += `${rawLine.slice(0, end)}\n`;
        result[multilineKey] = multilineValue.replace(/\n$/, "");
        multilineKey = "";
        multilineValue = "";
      } else multilineValue += `${rawLine}\n`;
      continue;
    }
    const line = stripTomlComment(rawLine);
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) { section = sectionMatch[1].trim(); continue; }
    const separator = findUnquoted(line, "=");
    if (separator <= 0) throw new Error(`TOML 行缺少等号：${rawLine}`);
    const key = line.slice(0, separator).trim().replace(/^['"]|['"]$/g, "");
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`TOML 键无效：${key}`);
    const fullKey = section ? `${section}.${key}` : key;
    const rawValue = line.slice(separator + 1).trim();
    if (!rawValue) throw new Error(`TOML 值为空：${key}`);
    if (rawValue.startsWith("\"\"\"")) {
      const end = rawValue.indexOf("\"\"\"", 3);
      if (end >= 0) result[fullKey] = rawValue.slice(3, end);
      else { multilineKey = fullKey; multilineValue = `${rawValue.slice(3)}\n`; }
    } else result[fullKey] = parseScalar(rawValue);
  }
  if (multilineKey) throw new Error(`TOML 多行字符串未闭合：${multilineKey}`);
  return result;
}

/** Parse Claude's markdown front matter without evaluating YAML or code. */
export function parseClaudeAgentMarkdown(source: string): { metadata: ParsedRecord; instructions: string } {
  const normalized = source.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return { metadata: Object.create(null), instructions: normalized.trim() };
  const metadata: ParsedRecord = Object.create(null);
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = findUnquoted(line, ":");
    if (separator <= 0) throw new Error(`Markdown front matter 键无效：${rawLine}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`Markdown front matter 键无效：${key}`);
    metadata[key] = parseScalar(line.slice(separator + 1));
  }
  return { metadata, instructions: normalized.slice(match[0].length).trim() };
}

function get(record: ParsedRecord, ...keys: string[]) {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function definitionFrom(provider: CustomAgentProvider, scope: CustomAgentScope, sourcePath: string, format: CustomAgentSourceFormat, record: ParsedRecord, instructions: string, fallbackName: string): CustomAgentDefinition {
  const id = normalizedId(get(record, "name", "id", "agent.name", "agent.id"), fallbackName);
  const description = cleanText(get(record, "description", "agent.description")) || undefined;
  const model = cleanText(get(record, "model", "agent.model")) || undefined;
  const tools = stringArray(get(record, "tools", "allowed_tools", "agent.tools"));
  const known = new Set(["name", "id", "description", "model", "tools", "allowed_tools", "agent.name", "agent.id", "agent.description", "agent.model", "agent.tools"]);
  const metadata: ParsedRecord = Object.create(null);
  for (const [key, value] of Object.entries(record)) if (!known.has(key)) metadata[key] = value;
  return { id, name: id, displayName: cleanText(get(record, "displayName", "display_name", "agent.displayName")) || id, provider, scope, description, instructions: instructions.trim(), model, tools, sourcePath, sourceFormat: format, metadata };
}

function contained(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readScope(options: { root: string; directory?: string; scope: CustomAgentScope; provider: CustomAgentProvider; format: CustomAgentSourceFormat; maxFileBytes: number; maxAgents: number }, diagnostics: CustomAgentDiagnostic[]) {
  const directory = options.directory || path.resolve(options.root, `.${options.provider}`, "agents");
  const result: CustomAgentDefinition[] = [];
  let entries;
  try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ sourcePath: directory, code: "read-failed", message: error instanceof Error ? error.message : String(error), scope: options.scope, provider: options.provider });
    return result;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      diagnostics.push({ sourcePath: path.resolve(directory, entry.name), code: "unsafe-path", message: "不读取符号链接 Agent 文件", scope: options.scope, provider: options.provider });
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if ((options.format === "markdown" && ![".md", ".markdown"].includes(extension)) || (options.format === "toml" && extension !== ".toml")) continue;
    const sourcePath = path.resolve(directory, entry.name);
    if (!contained(directory, sourcePath)) { diagnostics.push({ sourcePath, code: "unsafe-path", message: "Agent 文件路径越界", scope: options.scope, provider: options.provider }); continue; }
    let stat;
    try { stat = await fsp.stat(sourcePath); } catch { continue; }
    if (stat.size > options.maxFileBytes) { diagnostics.push({ sourcePath, code: "too-large", message: `文件超过 ${options.maxFileBytes} 字节限制`, scope: options.scope, provider: options.provider }); continue; }
    let source;
    try { source = await fsp.readFile(sourcePath, "utf8"); } catch (error) { diagnostics.push({ sourcePath, code: "read-failed", message: error instanceof Error ? error.message : String(error), scope: options.scope, provider: options.provider }); continue; }
    try {
      const fallback = path.basename(entry.name, extension);
      const parsed = options.format === "markdown"
        ? parseClaudeAgentMarkdown(source)
        : (() => {
          const metadata = parseCodexAgentToml(source);
          return { metadata, instructions: cleanText(metadata.developer_instructions || metadata.instructions || metadata.prompt || metadata["agent.instructions"] || metadata["agent.prompt"]) };
        })();
      result.push(definitionFrom(options.provider, options.scope, sourcePath, options.format, parsed.metadata, parsed.instructions, fallback));
      if (result.length >= options.maxAgents) break;
    } catch (error) { diagnostics.push({ sourcePath, code: "parse-failed", message: error instanceof Error ? error.message : String(error), scope: options.scope, provider: options.provider }); }
  }
  return result;
}

/** Project definitions override user definitions with the same provider/id. */
export function mergeCustomAgents(agents: readonly CustomAgentDefinition[]) {
  const merged = new Map<string, CustomAgentDefinition>();
  for (const agent of [...agents].sort((a, b) => (a.scope === b.scope ? a.sourcePath.localeCompare(b.sourcePath) : a.scope === "user" ? -1 : 1))) merged.set(`${agent.provider}:${agent.id}`, agent);
  return [...merged.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

export async function loadCustomAgents(options: CustomAgentLoadOptions): Promise<CustomAgentLoadResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const userHome = path.resolve(options.userHome || os.homedir());
  const maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes ?? MAX_FILE_BYTES));
  const maxAgents = Math.max(1, Math.floor(options.maxAgents ?? MAX_AGENTS));
  const diagnostics: CustomAgentDiagnostic[] = [];
  const all: CustomAgentDefinition[] = [];
  for (const scope of ["user", "project"] as const) for (const provider of ["claude", "codex"] as const) {
    const root = scope === "user" ? userHome : projectRoot;
    all.push(...await readScope({ root, ...(scope === "user" && options.providerHomes?.[provider] ? { directory: path.join(options.providerHomes[provider]!, "agents") } : {}), scope, provider, format: provider === "claude" ? "markdown" : "toml", maxFileBytes, maxAgents }, diagnostics));
  }
  return { agents: mergeCustomAgents(all).slice(0, maxAgents), diagnostics };
}

export const readCustomAgents = loadCustomAgents;
