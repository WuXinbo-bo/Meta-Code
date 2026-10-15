import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHookRegistry, HookTimeoutError } from "../server/agents/hooks.ts";
import { loadCustomAgents, parseClaudeAgentMarkdown, parseCodexAgentToml } from "../server/agents/customAgents.ts";

const registry = createHookRegistry({ defaultTimeoutMs: 25, onError: () => undefined });
const seen = [];
registry.register({ id: "session-first", kind: "session", event: "created", priority: 10, handler: (context) => { seen.push(context.event); return "ok"; } });
registry.register({ id: "session-fails", kind: "session", event: "created", handler: () => { throw new Error("fixture failure"); } });
registry.register({ id: "session-timeout", kind: "session", event: "created", handler: async () => { await new Promise((resolve) => setTimeout(resolve, 100)); }, timeoutMs: 10 });
registry.register({ id: "tool-other", kind: "tool", event: "called", handler: () => seen.push("wrong-kind") });
const dispatched = await registry.dispatch({ kind: "session", event: "created", payload: { fixture: true } });
assert.deepEqual(seen, ["created"]);
assert.deepEqual(dispatched.executions.map((item) => item.status), ["completed", "failed", "timeout"]);
assert.equal(dispatched.degraded, true);
assert.equal(registry.list("tool").length, 1);
assert.equal(registry.unregister("tool-other"), true);
assert.equal(registry.unregister("missing"), false);
assert(HookTimeoutError);

const claude = parseClaudeAgentMarkdown("---\nname: reviewer\ndescription: Review changes\ntools: [Read, Grep]\n---\nReview the diff.");
assert.equal(claude.metadata.name, "reviewer");
assert.deepEqual(claude.metadata.tools, ["Read", "Grep"]);
assert.equal(claude.instructions, "Review the diff.");
const nested = parseClaudeAgentMarkdown('---\nname: hooked\ndescription: |\n  Review with native hooks\ndisallowedTools: [Write]\nhooks:\n  PreToolUse:\n    - matcher: Read\n      hooks:\n        - type: command\n          command: node hook.mjs\n---\nReview only.');
assert.match(nested.metadata.description, /native hooks/);
assert.deepEqual(nested.metadata.disallowedTools, ['Write']);
assert.equal(nested.metadata.hooks.PreToolUse[0].hooks[0].command, 'node hook.mjs');
assert.throws(() => parseClaudeAgentMarkdown('---\nname: !!js/function "function () {}"\n---\nUnsafe'), /unknown tag/);
const codex = parseCodexAgentToml('name = "builder"\ndescription = "Build it"\ntools = ["shell", "read"]\ninstructions = """\nImplement safely.\n"""');
assert.equal(codex.name, "builder");
assert.deepEqual(codex.tools, ["shell", "read"]);
assert.match(codex.instructions, /Implement safely/);

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-agents-"));
const userHome = path.join(root, "home");
const projectRoot = path.join(root, "project");
await fsp.mkdir(path.join(userHome, ".claude", "agents"), { recursive: true });
await fsp.mkdir(path.join(projectRoot, ".claude", "agents"), { recursive: true });
await fsp.mkdir(path.join(projectRoot, ".codex", "agents"), { recursive: true });
await fsp.writeFile(path.join(userHome, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: User version\n---\nUser instructions");
await fsp.writeFile(path.join(projectRoot, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Project version\n---\nProject instructions");
await fsp.writeFile(path.join(projectRoot, ".codex", "agents", "builder.toml"), 'name = "builder"\ninstructions = "Build the project"\ntools = ["shell"]');
await fsp.writeFile(path.join(projectRoot, ".codex", "agents", "broken.toml"), "name =\n");
await fsp.mkdir(path.join(projectRoot, ".claude", "agents", "quality"));
await fsp.writeFile(path.join(projectRoot, ".claude", "agents", "quality", "hooked.md"), '---\nname: hooked\ndescription: Native nested definition\nhooks:\n  PreToolUse:\n    - matcher: Read\n      hooks:\n        - type: command\n          command: node hook.mjs\n---\nRead only.');
const loaded = await loadCustomAgents({ projectRoot, userHome });
assert.equal(loaded.agents.length, 3);
assert.equal(loaded.agents.find((item) => item.id === "reviewer")?.scope, "project");
assert.equal(loaded.agents.find((item) => item.id === "builder")?.provider, "codex");
assert.equal(loaded.diagnostics.length, 1);
assert.equal(loaded.agents.find((item) => item.id === "hooked")?.metadata.hooks.PreToolUse[0].hooks[0].command, 'node hook.mjs');
// A nested link must not import definitions from outside the agent directory.
try {
  await fsp.symlink(path.join(userHome, '.claude', 'agents'), path.join(projectRoot, '.claude', 'agents', 'external'), 'junction');
  const withLink = await loadCustomAgents({ projectRoot, userHome });
  assert.equal(withLink.agents.length, 3);
  assert.ok(withLink.diagnostics.some((d) => d.code === 'unsafe-path'));
} catch (error) { if (error.code !== 'EPERM') throw error; }
await fsp.rm(root, { recursive: true, force: true });
console.log("Agent hooks and custom Agent configuration tests passed");
