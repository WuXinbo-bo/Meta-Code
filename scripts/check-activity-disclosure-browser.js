// Run against scripts/fixtures/activity-disclosure-ui.html with a Playwright page.
async (page, outputDir) => {
  const errors = [];
  const assertions = [];
  page.on("pageerror", error => errors.push(error.message));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const log = (id, phase, category = "command") => ({ id, kind: category === "error" ? "error" : "tool", category, phase, title: category === "error" ? "执行失败" : "执行命令", text: "运行验证", detail: { command: "node validate.mjs", output: phase === "failed" ? "fixture validation failed" : "fixture validation passed", exitCode: phase === "failed" ? 128 : 0 }, createdAt: "2026-10-08T00:00:00Z" });
  const render = async (state) => {
    await page.evaluate(state => window.renderActivityFixture(state), state);
    await page.waitForFunction(() => document.querySelector(".agent-conversation-stream"));
    await page.waitForTimeout(70); // Include the native asynchronous details toggle event.
  };
  const closed = async (label) => {
    const values = await page.locator("details").evaluateAll(entries => entries.map(entry => entry.open));
    check(values.every(value => !value), `${label}: an execution disclosure opened automatically`);
    check(await page.locator(".command-execution-preview").count() === 0, `${label}: command body rendered while closed`);
  };
  for (const surface of ["main", "drawer"]) {
    for (const phase of ["running", "completed", "failed"]) {
      await render({ surface, status: phase, logs: [log(`${surface}-${phase}`, phase)] });
      await closed(`${surface}/${phase}`);
    }
    assertions.push(`${surface}: running, successful and failed command groups all default closed`);
    const initial = [log(`${surface}-stable-1`, "completed"), log(`${surface}-stable-2`, "running")];
    await render({ surface, status: "running", logs: initial });
    const group = page.locator(".agent-stream-cluster");
    await group.locator(":scope > summary").click();
    await page.locator(".agent-stream-event").first().locator(":scope > summary").click();
    await page.locator(".command-execution-preview").waitFor();
    await render({ surface, status: "failed", logs: initial.map(entry => ({ ...entry, phase: entry.id.endsWith("2") ? "failed" : "completed" })) });
    const settled = page.locator(".activity-summary-group");
    check(await settled.evaluate(entry => entry.open), `${surface}: group choice lost on failure`);
    check(await page.locator(".agent-stream-event").first().evaluate(entry => entry.open), `${surface}: leaf choice lost on failure`);
    check(!(await page.locator(".agent-stream-event").last().evaluate(entry => entry.open)), `${surface}: new failed leaf auto-opened`);
    await settled.locator(":scope > summary").click();
    await render({ surface, status: "running", logs: initial });
    await closed(`${surface}/resumed manually closed group`);
    await render({ surface, status: "failed", logs: initial.map(entry => ({ ...entry, phase: "failed" })) });
    await closed(`${surface}/new failure in manually closed group`);
    await page.locator(".activity-summary-group > summary").click();
    check(await page.locator(".agent-stream-event").first().evaluate(entry => entry.open), `${surface}: inner manual choice lost while outer group closed`);
    assertions.push(`${surface}: manual open and close survive group remount, resume and new failure`);
  }
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await render({ surface: "main", status: "completed", logs: [log(`tone-success-${theme}`, "completed"), log(`tone-failure-${theme}`, "failed")] });
    await closed(`${theme}/mixed outcomes`);
    await page.locator(".activity-summary-group > summary").click();
    const entries = page.locator(".agent-stream-event");
    await entries.first().waitFor();
    for (const entry of await entries.all()) {
      await entry.locator(":scope > summary").click();
      await entry.locator(".command-execution-preview").waitFor();
    }
    await page.getByText("fixture validation failed", { exact: true }).waitFor();
    const tones = await entries.evaluateAll(nodes => nodes.map(node => ({ icon: getComputedStyle(node.querySelector(".agent-event-icon")).color, title: getComputedStyle(node.querySelector("summary strong")).color, outcome: getComputedStyle(node.querySelector(".command-preview-meta > span")).color })));
    check(JSON.stringify(tones[0]) === JSON.stringify(tones[1]), `${theme}: failure and success tones differ`);
    check((await entries.last().innerText()).includes("执行失败") && (await entries.last().innerText()).includes("exit 128"), `${theme}: failure wording or exit status hidden`);
    if (outputDir) await page.screenshot({ path: `${outputDir}/log-disclosure-${theme}-expanded.png` });
    await page.locator(".activity-summary-group > summary").click();
    if (outputDir) await page.screenshot({ path: `${outputDir}/log-disclosure-${theme}-collapsed.png` });
    assertions.push(`${theme}: mixed success/failure share gray tones and retain failure output/exit code`);
  }
  const planLog = { ...log("plan-first", "running", "todo"), title: "更新计划", detail: { items: [{ text: "第一步", status: "in_progress" }, { text: "第二步", status: "pending" }] } };
  await render({ surface: "main", status: "running", logs: [planLog] });
  await closed("plan tool update");
  await page.locator(".agent-plan-view > summary").click();
  const planUpdate = { ...planLog, id: "plan-second", createdAt: "2026-10-08T00:00:01Z", detail: { items: [{ text: "第一步", status: "completed" }, { text: "第二步", status: "failed" }] } };
  await render({ surface: "main", status: "running", logs: [planLog, planUpdate] });
  check(await page.locator(".agent-plan-view").evaluate(element => element.open), "plan revision lost manual expansion");
  const planTones = await page.locator(".agent-plan-content li").evaluateAll(nodes => nodes.map(node => ({ text: getComputedStyle(node).color, icon: getComputedStyle(node.querySelector("span")).color })));
  check(JSON.stringify(planTones[0]) === JSON.stringify(planTones[1]), "failed plan steps have a different color from completed steps");
  await render({ surface: "main", status: "failed", logs: [planLog, planUpdate].map(entry => ({ ...entry, phase: "failed" })) });
  check(await page.locator(".activity-summary-group").evaluate(element => element.open), "plan disclosure choice lost in settled summary");
  await page.locator(".activity-summary-group > summary").click();
  await render({ surface: "main", status: "running", logs: [planLog, planUpdate] });
  await closed("resumed manually closed plan");
  assertions.push("plan tools default closed, retain user choice through revisions/completion and use neutral outcome tones");
  await render({ surface: "main", status: "failed", filters: true, logs: [log("standalone-failure", "failed", "error")] });
  await closed("standalone error event");
  await page.getByRole("button", { name: "查看 1 条失败活动" }).click();
  await closed("explicit failed activity inspection");
  assertions.push("standalone errors and failure-filter results also default closed");
  const longLogs = Array.from({ length: 100 }, (_, index) => ({ id: `long-${index}`, kind: "message", category: "message", phase: "completed", title: "回复", text: `历史回复 ${index}`, createdAt: new Date(1760000000000 + index * 1000).toISOString() }));
  await render({ surface: "drawer", status: "running", logs: [...longLogs, { ...log("long-tail-command", "failed"), createdAt: "2026-10-08T00:00:00Z" }] });
  await page.locator(".agent-work-progress").waitFor();
  check(await page.locator(".activity-virtual-row").count() < 60, "long transcript stopped virtualizing");
  const body = page.locator(".agent-drawer-body");
  await page.locator(".activity-summary-group > summary").click();
  await page.locator(".agent-stream-event > summary").click();
  await page.locator(".command-execution-preview").waitFor();
  await body.hover();
  await page.mouse.wheel(0, -1000000);
  await page.waitForFunction(() => document.querySelector(".agent-drawer-body").scrollTop < 5);
  await page.locator(".activity-summary-group").waitFor({ state: "detached" });
  await body.evaluate(element => element.scrollTop = element.scrollHeight);
  await page.locator(".command-execution-preview").waitFor();
  check(await page.locator(".activity-summary-group").evaluate(element => element.open), "virtualized group lost manual expansion");
  check(await page.locator(".agent-stream-event").evaluate(element => element.open), "virtualized leaf lost manual expansion");
  await page.locator(".activity-summary-group > summary").click();
  assertions.push("long transcript preserves manual expansion after scrolling away and virtualized remount");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  check(await page.locator(".agent-drawer-body").evaluate(body => body.scrollWidth <= body.clientWidth + 1), "drawer overflows on mobile");
  if (outputDir) await page.screenshot({ path: `${outputDir}/log-disclosure-drawer-mobile.png` });
  assertions.push("long drawer transcripts retain virtualization and mobile geometry");
  check(errors.length === 0, errors.join("\n"));
  return { assertions, pageErrors: errors };
}
