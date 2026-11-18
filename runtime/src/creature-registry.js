import { snapshot, digest } from '../../microkernel/src/canonical.js';
import { deny, fields, id } from '../../microkernel/src/grants.js';

const kinds = ['companion', 'stand-in', 'pet', 'business'];
const request = (raw, required) => {
  const value = snapshot('creature-registry-request', raw).value;
  fields(value, required);
  return value;
};
function boundedText(value, max) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max ||
      /[\u0000-\u001f\u007f]/u.test(value)) deny('invalid_creature_text');
}
const resourceKey = owner => 'creature-registry.' + digest('creature-owner', owner).slice(7);

// Trusted-host identity handles only: this is not remote/production authentication.
// Kind/personality/body are descriptive data, never service or business authority.
// Host seeds defaults by invoking create with the intended owner's authenticated
// handle. No admin override, client-supplied owner, or implicit sensory permission.
export class CreatureRegistry {
  #store; #auth;
  constructor(store, identities) { this.#store = store; this.#auth = identities; }
  belongsTo(store, identities) { return this.#store === store && this.#auth === identities; }
  #read(reader, owner) {
    const record = reader.get(resourceKey(owner));
    if (record && (record.kind !== 'creature-registry' || record.value.ownerId !== owner)) deny('registry_domain_mismatch');
    return record;
  }
  #view(owner, record) {
    return snapshot('creature-registry-view', {
      ...(record?.value ?? { ownerId: owner, primaryCreatureId: null, creatures: [] }),
      revision: record?.revision ?? 0,
      creatures: (record?.value.creatures ?? []).map(c => ({
        ...c, senseGenerations: c.senseGenerations ?? { hearing: 0, vision: 0 },
      })),
    }).value;
  }
  state(handle) {
    const owner = this.#auth.resolve(handle);
    return this.#view(owner, this.#read(this.#store, owner));
  }
  list(handle) { return this.state(handle).creatures; }
  get(handle, creatureId) {
    const state = this.state(handle); id(creatureId);
    const creature = state.creatures.find(c => c.id === creatureId);
    if (!creature) deny('creature_not_found');
    return creature;
  }
  create(handle, raw) {
    return this.#store.transaction(tx => this.createInTransaction(tx, handle, raw));
  }
  // Internal host composition only. The caller must use this registry's store.
  createInTransaction(tx, handle, raw, { preservePrimary = false } = {}) {
    const owner = this.#auth.resolve(handle);
    const spec = request(raw, ['id', 'name', 'kind', 'personality', 'body', 'tone']);
    id(spec.id); boundedText(spec.name, 64); boundedText(spec.personality, 512);
    if (!kinds.includes(spec.kind) || !['sprout', 'owl'].includes(spec.body) ||
        !['playful', 'precise'].includes(spec.tone)) deny('invalid_creature_definition');
    {
      const record = this.#read(tx, owner), state = this.#view(owner, record);
      if (state.creatures.some(c => c.id === spec.id)) deny('creature_exists');
      if (state.creatures.length >= 16) deny('creature_capacity');
      const creature = { ...spec, senses: { hearing: false, vision: false }, generation: 0, senseGenerations: { hearing: 0, vision: 0 } };
      const saved = tx.put(resourceKey(owner), 'creature-registry', {
        ownerId: owner, primaryCreatureId: preservePrimary ? state.primaryCreatureId : (state.primaryCreatureId ?? spec.id),
        creatures: [...state.creatures, creature],
      }, state.revision);
      return this.#view(owner, saved);
    }
  }
  #change(handle, spec, apply) {
    const owner = this.#auth.resolve(handle); id(spec.creatureId);
    if (!Number.isSafeInteger(spec.expectedRevision) || spec.expectedRevision < 1) deny('invalid_revision');
    return this.#store.transaction(tx => {
      const record = this.#read(tx, owner), state = this.#view(owner, record);
      // Resolve only in the authenticated owner's namespace, including primary.
      const creature = state.creatures.find(c => c.id === spec.creatureId);
      if (!creature) deny('creature_not_found');
      if (state.revision !== spec.expectedRevision) deny('revision_conflict');
      const next = apply(state, creature);
      if (next === null) return state; // Idempotent same-value operation, after CAS.
      return this.#view(owner, tx.put(resourceKey(owner), 'creature-registry', next, state.revision));
    });
  }
  setPrimary(handle, raw) {
    const spec = request(raw, ['creatureId', 'expectedRevision']);
    return this.#change(handle, spec, state => state.primaryCreatureId === spec.creatureId ? null : {
      ownerId: state.ownerId, primaryCreatureId: spec.creatureId, creatures: state.creatures,
    });
  }
  setSense(handle, raw) {
    const spec = request(raw, ['creatureId', 'modality', 'enabled', 'expectedRevision']);
    if (!['hearing', 'vision'].includes(spec.modality) || typeof spec.enabled !== 'boolean') deny('invalid_sense_setting');
    return this.#change(handle, spec, (state, creature) => {
      if (creature.senses[spec.modality] === spec.enabled) return null;
      if (creature.generation === Number.MAX_SAFE_INTEGER || creature.senseGenerations[spec.modality] === Number.MAX_SAFE_INTEGER) deny('generation_exhausted');
      return {
        ownerId: state.ownerId, primaryCreatureId: state.primaryCreatureId,
        creatures: state.creatures.map(c => c.id !== creature.id ? c : {
          ...c, senses: { ...c.senses, [spec.modality]: spec.enabled }, generation: c.generation + 1,
          senseGenerations: { ...c.senseGenerations, [spec.modality]: c.senseGenerations[spec.modality] + 1 },
        }),
      };
    });
  }
}
