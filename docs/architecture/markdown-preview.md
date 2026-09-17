# Markdown、公式与大文件预览

文件预览、主回复和子 Agent 回复共用 `MarkdownBody`。源内容不再因整篇长度、公式数量或代码块数量而被替换为不可展开的占位文字。用户始终连续滚动阅读，没有页码、上一页或下一页；下文的分页只指内部传输与渲染分块。

## 分工

- `markdownPlan.ts`：规范化代码之外的 `\(...\)` / `\[...\]`；按 Markdown 语义结构分页。长表格按行分段并重复表头，列表保留编号，公式、链接和内联代码保持完整。引用定义随页面提供；当前加载内容的章节目录和跨页标题 ID 保持一致。
- `markdownWorkerClient.ts`：较长内容在 Worker 中规划，支持取消与请求合并；缓存最多 16 项、约 200 万字符。流式更新等待新计划期间继续显示上一份内容。
- `MathFormula` / `mathRenderer.ts` / `math.worker.ts`：进入视口附近才排版；最多一个活跃 Worker；取消、异常或 5 秒无结果会终止该 Worker，随后任务使用新实例。成功结果缓存最多 256 项、约 4 MB。
- `server/markdownPreview.ts`：有界读取，默认约 96 KiB 一页；返回真实字节范围、文件版本及结构续读游标。代码围栏和表头补全只影响展示，`rawContent` 可用于检验原文逐字节连续性。不会跳过未展示的原文。
- `DeferredContent`：视口前后约 900px 才挂载内容；离屏时保留测量高度并卸载昂贵的 Markdown/公式节点。源码框也使用相同的连续滚动分块。加载占位保留估算高度，防止文档暂时变矮而误触发整篇预加载。
- `ContinuousFilePreview`：滚到末尾附近自动读取后续内容，完整块缓存最多 12 块且内容最多 200 万字符；历史仅保存轻量游标，缓存淘汰后向上滚动仍会重新读取。文件变化时停止续读，保留当前视图，提示重新读取。
- `messageTextPolicy.ts`：用户正文、助手正文和推理文本在接收、历史整理、导入和响应中保持完整；历史响应继续按消息窗口预算分页，单条超预算正文单独返回。工具详情仍遵守独立的详情/产物预算，不把超大命令输出当作正文全部展开。旧版本已经截断并保存的文字不能凭空恢复。

## 安全与边界

正常数学表达式不再受原来的 8K 单式、24K 累计或 120 个总数限制。完整显示公式可跨越普通文件页的软预算，最长读取约 2 MiB 的单一结构。

安全控制仍保留：KaTeX `trust: false`、`maxExpand: 1000`、`maxSize: 100`，文件 HTML 继续 sanitize，Mermaid 继续 strict。单个表达式超过约 200 万字符、排版超过 5 秒或结果 HTML 超过 400 万字符时，只隔离该表达式，提供完整源码的连续阅读与复制，不影响其余公式。大于 2 MiB 且不能完整读取的单一结构用连续源码块呈现，不能伪装成已完整排版。

大 Mermaid 图仍保留图形复杂度限制，但失败或超限后可翻页阅读、复制全部图表源码。代码高亮仍有预算，超限时保留全部代码和源码分页。这里不承诺 KaTeX 支持完整 LaTeX，也不改变 PDF、图片、Word、Excel 的现有格式与解码限制。

目录针对当前已加载的 Markdown 内容；不会为了建立整个巨型文件的目录而先读完整文件。跨服务端文件页的引用定义、脚注或章节跳转不属于全文件索引，后续如需要应以版本绑定的后台索引实现。

## 回归检查

```sh
npm run typecheck
npm run test:markdown-plan
npm run test:math-worker
npm run test:markdown-pages
npm run test:agent-conversation
npm run test:file-preview-types
npm run test:file-preview-api
npm run test:docx-preview
npm run build
```

真实浏览器使用 `scripts/fixtures/markdown-preview-ui.html` 和 `scripts/check-markdown-preview-browser.js`，通过 Playwright CLI 的 `run-code --filename=...` 执行。包括三处共享公式渲染、代码排除、危险 HTML、500 个公式段落的连续滚动遍历、视口外节点释放、章节跳转、窄屏/深色、单式失败、15 块文件内容的自动续读、缓存淘汰后的向上恢复与文件变化处理，并确认没有可见翻页按钮。接口回归还验证长正文/推理经真实导入、保存与历史接口后尾部不丢失。测试使用隔离的临时数据目录，不访问用户会话数据；浏览器中的文件网络故障采用确定性模拟。
