import { DomainError, serviceCatalog as catalog } from './model.js';

const menu = [{ id: 'noodles', name: '演示面条', priceMinor: 1200 }, { id: 'tea', name: '演示茶饮', priceMinor: 300 }];
// A demo intent interpreter, deliberately separate from registry matching.
const interpret = prompt => {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new DomainError(400, 'invalid_prompt');
  if (/^(你能做什么|你会什么|what can you do)$/i.test(prompt.trim())) return 'capabilities.describe';
  if (/^(菜单|看看菜单|查看菜单|menu|show menu)$/i.test(prompt.trim())) return 'menu.read';
  return null;
};
const unavailableReason = (creature, service, context) => {
  if (!creature.aibm.activitySpace.zones.includes(context?.zone)) return 'outside_simulated_activity_space';
  if (!Array.isArray(context?.renderers) || !context.renderers.includes(service.renderer) || !creature.aibm.renderingAbilities.includes(service.renderer)) return 'renderer_unavailable';
  return null;
};
// A controlled first scheduling layer. The demo intent resolver is deliberately
// deterministic, NOT an LLM intent planner. Client context is only a simulation;
// it must never become trusted geolocation or authorization evidence.
export class ServiceScheduler {
  constructor(runtime, { openports = null } = {}) { this.runtime = runtime; this.openports = openports; }
  discover(ownerId, creatureId) {
    const c = this.runtime.getCreature(ownerId, creatureId);
    return catalog.filter(s => c.aibm.serviceAbilities.includes(s.id)).map(s => structuredClone(s));
  }
  #connectorReason(ownerId, creatureId, service) {
    if (service.id === 'ecm.hello.read' && !this.openports) return 'business_bridge_unavailable';
    if (!service.requiresConnector) return null;
    const availability = this.runtime.connectorStatus(ownerId, creatureId, service.requiresConnector);
    return availability.available ? null : availability.reason;
  }
  discoverAcross(ownerId, request = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new DomainError(400, 'invalid_discovery_request');
    const { prompt, serviceId: requestedService, context } = request;
    if ((prompt === undefined) === (requestedService === undefined)) throw new DomainError(400, 'choose_one_intent_selector');
    if (!context || typeof context !== 'object' || Array.isArray(context) || typeof context.zone !== 'string' || !context.zone.trim() || context.zone.length > 200 || !Array.isArray(context.renderers) || context.renderers.length > 20 || context.renderers.some(r => typeof r !== 'string' || !r || r.length > 100)) throw new DomainError(400, 'invalid_discovery_context');
    if (prompt === undefined && (typeof requestedService !== 'string' || !requestedService || requestedService.length > 100)) throw new DomainError(400, 'invalid_service_id');
    const planner = prompt === undefined ? 'explicit-service' : 'demo-rules';
    const serviceId = prompt === undefined ? requestedService : interpret(prompt);
    const base = { planner, executed: false, simulation: true, candidates: [], unavailable: [] };
    if (serviceId === null) return { ...base, status: 'needs_clarification' };
    const service = catalog.find(s => s.id === serviceId);
    if (!service) throw new DomainError(404, 'service_not_found');
    for (const creature of this.runtime.listCreatures(ownerId)) {
      if (!creature.aibm.serviceAbilities.includes(serviceId)) continue;
      const reason = unavailableReason(creature, service, context) || this.#connectorReason(ownerId, creature.id, service);
      const candidate = { creatureId: creature.id, name: creature.name, service: structuredClone(service) };
      if (reason) base.unavailable.push({ ...candidate, reason });
      else base.candidates.push(candidate);
    }
    // No implicit ranking, selection, service execution or model request.
    return { ...base, serviceId, status: base.candidates.length === 1 ? 'proposed' : base.candidates.length > 1 ? 'needs_choice' : 'unavailable' };
  }
  async invoke(ownerId, { creatureId, serviceId, arguments: args = {}, context = {} } = {}) {
    const c = this.runtime.getCreature(ownerId, creatureId);
    const service = catalog.find(s => s.id === serviceId);
    if (!service) throw new DomainError(404, 'service_not_found');
    if (!c.aibm.serviceAbilities.includes(serviceId)) throw new DomainError(403, 'outside_service_boundary');
    const reason = unavailableReason(c, service, context) || this.#connectorReason(ownerId, c.id, service);
    if (reason) throw new DomainError(reason === 'outside_simulated_activity_space' ? 403 : 409, reason);
    if (serviceId.startsWith('sense.')) throw new DomainError(400, 'use_perception_endpoint');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new DomainError(400, 'invalid_arguments');
    let data;
    if (serviceId === 'ecm.hello.read') {
      if (Object.keys(args).length) throw new DomainError(400, 'unsupported_bridge_arguments');
      data = await this.openports.readHello();
      const current = this.runtime.getCreature(ownerId, creatureId);
      if (!current.aibm.serviceAbilities.includes(serviceId) || (current.authorizationVersion ?? 0) !== (c.authorizationVersion ?? 0)) throw new DomainError(409, 'authorization_changed');
      const currentReason = unavailableReason(current, service, context);
      if (currentReason) throw new DomainError(409, currentReason);
    } else if (serviceId === 'device.preview') {
      data = { notice: '模拟连接前提已满足，仅完成本地预检；未控制真实设备。', simulation: true, deviceActionExecuted: false, subjectId: c.id };
    } else if (serviceId === 'local.report') {
      data = { notice: '本地即时回执；未执行外部动作。', subjectId: c.id };
    } else if (serviceId === 'capabilities.describe') {
      data = { name: c.name, services: this.discover(ownerId, c.id), boundary: structuredClone(c.aibm) };
    } else if (serviceId === 'conversation') {
      const session = this.runtime.getSession(ownerId, args.sessionId);
      if (session.creatureId !== creatureId) throw new DomainError(403, 'session_creature_mismatch');
      data = await this.runtime.call(ownerId, args.sessionId, args.message);
    } else if (serviceId === 'menu.read') {
      data = { title: '演示菜单', currency: 'USD', items: structuredClone(menu) };
    } else if (serviceId === 'order.preview') {
      const item = menu.find(i => i.id === args.itemId);
      if (!item || !Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 20) throw new DomainError(400, 'invalid_order_preview');
      data = { item: structuredClone(item), quantity: args.quantity, totalMinor: item.priceMinor * args.quantity, currency: 'USD', submitted: false, notice: '仅演示预览，未下单、未付款。' };
    }
    return { creatureId, serviceId, status: 'completed', renderer: service.renderer, effect: service.effect, demo: serviceId === 'conversation' ? this.runtime.provider.mode === 'demo' : !['capabilities.describe', 'local.report', 'ecm.hello.read'].includes(serviceId), data };
  }
  resolve(ownerId, creatureId, prompt) {
    this.runtime.getCreature(ownerId, creatureId);
    // Never execute an ambiguous request. A plan is not execution authority.
    const serviceId = interpret(prompt);
    const services = this.discover(ownerId, creatureId);
    if (!serviceId || !services.some(s => s.id === serviceId)) return { status: 'needs_clarification', planner: 'demo-rules', services };
    return { status: 'proposed', planner: 'demo-rules', creatureId, serviceId, arguments: {}, executed: false };
  }
}
