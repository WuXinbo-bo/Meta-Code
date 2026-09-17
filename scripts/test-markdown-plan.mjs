import assert from "node:assert/strict";
import {
  MARKDOWN_CODE_BLOCK_CHAR_BUDGET,
  MARKDOWN_LINE_BUDGET,
  MARKDOWN_MATH_EXPRESSION_CHAR_BUDGET,
  MARKDOWN_MATH_BUDGET,
  MARKDOWN_MERMAID_BUDGET,
  MARKDOWN_MERMAID_CHAR_BUDGET,
  MARKDOWN_PLAIN_CHAR_BUDGET,
  MARKDOWN_RICH_CHAR_BUDGET,
  markdownRenderPlan
} from "../src/markdown/markdownPlan.ts";
import { MarkdownWorkerClient } from "../src/markdown/markdownWorkerClient.ts";
import { addWorkbenchMarkdownMetadata, githubHeadingSlug } from "../src/markdown/remarkWorkbench.ts";
import { WORKBENCH_MARKDOWN_SANITIZE_SCHEMA } from "../src/markdown/safeFileHtml.ts";

class FakeWorker {
  constructor({ autoRespond = true } = {}) {
    this.autoRespond = autoRespond;
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message) {
    this.messages.push(message);
    if (!this.autoRespond || message.type !== "plan") return;
    queueMicrotask(() => this.emit("message", {
      data: { type: "planned", id: message.id, plan: markdownRenderPlan(message.source) }
    }));
  }

  terminate() {
    this.terminated = true;
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

assert.deepEqual(markdownRenderPlan("# Hello"), {
  mode: "rich",
  text: "# Hello",
  truncated: false,
  highlight: true,
  math: true
});

assert.equal(markdownRenderPlan("x".repeat(MARKDOWN_RICH_CHAR_BUDGET)).mode, "rich");
assert.equal(markdownRenderPlan("x".repeat(MARKDOWN_RICH_CHAR_BUDGET + 1)).mode, "rich");

const maximumRichLines = Array.from({ length: MARKDOWN_LINE_BUDGET }, () => "line").join("\n");
assert.equal(markdownRenderPlan(maximumRichLines).mode, "rich");
assert.equal(markdownRenderPlan(`${maximumRichLines}\nline`).mode, "rich");

const fiveHundredTableLines = Array.from({ length: 500 }, () => "a|b").join("\n");
assert.equal(markdownRenderPlan(fiveHundredTableLines).mode, "rich");
assert.equal(markdownRenderPlan(`${fiveHundredTableLines}\na|b`).mode, "rich");

const oversizedPlain = markdownRenderPlan("x".repeat(MARKDOWN_PLAIN_CHAR_BUDGET + 1));
assert.equal(oversizedPlain.mode, "rich");
assert.equal(oversizedPlain.text.length, MARKDOWN_PLAIN_CHAR_BUDGET + 1);
assert.equal(oversizedPlain.truncated, false);
assert.equal(oversizedPlain.pages.join("").length, MARKDOWN_PLAIN_CHAR_BUDGET + 1);

const oversizedCode = `\`\`\`ts\n${"x".repeat(MARKDOWN_CODE_BLOCK_CHAR_BUDGET + 1)}\n\`\`\``;
const codePlan = markdownRenderPlan(oversizedCode);
assert.equal(codePlan.mode, "rich");
assert.equal(codePlan.text, oversizedCode);

const mermaidBlock = (content = "graph TD; A-->B") => `\`\`\`mermaid\n${content}\n\`\`\``;
const allowedMermaid = Array.from({ length: MARKDOWN_MERMAID_BUDGET }, () => mermaidBlock()).join("\n");
assert.doesNotMatch(markdownRenderPlan(allowedMermaid).text, /Mermaid 图表超出/);
assert.equal(markdownRenderPlan(`${allowedMermaid}\n${mermaidBlock()}`).text, `${allowedMermaid}\n${mermaidBlock()}`);
assert.match(markdownRenderPlan(mermaidBlock("x".repeat(MARKDOWN_MERMAID_CHAR_BUDGET + 1))).text, /x{12001}/);

const maximumHighlightedBlocks = Array.from({ length: 16 }, () => "```ts\nconst x = 1;\n```").join("\n");
assert.equal(markdownRenderPlan(maximumHighlightedBlocks).highlight, true);
assert.equal(markdownRenderPlan(`${maximumHighlightedBlocks}\n\`\`\`ts\nconst y = 2;\n\`\`\``).highlight, true);

assert.equal(markdownRenderPlan("\\(x\\)".repeat(MARKDOWN_MATH_BUDGET)).math, true);
const boundedMath = markdownRenderPlan("\\(x\\)".repeat(MARKDOWN_MATH_BUDGET + 1));
assert.equal(boundedMath.math, true);
assert.equal(boundedMath.text, "$x$".repeat(MARKDOWN_MATH_BUDGET + 1));

const oversizedMath = markdownRenderPlan(`$$${"x".repeat(MARKDOWN_MATH_EXPRESSION_CHAR_BUDGET + 1)}$$`);
assert.equal(oversizedMath.math, true);
assert.match(oversizedMath.text, /x{8001}/);

const mathInsideCode = markdownRenderPlan(`~~~text\n${"\\(x\\)".repeat(MARKDOWN_MATH_BUDGET + 1)}\n~~~\n\\(visible\\)`);
assert.doesNotMatch(mathInsideCode.text, /公式超出安全渲染预算/);
assert.match(mathInsideCode.text, /\$visible\$/);
assert.match(mathInsideCode.text, /\\\(x\\\)/);
assert.equal(markdownRenderPlan("`\\(code\\)` and \\(x^2\\)").text, "`\\(code\\)` and $x^2$");
assert.match(markdownRenderPlan("\\[x^2\\]").text, /\$\$\nx\^2\n\$\$/);
const formulaDocument = Array.from({ length: 500 }, (_, i) => `## Formula ${i}\n\n$y_{${i}}=x^2$\n`).join("\n");
const formulaPages = markdownRenderPlan(formulaDocument).pages;
assert.ok(formulaPages.length > 1);
for (let i = 0; i < 500; i++) assert.equal(formulaPages.filter(p => p.includes(`$y_{${i}}=x^2$`)).length, 1);
const referenced = markdownRenderPlan(("Paragraph [link][ref].\n\n").repeat(1000) + "\n[ref]: https://example.com\n");
assert.ok(referenced.pages.every(page => page.includes("[ref]: https://example.com")));
const headings = markdownRenderPlan(Array.from({ length: 100 }, () => '# Same\n\n' + 'paragraph '.repeat(100)).join('\n\n'));
const ids = headings.pageHeadings.flat().map(h => h.id);
assert.equal(ids.length, 100);
assert.equal(new Set(ids).size, 100, 'heading IDs remain unique across pages');

assert.equal(githubHeadingSlug("Hello, Workbench!"), "hello-workbench");
assert.equal(githubHeadingSlug("中文 标题"), "中文-标题");
const markdownTree = {
  type: "root",
  children: [
    { type: "heading", children: [{ type: "text", value: "Hello, Workbench!" }] },
    { type: "heading", children: [{ type: "text", value: "Hello, Workbench!-1" }] },
    { type: "heading", children: [{ type: "text", value: "Hello, Workbench!" }] },
    {
      type: "blockquote",
      children: [{ type: "paragraph", children: [{ type: "text", value: "[!WARNING]\nRead this carefully." }] }]
    }
  ]
};
addWorkbenchMarkdownMetadata(markdownTree);
assert.equal(markdownTree.children[0].data.hProperties.id, "hello-workbench");
assert.equal(markdownTree.children[1].data.hProperties.id, "hello-workbench-1");
assert.equal(markdownTree.children[2].data.hProperties.id, "hello-workbench-2");
assert.equal(markdownTree.children[3].data.hProperties["data-markdown-alert"], "warning");
assert.equal(markdownTree.children[3].children[0].children[0].value, "Read this carefully.");
assert.equal(WORKBENCH_MARKDOWN_SANITIZE_SCHEMA.tagNames.includes("script"), false);
assert.equal(WORKBENCH_MARKDOWN_SANITIZE_SCHEMA.attributes["*"].includes("style"), false);
assert.equal(WORKBENCH_MARKDOWN_SANITIZE_SCHEMA.attributes.blockquote.includes("dataMarkdownAlert"), true);

const worker = new FakeWorker();
const client = new MarkdownWorkerClient({ workerFactory: () => worker });
assert.equal((await client.plan("x".repeat(MARKDOWN_RICH_CHAR_BUDGET + 1))).mode, "rich");
assert.equal(worker.messages.length, 1);
const [deduplicatedA, deduplicatedB] = await Promise.all([
  client.plan("same source"),
  client.plan("same source")
]);
assert.deepEqual(deduplicatedA, deduplicatedB);
assert.equal(worker.messages.filter((message) => message.type === "plan").length, 2);

const oneSubscriberCancelled = new AbortController();
const cancelledSubscriber = client.plan("shared cancellation", { signal: oneSubscriberCancelled.signal });
const liveSubscriber = client.plan("shared cancellation");
oneSubscriberCancelled.abort();
await assert.rejects(cancelledSubscriber, (error) => error?.name === "AbortError");
assert.equal((await liveSubscriber).mode, "rich");

const deferredWorker = new FakeWorker({ autoRespond: false });
const deferredClient = new MarkdownWorkerClient({ workerFactory: () => deferredWorker });
const lastSubscriberCancelled = new AbortController();
const cancelledRequest = deferredClient.plan("cancel transport", { signal: lastSubscriberCancelled.signal });
await Promise.resolve();
lastSubscriberCancelled.abort();
await assert.rejects(cancelledRequest, (error) => error?.name === "AbortError");
assert.deepEqual(deferredWorker.messages.map((message) => message.type), ["plan", "cancel"]);

let fallbackCalls = 0;
const fallbackClient = new MarkdownWorkerClient({
  workerFactory: () => { throw new Error("Worker unavailable"); },
  fallback: (source) => {
    fallbackCalls += 1;
    return markdownRenderPlan(source);
  }
});
const [fallbackA, fallbackB] = await Promise.all([
  fallbackClient.plan("fallback source"),
  fallbackClient.plan("fallback source")
]);
assert.deepEqual(fallbackA, fallbackB);
assert.equal(fallbackCalls, 1);

client.dispose();
deferredClient.dispose();
fallbackClient.dispose();

console.log("Markdown render planning boundaries and worker client contract OK");
