import { randomUUID } from 'node:crypto';
import { snapshot, digest } from '../../microkernel/src/canonical.js';
import { deny, fields, id } from '../../microkernel/src/grants.js';

const PRODUCT = 'demo.maps.v1';
const catalog = snapshot('market-catalog', [{ productId: PRODUCT, providerId: 'demo-maps',
  name: '演示地图伙伴', serviceId: 'synthetic.route.v1', serviceVersion: 1,
  mode: 'synthetic-only', nodes: ['A', 'B', 'C'], network: false, paid: false }]).value;
const spec = (raw, keys) => { const v = snapshot('market-request', raw).value; fields(v, keys); return v; };
const checkProduct = value => { if (value !== PRODUCT) deny('unknown_market_product'); };
const key = (type, owner, extra = '') => 'market.' + type + '.' + digest('market-key', [owner, extra]).slice(7);
const sealed = (type, value) => snapshot(type, value).value;
function expectedResult(input) {
  const nodes = ['A', 'B', 'C'], from = nodes.indexOf(input.from), to = nodes.indexOf(input.to);
  const step = from <= to ? 1 : -1, path = [];
  for (let i = from; ; i += step) { path.push(nodes[i]); if (i === to) break; }
  return { path, hops: path.length - 1 };
}
// Trusted in-process synthetic executor only. No network, arbitrary URLs or tools.
export async function syntheticRoute(input) {
  if (!input || !['A', 'B', 'C'].includes(input.from) || !['A', 'B', 'C'].includes(input.to)) deny('synthetic_route_scope');
  return expectedResult(input);
}

export class CreatureMarket {
  #store; #auth; #registry; #executor; #timeout;
  constructor(store, identities, registry, { executor = syntheticRoute, timeoutMs = 1000 } = {}) {
    if (!registry.belongsTo(store, identities)) deny('market_domain_mismatch');
    if (typeof executor !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) deny('invalid_market_executor');
    this.#store = store; this.#auth = identities; this.#registry = registry; this.#executor = executor; this.#timeout = timeoutMs;
  }
  #sub(reader, owner) { return reader.get(key('subscription', owner, PRODUCT)); }
  #view(record) { return record ? sealed('market-subscription-view', { ...record.value, revision: record.revision }) : null; }
  state(handle) {
    const owner = this.#auth.resolve(handle), sub = this.#sub(this.#store, owner);
    const requests = this.#store.get(key('requests', owner))?.value.ids ?? [];
    const receipts = requests.map(requestId => this.#store.get(key('request', owner, requestId))?.value)
      .filter(r => r?.status === 'completed').slice(-16).map(r => r.receipt);
    return sealed('market-view', { catalog, subscriptions: sub ? [this.#view(sub)] : [], receipts,
      requests: requests.map(requestId => ({ requestId, status: this.#store.get(key('request', owner, requestId)).value.status })),
      requestCount: requests.length, requestLimit: 128, receiptWindow: 16 });
  }
  requestStatus(handle, raw) {
    const owner = this.#auth.resolve(handle), input = spec(raw, ['requestId']); id(input.requestId);
    const record = this.#store.get(key('request', owner, input.requestId));
    return sealed('market-request-status', { requestId: input.requestId,
      status: record?.value.status ?? 'not_started', receipt: record?.value.receipt ?? null });
  }
  subscribe(handle, raw) {
    const owner = this.#auth.resolve(handle), s = spec(raw, ['productId']); checkProduct(s.productId);
    return this.#store.transaction(tx => {
      const old = this.#sub(tx, owner);
      if (old?.value.status === 'active') return this.#view(old);
      if (old?.value.generation === Number.MAX_SAFE_INTEGER) deny('generation_exhausted');
      const instanceId = old?.value.instanceId ?? 'maps-' + randomUUID();
      if (!old) this.#registry.createInTransaction(tx, handle, {
        id: instanceId, name: '演示地图伙伴', kind: 'business', personality: '只解释合成节点路线，不提供真实导航', body: 'owl', tone: 'precise',
      }, { preservePrimary: true });
      const record = tx.put(key('subscription', owner, PRODUCT), 'market-subscription', {
        ownerId: owner, productId: PRODUCT, providerId: 'demo-maps', serviceId: 'synthetic.route.v1', serviceVersion: 1,
        instanceId, status: 'active', routeGranted: false, generation: (old?.value.generation ?? -1) + 1,
      }, old?.revision ?? 0);
      return this.#view(record);
    });
  }
  #change(handle, raw, granting) {
    const owner = this.#auth.resolve(handle), s = spec(raw, granting ? ['productId', 'enabled', 'expectedRevision'] : ['productId', 'expectedRevision']);
    checkProduct(s.productId);
    if (!Number.isSafeInteger(s.expectedRevision) || s.expectedRevision < 1) deny('invalid_revision');
    if (granting && typeof s.enabled !== 'boolean') deny('invalid_route_grant');
    return this.#store.transaction(tx => {
      const r = this.#sub(tx, owner); if (!r) deny('subscription_not_found');
      if (r.revision !== s.expectedRevision) deny('revision_conflict');
      if (granting && r.value.status !== 'active') deny('subscription_inactive');
      const status = granting ? 'active' : 'unsubscribed', routeGranted = granting ? s.enabled : false;
      if (r.value.status === status && r.value.routeGranted === routeGranted) return this.#view(r);
      if (r.value.generation === Number.MAX_SAFE_INTEGER) deny('generation_exhausted');
      return this.#view(tx.put(key('subscription', owner, PRODUCT), 'market-subscription', {
        ...r.value, status, routeGranted, generation: r.value.generation + 1,
      }, r.revision));
    });
  }
  grantRoute(handle, raw) { return this.#change(handle, raw, true); }
  unsubscribe(handle, raw) { return this.#change(handle, raw, false); }
  // Local pure synthetic computation only: cancellation records intent, not CPU
  // termination and not cancellation of any real external/uncertain side effect.
  cancelRequest(handle, raw) {
    const owner = this.#auth.resolve(handle), input = spec(raw, ['requestId']); id(input.requestId);
    return this.#store.transaction(tx => {
      const requestKey = key('request', owner, input.requestId), prior = tx.get(requestKey);
      if (prior && ['completed', 'cancelled'].includes(prior.value.status)) {
        return { requestId: input.requestId, status: prior.value.status };
      }
      if (prior) {
        tx.put(requestKey, 'market-request', { ...prior.value, status: 'cancelled' }, prior.revision);
      } else {
        const indexKey = key('requests', owner), index = tx.get(indexKey), ids = index?.value.ids ?? [];
        if (ids.length >= 128) deny('route_request_capacity');
        tx.put(requestKey, 'market-request', {
          ownerId: owner, input: null, inputDigest: null, subscriptionRevision: null,
          generation: null, status: 'cancelled', receipt: null,
        }, 0);
        tx.put(indexKey, 'market-request-index', { ids: [...ids, input.requestId] }, index?.revision ?? 0);
      }
      return { requestId: input.requestId, status: 'cancelled' };
    });
  }
  #authorized(reader, owner, input) {
    const sub = this.#sub(reader, owner);
    if (!sub || sub.value.status !== 'active' || !sub.value.routeGranted) deny('route_not_authorized');
    if (sub.value.instanceId !== input.instanceId) deny('provider_instance_mismatch');
    return sub;
  }
  #response(record, replayed) {
    // Only private validated/completed receipt records may produce render data.
    if (record.status !== 'completed') deny(record.status === 'cancelled' ? 'route_cancelled' : record.status === 'failed' ? 'route_failed' : 'route_pending');
    const receipt = record.receipt;
    return sealed('market-route-response', { replayed, receipt, render: {
      schema: 'synthetic-route.v1', receiptId: receipt.receiptId, providerId: receipt.providerId,
      productId: receipt.productId, instanceId: receipt.instanceId, nodes: receipt.result.path,
      hops: receipt.result.hops, source: receipt.source, disclaimer: '合成 A/B/C 节点，不是真实导航',
    } });
  }
  async route(handle, raw) {
    const owner = this.#auth.resolve(handle), input = spec(raw, ['productId', 'instanceId', 'from', 'to', 'requestId']);
    checkProduct(input.productId); id(input.instanceId); id(input.requestId);
    if (!['A', 'B', 'C'].includes(input.from) || !['A', 'B', 'C'].includes(input.to)) deny('synthetic_route_scope');
    const inputDigest = digest('route-input', input), requestKey = key('request', owner, input.requestId);
    const started = this.#store.transaction(tx => {
      const prior = tx.get(requestKey);
      if (prior) {
        if (prior.value.status === 'cancelled') deny('route_cancelled');
        if (prior.value.inputDigest !== inputDigest) deny('route_request_conflict');
        return { prior: prior.value }; // Historical receipt, never new execution.
      }
      const sub = this.#authorized(tx, owner, input), indexKey = key('requests', owner), index = tx.get(indexKey);
      const ids = index?.value.ids ?? []; if (ids.length >= 128) deny('route_request_capacity');
      const record = { ownerId: owner, input, inputDigest, subscriptionRevision: sub.revision, generation: sub.value.generation, status: 'pending', receipt: null };
      tx.put(requestKey, 'market-request', record, 0);
      tx.put(indexKey, 'market-request-index', { ids: [...ids, input.requestId] }, index?.revision ?? 0);
      return { prior: null };
    });
    if (started.prior) return this.#response(started.prior, true);
    let timer;
    try {
      const output = await Promise.race([
        Promise.resolve().then(() => this.#executor(input)),
        new Promise((_, reject) => { timer = setTimeout(() => { try { deny('route_timeout'); } catch (error) { reject(error); } }, this.#timeout); }),
      ]);
      // No client or executor can mint a receipt. The host checks exact output.
      const result = spec(output, ['path', 'hops']);
      if (digest('route-result', result) !== digest('route-result', expectedResult(input))) deny('invalid_route_result');
      if (this.#auth.resolve(handle) !== owner) deny('unauthenticated');
      return this.#store.transaction(tx => {
        const current = tx.get(requestKey);
        if (current?.value.status === 'cancelled') deny('route_cancelled');
        const sub = this.#authorized(tx, owner, input);
        if (current.value.status !== 'pending' || sub.revision !== current.value.subscriptionRevision || sub.value.generation !== current.value.generation) deny('route_authority_changed');
        const receipt = { receiptId: 'route-' + randomUUID(), providerId: 'demo-maps', productId: PRODUCT,
          instanceId: input.instanceId, serviceId: 'synthetic.route.v1', serviceVersion: 1,
          requestId: input.requestId, input: { from: input.from, to: input.to }, result,
          source: 'deterministic-synthetic-route' };
        const done = { ...current.value, status: 'completed', receipt };
        tx.put(requestKey, 'market-request', done, current.revision);
        return this.#response(done, false);
      });
    } catch (error) {
      this.#store.transaction(tx => {
        const current = tx.get(requestKey);
        if (current?.value.status === 'pending') tx.put(requestKey, 'market-request', { ...current.value, status: 'failed' }, current.revision);
        return null;
      });
      throw error;
    } finally { clearTimeout(timer); }
  }
}
