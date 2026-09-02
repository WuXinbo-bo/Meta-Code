import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretVault } from "../server/secretVault.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-vault-"));
const file = path.join(root, "secrets.dat");
const expected = {
  codexApiKey: "codex-secret",
  claudeApiKey: "claude-secret",
  mcp: { demo: { env: { TOKEN: "mcp-secret" }, headers: { Authorization: "Bearer secret" } } },
  providerConnections: { "profile-1": { apiKey: "provider-secret", secretEnv: { GEMINI_API_KEY: "gemini-secret" } } }
};
new SecretVault(file, true).save(expected);
const raw = fs.readFileSync(file, "utf8");
assert.doesNotMatch(raw, /codex-secret|claude-secret|mcp-secret|provider-secret|gemini-secret|Bearer secret/);
assert.deepEqual(new SecretVault(file, true).load(), expected);
assert.throws(() => {
  const envelope = JSON.parse(raw);
  envelope.payload = `${envelope.payload.slice(0, -2)}AA`;
  fs.writeFileSync(file, JSON.stringify(envelope));
  new SecretVault(file, true).load();
});
fs.rmSync(root, { recursive: true, force: true });
console.log("encrypted secret vault tests passed");
