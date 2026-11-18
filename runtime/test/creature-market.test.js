import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../microkernel/src/store.js';
import { HostIdentity } from '../../microkernel/src/identity.js';
import { CreatureRegistry } from '../src/creature-registry.js';
import { CreatureMarket, syntheticRoute } from '../src/creature-market.js';
const productId = 'demo.maps.v1';
const definition = id => ({ id, name: '伙伴', kind: 'pet', personality: '好奇', body: 'sprout', tone: 'playful' });
function fixture(options) {
  const dir = mkdtempSync(join(tmpdir(), 'creature-market-')), path = join(dir, 'core.sqlite');
  const auth = new HostIdentity(), alice = auth.authenticate('alice'), bob = auth.authenticate('bob');
  let store, registry, market;
  function open() { store = new SnapshotStore(path); registry = new CreatureRegistry(store, auth); market = new CreatureMarket(store, auth, registry, options); }
  open();
  return { auth, alice, bob, get store() { return store; }, get registry() { return registry; }, get market() { return market; },
    enable(handle = alice) { const sub = market.subscribe(handle, { productId }); return market.grantRoute(handle, { productId, enabled: true, expectedRevision: sub.revision }); },
    reopen() { store.close(); open(); }, close() { store.close(); rmSync(dir, { recursive: true }); } };
}
const request = (sub, requestId = 'r1') => ({ productId, instanceId: sub.instanceId, from: 'A', to: 'C', requestId });
test('subscribe atomically installs owned business instance, never senses/primary/route authority', async () => {
  const f = fixture(); try {
    const sub = f.market.subscribe(f.alice, { productId });
    assert.equal(sub.routeGranted, false); assert.equal(f.registry.state(f.alice).primaryCreatureId, null);
    const creature = f.registry.get(f.alice, sub.instanceId);
    assert.equal(creature.kind, 'business'); assert.deepEqual(creature.senses, { hearing: false, vision: false });
    assert.deepEqual(f.market.subscribe(f.alice, { productId }), sub); assert.equal(f.registry.list(f.alice).length, 1);
    await assert.rejects(f.market.route(f.alice, request(sub)), { code: 'route_not_authorized' });
    f.reopen(); assert.deepEqual(f.market.state(f.alice).subscriptions, [sub]);
    assert.equal(f.market.state(f.alice).catalog[0].providerId, 'demo-maps');
  } finally { f.close(); }
});
test('registry quota failure rolls back subscription and leaves existing primary unchanged', () => {
  const f = fixture(); try {
    for (let i = 0; i < 16; i++) f.registry.create(f.alice, definition('pet' + i));
    assert.throws(() => f.market.subscribe(f.alice, { productId }), { code: 'creature_capacity' });
    assert.deepEqual(f.market.state(f.alice).subscriptions, []);
    assert.equal(f.registry.state(f.alice).primaryCreatureId, 'pet0'); assert.equal(f.registry.list(f.alice).length, 16);
    assert.equal(f.market.subscribe(f.bob, { productId }).status, 'active');
  } finally { f.close(); }
});
test('only exact requested provider instance and nodes execute; receipt replay is persistent and immutable', async () => {
  let calls = 0; const f = fixture({ executor: async input => { calls++; return syntheticRoute(input); } });
  try {
    const sub = f.enable();
    for (const patch of [{ productId: 'google.maps' }, { instanceId: 'other' }, { from: 'real-location' }, { ownerId: 'bob' }]) await assert.rejects(f.market.route(f.alice, { ...request(sub), ...patch }));
    const response = await f.market.route(f.alice, request(sub)); assert.equal(calls, 1);
    assert.deepEqual(response.receipt.result, { path: ['A', 'B', 'C'], hops: 2 });
    assert.equal(response.receipt.source, 'deterministic-synthetic-route');
    assert.equal(response.render.receiptId, response.receipt.receiptId);
    assert.throws(() => { response.receipt.result.path[0] = 'forged'; }, TypeError);
    f.reopen(); const replay = await f.market.route(f.alice, request(sub));
    assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, response.receipt); assert.equal(calls, 1);
    await assert.rejects(f.market.route(f.alice, { ...request(sub), to: 'B' }), { code: 'route_request_conflict' });
  } finally { f.close(); }
});
test('owner identity isolates instances, requests, grants and retained receipts', async () => {
  const f = fixture(); try {
    const alice = f.enable(), bob = f.enable(f.bob);
    assert.notEqual(alice.instanceId, bob.instanceId);
    await assert.rejects(f.market.route(f.bob, request(alice)), { code: 'provider_instance_mismatch' });
    const a = await f.market.route(f.alice, request(alice)), b = await f.market.route(f.bob, request(bob));
    assert.notEqual(a.receipt.receiptId, b.receipt.receiptId);
    assert.equal(f.market.state(f.bob).receipts.some(r => r.instanceId === alice.instanceId), false);
    assert.throws(() => f.market.state({ id: 'alice' }), { code: 'unauthenticated' });
    assert.throws(() => f.market.grantRoute(f.alice, { productId, ownerId: 'bob', enabled: false, expectedRevision: alice.revision }), { code: 'invalid_shape' });
  } finally { f.close(); }
});
test('async revoke/regrant and unsubscribe/rejoin cannot publish old output', async () => {
  for (const change of ['regrant', 'resubscribe', 'identity']) {
    let release, enter; const entered = new Promise(r => enter = r);
    const f = fixture({ executor: input => { enter(); return new Promise(r => release = () => r(syntheticRoute(input))); } });
    try {
      const sub = f.enable(), pending = f.market.route(f.alice, request(sub)); await entered;
      if (change === 'identity') f.auth.revoke('alice');
      else if (change === 'regrant') {
        let s = f.market.grantRoute(f.alice, { productId, enabled: false, expectedRevision: sub.revision });
        f.market.grantRoute(f.alice, { productId, enabled: true, expectedRevision: s.revision });
      } else {
        f.market.unsubscribe(f.alice, { productId, expectedRevision: sub.revision });
        const s = f.market.subscribe(f.alice, { productId });
        assert.equal(s.instanceId, sub.instanceId); assert.equal(s.routeGranted, false);
        f.market.grantRoute(f.alice, { productId, enabled: true, expectedRevision: s.revision });
      }
      release(); await assert.rejects(pending);
      assert.equal(f.market.state(f.auth.authenticate('alice')).receipts.length, 0);
    } finally { f.close(); }
  }
});
test('concurrent duplicate never dispatches twice; bad executor output never renders success', async () => {
  let release, enter, calls = 0; const entered = new Promise(r => enter = r);
  const f = fixture({ executor: () => { calls++; enter(); return new Promise(r => release = r); } });
  try {
    const sub = f.enable(), pending = f.market.route(f.alice, request(sub)); await entered;
    await assert.rejects(f.market.route(f.alice, request(sub)), { code: 'route_pending' });
    release({ path: ['A', 'C'], hops: 1, receiptId: 'fake' }); await assert.rejects(pending);
    await assert.rejects(f.market.route(f.alice, request(sub)), { code: 'route_failed' });
    assert.equal(calls, 1); assert.equal(f.market.state(f.alice).receipts.length, 0);
  } finally { f.close(); }
});
test('timeout is terminal, late result ignored and new request may proceed', async () => {
  let release; let calls = 0;
  const f = fixture({ timeoutMs: 10, executor: input => ++calls === 1 ? new Promise(r => release = r) : syntheticRoute(input) });
  try {
    const sub = f.enable(); await assert.rejects(f.market.route(f.alice, request(sub)), { code: 'route_timeout' });
    release({ path: ['A', 'B', 'C'], hops: 2 }); await new Promise(r => setImmediate(r));
    assert.equal(f.market.state(f.alice).receipts.length, 0);
    f.reopen(); await assert.rejects(f.market.route(f.alice, request(sub)), { code: 'route_failed' });
    assert.equal((await f.market.route(f.alice, request(sub, 'r2'))).receipt.result.hops, 2);
  } finally { f.close(); }
});
test('unsubscribe keeps facts and instance, blocks new calls, replay does not execute', async () => {
  const f = fixture(); try {
    f.registry.create(f.alice, definition('my-primary')); const sub = f.enable();
    const done = await f.market.route(f.alice, request(sub));
    const inactive = f.market.unsubscribe(f.alice, { productId, expectedRevision: sub.revision });
    await assert.rejects(f.market.route(f.alice, request(sub, 'new-call')), { code: 'route_not_authorized' });
    assert.equal((await f.market.route(f.alice, request(sub))).receipt.receiptId, done.receipt.receiptId);
    assert.equal(f.registry.state(f.alice).primaryCreatureId, 'my-primary'); assert.equal(f.registry.list(f.alice).length, 2);
    assert.equal(f.market.state(f.alice).receipts.length, 1);
    assert.throws(() => f.market.grantRoute(f.alice, { productId, enabled: true, expectedRevision: inactive.revision }), { code: 'subscription_inactive' });
  } finally { f.close(); }
});
test('composition rejects mismatched store/identity domains and rollback undoes in-transaction registry create', () => {
  const f = fixture(); try {
    assert.throws(() => new CreatureMarket(f.store, new HostIdentity(), f.registry), { code: 'market_domain_mismatch' });
    assert.throws(() => f.store.transaction(tx => { f.registry.createInTransaction(tx, f.alice, definition('rollback')); throw Error('rollback'); }));
    assert.equal(f.registry.list(f.alice).length, 0);
  } finally { f.close(); }
});

test('actual SIGKILL with pending synthetic request cannot cause automatic redispatch after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'market-crash-')), path = join(dir, 'core.sqlite');
  const modules = {
    store: new URL('../../microkernel/src/store.js', import.meta.url).href,
    auth: new URL('../../microkernel/src/identity.js', import.meta.url).href,
    registry: new URL('../src/creature-registry.js', import.meta.url).href,
    market: new URL('../src/creature-market.js', import.meta.url).href,
  };
  const code = `import {SnapshotStore} from ${JSON.stringify(modules.store)};
    import {HostIdentity} from ${JSON.stringify(modules.auth)};
    import {CreatureRegistry} from ${JSON.stringify(modules.registry)};
    import {CreatureMarket} from ${JSON.stringify(modules.market)};
    const store=new SnapshotStore(process.argv[1]),auth=new HostIdentity(),handle=auth.authenticate('alice');
    const registry=new CreatureRegistry(store,auth);
    const market=new CreatureMarket(store,auth,registry,{timeoutMs:5000,executor:()=>{console.log('pending-ready');setInterval(()=>{},1000);return new Promise(()=>{});}});
    let sub=market.subscribe(handle,{productId:'demo.maps.v1'});
    sub=market.grantRoute(handle,{productId:sub.productId,enabled:true,expectedRevision:sub.revision});
    await market.route(handle,{productId:sub.productId,instanceId:sub.instanceId,from:'A',to:'C',requestId:'crash'});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume(); let store;
  try {
    const closed = once(child, 'close');
    await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(Error('child startup timeout')), 4000);
      child.stdout.on('data', bytes => { text += bytes; if (text.includes('pending-ready')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    child.kill('SIGKILL'); await closed;
    store = new SnapshotStore(path); const auth = new HostIdentity(), handle = auth.authenticate('alice');
    let calls = 0; const market = new CreatureMarket(store, auth, new CreatureRegistry(store, auth), { executor: () => { calls++; return {}; } });
    const sub = market.state(handle).subscriptions[0];
    await assert.rejects(market.route(handle, request(sub, 'crash')), { code: 'route_pending' });
    assert.equal(calls, 0); assert.equal(market.state(handle).receipts.length, 0);
  } finally { child.kill('SIGKILL'); store?.close(); rmSync(dir, { recursive: true }); }
});
test('bounded request history fails closed but preserves replay and isolates owner capacity', async () => {
  const f = fixture(); try {
    const sub = f.enable(); let first;
    for (let i = 0; i < 128; i++) { const r = await f.market.route(f.alice, request(sub, 'request' + i)); if (i === 0) first = r; }
    const state = f.market.state(f.alice); assert.equal(state.requestCount, 128); assert.equal(state.receipts.length, 16);
    await assert.rejects(f.market.route(f.alice, request(sub, 'overflow')), { code: 'route_request_capacity' });
    assert.equal((await f.market.route(f.alice, request(sub, 'request0'))).receipt.receiptId, first.receipt.receiptId);
    const bob = f.enable(f.bob); assert.equal((await f.market.route(f.bob, request(bob))).replayed, false);
  } finally { f.close(); }
});

test('unknown cancellation persists a bounded owner tombstone and rejects delayed old requests across restart', async () => {
  let calls = 0; const f = fixture({ executor: input => { calls++; return syntheticRoute(input); } });
  try {
    assert.deepEqual(f.market.cancelRequest(f.alice, { requestId: 'delayed' }), { requestId: 'delayed', status: 'cancelled' });
    assert.deepEqual(f.market.state(f.alice).requests, [{ requestId: 'delayed', status: 'cancelled' }]);
    f.reopen(); const sub = f.enable();
    await assert.rejects(f.market.route(f.alice, request(sub, 'delayed')), { code: 'route_cancelled' });
    await assert.rejects(f.market.route(f.alice, { ...request(sub, 'delayed'), to: 'B' }), { code: 'route_cancelled' });
    assert.equal(calls, 0);
    assert.equal((await f.market.route(f.alice, request(sub, 'explicit-new'))).replayed, false);
    const bob = f.enable(f.bob); assert.equal((await f.market.route(f.bob, request(bob, 'delayed'))).replayed, false);
    assert.throws(() => f.market.cancelRequest(f.alice, { requestId: 'foo', ownerId: 'bob' }), { code: 'invalid_shape' });
  } finally { f.close(); }
});
test('pending cancellation rejects late output, completed cancellation preserves fact, failed requests can be retired', async () => {
  let release, entered; const ready = new Promise(r => entered = r);
  const f = fixture({ executor: input => { entered(); return new Promise(r => release = () => r(syntheticRoute(input))); } });
  try {
    const sub = f.enable(), pending = f.market.route(f.alice, request(sub)); await ready;
    assert.deepEqual(f.market.state(f.alice).requests, [{ requestId: 'r1', status: 'pending' }]);
    assert.deepEqual(f.market.cancelRequest(f.alice, { requestId: 'r1' }), { requestId: 'r1', status: 'cancelled' });
    release(); await assert.rejects(pending, { code: 'route_cancelled' });
    f.reopen(); assert.equal(f.market.state(f.alice).requests[0].status, 'cancelled');
    assert.equal(f.market.state(f.alice).receipts.length, 0);
  } finally { f.close(); }
  const g = fixture(); try {
    const sub = g.enable(), response = await g.market.route(g.alice, request(sub));
    assert.deepEqual(g.market.cancelRequest(g.alice, { requestId: 'r1' }), { requestId: 'r1', status: 'completed' });
    assert.equal((await g.market.route(g.alice, request(sub))).receipt.receiptId, response.receipt.receiptId);
    assert.equal(g.market.state(g.alice).requests[0].status, 'completed');
  } finally { g.close(); }
  const h = fixture({ executor: () => { throw Error('fixture failure'); } }); try {
    const sub = h.enable(); await assert.rejects(h.market.route(h.alice, request(sub)));
    assert.equal(h.market.state(h.alice).requests[0].status, 'failed');
    h.market.cancelRequest(h.alice, { requestId: 'r1' });
    assert.equal(h.market.state(h.alice).requests[0].status, 'cancelled');
  } finally { h.close(); }
});
test('cancel tombstones share quota without evicting old identities or affecting other owners', () => {
  const f = fixture(); try {
    for (let i = 0; i < 128; i++) f.market.cancelRequest(f.alice, { requestId: 'cancel' + i });
    assert.equal(f.market.state(f.alice).requests.length, 128);
    assert.throws(() => f.market.cancelRequest(f.alice, { requestId: 'overflow' }), { code: 'route_request_capacity' });
    assert.equal(f.market.cancelRequest(f.alice, { requestId: 'cancel0' }).status, 'cancelled');
    assert.equal(f.market.cancelRequest(f.bob, { requestId: 'overflow' }).status, 'cancelled');
  } finally { f.close(); }
});
