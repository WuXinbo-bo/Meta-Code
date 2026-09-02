import { isValidElement, memo, useEffect, useId, useMemo, useRef, useState, type ComponentProps } from "react";
import { CircleAlert, Check, Copy, Info, Lightbulb, LoaderCircle, ShieldAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import {
  MARKDOWN_MERMAID_CHAR_BUDGET,
  MARKDOWN_PLAIN_CHAR_BUDGET,
  MARKDOWN_RICH_CHAR_BUDGET,
  markdownRenderPlan,
  type MarkdownRenderPlan
} from "../markdown/markdownPlan";
import { planMarkdownRender } from "../markdown/markdownWorkerClient";
import { remarkWorkbench } from "../markdown/remarkWorkbench";
import "../design/document-preview.css";

export type MarkdownBodyProps = {
  text: string;
  markdownPath?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  onOpenLocalFile?: (path: string) => void;
  additionalRehypePlugins?: ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
};

function nodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return nodeText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = nodeText(children).replace(/\n$/, "");
  return (
    <div className="code-block">
      <button
        className="copy-code"
        title="复制代码"
        aria-label="复制代码"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

let mermaidRenderQueue: Promise<unknown> = Promise.resolve();

function enqueueMermaidRender<T>(task: () => Promise<T>) {
  const result = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = result.catch(() => undefined);
  return result;
}

function MermaidDiagram({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let idleCallback: number | undefined;
    let timer: number | undefined;
    const render = () => enqueueMermaidRender(async () => {
      if (cancelled) return;
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
      return mermaid.render(`mermaid-${id}`, chart);
    }).then((rendered) => {
      if (!rendered) return;
      const { svg, bindFunctions } = rendered;
      if (cancelled || !containerRef.current) return;
      containerRef.current.innerHTML = svg;
      bindFunctions?.(containerRef.current);
      setError("");
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    if (chart.length > MARKDOWN_MERMAID_CHAR_BUDGET) setError("Mermaid 图表超过安全渲染预算");
    else if (typeof window.requestIdleCallback === "function") idleCallback = window.requestIdleCallback(() => void render(), { timeout: 500 });
    else timer = window.setTimeout(() => void render(), 16);
    return () => {
      cancelled = true;
      if (idleCallback !== undefined) window.cancelIdleCallback(idleCallback);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [chart, id]);
  if (error) return <pre className="mermaid-error">{error}\n{chart.slice(0, MARKDOWN_MERMAID_CHAR_BUDGET)}</pre>;
  return <div className="mermaid-diagram" ref={containerRef} />;
}

export function markdownUrlTransform(url: string) {
  if (/^\/\//.test(url)) return `https:${url}`;
  if (/^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i.test(url)) return url;
  if (/^(?:https?:|mailto:|tel:|#|[a-zA-Z]:[\\/]|\.{0,2}[\\/])/i.test(url)) return url;
  return url.includes(":") ? "" : url;
}

export function workspaceRelativePath(source: string | undefined, workspaceRoot?: string, markdownPath?: string) {
  if (!source || !workspaceRoot || /^(?:https?:|mailto:|tel:|#|data:|\/\/)/i.test(source)) return null;
  let cleanSource = source.split(/[?#]/, 1)[0].replace(/^file:\/{2,3}/i, "").replaceAll("\\", "/");
  try {
    cleanSource = decodeURIComponent(cleanSource);
  } catch {
    // Keep literal percent characters unchanged.
  }
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const absolute = /^[a-zA-Z]:\//.test(cleanSource);
  let relative = cleanSource;
  if (absolute) {
    const lowerSource = cleanSource.toLowerCase();
    const lowerRoot = normalizedRoot.toLowerCase();
    if (lowerSource !== lowerRoot && !lowerSource.startsWith(`${lowerRoot}/`)) return null;
    relative = cleanSource.slice(normalizedRoot.length).replace(/^\//, "");
  }
  const baseParts = absolute || !markdownPath
    ? []
    : markdownPath.replaceAll("\\", "/").split("/").slice(0, -1);
  let escapedRoot = false;
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!baseParts.length) escapedRoot = true;
      else baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return escapedRoot ? null : baseParts.join("\\");
}

function resolveMarkdownAsset(source: string | undefined, markdownPath?: string, workspaceId?: string, workspaceRoot?: string) {
  const relativePath = workspaceRelativePath(source, workspaceRoot, markdownPath);
  if (!relativePath || !workspaceId) return source;
  return `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(relativePath)}`;
}

const MARKDOWN_ALERT_DETAILS: Record<string, { label: string; icon: LucideIcon }> = {
  note: { label: "Note", icon: Info },
  tip: { label: "Tip", icon: Lightbulb },
  important: { label: "Important", icon: CircleAlert },
  warning: { label: "Warning", icon: TriangleAlert },
  caution: { label: "Caution", icon: ShieldAlert }
};

function MarkdownHeading({ level, children, ...props }: React.HTMLAttributes<HTMLHeadingElement> & { level: 1 | 2 | 3 | 4 | 5 | 6 }) {
  const Heading = `h${level}` as React.ElementType;
  const id = typeof props.id === "string" ? props.id : undefined;
  return <Heading {...props}>
    {id && <a className="markdown-heading-anchor" href={`#${encodeURIComponent(id)}`} aria-label={`链接到标题：${nodeText(children)}`}><span aria-hidden="true">#</span></a>}
    {children}
  </Heading>;
}

type MarkdownBlockquoteProps = React.BlockquoteHTMLAttributes<HTMLQuoteElement> & {
  "data-markdown-alert"?: string;
};

function MarkdownBlockquote({ children, "data-markdown-alert": alertType, className, ...props }: MarkdownBlockquoteProps) {
  const detail = alertType ? MARKDOWN_ALERT_DETAILS[alertType] : undefined;
  if (!detail) return <blockquote {...props} className={className}>{children}</blockquote>;
  const Icon = detail.icon;
  return <aside {...props} className={className} data-markdown-alert={alertType} role="note">
    <div className="markdown-alert-title"><Icon aria-hidden="true" size={15} /><span>{detail.label}</span></div>
    <div className="markdown-alert-content">{children}</div>
  </aside>;
}

function isLocalMarkdownLink(href: string) {
  return !/^(?:https?:|mailto:|tel:|#|data:|\/\/)/i.test(href);
}

const MARKDOWN_SYNC_PLAN_BUDGET = 12_000;

function immediateMarkdownPlan(source: string): MarkdownRenderPlan | null {
  if (source.length <= MARKDOWN_SYNC_PLAN_BUDGET || source.length > MARKDOWN_RICH_CHAR_BUDGET) {
    return markdownRenderPlan(source);
  }
  return null;
}

export const MarkdownBody = memo(function MarkdownBody({
  text,
  markdownPath,
  workspaceId,
  workspaceRoot,
  onOpenLocalFile,
  additionalRehypePlugins
}: MarkdownBodyProps) {
  const immediatePlan = useMemo(() => immediateMarkdownPlan(text), [text]);
  const [planned, setPlanned] = useState<{ source: string; plan: MarkdownRenderPlan | null }>(() => ({ source: text, plan: immediatePlan }));
  const plan = planned.source === text ? planned.plan : immediatePlan;

  useEffect(() => {
    if (immediatePlan) {
      setPlanned((current) => current.source === text && current.plan === immediatePlan ? current : { source: text, plan: immediatePlan });
      return;
    }
    const controller = new AbortController();
    setPlanned((current) => current.source === text ? current : { source: text, plan: null });
    void planMarkdownRender(text, { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setPlanned({ source: text, plan: next });
    }).catch((error) => {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
      setPlanned({
        source: text,
        plan: {
          mode: "plain",
          text: text.slice(0, MARKDOWN_PLAIN_CHAR_BUDGET),
          truncated: text.length > MARKDOWN_PLAIN_CHAR_BUDGET,
          highlight: false,
          math: false
        }
      });
    });
    return () => controller.abort();
  }, [immediatePlan, text]);

  if (!plan) return <div className="markdown-planning"><LoaderCircle className="spin" size={15} /><span>正在准备内容预览</span></div>;
  if (plan.mode === "plain") return <div className="markdown-safe-fallback">
    <p>内容规模超出富文本安全预算，已切换为纯文本预览。</p>
    <pre>{plan.text}</pre>
    {plan.truncated && <small>当前视图仅显示前 {MARKDOWN_PLAIN_CHAR_BUDGET.toLocaleString()} 个字符。</small>}
  </div>;
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={plan.math
          ? [remarkGfm, remarkMath, ...(markdownPath ? [remarkWorkbench] : []), remarkBreaks]
          : [remarkGfm, ...(markdownPath ? [remarkWorkbench] : []), remarkBreaks]}
        rehypePlugins={[
          ...(additionalRehypePlugins || []),
          ...(plan.math ? [rehypeKatex] : []),
          ...(plan.highlight ? [rehypeHighlight] : [])
        ]}
        urlTransform={markdownUrlTransform}
        components={{
          h1: ({ node: _node, ...props }) => <MarkdownHeading level={1} {...props} />,
          h2: ({ node: _node, ...props }) => <MarkdownHeading level={2} {...props} />,
          h3: ({ node: _node, ...props }) => <MarkdownHeading level={3} {...props} />,
          h4: ({ node: _node, ...props }) => <MarkdownHeading level={4} {...props} />,
          h5: ({ node: _node, ...props }) => <MarkdownHeading level={5} {...props} />,
          h6: ({ node: _node, ...props }) => <MarkdownHeading level={6} {...props} />,
          pre: ({ children }) => {
            const child = isValidElement<{ className?: string; children?: React.ReactNode }>(children) ? children : null;
            if (child?.props.className?.split(" ").includes("language-mermaid")) {
              return <MermaidDiagram chart={nodeText(child.props.children).replace(/\n$/, "")} />;
            }
            return <CodeBlock>{children}</CodeBlock>;
          },
          blockquote: ({ node: _node, ...props }) => <MarkdownBlockquote {...props} />,
          table: ({ node: _node, children, ...props }) => (
            <div className="markdown-table-scroll" role="region" aria-label="Markdown 表格" tabIndex={0}>
              <table {...props}>{children}</table>
            </div>
          ),
          input: ({ node: _node, type, checked, ...props }) => type === "checkbox"
            ? <input {...props} type="checkbox" checked={checked} disabled aria-label={checked ? "已完成" : "未完成"} />
            : <input {...props} type={type} />,
          a: ({ children, href, ...props }) => {
            if (!href) return <span>{children}</span>;
            const localPath = workspaceRelativePath(href, workspaceRoot, markdownPath);
            if (localPath && onOpenLocalFile) {
              return <a {...props} href="#" onClick={(event) => {
                event.preventDefault();
                onOpenLocalFile(localPath);
              }}>{children}</a>;
            }
            if (href.startsWith("#") || /^(?:mailto:|tel:)/i.test(href)) return <a {...props} href={href}>{children}</a>;
            if (isLocalMarkdownLink(href) && onOpenLocalFile) {
              return <span className="markdown-link-unavailable" title="链接位于当前工作区之外">{children}</span>;
            }
            if (/^data:/i.test(href)) return <span>{children}</span>;
            return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
          },
          img: ({ src, alt, ...props }) => <img {...props} src={resolveMarkdownAsset(src, markdownPath, workspaceId, workspaceRoot)} alt={alt || ""} loading="lazy" />
        }}
      >
        {plan.text}
      </ReactMarkdown>
    </div>
  );
}, (previous, next) =>
  previous.text === next.text &&
  previous.markdownPath === next.markdownPath &&
  previous.workspaceId === next.workspaceId &&
  previous.workspaceRoot === next.workspaceRoot &&
  previous.additionalRehypePlugins === next.additionalRehypePlugins
);

export default MarkdownBody;
