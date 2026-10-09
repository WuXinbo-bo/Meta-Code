import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type * as Integrity from "./fileIntegrity.js";
import type { calculateWorkflowPlanImpact } from "./stateFiles.js";

type Methods = Pick<typeof Integrity, "buildWorkflowFileIntegrity" | "workflowResultFileIntegrityIssue" | "workflowCompletedFileIntegrityIssues"> & { calculateWorkflowPlanImpact: typeof calculateWorkflowPlanImpact };
type Job = { method: keyof Methods; args: unknown[]; resolve: (value: any) => void; reject: (error: Error) => void };
const queue: Job[] = [];
let worker: Worker | null = null;
let current: Job | null = null;
let idle: NodeJS.Timeout | undefined;

// Integrity still checks every declared output (including ignored directories).
// Move hashing/recursive I/O off the HTTP event loop, without weakening evidence.
const workerSource = `
const {parentPort,workerData}=require('node:worker_threads');
const modulePromise=workerData.tsx ? import(workerData.tsx).then(m=>m.tsImport(workerData.moduleUrl,workerData.parentUrl)) : import(workerData.moduleUrl);
const statePromise=workerData.tsx ? import(workerData.tsx).then(m=>m.tsImport(workerData.stateUrl,workerData.parentUrl)) : import(workerData.stateUrl);
parentPort.on('message', async ({method,args})=>{
  try { const m=await (method==='calculateWorkflowPlanImpact' ? statePromise : modulePromise); parentPort.postMessage({ok:true,value:m[method](...args)}); }
  catch(error) { parentPort.postMessage({ok:false,error:error instanceof Error ? error.message : String(error)}); }
});`;

function pump() {
  if (current || !queue.length) return;
  if (idle) clearTimeout(idle);
  if (!worker) {
    const compiled = new URL("./fileIntegrity.js", import.meta.url);
    const source = !fs.existsSync(compiled);
    const moduleUrl = source ? new URL("./fileIntegrity.ts", import.meta.url) : compiled;
    const instance = new Worker(workerSource, { eval: true, workerData: {
      moduleUrl: moduleUrl.href, parentUrl: import.meta.url,
      stateUrl: new URL(source ? "./stateFiles.ts" : "./stateFiles.js", import.meta.url).href,
      tsx: source ? pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href : null
    }, execArgv: [] });
    worker = instance;
    const fail = (error: Error) => {
      if (worker !== instance) return;
      const pending = current; current = null; worker = null;
      void instance.terminate(); pending?.reject(error); pump();
    };
    instance.on("error", fail);
    instance.on("exit", (code) => { if (worker === instance) fail(new Error(`文件完整性检查进程退出（${code}）`)); });
    instance.on("message", (reply: { ok: boolean; value?: unknown; error?: string }) => {
      if (worker !== instance) return;
      const pending = current; current = null;
      if (reply.ok) pending?.resolve(reply.value); else pending?.reject(new Error(reply.error || "文件完整性检查失败"));
      if (queue.length) pump();
      else idle = setTimeout(() => { if (!current && worker === instance) { worker = null; void instance.terminate(); } }, 250).unref();
    });
  }
  current = queue.shift()!;
  try { worker.postMessage({ method: current.method, args: current.args }); }
  catch (error) { const pending = current; current = null; pending.reject(error instanceof Error ? error : new Error(String(error))); pump(); }
}

function run<K extends keyof Methods>(method: K, args: Parameters<Methods[K]>): Promise<ReturnType<Methods[K]>> {
  return new Promise((resolve, reject) => { queue.push({ method, args, resolve, reject }); pump(); });
}

export const buildWorkflowFileIntegrityAsync = (...args: Parameters<Methods["buildWorkflowFileIntegrity"]>) => run("buildWorkflowFileIntegrity", args);
export const workflowResultFileIntegrityIssueAsync = (...args: Parameters<Methods["workflowResultFileIntegrityIssue"]>) => run("workflowResultFileIntegrityIssue", args);
export const workflowCompletedFileIntegrityIssuesAsync = (...args: Parameters<Methods["workflowCompletedFileIntegrityIssues"]>) => run("workflowCompletedFileIntegrityIssues", args);
export const calculateWorkflowPlanImpactAsync = (...args: Parameters<Methods["calculateWorkflowPlanImpact"]>) => run("calculateWorkflowPlanImpact", args);
