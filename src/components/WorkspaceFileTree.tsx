import { useEffect, useState, type ReactNode } from "react";
import { Binary, Copy, File, FileCode2, FileImage, FileSpreadsheet, FileText, Folder, FolderOpen, Trash2 } from "lucide-react";
import { workspaceFilePathEquals } from "../files/filePathIdentity";
import { fileKind, type WorkspaceFileNode } from "../files/fileTypes";

export type WorkspaceFileTreeProps = {
  workspaceId: string;
  nodes: WorkspaceFileNode[];
  query: string;
  selectedPath?: string;
  onFileOpen: (node: WorkspaceFileNode, options?: { pinned?: boolean }) => void | Promise<void>;
  onDirectoryOpen: (node: WorkspaceFileNode) => void | Promise<void>;
  onMove: (paths: string[], targetDirectory: string) => unknown | Promise<unknown>;
  onCopyPaths: (paths: string[]) => unknown | Promise<unknown>;
  onDelete: (paths: string[]) => unknown | Promise<unknown>;
};

export function WorkspaceFileTree({ workspaceId, nodes, query, selectedPath, onFileOpen, onDirectoryOpen, onMove, onCopyPaths, onDelete }: WorkspaceFileTreeProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => { setOpen({}); setSelected([]); }, [workspaceId]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = (node: WorkspaceFileNode): boolean => !normalizedQuery || node.name.toLocaleLowerCase().includes(normalizedQuery) || node.path.toLocaleLowerCase().includes(normalizedQuery) || (node.children || []).some(visible);
  const choose = (path: string, additive: boolean) => setSelected((current) => additive ? current.includes(path) ? current.filter((item) => item !== path) : [...current, path] : [path]);
  const renderNodes = (items: WorkspaceFileNode[], level: number): ReactNode => items.filter(visible).map((node) => {
    const expanded = normalizedQuery ? true : Boolean(open[node.path]);
    const chosen = selected.includes(node.path);
    const kind = node.type === "file" ? fileKind(node.name) : null;
    const fileIcon = kind === "markdown" || kind === "document" || kind === "text" ? <FileText size={15} /> : kind === "image" ? <FileImage size={15} /> : kind === "table" ? <FileSpreadsheet size={15} /> : kind === "code" ? <FileCode2 size={15} /> : kind === "binary" ? <Binary size={15} /> : <File size={15} />;
    return <div className="workspace-tree-node" key={node.path}>
      <div
        className={`tree-row ${chosen ? "selected" : ""} ${workspaceFilePathEquals(selectedPath, node.path) ? "previewing" : ""}`}
        style={{ paddingLeft: 8 + level * 14 }}
        title={node.path}
        draggable
        onDragStart={(event) => { const paths = chosen ? selected : [node.path]; event.dataTransfer.setData("application/x-workbench-files", JSON.stringify(paths)); event.dataTransfer.effectAllowed = "move"; }}
        onDragOver={(event) => { if (node.type === "directory") event.preventDefault(); }}
        onDrop={(event) => { if (node.type !== "directory") return; event.preventDefault(); try { const paths = JSON.parse(event.dataTransfer.getData("application/x-workbench-files") || "[]"); if (Array.isArray(paths) && paths.length) void onMove(paths, node.path); } catch { /* Ignore invalid external drags. */ } }}
        onContextMenu={(event) => { event.preventDefault(); choose(node.path, event.ctrlKey || event.metaKey); }}
      >
        <button type="button" className="tree-row-main" onClick={(event) => {
          choose(node.path, event.ctrlKey || event.metaKey);
          if (event.ctrlKey || event.metaKey) return;
          if (event.detail > 1) return;
          if (node.type === "file") { void onFileOpen(node); return; }
          setOpen((current) => ({ ...current, [node.path]: !current[node.path] }));
          if (!node.childrenLoaded) void onDirectoryOpen(node);
        }} onDoubleClick={() => { if (node.type === "file") void onFileOpen(node, { pinned: true }); }}>{node.type === "directory" ? expanded ? <FolderOpen size={15} /> : <Folder size={15} /> : fileIcon}<span>{node.name}</span></button>
        {chosen && <span className="tree-row-actions"><button type="button" title="复制路径" aria-label={`复制 ${node.name} 的路径`} onClick={() => void onCopyPaths(selected.includes(node.path) ? selected : [node.path])}><Copy size={12} /></button><button type="button" title="删除" aria-label={`删除 ${node.name}`} onClick={() => void onDelete(selected.includes(node.path) ? selected : [node.path])}><Trash2 size={12} /></button></span>}
      </div>
      {node.type === "directory" && expanded && node.children && <div>{renderNodes(node.children, level + 1)}</div>}
    </div>;
  });
  return <div className="file-tree-shell workspace-file-tree" role="tree" aria-label="工作区文件">{renderNodes(nodes, 0)}</div>;
}

export default WorkspaceFileTree;
