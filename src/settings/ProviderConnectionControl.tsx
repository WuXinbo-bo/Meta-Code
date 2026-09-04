import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, Search, Settings2, Trash2 } from "lucide-react";
import { realtimeCoordinator } from "../realtimeCoordinator";
import type { ProviderControlSnapshot } from "../providers/types";

type ConnectionProfile = {
  id: string;
  providerId: string;
  name: string;
  authMode: "native-account" | "official-api" | "custom-endpoint" | "system-profile";
  authMethodId: string;
  baseUrl: string;
  apiKeyEnv: string;
  baseUrlEnv: string;
  env: Record<string, string>;
  secretEnvConfigured: string[];
  isDefault: boolean;
  apiKeyConfigured: boolean;
  healthStatus: "unknown" | "checking" | "ready" | "failed";
  healthCheckedAt: string;
  healthLatencyMs: number;
  healthMessage: string;
  configOptions: AcpConfigOption[];
  configValues: Record<string, string | boolean>;
};

type AcpConfigOption = {
  type: "select" | "boolean";
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  currentValue: string | boolean;
  options?: Array<{ value: string; name: string } | { group: string; name: string; options: Array<{ value: string; name: string }> }>;
};

type ProviderConfiguration = {
  providerId: string;
  authMethods: Array<{ id: string; name: string; description: string; type: "agent" | "terminal" }>;
  fields: Array<{ env: string; label: string; kind: "text" | "url" | "boolean" | "secret"; description?: string; placeholder?: string; defaultValue?: string; authMethodIds?: string[] }>;
  agentInfo: { name: string; title?: string; version: string } | null;
};

type ProfileDraft = Omit<ConnectionProfile, "secretEnvConfigured"> & {
  apiKey: string;
  secretEnv: Record<string, string>;
  secretEnvConfigured: string[];
};

const EMPTY_PROFILE: ProfileDraft = {
  id: "", providerId: "", name: "默认连接", authMode: "native-account", authMethodId: "", baseUrl: "", apiKey: "", apiKeyEnv: "", baseUrlEnv: "", env: {}, secretEnv: {}, secretEnvConfigured: [], isDefault: true, apiKeyConfigured: false,
  healthStatus: "unknown", healthCheckedAt: "", healthLatencyMs: 0, healthMessage: "", configOptions: [], configValues: {}
};

type ProviderRequestInit = RequestInit & { timeoutMs?: number };

async function providerApi<T>(url: string, init?: ProviderRequestInit) {
  const { timeoutMs = 45_000, signal: parentSignal, ...request } = init || {};
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(url, { ...request, signal, headers: { ...(request.body ? { "content-type": "application/json" } : {}), ...(request.headers || {}) } });
  } catch (cause) {
    if (timeoutSignal.aborted) throw new Error(`连接操作超时（${Math.round(timeoutMs / 1000)} 秒），已终止后台 Agent`);
    throw cause;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function draftFromProfile(profile: ConnectionProfile): ProfileDraft {
  return { ...profile, apiKey: "", secretEnv: {} };
}

function selectOptions(option: AcpConfigOption) {
  return (option.options || []).flatMap((item) => "options" in item ? item.options : [item]);
}

function newProfileDraft(providerId: string, configuration: ProviderConfiguration | null, isDefault: boolean): ProfileDraft {
  const method = configuration?.authMethods.find((item) => item.type === "agent");
  const env = Object.fromEntries((configuration?.fields || []).filter((field) => field.kind !== "secret" && field.defaultValue !== undefined && (!field.authMethodIds?.length || field.authMethodIds.includes(method?.id || ""))).map((field) => [field.env, field.defaultValue || ""]));
  return { ...EMPTY_PROFILE, providerId, authMethodId: method?.id || "", env, isDefault };
}

function authModeForMethod(methodId: string, current: ProfileDraft["authMode"]): ProfileDraft["authMode"] {
  if (methodId === "system-account") return "system-profile";
  if (["openai-api-key", "anthropic-api-key"].includes(methodId)) return "official-api";
  if (["openai-compatible", "anthropic-compatible", "gateway"].includes(methodId)) return "custom-endpoint";
  if (methodId === "workbench-account") return "native-account";
  return current === "system-profile" ? "system-profile" : "native-account";
}

export function ProviderConnectionControl({ providerId, control, title = "账号与连接" }: { providerId: string; control?: ProviderControlSnapshot; title?: string }) {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [configuration, setConfiguration] = useState<ProviderConfiguration | null>(null);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ ...EMPTY_PROFILE, providerId });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [profileResult, control] = await Promise.all([
        providerApi<{ items: ConnectionProfile[] }>(`/api/agent-market/${encodeURIComponent(providerId)}/profiles`),
        providerApi<ProviderConfiguration>(`/api/agent-market/${encodeURIComponent(providerId)}/configuration`)
      ]);
      setProfiles(profileResult.items);
      setConfiguration(control);
      const existing = profileResult.items.find((item) => item.isDefault) || profileResult.items[0];
      setProfileDraft(existing ? draftFromProfile(existing) : newProfileDraft(providerId, control, true));
      setNotice("");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [providerId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => realtimeCoordinator.subscribe("agent-market.changed", (detail) => {
    if (!detail.providerId || detail.providerId === providerId) void load();
  }), [load, providerId]);
  useEffect(() => realtimeCoordinator.subscribe("provider-control.changed", (detail) => {
    if (!detail.providerId || detail.providerId === providerId) void load();
  }), [load, providerId]);

  const selectedAuthMethod = configuration?.authMethods.find((method) => method.id === profileDraft.authMethodId);
  const activeFields = useMemo(() => (configuration?.fields || []).filter((field) => !field.authMethodIds?.length || !profileDraft.authMethodId || field.authMethodIds.includes(profileDraft.authMethodId)), [configuration?.fields, profileDraft.authMethodId]);

  const persist = async () => {
    const currentId = profileDraft.id;
    const url = currentId ? `/api/agent-market/${encodeURIComponent(providerId)}/profiles/${encodeURIComponent(currentId)}` : `/api/agent-market/${encodeURIComponent(providerId)}/profiles`;
    const saved = await providerApi<ConnectionProfile>(url, { method: currentId ? "PUT" : "POST", body: JSON.stringify(profileDraft) });
    const result = await providerApi<{ items: ConnectionProfile[] }>(`/api/agent-market/${encodeURIComponent(providerId)}/profiles`);
    setProfiles(result.items);
    setProfileDraft(draftFromProfile(saved));
    return saved;
  };

  const save = async () => {
    setBusy(true); setNotice("");
    try { await persist(); setNotice("连接配置已保存"); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const authenticate = async () => {
    setBusy(true); setNotice("");
    try {
      const saved = await persist();
      const result = await providerApi<{ message: string; configOptions: Array<{ name?: string }> }>(`/api/agent-market/${encodeURIComponent(providerId)}/authenticate`, { method: "POST", body: JSON.stringify({ profileId: saved.id, methodId: saved.authMethodId }), timeoutMs: selectedAuthMethod?.id === "oauth-personal" ? 5 * 60_000 : 95_000 });
      const options = result.configOptions.map((item) => item.name).filter(Boolean).join("、");
      setNotice(options ? `${result.message}；可配置：${options}` : result.message);
      const refreshed = await providerApi<{ items: ConnectionProfile[] }>(`/api/agent-market/${encodeURIComponent(providerId)}/profiles`);
      setProfiles(refreshed.items);
      const verified = refreshed.items.find((item) => item.id === saved.id);
      if (verified) setProfileDraft(draftFromProfile(verified));
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const discoverModels = async () => {
    setBusy(true); setNotice("");
    try {
      const saved = await persist();
      const result = await providerApi<{ message: string }>(`/api/agent-market/${encodeURIComponent(providerId)}/models`, { method: "POST", body: JSON.stringify({ profileId: saved.id, methodId: saved.authMethodId }), timeoutMs: 95_000 });
      setNotice(result.message);
      const refreshed = await providerApi<{ items: ConnectionProfile[] }>(`/api/agent-market/${encodeURIComponent(providerId)}/profiles`);
      setProfiles(refreshed.items);
      const discovered = refreshed.items.find((item) => item.id === saved.id);
      if (discovered) setProfileDraft(draftFromProfile(discovered));
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!profileDraft.id) return;
    setBusy(true);
    try {
      await providerApi(`/api/agent-market/${encodeURIComponent(providerId)}/profiles/${encodeURIComponent(profileDraft.id)}`, { method: "DELETE" });
      const next = profiles.filter((profile) => profile.id !== profileDraft.id);
      setProfiles(next);
      setProfileDraft(next[0] ? draftFromProfile(next[0]) : newProfileDraft(providerId, configuration, true));
      setNotice("连接配置已删除");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return <form className="agent-market-profiles provider-connection-control" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <header><strong>{title}</strong><button type="button" onClick={() => setProfileDraft(newProfileDraft(providerId, configuration, profiles.length === 0))}>新建</button></header>
    {loading ? <div className="agent-market-control-loading"><LoaderCircle className="spin" size={13} />正在读取 Agent 配置能力</div> : <>
      {profiles.length > 0 && <div className="agent-market-profile-tabs">{profiles.map((profile) => <button type="button" key={profile.id} className={profileDraft.id === profile.id ? "active" : ""} onClick={() => setProfileDraft(draftFromProfile(profile))}>{profile.name}{profile.isDefault ? <Check size={10} /> : null}</button>)}</div>}
      <div className="agent-market-profile-form">
        <label><span>方案名称</span><input value={profileDraft.name} onChange={(event) => setProfileDraft((current) => ({ ...current, name: event.target.value }))} /></label>
        {configuration?.authMethods.length ? <label className="wide"><span>账号与接口</span><select value={profileDraft.authMethodId} onChange={(event) => { const authMethodId = event.target.value; setProfileDraft((current) => ({ ...current, authMethodId, authMode: authModeForMethod(authMethodId, current.authMode), env: { ...current.env, ...Object.fromEntries((configuration.fields || []).filter((field) => field.kind !== "secret" && field.defaultValue !== undefined && (!field.authMethodIds?.length || field.authMethodIds.includes(authMethodId))).map((field) => [field.env, field.defaultValue || ""])) } })); }}>{configuration.authMethods.map((method) => <option key={method.id} value={method.id} disabled={method.type === "terminal"}>{method.name}{method.type === "terminal" ? "（需要终端）" : ""}</option>)}</select>{selectedAuthMethod?.description && <small>{selectedAuthMethod.description}</small>}</label> : <label><span>配置来源</span><select value={profileDraft.authMode === "system-profile" ? "system-profile" : "workbench"} onChange={(event) => setProfileDraft((current) => ({ ...current, authMode: event.target.value === "system-profile" ? "system-profile" : "native-account" }))}><option value="workbench">工作台独立</option><option value="system-profile">复用系统账号</option></select></label>}
        {activeFields.map((field) => <label key={field.env} className={field.kind === "url" || field.kind === "secret" ? "wide" : ""}><span>{field.label}{field.kind === "secret" && profileDraft.secretEnvConfigured.includes(field.env) ? " · 已保存" : ""}</span>{field.kind === "boolean" ? <select value={profileDraft.env[field.env] ?? field.defaultValue ?? "false"} onChange={(event) => setProfileDraft((current) => ({ ...current, env: { ...current.env, [field.env]: event.target.value } }))}><option value="true">启用</option><option value="false">关闭</option></select> : <input type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"} autoComplete={field.kind === "secret" ? "new-password" : field.kind === "url" ? "url" : "off"} value={field.kind === "secret" ? profileDraft.secretEnv[field.env] || "" : profileDraft.env[field.env] || ""} onChange={(event) => setProfileDraft((current) => field.kind === "secret" ? { ...current, secretEnv: { ...current.secretEnv, [field.env]: event.target.value } } : { ...current, env: { ...current.env, [field.env]: event.target.value } })} placeholder={field.kind === "secret" && profileDraft.secretEnvConfigured.includes(field.env) ? "留空保持原值" : field.placeholder || field.env} />}{field.description && <small>{field.description}</small>}</label>)}
        {!activeFields.length && <><label className="wide"><span>Base URL</span><input type="url" autoComplete="url" value={profileDraft.baseUrl} onChange={(event) => setProfileDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com" /></label><label><span>API Key 变量</span><input autoComplete="off" value={profileDraft.apiKeyEnv} onChange={(event) => setProfileDraft((current) => ({ ...current, apiKeyEnv: event.target.value }))} placeholder="API_KEY" /></label><label><span>Base URL 变量</span><input autoComplete="off" value={profileDraft.baseUrlEnv} onChange={(event) => setProfileDraft((current) => ({ ...current, baseUrlEnv: event.target.value }))} placeholder="BASE_URL" /></label><label className="wide"><span>API Key {profileDraft.apiKeyConfigured ? "· 已保存" : ""}</span><input type="password" autoComplete="new-password" value={profileDraft.apiKey} onChange={(event) => setProfileDraft((current) => ({ ...current, apiKey: event.target.value }))} placeholder={profileDraft.apiKeyConfigured ? "留空保持原值" : "输入密钥"} /></label></>}
        {profileDraft.configOptions.map((option) => <label key={option.id} className={option.category === "model" ? "wide" : ""}><span>{option.name}</span>{option.type === "boolean"
          ? <select value={String(profileDraft.configValues[option.id] ?? option.currentValue)} onChange={(event) => setProfileDraft((current) => ({ ...current, configValues: { ...current.configValues, [option.id]: event.target.value === "true" } }))}><option value="true">启用</option><option value="false">关闭</option></select>
          : <select value={String(profileDraft.configValues[option.id] ?? option.currentValue)} onChange={(event) => setProfileDraft((current) => ({ ...current, configValues: { ...current.configValues, [option.id]: event.target.value } }))}>{selectOptions(option).map((item) => <option key={item.value} value={item.value}>{item.name}</option>)}</select>}{option.description && <small>{option.description}</small>}</label>)}
        <label className="agent-market-default"><input type="checkbox" checked={profileDraft.isDefault} onChange={(event) => setProfileDraft((current) => ({ ...current, isDefault: event.target.checked }))} /><span>设为默认连接</span></label>
      </div>
      <footer>{profileDraft.id && <button type="button" className="provider-connection-delete" title="删除连接方案" disabled={busy} onClick={() => void remove()}><Trash2 size={13} /></button>}{control?.operations.discoverModels !== false && <button type="button" disabled={busy} onClick={() => void discoverModels()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />}探测模型</button>}{control?.operations.testConnection !== false && <button type="button" disabled={busy} onClick={() => void authenticate()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Settings2 size={13} />}{selectedAuthMethod?.id === "oauth-personal" ? "登录并验证" : "测试连接"}</button>}<button type="submit" className="primary" disabled={busy}><Check size={13} />保存</button></footer>
    </>}
    {profileDraft.healthMessage && <div className={`provider-connection-health ${profileDraft.healthStatus}`}><i />{profileDraft.healthMessage}{profileDraft.healthLatencyMs > 0 ? <small>{profileDraft.healthLatencyMs} ms</small> : null}</div>}
    {notice && <div className="agent-market-notice">{notice}</div>}
  </form>;
}
