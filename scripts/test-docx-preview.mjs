import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { DOCX_PREVIEW_INPUT_BYTES, clearDocxPreviewCache, previewDocx } from "../server/docxPreview.ts";

const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-docx-preview-"));
const target = path.join(temporaryRoot, "sample.docx");

try {
  const archive = new JSZip();
  archive.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);
  archive.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  archive.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
</w:styles>`);
  archive.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rUnsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
</Relationships>`);
  archive.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Preview title</w:t></w:r></w:p>
    <w:p><w:r><w:t>Readable body</w:t></w:r></w:p>
    <w:p><w:hyperlink r:id="rUnsafe"><w:r><w:t>Unsafe link</w:t></w:r></w:hyperlink></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`);
  await fsp.writeFile(target, await archive.generateAsync({ type: "nodebuffer" }));
  const stat = await fsp.stat(target);
  const first = await previewDocx(target, stat.size, stat.mtimeMs);
  assert.match(first.html, /Preview title/);
  assert.match(first.html, /Readable body/);
  assert.doesNotMatch(first.html, /javascript:/i);

  const second = await previewDocx(target, stat.size, stat.mtimeMs);
  assert.deepEqual(second, first, "the same file revision should be served from the preview cache");
  await assert.rejects(previewDocx(target, DOCX_PREVIEW_INPUT_BYTES + 1, stat.mtimeMs), /安全预览预算/);
  console.log("DOCX preview isolation, sanitization, and cache contracts OK");
} finally {
  clearDocxPreviewCache();
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
