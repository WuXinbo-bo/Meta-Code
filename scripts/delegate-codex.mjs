#!/usr/bin/env node
import fs from "node:fs/promises";
import crypto from "node:crypto";

function help() {
  console.log([
    "Claude-Codex Codex 委派桥接",
    "",
    "用法：",
    "  node scripts/delegate-codex.mjs --file .claude-codex/tasks/task-001.json",
    "  node scripts/delegate-codex.mjs --task \"实现并测试登录接口\" --cwd .",
    "",
    "JSON 文件字段：taskId、prompt、cwd、acceptance（字符串数组）"
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
if (args.help) {
  help();
  process.exit(0);
}

let task = {};
if (args.file) {
  const content = await fs.readFile(String(args.file), "utf8");
  task = JSON.parse(content);
}

const prompt = String(args.task || task.prompt || "").trim();
if (!prompt) {
  console.error("缺少 --task，或任务文件中没有 prompt");
  process.exit(2);
}

const acceptance = args.acceptance
  ? String(args.acceptance).split(/\r?\n|\|/).map((item) => item.trim()).filter(Boolean)
  : Array.isArray(task.acceptance) ? task.acceptance.map((item) => String(item).trim()).filter(Boolean) : [];
const url = process.env.CLAUDE_CODEX_BRIDGE_URL || "http://127.0.0.1:4318/api/internal/codex/delegate";
const token = process.env.CLAUDE_CODEX_BRIDGE_TOKEN || "";
const parentTaskId = process.env.CLAUDE_WORKBENCH_PARENT_TASK_ID || "";
if (!token) {
  console.error("缺少 CLAUDE_CODEX_BRIDGE_TOKEN；请从 Claude-Codex 工作台内调用此命令");
  process.exit(2);
}
if (!parentTaskId) {
  console.error("缺少 CLAUDE_WORKBENCH_PARENT_TASK_ID；请从工作台主 Claude 会话内调用此命令");
  process.exit(2);
}

const cwd = String(args.cwd || task.cwd || process.cwd());
const idempotencyKey = String(args.idempotencyKey || task.idempotencyKey || task.taskId || crypto.createHash("sha256").update(JSON.stringify({ provider: "codex", parentTaskId, cwd, prompt, acceptance })).digest("hex"));
const payload = {
  taskId: String(args.taskId || task.taskId || `codex-${idempotencyKey.slice(0, 16)}`),
  idempotencyKey,
  parentTaskId,
  nickname: String(args.nickname || task.nickname || "Codex 执行官"),
  cwd,
  prompt,
  acceptance
};

try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-codex-token": token },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    console.error(data.error || `Codex 委派失败（HTTP ${response.status}）`);
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
