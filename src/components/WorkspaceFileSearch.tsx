import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Binary, CircleAlert, FileCode2, FileImage, FileSpreadsheet, FileText, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { workspaceFilePathEquals } from "../files/filePathIdentity";
import { fileKind, type WorkspaceFileNode } from "../files/fileTypes";
import "./WorkspaceFileSearch.css";

export type WorkspaceFileSearchResponse = {
  results: WorkspaceFileNode[];
  truncated: boolean;
};

export type WorkspaceFileSearchProps = {
  workspaceId: string;
  query: string;
  search: (workspaceId: string, query: string, signal: AbortSignal) => Promise<WorkspaceFileSearchResponse>;
  onFileOpen: (node: WorkspaceFileNode) => void;
  loadedTree: WorkspaceFileNode[];
  selectedPath?: string;
};

type SearchState = WorkspaceFileSearchResponse & {
  workspaceId: string;
  query: string;
  status: "pending" | "ready" | "error";
  error?: string;
};

function SearchFileIcon({ name }: { name: string }) {
  const kind = fileKind(name);
  if (kind === "code") return <FileCode2 size={15} />;
  if (kind === "image") return <FileImage size={15} />;
  if (kind === "table") return <FileSpreadsheet size={15} />;
  if (kind === "binary") return <Binary size={15} />;
  return <FileText size={15} />;
}

export function WorkspaceFileSearch({ workspaceId, query, search, onFileOpen, loadedTree, selectedPath }: WorkspaceFileSearchProps) {
  const normalizedQuery = query.trim();
  const searchRef = useRef(search);
  const [retryVersion, setRetryVersion] = useState(0);
  const [state, setState] = useState<SearchState | null>(null);
  searchRef.current = search;

  const loadedFiles = useMemo(() => {
    const files = new Map<string, WorkspaceFileNode>();
    const visit = (nodes: WorkspaceFileNode[]) => {
      for (const node of nodes) {
        if (node.type === "file") files.set(node.path, node);
        else if (node.children) visit(node.children);
      }
    };
    visit(loadedTree);
    return files;
  }, [loadedTree]);

  useEffect(() => {
    if (!normalizedQuery || !workspaceId) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState({ workspaceId, query: normalizedQuery, status: "pending", results: [], truncated: false });
    const timer = window.setTimeout(() => {
      Promise.resolve()
        .then(() => cancelled || controller.signal.aborted ? null : searchRef.current(workspaceId, normalizedQuery, controller.signal))
        .then((response) => {
          if (!response || cancelled || controller.signal.aborted) return;
          const seen = new Set<string>();
          const results = response.results.filter((node) => {
            if (node.type !== "file" || seen.has(node.path)) return false;
            seen.add(node.path);
            return true;
          });
          setState({ workspaceId, query: normalizedQuery, status: "ready", results, truncated: response.truncated });
        })
        .catch((error: unknown) => {
          if (cancelled || controller.signal.aborted) return;
          setState({ workspaceId, query: normalizedQuery, status: "error", results: [], truncated: false, error: error instanceof Error ? error.message : String(error) });
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [workspaceId, normalizedQuery, retryVersion]);

  if (!normalizedQuery || !workspaceId) return null;
  const current = state?.workspaceId === workspaceId && state.query === normalizedQuery ? state : null;
  const pending = !current || current.status === "pending";
  const focusResult = (event: KeyboardEvent<HTMLButtonElement>) => {
    const list = event.currentTarget.closest(".workspace-file-search__list");
    const buttons = Array.from(list?.querySelectorAll<HTMLButtonElement>("button") || []);
    const index = buttons.indexOf(event.currentTarget);
    let target: number | null = null;
    if (event.key === "ArrowDown") target = Math.min(index + 1, buttons.length - 1);
    else if (event.key === "ArrowUp") target = Math.max(index - 1, 0);
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = buttons.length - 1;
    if (target === null) return;
    event.preventDefault();
    buttons[target]?.focus();
  };

  return <section className="workspace-file-search" aria-label="文件搜索结果" aria-busy={pending}>
    {pending && <div className="workspace-file-search__state" role="status"><LoaderCircle className="workspace-file-search__spinner" size={15} /><span>正在搜索文件</span></div>}
    {current?.status === "error" && <div className="workspace-file-search__error" role="alert">
      <CircleAlert size={15} aria-hidden="true" />
      <span><strong>文件搜索失败</strong><small>{current.error}</small></span>
      <button type="button" aria-label="重试文件搜索" title="重试文件搜索" onClick={() => setRetryVersion((version) => version + 1)}><RefreshCw size={14} /></button>
    </div>}
    {current?.status === "ready" && <>
      {current.results.length > 0 ? <ul className="workspace-file-search__list">{current.results.map((node) => {
        const loaded = loadedFiles.get(node.path);
        const size = node.size ?? loaded?.size;
        const title = size === undefined ? node.path : `${node.path}\n${size.toLocaleString()} bytes`;
        return <li key={node.path}><button
          type="button"
          className={workspaceFilePathEquals(selectedPath, node.path) ? "is-active" : undefined}
          aria-current={workspaceFilePathEquals(selectedPath, node.path) ? "true" : undefined}
          aria-label={`打开 ${node.path}`}
          title={title}
          onClick={() => onFileOpen(node)}
          onKeyDown={focusResult}
        ><SearchFileIcon name={node.name} /><span><strong>{node.name}</strong><small>{node.path}</small></span></button></li>;
      })}</ul> : <div className="workspace-file-search__state" role="status"><Search size={15} aria-hidden="true" /><span>没有匹配的文件</span></div>}
      {current.truncated && <p className="workspace-file-search__limit" role="status">搜索达到范围上限，请使用更具体的文件名或路径。</p>}
    </>}
  </section>;
}

export default WorkspaceFileSearch;
