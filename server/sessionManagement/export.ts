type ExportableSession = {
  id: string;
  title: string;
  engine: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{ role?: string; text?: string; createdAt?: string }>;
};

function markdownText(value: unknown) {
  return String(value || "").replace(/\r\n/g, "\n");
}

export function sessionAsMarkdown(session: ExportableSession) {
  const lines = [
    `# ${markdownText(session.title)}`,
    "",
    `- 会话 ID：\`${session.id}\``,
    `- 主脑：${session.engine}`,
    `- 创建时间：${session.createdAt}`,
    `- 更新时间：${session.updatedAt}`,
    ""
  ];
  for (const message of session.messages || []) {
    const role = message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role === "error" ? "错误" : "活动";
    lines.push(`## ${role}`, "", markdownText(message.text), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function sessionAsPortableJson(session: ExportableSession) {
  return JSON.stringify({ schemaVersion: 1, kind: "metacode-session", exportedAt: new Date().toISOString(), session }, null, 2);
}
