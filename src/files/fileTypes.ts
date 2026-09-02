export type WorkspaceFileNode = {
  name: string;
  path: string;
  type: "directory" | "file";
  size?: number;
  modifiedAt?: string;
  children?: WorkspaceFileNode[];
  childrenLoaded?: boolean;
  hasChildren?: boolean;
};

export type PreviewSheet = {
  name: string;
  rows: string[][];
  totalRows: number;
  truncated: boolean;
};

export type PreviewFile = WorkspaceFileNode & {
  kind: "markdown" | "document" | "pdf" | "image" | "table" | "code" | "text" | "binary";
  content?: string;
  html?: string;
  warnings?: string[];
  url?: string;
  language?: string;
  sheets?: PreviewSheet[];
  truncatedSheets?: boolean;
  extension?: string;
  workspaceRoot?: string;
  previewMode?: "full" | "plain" | "plain-paged" | "markdown-paged" | "bounded-table" | "document-html";
  offset?: number;
  nextOffset?: number | null;
  truncated?: boolean;
};

const PREVIEW_FILE_KIND_SET = new Set<PreviewFile["kind"]>(["markdown", "document", "pdf", "image", "table", "code", "text", "binary"]);

export function isPreviewFileKind(value: unknown): value is PreviewFile["kind"] {
  return typeof value === "string" && PREVIEW_FILE_KIND_SET.has(value as PreviewFile["kind"]);
}

export function fileKind(name: string): PreviewFile["kind"] | null {
  const extension = name.split(".").pop()?.toLowerCase() || "";
  if (["md", "markdown", "mdown"].includes(extension)) return "markdown";
  if (extension === "docx") return "document";
  if (extension === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) return "image";
  if (["xlsx", "csv"].includes(extension)) return "table";
  if (["py", "sh", "bash", "zsh", "ps1", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "less", "html", "htm", "xml", "tex", "bib", "cls", "json", "geojson", "jsonl", "drawio", "sql"].includes(extension)) return "code";
  if (["txt", "log", "aux", "toc", "out", "bbl", "blg", "bak", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties"].includes(extension)) return "text";
  return "binary";
}
