import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/runtime.js';
import { DemoProvider } from '../src/providers.js';
import { ServiceScheduler } from '../src/services.js';
const scheduler = () => new ServiceScheduler(new Runtime(new DemoProvider()));
const context = { zone: 'demo-restaurant', renderers: ['menu-card', 'order-card', 'capability-card'] };

test('same call discovers and dispatches actual distinct creature capabilities', async () => {
  const s = scheduler();
  const results = [];
  for (const creatureId of ['companion', 'restaurant']) {
    const plan = s.resolve('owner', creatureId, '你能做什么');
    assert.equal(plan.executed, false);
    const result = await s.invoke('owner', { ...plan, context: { zone: creatureId === 'companion' ? 'demo-world' : 'demo-restaurant', renderers: ['capability-card'] } });
    assert.equal(result.demo, false); // real registry inspection, not LLM or canned prose
    results.push(result);
  }
  assert.deepEqual(results[0].data.services.map(s => s.id), ['capabilities.describe', 'conversation']);
  assert.deepEqual(results[1].data.services.map(s => s.id), ['capabilities.describe', 'menu.read', 'order.preview']);
});
test('service, simulated spatial and rendering boundaries are enforced', async () => {
  const s = scheduler();
  await assert.rejects(s.invoke('owner', { creatureId: 'companion', serviceId: 'menu.read', context }), { code: 'outside_service_boundary' });
  await assert.rejects(s.invoke('owner', { creatureId: 'restaurant', serviceId: 'menu.read', context: { ...context, zone: 'elsewhere' } }), { code: 'outside_simulated_activity_space' });
  await assert.rejects(s.invoke('owner', { creatureId: 'restaurant', serviceId: 'menu.read', context: { ...context, renderers: ['text'] } }), { code: 'renderer_unavailable' });
  await assert.rejects(s.invoke('owner', { creatureId: 'restaurant', serviceId: 'order.submit', context }), { code: 'service_not_found' });
});
test('menu and preview use explicit fixtures, calculate totals and never submit', async () => {
  const s = scheduler();
  const menu = await s.invoke('owner', { creatureId: 'restaurant', serviceId: 'menu.read', context });
  assert.equal(menu.demo, true);
  const order = await s.invoke('owner', { creatureId: 'restaurant', serviceId: 'order.preview', arguments: { itemId: 'noodles', quantity: 2 }, context });
  assert.equal(order.data.totalMinor, 2400);
  assert.equal(order.data.submitted, false);
  await assert.rejects(s.invoke('owner', { creatureId: 'restaurant', serviceId: 'order.preview', arguments: { itemId: 'noodles', quantity: -1 }, context }), { code: 'invalid_order_preview' });
});
test('ambiguous or out-of-bound prompts require clarification; no action occurs', () => {
  const s = scheduler();
  assert.equal(s.resolve('owner', 'restaurant', '帮我处理一下').status, 'needs_clarification');
  assert.equal(s.resolve('owner', 'companion', '菜单').status, 'needs_clarification');
  assert.equal(s.resolve('owner', 'restaurant', '菜单').serviceId, 'menu.read');
});
