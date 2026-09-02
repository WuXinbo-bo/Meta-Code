import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bot, Check, FolderOpen, HardDrive, Network, Route, X } from "lucide-react";
import { ProductLogo } from "../branding/ProductLogo";
import "./firstRunGuide.css";

export const CURRENT_GUIDE_VERSION = 1;

type FirstRunGuideProps = {
  connectedAgents: number;
  workspaceCount: number;
  dataHome: string;
  onComplete: () => Promise<void>;
  onSkip: () => Promise<void>;
  onOpenAgentSettings: () => void;
  onAddWorkspace: () => void;
};

const steps = [
  { id: "data", title: "数据保存在你的电脑上", description: "源码、个人配置和项目文件彼此分离。删除或升级程序不会自动删除个人数据。", icon: HardDrive },
  { id: "agent", title: "准备第一个 Agent", description: "复用系统 CLI、指定现有路径，或者安装工作台托管版本，然后完成连接测试。", icon: Bot },
  { id: "workspace", title: "选择任务位置", description: "工作区任务可以读取和修改项目；临时任务不绑定目录，适合咨询和规划。", icon: FolderOpen },
  { id: "delegation", title: "用委派协议完成 Agent 协作", description: "协作模式由主脑拆分任务、调用其他已连接 Agent、跟踪日志并验收结果，最后仍由主脑统一交付。", icon: Network },
  { id: "orchestration", title: "用任务编排管理复杂工作", description: "任务编排会先生成可审查的计划，再按依赖并行执行节点，记录验收条件、交付物和失败重试。", icon: Route }
] as const;

export function FirstRunGuide({ connectedAgents, workspaceCount, dataHome, onComplete, onSkip, onOpenAgentSettings, onAddWorkspace }: FirstRunGuideProps) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shellRef = useRef<HTMLElement>(null);
  const item = steps[step];
  const Icon = item.icon;
  const last = step === steps.length - 1;
  const finish = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    shellRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      void finish(onSkip);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onSkip]);

  return <div className="first-run-layer" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
    <section ref={shellRef} className="first-run-shell" tabIndex={-1}>
      <header><ProductLogo variant="mark" /><span><strong>Meta Code</strong><small>首次使用</small></span><button type="button" aria-label="跳过引导" title="跳过引导" disabled={busy} onClick={() => void finish(onSkip)}><X size={17} /></button></header>
      <div className="first-run-progress" aria-label={`引导进度 ${step + 1}/${steps.length}`}>{steps.map((entry, index) => <span className={index === step ? "active" : index < step ? "done" : ""} key={entry.id}>{index < step ? <Check size={11} /> : index + 1}</span>)}</div>
      <main>
        <div className="first-run-icon"><Icon size={28} /></div>
        <small>第 {step + 1} 步，共 {steps.length} 步</small>
        <h1 id="first-run-title">{item.title}</h1>
        <p>{item.description}</p>
        {item.id === "data" && <div className="first-run-fact"><span>个人数据目录</span><code>{dataHome}</code></div>}
        {item.id === "agent" && <div className="first-run-fact"><span>当前已连接</span><strong>{connectedAgents} 个 Agent</strong><button type="button" onClick={onOpenAgentSettings}>打开 Agent 设置<ArrowRight size={13} /></button></div>}
        {item.id === "workspace" && <div className="first-run-fact"><span>当前工作区</span><strong>{workspaceCount} 个</strong><button type="button" onClick={onAddWorkspace}>添加工作区<ArrowRight size={13} /></button></div>}
        {item.id === "delegation" && <div className="first-run-mode-grid"><span><strong>原生</strong><small>单一 CLI 直接工作</small></span><span><strong>协作</strong><small>主脑拆分、委派并验收</small></span></div>}
        {item.id === "orchestration" && <div className="first-run-mode-grid"><span><strong>计划审查</strong><small>批准后才开始执行</small></span><span><strong>节点交付</strong><small>按依赖运行并逐项验收</small></span></div>}
        {error && <p className="first-run-error" role="alert">{error}</p>}
      </main>
      <footer><button type="button" disabled={step === 0 || busy} onClick={() => setStep((value) => Math.max(0, value - 1))}><ArrowLeft size={14} />上一步</button><button type="button" className="primary" disabled={busy} onClick={() => last ? void finish(onComplete) : setStep((value) => Math.min(steps.length - 1, value + 1))}>{last ? "进入工作台" : "下一步"}<ArrowRight size={14} /></button></footer>
    </section>
  </div>;
}
