import { Bot, Boxes, CircleHelp, Database, History, LayoutDashboard, PanelsTopLeft, RefreshCw, Store, Terminal } from "lucide-react";

export type SettingsSectionName = "ai" | "sessions" | "pages" | "data" | "updates" | "help";
export type AgentSettingsPage = "overview" | "providers" | "market" | "runtime";

const SETTINGS_SECTIONS = [
  { id: "ai", label: "Agent", icon: Bot },
  { id: "sessions", label: "会话", icon: History },
  { id: "pages", label: "页面与标签", icon: PanelsTopLeft },
  { id: "data", label: "数据", icon: Database },
  { id: "updates", label: "软件更新", icon: RefreshCw },
  { id: "help", label: "帮助与入门", icon: CircleHelp }
] as const;

const AGENT_PAGES = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "providers", label: "Provider", icon: Boxes },
  { id: "market", label: "Agent 市场", icon: Store },
  { id: "runtime", label: "运行环境", icon: Terminal }
] as const;

export function SettingsNavigation({ value, agentPage, onChange, onAgentPageChange }: { value: SettingsSectionName; agentPage: AgentSettingsPage; onChange: (value: SettingsSectionName) => void; onAgentPageChange: (value: AgentSettingsPage) => void }) {
  return <aside className="settings-navigation">
    <nav className="settings-section-list" aria-label="设置类别">
      {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => <div className={`settings-navigation-group ${id === "ai" ? "agent-navigation-group" : ""}`} key={id}>
        <button type="button" className={value === id ? "active" : ""} aria-current={value === id ? "page" : undefined} onClick={() => onChange(id)}><Icon size={15} /><span>{label}</span></button>
        {id === "ai" && value === "ai" && <div className="settings-agent-subnav" aria-label="Agent 设置页面">
          {AGENT_PAGES.map(({ id: pageId, label: pageLabel, icon: PageIcon }) => <button type="button" key={pageId} className={agentPage === pageId ? "active" : ""} aria-current={agentPage === pageId ? "page" : undefined} onClick={() => onAgentPageChange(pageId)}><PageIcon size={13} /><span>{pageLabel}</span></button>)}
        </div>}
      </div>)}
    </nav>
  </aside>;
}
