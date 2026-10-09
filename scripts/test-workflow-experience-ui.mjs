import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.METACODE_PLAYWRIGHT_MODULE || "playwright");
const baseUrl = process.env.METACODE_VISUAL_BASE_URL || "http://127.0.0.1:4339";
const output = process.env.METACODE_VISUAL_OUTPUT || path.join(os.homedir(), ".metacode", "test-artifacts", `workflow-ui-${new Date().toISOString().replaceAll(":", "-")}`);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.METACODE_BROWSER_EXECUTABLE || chromium.executablePath() });
const errors = [];
const screenshots = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
page.on("pageerror", (error) => errors.push(error.message));
const open = async (scenario, width = 1440) => {
  await page.setViewportSize({ width, height: 960 });
  await page.goto(`${baseUrl}/scripts/fixtures/workflow-experience-ui.html?scenario=${scenario}`, { waitUntil: "networkidle" });
  await page.locator(".workflow-visual-shell").waitFor();
};
const screenshot = async (name) => {
  await page.evaluate(() => document.fonts.ready);
  const destination = path.join(output, `${name}.png`);
  await page.screenshot({ path: destination, fullPage: true, animations: "disabled" });
  screenshots.push(destination);
};
const call = async (endpoint) => page.evaluate((wanted) => window.__workflowVisual.calls.filter((item) => item.path === wanted).at(-1), endpoint);
const visibleWithin = async (selector) => {
  const bounds = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, `${selector} leaves viewport: ${JSON.stringify(bounds)}`);
};

try {
  for (const target of ["workspace", "isolated", "worktree"]) {
    await open("create");
    await page.getByRole("button", { name: "创建初始任务" }).click();
    const location = page.getByLabel("执行位置");
    assert.equal(await location.inputValue(), "workspace", "New orchestration must default to the current project");
    assert.equal(await page.locator(".workflow-target-select").evaluate((element) => getComputedStyle(element).flexDirection), "row", "Execution target icon and select must stay on one row");
    await location.selectOption(target);
    await page.getByPlaceholder("描述希望完成的目标，规划经确认后开始执行……").fill("维护接口并补充回归测试");
    await screenshot(`create-${target}`);
    await page.getByRole("button", { name: "创建并规划" }).click();
    assert.equal((await call("/fixture/create")).body.executionTarget, target);
  }

  await open("running");
  await page.getByRole("button", { name: "询问", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "询问", exact: true }).evaluate((element) => getComputedStyle(element).flexDirection), "row", "Maintenance mode buttons must retain inline icon and text");
  await page.getByPlaceholder("询问任务进度、结果或下一步").fill("目前哪些结果可继续复用？");
  await page.getByTitle("发送问题", { exact: true }).click();
  await page.getByRole("status").filter({ hasText: "等待当前节点完成" }).waitFor();
  const question = await call("/api/workflows/visual-running/plan");
  assert.equal(question.body.intent, "question");
  assert.equal(question.body.source, "maintenance");
  assert.equal(question.body.plannerEngine, "codex");
  await page.locator(".workflow-checkpoint-feedback").filter({ hasText: "等待运行节点完成后回答问题" }).waitFor();
  assert.ok(await page.getByTitle("发送问题", { exact: true }).isDisabled(), "Checkpoint requests must prevent duplicate submissions");
  await screenshot("running-question-checkpoint");

  await open("running");
  await page.getByRole("button", { name: "调整", exact: true }).click();
  await page.getByLabel("维护规划 Agent").selectOption("claude");
  await page.getByPlaceholder("修改范围、更换节点 Agent 或局部重做").fill("保留研究，只改实现节点，并由 Claude 调整计划");
  await page.getByTitle("提交调整", { exact: true }).click();
  await page.getByRole("status").filter({ hasText: "等待当前节点完成" }).waitFor();
  const adjustment = await call("/api/workflows/visual-running/plan");
  assert.equal(adjustment.body.intent, "adjust");
  assert.equal(adjustment.body.plannerEngine, "claude");
  await screenshot("running-adjust-checkpoint");

  await open("candidate");
  await page.locator(".workflow-impact-summary").waitFor();
  await page.locator(".workflow-impact-summary summary").click();
  assert.match(await page.locator(".workflow-impact-summary").innerText(), /项目结构研究/);
  assert.match(await page.locator(".workflow-review-write-range").innerText(), /src\/payments/);
  await screenshot("candidate-impact");
  await page.getByRole("button", { name: "批准执行", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "计划已批准" }).waitFor();
  assert.equal((await call("/api/workflows/visual-candidate/approve")).body.revision, 8);

  await open("running");
  await page.getByTitle("保存工作流程", { exact: true }).click();
  const definitionPanel = page.locator(".workflow-extension-panel");
  await definitionPanel.getByLabel("名称", { exact: true }).fill("参数化接口维护");
  await definitionPanel.getByLabel("说明", { exact: true }).fill("在指定模块中保留现有接口合同并补充回归测试");
  await definitionPanel.getByTitle("添加参数").click();
  await page.getByLabel("参数 1 名称", { exact: true }).fill("module");
  await page.getByLabel("参数 1 标签", { exact: true }).fill("模块名称");
  await page.getByLabel("参数 1 替换内容", { exact: true }).fill("payments");
  await screenshot("definition-parameter-save");
  await definitionPanel.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已保存工作流程" }).waitFor();
  const saved = await call("/api/workflow-definitions");
  assert.equal(saved.method, "POST");
  assert.equal(saved.body.parameters[0].name, "module");
  assert.match(saved.body.goalTemplate, /\{\{module\}\}/);
  assert.match(saved.body.planTemplate.nodes[0].objective, /\{\{module\}\}/);
  assert.equal(saved.body.planTemplate.nodes[0].id, "research", "Parameter substitution must preserve node identities");

  await open("create");
  await page.getByRole("button", { name: "创建初始任务" }).click();
  await page.getByRole("button", { name: "工作流程", exact: true }).click();
  await page.getByLabel("选择工作流程").selectOption("visual-definition");
  await page.getByLabel("模块名称").fill("orders");
  await page.getByLabel("模块路径").fill("src/orders");
  assert.ok((await page.getByLabel("模块路径").boundingBox()).width >= 250, "Definition parameters must offer a usable full-width input");
  await screenshot("definition-instantiate");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  const instantiated = await call("/api/workflow-definitions/visual-definition/instantiate");
  assert.deepEqual(instantiated.body.inputs, { module: "orders", scope: "src/orders" });
  assert.equal(instantiated.body.expectedRevision, 1);
  assert.equal(instantiated.body.executionTarget, "workspace");

  await open("worktree");
  await page.getByTitle("比较方案与项目", { exact: true }).click();
  await page.getByText("方案可整合", { exact: true }).waitFor();
  const integrate = page.getByRole("button", { name: "整合到项目", exact: true });
  assert.ok(await integrate.isDisabled(), "Uncommitted changes require explicit snapshot selection");
  await page.getByText("文件差异", { exact: true }).click();
  await page.getByLabel("提交方案修改后整合").check();
  assert.ok(await integrate.isEnabled());
  await screenshot("worktree-compare");
  await integrate.click();
  await page.getByRole("alertdialog", { name: "整合方案到项目" }).waitFor();
  await screenshot("worktree-integrate-confirmation");
  await page.getByRole("button", { name: "整合方案", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "方案已整合" }).waitFor();
  const integrated = await call("/api/workflows/visual-worktree/worktree/integrate");
  assert.deepEqual(integrated.body, { workflowRevision: 8, expectedRevision: 1, previewDigest: "visual-preview", snapshotChanges: true });

  for (const state of ["worktree-dirty", "worktree-conflict"]) {
    await open(state);
    await page.getByTitle("比较方案与项目", { exact: true }).click();
    await page.locator(".workflow-extension-checkbox").waitFor();
    await page.getByLabel("提交方案修改后整合").check();
    assert.ok(await page.getByRole("button", { name: "整合到项目", exact: true }).isDisabled(), "Dirty target or conflicts must block integration even with snapshot consent");
    await screenshot(state);
  }
  await open("worktree-stale");
  await page.getByTitle("比较方案与项目", { exact: true }).click();
  await page.getByLabel("提交方案修改后整合").check();
  await page.getByRole("button", { name: "整合到项目", exact: true }).click();
  await page.getByRole("button", { name: "整合方案", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "已变化，请重新比较" }).waitFor();
  await screenshot("worktree-stale-preview");

  await open("conversation");
  await page.locator(".task-workflow-progress").waitFor();
  assert.equal(await page.getByRole("button", { name: "询问编排", exact: true }).isVisible(), true, "Conversation shell must expose a compact orchestration question action");
  await page.getByRole("button", { name: "询问编排", exact: true }).click();
  await page.getByLabel("编排问题", { exact: true }).fill("哪些研究结果可以继续复用？");
  await page.getByRole("button", { name: "发送编排请求", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已收到" }).waitFor();
  const compactQuestion = await call("/api/workflows/visual-conversation/plan");
  assert.equal(compactQuestion.body.intent, "question");
  assert.equal(compactQuestion.body.source, "maintenance");
  assert.equal(await page.getByText("最近回复", { exact: true }).count(), 1, "Compact progress should expose the latest planner reply");
  await page.getByRole("button", { name: "调整计划", exact: true }).click();
  await page.getByLabel("计划调整要求", { exact: true }).fill("保留研究结果，只调整实现节点");
  await page.getByRole("button", { name: "发送编排请求", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已收到" }).waitFor();
  const compactAdjustment = await call("/api/workflows/visual-conversation/plan");
  assert.equal(compactAdjustment.body.intent, "adjust");
  assert.equal(compactAdjustment.body.mode, "refine");
  await page.getByRole("button", { name: "追加一轮编排", exact: true }).click();
  await page.getByLabel("编排目标", { exact: true }).fill("继续补充支付接口的回归场景");
  await screenshot("conversation-append-form");
  await page.getByRole("button", { name: "生成计划", exact: true }).click();
  const compactCreate = await call("/fixture/create");
  assert.equal(compactCreate.body.taskContextId, "visual-task");
  assert.equal(compactCreate.body.goal, "继续补充支付接口的回归场景");
  await page.locator(".task-workflow-progress").waitFor();
  assert.equal(await page.locator(".workflow-workbench").count(), 0, "Creating a round from chat must retain the conversation view");
  await screenshot("conversation-progress");
  await page.getByRole("button", { name: "编排", exact: true }).click();
  await page.locator(".workflow-workbench").waitFor();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.locator(".task-workflow-progress").waitFor();
  assert.ok(await call("/api/task-contexts/visual-task/conversation"), "Task shell must hand off through the host API");

  for (const scenario of ["create", "running", "candidate", "worktree"]) {
    await open(scenario, 640);
    if (scenario === "create") await page.getByRole("button", { name: "创建初始任务" }).click();
    if (scenario === "worktree") { await page.getByTitle("比较方案与项目", { exact: true }).click(); await page.getByText("方案可整合", { exact: true }).waitFor(); }
    await visibleWithin(scenario === "create" ? ".workflow-create-popover" : scenario === "candidate" ? ".workflow-review-card" : scenario === "worktree" ? ".workflow-extension-panel" : ".workflow-maintenance-panel");
    await screenshot(`narrow-${scenario}`);
  }
  await open("create", 640);
  await page.getByRole("button", { name: "创建初始任务" }).click();
  assert.equal(await page.locator(".workflow-create-mode").evaluate((element) => getComputedStyle(element).flexDirection), "row", "Narrow create task source controls must stay compact");
  await open("candidate");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot("dark-candidate");
  await open("worktree");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.getByTitle("比较方案与项目", { exact: true }).click();
  await page.getByText("方案可整合", { exact: true }).waitFor();
  await screenshot("dark-worktree");
  assert.deepEqual(errors, [], "Visual scenarios must not throw client exceptions");
  const report = { screenshots, assertions: "execution targets, checkpoint request intent, revisioned approval, parameterized workflow save/instantiate, worktree integration confirmation, unified task handoff, desktop and narrow layout", clientErrors: errors };
  await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
