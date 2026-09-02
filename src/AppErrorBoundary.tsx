import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Workbench UI render failure", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="splash">
      <strong>界面渲染遇到异常</strong>
      <span>{this.state.error.message || "未知前端错误"}</span>
      <button type="button" className="primary" onClick={() => window.location.reload()}>重新加载工作台</button>
    </main>;
  }
}
