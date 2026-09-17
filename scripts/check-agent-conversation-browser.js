async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const bottom = () => page.waitForFunction(() => {
    const s = document.querySelector('.agent-drawer-body');
    return s && document.querySelectorAll('.activity-virtual-row').length > 0 && Math.abs(s.scrollHeight - s.scrollTop - s.clientHeight) < 4;
  });
  await bottom();
  await page.getByRole('button', { name: '一万条', exact: true }).click();
  await bottom();
  await page.waitForFunction(() => document.querySelector('.agent-drawer-body').textContent.includes('第 9998 条回复'));
  for (const provider of ['claude', 'gemini', 'codebuddy', 'codex']) {
    await page.getByRole('button', { name: provider, exact: true }).click();
    await bottom();
    await page.waitForFunction(() => document.querySelector('.agent-drawer-body').textContent.includes('第 9998 条回复'));
  }
  await page.getByRole('button', { name: '追加日志', exact: true }).click();
  await bottom();
  await page.waitForFunction(() => document.querySelector('.activity-live-current')?.textContent.includes('live-10000'));
  await page.locator('.agent-drawer-body').hover();
  await page.mouse.wheel(0, -1000000);
  await page.waitForFunction(() => document.querySelector('.agent-drawer-body').scrollTop < 5);
  await page.getByRole('button', { name: '追加日志', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.agent-drawer-body').scrollTop < 5);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  const summary = page.locator('.activity-summary-group > summary').first();
  await summary.click();
  await page.locator('.activity-summary-details .agent-stream-event > summary').first().click();
  await page.locator('.command-execution-preview').first().waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: 'output/playwright/agent-layout-wide.png' });
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.setViewportSize({ width: 760, height: 850 });
  await page.screenshot({ path: 'output/playwright/agent-layout-dark.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const s = document.querySelector('.agent-drawer-body');
    if (s.scrollWidth > s.clientWidth + 1) throw Error('Drawer overflows horizontally');
    const samples = Array.from(document.querySelectorAll('.assistant-reply .markdown-body')).map(e => getComputedStyle(e).fontSize);
    if (samples.some(size => size !== samples[0])) throw Error('Reply typography differs');
    if (document.querySelectorAll('.activity-virtual-row').length > 60) throw Error('Too many rendered rows');
  });
  await page.screenshot({ path: 'output/playwright/agent-layout-narrow.png' });
  await page.locator('.agent-drawer').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  if (!(await page.evaluate(() => !!document.activeElement?.closest('.agent-drawer')))) throw Error('Focus escaped the drawer');
  if (errors.length) throw Error(errors.join('\n'));
  return 'PASS: 10,000 logs; provider switches; live output and reading position; command details; light/dark; wide/narrow; focus; console';
}
