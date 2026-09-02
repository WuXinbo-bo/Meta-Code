import { spawn } from "node:child_process";
import path from "node:path";

export type DocxPreviewResult = {
  html: string;
  warnings: string[];
};

export const DOCX_PREVIEW_INPUT_BYTES = 12 * 1024 * 1024;
const DOCX_PREVIEW_OUTPUT_BYTES = 8 * 1024 * 1024;
const DOCX_PREVIEW_TIMEOUT_MS = 15_000;
const DOCX_PREVIEW_CACHE_ENTRIES = 16;
const DOCX_PREVIEW_CACHE_BYTES = 32 * 1024 * 1024;

type CacheEntry = { value: DocxPreviewResult; bytes: number };

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<DocxPreviewResult>>();
let cacheBytes = 0;

const CONVERTER_SOURCE = String.raw`
const mammoth = require("mammoth");
const sanitizeHtml = require("sanitize-html");

const target = process.argv[1];

(async () => {
  const converted = await mammoth.convertToHtml(
    { path: target },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: true,
      includeDefaultStyleMap: true,
      styleMap: [
        "p[style-name='Title'] => h1.docx-title:fresh",
        "p[style-name='Subtitle'] => p.docx-subtitle:fresh",
        "p[style-name='Caption'] => p.docx-caption:fresh",
        "p[style-name='Code'] => pre.docx-code:fresh"
      ]
    }
  );
  const html = sanitizeHtml(converted.value, {
    allowedTags: [
      "p", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "strong", "em", "u", "s", "sup", "sub",
      "blockquote", "pre", "code", "br", "hr", "a", "img",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td"
    ],
    allowedAttributes: {
      "*": ["class", "id"],
      a: ["href", "name", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      ol: ["start"],
      li: ["value"],
      th: ["colspan", "rowspan", "scope"],
      td: ["colspan", "rowspan"]
    },
    allowedSchemes: ["http", "https", "mailto", "data"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: "_blank", rel: "noreferrer noopener" }
      })
    }
  });
  const warnings = converted.messages
    .filter((message) => message && message.message)
    .slice(0, 12)
    .map((message) => String(message.message));
  process.stdout.write(JSON.stringify({ html, warnings }));
})().catch((error) => {
  process.stderr.write(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`;

function cacheKey(target: string, size: number, modifiedAtMs: number) {
  return `${path.resolve(target)}\u0000${size}\u0000${modifiedAtMs}`;
}

function cacheResult(key: string, value: DocxPreviewResult) {
  const bytes = Buffer.byteLength(value.html, "utf8") + value.warnings.reduce((total, warning) => total + Buffer.byteLength(warning, "utf8"), 0);
  const previous = cache.get(key);
  if (previous) cacheBytes -= previous.bytes;
  cache.delete(key);
  cache.set(key, { value, bytes });
  cacheBytes += bytes;
  while (cache.size > DOCX_PREVIEW_CACHE_ENTRIES || cacheBytes > DOCX_PREVIEW_CACHE_BYTES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    if (oldest) cacheBytes -= oldest.bytes;
    cache.delete(oldestKey);
  }
}

function runConverter(target: string) {
  return new Promise<DocxPreviewResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=192", "-e", CONVERTER_SOURCE, target], {
      cwd: process.cwd(),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: DocxPreviewResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value!);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Word 预览转换超时，请使用系统 Word 打开该文档"));
    }, DOCX_PREVIEW_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > DOCX_PREVIEW_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("Word 预览内容超过安全输出预算，请使用系统 Word 打开该文档"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new Error(detail ? `Word 预览转换失败：${detail.slice(0, 600)}` : "Word 预览转换失败"));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Partial<DocxPreviewResult>;
        if (typeof parsed.html !== "string" || !Array.isArray(parsed.warnings)) throw new Error("Word 预览转换结果无效");
        finish(undefined, { html: parsed.html, warnings: parsed.warnings.filter((item): item is string => typeof item === "string") });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export async function previewDocx(target: string, size: number, modifiedAtMs: number) {
  if (!Number.isFinite(size) || size < 0 || size > DOCX_PREVIEW_INPUT_BYTES) {
    throw new Error(`Word 文档超过 ${Math.round(DOCX_PREVIEW_INPUT_BYTES / 1024 / 1024)} MB 安全预览预算，请使用系统 Word 打开`);
  }
  const key = cacheKey(target, size, modifiedAtMs);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.value;
  }
  const existing = pending.get(key);
  if (existing) return existing;
  const conversion = runConverter(target).then((value) => {
    cacheResult(key, value);
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, conversion);
  return conversion;
}

export function clearDocxPreviewCache() {
  cache.clear();
  pending.clear();
  cacheBytes = 0;
}
