import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.js';
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'summon-kernel-')); let time = 1000;
  const path = join(dir, 'store.json');
  let k = new Kernel(path, { clock: () => time, minIntervalMs: 100 });
  return { get k() { return k; }, setTime: t => time = t, restart() { k.close(); k = new Kernel(path, { clock: () => time, minIntervalMs: 100 }); }, path, done() { k.close(); rmSync(dir, { recursive: true }); } };
};
test('persistent subjects, services, recurring tasks survive client absence and process restart', () => {
  const f = setup();
  try {
    const subject = f.k.createSubject('owner', { name: '固定主体' });
    f.k.mount('owner', subject.id, 'local.report');
    f.k.schedule('owner', { subjectId: subject.id, serviceId: 'local.report', trigger: { kind: 'timer', at: 1000, intervalMs: 100 }, payload: { purpose: 'fixture broadcast receipt, not an actual broadcast' } });
    assert.equal(f.k.tick().length, 1); assert.equal(f.k.tick().length, 0);
    f.restart(); assert.equal(f.k.list('owner').subjects[0].name, '固定主体');
    f.setTime(5000); assert.equal(f.k.tick().length, 1); // missed slots are not replayed
    assert.equal(f.k.tick().length, 0);
    assert.equal(f.k.list('owner').results.length, 2);
  } finally { f.done(); }
});
test('paused and retired subjects stop work; revoked capabilities cancel tasks', () => {
  const f = setup();
  try {
    const s = f.k.createSubject('a', { name: 'subject' }); f.k.mount('a', s.id, 'local.report');
    f.k.schedule('a', { subjectId: s.id, serviceId: 'local.report', trigger: { kind: 'timer', at: 1000, intervalMs: 100 } });
    f.k.transition('a', s.id, 'paused'); assert.equal(f.k.tick().length, 0);
    f.k.transition('a', s.id, 'active'); assert.equal(f.k.tick().length, 1);
    f.k.mount('a', s.id, 'local.report', false); f.setTime(2000); assert.equal(f.k.tick().length, 0);
    assert.equal(f.k.list('a').tasks[0].status, 'cancelled');
    f.k.transition('a', s.id, 'retired'); assert.throws(() => f.k.transition('a', s.id, 'active'), { code: 'subject_retired' });
  } finally { f.done(); }
});
test('event task coalesces repeated signals and respects minimum intervals', () => {
  const f = setup();
  try {
    const s = f.k.createSubject('a', { name: 'simulated local connector' }); f.k.mount('a', s.id, 'local.report');
    f.k.schedule('a', { subjectId: s.id, serviceId: 'local.report', trigger: { kind: 'event', type: 'connector.lost', repeat: true } });
    assert.equal(f.k.signal('a', { subjectId: s.id, type: 'connector.lost' }).queued, 1);
    assert.equal(f.k.signal('a', { subjectId: s.id, type: 'connector.lost' }).queued, 0);
    assert.equal(f.k.tick().length, 1);
    f.k.signal('a', { subjectId: s.id, type: 'connector.lost' }); assert.equal(f.k.tick().length, 0);
    f.setTime(1100); assert.equal(f.k.tick().length, 1);
  } finally { f.done(); }
});
test('owners, service whitelist, policies and store lock fail closed', () => {
  const f = setup();
  try {
    const s = f.k.createSubject('a', { name: 'subject' });
    assert.throws(() => new Kernel(f.path), /locked/);
    assert.throws(() => f.k.mount('b', s.id, 'local.report'), { code: 'subject_not_found' });
    assert.throws(() => f.k.mount('a', s.id, '__proto__'), { code: 'unsupported_local_service' });
    assert.throws(() => f.k.mount('a', s.id, 'shell.execute'), { code: 'unsupported_local_service' });
    assert.throws(() => f.k.schedule('a', { subjectId: s.id, serviceId: 'local.report', trigger: { kind: 'timer', at: 1000 } }), { code: 'outside_service_boundary' });
    f.k.mount('a', s.id, 'local.report');
    assert.throws(() => f.k.schedule('a', { subjectId: s.id, serviceId: 'local.report', trigger: { kind: 'timer', at: 1000, intervalMs: 1 } }), { code: 'invalid_timer' });
    assert.deepEqual(f.k.list('b').subjects, []);
  } finally { f.done(); }
});

test('arrival guidance retains no-reservation constraint through restart and runs once', () => {
  const f = setup();
  try {
    const s = f.k.createSubject('owner', { name: '车辆场景模拟主体', activitySpace: 'follow-owner-simulation' });
    f.k.mount('owner', s.id, 'local.report');
    f.k.schedule('owner', {
      subjectId: s.id, serviceId: 'local.report', trigger: { kind: 'event', type: 'destination.approaching' },
      payload: { destination: '模拟公园', instructions: '接近目的地时给出指导', constraints: { reserveParking: false, paidAction: false } },
    });
    f.restart();
    f.k.signal('owner', { subjectId: s.id, type: 'destination.approaching' });
    const first = f.k.tick(); assert.equal(first.length, 1);
    assert.equal(first[0].payload.constraints.reserveParking, false);
    assert.equal(first[0].effect, 'local-only');
    f.restart(); f.k.signal('owner', { subjectId: s.id, type: 'destination.approaching' });
    assert.equal(f.k.tick().length, 0);
    assert.equal(f.k.list('owner').results.length, 1);
  } finally { f.done(); }
});

test('kernel HTTP exposes persistent primitives only behind authentication', async () => {
  const { createApi } = await import('../src/http.js');
  const { Runtime } = await import('../src/runtime.js');
  const { DemoProvider } = await import('../src/providers.js');
  const f = setup(); const token = 'kernel-test-token-abcdefghijklmnopqrstuvwxyz';
  const server = createApi(new Runtime(new DemoProvider()), { appToken: token, kernel: f.k });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1/kernel/`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + 'state')).status, 401);
    const created = await fetch(base + 'subjects', { method: 'POST', headers, body: JSON.stringify({ name: 'persistent HTTP subject' }) });
    assert.equal(created.status, 201); const s = await created.json();
    assert.equal((await fetch(base + 'mounts', { method: 'POST', headers, body: JSON.stringify({ subjectId: s.id, serviceId: 'local.report', enabled: true }) })).status, 200);
    assert.equal((await fetch(base + 'tasks', { method: 'POST', headers, body: JSON.stringify({ subjectId: s.id, serviceId: 'local.report', trigger: { kind: 'timer', at: 1000 } }) })).status, 201);
    assert.equal(f.k.tick().length, 1);
    const state = await (await fetch(base + 'state', { headers })).json();
    assert.equal(state.results.length, 1);
  } finally { await new Promise(r => server.close(r)); f.done(); }
});
