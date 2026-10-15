import assert from "node:assert/strict";
import { BINARY_PREVIEW_EXTENSIONS, CODE_PREVIEW_LANGUAGES, TEXT_PREVIEW_EXTENSIONS, looksLikeTextPreview } from "../server/filePreviewTypes.ts";
import { fileKind } from "../src/files/fileTypes.ts";
import { fileScopeRoot } from "../src/files/fileScopeRoot.ts";
import { workspaceRelativePath } from "../src/markdown/localFileLinks.ts";

const matrix = {
  markdown: ["README.md", "notes.markdown"],
  document: ["report.docx"],
  pdf: ["paper.pdf"],
  image: ["plot.png", "photo.jpeg", "diagram.svg", "animation.webp"],
  table: ["data.csv", "workbook.xlsx"],
  code: ["app.ts", "view.tsx", "worker.js", "style.css", "index.html", "config.json", "script.ps1", "query.sql"],
  text: ["notes.txt", "settings.yaml", "tool.toml", "runtime.env"],
  binary: ["archive.zip", "program.exe", "library.dll", "unknown.custom", "LICENSE"]
};

for (const [kind, names] of Object.entries(matrix)) {
  for (const name of names) assert.equal(fileKind(name), kind, `${name} should open as ${kind}`);
}
for (const extension of Object.keys(CODE_PREVIEW_LANGUAGES)) assert.equal(fileKind(`fixture${extension}`), "code");
for (const extension of TEXT_PREVIEW_EXTENSIONS) assert.equal(fileKind(`fixture${extension}`), "text");
for (const extension of BINARY_PREVIEW_EXTENSIONS) assert.equal(fileKind(`fixture${extension}`), "binary");

assert.equal(looksLikeTextPreview(Buffer.from("plain UTF-8 中文\n")), true);
assert.equal(looksLikeTextPreview(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), false);
assert.equal(looksLikeTextPreview(Buffer.from([0xff, 0xfe, 0x00, 0x01])), false);

const scopeInventory = {
  workspaces: [{ id: "workspace", root: "/project" }],
  sessions: [{ id: "chat", workspaceId: "workspace" }, { id: "branch-chat", workspaceId: "workspace", executionRoot: "/runtime/worktree" }, { id: "temporary", workspaceId: "", executionRoot: "/runtime/temporary" }],
  workflows: [{ id: "direct", workspaceId: "workspace", executionRoot: "/project", workDirectory: "/wrong-legacy-alias" }, { id: "isolated", workspaceId: "workspace", executionRoot: "/runtime/isolated" }, { id: "legacy", workspaceId: "workspace", workDirectory: "/legacy-task" }]
};
assert.equal(fileScopeRoot("workspace", scopeInventory), "/project");
assert.equal(fileScopeRoot("chat", scopeInventory), "/project");
assert.equal(fileScopeRoot("branch-chat", scopeInventory), "/runtime/worktree", "a continued chat keeps its worktree root");
assert.equal(fileScopeRoot("temporary", scopeInventory), "/runtime/temporary");
assert.equal(fileScopeRoot("direct", scopeInventory), "/project", "execution root takes precedence over legacy alias");
assert.equal(fileScopeRoot("isolated", scopeInventory), "/runtime/isolated");
assert.equal(fileScopeRoot("legacy", scopeInventory), "/legacy-task");
assert.equal(fileScopeRoot("removed", scopeInventory), "");
assert.equal(fileScopeRoot("direct", null), "");

assert.equal(workspaceRelativePath("/runtime/worktree/docs/report.md", "/runtime/worktree", "readme.md"), "docs\\report.md");
assert.equal(workspaceRelativePath("file:///runtime/worktree/docs/report%20one.md#summary", "/runtime/worktree"), "docs\\report one.md");
assert.equal(workspaceRelativePath("/runtime/worktree-other/report.md", "/runtime/worktree"), null, "a sibling directory cannot masquerade as the execution root");
assert.equal(workspaceRelativePath("/project/report.md", "/runtime/worktree"), null, "links to the original project cannot escape the worktree scope");
assert.equal(workspaceRelativePath("/Runtime/worktree/report.md", "/runtime/worktree"), null, "POSIX root matching preserves case");
assert.equal(workspaceRelativePath("/runtime/worktree/../outside.md", "/runtime/worktree"), null);
assert.equal(workspaceRelativePath("../report.md", "/runtime/worktree", "docs/readme.md"), "report.md");
assert.equal(workspaceRelativePath("../../report.md", "/runtime/worktree", "docs/readme.md"), null);
assert.equal(workspaceRelativePath("C:\\Runtime\\worktree\\docs\\report.md", "c:\\runtime\\worktree"), "docs\\report.md");
assert.equal(workspaceRelativePath("file:///C:/Runtime/worktree/report.md", "C:/Runtime/worktree"), "report.md");
assert.equal(workspaceRelativePath("https://example.com/report.md", "/runtime/worktree"), null);
assert.equal(workspaceRelativePath("/report.md", "/"), "report.md");

console.log("File preview extension parity, execution roots, and bounded local Markdown links OK");
