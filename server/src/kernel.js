import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DomainError, creatures, serviceCatalog } from './model.js';

const requireText = (v, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new DomainError(400, 'invalid_text');
  return v.trim();
};
const safeObject = v => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || JSON.stringify(v).length > 4000) throw new DomainError(400, 'invalid_payload');
  return structuredClone(v);
};
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
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
  constructor(path, { clock = () => Date.now(), minIntervalMs = 60000, maxRequestsPerOwner = 100 } = {}) {
    if (!Number.isSafeInteger(maxRequestsPerOwner) || maxRequestsPerOwner < 1 || maxRequestsPerOwner > 1000) throw new Error('Invalid per-owner request quota');
    this.maxRequestsPerOwner = maxRequestsPerOwner;
    this.path = path; this.clock = clock; this.minIntervalMs = minIntervalMs;
    this.lock = `${path}.lock`; this.closed = false;
    mkdirSync(dirname(path), { recursive: true });
    try { mkdirSync(this.lock); } catch { throw new Error('Kernel store already locked; verify owner before recovery'); }
    try {
      this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, subjects: {}, tasks: {}, events: [], results: [], revision: 0 };
      this.state.sessions ??= {};
      this.state.connectors ??= {};
      this.state.perceptions ??= {};
      for (const perception of Object.values(this.state.perceptions)) {
        if (perception.status === 'processing') { perception.status = 'interrupted'; perception.error = 'process_restarted'; }
      }
      this.state.requests ??= {};
      // v0.12 receipts carried ownership in their result, before an explicit field.
      for (const request of Object.values(this.state.requests)) request.ownerId ??= request.result?.ownerId;
      for (const subject of Object.values(this.state.subjects || {})) {
        subject.authorizationVersion ??= 0;
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
  #once(ownerId, operation, requestId, input, change) {
    if (requestId === undefined) return this.#commit(change);
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new DomainError(400, 'invalid_request_id');
    const key = createHash('sha256').update(JSON.stringify([ownerId, requestId])).digest('hex');
    const fingerprint = createHash('sha256').update(canonical({ operation, input })).digest('hex');
    const previous = this.state.requests[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new DomainError(409, 'request_id_conflict');
      return { ...structuredClone(previous.result), requestId, replayed: true };
    }
    return this.#commit(state => {
      if (Object.values(state.requests).filter(r => r.ownerId === ownerId).length >= this.maxRequestsPerOwner) throw new DomainError(429, 'owner_request_capacity');
      if (Object.keys(state.requests).length >= 1000) throw new DomainError(429, 'request_capacity');
      const result = change(state);
      state.requests[key] = { ownerId, fingerprint, result: structuredClone(result) };
      return { ...result, requestId, replayed: false };
    });
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
  createSubject(ownerId, { name, personality = '', activitySpace = 'fixed-simulation', requestId } = {}) {
    name = requireText(name); personality = requireText(personality || '未指定', 1000);
    if (!['fixed-simulation', 'follow-owner-simulation'].includes(activitySpace)) throw new DomainError(400, 'invalid_activity_space');
    return this.#once(ownerId, 'subject.create', requestId, { name, personality, activitySpace }, state => {
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
  listSessions(ownerId, subjectId) {
    this.getSubject(ownerId, subjectId);
    return Object.values(this.state.sessions).filter(s => s.ownerId === ownerId && s.creatureId === subjectId)
      .reverse().map(s => ({ id: s.id, creatureId: s.creatureId, turnCount: s.turns.length / 2 }));
  }
  getSession(ownerId, id) {
    const session = this.state.sessions[id];
    if (!session || session.ownerId !== ownerId) throw new DomainError(404, 'session_not_found');
    return structuredClone(session);
  }
  appendTurn(ownerId, id, expectedLength, user, assistant, expectedAuthorizationVersion) {
    return this.#commit(state => {
      const session = state.sessions[id];
      if (!session || session.ownerId !== ownerId) throw new DomainError(404, 'session_not_found');
      const subject = this.#subject(state, ownerId, session.creatureId);
      if (subject.status !== 'active') throw new DomainError(409, 'subject_not_active');
      if (!subject.aibm.serviceAbilities.includes('conversation')) throw new DomainError(403, 'outside_service_boundary');
      if (expectedAuthorizationVersion !== undefined && (subject.authorizationVersion ?? 0) !== expectedAuthorizationVersion) throw new DomainError(409, 'authorization_changed');
      if (session.turns.length !== expectedLength) throw new DomainError(409, 'session_changed');
      session.turns.push(user, assistant); return session;
    });
  }
  beginPerception(ownerId, { creatureId, modality, mimeType, byteLength }) {
    const serviceId = modality === 'hearing' ? 'sense.hearing' : modality === 'vision' ? 'sense.vision' : null;
    if (!serviceId) throw new DomainError(400, 'invalid_modality');
    return this.#commit(state => {
      const subject = this.#subject(state, ownerId, creatureId);
      if (subject.status !== 'active') throw new DomainError(409, 'subject_not_active');
      if (!subject.aibm.serviceAbilities.includes(serviceId)) throw new DomainError(403, 'outside_sensory_boundary');
      if (Object.values(state.perceptions).filter(p => p.ownerId === ownerId).length >= 100 || Object.keys(state.perceptions).length >= 1000) throw new DomainError(429, 'perception_capacity');
      const perception = { id: randomUUID(), ownerId, creatureId, modality, source: 'user-supplied-media', mimeType,
        byteLength, createdAt: this.clock(), status: 'processing', authorizationVersion: subject.authorizationVersion ?? 0,
        retention: 'metadata-only-no-media-or-transcript' };
      state.perceptions[perception.id] = perception;
      this.#event(state, 'perception.started', ownerId, creatureId, { perceptionId: perception.id, modality });
      return perception;
    });
  }
  #ownedPerception(state, ownerId, id) {
    const perception = state.perceptions[id];
    if (!perception || perception.ownerId !== ownerId) throw new DomainError(404, 'perception_not_found');
    return perception;
  }
  #perceptionAuthority(state, ownerId, perception) {
    const subject = this.#subject(state, ownerId, perception.creatureId);
    if (subject.status !== 'active') throw new DomainError(409, 'subject_not_active');
    if (!subject.aibm.serviceAbilities.includes(`sense.${perception.modality}`)) throw new DomainError(403, 'outside_sensory_boundary');
    if ((subject.authorizationVersion ?? 0) !== perception.authorizationVersion) throw new DomainError(409, 'authorization_changed');
  }
  assertPerceptionAuthority(ownerId, id) {
    const perception = this.#ownedPerception(this.state, ownerId, id);
    if (perception.status !== 'processing') throw new DomainError(409, 'perception_not_processing');
    this.#perceptionAuthority(this.state, ownerId, perception);
  }
  assertCompletedPerceptionAuthority(ownerId, id) {
    const perception = this.#ownedPerception(this.state, ownerId, id);
    if (perception.status !== 'completed') throw new DomainError(409, 'perception_not_completed');
    this.#perceptionAuthority(this.state, ownerId, perception);
  }
  finishPerception(ownerId, id, metadata) {
    return this.#commit(state => {
      const perception = this.#ownedPerception(state, ownerId, id);
      if (perception.status !== 'processing') throw new DomainError(409, 'perception_not_processing');
      this.#perceptionAuthority(state, ownerId, perception);
      perception.status = 'completed'; perception.completedAt = this.clock(); perception.result = metadata;
      this.#event(state, 'perception.completed', ownerId, perception.creatureId, { perceptionId: id, modality: perception.modality, engine: metadata.engine, textLength: metadata.textLength });
      return perception;
    });
  }
  failPerception(ownerId, id, code) {
    return this.#commit(state => {
      const p = this.#ownedPerception(state, ownerId, id);
      if (p.status === 'processing') { p.status = 'failed'; p.error = code; p.completedAt = this.clock(); }
      return p;
    });
  }
  listPerceptions(ownerId) {
    return structuredClone(Object.values(this.state.perceptions).filter(p => p.ownerId === ownerId));
  }
  // Internal dedicated-adapter retention operation, not exposed over HTTP.
  // Removes metadata only; missing records are idempotent, active work is protected.
  retirePerceptionMetadata(ownerId, ids) {
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string')) throw new DomainError(400, 'invalid_perception_retirement');
    return this.#commit(state => {
      for (const id of ids) {
        const p=state.perceptions[id];
        if(p && (p.ownerId!==ownerId || p.status==='processing')) throw new DomainError(409,'perception_retirement_denied');
      }
      for(const id of ids) delete state.perceptions[id];
      return {retired:ids.length};
    });
  }
  acceptRequestedText(ownerId, perceptionId, creatureId, textLength) {
    return this.#commit(state => {
      const p = this.#ownedPerception(state, ownerId, perceptionId);
      if (p.creatureId !== creatureId || p.status !== 'completed' || p.modality !== 'hearing' || !p.result?.allowsTextInput) throw new DomainError(403, 'text_input_not_requested');
      this.#perceptionAuthority(state, ownerId, p);
      this.#event(state, 'interaction.text', ownerId, creatureId, { perceptionId, textLength });
      return { perceptionId, creatureId };
    });
  }
  #queueSignal(state, ownerId, subjectId, type, now) {
    let queued = 0;
    for (const task of Object.values(state.tasks)) {
      if (task.ownerId !== ownerId || task.subjectId !== subjectId || task.status !== 'scheduled' || task.trigger.kind !== 'event' || task.trigger.type !== type) continue;
      if (task.dueAt === null) { task.dueAt = Math.max(now, (task.lastRunAt ?? -Infinity) + task.minimumIntervalMs); queued++; }
    }
    return queued;
  }
  #connectorLost(state, connector, now, cause) {
    if (connector.status !== 'connected' || connector.lossEmitted) return;
    connector.lossEmitted = true;
    connector.lossObservedAt = now;
    const queued = this.#queueSignal(state, connector.ownerId, connector.subjectId, 'connector.lost', now);
    this.#event(state, 'simulation.connector.lost', connector.ownerId, connector.subjectId,
      { cause, observedAt: now, queued, simulation: true });
  }
  #connectorExpired(connector, now) {
    return connector.status === 'connected' && !connector.lossEmitted
      && (!Number.isSafeInteger(connector.expiresAt) || connector.expiresAt <= now);
  }
  #observeConnectorExpiry(ownerId) {
    const now = this.clock();
    const expired = Object.values(this.state.connectors).some(c => c.ownerId === ownerId && this.#connectorExpired(c, now));
    if (!expired) return now;
    // Persist observed expiry; wall-clock rollback cannot resurrect this lease.
    // This bookkeeping may queue only already-authorized local fallback tasks.
    this.#commit(state => {
      for (const connector of Object.values(state.connectors)) {
        if (connector.ownerId === ownerId && this.#connectorExpired(connector, now)) this.#connectorLost(state, connector, now, 'lease_expired');
      }
      return null;
    });
    return now;
  }
  reportConnector(ownerId, { subjectId, kind = 'device-simulation', status, leaseMs = 30000 } = {}) {
    if (kind !== 'device-simulation' || !['connected', 'disconnected'].includes(status)) throw new DomainError(400, 'invalid_simulated_connector');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new DomainError(400, 'invalid_connector_lease');
    return this.#commit(state => {
      const subject = this.#subject(state, ownerId, subjectId);
      if (subject.status !== 'active') throw new DomainError(409, 'subject_not_active');
      const now = this.clock();
      const previous = state.connectors[subjectId];
      if (previous && this.#connectorExpired(previous, now)) this.#connectorLost(state, previous, now, 'lease_expired');
      if (previous && status === 'disconnected') this.#connectorLost(state, previous, now, 'explicit_disconnect');
      const connector = { subjectId, ownerId, kind, status, simulation: true, observedAt: now,
        expiresAt: status === 'connected' ? now + leaseMs : null, lossEmitted: status === 'disconnected',
        lossObservedAt: status === 'disconnected' ? previous?.lossObservedAt ?? null : null };
      state.connectors[subjectId] = connector;
      this.#event(state, 'simulation.connector.reported', ownerId, subjectId, { status, expiresAt: connector.expiresAt });
      return connector;
    });
  }
  connectorStatus(ownerId, subjectId, kind) {
    this.getSubject(ownerId, subjectId);
    const now = this.#observeConnectorExpiry(ownerId);
    const connector = this.state.connectors[subjectId];
    if (!connector || connector.ownerId !== ownerId || connector.kind !== kind || connector.status !== 'connected') {
      return { available: false, simulation: true, reason: 'connector_unavailable' };
    }
    if (connector.lossEmitted || !Number.isSafeInteger(connector.expiresAt) || connector.expiresAt <= now) return { available: false, simulation: true, reason: 'connector_expired', expiresAt: connector.expiresAt };
    return { available: true, simulation: true, expiresAt: connector.expiresAt };
  }
  list(ownerId) {
    const now = this.#observeConnectorExpiry(ownerId);
    return structuredClone({ requestQuota: { used: Object.values(this.state.requests).filter(r => r.ownerId === ownerId).length, limit: this.maxRequestsPerOwner }, subjects: Object.values(this.state.subjects).filter(s => s.ownerId === ownerId), tasks: Object.values(this.state.tasks).filter(t => t.ownerId === ownerId), connectors: Object.values(this.state.connectors).filter(c => c.ownerId === ownerId).map(c => ({ ...c, effectiveStatus: this.state.subjects[c.subjectId]?.status !== 'active' ? 'subject_inactive' : c.status !== 'connected' ? 'disconnected' : (c.lossEmitted || !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= now) ? 'expired' : 'connected' })), results: this.state.results.filter(r => r.ownerId === ownerId), revision: this.state.revision });
  }
  transition(ownerId, id, status) {
    if (!['active', 'paused', 'retired'].includes(status)) throw new DomainError(400, 'invalid_subject_status');
    return this.#commit(state => {
      const subject = this.#subject(state, ownerId, id);
      if (subject.status === 'retired') throw new DomainError(409, 'subject_retired');
      subject.authorizationVersion = (subject.authorizationVersion ?? 0) + 1;
      subject.status = status;
      if (status === 'retired') for (const task of Object.values(state.tasks)) if (task.subjectId === id && !['completed', 'cancelled'].includes(task.status)) task.status = 'cancelled';
      this.#event(state, `subject.${status}`, ownerId, id); return subject;
    });
  }
  // Internal bridge-only synchronization: marker and capability share one commit.
  // Independent mount(false) is a second authority boundary and cannot be
  // overridden by replaying registry state, including after a failed write.
  syncRegistrySense(ownerId, id, { modality, generation, enabled, initializeOnly = false }) {
    if (!['hearing', 'vision'].includes(modality) || !Number.isSafeInteger(generation) || generation < 0 || typeof enabled !== 'boolean' || typeof initializeOnly !== 'boolean') throw new DomainError(400, 'invalid_sensory_sync');
    const serviceId = 'sense.' + modality;
    const existing = this.getSubject(ownerId, id);
    if (existing.status === 'retired') throw new DomainError(409, 'subject_retired');
    const seen = existing.registrySenseGenerations?.[modality];
    if (seen !== undefined && generation <= seen) return existing;
    return this.#commit(state => {
      const subject = this.#subject(state, ownerId, id);
      if (subject.status === 'retired') throw new DomainError(409, 'subject_retired');
      subject.registrySenseGenerations ??= {};
      subject.independentSenseRevocations ??= {};
      const previous = subject.registrySenseGenerations[modality];
      if (previous !== undefined && generation <= previous) return subject;
      const wasEnabled = subject.aibm.serviceAbilities.includes(serviceId);
      // First encounter of an existing subject is migration, not a fresh grant.
      if (previous === undefined && initializeOnly) {
        if (!wasEnabled) subject.independentSenseRevocations[modality] = true;
        subject.registrySenseGenerations[modality] = generation;
        return subject;
      }
      subject.registrySenseGenerations[modality] = generation;
      const permitted = enabled && subject.independentSenseRevocations[modality] !== true;
      if (permitted !== wasEnabled) {
        subject.authorizationVersion = (subject.authorizationVersion ?? 0) + 1;
        subject.aibm.serviceAbilities = subject.aibm.serviceAbilities.filter(s => s !== serviceId);
        if (permitted) {
          subject.aibm.serviceAbilities.push(serviceId);
          const renderer = serviceCatalog.find(s => s.id === serviceId).renderer;
          if (!subject.aibm.renderingAbilities.includes(renderer)) subject.aibm.renderingAbilities.push(renderer);
        } else for (const task of Object.values(state.tasks)) if (task.subjectId === id && task.serviceId === serviceId && !['completed','cancelled'].includes(task.status)) task.status = 'cancelled';
        this.#event(state, permitted ? 'service.mounted' : 'service.revoked', ownerId, id, { serviceId });
      }
      return subject;
    });
  }
  mount(ownerId, id, serviceId, enabled = true) {
    if (!serviceCatalog.some(service => service.id === serviceId) || typeof enabled !== 'boolean') throw new DomainError(400, 'unsupported_local_service');
    return this.#commit(state => {
      const subject = this.#subject(state, ownerId, id);
      if (subject.status === 'retired') throw new DomainError(409, 'subject_retired');
      if (['sense.hearing', 'sense.vision'].includes(serviceId)) { subject.independentSenseRevocations ??= {}; subject.independentSenseRevocations[serviceId.slice(6)] = !enabled; }
      subject.authorizationVersion = (subject.authorizationVersion ?? 0) + 1;
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
  schedule(ownerId, { subjectId, serviceId, trigger, payload = {}, minimumIntervalMs = this.minIntervalMs, requestId } = {}) {
    payload = safeObject(payload);
    if (!trigger || !['timer', 'event'].includes(trigger.kind)) throw new DomainError(400, 'invalid_trigger');
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < this.minIntervalMs) throw new DomainError(400, 'invalid_minimum_interval');
    const normalized = trigger.kind === 'timer'
      ? { kind: 'timer', ...(trigger.delayMs !== undefined ? { delayMs: trigger.delayMs } : { at: trigger.at }), intervalMs: trigger.intervalMs ?? null }
      : { kind: 'event', type: requireText(trigger.type), repeat: trigger.repeat === true };
    if (normalized.kind === 'timer') {
      if (trigger.at !== undefined && trigger.delayMs !== undefined) throw new DomainError(400, 'ambiguous_timer');
      const validTime = normalized.delayMs !== undefined
        ? Number.isSafeInteger(normalized.delayMs) && normalized.delayMs >= 1000 && normalized.delayMs <= 86400000
        : Number.isSafeInteger(normalized.at) && normalized.at >= 0;
      if (!validTime || (normalized.intervalMs !== null && (!Number.isSafeInteger(normalized.intervalMs) || normalized.intervalMs < minimumIntervalMs))) throw new DomainError(400, 'invalid_timer');
    }
    return this.#once(ownerId, 'task.schedule', requestId, { subjectId, serviceId, trigger: normalized, payload, minimumIntervalMs }, state => {
      const subject = this.#subject(state, ownerId, subjectId);
      if (subject.status !== 'active') throw new DomainError(409, 'subject_not_active');
      if (!Object.hasOwn(scheduledServices, serviceId) || !subject.aibm.serviceAbilities.includes(serviceId)) throw new DomainError(403, 'outside_service_boundary');
      if (Object.keys(state.tasks).length >= 1000) throw new DomainError(429, 'task_capacity');
      const effectiveTrigger = normalized.kind === 'timer' && normalized.delayMs !== undefined
        ? { kind: 'timer', at: this.clock() + normalized.delayMs, intervalMs: normalized.intervalMs } : normalized;
      if (effectiveTrigger.kind === 'timer' && (!Number.isSafeInteger(effectiveTrigger.at) || effectiveTrigger.at < 0)) throw new DomainError(400, 'invalid_timer');
      const task = { id: randomUUID(), ownerId, subjectId, serviceId, trigger: effectiveTrigger, payload, minimumIntervalMs, status: 'scheduled', dueAt: effectiveTrigger.kind === 'timer' ? effectiveTrigger.at : null, lastRunAt: null, runs: 0 };
      state.tasks[task.id] = task; this.#event(state, 'task.scheduled', ownerId, subjectId, { taskId: task.id }); return task;
    });
  }
  signal(ownerId, { subjectId, type } = {}) {
    type = requireText(type);
    return this.#commit(state => {
      this.#subject(state, ownerId, subjectId);
      const queued = this.#queueSignal(state, ownerId, subjectId, type, this.clock());
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
    const lost = Object.values(this.state.connectors).some(c => this.#connectorExpired(c, now));
    if (!eligible && !lost) return [];
    return this.#commit(state => {
      for (const connector of Object.values(state.connectors)) {
        if (this.#connectorExpired(connector, now)) this.#connectorLost(state, connector, now, 'lease_expired');
      }
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
