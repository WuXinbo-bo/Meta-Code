import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicFiles = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "desktop/README.md",
  "docs/architecture/README.md",
  "docs/architecture/overview.md",
  "docs/architecture/cli-runtime.md",
  "docs/architecture/data-and-runtime.md",
  "docs/architecture/codex-native-link.md",
  "docs/architecture/task-orchestration.md",
  "docs/architecture/task-orchestration-ui.md",
  "docs/development/README.md",
  "docs/development/setup.md",
  "docs/development/repository-boundaries.md",
  "docs/development/release-and-update.md",
  ".github/workflows/release.yml",
  "docs/user-guide/README.md",
  "docs/user-guide/delegation.md",
  "docs/user-guide/task-orchestration.md"
];

const documents = await Promise.all(publicFiles.map(async (relative) => ({
  relative,
  text: await readFile(path.join(root, relative), "utf8")
})));
const combined = documents.map((document) => document.text).join("\n");
const readme = documents.find((document) => document.relative === "README.md")?.text || "";
const appSource = await readFile(path.join(root, "src", "App.tsx"), "utf8");

assert.doesNotMatch(combined, /[A-Z]:\\(?:Users|ModelX)\\/i, "public docs must not contain machine-specific Windows paths");
assert.doesNotMatch(appSource, /[A-Z]:\\(?:Users|ModelX)\\/i, "public UI defaults must not contain machine-specific Windows paths");
assert.doesNotMatch(combined, /127\.0\.0\.1:4319|VITE_SKIP_AUTH|Claude-Codex Workbench/, "public docs must not describe retired runtime behavior");
assert.match(readme, /<img src="\.\/public\/meta-code\.svg"[^>]+alt="Meta Code Logo"/, "README must render the official product logo");
assert.match(readme, /prefers-color-scheme: dark[^>]+meta-code-readme-dark\.svg/, "README logo must remain visible in GitHub dark mode");
assert.match(readme, /## 两种特色工作方式[\s\S]+委派协议[\s\S]+Meta 任务编排/, "README must introduce both signature work modes near the top");
assert.match(readme, /```mermaid[\s\S]+ACP Client Host/, "README must include a visual architecture diagram");
await access(path.join(root, "docs", "images", "meta-code-readme-dark.svg"));

for (const { relative, text } of documents) {
  const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  for (const link of links) {
    if (/^(?:https?:|mailto:|#)/i.test(link)) continue;
    const target = decodeURIComponent(link.split("#", 1)[0]);
    if (!target || target.includes("<repository-url>")) continue;
    const resolved = path.resolve(path.dirname(path.join(root, relative)), target);
    assert.ok(resolved === root || resolved.startsWith(`${root}${path.sep}`), `${relative} links outside the repository: ${link}`);
    await access(resolved);
    assert.ok((await stat(resolved)).isFile() || (await stat(resolved)).isDirectory(), `${relative} has an invalid link: ${link}`);
  }
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assert.equal(packageJson.name, "meta-code-workbench");
assert.equal(packageJson.productName, "Meta Code");
assert.equal(packageJson.version, "0.1.2");
assert.equal(packageJson.license, "Apache-2.0");
assert.equal(packageJson.repository?.url, "git+https://github.com/WuXinbo-bo/Meta-Code.git");

const releaseConfig = JSON.parse(await readFile(path.join(root, "release.config.json"), "utf8"));
assert.equal(releaseConfig.githubRepository, "WuXinbo-bo/Meta-Code");
assert.equal(releaseConfig.manifestUrls.stable, "https://github.com/WuXinbo-bo/Meta-Code/releases/latest/download/latest.json");
assert.equal(releaseConfig.manifestUrls.beta, "");
assert.equal(releaseConfig.schemaVersion, 2);
assert.equal(releaseConfig.dataCompatibility.writesTo, releaseConfig.dataSchemaVersion);
assert.equal(releaseConfig.manifestSigning.required, true);
assert.ok(releaseConfig.manifestSigning.trustedKeys["meta-code-release-2026"]);

const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
for (const entry of [".claude-codex/", ".local-release-notes/", ".runtime/", "*.db", "*.key"]) assert.match(gitignore, new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

console.log("repository readiness checks passed");
