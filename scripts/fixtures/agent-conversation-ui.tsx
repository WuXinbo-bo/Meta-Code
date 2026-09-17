import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentDrawer, AgentTaskDescription } from '/src/components/AgentDrawer';
import { AgentConversation, useAgentOutputFollow } from '/src/components/AgentConversation';
import { AssistantReply } from '/src/components/AssistantReply';
import { MarkdownBody } from '/src/components/MarkdownBody';
import { ProviderIcon } from '/src/branding/ProviderIcon';
import '/src/styles.css';
import '/src/design/tokens.css';
import '/src/design/shell.css';
import '/src/design/conversation.css';
import '/src/design/features.css';
import '/src/design/workflow.css';

const text = '检查日志的统一排版。这里包含 **强调文字**、`inline code` 和正常的中文段落。\n\n- 保留原生能力\n- 运行结束后点击摘要查看详情\n\n```ts\nconst message = "hello";\n```';
const makeLogs = (count: number) => Array.from({ length: count }, (_, i) => ({ id: String(i), createdAt: new Date(1750000000000 + i * 1000).toISOString(), kind: i % 2 ? 'tool' : 'message', category: i % 2 ? 'command' : 'message', phase: 'completed', title: '执行命令', text: i % 2 ? `echo command-${i}` : `第 ${i} 条回复\n\n${text}` }));
function Fixture() {
  const [logs, setLogs] = useState(makeLogs(120));
  const [provider, setProvider] = useState('codex');
  const [status, setStatus] = useState('completed');
  const [theme, setTheme] = useState('light');
  const followOutput = useAgentOutputFollow(JSON.stringify(logs.at(-1)), provider);
  return <>
    <main style={{ width: '40%', padding: 24 }}><AssistantReply text={text} renderMessage={value => <MarkdownBody text={value} />} avatar={<ProviderIcon provider={provider} size={18} />} /></main>
    <AgentDrawer title="布局验证" onClose={() => {}} followOutput={followOutput} header={<header><strong>布局验证</strong><button onClick={() => { const t = theme === 'light' ? 'dark' : 'light'; setTheme(t); document.documentElement.dataset.theme = t; }}>切换主题</button></header>} navigation={<nav className="agent-thread-tabs">
      {['codex', 'claude', 'gemini', 'codebuddy'].map(p => <button key={p} onClick={() => setProvider(p)}>{p}</button>)}
      <button onClick={() => setLogs(makeLogs(10000))}>一万条</button>
      <button onClick={() => { setStatus('running'); setLogs(current => [...current, { ...makeLogs(1)[0], id: String(current.length), createdAt: new Date().toISOString(), kind: 'tool', category: 'command', phase: 'running', text: `echo live-${current.length}` }]); }}>追加日志</button>
      <button onClick={() => setStatus('completed')}>完成</button>
    </nav>}>
      <AgentTaskDescription text={'这是一段较长的任务说明。'.repeat(80)} />
      <AgentConversation key={provider} scrollRef={followOutput.containerRef} provider={provider} renderMessage={value => <MarkdownBody text={value} />} logs={logs} status={status} showProvider={false} />
    </AgentDrawer>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
