import { Layers3, PanelLeft, RotateCcw, Sparkles } from "lucide-react";
import {
  WORKSPACE_BROWSER_TAB_LIMIT_OPTIONS,
  type WorkspaceBrowserPreferences
} from "./pagePreferences";

type PageSettingsProps = {
  value: WorkspaceBrowserPreferences;
  onChange: (value: WorkspaceBrowserPreferences) => void;
  onResetTabs: () => void;
  onResetLayout: () => void;
};

export function PageSettings({ value, onChange, onResetTabs, onResetLayout }: PageSettingsProps) {
  const update = <K extends keyof WorkspaceBrowserPreferences>(key: K, next: WorkspaceBrowserPreferences[K]) => {
    onChange({ ...value, [key]: next });
  };
  return <div className="settings-section page-settings">
    <div className="settings-page-heading">
      <h2>页面与标签</h2>
      <p>管理工作区页面的打开方式、恢复行为和交互动画。</p>
    </div>
    <section className="page-settings-group">
      <header><Layers3 size={17} /><div><strong>标签管理</strong><span>控制同时保留的页面数量与文件打开方式。</span></div></header>
      <div className="page-settings-row">
        <label htmlFor="page-settings-limit"><strong>同时打开的页面</strong><span>超过上限时自动关闭最久未使用且未固定的页面。</span></label>
        <select id="page-settings-limit" value={value.maxTabs} onChange={(event) => update("maxTabs", Number(event.target.value))}>
          {WORKSPACE_BROWSER_TAB_LIMIT_OPTIONS.map((limit) => <option value={limit} key={limit}>{limit} 个</option>)}
        </select>
      </div>
      <div className="page-settings-row">
        <label htmlFor="page-settings-file-mode"><strong>单击文件</strong><span>临时预览复用一个页面；固定打开会保留每个文件页面。</span></label>
        <select id="page-settings-file-mode" value={value.fileOpenMode} onChange={(event) => update("fileOpenMode", event.target.value as WorkspaceBrowserPreferences["fileOpenMode"])}>
          <option value="preview">临时预览</option>
          <option value="persistent">固定打开</option>
        </select>
      </div>
    </section>
    <section className="page-settings-group">
      <header><Sparkles size={17} /><div><strong>恢复与动画</strong><span>控制再次启动工作台时的页面状态和标签动效。</span></div></header>
      <div className="page-settings-row">
        <label htmlFor="page-settings-restore"><strong>恢复上次页面</strong><span>重新打开工作台时恢复仍然有效的页面和顺序。</span></label>
        <button id="page-settings-restore" type="button" className="settings-switch" role="switch" aria-checked={value.restoreTabs} onClick={() => update("restoreTabs", !value.restoreTabs)}><span /></button>
      </div>
      <div className="page-settings-row">
        <label htmlFor="page-settings-motion"><strong>标签动画</strong><span>完整模式保留拖拽、让位与回弹；精简模式关闭位移动画。</span></label>
        <select id="page-settings-motion" value={value.tabMotion} onChange={(event) => update("tabMotion", event.target.value as WorkspaceBrowserPreferences["tabMotion"])}>
          <option value="system">跟随系统</option>
          <option value="full">完整</option>
          <option value="reduced">精简</option>
        </select>
      </div>
    </section>
    <section className="page-settings-group page-settings-actions">
      <header><PanelLeft size={17} /><div><strong>页面状态</strong><span>只重置本机界面，不会删除任务、文件或对话。</span></div></header>
      <div>
        <button type="button" onClick={onResetTabs}><RotateCcw size={14} />关闭全部页面</button>
        <button type="button" onClick={onResetLayout}><RotateCcw size={14} />恢复默认栏宽</button>
      </div>
    </section>
  </div>;
}
