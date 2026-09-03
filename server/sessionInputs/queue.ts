import {
  PendingInputActionError,
  type PendingInput,
  type PendingInputPatch
} from "./types.js";

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizedNames(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : undefined;
}

export function normalizePendingInput<TAttachment = unknown, TSkillPolicies = Record<string, unknown>>(
  value: unknown,
  fallbackNow = new Date().toISOString()
): PendingInput<TAttachment, TSkillPolicies> | null {
  const source = recordOf(value);
  const id = String(source.id || "").trim();
  const text = String(source.text || "").trim();
  if (!id || !text) return null;
  const createdAt = typeof source.createdAt === "string" && Number.isFinite(Date.parse(source.createdAt))
    ? source.createdAt
    : fallbackNow;
  const updatedAt = typeof source.updatedAt === "string" && Number.isFinite(Date.parse(source.updatedAt))
    ? source.updatedAt
    : createdAt;
  const status = source.status === "steering" || source.mode === "steer" ? "steering" : "queued";
  const agentMode = source.agentMode === "auto" || source.agentMode === "all" || source.agentMode === "off"
    ? source.agentMode
    : undefined;
  return {
    schemaVersion: 1,
    id,
    text,
    mode: status === "steering" ? "steer" : "queue",
    status,
    createdAt,
    updatedAt,
    revision: Number.isInteger(source.revision) && Number(source.revision) >= 0 ? Number(source.revision) : 0,
    ...(typeof source.clientMutationId === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(source.clientMutationId)
      ? { clientMutationId: source.clientMutationId }
      : {}),
    ...(typeof source.skillName === "string" && source.skillName.trim() ? { skillName: source.skillName.trim() } : {}),
    ...(normalizedNames(source.skillNames)?.length ? { skillNames: normalizedNames(source.skillNames) } : {}),
    ...(agentMode ? { agentMode } : {}),
    ...(source.skillPolicies && typeof source.skillPolicies === "object" && !Array.isArray(source.skillPolicies)
      ? { skillPolicies: source.skillPolicies as TSkillPolicies }
      : {}),
    ...(Array.isArray(source.attachments) ? { attachments: source.attachments as TAttachment[] } : {})
  };
}

export function normalizePendingInputs<TAttachment = unknown, TSkillPolicies = Record<string, unknown>>(
  value: unknown,
  fallbackNow = new Date().toISOString()
) {
  if (!Array.isArray(value)) return [] as PendingInput<TAttachment, TSkillPolicies>[];
  return value
    .map((item) => normalizePendingInput<TAttachment, TSkillPolicies>(item, fallbackNow))
    .filter((item): item is PendingInput<TAttachment, TSkillPolicies> => Boolean(item));
}

export function updatePendingInput<TAttachment, TSkillPolicies>(
  queue: PendingInput<TAttachment, TSkillPolicies>[],
  inputId: string,
  patch: PendingInputPatch<TAttachment>,
  now = new Date().toISOString()
) {
  const index = queue.findIndex((item) => item.id === inputId);
  if (index < 0) throw new PendingInputActionError("not_found", "排队消息不存在");
  const current = queue[index];
  if (current.status !== "queued") throw new PendingInputActionError("locked", "该消息已经开始应用，无法编辑");
  const text = patch.text === undefined ? current.text : patch.text.trim();
  const attachments = patch.attachments === undefined ? current.attachments : patch.attachments;
  if (!text && !attachments?.length) throw new PendingInputActionError("invalid", "请输入消息或添加附件");
  const next: PendingInput<TAttachment, TSkillPolicies> = {
    ...current,
    text: text || "请处理以下附件。",
    updatedAt: now,
    revision: current.revision + 1,
    ...(patch.attachments === undefined ? {} : { attachments }),
    ...(patch.skillNames === undefined ? {} : { skillNames: normalizedNames(patch.skillNames) || [] })
  };
  return { queue: queue.map((item, itemIndex) => itemIndex === index ? next : item), input: next };
}

export function removePendingInput<TAttachment, TSkillPolicies>(
  queue: PendingInput<TAttachment, TSkillPolicies>[],
  inputId: string
) {
  const current = queue.find((item) => item.id === inputId);
  if (!current) throw new PendingInputActionError("not_found", "排队消息不存在");
  if (current.status !== "queued") throw new PendingInputActionError("locked", "该消息已经开始应用，无法删除");
  return { queue: queue.filter((item) => item.id !== inputId), input: current };
}

export function promotePendingInput<TAttachment, TSkillPolicies>(
  queue: PendingInput<TAttachment, TSkillPolicies>[],
  inputId: string,
  now = new Date().toISOString()
) {
  const current = queue.find((item) => item.id === inputId);
  if (!current) throw new PendingInputActionError("not_found", "排队消息不存在");
  if (current.status !== "queued") throw new PendingInputActionError("locked", "该消息已经开始应用");
  const demoted = queue
    .filter((item) => item.id !== inputId)
    .map((item) => item.status === "steering"
      ? { ...item, mode: "queue" as const, status: "queued" as const, updatedAt: now, revision: item.revision + 1 }
      : item);
  const promoted: PendingInput<TAttachment, TSkillPolicies> = {
    ...current,
    mode: "steer",
    status: "steering",
    updatedAt: now,
    revision: current.revision + 1
  };
  return { queue: [promoted, ...demoted], input: promoted };
}

export function claimPendingInput<TAttachment, TSkillPolicies>(
  queue: PendingInput<TAttachment, TSkillPolicies>[],
  requestedId?: string
) {
  const index = requestedId ? queue.findIndex((item) => item.id === requestedId) : queue.length ? 0 : -1;
  if (index < 0) return { queue, input: null };
  return { queue: queue.filter((_, itemIndex) => itemIndex !== index), input: queue[index] };
}
