import fsp from "node:fs/promises";

export const DEFAULT_MARKDOWN_PREVIEW_PAGE_BYTES = 96 * 1024;
export const DEFAULT_MARKDOWN_PREVIEW_MAX_BYTES = 112 * 1024;
export const DEFAULT_MARKDOWN_PREVIEW_MAX_LINES = 2400;
export const DEFAULT_MARKDOWN_PREVIEW_MAX_PIPE_LINES = 450;
const ATOMIC_MATH_BYTES = 2 * 1024 * 1024;

type Continuation = { kind: "fence" | "table" | "math" | "line"; marker: string; header?: string };
export type MarkdownPreviewOptions = {
  pageBytes?: number; maxPageBytes?: number; maxLines?: number; maxPipeLines?: number;
  maxTableRows?: number; readChunkBytes?: number; continuation?: string; version?: string;
};
export type MarkdownPreviewPage = {
  content: string; rawContent: string; offset: number; endOffset: number; nextOffset: number | null;
  truncated: boolean; nextContinuation?: string; sourcePage?: boolean; version: string;
};
export function previewFileVersion(stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number }) {
  return `${stat.size}-${stat.mtimeMs}-${stat.ctimeMs}-${stat.ino}`;
}
function changed() { return new Error("文件已发生变化，请重新读取后继续浏览。旧页面仍保留，未混入新版本内容。"); }
function decodeContinuation(value?: string): Continuation | undefined {
  if (!value) return;
  if (value.length > 16_000) throw new Error("分页游标无效，请重新读取文件");
  const c = JSON.parse(Buffer.from(value, "base64url").toString()) as Continuation;
  if (!["fence", "table", "math", "line"].includes(c.kind) || typeof c.marker !== "string" || c.marker.length > 1000 || (c.header && (typeof c.header !== "string" || c.header.length > 8000))) throw new Error("分页游标无效，请重新读取文件");
  return c;
}
function byteEnd(text: string, limit: number) {
  let bytes = 0, chars = 0;
  for (const char of text) { const size = Buffer.byteLength(char); if (bytes + size > limit) break; bytes += size; chars += char.length; }
  return chars;
}
function fence(line: string) { return line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)/); }
function closeFence(line: string, marker: string) {
  const match = line.match(/^ {0,3}(`+|~+)\s*$/);
  return !!match && match[1][0] === marker[0] && match[1].length >= marker.length;
}
function tableDelimiter(line: string) { return /^\s*\|?\s*:?-+:?\s*\|[\s|:\-]*$/.test(line); }

/** Bounded reads with explicit continuation. rawContent concatenates to the exact original bytes. */
export async function readMarkdownPreviewPage(target: string, _size: number, requestedOffset: number, options: MarkdownPreviewOptions = {}): Promise<MarkdownPreviewPage> {
  const handle = await fsp.open(target, "r");
  try {
    const before = await handle.stat();
    const version = previewFileVersion(before);
    if (options.version && options.version !== version) throw changed();
    const offset = Math.max(0, Math.min(before.size, Math.floor(Number.isFinite(requestedOffset) ? requestedOffset : 0)));
    const budget = Math.max(32, Math.min(DEFAULT_MARKDOWN_PREVIEW_MAX_BYTES, options.pageBytes || DEFAULT_MARKDOWN_PREVIEW_PAGE_BYTES));
    const maxBytes = Math.max(budget, Math.min(DEFAULT_MARKDOWN_PREVIEW_MAX_BYTES, options.maxPageBytes || DEFAULT_MARKDOWN_PREVIEW_MAX_BYTES));
    const maxLines = Math.max(1, options.maxLines || DEFAULT_MARKDOWN_PREVIEW_MAX_LINES);
    const tableRows = Math.max(3, options.maxTableRows || 100);
    const buffer = Buffer.alloc(Math.min(ATOMIC_MATH_BYTES + 4, before.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let safeBytes = bytesRead;
    if (offset + bytesRead < before.size) {
      while (safeBytes > 0 && (buffer[safeBytes - 1] & 0xc0) === 0x80) safeBytes--;
      if (safeBytes < bytesRead || buffer[safeBytes - 1] >= 0xc0) safeBytes--;
    }
    const source = buffer.subarray(0, Math.max(0, safeBytes)).toString("utf8");
    const lines = source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || [];
    const starts: number[] = []; let position = 0;
    for (const line of lines) { starts.push(position); position += line.length; }
    let current = decodeContinuation(options.continuation);
    let next: Continuation | undefined;
    let consumed = 0;
    let rendered = "";
    let sourcePage = false;
    for (let i = 0; i < lines.length;) {
      const start = starts[i];
      const opener = !current ? fence(lines[i]) : null;
      const math = !current && (/^\s*\$\$\s*$/.test(lines[i]) ? "$$" : /^\s*\\\[\s*$/.test(lines[i]) ? "\\]" : "");
      const isTable = !current && i + 1 < lines.length && lines[i].includes("|") && tableDelimiter(lines[i + 1]);
      const state: Continuation | undefined = current || (opener ? { kind: "fence", marker: opener[1], header: lines[i] } : math ? { kind: "math", marker: math } : isTable ? { kind: "table", marker: "", header: lines[i] + lines[i + 1] } : undefined);
      let endLine = i + 1;
      let complete = true;
      if (state?.kind === "fence" || state?.kind === "math") {
        const firstContent = current ? i : i + 1;
        endLine = firstContent;
        while (endLine < lines.length && !(state.kind === "fence" ? closeFence(lines[endLine], state.marker) : lines[endLine].trim() === state.marker)) endLine++;
        complete = endLine < lines.length;
        if (complete) endLine++;
      } else if (state?.kind === "table") {
        endLine = current ? i : i + 2;
        while (endLine < lines.length && lines[endLine].trim() && lines[endLine].includes("|")) endLine++;
        complete = endLine < lines.length || offset + safeBytes === before.size;
      }
      const end = starts[endLine] ?? source.length;
      const whole = source.slice(start, end);
      const length = Buffer.byteLength(whole);
      if (rendered && (Buffer.byteLength(source.slice(0, end)) > budget || endLine > maxLines)) break;
      const atomicMath = state?.kind === "math" && !current && complete && length <= ATOMIC_MATH_BYTES;
      const atomicLine = !state && length <= ATOMIC_MATH_BYTES && (whole.endsWith("\n") || offset + safeBytes === before.size);
      const needsSplit = !atomicMath && !atomicLine && (length > maxBytes || endLine - i > (state?.kind === "table" ? tableRows : maxLines) || !complete);
      if (needsSplit || current?.kind === "line" || current?.kind === "math") {
        if (rendered) break;
        let cut = byteEnd(whole, budget);
        const newline = whole.lastIndexOf("\n", Math.max(0, cut - 1));
        if (newline > 0) cut = newline + 1;
        const rowLimit = state?.kind === "table" ? tableRows : maxLines;
        const rowEnd = starts[Math.min(endLine, i + rowLimit)];
        if (rowEnd !== undefined && rowEnd > start) cut = Math.min(cut, rowEnd - start);
        if (current?.kind === "line") cut = Math.min(cut, lines[i].length);
        cut = Math.max(1, cut);
        const part = whole.slice(0, cut);
        const done = cut === whole.length && complete;
        consumed = start + cut;
        // Extremely large single formula/line remains available as contiguous source pages.
        sourcePage = !state || state.kind === "math" || state.kind === "line";
        if (sourcePage) rendered = part;
        else if (state?.kind === "fence") rendered = (current ? state.header || `${state.marker}\n` : "") + part + (done ? "" : `\n${state.marker}\n`);
        else rendered = (current ? state?.header || "" : "") + part;
        if (!done) next = state || { kind: "line", marker: "" };
        break;
      }
      rendered += (current && state?.kind === "fence" ? state.header || `${state.marker}\n` : current && state?.kind === "table" ? state.header || "" : "") + whole;
      consumed = end; i = endLine; current = undefined;
      if (Buffer.byteLength(source.slice(0, consumed)) >= budget || i >= maxLines) break;
    }
    const rawContent = source.slice(0, consumed);
    const endOffset = offset + Buffer.byteLength(rawContent);
    if (endOffset === offset && offset < before.size) throw new Error("无法继续读取文件，请重新读取");
    if (previewFileVersion(await handle.stat()) !== version || previewFileVersion(await fsp.stat(target)) !== version) throw changed();
    return { content: rendered, rawContent, offset, endOffset, nextOffset: endOffset < before.size ? endOffset : null,
      truncated: offset > 0 || endOffset < before.size, version, sourcePage,
      ...(next && endOffset < before.size ? { nextContinuation: Buffer.from(JSON.stringify(next)).toString("base64url") } : {}) };
  } finally { await handle.close(); }
}
