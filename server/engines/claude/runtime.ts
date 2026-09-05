import fs from "node:fs";
import path from "node:path";
import { agentNodeExecutable } from "../../runtime/nodeEnvironment.js";

export function resolveClaudeCommand(candidate: string) {
  if (/\.(?:m?js)$/i.test(candidate)) return { executable: agentNodeExecutable(), args: [candidate] };
  if (/\.cmd$/i.test(candidate)) {
    const nearby = [
      path.resolve(path.dirname(candidate), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
      path.resolve(path.dirname(candidate), "..", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
      path.resolve(path.dirname(candidate), "..", "@anthropic-ai", "claude-code", "cli.js"),
      path.resolve(path.dirname(candidate), "node_modules", "@anthropic-ai", "claude-code", "cli.js")
    ].find((item) => fs.existsSync(item));
    if (nearby) return /\.(?:m?js)$/i.test(nearby)
      ? { executable: agentNodeExecutable(), args: [nearby] }
      : { executable: nearby, args: [] as string[] };
    if (process.platform === "win32") return {
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", candidate]
    };
  }
  return { executable: candidate, args: [] as string[] };
}
