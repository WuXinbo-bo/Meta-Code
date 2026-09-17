import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownBody } from '/src/components/MarkdownBody';
import { SafeFileMarkdownBody } from '/src/components/SafeFileMarkdownBody';
import { AgentReplyContent } from '/src/components/AssistantReply';
import { FilePreview } from '/src/components/FilePreview';
import '/src/styles.css';
import '/src/design/tokens.css';
import '/src/design/document-preview.css';

const basic = String.raw`# 数学与日志

行内公式 $E=mc^2$ 与括号公式 \(a^2+b^2=c^2\)。

\[
\frac{1}{n}\sum_{i=1}^{n}x_i
\]

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$
` + '\n```text\n\\(not math\\)\n```\n';
const huge = Array.from({ length: 500 }, (_, i) => `## 第 ${i} 条\n\n唯一标记${i} $y_{${i}}=x^2$\n\n${'完整中文内容。'.repeat(80)}\n`).join('\n');
function Fixture() {
  const [mode, setMode] = useState('basic');
  const [tick, setTick] = useState(0);
  const source = mode === 'huge' ? huge : mode === 'errors' ? '$\\badcommand{x}$\n\n正常公式 $x^2$\n\n$\\href{javascript:alert(1)}{bad}$' : basic;
  const file = React.useMemo(() => ({ type: 'file', kind: 'markdown', name: 'long.md', path: 'long.md', size: 2000000, version: `version-${tick}`, content: '# 文件第 0 页\n\n$x^2$', offset: 0, endOffset: 100000, nextOffset: 100000, previewMode: 'markdown-paged' }), [tick]);
  return <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
    <nav>{['basic', 'huge', 'errors', 'file'].map(m => <button key={m} onClick={() => setMode(m)}>{m}</button>)}<button onClick={() => { const el = document.documentElement; el.dataset.theme = el.dataset.theme === 'dark' ? 'light' : 'dark'; }}>主题</button></nav>
    {mode === 'file' ? <FilePreview file={file} workspaceId="fixture" workspaceRoot="fixture" presentation="workspace" onClose={() => {}} onReveal={() => {}} onOpenLocalFile={() => {}} onReload={() => setTick(tick + 1)} /> : <>
      <section data-testid="main"><h2>主对话</h2><MarkdownBody key={mode} text={source} /></section>
      <section data-testid="file"><h2>安全文件预览</h2><SafeFileMarkdownBody key={mode} text={source + '\n<script>window.UNSAFE=true</script>\n'} markdownPath="test.md" /></section>
      <section data-testid="agent"><h2>子 Agent 共享渲染</h2><AgentReplyContent key={mode} text={source} /></section>
    </>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
