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
  createSession(ownerId, creatureId) {
    this.getCreature(ownerId, creatureId);
    if (this.kernel) return this.#public(this.kernel.createSession(ownerId, creatureId, this.maxSessions));
    if (this.#sessions.size >= this.maxSessions) throw new DomainError(429, 'session_capacity');
    const session = { id: randomUUID(), ownerId, creatureId, turns: [] };
    this.#sessions.set(session.id, session);
    return this.#public(session);
  }
  #owned(ownerId, id) {
    if (this.kernel) return this.kernel.getSession(ownerId, id);
    const session = this.#sessions.get(id);
    if (!session || session.ownerId !== ownerId) throw new DomainError(404, 'session_not_found');
    return session;
  }
  #public(s) { return { id: s.id, creatureId: s.creatureId, turns: structuredClone(s.turns) }; }
  getSession(ownerId, id) { return this.#public(this.#owned(ownerId, id)); }
  async call(ownerId, id, input) {
    const s = this.#owned(ownerId, id);
    const creature = this.getCreature(ownerId, s.creatureId);
    if (!creature.aibm.serviceAbilities.includes('conversation')) throw new DomainError(403, 'outside_service_boundary');
    if (typeof input !== 'string' || !input.trim() || input.length > 4000) throw new DomainError(400, 'invalid_message');
    if (this.#busy.has(id)) throw new DomainError(409, 'session_busy');
    if (s.turns.length >= this.maxTurns * 2) throw new DomainError(429, 'turn_limit');
    this.#busy.add(id);
    try {
      const user = { role: 'user', content: input.trim() };
      const content = await this.provider.respond(creature, [...structuredClone(s.turns), user]);
      if (typeof content !== 'string' || !content.trim() || content.length > 16000) throw new DomainError(502, 'invalid_provider_response');
      const assistant = { role: 'assistant', content };
      // Recheck lifecycle/grants after asynchronous model work; revocation wins.
      if (this.kernel) return this.#public(this.kernel.appendTurn(ownerId, id, s.turns.length, user, assistant));
      s.turns.push(user, assistant);
      return this.#public(s);
    } finally { this.#busy.delete(id); }
  }
}
