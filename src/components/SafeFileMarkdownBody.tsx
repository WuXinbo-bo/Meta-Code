import { LazyMarkdownBody, type MarkdownBodyProps } from "./LazyMarkdownBody";
import { SAFE_FILE_HTML_REHYPE_PLUGINS } from "../markdown/safeFileHtml";

type SafeFileMarkdownBodyProps = Omit<MarkdownBodyProps, "additionalRehypePlugins">;

export function SafeFileMarkdownBody(props: SafeFileMarkdownBodyProps) {
  return <LazyMarkdownBody {...props} additionalRehypePlugins={SAFE_FILE_HTML_REHYPE_PLUGINS} />;
}

export default SafeFileMarkdownBody;
