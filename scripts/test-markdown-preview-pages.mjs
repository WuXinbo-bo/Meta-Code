import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readMarkdownPreviewPage } from "../server/markdownPreview.ts";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-markdown-lossless-"));
async function verify(name, source, options = {}) {
  const target = path.join(root, name);
  await fsp.writeFile(target, source);
  const size = Buffer.byteLength(source);
  let offset = 0, continuation, version;
  const pages = [];
  for (let i = 0; i < 10000; i++) {
    const page = await readMarkdownPreviewPage(target, size, offset, { ...options, continuation, version });
    assert.equal(page.offset, offset);
    assert.equal(page.endOffset, offset + Buffer.byteLength(page.rawContent));
    assert.equal(page.rawContent, Buffer.from(source).subarray(offset, page.endOffset).toString(), "source bytes are never dropped or duplicated");
    assert.ok(!page.rawContent.includes("\ufffd"), "UTF-8 remains intact");
    pages.push(page);
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset; continuation = page.nextContinuation; version = page.version;
  }
  assert.equal(pages.at(-1).nextOffset, null);
  assert.equal(pages.map(p => p.rawContent).join(""), source);
  return { pages, target, size };
}
try {
  const small = { pageBytes: 180, maxPageBytes: 1024, maxLines: 100 };
  const ordinary = await verify("ordinary.md", "# 标题\n\n" + "段落内容😀。\n\n".repeat(30) + "```ts\nconst x = 1;\n```\n\n$$\nx^2\n$$\n\n\\[\na^2+b^2=c^2\n\\]\n", small);
  assert.ok(ordinary.pages.length > 2);
  const formulaPage = ordinary.pages.find(p => p.content.includes("x^2"));
  assert.equal(formulaPage.content.match(/^\$\$$/gm).length, 2);
  const code = await verify("code.md", "前言\n```ts\n" + Array.from({ length: 300 }, (_, i) => `const value${i} = '中文';\n`).join("") + "```\n尾声\n", { pageBytes: 256, maxPageBytes: 512 });
  assert.ok(code.pages.length > 12);
  assert.ok(code.pages.some(p => p.nextContinuation));
  for (const page of code.pages.filter(p => p.content.includes("const value"))) assert.equal(page.content.match(/^```/gm).length, 2, "continued code is syntactically fenced");
  const table = await verify("table.md", "| index | value |\n| --- | --- |\n" + Array.from({ length: 550 }, (_, i) => `| ${i} | row-${i} |\n`).join("") + "\n尾声\n", { maxTableRows: 50 });
  assert.ok(table.pages.length >= 11);
  for (const page of table.pages.filter(p => p.content.includes("row-"))) assert.match(page.content, /^\| index \| value \|\n\| --- \| --- \|/);
  const math = await verify("math.md", "$$\n" + "x + ".repeat(6000) + "y\n$$\nafter\n", { pageBytes: 128, maxPageBytes: 300 });
  assert.ok(math.pages[0].content.includes("y\n$$"), "a large complete formula stays atomic, beyond old 8K/24K limits");
  assert.equal(math.pages[0].sourcePage, false);
  await verify("long-line.md", "😀中文".repeat(50000) + "\nend\n");
  await verify("long-code-line.md", "```text\n" + "😀中文".repeat(50000) + "\n```\nend\n");
  const extreme = await verify("extreme-math.md", "$$\n" + "x+".repeat(1100000) + "y\n$$\nend\n");
  assert.equal(extreme.pages[0].sourcePage, true, "pathological single expression has complete paged source access");
  assert.ok(extreme.pages.every(p => Buffer.byteLength(p.content) <= 120000));
  const saved = code.pages[0];
  await fsp.appendFile(code.target, "changed");
  await assert.rejects(readMarkdownPreviewPage(code.target, code.size, saved.nextOffset, { continuation: saved.nextContinuation, version: saved.version }), /文件已发生变化/);
  await assert.rejects(readMarkdownPreviewPage(code.target, code.size, 0, { continuation: "bad" }));
  console.log("Lossless pages: Unicode, 300-line code, 550-row table, 24K+ formula, 2MB+ source, cursor continuity and changed-file rejection passed");
} finally { await fsp.rm(root, { recursive: true, force: true }); }
