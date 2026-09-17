import { useEffect, useRef, useState } from "react";
import type { PreviewFile } from "../files/fileTypes";
import { DeferredContent } from "./DeferredContent";
import { SafeFileMarkdownBody } from "./SafeFileMarkdownBody";

type Cursor = { offset: number; continuation?: string; nextOffset?: number | null; nextContinuation?: string; characters: number };
function cursorFor(page: PreviewFile, continuation?: string): Cursor {
  return { offset: page.offset || 0, continuation, nextOffset: page.nextOffset, nextContinuation: page.nextContinuation, characters: page.content?.length || 0 };
}
function LoadedBlock({ cursor, getPage, render }: { cursor: Cursor; getPage: (cursor: Cursor, signal: AbortSignal) => Promise<PreviewFile>; render: (page: PreviewFile) => React.ReactNode }) {
  const [content, setContent] = useState<PreviewFile>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void getPage(cursor, controller.signal).then(page => { if (!controller.signal.aborted) { setContent(page); setError(""); } }).catch(reason => { if (!controller.signal.aborted) setError(String(reason.message || reason)); });
    return () => controller.abort();
  }, [cursor.offset, cursor.continuation, retry]);
  return content ? <>{render(content)}</> : error ? <p role="alert">{error} <button onClick={() => setRetry(retry + 1)}>重试读取</button></p> : <p className="continuous-block-loading" role="status">正在加载内容…</p>;
}

/** Transport pages are invisible to readers. Keep only nearby full bodies and
 * lightweight cursors, so scrolling back can reload evicted content. */
export function ContinuousFilePreview({ file, workspaceId, workspaceRoot, onOpenLocalFile, onReload }: {
  file: PreviewFile; workspaceId: string; workspaceRoot: string; onOpenLocalFile: (path: string) => void; onReload?: () => void;
}) {
  const [blocks, setBlocks] = useState<Cursor[]>(() => [cursorFor(file)]);
  const cache = useRef(new Map<string, PreviewFile>([[`${file.offset || 0}:`, file]]));
  const tail = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const last = blocks[blocks.length - 1];
  const getPage = async (cursor: Cursor, signal: AbortSignal) => {
    const key = `${cursor.offset}:${cursor.continuation || ""}`;
    const found = cache.current.get(key);
    if (found) { cache.current.delete(key); cache.current.set(key, found); return found; }
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(file.path)}&offset=${cursor.offset}&continuation=${encodeURIComponent(cursor.continuation || "")}&version=${encodeURIComponent(file.version || "")}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "内容读取失败，请重试");
    if (file.version && data.version !== file.version) throw new Error("文件版本已变化，请重新读取后继续浏览");
    const page = { ...file, ...data } as PreviewFile;
    delete (page as unknown as Record<string, unknown>).rawContent;
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    cache.current.set(key, page);
    let size = [...cache.current.values()].reduce((sum, value) => sum + (value.content?.length || 0), 0);
    while (cache.current.size > 12 || size > 2_000_000) {
      const oldest = cache.current.entries().next().value!;
      size -= oldest[1].content?.length || 0; cache.current.delete(oldest[0]);
    }
    return page;
  };
  const more = async () => {
    if (pending.current || last.nextOffset == null) return;
    pending.current = true; setLoading(true); setError("");
    const controller = new AbortController(); request.current = controller;
    try {
      const page = await getPage({ offset: last.nextOffset, continuation: last.nextContinuation, characters: 0 }, controller.signal);
      if (!controller.signal.aborted) {
        if ((page.offset || 0) <= last.offset) throw new Error("内容位置没有前进，请重新读取文件");
        setBlocks(current => [...current, cursorFor(page, last.nextContinuation)]);
      }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    if (!tail.current || last.nextOffset == null || error) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void more(); }, { rootMargin: "900px 0px" });
    observer.observe(tail.current);
    return () => observer.disconnect();
  }, [last.offset, last.nextOffset, error]);
  useEffect(() => () => request.current?.abort(), []);
  const render = (page: PreviewFile) => page.kind === "markdown" && !page.sourcePage
    ? <SafeFileMarkdownBody text={page.content || ""} markdownPath={file.path} workspaceId={workspaceId} workspaceRoot={workspaceRoot} onOpenLocalFile={onOpenLocalFile} />
    : <pre className="source-preview plain-text">{page.content || ""}</pre>;
  return <div className="continuous-file-preview">
    {blocks.map((cursor, index) => <DeferredContent key={cursor.offset} initial={index === 0} estimate={Math.max(160, Math.min(6000, cursor.characters / 60 * 24))}>
      <LoadedBlock cursor={cursor} getPage={getPage} render={render} />
    </DeferredContent>)}
    <div ref={tail} className="continuous-preview-status" role={error ? "alert" : "status"}>
      {error ? <>{error} <button onClick={() => void more()}>重试加载</button>{onReload && <button onClick={onReload}>重新读取文件</button>}</> : loading ? "正在加载后续内容…" : last.nextOffset == null ? null : "继续向下滚动阅读"}
    </div>
  </div>;
}
