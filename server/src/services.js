import { creatures, DomainError } from './runtime.js';

const catalog = [
  { id: 'capabilities.describe', title: '说明自身能力', effect: 'read-only', renderer: 'capability-card', inputs: [], requiresConfirmation: false },
  { id: 'conversation', title: '交流', effect: 'model-request', renderer: 'text', inputs: ['message'], requiresConfirmation: false },
  { id: 'menu.read', title: '查看演示菜单', effect: 'read-only', renderer: 'menu-card', inputs: [], requiresConfirmation: false },
  { id: 'order.preview', title: '生成点餐预览', effect: 'local-preview', renderer: 'order-card', inputs: ['itemId', 'quantity'], requiresConfirmation: false },
];
const menu = [{ id: 'noodles', name: '演示面条', priceMinor: 1200 }, { id: 'tea', name: '演示茶饮', priceMinor: 300 }];
const byId = id => {
  const c = creatures.find(c => c.id === id);
  if (!c) throw new DomainError(404, 'creature_not_found');
  return c;
};

// A controlled first scheduling layer. The demo intent resolver is deliberately
// deterministic, NOT an LLM intent planner. Client context is only a simulation;
// it must never become trusted geolocation or authorization evidence.
export class ServiceScheduler {
  constructor(runtime) { this.runtime = runtime; }
  discover(creatureId) {
    const c = byId(creatureId);
    return catalog.filter(s => c.aibm.serviceAbilities.includes(s.id)).map(s => structuredClone(s));
  }
  async invoke(ownerId, { creatureId, serviceId, arguments: args = {}, context = {} } = {}) {
    const c = byId(creatureId);
    const service = catalog.find(s => s.id === serviceId);
    if (!service) throw new DomainError(404, 'service_not_found');
    if (!c.aibm.serviceAbilities.includes(serviceId)) throw new DomainError(403, 'outside_service_boundary');
    if (!c.aibm.activitySpace.zones.includes(context?.zone)) throw new DomainError(403, 'outside_simulated_activity_space');
    if (!Array.isArray(context?.renderers) || !context.renderers.includes(service.renderer) || !c.aibm.renderingAbilities.includes(service.renderer)) throw new DomainError(409, 'renderer_unavailable');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new DomainError(400, 'invalid_arguments');
    let data;
    if (serviceId === 'capabilities.describe') {
      data = { name: c.name, services: this.discover(c.id), boundary: structuredClone(c.aibm) };
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
    return { creatureId, serviceId, status: 'completed', renderer: service.renderer, effect: service.effect, demo: serviceId === 'conversation' ? this.runtime.provider.mode === 'demo' : serviceId !== 'capabilities.describe', data };
  }
  resolve(creatureId, prompt) {
    byId(creatureId);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new DomainError(400, 'invalid_prompt');
    // Never execute an ambiguous request. A plan is not execution authority.
    let serviceId;
    if (/^(你能做什么|你会什么|what can you do)$/i.test(prompt.trim())) serviceId = 'capabilities.describe';
    if (/^(菜单|看看菜单|查看菜单|menu|show menu)$/i.test(prompt.trim())) serviceId = 'menu.read';
    const services = this.discover(creatureId);
    if (!serviceId || !services.some(s => s.id === serviceId)) return { status: 'needs_clarification', planner: 'demo-rules', services };
    return { status: 'proposed', planner: 'demo-rules', creatureId, serviceId, arguments: {}, executed: false };
  }
}
