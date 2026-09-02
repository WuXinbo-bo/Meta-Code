#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";

function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (value.startsWith("--")) result[value.slice(2)] = argv[index + 1] ?? "";
    if (value.startsWith("--")) index += 1;
  }
  return result;
}

function help() {
  console.log([
    "Workbench 通用 Agent 委派桥接",
    "",
    "用法：",
    "  node scripts/delegate-agent.mjs --provider codex --task \"实现并测试接口\" --cwd .",
    "  node scripts/delegate-agent.mjs --provider claude --file .claude-codex/tasks/review.json",
    "",
    "JSON 字段：providerId、taskId、nickname、mode、prompt、cwd、acceptance、capabilityRequirements"
  ].join("\n"));
}

const list = (value) => Array.isArray(value)
  ? value.map(String).map((item) => item.trim()).filter(Boolean)
  : String(value || "").split(/\r?\n|\||,/).map((item) => item.trim()).filter(Boolean);
async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  if (args.help) { help(); return 0; }
  if (Number(process.env.WORKBENCH_AGENT_DEPTH || process.env.CLAUDE_WORKER_DEPTH || 0) >= 1) {
    console.error("工作台子 Agent 不允许递归委派");
    return 2;
  }

  let task = {};
  if (args.file) task = JSON.parse(await fs.readFile(String(args.file), "utf8"));
  const providerId = String(args.provider || task.providerId || task.provider || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(providerId)) { console.error("缺少或无效的 --provider"); return 2; }
  const prompt = String(args.task || task.prompt || "").trim();
  if (!prompt) { console.error("缺少 --task，或任务文件中没有 prompt"); return 2; }

  const url = process.env.WORKBENCH_AGENT_BRIDGE_URL || "";
  const token = process.env.WORKBENCH_AGENT_BRIDGE_TOKEN || "";
  const parentTaskId = process.env.CLAUDE_WORKBENCH_PARENT_TASK_ID || process.env.WORKBENCH_PARENT_TASK_ID || "";
  if (!url || !token || !parentTaskId) {
    console.error("缺少工作台通用委派环境；请从已启用协作模式的工作台主任务内调用");
    return 2;
  }

  const acceptance = list(args.acceptance || task.acceptance);
  const capabilityRequirements = list(args.capabilities || task.capabilityRequirements);
  const requestedMode = String(args.mode || task.mode || "implementation");
  const modeAliases = { read: "analysis", write: "implementation" };
  const normalizedMode = modeAliases[requestedMode] || requestedMode;
  const mode = ["analysis", "review", "implementation"].includes(normalizedMode) ? normalizedMode : "implementation";
  const cwd = String(args.cwd || task.cwd || process.cwd());
  const idempotencyKey = String(args.idempotencyKey || task.idempotencyKey || task.taskId || crypto.createHash("sha256").update(JSON.stringify({ providerId, parentTaskId, cwd, prompt, acceptance, mode })).digest("hex"));
  const payload = {
    schemaVersion: 3,
    providerId,
    taskId: String(args.taskId || task.taskId || `${providerId}-worker-${idempotencyKey.slice(0, 16)}`),
    idempotencyKey,
    parentTaskId,
    nickname: String(args.nickname || task.nickname || `${providerId} 子 Agent`),
    mode,
    cwd,
    prompt,
    acceptance,
    capabilityRequirements,
    depth: Number(process.env.WORKBENCH_AGENT_DEPTH || process.env.CLAUDE_WORKER_DEPTH || 0)
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-workbench-agent-token": token },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) { console.error(data.error || `Agent 委派失败（HTTP ${response.status}）`); return 1; }
    console.log(JSON.stringify(data, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = await main();
