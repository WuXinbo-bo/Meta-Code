import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

type Props = {
  children: ReactNode;
  resetKey: string;
  title?: string;
};

type State = { error: string };

export class RecoverableSectionBoundary extends Component<Props, State> {
  state: State = { error: "" };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Workbench section render failure", error, info.componentStack);
  }

  componentDidUpdate(previous: Readonly<Props>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: "" });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <section className="recoverable-section-error" role="alert">
      <AlertTriangle size={20} />
      <div><strong>{this.props.title || "此区域暂时无法显示"}</strong><span>异常已被限制在当前区域，其他任务和页面仍可继续使用。</span><small>{this.state.error}</small></div>
      <button type="button" onClick={() => this.setState({ error: "" })}><RefreshCw size={14} />重试</button>
    </section>;
  }
}
