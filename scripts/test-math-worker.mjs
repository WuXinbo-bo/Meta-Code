import assert from 'node:assert/strict';
let created = 0, terminated = 0, sent = 0;
class FakeWorker {
  constructor() { created++; }
  postMessage({ source }) {
    sent++;
    if (source === 'hang') return;
    queueMicrotask(() => this.onmessage?.({ data: source === 'bad' ? { error: 'invalid formula' } : { html: `<span>${source}</span>` } }));
  }
  terminate() { terminated++; }
}
globalThis.Worker = FakeWorker;
const { renderFormula } = await import('../src/markdown/mathRenderer.ts');
const signal = () => new AbortController().signal;
assert.equal(await renderFormula('normal', false, signal()), '<span>normal</span>');
assert.equal(await renderFormula('normal', false, signal()), '<span>normal</span>');
assert.equal(sent, 1, 'completed formula is cached');
await assert.rejects(renderFormula('bad', false, signal()), /invalid/);
assert.equal(await renderFormula('after-error', false, signal()), '<span>after-error</span>');
const abort = new AbortController();
const blocked = renderFormula('hang', true, abort.signal);
const queued = renderFormula('after-abort', true, signal());
abort.abort();
await assert.rejects(blocked, error => error.name === 'AbortError');
assert.equal(await queued, '<span>after-abort</span>');
const start = Date.now();
await assert.rejects(renderFormula('hang', true, signal()), /耗时较长/);
assert.ok(Date.now() - start < 7000, 'hung worker is terminated by watchdog');
assert.equal(await renderFormula('after-timeout', false, signal()), '<span>after-timeout</span>');
assert.ok(terminated >= 3 && created >= 4);
for (let i = 0; i < 260; i++) await renderFormula(`cache-${i}`, false, signal());
const before = sent;
await renderFormula('normal', false, signal());
assert.equal(sent, before + 1, 'cache eviction does not prevent re-render');
console.log('Formula worker: cache, isolated error, cancellation, timeout recovery and bounded eviction passed');
