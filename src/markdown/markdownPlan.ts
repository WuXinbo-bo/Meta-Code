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

export type MarkdownRenderPlan =
  | { mode: "plain"; text: string; truncated: boolean; highlight: false; math: false }
  | { mode: "rich"; text: string; truncated: false; highlight: boolean; math: boolean };

export function isMarkdownRenderPlan(value: unknown): value is MarkdownRenderPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<MarkdownRenderPlan>;
  if (typeof plan.text !== "string" || typeof plan.truncated !== "boolean") return false;
  if (typeof plan.highlight !== "boolean" || typeof plan.math !== "boolean") return false;
  if (plan.mode === "plain") return plan.highlight === false && plan.math === false;
  return plan.mode === "rich" && plan.truncated === false;
}

function plainTextPlan(source: string): MarkdownRenderPlan {
  return {
    mode: "plain",
    text: source.slice(0, MARKDOWN_PLAIN_CHAR_BUDGET),
    truncated: source.length > MARKDOWN_PLAIN_CHAR_BUDGET,
    highlight: false,
    math: false
  };
}

function countLinesUntilBudget(source: string) {
  let lineCount = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 10) continue;
    lineCount += 1;
    if (lineCount > MARKDOWN_LINE_BUDGET) break;
  }
  return lineCount;
}

type MathBudgetState = {
  count: number;
  characters: number;
};

function isEscaped(source: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source.charCodeAt(cursor) === 92; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function findMathClosingDelimiter(source: string, start: number, delimiter: string, allowNewline: boolean) {
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (!allowNewline && source.charCodeAt(cursor) === 10) return -1;
    if (!source.startsWith(delimiter, cursor) || isEscaped(source, cursor)) continue;
    if (delimiter === "$" && source[cursor + 1] === "$") continue;
    return cursor;
  }
  return -1;
}

function boundedMathText(source: string, state: MathBudgetState) {
  let result = "";
  let copiedUntil = 0;
  let cursor = 0;
  while (cursor < source.length) {
    let opener = "";
    let closer = "";
    let allowNewline = false;
    if (source.startsWith("$$", cursor) && !isEscaped(source, cursor)) {
      opener = closer = "$$";
      allowNewline = true;
    } else if (source.startsWith("\\[", cursor) && !isEscaped(source, cursor)) {
      opener = "\\[";
      closer = "\\]";
      allowNewline = true;
    } else if (source.startsWith("\\(", cursor) && !isEscaped(source, cursor)) {
      opener = "\\(";
      closer = "\\)";
    } else if (source[cursor] === "$" && source[cursor + 1] !== "$" && !isEscaped(source, cursor)) {
      opener = closer = "$";
    }
    if (!opener) {
      cursor += 1;
      continue;
    }

    const closingIndex = findMathClosingDelimiter(source, cursor + opener.length, closer, allowNewline);
    if (closingIndex < 0) {
      cursor += opener.length;
      continue;
    }
    const expressionEnd = closingIndex + closer.length;
    const expressionLength = expressionEnd - cursor;
    state.count += 1;
    const withinBudget = state.count <= MARKDOWN_MATH_BUDGET
      && expressionLength <= MARKDOWN_MATH_EXPRESSION_CHAR_BUDGET
      && state.characters + expressionLength <= MARKDOWN_MATH_CHAR_BUDGET;
    if (withinBudget) {
      state.characters += expressionLength;
    } else {
      result += source.slice(copiedUntil, cursor);
      result += "`[公式超出安全渲染预算，已折叠]`";
      copiedUntil = expressionEnd;
    }
    cursor = expressionEnd;
  }
  return result ? result + source.slice(copiedUntil) : source;
}

function fencedLineParts(source: string) {
  return source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || [];
}

function rewriteBoundedMarkdown(source: string) {
  const lines = fencedLineParts(source);
  const output: string[] = [];
  const normalLines: string[] = [];
  const mathState: MathBudgetState = { count: 0, characters: 0 };
  let fenceCount = 0;
  let mermaidCount = 0;

  const flushNormalLines = () => {
    if (!normalLines.length) return;
    output.push(boundedMathText(normalLines.join(""), mathState));
    normalLines.length = 0;
  };

  for (let index = 0; index < lines.length;) {
    const lineWithoutEnding = lines[index].replace(/\r?\n$/, "");
    const opener = lineWithoutEnding.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (!opener || (opener[1][0] === "`" && opener[2].includes("`"))) {
      normalLines.push(lines[index]);
      index += 1;
      continue;
    }

    flushNormalLines();
    fenceCount += 1;
    const fenceCharacter = opener[1][0];
    const minimumFenceLength = opener[1].length;
    const language = opener[2].trim().split(/\s+/, 1)[0].toLocaleLowerCase();
    let closingIndex = index + 1;
    for (; closingIndex < lines.length; closingIndex += 1) {
      const candidate = lines[closingIndex].replace(/\r?\n$/, "");
      const closingFence = candidate.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/)?.[1];
      if (closingFence?.[0] === fenceCharacter && closingFence.length >= minimumFenceLength) break;
    }
    const hasClosingFence = closingIndex < lines.length;
    const blockEnd = hasClosingFence ? closingIndex + 1 : lines.length;
    const block = lines.slice(index, blockEnd).join("");
    const content = lines.slice(index + 1, hasClosingFence ? closingIndex : lines.length).join("");
    if (content.length > MARKDOWN_CODE_BLOCK_CHAR_BUDGET) {
      output.push(`\n\`\`\`text\n[代码块超过 ${Math.round(MARKDOWN_CODE_BLOCK_CHAR_BUDGET / 1000)}K 字符，已在安全预览中省略]\n\`\`\`\n`);
    } else if (language === "mermaid" && (++mermaidCount > MARKDOWN_MERMAID_BUDGET || content.length > MARKDOWN_MERMAID_CHAR_BUDGET)) {
      output.push("\n```text\n[Mermaid 图表超出安全渲染预算，已显示为占位信息]\n```\n");
    } else {
      output.push(block);
    }
    index = blockEnd;
  }
  flushNormalLines();
  return { text: output.join(""), fenceCount };
}

export function markdownRenderPlan(source: string): MarkdownRenderPlan {
  if (source.length > MARKDOWN_RICH_CHAR_BUDGET) return plainTextPlan(source);

  const lineCount = countLinesUntilBudget(source);
  if (lineCount > MARKDOWN_LINE_BUDGET) return plainTextPlan(source);

  const tableLikeLines = source.split("\n").filter((line) => line.includes("|")).length;
  if (tableLikeLines > 500) return plainTextPlan(source);

  const { text, fenceCount } = rewriteBoundedMarkdown(source);

  return {
    mode: "rich",
    text,
    truncated: false,
    highlight: source.length <= 80_000 && fenceCount <= MARKDOWN_CODE_BLOCK_BUDGET,
    math: true
  };
}
