import type { KeyboardEvent } from "react";
import { Check, ChevronDown, Folder, FolderPlus, MessageSquare, MessageSquareText, Workflow } from "lucide-react";
import type { AgentProviderDescriptor } from "../agents/types";
import { ProviderIcon } from "../branding/ProviderIcon";
import type { ProviderControlSnapshot } from "../providers/types";
import { CapabilityModeBadge, capabilitySnapshotForControl, useProviderCapabilitySnapshot } from "../providers/CapabilityCompatibility";
import { useHoverPanel } from "./useHoverPanel";
import "../design/task-launch.css";

type TaskLaunchControlsProps = {
  workspaces: Array<{ id: string; name: string; root: string }>;
  providers: AgentProviderDescriptor[];
  providerControls: ProviderControlSnapshot[];
  workspaceId: string;
  onWorkspaceChange: (workspaceId: string) => void;
  selectedProvider: string;
  onProviderChange: (providerId: string) => void;
  taskKind: "conversation" | "workflow";
  onTaskKindChange: (taskKind: "conversation" | "workflow") => void;
  engineReady: (providerId: string) => boolean;
  workflowReady: boolean;
  busy: boolean;
  onAddDirectory: () => void;
};

function selectRadioWithKeyboard(event: KeyboardEvent<HTMLDivElement>, onSelect: (value: string) => void) {
  const offset = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (!offset && event.key !== "Home" && event.key !== "End") return;
  const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'));
  if (!choices.length) return;
  event.preventDefault();
  const current = choices.findIndex((choice) => choice === document.activeElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (current + offset + choices.length) % choices.length;
  const choice = choices[index];
  choice.focus();
  onSelect(choice.dataset.value || "");
}

export function TaskLaunchControls({ workspaces, providers, providerControls, workspaceId, onWorkspaceChange, selectedProvider, onProviderChange, taskKind, onTaskKindChange, engineReady, workflowReady, busy, onAddDirectory }: TaskLaunchControlsProps) {
  const location = useHoverPanel("task-launch-location", busy);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const engines = providers.filter((provider) => provider.capabilities.sessions.create);
  const selected = engines.find((provider) => provider.id === selectedProvider);
  const selectedControl = providerControls.find((candidate) => candidate.providerId === selectedProvider);
  const capabilityFallback = selectedControl ? capabilitySnapshotForControl(selectedControl) : null;
  const capabilityState = useProviderCapabilitySnapshot(selectedProvider, Boolean(selectedControl), capabilityFallback);
  const firstReady = engines.find((provider) => engineReady(provider.id))?.id;
  const providerTabStop = selected && engineReady(selected.id) ? selected.id : firstReady;
  const selectWorkspace = (id: string) => {
    onWorkspaceChange(id);
    location.close(true);
  };

  return <div className="task-create-controls">
    <div className="task-create-mode-options" role="radiogroup" aria-label="任务类型" onKeyDown={(event) => selectRadioWithKeyboard(event, (value) => onTaskKindChange(value as "conversation" | "workflow"))}>
      <button type="button" className={taskKind === "conversation" ? "is-selected" : ""} role="radio" aria-checked={taskKind === "conversation"} aria-label="对话任务" data-value="conversation" tabIndex={taskKind === "conversation" || !workflowReady ? 0 : -1} disabled={busy} onClick={() => onTaskKindChange("conversation")}><MessageSquareText size={22} strokeWidth={1.6} /><span>对话</span></button>
      <button type="button" className={taskKind === "workflow" ? "is-selected" : ""} role="radio" aria-checked={taskKind === "workflow"} aria-label="任务编排" data-value="workflow" tabIndex={taskKind === "workflow" ? 0 : -1} disabled={busy || !workflowReady} onClick={() => onTaskKindChange("workflow")} title={workflowReady ? "任务编排" : "任务编排暂不可用"}><Workflow size={22} strokeWidth={1.6} /><span>编排</span></button>
    </div>

    <div className="task-create-main">
      {taskKind === "conversation" ? <>
        <div className="task-create-section-heading"><span id="task-create-agent-label">主 Agent</span><span aria-live="polite">{selected?.shortName || "选择一个开始"}{selectedControl && <CapabilityModeBadge snapshot={capabilityState.snapshot || capabilityFallback} loading={capabilityState.loading} />}</span></div>
        <div className="task-create-providers" role="radiogroup" aria-label="本次任务主 Agent" onKeyDown={(event) => selectRadioWithKeyboard(event, onProviderChange)}>
          {engines.map((provider) => {
            const control = providerControls.find((candidate) => candidate.providerId === provider.id);
            const ready = engineReady(provider.id);
            const active = selectedProvider === provider.id;
            return <button type="button" key={provider.id} className={`task-create-provider ${active ? "is-selected" : ""}`} role="radio" aria-checked={active} aria-label={provider.shortName} data-value={provider.id} tabIndex={provider.id === providerTabStop ? 0 : -1} disabled={busy || !ready} onClick={() => onProviderChange(provider.id)} title={`${provider.shortName}${ready ? "" : " · 未就绪"}`}>
              <span className="task-create-provider-icon"><ProviderIcon provider={provider.id} icon={control?.identity.icon || provider.branding.icon} accent={control?.identity.accent || provider.branding.accent} size={30} /></span>
              <span className="task-create-provider-name">{provider.shortName}</span>
              <span className="task-create-provider-check" aria-hidden="true">{active && <Check size={12} strokeWidth={2.2} />}</span>
              {!ready && <span className="task-create-provider-unavailable">未就绪</span>}
            </button>;
          })}
        </div>
        {selectedProvider && !engineReady(selectedProvider) && <p className="task-create-notice" role="status">当前 Agent 尚未就绪</p>}
      </> : <div className="task-create-workflow-overview">
        <span className="task-create-workflow-icon"><Workflow size={30} strokeWidth={1.5} /></span>
        <strong>先规划，再分步执行</strong>
        <p>在项目画布中拆分与管理任务。</p>
        {!workspaceId && <p className="task-create-notice" role="status">选择项目后即可开始</p>}
      </div>}
    </div>

    <div className="task-create-location">
        <button
          ref={location.triggerRef}
          {...location.triggerProps}
          type="button"
          className="task-create-location-trigger"
          disabled={busy}
          aria-label="新任务位置"
          aria-haspopup="dialog"
          aria-expanded={location.open && !busy}
          aria-controls="task-create-location-panel"
          title={workspace?.root || "临时对话"}
        ><Folder size={18} strokeWidth={1.7} /><span>{workspace?.name || "临时对话"}</span><ChevronDown size={14} /></button>
        <button type="button" className="task-create-icon" disabled={busy} onClick={onAddDirectory} title="选择目录并添加项目" aria-label="选择目录并添加项目"><FolderPlus size={17} /></button>
        {location.open && !busy && <section
          ref={location.panelRef}
          {...location.panelProps}
          id="task-create-location-panel"
          className="task-create-location-panel"
          role="dialog"
          aria-label="选择任务位置"
        >
          <button type="button" className={!workspaceId ? "is-selected" : ""} onClick={() => selectWorkspace("")} aria-pressed={!workspaceId}><MessageSquare size={16} /><span>临时对话</span>{!workspaceId && <Check size={14} />}</button>
          {workspaces.length > 0 && <div className="task-create-location-divider" />}
          {workspaces.map((item) => <button type="button" key={item.id} className={workspaceId === item.id ? "is-selected" : ""} title={item.root} onClick={() => selectWorkspace(item.id)} aria-pressed={workspaceId === item.id}><Folder size={16} /><span>{item.name}</span>{workspaceId === item.id && <Check size={14} />}</button>)}
          <button type="button" className="task-create-add-project" onClick={onAddDirectory}><FolderPlus size={16} /><span>添加项目</span></button>
        </section>}
    </div>
  </div>;
}
