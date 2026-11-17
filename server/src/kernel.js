import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, creatures, serviceCatalog } from './model.js';

const requireText = (v, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new DomainError(400, 'invalid_text');
  return v.trim();
};
const safeObject = v => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || JSON.stringify(v).length > 4000) throw new DomainError(400, 'invalid_payload');
  return structuredClone(v);
};
const scheduledServices = Object.freeze({
  // Only pure, local result generation is supported. No external side effects.
  'local.report': { effect: 'local-only', description: '生成本地任务回执，不广播、不控制设备、不发消息。' },
});

/** Single-process persistent kernel. JSON snapshots are atomically replaced.
 * Directory lease rejects a second writer. Stale leases after a crash require
 * an operator to verify no process owns the store before manual removal.
 * Pure local execution + snapshot commit means retries cannot duplicate an
 * external action (there are no external actions). Not a distributed scheduler.
 */
export class Kernel {
  constructor(path, { clock = () => Date.now(), minIntervalMs = 60000 } = {}) {
    this.path = path; this.clock = clock; this.minIntervalMs = minIntervalMs;
    this.lock = `${path}.lock`; this.closed = false;
    mkdirSync(dirname(path), { recursive: true });
    try { mkdirSync(this.lock); } catch { throw new Error('Kernel store already locked; verify owner before recovery'); }
    try {
      this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, subjects: {}, tasks: {}, events: [], results: [], revision: 0 };
      this.state.sessions ??= {};
      for (const subject of Object.values(this.state.subjects || {})) {
        if (typeof subject.aibm?.activitySpace === 'string') subject.aibm.activitySpace = { mode: subject.aibm.activitySpace, zones: ['demo-world'] };
      }
      if (this.state.version !== 1 || !this.state.subjects || !this.state.tasks || !Array.isArray(this.state.events) || !Array.isArray(this.state.results)) throw new Error('Invalid kernel store');
    } catch (e) { rmSync(this.lock, { recursive: true }); throw e; }
  }
  close() { if (!this.closed) { this.closed = true; rmSync(this.lock, { recursive: true }); } }
  #commit(change) {
    if (this.closed) throw new Error('Kernel closed');
    const draft = structuredClone(this.state);
    const result = change(draft);
    draft.revision++;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(draft), { mode: 0o600 }); renameSync(temp, this.path); }
    finally { if (existsSync(temp)) rmSync(temp); }
    this.state = draft;
    return structuredClone(result);
  }
  #subject(state, ownerId, id) {
    const subject = state.subjects[id];
    if (!subject || subject.ownerId !== ownerId) throw new DomainError(404, 'subject_not_found');
    return subject;
  }
  #event(state, type, ownerId, subjectId, details = {}) {
    state.events.push({ id: randomUUID(), type, ownerId, subjectId, at: this.clock(), details });
    if (state.events.length > 2000) state.events.splice(0, state.events.length - 2000);
  }
  createSubject(ownerId, { name, personality = '', activitySpace = 'fixed-simulation' } = {}) {
    name = requireText(name); personality = requireText(personality || '未指定', 1000);
    if (!['fixed-simulation', 'follow-owner-simulation'].includes(activitySpace)) throw new DomainError(400, 'invalid_activity_space');
    return this.#commit(state => {
      if (Object.keys(state.subjects).length >= 1000) throw new DomainError(429, 'subject_capacity');
      const subject = { id: randomUUID(), ownerId, name, role: 'custom', description: '用户创建的 AI 主体，仅可使用已挂载能力。', status: 'active', aibm: { personality, activitySpace: { mode: activitySpace, zones: ['demo-world'] }, serviceAbilities: [], renderingAbilities: ['receipt-card'] }, createdAt: this.clock() };
      state.subjects[subject.id] = subject; this.#event(state, 'subject.created', ownerId, subject.id); return subject;
    });
  }
  bootstrap(ownerId) {
    // Templates are only installed once per owner. Revoked grants stay revoked.
    if (this.state.bootstrapOwners?.includes(ownerId)) return;
    this.#commit(state => {
      state.bootstrapOwners ??= [];
      for (const template of creatures) {
        const subject = { ...structuredClone(template), id: randomUUID(), templateId: template.id, ownerId, status: 'active', createdAt: this.clock() };
        state.subjects[subject.id] = subject;
      }
      state.bootstrapOwners.push(ownerId);
      return { initialized: true };
    });
  }
  getSubject(ownerId, id, { requireActive = true } = {}) {
    const subject = this.#subject(this.state, ownerId, id);
    if (requireActive && subject.status !== 'active') throw new DomainError(409, 'subject_not_active');
    return structuredClone(subject);
  }
  createSession(ownerId, subjectId, maxSessions = 1000) {
    return this.#commit(state => {
      const subject = this.#subject(state, ownerId, subjectId);
      if (subject.status !== 'active') throw new DomainError(409, 'subject_not_active');
      if (Object.keys(state.sessions).length >= maxSessions) throw new DomainError(429, 'session_capacity');
      const session = { id: randomUUID(), ownerId, creatureId: subjectId, turns: [] };
      state.sessions[session.id] = session; return session;
    });
  }
  resumeSession(ownerId, subjectId, maxSessions = 1000) {
    this.getSubject(ownerId, subjectId); // Ownership/lifecycle checked even on reuse.
    const existing = Object.values(this.state.sessions).reverse()
      .find(s => s.ownerId === ownerId && s.creatureId === subjectId);
    return existing ? structuredClone(existing) : this.createSession(ownerId, subjectId, maxSessions);
  }
  getSession(ownerId, id) {
    const session = this.state.sessions[id];
    if (!session || session.ownerId !== ownerId) throw new DomainError(404, 'session_not_found');
    return structuredClone(session);
  }
  appendTurn(ownerId, id, expectedLength, user, assistant) {
    return this.#commit(state => {
      const session = state.sessions[id];
      if (!session || session.ownerId !== ownerId) throw new DomainError(404, 'session_not_found');
      const subject = this.#subject(state, ownerId, session.creatureId);
      if (subject.status !== 'active') throw new DomainError(409, 'subject_not_active');
      if (!subject.aibm.serviceAbilities.includes('conversation')) throw new DomainError(403, 'outside_service_boundary');
      if (session.turns.length !== expectedLength) throw new DomainError(409, 'session_changed');
      session.turns.push(user, assistant); return session;
    });
  }
  list(ownerId) {
    return structuredClone({ subjects: Object.values(this.state.subjects).filter(s => s.ownerId === ownerId), tasks: Object.values(this.state.tasks).filter(t => t.ownerId === ownerId), results: this.state.results.filter(r => r.ownerId === ownerId), revision: this.state.revision });
  }
  transition(ownerId, id, status) {
    if (!['active', 'paused', 'retired'].includes(status)) throw new DomainError(400, 'invalid_subject_status');
    return this.#commit(state => {
      const subject = this.#subject(state, ownerId, id);
      if (subject.status === 'retired') throw new DomainError(409, 'subject_retired');
      subject.status = status;
      if (status === 'retired') for (const task of Object.values(state.tasks)) if (task.subjectId === id && !['completed', 'cancelled'].includes(task.status)) task.status = 'cancelled';
      this.#event(state, `subject.${status}`, ownerId, id); return subject;
    });
  }
  mount(ownerId, id, serviceId, enabled = true) {
    if (!serviceCatalog.some(service => service.id === serviceId) || typeof enabled !== 'boolean') throw new DomainError(400, 'unsupported_local_service');
    return this.#commit(state => {
      const subject = this.#subject(state, ownerId, id);
      if (subject.status === 'retired') throw new DomainError(409, 'subject_retired');
      subject.aibm.serviceAbilities = subject.aibm.serviceAbilities.filter(s => s !== serviceId);
      if (enabled) {
        subject.aibm.serviceAbilities.push(serviceId);
        const renderer = serviceCatalog.find(service => service.id === serviceId).renderer;
        if (!subject.aibm.renderingAbilities.includes(renderer)) subject.aibm.renderingAbilities.push(renderer);
      }
      else for (const t of Object.values(state.tasks)) if (t.subjectId === id && t.serviceId === serviceId && !['completed','cancelled'].includes(t.status)) t.status = 'cancelled';
      this.#event(state, enabled ? 'service.mounted' : 'service.revoked', ownerId, id, { serviceId }); return subject;
    });
  }
  schedule(ownerId, { subjectId, serviceId, trigger, payload = {}, minimumIntervalMs = this.minIntervalMs } = {}) {
    payload = safeObject(payload);
    if (!trigger || !['timer', 'event'].includes(trigger.kind)) throw new DomainError(400, 'invalid_trigger');
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < this.minIntervalMs) throw new DomainError(400, 'invalid_minimum_interval');
    const normalized = trigger.kind === 'timer'
      ? { kind: 'timer', at: trigger.at, intervalMs: trigger.intervalMs ?? null }
      : { kind: 'event', type: requireText(trigger.type), repeat: trigger.repeat === true };
    if (normalized.kind === 'timer' && (!Number.isSafeInteger(normalized.at) || normalized.at < 0 || (normalized.intervalMs !== null && (!Number.isSafeInteger(normalized.intervalMs) || normalized.intervalMs < minimumIntervalMs)))) throw new DomainError(400, 'invalid_timer');
    return this.#commit(state => {
      const subject = this.#subject(state, ownerId, subjectId);
      if (subject.status !== 'active') throw new DomainError(409, 'subject_not_active');
      if (!Object.hasOwn(scheduledServices, serviceId) || !subject.aibm.serviceAbilities.includes(serviceId)) throw new DomainError(403, 'outside_service_boundary');
      if (Object.keys(state.tasks).length >= 1000) throw new DomainError(429, 'task_capacity');
      const task = { id: randomUUID(), ownerId, subjectId, serviceId, trigger: normalized, payload, minimumIntervalMs, status: 'scheduled', dueAt: normalized.kind === 'timer' ? normalized.at : null, lastRunAt: null, runs: 0 };
      state.tasks[task.id] = task; this.#event(state, 'task.scheduled', ownerId, subjectId, { taskId: task.id }); return task;
    });
  }
  signal(ownerId, { subjectId, type } = {}) {
    type = requireText(type);
    return this.#commit(state => {
      this.#subject(state, ownerId, subjectId);
      const now = this.clock(); let queued = 0;
      for (const task of Object.values(state.tasks)) {
        if (task.ownerId !== ownerId || task.subjectId !== subjectId || task.status !== 'scheduled' || task.trigger.kind !== 'event' || task.trigger.type !== type) continue;
        // Coalesce while already queued; enforce cooldown from successful run.
        if (task.dueAt === null) { task.dueAt = Math.max(now, (task.lastRunAt ?? -Infinity) + task.minimumIntervalMs); queued++; }
      }
      this.#event(state, 'simulation.signal', ownerId, subjectId, { type, queued }); return { queued, simulation: true };
    });
  }
  cancel(ownerId, taskId) {
    return this.#commit(state => {
      const task = state.tasks[taskId];
      if (!task || task.ownerId !== ownerId) throw new DomainError(404, 'task_not_found');
      if (task.status === 'completed') throw new DomainError(409, 'task_completed');
      task.status = 'cancelled'; this.#event(state, 'task.cancelled', ownerId, task.subjectId, { taskId }); return task;
    });
  }
  tick() {
    const now = this.clock();
    const eligible = Object.values(this.state.tasks).some(t => t.status === 'scheduled' && t.dueAt !== null && t.dueAt <= now && this.state.subjects[t.subjectId]?.status === 'active');
    if (!eligible) return [];
    return this.#commit(state => {
      const results = [];
      for (const task of Object.values(state.tasks)) {
        const subject = state.subjects[task.subjectId];
        if (task.status !== 'scheduled' || task.dueAt === null || task.dueAt > now || subject?.status !== 'active') continue;
        if (!subject.aibm.serviceAbilities.includes(task.serviceId)) { task.status = 'blocked'; continue; }
        this.#event(state, 'task.started', task.ownerId, subject.id, { taskId: task.id });
        // Pure local deterministic action. Receipt is the outcome, not a claim of
        // broadcast/IoT execution. Store outcome and task transition atomically.
        const result = { id: `${task.id}:${task.runs + 1}`, taskId: task.id, ownerId: task.ownerId, subjectId: subject.id, at: now, effect: 'local-only', payload: task.payload, notice: '本地回执；未执行外部广播、消息或设备控制。' };
        results.push(result); state.results.push(result);
        task.runs++; task.lastRunAt = now;
        if (task.trigger.kind === 'timer' && task.trigger.intervalMs !== null) task.dueAt = now + task.trigger.intervalMs; // skip missed occurrences, never catch-up burst
        else if (task.trigger.kind === 'event' && task.trigger.repeat) task.dueAt = null;
        else { task.status = 'completed'; task.dueAt = null; }
        this.#event(state, 'task.finished', task.ownerId, subject.id, { taskId: task.id, resultId: result.id });
      }
      if (state.results.length > 1000) state.results.splice(0, state.results.length - 1000);
      return results;
    });
  }
}
