type MarkdownNodeData = {
  hProperties?: Record<string, unknown>;
  [key: string]: unknown;
};

export type MarkdownAstNode = {
  type: string;
  value?: string;
  children?: MarkdownAstNode[];
  data?: MarkdownNodeData;
};

const ALERT_TYPES = new Set(["note", "tip", "important", "warning", "caution"]);

function markdownNodeText(node: MarkdownAstNode): string {
  if (typeof node.value === "string") return node.value;
  return node.children?.map(markdownNodeText).join("") || "";
}

function visitMarkdownNodes(node: MarkdownAstNode, visitor: (node: MarkdownAstNode) => void) {
  visitor(node);
  for (const child of node.children || []) visitMarkdownNodes(child, visitor);
}

function consumeLeadingText(node: MarkdownAstNode, count: number): number {
  if (count <= 0) return 0;
  if (typeof node.value === "string") {
    const consumed = Math.min(count, node.value.length);
    node.value = node.value.slice(consumed);
    return count - consumed;
  }
  for (const child of node.children || []) {
    count = consumeLeadingText(child, count);
    if (count <= 0) break;
  }
  return count;
}

function removeEmptyLeadingParagraph(blockquote: MarkdownAstNode) {
  const first = blockquote.children?.[0];
  if (first?.type !== "paragraph" || markdownNodeText(first).trim()) return;
  blockquote.children?.shift();
}

export function githubHeadingSlug(value: string): string {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s+/g, "-");
  return slug || "section";
}

export function addWorkbenchMarkdownMetadata(tree: MarkdownAstNode) {
  const headingIds = new Set<string>();
  visitMarkdownNodes(tree, (node) => {
    if (/^heading$/.test(node.type)) {
      const base = githubHeadingSlug(markdownNodeText(node));
      let id = base;
      let duplicateIndex = 1;
      while (headingIds.has(id)) id = `${base}-${duplicateIndex++}`;
      headingIds.add(id);
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, id }
      };
      return;
    }

    if (node.type !== "blockquote") return;
    const firstParagraph = node.children?.[0];
    if (firstParagraph?.type !== "paragraph") return;
    const marker = markdownNodeText(firstParagraph).match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i);
    if (!marker) return;
    const alertType = marker[1].toLocaleLowerCase();
    if (!ALERT_TYPES.has(alertType)) return;
    consumeLeadingText(firstParagraph, marker[0].length);
    removeEmptyLeadingParagraph(node);
    node.data = {
      ...node.data,
      hProperties: {
        ...node.data?.hProperties,
        className: ["markdown-alert", `markdown-alert-${alertType}`],
        "data-markdown-alert": alertType
      }
    };
  });
}

export function remarkWorkbench() {
  return (tree: MarkdownAstNode) => addWorkbenchMarkdownMetadata(tree);
}
