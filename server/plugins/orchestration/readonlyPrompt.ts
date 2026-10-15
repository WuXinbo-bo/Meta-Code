/** Describe native reading tools without changing the approved access contract. */
export function workflowReadonlyNodeGuidance(providerId: string, shellAvailable: boolean, hasVerificationCommands: boolean) {
  const reading = providerId === "claude"
    ? "Claude 只读节点使用 Read、Glob、Grep 等原生读取工具查看业务文件；Bash、Write、Edit、NotebookEdit 已禁用，不得申请或绕过这些权限。"
    : providerId === "codex" || shellAvailable
      ? `${providerId === "codex" ? "Codex 只读节点通常通过 read-only shell 读取文件，没有 Claude 的 Read/Glob/Grep 工具。" : "当前适配器声明了 shell 能力；若已提供只读 shell，可以将它用作文件读取入口。"}只允许 cat、sed、rg、ls 等仅读取、搜索或列举业务文件的操作；不得执行测试、项目脚本、构建、安装、写入或提权，不得用重定向、管道或命令组合绕过只读限制。读取 shell 不是验收命令，不登记为测试通过证据。`
      : "当前适配器使用已提供的原生文件读取、目录列举或搜索工具查看业务文件；未声明 shell 能力，不得申请 shell 或假设存在 Claude 的 Read/Glob/Grep 工具。";
  const verification = hasVerificationCommands
    ? "合同中的 verificationCommands 由 Workbench 在本回合前执行；systemVerification 是真实命令、退出码、输出和文件边界检查，已自动登记到 checks。请阅读文件并审查这些证据，不要重复执行或改写系统检查。若系统检查失败、缺少证据或验收仍不充分，则指出真实原因并提交 blocked/partial，不得声称通过。"
    : "这是纯只读分析节点，合同未声明 verificationCommands，无需执行测试或验证命令，也无需 systemVerification。使用合规文件读取入口和已有输入完成分析，只登记真实阅读检查，不要因没有测试命令证据而报告 blocked。";
  return [
    reading,
    "上述说明仅描述已提供的读取入口，不增加权限，也不覆盖已批准合同。若 task.constraints、task.nonGoals 或祖先正式合同禁止 shell/终端命令，必须遵守；读取工具无法合规访问必需文件时返回 blocked 并说明入口缺失，不得忽略用户禁令。所有读取仍限定在 execution.executionRoot。",
    verification,
    "需要新增测试或验证命令时请求维护计划，不能自行扩展验收命令。"
  ].join("\n");
}
