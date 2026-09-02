import { AtSign, Check, ChevronDown, Layers3, Settings, Sparkles, Wrench } from "lucide-react";
import type { CapabilityProfileSummary } from "./types";
import { HelpButton } from "../help/HelpProvider";

type Props = {
  open: boolean;
  activeProfileId: string | null;
  activeLabel: string;
  adjusted: boolean;
  profiles: CapabilityProfileSummary[];
  onToggle: () => void;
  onClose: () => void;
  onSelect: (profileId: string | null) => Promise<void>;
  onTemporarySkills: () => void;
  onManage: () => void;
};

export function CapabilityProfileControl({
  open,
  activeProfileId,
  activeLabel,
  adjusted,
  profiles,
  onToggle,
  onClose,
  onSelect,
  onTemporarySkills,
  onManage
}: Props) {
  return <div className={`composer-capability-control ${open ? "open" : ""}`}>
    <button type="button" className="composer-control-button capability-profile-trigger" title="选择当前任务的能力方案" aria-expanded={open} onClick={onToggle}>
      <Sparkles size={13} /><span>{activeLabel}</span>{adjusted && <i title="当前配置包含单独调整" />}<ChevronDown size={12} />
    </button>
    {open && <button type="button" className="skill-quick-config-dismiss" aria-label="关闭能力方案菜单" onClick={onClose} />}
    {open && <div className="skill-quick-config composer-capability-popover" role="dialog" aria-label="快速选择能力方案">
      <div className="skill-quick-config-header"><span><strong>{activeLabel}</strong><small>{adjusted ? "当前工作区包含单独调整" : "当前能力方案"}</small></span><div><HelpButton topic="capability-profiles" /><button type="button" aria-label="打开 Skill 中心" title="打开 Skill 中心" onClick={onManage}><Settings size={14} /></button></div></div>
      <div className="skill-profile-quick-list">
        <button type="button" className={!activeProfileId ? "selected" : ""} onClick={() => void onSelect(null)}><Wrench size={13} /><span><strong>自定义配置</strong><small>不使用已保存方案</small></span>{!activeProfileId && <Check size={13} />}</button>
        {profiles.map((profile) => <button type="button" className={profile.id === activeProfileId ? "selected" : ""} key={profile.id} onClick={() => void onSelect(profile.id)}><Layers3 size={13} /><span><strong>{profile.name}</strong><small>{profile.description || "已保存的 Skill 策略"}</small></span>{profile.id === activeProfileId && <Check size={13} />}</button>)}
        {!profiles.length && <p className="skill-invoke-empty">还没有已保存的能力方案。</p>}
      </div>
      <div className="skill-quick-config-actions"><button type="button" onClick={onTemporarySkills}><AtSign size={13} />本轮临时调用</button><button type="button" onClick={onManage}><Settings size={13} />管理能力方案</button></div>
    </div>}
  </div>;
}
