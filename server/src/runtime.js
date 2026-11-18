import { validateScene } from './presentation.js';
import { randomUUID } from 'node:crypto';
import { creatures, DomainError } from './model.js';
export { creatures, DomainError } from './model.js';

// Production main supplies the persistent kernel. The optional in-memory mode
// remains solely a lightweight fixture for isolated provider/transport tests.
export class Runtime {
  #sessions = new Map();
  #busy = new Set();
  constructor(provider, { kernel = null, maxSessions = 1000, maxTurns = 50 } = {}) {
    this.provider = provider; this.kernel = kernel; this.maxSessions = maxSessions; this.maxTurns = maxTurns;
  }
  listCreatures(ownerId) {
    const list = this.kernel ? this.kernel.list(ownerId).subjects.filter(s => s.status === 'active') : structuredClone(creatures);
    return list.map(c => ({ ...c, capabilities: [...c.aibm.serviceAbilities] }));
  }
  getCreature(ownerId, id) {
    if (this.kernel) { const c = this.kernel.getSubject(ownerId, id); return { ...c, capabilities: [...c.aibm.serviceAbilities] }; }
    const c = creatures.find(c => c.id === id);
    if (!c) throw new DomainError(404, 'creature_not_found');
    return structuredClone(c);
  }
  connectorStatus(ownerId, creatureId, kind) {
    this.getCreature(ownerId, creatureId);
    return this.kernel ? this.kernel.connectorStatus(ownerId, creatureId, kind)
      : { available: false, simulation: true, reason: 'connector_unavailable' };
  }
  createSession(ownerId, creatureId) {
    this.getCreature(ownerId, creatureId);
    if (this.kernel) return this.#public(this.kernel.createSession(ownerId, creatureId, this.maxSessions));
    if (this.#sessions.size >= this.maxSessions) throw new DomainError(429, 'session_capacity');
    const session = { id: randomUUID(), ownerId, creatureId, turns: [] };
    this.#sessions.set(session.id, session);
    return this.#public(session);
  }
  resumeSession(ownerId, creatureId) {
    this.getCreature(ownerId, creatureId);
    if (this.kernel) return this.#public(this.kernel.resumeSession(ownerId, creatureId, this.maxSessions));
    const existing = [...this.#sessions.values()].reverse()
      .find(s => s.ownerId === ownerId && s.creatureId === creatureId);
    return existing ? this.#public(existing) : this.createSession(ownerId, creatureId);
  }
  listSessions(ownerId, creatureId) {
    this.getCreature(ownerId, creatureId);
    const sessions = this.kernel ? this.kernel.listSessions(ownerId, creatureId)
      : [...this.#sessions.values()].filter(s => s.ownerId === ownerId && s.creatureId === creatureId)
        .reverse().map(s => ({ id: s.id, creatureId: s.creatureId, turnCount: s.turns.length / 2 }));
    return { sessions, maxTurns: this.maxTurns };
  }
  #owned(ownerId, id) {
    if (this.kernel) return this.kernel.getSession(ownerId, id);
    const session = this.#sessions.get(id);
    if (!session || session.ownerId !== ownerId) throw new DomainError(404, 'session_not_found');
    return session;
  }
  #public(s) { return { id: s.id, creatureId: s.creatureId, turns: structuredClone(s.turns) }; }
  getSession(ownerId, id) { return this.#public(this.#owned(ownerId, id)); }
  async call(ownerId, id, input, { scene = false, commitGuard = null } = {}) {
    const s = this.#owned(ownerId, id);
    const creature = this.getCreature(ownerId, s.creatureId);
    if (!creature.aibm.serviceAbilities.includes('conversation')) throw new DomainError(403, 'outside_service_boundary');
    if (typeof input !== 'string' || !input.trim() || input.length > 4000) throw new DomainError(400, 'invalid_message');
    if (this.#busy.has(id)) throw new DomainError(409, 'session_busy');
    if (s.turns.length >= this.maxTurns * 2) throw new DomainError(429, 'turn_limit');
    this.#busy.add(id);
    try {
      const user = { role: 'user', content: input.trim() };
      const messages = [...structuredClone(s.turns), user];
      const structured = scene && typeof this.provider.respondScene === 'function';
      const raw = structured ? await this.provider.respondScene(creature, messages) : await this.provider.respond(creature, messages);
      const rendered = structured ? validateScene(raw) : null;
      const content = rendered ? rendered.answer : raw;
      if (typeof content !== 'string' || !content.trim() || content.length > 16000) throw new DomainError(502, 'invalid_provider_response');
      const assistant = { role: 'assistant', content };
      // Recheck lifecycle/grants after asynchronous model work; revocation wins.
      if (commitGuard) commitGuard();
      let saved;
      if (this.kernel) saved = this.#public(this.kernel.appendTurn(ownerId, id, s.turns.length, user, assistant, creature.authorizationVersion ?? 0));
      else { s.turns.push(user, assistant); saved = this.#public(s); }
      return scene ? { ...saved, presentation: rendered?.presentation ?? { strategy: 'plain-response', generatedByModel: false, components: [] }, providerMode: this.provider.mode } : saved;
    } finally { this.#busy.delete(id); }
  }
}
