import { useMemo, useState } from "react";
import { ArrowRight, BookOpen, RotateCcw, Search } from "lucide-react";
import { HELP_TOPICS } from "./topics";
import { useHelp } from "./HelpProvider";

export function HelpCenter() {
  const [query, setQuery] = useState("");
  const { openHelp } = useHelp();
  const topics = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return HELP_TOPICS;
    return HELP_TOPICS.filter((topic) => [topic.title, topic.summary, topic.group, ...topic.sections.flatMap((section) => [section.title, section.body])].join(" ").toLocaleLowerCase().includes(normalized));
  }, [query]);
  const groups = [...new Set(topics.map((topic) => topic.group))];
  return <div className="settings-section help-center">
    <div className="settings-page-heading"><h2>帮助与入门</h2><p>查找工作台概念、配置边界和常用操作说明。</p></div>
    <button type="button" className="help-center-reopen" onClick={() => window.dispatchEvent(new Event("metacode:open-guide"))}><RotateCcw size={14} />重新查看首次引导</button>
    <label className="help-center-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索委派、CLI、Skill、数据等" aria-label="搜索帮助" /></label>
    <div className="help-center-groups">{groups.map((group) => <section key={group}><header><BookOpen size={16} /><strong>{group}</strong></header><div>{topics.filter((topic) => topic.group === group).map((topic) => <button type="button" key={topic.id} onClick={() => openHelp(topic.id)}><span><strong>{topic.title}</strong><small>{topic.summary}</small></span><ArrowRight size={14} /></button>)}</div></section>)}</div>
    {!topics.length && <p className="help-center-empty">没有匹配的说明。</p>}
  </div>;
}
