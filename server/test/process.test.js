import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
const token = 'process-test-token-abcdefghijklmnopqrstuvwxyz';
async function start(store) {
  const child = spawn(process.execPath, ['src/main.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, APP_TOKEN: token, LLM_MODE: 'demo', KERNEL_STORE: store, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('server startup timeout')); }, 5000);
    child.stdout.on('data', data => { const match = /port=(\d+)/.exec(data.toString()); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
  });
  return { child, base: `http://127.0.0.1:${port}/v1/kernel/` };
}
async function stop(child) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }

test('running server ticks without client action, then restores state after restart', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'summon-process-')); let proc;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    proc = await start(join(dir, 'store.json'));
    const post = async (path, body) => {
      const response = await fetch(proc.base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.ok(response.ok); return response.json();
    };
    const subject = await post('subjects', { name: 'persistent process subject' });
    await post('mounts', { subjectId: subject.id, serviceId: 'local.report', enabled: true });
    await post('mounts', { subjectId: subject.id, serviceId: 'conversation', enabled: true });
    const apiBase = proc.base.replace('/kernel/', '/');
    const directory = await (await fetch(apiBase + 'creatures', { headers })).json();
    assert.ok(directory.creatures.some(c => c.id === subject.id));
    const session = await (await fetch(apiBase + 'sessions', { method: 'POST', headers, body: JSON.stringify({ creatureId: subject.id }) })).json();
    const called = await fetch(apiBase + `sessions/${session.id}/calls`, { method: 'POST', headers, body: JSON.stringify({ message: 'persist this conversation' }) });
    assert.equal(called.status, 200);
    await post('tasks', { subjectId: subject.id, serviceId: 'local.report', trigger: { kind: 'timer', at: Date.now() } });
    // No tick endpoint or client request drives execution. Wait for server clock.
    await new Promise(r => setTimeout(r, 1300));
    let state = await (await fetch(proc.base + 'state', { headers })).json();
    assert.equal(state.results.length, 1);
    await stop(proc.child); proc = null;
    proc = await start(join(dir, 'store.json'));
    state = await (await fetch(proc.base + 'state', { headers })).json();
    assert.ok(state.subjects.some(s => s.id === subject.id));
    assert.equal(state.results.length, 1);
    assert.equal(state.tasks[0].status, 'completed');
    const restoredSession = await (await fetch(proc.base.replace('/kernel/', '/') + `sessions/${session.id}`, { headers })).json();
    assert.equal(restoredSession.turns.length, 2);
    assert.equal(restoredSession.turns[0].content, 'persist this conversation');
  } finally { if (proc) await stop(proc.child); rmSync(dir, { recursive: true, force: true }); }
});
