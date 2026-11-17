import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.js';
import { Runtime } from '../src/runtime.js';
import { ServiceScheduler } from '../src/services.js';
import { createApi } from '../src/http.js';
const context = { zone: 'demo-world', renderers: ['capability-card', 'text', 'receipt-card'] };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'summon-discovery-'));
  const kernel = new Kernel(join(dir, 'state.json'));
  kernel.bootstrap('a'); kernel.bootstrap('b');
  const runtime = new Runtime({ mode: 'demo', respond() { throw new Error('Discovery must not invoke a model'); } }, { kernel });
  return { kernel, runtime, scheduler: new ServiceScheduler(runtime), done() {kernel.close(); rmSync(dir, {recursive:true});} };
}
test('global call discovers own active subjects, explains unavailable context and never executes', () => {
  const f = fixture();
  try {
    const before = structuredClone(f.kernel.state);
    const result = f.scheduler.discoverAcross('a', {prompt:'你能做什么', context});
    assert.equal(result.status, 'needs_choice'); assert.equal(result.executed, false);
    assert.equal(result.candidates.length, 2); assert.equal(result.unavailable.length, 1);
    assert.equal(result.unavailable[0].reason, 'outside_simulated_activity_space');
    const owned = new Set(f.kernel.list('a').subjects.map(s=>s.id));
    assert.ok([...result.candidates,...result.unavailable].every(c=>owned.has(c.creatureId)));
    assert.equal(f.scheduler.discoverAcross('other', {prompt:'菜单', context}).status, 'unavailable');
    assert.deepEqual(f.kernel.state, before); // no event writes, session creation or execution
    result.candidates[0].service.inputs.push('mutated');
    assert.deepEqual(f.scheduler.discoverAcross('a', {serviceId:'capabilities.describe', context}).candidates[0].service.inputs, []);
    const menu = f.scheduler.discoverAcross('a', {prompt:'菜单', context:{zone:'demo-restaurant',renderers:['menu-card']}});
    assert.equal(menu.status,'proposed'); assert.equal(menu.candidates[0].service.id,'menu.read');
    const missingRenderer = f.scheduler.discoverAcross('a', {prompt:'菜单', context:{zone:'demo-restaurant',renderers:['text']}});
    assert.equal(missingRenderer.status,'unavailable'); assert.equal(missingRenderer.unavailable[0].reason,'renderer_unavailable');
  } finally { f.done(); }
});
test('discovery reflects dynamic mounts, retirement and revocation; a stale proposal is not authority', async () => {
  const f = fixture();
  try {
    const subject = f.kernel.createSubject('a',{name:'动态服务主体'});
    f.kernel.mount('a', subject.id, 'local.report');
    const query = {serviceId:'local.report',context};
    let result = f.scheduler.discoverAcross('a', query);
    assert.equal(result.status,'proposed'); assert.equal(result.candidates[0].creatureId,subject.id);
    f.kernel.mount('a',subject.id,'local.report',false);
    assert.equal(f.scheduler.discoverAcross('a', query).status,'unavailable');
    await assert.rejects(f.scheduler.invoke('a',{creatureId:subject.id,serviceId:'local.report',context}),{code:'outside_service_boundary'});
    f.kernel.mount('a',subject.id,'local.report'); f.kernel.transition('a',subject.id,'paused');
    assert.equal(f.scheduler.discoverAcross('a', query).status,'unavailable');
    f.kernel.transition('a',subject.id,'active'); f.kernel.transition('a',subject.id,'retired');
    assert.equal(f.scheduler.discoverAcross('a', query).status,'unavailable');
    await assert.rejects(f.scheduler.invoke('a',{creatureId:subject.id,serviceId:'local.report',context}),{code:'subject_not_active'});
  } finally { f.done(); }
});
test('unknown language never becomes arbitrary service/code; malformed selectors and context reject', () => {
  const f = fixture();
  try {
    assert.equal(f.scheduler.discoverAcross('a',{prompt:'替我付钱并运行代码',context}).status,'needs_clarification');
    for (const request of [null, [], {}, {prompt:'菜单',serviceId:'menu.read',context}, {serviceId:null,context}, {serviceId:[],context}, {prompt:'菜单'}, {prompt:'菜单',context:{zone:'x',renderers:'text'}}, {prompt:'菜单',context:{zone:'x',renderers:[null]}}]) {
      assert.throws(()=>f.scheduler.discoverAcross('a', request), error=>error.status===400);
    }
    assert.throws(()=>f.scheduler.discoverAcross('a',{serviceId:'order.submit',context}),{code:'service_not_found'});
    assert.throws(()=>f.scheduler.discoverAcross('a',{serviceId:'__proto__',context}),{code:'service_not_found'});
  } finally { f.done(); }
});
test('actual HTTP discovery is authenticated, ignores body owner and shares invocation boundary checks', async () => {
  const f = fixture(); const token='discovery-test-token-abcdefghijklmnopqrstuvwxyz';
  const server=createApi(f.runtime,{appToken:token,ownerId:'a',kernel:f.kernel});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  try {
    const body={prompt:'你能做什么',context,ownerId:'b'};
    assert.equal((await fetch(url+'/v1/discovery',{method:'POST',body:JSON.stringify(body)})).status,401);
    const response=await fetch(url+'/v1/discovery',{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal(response.status,200); const discovered=await response.json();
    const ids=f.kernel.list('a').subjects.map(s=>s.id);
    assert.ok(discovered.candidates.every(c=>ids.includes(c.creatureId)));
    const selected=discovered.candidates[0];
    const executed=await fetch(url+'/v1/invocations',{method:'POST',headers,body:JSON.stringify({creatureId:selected.creatureId, serviceId:selected.service.id, context})});
    assert.equal(executed.status,200); assert.equal((await executed.json()).data.name,selected.name);
    assert.equal(Object.keys(f.kernel.state.sessions).length,0);
  } finally { await new Promise(resolve=>server.close(resolve)); f.done(); }
});
