import katex from "katex";

self.onmessage = (event: MessageEvent<{ source: string; display: boolean }>) => {
  try {
    const html = katex.renderToString(event.data.source, {
      displayMode: event.data.display, trust: false, throwOnError: true,
      maxExpand: 1000, maxSize: 100, output: "htmlAndMathml"
    });
    if (html.length > 4_000_000) self.postMessage({ error: "此公式排版结果过大，已保留完整源码供分段阅读。" });
    else self.postMessage({ html });
  } catch {
    self.postMessage({ error: "该公式暂时无法排版，可查看完整公式源码。" });
  }
};
