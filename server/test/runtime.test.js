import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/runtime.js';
import { DemoProvider, CompatibleProvider } from '../src/providers.js';
import { createApi } from '../src/http.js';

test('identity, isolated sessions and bounded calls', async () => {
  const r = new Runtime(new DemoProvider(), { maxTurns: 1 });
  const a = r.createSession('a', 'companion');
  const b = r.createSession('a', 'guide');
  assert.throws(() => r.getSession('b', a.id), { code: 'session_not_found' });
  assert.throws(() => r.createSession('a', 'unknown'), { code: 'creature_not_found' });
  const result = await r.call('a', a.id, '你好');
  assert.equal(result.turns.length, 2);
  assert.match(result.turns[1].content, /演示模式/);
  assert.equal(r.getSession('a', b.id).turns.length, 0);
  result.turns[0].content = 'mutated';
  assert.equal(r.getSession('a', a.id).turns[0].content, '你好');
  await assert.rejects(r.call('a', a.id, 'again'), { code: 'turn_limit' });
});
test('failed requests do not mutate history, busy requests reject', async () => {
  let resolve; const r = new Runtime({ respond: () => new Promise(r => resolve = r) });
  const s = r.createSession('a', 'guide');
  await assert.rejects(r.call('a', s.id, '  '), { code: 'invalid_message' });
  const pending = r.call('a', s.id, 'hi');
  await assert.rejects(r.call('a', s.id, 'double tap'), { code: 'session_busy' });
  resolve(null);
  await assert.rejects(pending, { code: 'invalid_provider_response' });
  assert.equal(r.getSession('a', s.id).turns.length, 0);
  const retry = r.call('a', s.id, 'retry'); resolve('ok');
  assert.equal((await retry).turns.length, 2);
});
test('compatible adapter sends expected contract and refuses insecure endpoint', async () => {
  assert.throws(() => new CompatibleProvider({ endpoint: 'http://example.test', apiKey: 'test', model: 'm' }));
  const p = new CompatibleProvider({ endpoint: 'https://example.test/v1/chat/completions', apiKey: 'test-not-real', model: 'm', fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).messages.length, 2);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'reply' } }] }) };
  }});
  assert.equal(await p.respond({ name: 'a', description: 'b' }, [{ role: 'user', content: 'hi' }]), 'reply');
});
test('HTTP authentication and complete local round trip', async () => {
  const token = 'test-only-token-abcdefghijklmnopqrstuvwxyz';
  const server = createApi(new Runtime(new DemoProvider()), { appToken: token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/v1/creatures')).status, 401);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await (await fetch(base + '/v1/creatures', { headers })).json()).creatures.length, 3);
    const created = await fetch(base + '/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ creatureId: 'guide' }) });
    assert.equal(created.status, 201); const session = await created.json();
    const called = await fetch(base + `/v1/sessions/${session.id}/calls`, { method: 'POST', headers, body: JSON.stringify({ message: 'hello' }) });
    assert.equal(called.status, 200); assert.equal((await called.json()).turns.length, 2);
    assert.equal((await fetch(base + '/v1/sessions', { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(base + '/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ message: 'a'.repeat(17000) }) })).status, 413);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('legacy conversation route cannot bypass creature service boundary', async () => {
  const r = new Runtime(new DemoProvider());
  const s = r.createSession('a', 'restaurant');
  await assert.rejects(r.call('a', s.id, 'hi'), { code: 'outside_service_boundary' });
});
