import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

export const WORKBENCH_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    blockquote: [
      ...(defaultSchema.attributes?.blockquote || []),
      "dataMarkdownAlert"
    ]
  }
};

// Raw HTML is enabled only for workspace files, then reduced to GitHub's safe
// structural subset before KaTeX, highlighting, or React components run.
export const SAFE_FILE_HTML_REHYPE_PLUGINS: [
  typeof rehypeRaw,
  [typeof rehypeSanitize, typeof WORKBENCH_MARKDOWN_SANITIZE_SCHEMA]
] = [
  rehypeRaw,
  [rehypeSanitize, WORKBENCH_MARKDOWN_SANITIZE_SCHEMA]
];
