import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Kernel } from '../src/kernel.js';
import { Runtime } from '../src/runtime.js';
import { DemoProvider } from '../src/providers.js';
import { ServiceScheduler } from '../src/services.js';
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'summon-unified-')); const path = join(dir, 'store.json'); let kernel = new Kernel(path);
  return { path, get kernel() { return kernel; }, restart() { kernel.close(); kernel = new Kernel(path); }, done() { kernel.close(); rmSync(dir, { recursive: true }); } };
};

test('bootstrap is owner-isolated, idempotent and never regrants a revoked service', () => {
  const f = fixture();
  try {
    f.kernel.bootstrap('a'); f.kernel.bootstrap('b');
    const r = new Runtime(new DemoProvider(), { kernel: f.kernel });
    const a = r.listCreatures('a')[0];
    assert.equal(r.listCreatures('a').length, 3);
    assert.throws(() => r.getCreature('b', a.id), { code: 'subject_not_found' });
    f.kernel.mount('a', a.id, 'conversation', false);
    f.restart(); f.kernel.bootstrap('a');
    const restarted = new Runtime(new DemoProvider(), { kernel: f.kernel });
    assert.equal(restarted.listCreatures('a').length, 3);
    assert.equal(restarted.getCreature('a', a.id).aibm.serviceAbilities.includes('conversation'), false);
  } finally { f.done(); }
});
test('new persistent subject is discoverable and shares durable conversation state', async () => {
  const f = fixture();
  try {
    const c = f.kernel.createSubject('owner', { name: '新主体' });
    f.kernel.mount('owner', c.id, 'conversation'); f.kernel.mount('owner', c.id, 'capabilities.describe');
    let runtime = new Runtime(new DemoProvider(), { kernel: f.kernel });
    const scheduler = new ServiceScheduler(runtime);
    assert.deepEqual(scheduler.discover('owner', c.id).map(s => s.id), ['capabilities.describe', 'conversation']);
    const session = runtime.createSession('owner', c.id);
    await scheduler.invoke('owner', { creatureId: c.id, serviceId: 'conversation', arguments: { sessionId: session.id, message: '记住本次会话' }, context: { zone: 'demo-world', renderers: ['text'] } });
    f.restart(); runtime = new Runtime(new DemoProvider(), { kernel: f.kernel });
    assert.equal(runtime.getSession('owner', session.id).turns.length, 2);
    assert.throws(() => runtime.getSession('other', session.id), { code: 'session_not_found' });
    f.kernel.transition('owner', c.id, 'paused');
    await assert.rejects(runtime.call('owner', session.id, 'paused'), { code: 'subject_not_active' });
    f.kernel.transition('owner', c.id, 'active');
    assert.equal((await runtime.call('owner', session.id, '继续')).turns.length, 4);
  } finally { f.done(); }
});
test('revocation during pending LLM request prevents result commit', async () => {
  const f = fixture();
  try {
    f.kernel.bootstrap('a'); const c = f.kernel.list('a').subjects.find(c => c.templateId === 'companion');
    let resolve; const r = new Runtime({ mode: 'test', respond: () => new Promise(done => resolve = done) }, { kernel: f.kernel });
    const s = r.createSession('a', c.id); const pending = r.call('a', s.id, 'hi');
    f.kernel.mount('a', c.id, 'conversation', false); resolve('too late');
    await assert.rejects(pending, { code: 'outside_service_boundary' });
    assert.equal(r.getSession('a', s.id).turns.length, 0);
  } finally { f.done(); }
});
test('two runtime adapters cannot overwrite a conversation revision', async () => {
  const f = fixture();
  try {
    f.kernel.bootstrap('a'); const c = f.kernel.list('a').subjects[0];
    let finish; const a = new Runtime({ mode: 'test', respond: () => new Promise(r => finish = r) }, { kernel: f.kernel });
    const b = new Runtime(new DemoProvider(), { kernel: f.kernel });
    const s = a.createSession('a', c.id); const slow = a.call('a', s.id, 'slow');
    await b.call('a', s.id, 'fast'); finish('slow reply');
    await assert.rejects(slow, { code: 'session_changed' });
    assert.equal(a.getSession('a', s.id).turns[0].content, 'fast');
    assert.equal(a.getSession('a', s.id).turns.length, 2);
  } finally { f.done(); }
});
test('v0.3 snapshot is normalized without discarding its subjects and tasks', () => {
  const f = fixture();
  try {
    f.kernel.close();
    writeFileSync(f.path, JSON.stringify({ version: 1, revision: 4, subjects: { legacy: { id: 'legacy', ownerId: 'a', name: 'legacy', status: 'active', aibm: { personality: 'x', activitySpace: 'fixed-simulation', serviceAbilities: ['local.report'], renderingAbilities: ['receipt-card'] } } }, tasks: {}, events: [], results: [] }));
    f.restart();
    assert.deepEqual(f.kernel.getSubject('a', 'legacy').aibm.activitySpace, { mode: 'fixed-simulation', zones: ['demo-world'] });
    assert.equal(f.kernel.list('a').revision, 4);
  } finally { f.done(); }
});
