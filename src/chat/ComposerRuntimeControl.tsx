import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ProviderIcon } from "../branding/ProviderIcon";
import { HelpButton } from "../help/HelpProvider";
import type { AgentProviderDescriptor } from "../agents/types";
import type { ProviderControlSnapshot } from "../providers/types";
import { acpConfigurationSummary, flattenAcpConfigChoices, orderedAcpConfigOptions, reasoningChoices } from "./providerConfiguration";
import type { EngineName, ExecutionMode, ModelOption, ProviderSessionConfiguration } from "./types";

type Props = {
  provider: EngineName;
  descriptor?: AgentProviderDescriptor;
  control?: ProviderControlSnapshot;
  sessionId?: string;
  model: string;
  effort: string;
  executionMode: ExecutionMode;
  loadModels: (provider: EngineName) => Promise<ModelOption[]>;
  onModelChange: (provider: EngineName, model: string, effort: string) => Promise<void>;
  loadSessionConfiguration: (sessionId: string) => Promise<ProviderSessionConfiguration>;
  onSessionConfigurationChange: (sessionId: string, configId: string, value: string | boolean) => Promise<ProviderSessionConfiguration>;
  onProfileConfigurationChange: (provider: EngineName, configId: string, value: string | boolean) => Promise<ProviderSessionConfiguration>;
  onExecutionModeChange: (mode: ExecutionMode) => Promise<void>;
};

export function ComposerRuntimeControl({
  provider,
  descriptor,
  control,
  sessionId,
  model,
  effort,
  executionMode,
  loadModels,
  onModelChange,
  loadSessionConfiguration,
  onSessionConfigurationChange,
  onProfileConfigurationChange,
  onExecutionModeChange
}: Props) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [sessionConfiguration, setSessionConfiguration] = useState<ProviderSessionConfiguration | null>(null);
  const [selectedModel, setSelectedModel] = useState(model);
  const [selectedEffort, setSelectedEffort] = useState(effort);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const label = descriptor?.shortName || (provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider);
  const modeLabel = executionMode === "collaborative" ? "协作" : "原生";
  const isAcp = control?.identity.transport === "acp";
  const collaborationAvailable = !control || control.identity.transport === "native" || control.capabilities.tools.shell;
  const efforts = control ? reasoningChoices(control.configuration.reasoning) : [];
  const modelOptions = [...new Map([{ id: selectedModel, displayName: selectedModel }, ...models].filter((item) => item.id).map((item) => [item.id, item])).values()];
  const sessionOptions = orderedAcpConfigOptions(sessionConfiguration?.options || control?.configuration.sessionOptions || []);
  const configurationSummary = isAcp
    ? acpConfigurationSummary(sessionOptions, sessionId ? label : "创建任务后配置")
    : [selectedModel || label, selectedEffort].filter(Boolean).join(" · ");

  useEffect(() => {
    setSelectedModel(model);
    setSelectedEffort(effort);
    setSessionConfiguration(isAcp ? { schemaVersion: 1, providerId: provider, transport: "acp", options: control?.configuration.sessionOptions || [] } : null);
  }, [provider, model, effort, isAcp, control?.configuration.sessionOptions]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const request = isAcp
      ? sessionId
        ? loadSessionConfiguration(sessionId).then((configuration) => { if (!cancelled) setSessionConfiguration(configuration); })
        : Promise.resolve()
      : control?.capabilities.configuration.models === false
        ? Promise.resolve()
        : loadModels(provider).then((items) => { if (!cancelled) setModels(items); });
    request
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, provider, sessionId, isAcp, loadModels, loadSessionConfiguration, control?.capabilities.configuration.models]);

  const saveModel = async (nextModel: string, nextEffort: string) => {
    setSaving(true);
    setError("");
    try { await onModelChange(provider, nextModel, nextEffort); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  const saveMode = async (mode: ExecutionMode) => {
    if (mode === executionMode) return;
    setSaving(true);
    setError("");
    try { await onExecutionModeChange(mode); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  const saveSessionOption = async (configId: string, value: string | boolean) => {
    setSaving(true);
    setError("");
    try {
      setSessionConfiguration(sessionId
        ? await onSessionConfigurationChange(sessionId, configId, value)
        : await onProfileConfigurationChange(provider, configId, value));
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  return <div ref={rootRef} className={`composer-runtime-control ${open ? "open" : ""}`}>
    <button type="button" className="composer-runtime-trigger" aria-label={`${label}，工作台${modeLabel}模式，${configurationSummary}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="composer-runtime-logo"><ProviderIcon provider={provider} icon={control?.identity.icon} accent={control?.identity.accent} size={18} /></span>
      <span className="composer-runtime-copy"><small>{modeLabel}</small><strong>{configurationSummary}</strong></span>
      <ChevronDown size={12} />
    </button>
    {open && <section className="composer-runtime-popover" role="dialog" aria-label={`${label} 运行配置`}>
      <div className="composer-runtime-mode-heading"><span>运行模式</span><HelpButton topic="delegation-protocol" /></div>
      <div className="composer-runtime-mode" role="radiogroup" aria-label="运行模式">
        {(["native", "collaborative"] as ExecutionMode[]).map((mode) => <button type="button" role="radio" aria-checked={executionMode === mode} className={executionMode === mode ? "selected" : ""} disabled={saving || (mode === "collaborative" && !collaborationAvailable)} title={mode === "collaborative" && !collaborationAvailable ? "该 Agent 未声明终端能力，无法调用工作台委派桥接" : undefined} key={mode} onClick={() => void saveMode(mode)}><span>{mode === "native" ? "原生" : "协作"}</span>{executionMode === mode && <Check size={12} />}</button>)}
      </div>
      {!collaborationAvailable && <div className="composer-runtime-empty">该 Agent 当前仅支持原生运行</div>}
      {!isAcp && (control?.capabilities.configuration.models !== false || efforts.length > 0) && <div className="composer-runtime-fields">
        {control?.capabilities.configuration.models !== false &&
        <select aria-label="模型" value={selectedModel} disabled={saving || loading || !modelOptions.length} onChange={(event) => { const value = event.target.value; setSelectedModel(value); void saveModel(value, selectedEffort); }}>
          {!modelOptions.length && <option value="">{loading ? "正在读取" : "暂无模型"}</option>}
          {modelOptions.map((item) => <option key={item.id} value={item.id}>{item.displayName || item.id}</option>)}
        </select>}
        {efforts.length > 0 &&
        <select aria-label="思考强度" value={selectedEffort} disabled={saving} onChange={(event) => { const value = event.target.value; setSelectedEffort(value); void saveModel(selectedModel, value); }}>
          {efforts.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>}
      </div>}
      {isAcp && !loading && !sessionOptions.length && <div className="composer-runtime-empty">请先在 Provider 中测试连接并探测模型</div>}
      {isAcp && sessionOptions.length > 0 && <div className="composer-runtime-fields acp">
        {sessionOptions.map((option) => <label key={option.id} className={option.category === "model" ? "wide" : ""} title={option.description || option.name}>
          <span>{option.name}</span>
          {option.type === "boolean"
            ? <select aria-label={option.name} value={String(option.currentValue)} disabled={saving} onChange={(event) => void saveSessionOption(option.id, event.target.value === "true")}><option value="true">启用</option><option value="false">关闭</option></select>
            : <select aria-label={option.name} value={String(option.currentValue)} disabled={saving} onChange={(event) => void saveSessionOption(option.id, event.target.value)}>{flattenAcpConfigChoices(option).map((choice) => <option key={choice.value} value={choice.value}>{choice.name}</option>)}</select>}
        </label>)}
      </div>}
      {(loading || saving) && <LoaderCircle className="spin composer-runtime-progress" size={13} />}
      {error && <p>{error}</p>}
    </section>}
  </div>;
}
