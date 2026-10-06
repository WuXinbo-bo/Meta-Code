import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IncrementalJsonl } from "../server/incrementalJsonl.ts";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-jsonl-"));
const file = path.join(root, "agent.jsonl");
let consumed = 0;
const reader = new IncrementalJsonl(
  () => ({ records: [], indexes: [] }),
  (state, record, index) => { consumed++; state.records.push(record); state.indexes.push(index); },
  2
);
try {
  await fsp.writeFile(file, '{"id":1,"text":"你好"}\n{"id":');
  assert.deepEqual((await reader.read(file)).records, [{ id: 1, text: "你好" }]);
  assert.equal(consumed, 1);
  const unchanged = await reader.read(file);
  assert.equal(consumed, 1, "unchanged transcripts must not parse old records again");

  await fsp.appendFile(file, '2}\n{"id":3}\n');
  const [left, right] = await Promise.all([reader.read(file), reader.read(file)]);
  assert.equal(left, right, "concurrent readers share one parse and snapshot");
  assert.equal(left, unchanged, "append folds into the retained bounded state");
  assert.deepEqual(left.records.map((record) => record.id), [1, 2, 3]);
  assert.deepEqual(left.indexes, [0, 1, 2]);
  assert.equal(consumed, 3);

  await fsp.appendFile(file, '{bad}\n{"id":4}');
  assert.deepEqual((await reader.read(file)).records.map((record) => record.id), [1, 2, 3, 4]);
  await fsp.appendFile(file, '\n{"id":5}\n');
  assert.equal((await reader.read(file)).records.filter((record) => record.id === 4).length, 1, "a complete final JSON record without newline is not replayed");

  await fsp.writeFile(file, '{"id":6}\n');
  assert.deepEqual((await reader.read(file)).records, [{ id: 6 }], "truncation starts a fresh transcript");
  const replacement = path.join(root, "replacement.jsonl");
  await fsp.writeFile(replacement, '{"id":7}\n');
  await fsp.rename(replacement, file);
  assert.deepEqual((await reader.read(file)).records, [{ id: 7 }], "atomic replacement invalidates by inode");

  // A multi-byte UTF-8 character and JSON record may cross a 64KB read boundary.
  const long = `${JSON.stringify({ id: 8, text: "x".repeat(65_510) + "世界" })}\n`;
  await fsp.writeFile(file, long);
  const large = await reader.read(file);
  assert.equal(large.records.at(-1).text, "x".repeat(65_510) + "世界");
  assert.equal(large.records.at(-1).id, 8);
  console.log("Incremental JSONL append, partial writes, single-flight, replacement and UTF-8 passed");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
