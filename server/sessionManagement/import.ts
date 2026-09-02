import { normalizeProviderId } from "../agents/types.js";

type JsonRecord = Record<string, unknown>;

export type PortableSessionImport = {
  title: string;
  engine: string;
  workspaceId: string;
  messages: JsonRecord[];
  createdAt: string | null;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export function parsePortableSessionImport(value: unknown): PortableSessionImport {
  const envelope = record(value);
  if (envelope.schemaVersion !== 1 || envelope.kind !== "metacode-session") {
    throw new Error("只支持 Meta Code schemaVersion 1 会话包");
  }
  const session = record(envelope.session);
  let engine: string;
  try { engine = normalizeProviderId(session.engine); }
  catch { throw new Error("会话包主脑类型无效"); }
  const messages = Array.isArray(session.messages) ? session.messages.map(record) : [];
  if (messages.length > 10_000) throw new Error("会话包消息数量超过 10000 条安全上限");
  const title = String(session.title || "导入会话").trim().slice(0, 160) || "导入会话";
  const createdAt = typeof session.createdAt === "string" && Number.isFinite(Date.parse(session.createdAt)) ? session.createdAt : null;
  return {
    title,
    engine,
    workspaceId: typeof session.workspaceId === "string" ? session.workspaceId : "",
    messages,
    createdAt
  };
}
