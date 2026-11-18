import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../microkernel/src/store.js';
import { HostIdentity } from '../../microkernel/src/identity.js';
import { digest } from '../../microkernel/src/canonical.js';
import { CreatureRegistry } from '../src/creature-registry.js';
const definition = (id = 'companion') => ({ id, name: '小伴', kind: 'companion', personality: '好奇且尊重边界', body: 'sprout', tone: 'playful' });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'creature-registry-')), path = join(dir, 'state.sqlite');
  const auth = new HostIdentity(), alice = auth.authenticate('alice'), bob = auth.authenticate('bob');
  let store = new SnapshotStore(path), registry = new CreatureRegistry(store, auth);
  return { auth, alice, bob, get registry() { return registry; }, get store() { return store; }, reopen() { store.close(); store = new SnapshotStore(path); registry = new CreatureRegistry(store, auth); }, close() { store.close(); rmSync(dir, { recursive: true }); } };
}
test('persistent owner registry defaults to first creature; descriptions never grant senses', () => {
  const f = fixture(); try {
    assert.deepEqual(f.registry.state(f.alice), { ownerId: 'alice', revision: 0, primaryCreatureId: null, creatures: [] });
    f.registry.create(f.alice, definition());
    let s = f.registry.create(f.alice, { ...definition('work'), kind: 'business', body: 'owl', tone: 'precise' });
    assert.equal(s.primaryCreatureId, 'companion'); assert.equal(s.revision, 2);
    s = f.registry.setPrimary(f.alice, { creatureId: 'work', expectedRevision: 2 });
    assert.equal(s.primaryCreatureId, 'work');
    for (const c of s.creatures) { assert.deepEqual(c.senses, { hearing: false, vision: false }); assert.equal(c.generation, 0); }
    f.reopen(); assert.deepEqual(f.registry.state(f.alice), s);
    assert.throws(() => { f.registry.get(f.alice, 'work').senses.hearing = true; }, TypeError);
  } finally { f.close(); }
});
test('authenticated namespaces isolate read, create, primary and sensory mutations', () => {
  const f = fixture(); try {
    f.registry.create(f.alice, definition('private'));
    assert.deepEqual(f.registry.list(f.bob), []);
    assert.throws(() => f.registry.get(f.bob, 'private'), { code: 'creature_not_found' });
    assert.throws(() => f.registry.setPrimary(f.bob, { creatureId: 'private', expectedRevision: 1 }), { code: 'creature_not_found' });
    assert.throws(() => f.registry.setSense(f.bob, { creatureId: 'private', modality: 'hearing', enabled: true, expectedRevision: 1 }), { code: 'creature_not_found' });
    f.registry.create(f.bob, { ...definition('private'), name: '另一个主体' });
    f.registry.setSense(f.bob, { creatureId: 'private', modality: 'hearing', enabled: true, expectedRevision: 1 });
    assert.equal(f.registry.get(f.alice, 'private').senses.hearing, false);
    assert.throws(() => f.registry.create(f.bob, { ...definition(), ownerId: 'alice' }), { code: 'invalid_shape' });
    assert.throws(() => f.registry.state({ id: 'alice' }), { code: 'unauthenticated' });
    assert.throws(() => f.registry.state(new HostIdentity().authenticate('alice')), { code: 'unauthenticated' });
    f.auth.revoke('alice'); assert.throws(() => f.registry.list(f.alice), { code: 'unauthenticated' });
    assert.equal(f.registry.get(f.auth.authenticate('alice'), 'private').name, '小伴');
  } finally { f.close(); }
});
test('independent senses have persistent ABA generation and optimistic owner revision', () => {
  const f = fixture(); try {
    f.registry.create(f.alice, definition()); f.registry.create(f.alice, definition('pet'));
    let s = f.registry.setSense(f.alice, { creatureId: 'companion', modality: 'hearing', enabled: true, expectedRevision: 2 });
    assert.equal(s.revision, 3); assert.equal(s.creatures[0].generation, 1); assert.deepEqual(s.creatures[0].senseGenerations, { hearing: 1, vision: 0 });
    assert.throws(() => f.registry.setPrimary(f.alice, { creatureId: 'pet', expectedRevision: 2 }), { code: 'revision_conflict' });
    assert.throws(() => f.registry.setSense(f.alice, { creatureId: 'companion', modality: 'vision', enabled: true, expectedRevision: 2 }), { code: 'revision_conflict' });
    assert.equal(f.registry.setSense(f.alice, { creatureId: 'companion', modality: 'hearing', enabled: true, expectedRevision: 3 }).revision, 3);
    s = f.registry.setSense(f.alice, { creatureId: 'companion', modality: 'hearing', enabled: false, expectedRevision: 3 });
    s = f.registry.setSense(f.alice, { creatureId: 'companion', modality: 'hearing', enabled: true, expectedRevision: s.revision });
    s = f.registry.setSense(f.alice, { creatureId: 'companion', modality: 'vision', enabled: true, expectedRevision: s.revision });
    assert.equal(s.creatures[0].generation, 4); assert.deepEqual(s.creatures[0].senseGenerations, { hearing: 3, vision: 1 }); assert.deepEqual(s.creatures[1].senseGenerations, { hearing: 0, vision: 0 }); assert.deepEqual(s.creatures[1].senses, { hearing: false, vision: false });
    f.reopen(); assert.deepEqual(f.registry.state(f.alice), s);
  } finally { f.close(); }
});
test('strict C1 shape, text bounds, enums and owner-local capacity fail without partial writes', () => {
  const f = fixture(); try {
    let invoked = false; const evil = definition(); Object.defineProperty(evil, 'name', { get() { invoked = true; return 'bad'; }, enumerable: true });
    assert.throws(() => f.registry.create(f.alice, evil)); assert.equal(invoked, false);
    for (const patch of [{ id: '../escape' }, { name: 'x'.repeat(65) }, { personality: 'x'.repeat(513) }, { personality: ' ' }, { name: 'a\nb' }, { kind: 'admin' }, { body: 'http://external' }, { tone: 'execute' }, { senses: { hearing: true } }]) assert.throws(() => f.registry.create(f.alice, { ...definition(), ...patch }));
    assert.equal(f.registry.state(f.alice).revision, 0);
    for (let i = 0; i < 16; i++) f.registry.create(f.alice, definition('c' + i));
    assert.throws(() => f.registry.create(f.alice, definition('extra')), { code: 'creature_capacity' });
    assert.throws(() => f.registry.create(f.alice, definition('c0')), { code: 'creature_exists' });
    assert.equal(f.registry.create(f.bob, definition()).creatures.length, 1);
    assert.throws(() => f.registry.setSense(f.alice, { creatureId: 'c0', modality: 'hearing', enabled: 'yes', expectedRevision: 16 }), { code: 'invalid_sense_setting' });
    assert.throws(() => f.registry.setPrimary(f.alice, { creatureId: 'c0', expectedRevision: 0 }), { code: 'invalid_revision' });
    assert.equal(f.registry.state(f.alice).revision, 16);
  } finally { f.close(); }
});

test('legacy records without modality epochs normalize to zero without changing grants or stored revision', () => {
  const f = fixture(); try {
    const key = 'creature-registry.' + digest('creature-owner', 'alice').slice(7);
    f.store.transaction(tx => { tx.put(key, 'creature-registry', {
      ownerId: 'alice', primaryCreatureId: 'old', creatures: [{ ...definition('old'), senses: { hearing: true, vision: false }, generation: 7 }],
    }, 0); return null; });
    f.reopen(); let s = f.registry.state(f.alice);
    assert.equal(s.revision, 1); assert.equal(s.creatures[0].generation, 7);
    assert.deepEqual(s.creatures[0].senseGenerations, { hearing: 0, vision: 0 });
    assert.deepEqual(s.creatures[0].senses, { hearing: true, vision: false });
    assert.equal(f.store.get(key).value.creatures[0].senseGenerations, undefined);
    s = f.registry.setSense(f.alice, { creatureId: 'old', modality: 'vision', enabled: true, expectedRevision: 1 });
    assert.deepEqual(s.creatures[0].senseGenerations, { hearing: 0, vision: 1 });
    assert.equal(s.creatures[0].generation, 8);
    s = f.registry.setSense(f.alice, { creatureId: 'old', modality: 'vision', enabled: false, expectedRevision: 2 });
    assert.deepEqual(s.creatures[0].senseGenerations, { hearing: 0, vision: 2 });
    assert.deepEqual(s.creatures[0].senses, { hearing: true, vision: false });
    f.reopen(); assert.deepEqual(f.registry.state(f.alice), s);
  } finally { f.close(); }
});
