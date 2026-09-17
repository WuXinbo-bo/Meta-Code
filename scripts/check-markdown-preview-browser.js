async (page) => {
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.unroute('**/api/workspaces/fixture/file?*');
  await page.getByRole('button', { name: 'basic', exact: true }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const name of ['main', 'file', 'agent']) {
    const section = page.getByTestId(name);
    await section.scrollIntoViewIfNeeded();
    await page.waitForFunction(name => document.querySelector(`[data-testid="${name}"]`).querySelectorAll('.katex').length === 4, name);
    if (await section.locator('pre .math-formula').count()) throw Error('Code interpreted as math');
  }
  if (await page.evaluate(() => window.UNSAFE || !!document.querySelector('[data-testid="file"] script'))) throw Error('Unsafe HTML executed');
  await page.getByTestId('main').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/markdown-verified-basic.png' });
  await page.getByRole('button', { name: 'huge', exact: true }).click();
  const section = page.getByTestId('main');
  const blocks = section.locator('.markdown-continuous > .deferred-content');
  await blocks.first().waitFor();
  const seen = new Set();
  const started = Date.now();
  const blockCount = await blocks.count();
  for (let i = 0; i < blockCount; i++) {
    const block = blocks.nth(i);
    await block.evaluate(el => el.scrollIntoView({ block: 'start' }));
    await block.locator('.markdown-body').waitFor();
    for (const match of (await block.innerText()).matchAll(/唯一标记(\d+)/g)) {
      if (seen.has(match[1])) throw Error('Repeated source marker'); seen.add(match[1]);
    }
    const formula = block.locator('.math-formula').first();
    if (await formula.count()) { await formula.scrollIntoViewIfNeeded(); await formula.locator('.katex').waitFor(); }
  }
  if (seen.size !== 500) throw Error(`Only ${seen.size}/500 paragraphs survived continuous rendering`);
  if (await section.getByRole('button', { name: /上一页|下一页|上一段|下一段/ }).count()) throw Error('Visible pagination controls remain');
  await blocks.first().evaluate(el => el.scrollIntoView({ block: 'start' }));
  await blocks.first().locator('.markdown-body').waitFor();
  if (!(await blocks.first().innerText()).includes('唯一标记0')) throw Error('Scrolled-back content did not restore');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="main"] .markdown-continuous > .deferred-content[data-content-active="true"]').length <= 3);
  const duration = Date.now() - started;
  const outline = page.getByTestId('file').getByRole('combobox', { name: '当前内容目录' });
  await outline.selectOption(await outline.locator('option').last().getAttribute('value'));
  await page.getByTestId('file').locator('h2').filter({ hasText: '第 499 条' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '主题', exact: true }).click();
  await blocks.first().evaluate(el => el.scrollIntoView({ block: 'start' }));
  await blocks.first().locator('.markdown-body').waitFor();
  await page.screenshot({ path: 'output/playwright/markdown-verified-narrow.png' });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)) throw Error('Narrow layout overflows');
  await page.getByRole('button', { name: 'errors', exact: true }).click();
  await section.scrollIntoViewIfNeeded();
  await section.getByRole('button', { name: '查看公式源码', exact: true }).first().click();
  if (!(await section.innerText()).includes('\\badcommand{x}')) throw Error('Failed formula lost source');
  await section.locator('.katex').first().waitFor();
  if (await page.locator('a[href^="javascript:"]').count()) throw Error('Unsafe formula link allowed');
  await page.screenshot({ path: 'output/playwright/markdown-verified-error.png' });

  let changed = false, requests = 0;
  await page.route('**/api/workspaces/fixture/file?*', async route => {
    requests++;
    const offset = Number(route.request().url().match(/[?&]offset=(\d+)/)?.[1] || 0);
    if (changed) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '文件已发生变化，请重新读取后继续浏览。' }) });
    const index = offset / 100000;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ kind: 'markdown', content: `# 文件片段 ${index}\n\n$x^2$\n\n` + '完整内容。\n\n'.repeat(120), offset, endOffset: offset + 100000, nextOffset: index === 19 ? null : offset + 100000, version: 'version-0', size: 2000000, previewMode: 'markdown-paged' }) });
  });
  await page.getByRole('button', { name: 'file', exact: true }).click();
  const fileBlocks = page.locator('.continuous-file-preview > .deferred-content');
  for (let i = 1; i <= 15; i++) {
    await page.locator('.continuous-preview-status').evaluate(el => el.scrollIntoView({ block: 'end' }));
    await fileBlocks.nth(i).waitFor();
    await fileBlocks.nth(i).evaluate(el => el.scrollIntoView({ block: 'start' }));
    await fileBlocks.nth(i).locator('h1').filter({ hasText: `文件片段 ${i}` }).waitFor();
  }
  const requestsBeforeReturn = requests;
  await fileBlocks.nth(1).evaluate(el => el.scrollIntoView({ block: 'start' }));
  await fileBlocks.nth(1).locator('h1').filter({ hasText: '文件片段 1' }).waitFor();
  if (requests <= requestsBeforeReturn) throw Error('Evicted content was not reloaded on backward scrolling');
  if (await page.getByRole('button', { name: /上一段|下一段|上一页|下一页/ }).count()) throw Error('File preview exposes transport pages');
  changed = true;
  await page.locator('.continuous-preview-status').evaluate(el => el.scrollIntoView({ block: 'end' }));
  await page.locator('.continuous-preview-status[role="alert"]').waitFor();
  if (await fileBlocks.count() < 15) throw Error('Read failure erased known content');
  if (errors.length) throw Error(errors.join('\n'));
  return { status: 'PASS', formulaParagraphs: seen.size, logicalBlocks: blockCount, traversalMs: duration, requests, checks: 'shared rendering, 500 paragraphs via continuous scrolling, bounded mounted blocks, backward restoration, outline, narrow/dark, formula isolation, 15 file chunks/cache eviction and version conflict, no page controls' };
}
