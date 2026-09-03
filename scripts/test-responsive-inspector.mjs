import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [appSource, legacyStyles, shellStyles, entrySource] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/design/shell.css", import.meta.url), "utf8"),
  readFile(new URL("../src/main.tsx", import.meta.url), "utf8")
]);

assert.match(appSource, /className="mobile-inspector-backdrop"[\s\S]{0,240}setInspectorOpen\(false\)/, "narrow inspector needs a dismissible backdrop");
assert.match(appSource, /label="关闭文件区"[\s\S]{0,240}setInspectorOpen\(false\)/, "inspector header needs an explicit close action");
assert.match(legacyStyles, /@media \(max-width: 1050px\)[\s\S]+?\.inspector \{ display: none; \}/, "test must cover the legacy narrow-screen rule");
assert.match(shellStyles, /@media \(max-width: 1099px\)[\s\S]+?\.app-shell:not\(\.inspector-collapsed\) \.inspector[\s\S]+?display: flex;/, "shell layer must restore the inspector as a narrow-screen drawer");

const legacyImport = entrySource.indexOf('./styles.css');
const shellImport = entrySource.indexOf('./design/shell.css');
assert.ok(legacyImport >= 0 && shellImport > legacyImport, "shell overrides must load after legacy styles");

console.log("responsive inspector checks passed");
