import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import type { MarkdownBodyProps } from "./MarkdownBody";

/**
 * Keep the markdown renderer (and its sizeable remark/rehype dependencies)
 * out of the application shell.  Conversation and file-preview surfaces can
 * request it on demand while retaining the same props and fallback UI.
 */
const MarkdownBodyRenderer = lazy(() => import("./MarkdownBody"));

function fallbackMarkup(text: string) {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function LazyMarkdownBody(props: MarkdownBodyProps) {
  const fallback = <div className="markdown-planning" role="status" aria-label="正在准备 Markdown 预览">
    <LoaderCircle className="spin" size={15} />
    <span dangerouslySetInnerHTML={{ __html: fallbackMarkup(props.text) }} />
  </div>;
  return <Suspense fallback={fallback}>
    <MarkdownBodyRenderer {...props} />
  </Suspense>;
}

export type { MarkdownBodyProps };

export default LazyMarkdownBody;
