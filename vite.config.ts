import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { defaultWorkbenchDataDir } from "./server/appPaths";
import { loadOrCreateDevelopmentApiToken, LOCAL_API_TOKEN_HEADER } from "./server/localApiSecurity";

const webPort = Number(process.env.WORKBENCH_WEB_PORT || 4339);
const apiPort = Number(process.env.WORKBENCH_API_PORT || process.env.PORT || 4338);
const developmentDataDir = process.env.METACODE_HOME
  || (process.env.METACODE_PROFILE ? `${defaultWorkbenchDataDir()}-${process.env.METACODE_PROFILE}` : defaultWorkbenchDataDir());
const apiToken = loadOrCreateDevelopmentApiToken(developmentDataDir);

function packageChunk(id: string) {
  if (!id.includes("node_modules")) return undefined;
  // Rollup receives POSIX paths on macOS/Linux and backslash paths on
  // Windows. Normalizing once keeps the split rules portable.
  const normalized = id.replaceAll("\\", "/");
  const packagePath = normalized.split("/node_modules/").pop() || "";
  if (/^(?:react|react-dom|scheduler)(?:\/|$)/.test(packagePath)) return "vendor-react";
  if (/^lucide-react(?:\/|$)/.test(packagePath)) return "vendor-icons";
  if (/^@tanstack\/react-virtual(?:\/|$)/.test(packagePath)) return "vendor-virtual";

  // These packages are only reached by deferred surfaces (MarkdownBody and
  // FilePreview). Keeping them in stable vendor chunks prevents them from
  // inflating the app shell and lets browsers cache them independently.
  if (/^(?:react-markdown|remark-|rehype-|unified|vfile|micromark|mdast-|hast-|unist-|decode-named-character-reference|character-entities|property-information|space-separated-tokens|comma-separated-tokens|parse-entities|html-void-elements|trim-lines|longest-streak|ccount|bail|devlop)(?:\/|$)/.test(packagePath)) {
    return "vendor-markdown";
  }
  // Keep the global highlight.js stylesheet in the entry CSS; only the
  // runtime highlighter and language grammars belong in the deferred chunk.
  if (/^highlight\.js(?:\/|$)/.test(packagePath) && !packagePath.endsWith(".css")) return "vendor-highlight";
  if (/^(?:mammoth|read-excel-file|csv-parse|yauzl)(?:\/|$)/.test(packagePath)) return "vendor-file-formats";
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          return packageChunk(id);
        }
      }
    }
  },
  server: {
    port: webPort,
    watch: {
      ignored: ["**/.runtime/**", "**/output/**", "**/release-artifacts/**", "**/dist/**", "**/dist-server/**", "**/.local-release-notes/**", "**/.workbench-data/**"]
    },
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, headers: { [LOCAL_API_TOKEN_HEADER]: apiToken } }
    }
  }
});
