import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { markdownRenderPlan } from "../src/markdown/markdownPlan.ts";
import { readMarkdownPreviewPage } from "../server/markdownPreview.ts";

const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-markdown-pages-"));

async function writeFixture(name, content) {
  const target = path.join(temporaryRoot, name);
  await fsp.writeFile(target, content, "utf8");
  return { target, size: (await fsp.stat(target)).size };
}

async function readAllPages(fixture, options) {
  const pages = [];
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await readMarkdownPreviewPage(fixture.target, fixture.size, offset, options);
    pages.push(page);
    if (page.nextOffset == null) return pages;
    assert.ok(page.nextOffset > offset, "Markdown pagination must always make byte progress");
    offset = page.nextOffset;
  }
  throw new Error("Markdown pagination exceeded the test page limit");
}

try {
  const completeSource = [
    "# 大型文档",
    "",
    "开场段落：" + "甲乙丙丁".repeat(18),
    "",
    "```ts",
    "const message = '代码围栏必须留在同一页';",
    "const values = [1, 2, 3, 4, 5];",
    "```",
    "",
    "~~~python",
    "print('波浪线围栏也必须保持完整')",
    "~~~",
    "",
    "过渡段落：" + "workbench ".repeat(12),
    "",
    "$$",
    "E = mc^2 + \\sum_{i=1}^{n} i",
    "$$",
    "",
    "\\[",
    "a^2 + b^2 = c^2",
    "\\]",
    "",
    "| 名称 | 状态 | 说明 |",
    "| --- | :---: | ---: |",
    "| Codex | ready | 结构安全分页 |",
    "| Claude | ready | 表格不可拆分 |",
    "| 中文 | 正常 | UTF-8 字节偏移准确 |",
    "",
    "结尾段落：" + "完成 ".repeat(25),
    ""
  ].join("\n");
  const completeFixture = await writeFixture("complete.md", completeSource);
  const completePages = await readAllPages(completeFixture, {
    pageBytes: 180,
    maxPageBytes: 1_024,
    maxLines: 100,
    maxPipeLines: 50,
    maxTableRows: 20,
    readChunkBytes: 37
  });

  assert.ok(completePages.length >= 3);
  assert.equal(completePages.map((page) => page.content).join(""), completeSource);
  assert.equal(completePages.at(-1).nextOffset, null);
  assert.equal(completePages.at(-1).truncated, true);
  assert.equal(completePages[0].offset, 0);
  for (const page of completePages) {
    assert.equal(markdownRenderPlan(page.content).mode, "rich", "each Markdown page must remain richly renderable");
  }

  const fencedPage = completePages.find((page) => page.content.includes("```ts"));
  assert.ok(fencedPage?.content.includes("\n```\n"), "a fenced block must include its closing fence on the same page");
  assert.equal(completePages.filter((page) => page.content.includes("代码围栏必须留在同一页")).length, 1);
  const tildeFencePage = completePages.find((page) => page.content.includes("~~~python"));
  assert.ok(tildeFencePage?.content.includes("\n~~~\n"), "tilde fences must use the same atomic paging rule");

  const mathPage = completePages.find((page) => page.content.includes("E = mc^2"));
  assert.equal(mathPage?.content.match(/^\$\$$/gm)?.length, 2, "a display-math block must not cross pages");
  const bracketMathPage = completePages.find((page) => page.content.includes("a^2 + b^2"));
  assert.ok(bracketMathPage?.content.includes("\\[") && bracketMathPage.content.includes("\\]"));

  const tablePage = completePages.find((page) => page.content.includes("| 名称 | 状态 | 说明 |"));
  assert.ok(tablePage?.content.includes("| 中文 | 正常 | UTF-8 字节偏移准确 |"), "a GFM table must stay together");
  assert.equal(completePages.filter((page) => page.content.includes("| Codex | ready |")).length, 1);

  let sourceByteOffset = 0;
  for (const page of completePages) {
    assert.equal(page.offset, sourceByteOffset);
    sourceByteOffset = page.nextOffset ?? completeFixture.size;
  }
  assert.equal(sourceByteOffset, Buffer.byteLength(completeSource));

  const oversizedFenceSource = [
    "引言",
    "",
    "```javascript",
    ...Array.from({ length: 80 }, (_, index) => `const value${index} = '${"x".repeat(28)}';`),
    "```",
    "",
    "收尾",
    ""
  ].join("\n");
  const oversizedFenceFixture = await writeFixture("oversized-fence.md", oversizedFenceSource);
  const oversizedFencePages = await readAllPages(oversizedFenceFixture, {
    pageBytes: 96,
    maxPageBytes: 320,
    maxLines: 40,
    maxPipeLines: 20,
    maxTableRows: 12,
    readChunkBytes: 41
  });
  const fenceSummaryPage = oversizedFencePages.find((page) => page.omittedStructures?.some((item) => item.kind === "fence"));
  assert.ok(fenceSummaryPage);
  assert.match(fenceSummaryPage.content, /大型代码块已折叠/);
  assert.equal(markdownRenderPlan(fenceSummaryPage.content).mode, "rich");
  assert.doesNotMatch(fenceSummaryPage.content, /const value40/);
  assert.equal(fenceSummaryPage.content.match(/```/g)?.length, 2, "the fence summary itself must be valid Markdown");
  assert.equal(oversizedFencePages.at(-1).content, "\n收尾\n");

  const oversizedMathSource = ["$$", ...Array.from({ length: 60 }, () => "x_1 + x_2 + x_3 + x_4"), "$$", "after", ""].join("\n");
  const oversizedMathFixture = await writeFixture("oversized-math.md", oversizedMathSource);
  const oversizedMathPages = await readAllPages(oversizedMathFixture, {
    pageBytes: 128,
    maxPageBytes: 300,
    maxLines: 35,
    maxPipeLines: 20,
    maxTableRows: 12
  });
  assert.match(oversizedMathPages[0].content, /大型数学公式块已折叠/);
  assert.equal(oversizedMathPages[0].omittedStructures?.[0].kind, "math");
  assert.equal(markdownRenderPlan(oversizedMathPages[0].content).mode, "rich");

  const oversizedTableSource = [
    "| index | value |",
    "| ---: | --- |",
    ...Array.from({ length: 30 }, (_, index) => `| ${index} | row-${index} |`),
    "",
    "after",
    ""
  ].join("\n");
  const oversizedTableFixture = await writeFixture("oversized-table.md", oversizedTableSource);
  const oversizedTablePages = await readAllPages(oversizedTableFixture, {
    pageBytes: 256,
    maxPageBytes: 2_048,
    maxLines: 100,
    maxPipeLines: 50,
    maxTableRows: 10
  });
  assert.match(oversizedTablePages[0].content, /大型表格已折叠/);
  assert.equal(oversizedTablePages[0].omittedStructures?.[0].reason, "table-row-budget");
  assert.doesNotMatch(oversizedTablePages[0].content, /row-15/);
  assert.equal(markdownRenderPlan(oversizedTablePages[0].content).mode, "rich");

  const productionBudgetFence = await writeFixture("production-budget-fence.md", `\`\`\`text\n${"x".repeat(130 * 1024)}\n\`\`\`\n`);
  const productionBudgetPage = await readMarkdownPreviewPage(productionBudgetFence.target, productionBudgetFence.size, 0);
  assert.match(productionBudgetPage.content, /大型代码块已折叠/);
  assert.ok(Buffer.byteLength(productionBudgetPage.content) < 120_000);
  assert.equal(markdownRenderPlan(productionBudgetPage.content).mode, "rich");
  assert.equal(productionBudgetPage.nextOffset, null);

  const arbitraryOffsetSource = "first line\nsecond line\nthird line\n";
  const arbitraryFixture = await writeFixture("arbitrary-offset.md", arbitraryOffsetSource);
  const arbitraryPage = await readMarkdownPreviewPage(arbitraryFixture.target, arbitraryFixture.size, 3, { pageBytes: 64 });
  assert.equal(arbitraryPage.offset, Buffer.byteLength("first line\n"));
  assert.equal(arbitraryPage.content, "second line\nthird line\n");

  console.log("Markdown preview pages preserve fenced code, display math, GFM tables and rich-render budgets");
} finally {
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
