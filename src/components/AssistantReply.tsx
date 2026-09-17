import type { HTMLAttributes, ReactNode } from "react";
import { MarkdownBody } from "./MarkdownBody";

export function AgentReplyContent({ text, renderMessage }: { text: unknown; renderMessage?: (text: string) => ReactNode }) {
  const messageText = typeof text === "string" && text ? text : "已更新任务进度";
  if (renderMessage) return <>{renderMessage(messageText)}</>;
  return <div className="agent-markdown-message"><MarkdownBody text={messageText} /></div>;
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
