import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Bookmark, ChevronDown, FolderOpen, GitBranch, Layers3, LoaderCircle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { confirmAction } from "../components/ConfirmationProvider";

export type ExecutionTarget = "workspace" | "isolated" | "worktree";
type Notice = (message: string, tone?: "success" | "warning" | "error" | "info") => void;
type Parameter = { name: string; label: string; kind: "text" | "path" | "choice"; required: boolean; defaultValue?: string; options?: string[] };
type Definition = { id: string; revision: number; name: string; description: string; parameters: Parameter[] };
type DefinitionWorkflow = { id: string; title: string; originalPrompt: string; plannerEngine: string; status: string; executionTarget?: ExecutionTarget; plan: unknown };
type Comparison = {
  workflowRevision: number; previewDigest: string; sourceDirty: boolean; targetDirty: boolean;
  changedFiles: string[]; untrackedFiles: string[]; committedDiff: string; workingDiff: string;
  status: string; message?: string; conflicts: string[];
  binding: { revision: number; branch: string | null; integratedAt: string | null };
};

async function request<T>(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `请求失败（${response.status}）`);
  return body as T;
}

export function ExecutionTargetSelect({ value, onChange, includeWorktree = true, disabled = false }: { value: ExecutionTarget; onChange: (value: ExecutionTarget) => void; includeWorktree?: boolean; disabled?: boolean }) {
  const Icon = value === "workspace" ? FolderOpen : value === "worktree" ? GitBranch : Layers3;
  return <label className="workflow-target-select" title="执行位置"><Icon size={14} /><select aria-label="执行位置" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as ExecutionTarget)}><option value="workspace">当前项目</option><option value="isolated">隔离任务</option>{includeWorktree && <option value="worktree">Git Worktree</option>}</select></label>;
}

export function WorkflowDefinitionPicker({ workspaceId, target, onCreated, onNotice }: { workspaceId?: string; target: ExecutionTarget; onCreated: (id: string) => void; onNotice: Notice }) {
  const [items, setItems] = useState<Definition[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  useEffect(() => { generation.current += 1; setBusy(false); return () => { generation.current += 1; }; }, [workspaceId]);
  const selected = items.find((item) => item.id === selectedId);
  const load = async () => {
    const current = generation.current;
    try { const response = await request<{ items: Definition[] }>("/api/workflow-definitions"); if (generation.current === current) { setItems(response.items); setError(""); } }
    catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  useEffect(() => { void load(); }, [workspaceId]);
  useEffect(() => { setInputs(Object.fromEntries((selected?.parameters || []).map((parameter) => [parameter.name, parameter.defaultValue || ""]))); }, [selectedId]);
  const instantiate = async () => {
    if (busy || !selected || !workspaceId) return;
    const current = generation.current;
    const isCurrent = () => generation.current === current && currentWorkspace.current === workspaceId;
    setBusy(true);
    try {
      const workflow = await request<{ id: string }>(`/api/workflow-definitions/${encodeURIComponent(selected.id)}/instantiate`, { method: "POST", body: JSON.stringify({ workspaceId, expectedRevision: selected.revision, inputs, executionTarget: target }) });
      if (!isCurrent()) return;
      onCreated(workflow.id);
      onNotice("工作流程已创建，等待审批", "success");
    } catch (failure) { if (isCurrent()) { onNotice(failure instanceof Error ? failure.message : String(failure), "error"); await load(); } }
    finally { if (isCurrent()) setBusy(false); }
  };
  return <div className="workflow-definition-picker">
    <div className="workflow-definition-select"><Bookmark size={15} /><select aria-label="选择工作流程" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="">选择工作流程</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" title="刷新工作流程" onClick={() => void load()}><RefreshCw size={14} /></button></div>
    {error && <p className="workflow-extension-error">{error}</p>}
    {selected && <><p className="workflow-extension-description">{selected.description}</p>{selected.parameters.map((parameter) => <label key={parameter.name}>{parameter.label}{parameter.required && <span aria-hidden="true"> *</span>}{parameter.kind === "choice" ? <select value={inputs[parameter.name] || ""} onChange={(event) => setInputs((current) => ({ ...current, [parameter.name]: event.target.value }))}>{!parameter.required && <option value="">未指定</option>}{parameter.required && !inputs[parameter.name] && <option value="">请选择</option>}{parameter.options?.map((option) => <option key={option}>{option}</option>)}</select> : <input value={inputs[parameter.name] || ""} placeholder={parameter.kind === "path" ? "项目内相对路径" : ""} onChange={(event) => setInputs((current) => ({ ...current, [parameter.name]: event.target.value }))} />}</label>)}<button type="button" className="primary" disabled={busy || !workspaceId || selected.parameters.some((parameter) => parameter.required && !inputs[parameter.name]?.trim())} onClick={() => void instantiate()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}创建任务</button></>}
  </div>;
}

type EditableParameter = Parameter & { sourceValue: string };
function parameterize(value: unknown, parameters: EditableParameter[], key = ""): unknown {
  const protectedKeys = new Set(["id", "provider", "dependsOn", "skills", "mcpServers", "verificationCommands", "producerNodeId", "providerReason"]);
  if (protectedKeys.has(key)) return value;
  if (typeof value === "string") return parameters.reduce((text, parameter) => parameter.sourceValue ? text.split(parameter.sourceValue).join(`{{${parameter.name}}}`) : text, value);
  if (Array.isArray(value)) return value.map((item) => parameterize(item, parameters, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, parameterize(item, parameters, field)]));
  return value;
}

export function WorkflowExtensions({ workflow, workspaceId, onNotice, onChanged }: { workflow: DefinitionWorkflow; workspaceId?: string; onNotice: Notice; onChanged: () => Promise<void> }) {
  const [panel, setPanel] = useState<"save" | "compare" | null>(null);
  const [name, setName] = useState(workflow.title);
  const [description, setDescription] = useState("");
  const [parameters, setParameters] = useState<EditableParameter[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [snapshotChanges, setSnapshotChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; setPanel(null); setName(workflow.title); setDescription(""); setParameters([]); setComparison(null); setError(""); setBusy(false); return () => { generation.current += 1; }; }, [workflow.id]);
  const updateParameter = (index: number, patch: Partial<EditableParameter>) => setParameters((current) => current.map((parameter, currentIndex) => currentIndex === index ? { ...parameter, ...patch } : parameter));
  const loadComparison = async () => {
    const current = generation.current;
    setBusy(true); setError("");
    try { const value = await request<Comparison>(`/api/workflows/${encodeURIComponent(workflow.id)}/worktree/compare`); if (generation.current === current) setComparison(value); }
    catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const save = async () => {
    const current = generation.current;
    setBusy(true); setError("");
    try {
      await request("/api/workflow-definitions", { method: "POST", body: JSON.stringify({ workflowId: workflow.id, workspaceId, name, description, goalTemplate: parameterize(workflow.originalPrompt, parameters), planTemplate: parameterize(workflow.plan, parameters), parameters: parameters.map(({ sourceValue: _source, ...parameter }) => parameter), team: { plannerEngine: workflow.plannerEngine, nodeProviders: {} } }) });
      if (generation.current === current) { setPanel(null); onNotice("已保存工作流程", "success"); }
    } catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const integrate = async () => {
    const current = generation.current;
    if (!comparison || !await confirmAction(`将方案 ${comparison.binding.branch || "Worktree"} 整合到当前项目。${comparison.sourceDirty ? "方案中尚未提交的修改会先生成 Git 提交。" : ""}当前项目的已有提交会保留。`, { title: "整合方案到项目", confirmLabel: "整合方案" })) return;
    if (generation.current !== current) return;
    setBusy(true); setError("");
    try {
      await request(`/api/workflows/${encodeURIComponent(workflow.id)}/worktree/integrate`, { method: "POST", body: JSON.stringify({ workflowRevision: comparison.workflowRevision, expectedRevision: comparison.binding.revision, previewDigest: comparison.previewDigest, snapshotChanges }) });
      if (generation.current === current) { onNotice("方案已整合到当前项目", "success"); await onChanged(); if (generation.current === current) await loadComparison(); }
    } catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (generation.current === current) setBusy(false); }
  };
  return <>
    <div className="workflow-extension-tools"><button type="button" title="保存工作流程" disabled={!workflow.plan} onClick={() => { setPanel((current) => current === "save" ? null : "save"); setError(""); }}><Bookmark size={15} /></button>{workflow.executionTarget === "worktree" && <button type="button" title="比较方案与项目" onClick={() => { setPanel("compare"); setSnapshotChanges(false); void loadComparison(); }}><GitBranch size={15} /></button>}</div>
    {panel && <aside className="workflow-extension-panel" onPointerDown={(event) => event.stopPropagation()}><header><strong>{panel === "save" ? "保存工作流程" : "方案与项目"}</strong><button type="button" title="关闭" onClick={() => setPanel(null)}><X size={16} /></button></header><div className="workflow-extension-scroll">
      {panel === "save" ? <><label>名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} /></label><label>说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} /></label><div className="workflow-parameter-heading"><strong>输入参数</strong><button type="button" title="添加参数" onClick={() => setParameters((current) => [...current, { name: `input_${current.length + 1}`, label: "新参数", kind: "text", required: true, defaultValue: "", sourceValue: "" }])}><Plus size={14} /></button></div>{parameters.map((parameter, index) => <fieldset className="workflow-parameter-row" key={index}><div><input aria-label={`参数 ${index + 1} 名称`} value={parameter.name} onChange={(event) => updateParameter(index, { name: event.target.value })} placeholder="参数名称" /><select aria-label={`参数 ${index + 1} 类型`} value={parameter.kind} onChange={(event) => updateParameter(index, { kind: event.target.value as Parameter["kind"] })}><option value="text">文本</option><option value="path">路径</option><option value="choice">选项</option></select><button type="button" title="删除参数" onClick={() => setParameters((current) => current.filter((_, currentIndex) => currentIndex !== index))}><Trash2 size={14} /></button></div><input aria-label={`参数 ${index + 1} 标签`} value={parameter.label} onChange={(event) => updateParameter(index, { label: event.target.value })} placeholder="显示名称" /><input aria-label={`参数 ${index + 1} 替换内容`} value={parameter.sourceValue} onChange={(event) => updateParameter(index, { sourceValue: event.target.value, defaultValue: event.target.value })} placeholder="任务中需要替换的原始内容" />{parameter.kind === "choice" && <input aria-label={`参数 ${index + 1} 可选值`} value={parameter.options?.join(", ") || ""} onChange={(event) => updateParameter(index, { options: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} placeholder="可选值，用逗号分隔" />}<label className="workflow-extension-checkbox"><input type="checkbox" checked={parameter.required} onChange={(event) => updateParameter(index, { required: event.target.checked })} />必填</label></fieldset>)}</> : <>{busy && !comparison ? <p><LoaderCircle className="spin" size={15} />正在比较方案</p> : comparison && <><div className="workflow-comparison-summary"><GitBranch size={16} /><strong>{comparison.binding.branch || "方案 Worktree"}</strong><button type="button" title="刷新对比" disabled={busy} onClick={() => void loadComparison()}><RefreshCw size={14} /></button></div><p className="workflow-extension-description">{comparison.message || (comparison.status === "ready" ? "方案可整合" : comparison.status === "already_up_to_date" ? "项目已包含方案成果" : comparison.status === "conflicts" ? "方案与项目存在冲突" : "暂时无法整合")}</p>{comparison.targetDirty && <p className="workflow-extension-error">当前项目有未提交修改，请先处理后重新比较。</p>}<div className="workflow-comparison-files">{[...new Set([...comparison.changedFiles, ...comparison.untrackedFiles])].map((file) => <code key={file}>{file}</code>)}</div>{comparison.conflicts.length > 0 && <div className="workflow-extension-error">{comparison.conflicts.map((file) => <p key={file}>{file}</p>)}</div>}<details><summary>文件差异<ChevronDown size={13} /></summary><pre>{[comparison.committedDiff, comparison.workingDiff].filter(Boolean).join("\n") || "没有文件差异"}</pre></details>{comparison.sourceDirty && <label className="workflow-extension-checkbox"><input type="checkbox" checked={snapshotChanges} onChange={(event) => setSnapshotChanges(event.target.checked)} />提交方案修改后整合</label>}</>}</>}
      {error && <p className="workflow-extension-error" role="alert">{error}</p>}
    </div><footer><button type="button" onClick={() => setPanel(null)}>取消</button>{panel === "save" ? <button type="button" className="primary" disabled={busy || !name.trim() || parameters.some((parameter) => !/^[a-z][a-z0-9_]{0,63}$/.test(parameter.name) || !parameter.sourceValue.trim())} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Bookmark size={14} />}保存</button> : <button type="button" className="primary" disabled={busy || workflow.status !== "completed" || comparison?.status !== "ready" || Boolean(comparison.sourceDirty && !snapshotChanges) || Boolean(comparison.targetDirty)} onClick={() => void integrate()}>{busy ? <LoaderCircle className="spin" size={14} /> : <ArrowDownToLine size={14} />}整合到项目</button>}</footer></aside>}
  </>;
}
