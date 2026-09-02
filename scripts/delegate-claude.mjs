#!/usr/bin/env node
import fs from "node:fs/promises";
import crypto from "node:crypto";

function help() {
  console.log([
    "Claude-Codex Claude 独立子任务桥接",
    "",
    "用法：",
    "  node scripts/delegate-claude.mjs --file .claude-codex/tasks/review-001.json",
    "  node scripts/delegate-claude.mjs --task \"审查当前架构\" --mode review --cwd .",
    "",
    "JSON 字段：taskId、nickname、mode、prompt、cwd、acceptance（字符串数组）"
  ].join("\n"));
}

function argsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg.startsWith("--")) result[arg.slice(2)] = argv[index + 1] ?? "";
    if (arg.startsWith("--")) index += 1;
  }
  return result;
}

const args = argsFrom(process.argv.slice(2));
if (args.help) { help(); process.exit(0); }
if (Number(process.env.CLAUDE_WORKER_DEPTH || 0) >= 1) {
  console.error("Claude 子 Agent 不允许递归委派 Claude");
  process.exit(2);
}

let task = {};
if (args.file) task = JSON.parse(await fs.readFile(String(args.file), "utf8"));
const prompt = String(args.task || task.prompt || "").trim();
if (!prompt) { console.error("缺少 --task，或任务文件中没有 prompt"); process.exit(2); }

const url = process.env.CLAUDE_WORKER_BRIDGE_URL || "";
const token = process.env.CLAUDE_WORKER_BRIDGE_TOKEN || "";
const parentTaskId = process.env.CLAUDE_WORKBENCH_PARENT_TASK_ID || "";
if (!url || !token || !parentTaskId) {
  console.error("缺少 Claude 子任务桥环境；请从 Claude-Codex 工作台的主 Claude 会话内调用");
  process.exit(2);
}
const acceptance = args.acceptance
  ? String(args.acceptance).split(/\r?\n|\|/).map((item) => item.trim()).filter(Boolean)
  : Array.isArray(task.acceptance)
    ? task.acceptance.map((item) => String(item).trim()).filter(Boolean)
    : String(task.acceptance || "").split(/\r?\n|\|/).map((item) => item.trim()).filter(Boolean);
const requestedMode = String(args.mode || task.mode || "analysis");
const mode = ["analysis", "review", "implementation"].includes(requestedMode) ? requestedMode : "analysis";
const cwd = String(args.cwd || task.cwd || process.cwd());
const idempotencyKey = String(args.idempotencyKey || task.idempotencyKey || task.taskId || crypto.createHash("sha256").update(JSON.stringify({ provider: "claude", parentTaskId, cwd, prompt, acceptance, mode })).digest("hex"));
const payload = {
  taskId: String(args.taskId || task.taskId || `claude-worker-${idempotencyKey.slice(0, 16)}`),
  idempotencyKey,
  parentTaskId,
  nickname: String(args.nickname || task.nickname || "Claude 子 Agent"),
  mode,
  cwd,
  prompt,
  acceptance,
  depth: Number(process.env.CLAUDE_WORKER_DEPTH || 0)
};

try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-worker-token": token },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) { console.error(data.error || `Claude 子任务失败（HTTP ${response.status}）`); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
