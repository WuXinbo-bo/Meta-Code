import { CircleAlert, FolderInput } from "lucide-react";
import { useState } from "react";
import { validateWorkspaceDrop } from "./dropValidation";
import "./workspaceDropZone.css";

type Props = {
  disabled?: boolean;
  onFolder(path: string): void;
};

export function WorkspaceDropZone({ disabled, onFolder }: Props) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  return <div
    className={`workspace-drop-zone ${dragging ? "dragging" : ""} ${disabled ? "disabled" : ""}`}
    onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? "none" : "copy"; }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    }}
    onDrop={(event) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) return;
      const items = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
      const item = items[0];
      const entry = item?.webkitGetAsEntry?.();
      const file = item?.getAsFile();
      const path = file && window.metaCodeDesktop ? window.metaCodeDesktop.getPathForFile(file) : "";
      const result = validateWorkspaceDrop({ itemCount: items.length, isDirectory: Boolean(entry?.isDirectory), path });
      if (!result.ok) return void setError(result.error);
      setError("");
      onFolder(result.path);
    }}
  >
    <FolderInput size={22} aria-hidden="true" />
    <span><strong>拖入文件夹</strong><small>松开后自动识别工作区位置</small></span>
    {error && <p role="alert"><CircleAlert size={13} />{error}</p>}
  </div>;
}
