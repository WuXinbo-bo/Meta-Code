import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { armDeadline, deadlineFromMinutes, remainingDeadlineMs, timeoutMinutes, timeoutReason } from "../dist-server/orchestration/timeouts.js";
import { registerProcessTree, terminateProcessTree } from "../dist-server/processTree.js";

assert.equal(timeoutMinutes("bad"), 120);
assert.equal(timeoutMinutes(0), 120);
assert.equal(timeoutMinutes(0.2), 1);
assert.ok(remainingDeadlineMs(deadlineFromMinutes(1)) > 59_000);
const controller = new AbortController();
const timer = armDeadline(controller, new Date(Date.now() + 40).toISOString(), "main", "测试任务");
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(controller.signal.aborted, true);
assert.equal(timeoutReason(controller.signal)?.scope, "main");
if (timer) clearTimeout(timer);
console.log("unified timeout contracts OK");

const parentSource = [
  "const {spawn}=require('child_process');",
  "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
  "console.log(child.pid);",
  "setInterval(()=>{},1000);"
].join("");
const parent = spawn(process.execPath, ["-e", parentSource], { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" });
registerProcessTree("resilience-test", parent);
const grandchildPid = Number(await new Promise((resolve, reject) => {
  let output = "";
  const timeout = setTimeout(() => reject(new Error("child pid timeout")), 5_000);
  parent.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
    const value = Number(output.trim());
    if (value > 0) { clearTimeout(timeout); resolve(value); }
  });
}));
terminateProcessTree(parent);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};
const waitForExit = async (pid, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
await Promise.all([waitForExit(parent.pid), waitForExit(grandchildPid)]);
assert.equal(alive(parent.pid), false, "parent process should be terminated");
assert.equal(alive(grandchildPid), false, "grandchild process should be terminated");
console.log("process tree cleanup OK");
