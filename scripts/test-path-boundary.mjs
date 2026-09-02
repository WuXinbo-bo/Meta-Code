import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertPathInsideRoot } from "../server/pathBoundary.ts";
import { RestrictedAcpClientServices } from "../server/providers/acp/services.ts";

const base = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-boundary-"));
const root = path.join(base, "workspace");
const outside = path.join(base, "outside");
await fsp.mkdir(root);
await fsp.mkdir(outside);
await fsp.writeFile(path.join(outside, "secret.txt"), "outside-secret");

try {
  assert.equal(assertPathInsideRoot(root, path.join(root, "new", "file.txt"), { allowMissing: true }), path.join(root, "new", "file.txt"));
  assert.throws(() => assertPathInsideRoot(root, path.join(base, "outside", "secret.txt")), /工作区/);

  const link = path.join(root, "escape");
  try {
    await fsp.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
  }
  if (fs.existsSync(link)) {
    assert.throws(() => assertPathInsideRoot(root, path.join(link, "secret.txt")), /符号链接|目录联接/);
    const services = new RestrictedAcpClientServices({ roots: [root], allowWrite: true, allowTerminal: true });
    await assert.rejects(services.readTextFile({ sessionId: "test", path: path.join(link, "secret.txt") }), /越过工作区边界/);
    await assert.rejects(services.writeTextFile({ sessionId: "test", path: path.join(link, "new.txt"), content: "leak" }), /越过工作区边界/);
    await assert.rejects(services.createTerminal({ sessionId: "test", cwd: link, command: process.execPath, args: ["-e", "process.exit(0)"] }), /越过工作区边界/);
    assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
    await services.close();
  }
  console.log("canonical workspace boundary rejects traversal and link/junction escapes");
} finally {
  await fsp.rm(base, { recursive: true, force: true });
}

