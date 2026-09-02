import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Binary, FolderOpen, LoaderCircle, RefreshCw, X } from "lucide-react";
import hljs from "highlight.js/lib/core";
import pythonLanguage from "highlight.js/lib/languages/python";
import shellLanguage from "highlight.js/lib/languages/shell";
import latexLanguage from "highlight.js/lib/languages/latex";
import jsonLanguage from "highlight.js/lib/languages/json";
import xmlLanguage from "highlight.js/lib/languages/xml";
import javascriptLanguage from "highlight.js/lib/languages/javascript";
import typescriptLanguage from "highlight.js/lib/languages/typescript";
import cssLanguage from "highlight.js/lib/languages/css";
import sqlLanguage from "highlight.js/lib/languages/sql";
import powershellLanguage from "highlight.js/lib/languages/powershell";
import { SafeFileMarkdownBody } from "./SafeFileMarkdownBody";
import { isPreviewFileKind, type PreviewFile } from "../files/fileTypes";

hljs.registerLanguage("python", pythonLanguage);
hljs.registerLanguage("shell", shellLanguage);
hljs.registerLanguage("latex", latexLanguage);
hljs.registerLanguage("json", jsonLanguage);
hljs.registerLanguage("xml", xmlLanguage);
hljs.registerLanguage("javascript", javascriptLanguage);
hljs.registerLanguage("typescript", typescriptLanguage);
hljs.registerLanguage("css", cssLanguage);
hljs.registerLanguage("sql", sqlLanguage);
hljs.registerLanguage("powershell", powershellLanguage);

const PREVIEW_PAGE_HISTORY_LIMIT = 12;

export type FilePreviewProps = {
  file: PreviewFile;
  workspaceId: string;
  workspaceRoot: string;
  presentation?: "modal" | "workspace";
  onOpenLocalFile: (path: string) => void;
  onReveal: (path: string) => void;
  onReload?: () => void;
  onClose: () => void;
};

function formatBytes(value = 0) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function PreviewIconButton({ label, children, onClick }: { label: string; children: React.ReactNode; onClick: () => void }) {
  return <button className="icon-button" title={label} aria-label={label} onClick={onClick}>{children}</button>;
}

async function fetchPreviewPage(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
  return data as Partial<PreviewFile>;
}

function resolvedPreviewKind(value: unknown, fallback: PreviewFile["kind"]) {
  return isPreviewFileKind(value) ? value : fallback;
}

export function FilePreview({ file, workspaceId, workspaceRoot, presentation = "modal", onOpenLocalFile, onReveal, onReload, onClose }: FilePreviewProps) {
  const [activeSheet, setActiveSheet] = useState(0);
  const [pdfObjectUrl, setPdfObjectUrl] = useState("");
  const [pdfError, setPdfError] = useState("");
  const [pdfLoading, setPdfLoading] = useState(false);
  const [imageObjectUrl, setImageObjectUrl] = useState("");
  const [imageError, setImageError] = useState("");
  const [imageLoading, setImageLoading] = useState(false);
  const [page, setPage] = useState(file);
  const [pageHistory, setPageHistory] = useState<PreviewFile[]>([]);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const pageRequestRef = useRef<AbortController | null>(null);
  const pageRequestVersionRef = useRef(0);
  const previewKey = `${workspaceId}:${file.path}:${file.modifiedAt || ""}`;
  useEffect(() => setActiveSheet(0), [file.path]);
  useEffect(() => {
    pageRequestVersionRef.current += 1;
    pageRequestRef.current?.abort();
    pageRequestRef.current = null;
    setPage(file);
    setPageHistory([]);
    setPageError("");
    setPageLoading(false);
  }, [file, previewKey]);
  useEffect(() => () => pageRequestRef.current?.abort(), []);
  useEffect(() => {
    if (file.kind !== "pdf" || !file.url) {
      setPdfObjectUrl("");
      setPdfError("");
      setPdfLoading(false);
      return;
    }
    const controller = new AbortController();
    let objectUrl = "";
    setPdfObjectUrl("");
    setPdfLoading(true);
    setPdfError("");
    fetch(file.url, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `PDF 加载失败（${response.status}）`);
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (!blob.type.toLowerCase().includes("pdf")) throw new Error("服务器未返回 PDF 内容");
        objectUrl = URL.createObjectURL(blob);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = "";
          return;
        }
        setPdfObjectUrl(objectUrl);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setPdfError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPdfLoading(false);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.kind, file.url, previewKey]);
  useEffect(() => {
    if (file.kind !== "image" || !file.url) {
      setImageObjectUrl("");
      setImageError("");
      setImageLoading(false);
      return;
    }
    const controller = new AbortController();
    let objectUrl = "";
    setImageObjectUrl("");
    setImageLoading(true);
    setImageError("");
    fetch(file.url, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `图片加载失败（${response.status}）`);
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (!blob.type.toLowerCase().startsWith("image/")) throw new Error("服务器未返回图片内容");
        objectUrl = URL.createObjectURL(blob);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = "";
          return;
        }
        setImageObjectUrl(objectUrl);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setImageError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setImageLoading(false);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.kind, file.url, previewKey]);
  const highlightedCode = useMemo(() => {
    if (page.kind !== "code" || (page.previewMode !== undefined && page.previewMode !== "full") || !page.content) return "";
    try {
      return page.language && hljs.getLanguage(page.language)
        ? hljs.highlight(page.content, { language: page.language }).value
        : page.content.replace(/[&<>]/g, (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[value] || value));
    } catch {
      return page.content.replace(/[&<>]/g, (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[value] || value));
    }
  }, [page.content, page.kind, page.language, page.previewMode]);
  const sheet = file.sheets?.[activeSheet];
  const loadPreviewPage = async (offset: number) => {
    if (pageLoading) return;
    const requestVersion = ++pageRequestVersionRef.current;
    pageRequestRef.current?.abort();
    const controller = new AbortController();
    pageRequestRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    setPageLoading(true);
    setPageError("");
    try {
      const result = await fetchPreviewPage(`/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(file.path)}&offset=${offset}`, controller.signal);
      if (requestVersion !== pageRequestVersionRef.current) return;
      setPageHistory((current) => [...current.slice(-(PREVIEW_PAGE_HISTORY_LIMIT - 1)), page]);
      setPage({ ...file, ...result, kind: resolvedPreviewKind(result.kind, file.kind) });
    } catch (error) {
      if (requestVersion === pageRequestVersionRef.current && (!controller.signal.aborted || timedOut)) {
        setPageError(timedOut ? "分段内容读取超时，请重试" : error instanceof Error ? error.message : String(error));
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestVersion === pageRequestVersionRef.current) {
        pageRequestRef.current = null;
        setPageLoading(false);
      }
    }
  };
  const previousPreviewPage = () => {
    const previous = pageHistory.at(-1);
    if (!previous) return;
    setPage(previous);
    setPageHistory((current) => current.slice(0, -1));
    setPageError("");
  };
  const paged = page.previewMode === "plain-paged" || page.previewMode === "markdown-paged";
  const richMarkdownPage = page.previewMode === "markdown-paged";
  const fullRichPreview = page.previewMode === undefined || page.previewMode === "full";
  const preview = (
      <section className={`file-preview ${presentation === "workspace" ? "workspace-file-preview" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <strong>{file.name}</strong>
            <span>{file.path}{file.size !== undefined ? ` · ${formatBytes(file.size)}` : ""}</span>
          </div>
          <span className="preview-header-actions">
            {onReload && <PreviewIconButton label="重新读取文件" onClick={onReload}><RefreshCw size={16} /></PreviewIconButton>}
            <PreviewIconButton label="在文件管理器中定位" onClick={() => onReveal(file.path)}><FolderOpen size={17} /></PreviewIconButton>
            <PreviewIconButton label="关闭预览" onClick={onClose}><X size={18} /></PreviewIconButton>
          </span>
        </header>
        <div className={`preview-content ${file.kind}`}>
          {file.kind === "markdown" && (fullRichPreview || richMarkdownPage) && (
            <SafeFileMarkdownBody text={page.content || ""} markdownPath={file.path} workspaceId={workspaceId} workspaceRoot={workspaceRoot} onOpenLocalFile={onOpenLocalFile} />
          )}
          {file.kind === "markdown" && !fullRichPreview && !richMarkdownPage && <div className="paged-text-preview"><p>当前内容无法安全进行富文本渲染，已使用分段纯文本预览。</p><pre>{page.content || ""}</pre></div>}
          {file.kind === "document" && <article className="docx-preview">
            {file.warnings?.length ? <details className="docx-preview-warnings"><summary>部分 Word 格式未完整还原</summary><ul>{file.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></details> : null}
            <div className="docx-document" dangerouslySetInnerHTML={{ __html: file.html || "" }} />
          </article>}
          {file.kind === "pdf" && pdfLoading && <div className="preview-state"><LoaderCircle className="spin" size={20} />正在加载 PDF</div>}
          {file.kind === "pdf" && pdfError && <div className="preview-state error"><Activity size={20} />{pdfError}</div>}
          {file.kind === "pdf" && pdfObjectUrl && <iframe src={pdfObjectUrl} title={file.name} />}
          {file.kind === "image" && imageLoading && <div className="preview-state"><LoaderCircle className="spin" size={20} />正在安全加载图片</div>}
          {file.kind === "image" && imageError && <div className="preview-state error"><Activity size={20} />{imageError}</div>}
          {file.kind === "image" && imageObjectUrl && <img src={imageObjectUrl} alt={file.name} />}
          {file.kind === "table" && (
            <div className="table-preview">
              {(file.sheets?.length || 0) > 1 && <nav className="sheet-tabs" aria-label="工作表">{file.sheets?.map((item, index) => <button className={activeSheet === index ? "active" : ""} onClick={() => setActiveSheet(index)} key={`${item.name}-${index}`}>{item.name}</button>)}</nav>}
              {sheet && <div className="table-scroll"><table><tbody>{sheet.rows.map((row, rowIndex) => <tr key={rowIndex}><th className="row-number">{rowIndex + 1}</th>{row.map((cell, columnIndex) => rowIndex === 0 ? <th key={columnIndex}>{cell}</th> : <td key={columnIndex}>{cell}</td>)}</tr>)}</tbody></table></div>}
              {(sheet?.truncated || file.truncatedSheets) && <p className="preview-limit">为保持流畅，仅显示部分工作表、行或列。原文件不会被修改。</p>}
            </div>
          )}
          {file.kind === "code" && page.previewMode === "full" && <pre className="source-preview"><code className={`hljs language-${page.language || "text"}`} dangerouslySetInnerHTML={{ __html: highlightedCode }} /></pre>}
          {file.kind === "code" && page.previewMode !== "full" && <div className="paged-text-preview"><p>代码文件超过高亮预算，已使用纯文本模式。</p><pre>{page.content || ""}</pre></div>}
          {file.kind === "text" && <pre className="source-preview plain-text"><code>{page.content || ""}</code></pre>}
          {file.kind === "binary" && <div className="binary-preview"><Binary size={34} /><strong>{file.extension?.replace(".", "").toUpperCase() || "二进制文件"}</strong><p>该文件不能作为文本安全展示，已提供轻量文件信息。可由对应的 Python 运行环境或字体工具打开。</p><dl><div><dt>大小</dt><dd>{formatBytes(file.size)}</dd></div><div><dt>路径</dt><dd>{file.path}</dd></div></dl></div>}
          {paged && <div className="preview-page-controls"><span>{formatBytes(page.offset || 0)} - {formatBytes((page.offset || 0) + new Blob([page.content || ""]).size)} / {formatBytes(page.size)}</span><div><button type="button" disabled={!pageHistory.length || pageLoading} onClick={previousPreviewPage}>上一段</button><button type="button" disabled={page.nextOffset == null || pageLoading} onClick={() => void loadPreviewPage(page.nextOffset || 0)}>{pageLoading ? "读取中" : "下一段"}</button></div>{pageError && <small>{pageError}</small>}</div>}
        </div>
      </section>
  );
  if (presentation === "workspace") return preview;
  return <div className="preview-backdrop" onMouseDown={onClose}>{preview}</div>;
}

export default FilePreview;
