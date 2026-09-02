import type { SessionConfigOption } from "@agentclientprotocol/sdk";

export const ACP_SESSION_MODEL_OPTION_ID = "workbench.acp.session-model";
export const ACP_SESSION_MODE_OPTION_ID = "workbench.acp.session-mode";

type RecordValue = Record<string, unknown>;

export type AcpExtendedSessionResponse = {
  sessionId?: string;
  configOptions?: SessionConfigOption[] | null;
  models?: unknown;
  modes?: unknown;
};

export function sessionControlOptions(response: AcpExtendedSessionResponse, previous: SessionConfigOption[] = []) {
  const rawOptions = Array.isArray(response.configOptions)
    ? response.configOptions
    : previous.filter((option) => !isSyntheticSessionOption(option.id));
  const options = structuredClone(rawOptions);
  const modelState = recordOf(response.models);
  const models = Array.isArray(modelState?.availableModels)
    ? modelState.availableModels.map(recordOf).filter(Boolean)
    : [];
  const currentModelId = stringValue(modelState?.currentModelId);
  if (models.length && currentModelId && !options.some((option) => option.category === "model")) {
    options.push({
      id: ACP_SESSION_MODEL_OPTION_ID,
      name: "模型",
      description: "由 Agent 会话动态提供",
      category: "model",
      type: "select",
      currentValue: currentModelId,
      options: models
        .map((model) => ({
          value: stringValue(model?.modelId),
          name: stringValue(model?.name) || stringValue(model?.modelId),
          description: stringValue(model?.description) || undefined
        }))
        .filter((model) => model.value)
    });
  } else {
    preserveSyntheticOption(options, previous, ACP_SESSION_MODEL_OPTION_ID);
  }

  const modeState = recordOf(response.modes);
  const modes = Array.isArray(modeState?.availableModes)
    ? modeState.availableModes.map(recordOf).filter(Boolean)
    : [];
  const currentModeId = stringValue(modeState?.currentModeId);
  if (modes.length && currentModeId && !options.some((option) => option.category === "mode")) {
    options.push({
      id: ACP_SESSION_MODE_OPTION_ID,
      name: "Agent 模式",
      description: "由 Agent 会话动态提供",
      category: "mode",
      type: "select",
      currentValue: currentModeId,
      options: modes
        .map((mode) => ({
          value: stringValue(mode?.id),
          name: stringValue(mode?.name) || stringValue(mode?.id),
          description: stringValue(mode?.description) || undefined
        }))
        .filter((mode) => mode.value)
    });
  } else {
    preserveSyntheticOption(options, previous, ACP_SESSION_MODE_OPTION_ID);
  }
  return options;
}

export function updateSessionControlValue(options: SessionConfigOption[], optionId: string, value: string | boolean) {
  return options.map((option) => option.id === optionId ? { ...option, currentValue: value } as SessionConfigOption : option);
}

export function isSyntheticSessionOption(optionId: string) {
  return optionId === ACP_SESSION_MODEL_OPTION_ID || optionId === ACP_SESSION_MODE_OPTION_ID;
}

function preserveSyntheticOption(options: SessionConfigOption[], previous: SessionConfigOption[], optionId: string) {
  if (options.some((option) => option.id === optionId)) return;
  const existing = previous.find((option) => option.id === optionId);
  if (existing) options.push(structuredClone(existing));
}

function recordOf(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
