import type { HTMLAttributes, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export function AgentReplyContent({ text, renderMessage }: { text: unknown; renderMessage?: (text: string) => ReactNode }) {
  const messageText = typeof text === "string" && text ? text : "已更新任务进度";
  if (renderMessage) return <>{renderMessage(messageText)}</>;
  return messageText.length > 120_000
    ? <div className="agent-markdown-message safe-plain"><p>回复内容较大，已切换为纯文本安全预览。</p><pre>{messageText.slice(0, 180_000)}</pre></div>
    : <div className="agent-markdown-message"><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{messageText}</ReactMarkdown></div>;
}

/** Main replies and Agent transcripts share the same row, typography and action slots. */
export function AssistantReply({ text, renderMessage, avatar, heading, actions, children, className = "", ...attributes }: HTMLAttributes<HTMLElement> & {
  text: unknown;
  renderMessage?: (text: string) => ReactNode;
  avatar: ReactNode;
  heading?: ReactNode;
  actions?: ReactNode;
}) {
  return <article {...attributes} className={`message assistant assistant-reply ${className}`.trim()}>
    <div className="avatar">{avatar}</div>
    <div className="message-body">
      {heading && <header className="assistant-reply-heading">{heading}</header>}
      <AgentReplyContent text={text} renderMessage={renderMessage} />
      {children}
      {actions}
    </div>
  </article>;
}
