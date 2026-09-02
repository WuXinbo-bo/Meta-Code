import fsp, { type FileHandle } from "node:fs/promises";

export const DEFAULT_MARKDOWN_PREVIEW_PAGE_BYTES = 96 * 1024;
export const DEFAULT_MARKDOWN_PREVIEW_MAX_BYTES = 112 * 1024;
export const DEFAULT_MARKDOWN_PREVIEW_MAX_LINES = 2_400;
export const DEFAULT_MARKDOWN_PREVIEW_MAX_PIPE_LINES = 450;

const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;

export type MarkdownPreviewStructureKind = "fence" | "math" | "table" | "line";

export type MarkdownPreviewOmission = {
  kind: MarkdownPreviewStructureKind;
  offset: number;
  endOffset: number;
  byteLength: number;
  lineCount: number;
  reason: "byte-budget" | "line-budget" | "table-row-budget" | "pipe-line-budget";
};

export type MarkdownPreviewPage = {
  content: string;
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
  omittedStructures?: MarkdownPreviewOmission[];
};

export type MarkdownPreviewOptions = {
  pageBytes?: number;
  maxPageBytes?: number;
  maxLines?: number;
  maxPipeLines?: number;
  maxTableRows?: number;
  readChunkBytes?: number;
};

type ResolvedMarkdownPreviewOptions = {
  pageBytes: number;
  maxPageBytes: number;
  maxLines: number;
  maxPipeLines: number;
  maxTableRows: number;
  readChunkBytes: number;
};

type MarkdownLine = {
  start: number;
  end: number;
  captured: Buffer;
  text: string;
  hasPipe: boolean;
};

type MarkdownBlock = {
  kind: MarkdownPreviewStructureKind;
  start: number;
  end: number;
  bytes: number;
  lineCount: number;
  pipeLineCount: number;
  tableRows: number;
  content: Buffer;
};

type FenceMarker = {
  character: "`" | "~";
  length: number;
};

type MathMarker = {
  opener: "$$" | "\\[";
  closer: "$$" | "\\]";
};

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function resolveOptions(options: MarkdownPreviewOptions = {}): ResolvedMarkdownPreviewOptions {
  const requestedPageBytes = positiveInteger(options.pageBytes, DEFAULT_MARKDOWN_PREVIEW_PAGE_BYTES);
  const requestedMaxBytes = positiveInteger(options.maxPageBytes, DEFAULT_MARKDOWN_PREVIEW_MAX_BYTES);
  const maxPageBytes = Math.min(DEFAULT_MARKDOWN_PREVIEW_MAX_BYTES, Math.max(requestedPageBytes, requestedMaxBytes));
  const pageBytes = Math.min(requestedPageBytes, maxPageBytes);
  const maxLines = positiveInteger(options.maxLines, DEFAULT_MARKDOWN_PREVIEW_MAX_LINES);
  return {
    pageBytes,
    maxPageBytes,
    maxLines,
    maxPipeLines: positiveInteger(options.maxPipeLines, DEFAULT_MARKDOWN_PREVIEW_MAX_PIPE_LINES),
    maxTableRows: positiveInteger(options.maxTableRows, Math.max(1, Math.min(400, maxLines - 2))),
    readChunkBytes: Math.min(1024 * 1024, positiveInteger(options.readChunkBytes, DEFAULT_READ_CHUNK_BYTES))
  };
}

function textWithoutLineEnding(buffer: Buffer) {
  let end = buffer.length;
  if (end > 0 && buffer[end - 1] === 10) end -= 1;
  if (end > 0 && buffer[end - 1] === 13) end -= 1;
  return buffer.subarray(0, end).toString("utf8").replace(/^\uFEFF/, "");
}

function unescapedPipeIndexes(line: string) {
  const indexes: number[] = [];
  let backslashes = 0;
  let codeDelimiterLength = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === "`") {
      let runLength = 1;
      while (line[index + runLength] === "`") runLength += 1;
      if (backslashes % 2 === 0) {
        if (codeDelimiterLength === 0) codeDelimiterLength = runLength;
        else if (runLength === codeDelimiterLength) codeDelimiterLength = 0;
      }
      index += runLength - 1;
      backslashes = 0;
      continue;
    }
    if (character === "|" && backslashes % 2 === 0 && codeDelimiterLength === 0) indexes.push(index);
    backslashes = 0;
  }
  return indexes;
}

function splitTableCells(line: string) {
  const indexes = unescapedPipeIndexes(line);
  if (!indexes.length) return [];
  const boundaries = [-1, ...indexes, line.length];
  const cells: string[] = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    cells.push(line.slice(boundaries[index - 1] + 1, boundaries[index]));
  }
  if (indexes[0] === 0) cells.shift();
  if (indexes.at(-1) === line.length - 1) cells.pop();
  return cells;
}

function isTableDelimiter(line: string) {
  const cells = splitTableCells(line.trim());
  return cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

function fenceOpener(line: string): FenceMarker | null {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === "`" && match[2].includes("`"))) return null;
  return { character: match[1][0] as "`" | "~", length: match[1].length };
}

function closesFence(line: string, marker: FenceMarker) {
  const match = line.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/);
  return Boolean(match && match[1][0] === marker.character && match[1].length >= marker.length);
}

function delimiterCount(line: string, delimiter: string) {
  let count = 0;
  for (let index = 0; index <= line.length - delimiter.length; index += 1) {
    if (!line.startsWith(delimiter, index)) continue;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashCount += 1;
    if (slashCount % 2 === 0) count += 1;
    index += delimiter.length - 1;
  }
  return count;
}

function mathOpener(line: string): MathMarker | null {
  const content = line.trim();
  if (content.startsWith("$$") && delimiterCount(content, "$$") % 2 === 1) return { opener: "$$", closer: "$$" };
  if (content.startsWith("\\[") && delimiterCount(content, "\\[") > delimiterCount(content, "\\]")) {
    return { opener: "\\[", closer: "\\]" };
  }
  return null;
}

function closesMath(line: string, marker: MathMarker) {
  return delimiterCount(line, marker.closer) > 0;
}

class Utf8LineCursor {
  private readonly handle: FileHandle;
  private readonly size: number;
  private readonly captureLimit: number;
  private readonly readChunkBytes: number;
  private readPosition: number;
  private cursorPosition: number;
  private chunk = Buffer.alloc(0);
  private chunkOffset = 0;
  private readonly queue: MarkdownLine[] = [];

  constructor(handle: FileHandle, size: number, start: number, captureLimit: number, readChunkBytes: number) {
    this.handle = handle;
    this.size = size;
    this.captureLimit = captureLimit;
    this.readChunkBytes = readChunkBytes;
    this.readPosition = start;
    this.cursorPosition = start;
  }

  private async fillChunk() {
    if (this.readPosition >= this.size) return false;
    const length = Math.min(this.readChunkBytes, this.size - this.readPosition);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, this.readPosition);
    if (!bytesRead) return false;
    this.chunk = buffer.subarray(0, bytesRead);
    this.chunkOffset = 0;
    this.readPosition += bytesRead;
    return true;
  }

  private async readLine(): Promise<MarkdownLine | null> {
    if (this.cursorPosition >= this.size) return null;
    const start = this.cursorPosition;
    const parts: Buffer[] = [];
    let capturedBytes = 0;
    let totalBytes = 0;
    while (this.cursorPosition < this.size) {
      if (this.chunkOffset >= this.chunk.length && !(await this.fillChunk())) break;
      const newline = this.chunk.indexOf(10, this.chunkOffset);
      const segmentEnd = newline >= 0 ? newline + 1 : this.chunk.length;
      const segment = this.chunk.subarray(this.chunkOffset, segmentEnd);
      const remainingCapture = this.captureLimit - capturedBytes;
      if (remainingCapture > 0) {
        const captured = segment.subarray(0, remainingCapture);
        parts.push(captured);
        capturedBytes += captured.length;
      }
      totalBytes += segment.length;
      this.cursorPosition += segment.length;
      this.chunkOffset = segmentEnd;
      if (newline >= 0) break;
    }
    const captured = Buffer.concat(parts, capturedBytes);
    const text = textWithoutLineEnding(captured);
    return {
      start,
      end: start + totalBytes,
      captured,
      text,
      hasPipe: unescapedPipeIndexes(text).length > 0
    };
  }

  async peek(distance = 0) {
    while (this.queue.length <= distance) {
      const line = await this.readLine();
      if (!line) break;
      this.queue.push(line);
    }
    return this.queue[distance] || null;
  }

  async next() {
    await this.peek();
    return this.queue.shift() || null;
  }
}

function createBlockCollector(kind: MarkdownPreviewStructureKind, captureLimit: number) {
  const parts: Buffer[] = [];
  let capturedBytes = 0;
  let start = -1;
  let end = -1;
  let bytes = 0;
  let lineCount = 0;
  let pipeLineCount = 0;
  return {
    add(line: MarkdownLine) {
      if (start < 0) start = line.start;
      end = line.end;
      bytes += line.end - line.start;
      lineCount += 1;
      if (line.hasPipe) pipeLineCount += 1;
      const remaining = captureLimit - capturedBytes;
      if (remaining > 0) {
        const captured = line.captured.subarray(0, remaining);
        parts.push(captured);
        capturedBytes += captured.length;
      }
    },
    finish(tableRows = 0): MarkdownBlock {
      return {
        kind,
        start,
        end,
        bytes,
        lineCount,
        pipeLineCount,
        tableRows,
        content: Buffer.concat(parts, capturedBytes)
      };
    }
  };
}

async function readMarkdownBlock(cursor: Utf8LineCursor, captureLimit: number): Promise<MarkdownBlock | null> {
  const first = await cursor.peek(0);
  if (!first) return null;

  const fence = fenceOpener(first.text);
  if (fence) {
    const collector = createBlockCollector("fence", captureLimit);
    collector.add((await cursor.next())!);
    while (true) {
      const line = await cursor.next();
      if (!line) break;
      collector.add(line);
      if (closesFence(line.text, fence)) break;
    }
    return collector.finish();
  }

  const math = mathOpener(first.text);
  if (math) {
    const collector = createBlockCollector("math", captureLimit);
    collector.add((await cursor.next())!);
    while (true) {
      const line = await cursor.next();
      if (!line) break;
      collector.add(line);
      if (closesMath(line.text, math)) break;
    }
    return collector.finish();
  }

  const second = await cursor.peek(1);
  if (first.hasPipe && second && isTableDelimiter(second.text)) {
    const collector = createBlockCollector("table", captureLimit);
    collector.add((await cursor.next())!);
    collector.add((await cursor.next())!);
    let tableRows = 2;
    while (true) {
      const line = await cursor.peek();
      if (!line || !line.hasPipe || line.text.trim() === "") break;
      collector.add((await cursor.next())!);
      tableRows += 1;
    }
    return collector.finish(tableRows);
  }

  const collector = createBlockCollector("line", captureLimit);
  collector.add((await cursor.next())!);
  return collector.finish();
}

async function normalizeOffset(handle: FileHandle, size: number, requestedOffset: number, readChunkBytes: number) {
  const safeOffset = Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0;
  let offset = Math.max(0, Math.min(safeOffset, size));
  if (offset === 0 || offset === size) return offset;
  const preceding = Buffer.alloc(1);
  const { bytesRead } = await handle.read(preceding, 0, 1, offset - 1);
  if (bytesRead && preceding[0] === 10) return offset;
  while (offset < size) {
    const length = Math.min(readChunkBytes, size - offset);
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, offset);
    if (!result.bytesRead) return size;
    const newline = buffer.indexOf(10, 0);
    if (newline >= 0) return offset + newline + 1;
    offset += result.bytesRead;
  }
  return size;
}

function omissionReason(block: MarkdownBlock, options: ResolvedMarkdownPreviewOptions): MarkdownPreviewOmission["reason"] | null {
  if (block.bytes > options.maxPageBytes) return "byte-budget";
  if (block.lineCount > options.maxLines) return "line-budget";
  if (block.kind === "table" && block.tableRows > options.maxTableRows) return "table-row-budget";
  if (block.pipeLineCount > options.maxPipeLines) return "pipe-line-budget";
  return null;
}

function summaryContent(block: MarkdownBlock) {
  const sizeLabel = `${Math.max(1, Math.ceil(block.bytes / 1024)).toLocaleString("zh-CN")} KB`;
  const lines = block.lineCount.toLocaleString("zh-CN");
  if (block.kind === "fence") {
    return `\n\`\`\`text\n[大型代码块已折叠：${lines} 行，${sizeLabel}。原文件内容未被修改。]\n\`\`\`\n`;
  }
  if (block.kind === "math") {
    return `\n> [!NOTE]\n> 大型数学公式块已折叠（${lines} 行，${sizeLabel}），请在原文件中查看完整公式。\n`;
  }
  if (block.kind === "table") {
    return `\n| 预览状态 | 规模 |\n| --- | ---: |\n| 大型表格已折叠，原文件内容未被修改 | ${lines} 行 / ${sizeLabel} |\n`;
  }
  return `\n> [!NOTE]\n> 超长单行已折叠（${sizeLabel}），请在原文件中查看完整内容。\n`;
}

export async function readMarkdownPreviewPage(
  target: string,
  size: number,
  requestedOffset: number,
  options: MarkdownPreviewOptions = {}
): Promise<MarkdownPreviewPage> {
  const resolved = resolveOptions(options);
  const handle = await fsp.open(target, "r");
  try {
    const offset = await normalizeOffset(handle, size, requestedOffset, resolved.readChunkBytes);
    const cursor = new Utf8LineCursor(handle, size, offset, resolved.maxPageBytes, resolved.readChunkBytes);
    const content: Buffer[] = [];
    const omissions: MarkdownPreviewOmission[] = [];
    let outputBytes = 0;
    let consumedBytes = 0;
    let lineCount = 0;
    let pipeLineCount = 0;
    let nextOffset = offset;

    while (nextOffset < size) {
      const block = await readMarkdownBlock(cursor, resolved.maxPageBytes);
      if (!block) break;
      const reason = omissionReason(block, resolved);
      const summary = reason ? summaryContent(block) : "";
      const rendered = reason ? Buffer.from(summary, "utf8") : block.content;
      const renderedLines = reason ? summary.split("\n").length - 1 : block.lineCount;
      const renderedPipeLines = reason && block.kind === "table" ? 3 : reason ? 0 : block.pipeLineCount;
      const exceedsSoftBudget = content.length > 0 && (
        consumedBytes + block.bytes > resolved.pageBytes
        || lineCount + renderedLines > resolved.maxLines
        || pipeLineCount + renderedPipeLines > resolved.maxPipeLines
      );
      if (exceedsSoftBudget) {
        nextOffset = block.start;
        break;
      }

      content.push(rendered);
      outputBytes += rendered.length;
      consumedBytes += block.bytes;
      lineCount += renderedLines;
      pipeLineCount += renderedPipeLines;
      nextOffset = block.end;
      if (reason) {
        omissions.push({
          kind: block.kind,
          offset: block.start,
          endOffset: block.end,
          byteLength: block.bytes,
          lineCount: block.lineCount,
          reason
        });
      }
      if (consumedBytes >= resolved.pageBytes || outputBytes >= resolved.pageBytes) break;
    }

    const finalOffset = nextOffset < size ? nextOffset : null;
    return {
      content: Buffer.concat(content, outputBytes).toString("utf8"),
      offset,
      nextOffset: finalOffset,
      truncated: offset > 0 || finalOffset !== null,
      ...(omissions.length ? { omittedStructures: omissions } : {})
    };
  } finally {
    await handle.close();
  }
}
