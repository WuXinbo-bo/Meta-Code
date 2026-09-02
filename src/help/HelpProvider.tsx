import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, CircleHelp, X } from "lucide-react";
import { HELP_TOPIC_BY_ID, type HelpTopicId } from "./topics";
import "./help.css";

type HelpContextValue = {
  activeTopicId: HelpTopicId | null;
  openHelp: (topicId: HelpTopicId) => void;
  closeHelp: () => void;
};

const HelpContext = createContext<HelpContextValue | null>(null);

export function HelpProvider({ children }: { children: ReactNode }) {
  const [activeTopicId, setActiveTopicId] = useState<HelpTopicId | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const openHelp = useCallback((topicId: HelpTopicId) => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActiveTopicId(topicId);
  }, []);
  const closeHelp = useCallback(() => {
    setActiveTopicId(null);
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!activeTopicId) return;
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closeHelp(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [activeTopicId, closeHelp]);

  const topic = activeTopicId ? HELP_TOPIC_BY_ID.get(activeTopicId) : undefined;
  return <HelpContext.Provider value={{ activeTopicId, openHelp, closeHelp }}>
    {children}
    {topic && <div className="help-layer">
      <button type="button" className="help-backdrop" aria-label="关闭帮助" onClick={closeHelp} />
      <aside className="help-drawer" role="dialog" aria-modal="true" aria-labelledby="help-drawer-title">
        <header><span><small>{topic.group}</small><strong id="help-drawer-title">{topic.title}</strong></span><button ref={closeRef} type="button" aria-label="关闭帮助" title="关闭" onClick={closeHelp}><X size={17} /></button></header>
        <p className="help-drawer-summary">{topic.summary}</p>
        <div className="help-drawer-sections">{topic.sections.map((section) => <section key={section.title}>
          <h3>{section.title}</h3><p>{section.body}</p>
          {section.steps && <ol>{section.steps.map((step) => <li key={step}><ArrowRight size={13} />{step}</li>)}</ol>}
        </section>)}</div>
      </aside>
    </div>}
  </HelpContext.Provider>;
}

export function useHelp() {
  const value = useContext(HelpContext);
  if (!value) throw new Error("useHelp must be used inside HelpProvider");
  return value;
}

export function HelpButton({ topic, className = "", label }: { topic: HelpTopicId; className?: string; label?: string }) {
  const { openHelp } = useHelp();
  const title = HELP_TOPIC_BY_ID.get(topic)?.title || "帮助";
  return <button type="button" className={`help-trigger ${className}`.trim()} aria-label={`了解${title}`} title={title} onClick={(event) => { event.stopPropagation(); openHelp(topic); }}><CircleHelp size={14} />{label && <span>{label}</span>}</button>;
}
