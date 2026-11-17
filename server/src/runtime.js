import { randomUUID } from 'node:crypto';

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
export const creatures = deepFreeze([
  { id: 'companion', name: '同行者', role: 'companion', description: '陪伴用户探索现实生活的数字角色。', capabilities: ['conversation'],
    aibm: { personality: '友善、简洁', activitySpace: { mode: 'follow-owner', zones: ['demo-world'] }, serviceAbilities: ['conversation', 'capabilities.describe'], renderingAbilities: ['text', 'capability-card'] } },
  { id: 'guide', name: '向导', role: 'guide', description: '帮助梳理计划和问题的数字角色。', capabilities: ['conversation'],
    aibm: { personality: '清晰、有条理', activitySpace: { mode: 'stationary', zones: ['demo-world'] }, serviceAbilities: ['conversation', 'capabilities.describe'], renderingAbilities: ['text', 'capability-card'] } },
  { id: 'restaurant', name: '演示餐馆替身', role: 'restaurant', description: '提供演示菜单和点餐预览，不连接真实商户。', capabilities: ['menu.read', 'order.preview'],
    aibm: { personality: '热情、诚实', activitySpace: { mode: 'stationary', zones: ['demo-restaurant'] }, serviceAbilities: ['menu.read', 'order.preview', 'capabilities.describe'], renderingAbilities: ['menu-card', 'order-card', 'capability-card'] } },
]);

export class DomainError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

// One process, local prototype only. Identity is supplied by the authenticated API,
// never accepted from a request body. Spatial modes are metadata, not GPS tracking.
export class Runtime {
  #sessions = new Map();
  constructor(provider, { maxSessions = 1000, maxTurns = 50 } = {}) {
    this.provider = provider; this.maxSessions = maxSessions; this.maxTurns = maxTurns;
  }
  createSession(ownerId, creatureId) {
    if (!creatures.some(c => c.id === creatureId)) throw new DomainError(404, 'creature_not_found');
    if (this.#sessions.size >= this.maxSessions) throw new DomainError(429, 'session_capacity');
    const session = { id: randomUUID(), ownerId, creatureId, turns: [], busy: false };
    this.#sessions.set(session.id, session);
    return this.#public(session);
  }
  #owned(ownerId, id) {
    const session = this.#sessions.get(id);
    if (!session || session.ownerId !== ownerId) throw new DomainError(404, 'session_not_found');
    return session;
  }
  #public(s) { return { id: s.id, creatureId: s.creatureId, turns: structuredClone(s.turns) }; }
  getSession(ownerId, id) { return this.#public(this.#owned(ownerId, id)); }
  async call(ownerId, id, input) {
    const s = this.#owned(ownerId, id);
    if (!creatures.find(c => c.id === s.creatureId).aibm.serviceAbilities.includes('conversation')) throw new DomainError(403, 'outside_service_boundary');
    if (typeof input !== 'string' || !input.trim() || input.length > 4000) throw new DomainError(400, 'invalid_message');
    if (s.busy) throw new DomainError(409, 'session_busy');
    if (s.turns.length >= this.maxTurns * 2) throw new DomainError(429, 'turn_limit');
    s.busy = true;
    try {
      const creature = creatures.find(c => c.id === s.creatureId);
      const user = { role: 'user', content: input.trim() };
      const content = await this.provider.respond(creature, [...structuredClone(s.turns), user]);
      if (typeof content !== 'string' || !content.trim() || content.length > 16000) throw new DomainError(502, 'invalid_provider_response');
      s.turns.push(user, { role: 'assistant', content });
      return this.#public(s);
    } finally { s.busy = false; }
  }
}
