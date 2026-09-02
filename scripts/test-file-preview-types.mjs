import assert from "node:assert/strict";
import { BINARY_PREVIEW_EXTENSIONS, CODE_PREVIEW_LANGUAGES, TEXT_PREVIEW_EXTENSIONS, looksLikeTextPreview } from "../server/filePreviewTypes.ts";
import { fileKind } from "../src/files/fileTypes.ts";

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

console.log("File preview extension parity and unknown-file fallback contracts OK");
