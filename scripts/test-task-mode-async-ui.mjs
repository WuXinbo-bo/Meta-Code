import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.METACODE_PLAYWRIGHT_MODULE || "playwright");
const baseUrl = process.env.METACODE_VISUAL_BASE_URL || "http://127.0.0.1:4339";
const browser = await chromium.launch({ headless: true, executablePath: process.env.METACODE_BROWSER_EXECUTABLE || chromium.executablePath() });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, reducedMotion: "reduce" });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const open = async (mode) => page.goto(`${baseUrl}/scripts/fixtures/task-mode-async-ui.html?mode=${mode}`, { waitUntil: "networkidle" });
const waitRequest = async (path) => page.waitForFunction((path) => window.__taskAsync.calls.some((call) => call.path === path && call.body), path);
const resolve = async (path, body, status = 200) => page.evaluate(({ path, body, status }) => window.__taskAsync.resolve(path, body, status), { path, body, status });
const selected = () => page.getByLabel("Selected task").textContent();
try {
  await open("bar");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await waitRequest("/api/task-contexts/context-a/conversation");
  await page.getByRole("button", { name: "Select B" }).click();
  await page.getByRole("button", { name: "对话", exact: true }).waitFor();
  await resolve("/api/task-contexts/context-a/conversation", { id: "session-a" });
  await page.waitForTimeout(80);
  assert.equal(await selected(), "b", "An old conversation response must not navigate away from the newly selected task");
  assert.equal(await page.evaluate(() => window.__taskAsync.conversations.length), 0);
  assert.ok(await page.getByRole("button", { name: "对话", exact: true }).isEnabled(), "Switching tasks clears the previous task's busy indicator");

  for (const fail of [false, true]) {
    await open("compact");
    await page.getByRole("button", { name: "询问编排" }).click();
    await page.getByLabel("编排问题").fill("Question for A");
    await page.getByRole("button", { name: "发送编排请求" }).click();
    await waitRequest("/api/workflows/async-a/plan");
    await page.getByRole("button", { name: "Select B" }).click();
    await page.getByTitle("查看编排详情").filter({ hasText: "Task B" }).waitFor();
    await page.getByRole("button", { name: "调整计划" }).click();
    await page.getByLabel("计划调整要求").fill("New request for B");
    await resolve("/api/workflows/async-a/plan", fail ? { error: "Old A error" } : { workflow: await page.evaluate(() => window.__taskAsync.workflow("a")), queuedUntilCheckpoint: true }, fail ? 409 : 200);
    await page.waitForTimeout(80);
    assert.match(await page.locator(".task-workflow-progress").innerText(), /Task B/, "An old maintenance result must not replace the new task's progress");
    assert.equal(await page.getByLabel("计划调整要求").inputValue(), "New request for B", "An old response must not clear the new task's draft");
    assert.equal(await page.locator(".task-workflow-feedback").count(), 0, "An old success or failure must not create feedback in the new task");
    assert.ok(await page.getByRole("button", { name: "发送编排请求" }).isEnabled());
  }

  await open("create");
  await page.getByRole("button", { name: "追加一轮编排" }).click();
  await page.getByRole("button", { name: "生成计划" }).click();
  await waitRequest("/api/task-contexts/context-a/create");
  await page.getByRole("button", { name: "Select B" }).click();
  await page.getByRole("button", { name: "追加一轮编排" }).click();
  await page.getByRole("textbox", { name: "编排目标" }).fill("Goal B");
  await page.getByRole("button", { name: "生成计划" }).click();
  await waitRequest("/api/task-contexts/context-b/create");
  await resolve("/api/task-contexts/context-a/create", { ok: true });
  await page.waitForTimeout(80);
  assert.equal(await page.getByRole("textbox", { name: "编排目标" }).inputValue(), "Goal B", "An old creation must not dismiss the new task's form");
  assert.ok(await page.getByRole("button", { name: "生成计划" }).isDisabled(), "An old creation must not release the new task's pending operation");
  await resolve("/api/task-contexts/context-b/create", { ok: true });
  await page.getByLabel("本轮编排目标").waitFor({ state: "detached" });

  await open("bar");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await waitRequest("/api/task-contexts/context-a/conversation");
  await page.getByRole("button", { name: "Hide panel" }).click();
  await resolve("/api/task-contexts/context-a/conversation", { id: "session-a" });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.__taskAsync.conversations.length), 0, "An unmounted task shell must not navigate on late completion");
  for (const navigation of ["Select B", "Hide panel"]) {
    await open("definition");
    await page.getByLabel("选择工作流程").selectOption("async-definition");
    await page.getByRole("button", { name: "创建任务", exact: true }).click();
    await waitRequest("/api/workflow-definitions/async-definition/instantiate");
    await page.getByRole("button", { name: navigation }).click();
    await resolve("/api/workflow-definitions/async-definition/instantiate", { id: "workflow-a" });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.__taskAsync.conversations.length), 0, "A definition created in an old workspace must not navigate after a workspace switch or unmount");
    if (navigation === "Select B") {
      assert.equal(await selected(), "b");
      assert.ok(await page.getByRole("button", { name: "创建任务", exact: true }).isEnabled(), "An old workspace request must not block the new workspace picker");
      await page.getByRole("button", { name: "创建任务", exact: true }).click();
      const latest = await page.evaluate(() => window.__taskAsync.calls.filter((call) => call.path.endsWith("/instantiate")).at(-1));
      assert.equal(latest.body.workspaceId, "workspace-b", "The next creation must target the newly selected workspace");
      await resolve("/api/workflow-definitions/async-definition/instantiate", { id: "workflow-b" });
    }
  }
  assert.deepEqual(pageErrors, []);
  console.log("task mode UI: late conversation/maintenance/creation/definition responses, drafts, busy ownership, workspace and unmount navigation boundaries passed");
} finally { await browser.close(); }
