type JsonRecord = Record<string, unknown>;

function recordOf(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function limitedText(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function isClaudeQuestionTool(toolName = "") {
  return ["askuserquestion", "ask_user_question", "request_user_input"].includes(toolName.trim().toLowerCase());
}

export function compactClaudeQuestionPayload(payload: unknown) {
  const source = recordOf(payload);
  const input = recordOf(source?.input);
  const rawQuestions = Array.isArray(input?.questions) ? input.questions : [];
  const questions = rawQuestions.slice(0, 10).flatMap((value) => {
    const question = recordOf(value);
    const text = limitedText(question?.question, 4_000);
    if (!text) return [];
    const options = (Array.isArray(question?.options) ? question.options : []).slice(0, 20).flatMap((optionValue) => {
      const option = recordOf(optionValue);
      const label = limitedText(option?.label, 500);
      if (!label) return [];
      return [{ label, description: limitedText(option?.description, 2_000) }];
    });
    return [{
      header: limitedText(question?.header, 200),
      question: text,
      multiSelect: question?.multiSelect === true,
      options
    }];
  });
  return {
    type: source?.type,
    name: source?.name,
    id: source?.id,
    tool_use_id: source?.tool_use_id,
    questions,
    workbench_compacted: true
  };
}
