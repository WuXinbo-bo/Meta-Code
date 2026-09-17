import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-preview-api-"));
const dataRoot = path.join(temporaryRoot, "data");
const workspaceRoot = path.join(temporaryRoot, "workspace");
const apiToken = "file-preview-test-token-0123456789";
await fsp.mkdir(workspaceRoot, { recursive: true });

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(selected));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];
const child = spawn(process.execPath, [path.join(projectRoot, "dist-server", "index.js")], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: String(port),
    METACODE_HOME: dataRoot,
    WORKSPACE_ROOT: temporaryRoot,
    METACODE_API_TOKEN: apiToken
  },
  windowsHide: true,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated backend exited early (${child.exitCode})\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The isolated backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`isolated backend did not become ready\n${output.join("")}`);
}

async function json(pathname, expectedStatus = 200, options) {
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { "X-MetaCode-Api-Token": apiToken, ...(options?.headers || {}) } });
  const body = await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${pathname}: ${JSON.stringify(body)}`);
  return body;
}

try {
  await fsp.writeFile(path.join(workspaceRoot, "README.md"), "# Preview\n\n$$x^2$$\n\n```mermaid\ngraph TD; A-->B\n```\n");
  await fsp.writeFile(path.join(workspaceRoot, "app.ts"), "export const ready: boolean = true;\n");
  await fsp.writeFile(path.join(workspaceRoot, "settings.yaml"), "theme: light\n");
  await fsp.writeFile(path.join(workspaceRoot, "LICENSE"), "Local preview license\n");
  await fsp.writeFile(path.join(workspaceRoot, "large.custom"), "line content\n".repeat(60_000));
  await fsp.writeFile(path.join(workspaceRoot, "blob.custom"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]));
  await fsp.writeFile(path.join(workspaceRoot, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  await fsp.writeFile(path.join(workspaceRoot, "valid.pdf"), "%PDF-1.4\n%%EOF\n");
  await fsp.writeFile(path.join(workspaceRoot, "valid.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await fsp.writeFile(path.join(workspaceRoot, "broken.docx"), "not a Word archive");
  await fsp.writeFile(path.join(workspaceRoot, "broken.pdf"), "not a PDF");
  await fsp.writeFile(path.join(workspaceRoot, "broken.png"), "not a PNG");

  await waitForHealth();
  const workspace = await json("/api/workspaces", 201, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: workspaceRoot, name: "Preview matrix" })
  });
  const preview = async (name, status = 200) => json(`/api/workspaces/${encodeURIComponent(workspace.id)}/file?path=${encodeURIComponent(name)}`, status);

  const markdown = await preview("README.md");
  assert.equal(markdown.kind, "markdown");
  assert.match(markdown.content, /mermaid/);
  assert.match(markdown.content, /x\^2/);
  assert.equal(typeof markdown.version, "string");
  const largeMarkdownSource = "```ts\n" + Array.from({ length: 10000 }, (_, i) => `const item${i} = '中文内容';\n`).join("") + "```\n\n$$\nx^2\n$$\n";
  await fsp.writeFile(path.join(workspaceRoot, "large.md"), largeMarkdownSource);
  let mdPage = await preview("large.md");
  const firstPage = mdPage;
  let joined = mdPage.rawContent;
  for (let i = 0; mdPage.nextOffset != null && i < 100; i++) {
    mdPage = await json(`/api/workspaces/${encodeURIComponent(workspace.id)}/file?path=large.md&offset=${mdPage.nextOffset}&continuation=${encodeURIComponent(mdPage.nextContinuation || "")}&version=${encodeURIComponent(firstPage.version)}`);
    joined += mdPage.rawContent;
  }
  assert.equal(mdPage.nextOffset, null);
  assert.equal(joined, largeMarkdownSource, "HTTP pagination retains every source byte");
  await fsp.appendFile(path.join(workspaceRoot, "large.md"), "changed");
  const conflict = await json(`/api/workspaces/${encodeURIComponent(workspace.id)}/file?path=large.md&offset=${firstPage.nextOffset}&version=${encodeURIComponent(firstPage.version)}`, 400);
  assert.match(conflict.error, /文件已发生变化/);
  const narrative = "完整数学正文 $x^2$。\n\n".repeat(22000) + "正文尾部验证点";
  const reasoning = "推理公式 $y^2$。\n\n".repeat(8000) + "推理尾部验证点";
  const imported = await json("/api/session-management/import", 201, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, kind: "metacode-session", session: { title: "Long Markdown integrity", engine: "codex", workspaceId: workspace.id, messages: [
      { role: "user", text: narrative }, { role: "assistant", text: narrative }, { role: "event", eventType: "reasoning", text: reasoning }
    ] } })
  });
  assert.equal(imported.session.messages[1].text, narrative, "import/persistence path retains long assistant text");
  const history = await json(`/api/sessions/${imported.session.id}/messages?limit=10`);
  assert.equal(history.messages[0].text, narrative);
  assert.equal(history.messages[1].text, narrative);
  assert.equal(history.messages[2].text, reasoning, "reasoning uses the same lossless renderer contract");
  assert.equal((await preview("app.ts")).kind, "code");
  assert.equal((await preview("settings.yaml")).kind, "text");
  assert.equal((await preview("LICENSE")).kind, "text");
  assert.equal((await preview("blob.custom")).kind, "binary");
  assert.equal((await preview("archive.zip")).kind, "binary");
  const large = await preview("large.custom");
  assert.equal(large.previewMode, "plain-paged");
  assert.equal(typeof large.nextOffset, "number");
  assert.match((await preview("broken.docx", 400)).error, /Word|archive|zip/i);
  assert.match((await preview("broken.pdf", 400)).error, /PDF.*无效|损坏/);
  assert.match((await preview("broken.png", 400)).error, /PNG.*无效|损坏/);
  const pdfResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/file?path=valid.pdf`, { headers: { "X-MetaCode-Api-Token": apiToken } });
  assert.equal(pdfResponse.status, 200);
  assert.match(pdfResponse.headers.get("content-type") || "", /application\/pdf/);
  const imageResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/file?path=valid.png`, { headers: { "X-MetaCode-Api-Token": apiToken } });
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get("content-type") || "", /image\/png/);

  console.log("File preview API matrix handles rich, source, large, binary, and corrupt files safely");
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 10_000))
  ]);
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
