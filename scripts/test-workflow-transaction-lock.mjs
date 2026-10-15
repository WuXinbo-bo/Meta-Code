import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withTransactionFileLock } from "../server/plugins/orchestration/transactionFile.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-lock-"));
const target = path.join(root, "transaction.json");
const lock = `${target}.lock`;
const moduleUrl = pathToFileURL(fileURLToPath(new URL("../server/plugins/orchestration/transactionFile.ts", import.meta.url))).href;
const run = (source) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (part) => { output += part; }); child.stderr.on("data", (part) => { output += part; });
  child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(output)));
});
try {
  const liveOwner = JSON.stringify({ pid: process.pid, token: "existing-owner" });
  fs.writeFileSync(lock, liveOwner);
  fs.utimesSync(lock, new Date(0), new Date(0));
  const start = performance.now();
  assert.throws(() => withTransactionFileLock(target, () => assert.fail("must not steal live lock")), /锁超时/);
  assert.ok(performance.now() - start < 1500, "lock contention must not block the host for many seconds");
  assert.equal(fs.readFileSync(lock, "utf8"), liveOwner, "age alone never makes a live owner stale");
  fs.unlinkSync(lock);
  withTransactionFileLock(target, () => {
    const metadata = JSON.parse(fs.readFileSync(lock, "utf8"));
    assert.equal(metadata.pid, process.pid);
    assert.ok(metadata.token);
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, liveOwner);
  });
  assert.equal(fs.readFileSync(lock, "utf8"), liveOwner, "release cannot delete a replacement token");
  fs.unlinkSync(lock);

  await run(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(lock)}, JSON.stringify({pid:process.pid,token:'dead-owner'}));`);
  withTransactionFileLock(target, () => fs.writeFileSync(target, "0"));
  assert.equal(fs.existsSync(lock), false, "confirmed dead owner is reclaimed");
  const contender = `
    import fs from 'node:fs';
    import {withTransactionFileLock} from ${JSON.stringify(moduleUrl)};
    for(let i=0;i<20;i++) {
      let done=false;
      for(let retry=0;retry<20&&!done;retry++) {
        try { withTransactionFileLock(${JSON.stringify(target)},()=>{
          const count=Number(fs.readFileSync(${JSON.stringify(target)},'utf8'));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
          fs.writeFileSync(${JSON.stringify(target)},String(count+1));
        }); done=true; }
        catch(e) { if(!String(e).includes('锁超时'))throw e; }
      }
      if(!done)throw new Error('lock starvation');
    }`;
  await Promise.all(Array.from({ length: 4 }, () => run(contender)));
  assert.equal(fs.readFileSync(target, "utf8"), "80", "concurrent processes never overlap a transaction");
  assert.equal(fs.existsSync(lock), false);
  console.log("workflow transaction locks: live ownership, short contention, dead-owner recovery and multi-process exclusion passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
