import assert from "node:assert/strict";
import { workflowReadonlyNodeGuidance } from "../server/plugins/orchestration/readonlyPrompt.ts";

for (const hasVerificationCommands of [false, true]) {
  const claude = workflowReadonlyNodeGuidance("claude", true, hasVerificationCommands);
  assert.match(claude, /Claude 只读节点使用 Read、Glob、Grep/);
  assert.match(claude, /Bash、Write、Edit、NotebookEdit 已禁用/);
  assert.doesNotMatch(claude, /通过 read-only shell/);
  const codex = workflowReadonlyNodeGuidance("codex", true, hasVerificationCommands);
  assert.match(codex, /Codex 只读节点通常通过 read-only shell 读取文件/);
  assert.match(codex, /不得执行测试、项目脚本、构建、安装、写入或提权/);
  assert.match(codex, /不增加权限，也不覆盖已批准合同/);
  assert.match(codex, /合同禁止 shell\/终端命令，必须遵守/);
  assert.doesNotMatch(codex, /不具备 Bash|无需命令执行|Bash.*已禁用/);
  const customFile = workflowReadonlyNodeGuidance("custom-file", false, hasVerificationCommands);
  assert.match(customFile, /原生文件读取、目录列举或搜索工具/);
  assert.match(customFile, /未声明 shell 能力，不得申请 shell/);
  const customShell = workflowReadonlyNodeGuidance("custom-shell", true, hasVerificationCommands);
  assert.match(customShell, /当前适配器声明了 shell 能力/);
  assert.match(customShell, /若已提供只读 shell/);
  for (const prompt of [claude, codex, customFile, customShell]) {
    assert.match(prompt, /所有读取仍限定在 execution\.executionRoot/);
    assert.match(prompt, /需要新增测试或验证命令时请求维护计划/);
    if (hasVerificationCommands) {
      assert.match(prompt, /由 Workbench 在本回合前执行/);
      assert.match(prompt, /不要重复执行或改写系统检查/);
    } else assert.match(prompt, /纯只读分析节点/);
  }
}
console.log("Readonly Provider prompts: native reading tools, host verification and contract prohibitions passed");
