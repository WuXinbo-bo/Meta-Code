import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkStringify from "remark-stringify";
import { addWorkbenchMarkdownMetadata, type MarkdownAstNode } from "./remarkWorkbench";

// Budgets govern work per page, never the amount of source retained.
export const MARKDOWN_RICH_CHAR_BUDGET = 120_000;
export const MARKDOWN_PLAIN_CHAR_BUDGET = 180_000;
export const MARKDOWN_LINE_BUDGET = 3_000;
export const MARKDOWN_CODE_BLOCK_BUDGET = 16;
export const MARKDOWN_CODE_BLOCK_CHAR_BUDGET = 50_000;
export const MARKDOWN_MERMAID_BUDGET = 3;
export const MARKDOWN_MERMAID_CHAR_BUDGET = 12_000;
export const MARKDOWN_MATH_BUDGET = 120;
export const MARKDOWN_MATH_CHAR_BUDGET = 24_000;
export const MARKDOWN_MATH_EXPRESSION_CHAR_BUDGET = 8_000;
export const MARKDOWN_PAGE_CHARS = 16_000;

export type MarkdownRenderPlan = {
  mode: "rich" | "plain"; text: string; truncated: boolean; highlight: boolean; math: boolean; pages?: string[];
  pageHeadings?: { id: string; title: string }[][];
};
export function isMarkdownRenderPlan(value: unknown): value is MarkdownRenderPlan {
  const p = value as MarkdownRenderPlan | null;
  return !!p && (p.mode === "rich" || p.mode === "plain") && typeof p.text === "string"
    && typeof p.truncated === "boolean" && typeof p.highlight === "boolean" && typeof p.math === "boolean"
    && (p.pages === undefined || (Array.isArray(p.pages) && p.pages.every(x => typeof x === "string")))
    && (p.pageHeadings === undefined || (Array.isArray(p.pageHeadings) && p.pageHeadings.every(items => Array.isArray(items) && items.every(x => typeof x.id === "string" && typeof x.title === "string"))));
}

/** Normalize model-emitted TeX delimiters, excluding fenced/indented/inline code. */
export function normalizeMathDelimiters(source: string): string {
  let fence = "";
  let inline = "";
  return source.split(/(?<=\n)/).map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = "";
      return line;
    }
    if (marker) { fence = marker[1]; return line; }
    if (/^(?: {4}|\t)/.test(line)) return line;
    let out = "";
    for (let i = 0; i < line.length;) {
      if (line[i] === "`") {
        const run = line.slice(i).match(/^`+/)![0];
        if (!inline) inline = run; else if (inline === run) inline = "";
        out += run; i += run.length; continue;
      }
      if (!inline && line[i] === "\\") {
        const next = line[i + 1];
        if (next === "\\") { out += "\\\\"; i += 2; continue; }
        if (next === "(" || next === ")") { out += "$"; i += 2; continue; }
        if (next === "[" || next === "]") { out += "\n$$\n"; i += 2; continue; }
      }
      out += line[i++];
    }
    return out;
  }).join("");
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkStringify);

export function markdownRenderPlan(source: string): MarkdownRenderPlan {
  const text = normalizeMathDelimiters(source);
  const result: MarkdownRenderPlan = { mode: "rich", text, truncated: false, highlight: text.length <= MARKDOWN_PAGE_CHARS, math: true };
  if (text.length < MARKDOWN_PAGE_CHARS && text.split("\n").length < 300 && (text.match(/\$/g)?.length || 0) < 120) return result;
  const tree = processor.parse(text);
  const definitions = tree.children.filter(n => n.type === "definition" || n.type === "footnoteDefinition");
  const context = definitions.length ? "\n\n" + processor.stringify({ type: "root", children: definitions }) : "";
  const pieces: string[] = [];
  for (const node of tree.children) {
    if (node.type === "definition" || node.type === "footnoteDefinition") continue;
    if (node.type === "table" && node.children.length > 100) {
      for (let i = 1; i < node.children.length; i += 100) {
        pieces.push(processor.stringify({ type: "root", children: [{ ...node, children: [node.children[0], ...node.children.slice(i, i + 100)] }] }));
      }
    } else if (node.type === "list" && node.children.length > 100) {
      for (let i = 0; i < node.children.length; i += 100) {
        pieces.push(processor.stringify({ type: "root", children: [{ ...node, start: node.ordered ? (node.start || 1) + i : node.start, children: node.children.slice(i, i + 100) }] }));
      }
    } else if (node.type === "paragraph" && (node.position!.end.offset! - node.position!.start.offset!) > MARKDOWN_PAGE_CHARS) {
      let part = "";
      for (const child of node.children) {
        const value = text.slice(child.position!.start.offset, child.position!.end.offset);
        if (child.type === "text") {
          for (let i = 0; i < value.length;) {
            let end = Math.min(value.length, i + MARKDOWN_PAGE_CHARS);
            if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
            part += value.slice(i, end); i = end;
            if (part.length >= MARKDOWN_PAGE_CHARS) { pieces.push(part); part = ""; }
          }
        } else {
          // Inline formula/link/code is atomic, even above the soft page budget.
          if (part.length + value.length > MARKDOWN_PAGE_CHARS && part) { pieces.push(part); part = ""; }
          part += value;
        }
      }
      if (part) pieces.push(part);
    } else {
      pieces.push(text.slice(node.position!.start.offset, node.position!.end.offset));
    }
  }
  const pages: string[] = [];
  let page = "";
  for (const piece of pieces) {
    if (page && (page.length + piece.length > MARKDOWN_PAGE_CHARS || page.split("\n").length > 250 || (page.match(/\$/g)?.length || 0) >= 100)) {
      pages.push(page + context); page = "";
    }
    page += (page ? "\n\n" : "") + piece;
  }
  if (page || !pages.length) pages.push(page + context);
  if (pages.length > 1) {
    result.pages = pages;
    const ids = new Set<string>();
    result.pageHeadings = pages.map(page => {
      const tree = processor.parse(page);
      addWorkbenchMarkdownMetadata(tree, ids);
      const headings: { id: string; title: string }[] = [];
      const textOf = (node: MarkdownAstNode): string => node.value || node.children?.map(textOf).join("") || "";
      const visit = (node: MarkdownAstNode) => {
        if (node.type === "heading") headings.push({ id: String(node.data?.hProperties?.id), title: textOf(node) });
        node.children?.forEach(visit);
      };
      visit(tree);
      return headings;
    });
  }
  return result;
}
