import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.js';
import { Runtime } from '../src/runtime.js';
import { ServiceScheduler } from '../src/services.js';
import { DemoProvider } from '../src/providers.js';
import { createApi } from '../src/http.js';
const context = { zone:'demo-world', renderers:['receipt-card'] };
function setup() {
  const dir=mkdtempSync(join(tmpdir(),'summon-connectors-')); const path=join(dir,'state.json');
  let now=1000; let k=new Kernel(path,{clock:()=>now});
  return {get k(){return k;},time(t){now=t;},scheduler(){return new ServiceScheduler(new Runtime(new DemoProvider(),{kernel:k}));},
    restart(){k.close();k=new Kernel(path,{clock:()=>now});},done(){k.close();rmSync(dir,{recursive:true});}};
}
function device(f,owner='a') {
  const s=f.k.createSubject(owner,{name:'模拟设备主体'}); f.k.mount(owner,s.id,'device.preview');return s;
}
test('simulation connector lease gates both discovery and invocation, expires after restart', async()=>{
  const f=setup();
  try {
    const s=device(f); const query={serviceId:'device.preview',context};
    assert.equal(f.scheduler().discoverAcross('a',query).unavailable[0].reason,'connector_unavailable');
    await assert.rejects(f.scheduler().invoke('a',{creatureId:s.id,...query}),{code:'connector_unavailable'});
    f.k.reportConnector('a',{subjectId:s.id,status:'connected',leaseMs:1000});
    assert.equal(f.scheduler().discoverAcross('a',query).status,'proposed');
    const result=await f.scheduler().invoke('a',{creatureId:s.id,...query});
    assert.equal(result.data.deviceActionExecuted,false);assert.equal(result.demo,true);
    f.time(1999);f.restart();assert.equal(f.scheduler().discoverAcross('a',query).status,'proposed');
    f.time(2000);f.restart();assert.equal(f.scheduler().discoverAcross('a',query).unavailable[0].reason,'connector_expired');
    await assert.rejects(f.scheduler().invoke('a',{creatureId:s.id,...query}),{code:'connector_expired'});
    assert.equal(f.k.list('a').connectors[0].effectiveStatus,'expired');
    assert.equal(f.k.list('a').connectors[0].expiresAt,2000); // restart never renews it
  } finally {f.done();}
});
test('disconnect invalidates stale candidate; connector never grants service or background execution', async()=>{
  const f=setup();
  try {
    const s=device(f);f.k.reportConnector('a',{subjectId:s.id,status:'connected'});
    const stale=f.scheduler().discoverAcross('a',{serviceId:'device.preview',context}).candidates[0];
    f.k.reportConnector('a',{subjectId:s.id,status:'disconnected'});
    await assert.rejects(f.scheduler().invoke('a',{creatureId:stale.creatureId,serviceId:stale.service.id,context}),{code:'connector_unavailable'});
    f.k.reportConnector('a',{subjectId:s.id,status:'connected'});f.k.mount('a',s.id,'device.preview',false);
    await assert.rejects(f.scheduler().invoke('a',{creatureId:s.id,serviceId:'device.preview',context}),{code:'outside_service_boundary'});
    f.k.mount('a',s.id,'device.preview');
    assert.throws(()=>f.k.schedule('a',{subjectId:s.id,serviceId:'device.preview',trigger:{kind:'timer',at:1000}}),{code:'outside_service_boundary'});
    f.k.transition('a',s.id,'paused');
    assert.throws(()=>f.k.reportConnector('a',{subjectId:s.id,status:'connected'}),{code:'subject_not_active'});
  }finally{f.done();}
});
test('connector reports are owner-scoped, bounded, typed, simulated and expiry observation is persistently latched',()=>{
  const f=setup();try{
    const a=device(f), b=device(f,'b');
    assert.throws(()=>f.k.reportConnector('b',{subjectId:a.id,status:'connected'}),{code:'subject_not_found'});
    for(const leaseMs of [0,999,300001,Infinity,'1000']) assert.throws(()=>f.k.reportConnector('a',{subjectId:a.id,status:'connected',leaseMs}),{code:'invalid_connector_lease'});
    assert.throws(()=>f.k.reportConnector('a',{subjectId:a.id,status:'connected',kind:'https://remote.test'}),{code:'invalid_simulated_connector'});
    assert.throws(()=>f.k.reportConnector('a',{subjectId:a.id,status:'unknown'}),{code:'invalid_simulated_connector'});
    f.k.reportConnector('a',{subjectId:a.id,status:'connected',leaseMs:1000});f.k.reportConnector('b',{subjectId:b.id,status:'connected'});
    f.time(2000);f.k.connectorStatus('a',a.id,'device-simulation');
    assert.equal(f.k.state.connectors[a.id].lossEmitted,true);
    const before=structuredClone(f.k.state);f.k.connectorStatus('a',a.id,'device-simulation');
    assert.deepEqual(f.k.state,before);assert.equal(f.k.list('a').connectors.length,1);
    assert.equal(f.k.list('a').connectors[0].simulation,true);
    delete f.k.state.connectors[a.id].expiresAt;
    assert.equal(f.k.connectorStatus('a',a.id,'device-simulation').available,false);
    assert.equal(f.k.list('a').connectors[0].effectiveStatus,'expired');
  }finally{f.done();}
});
test('actual connector HTTP requires auth and cannot substitute request owner',async()=>{
  const f=setup();const a=device(f),b=device(f,'b');const token='connector-synthetic-token-abcdefghijklmnopqrstuvwxyz';
  const server=createApi(new Runtime(new DemoProvider(),{kernel:f.k}),{kernel:f.k,ownerId:'a',appToken:token});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const post=(path,body,auth=headers)=>fetch(base+path,{method:'POST',headers:auth,body:JSON.stringify(body)});
  try{
    assert.equal((await post('/v1/kernel/connectors',{subjectId:a.id,status:'connected'},{})).status,401);
    assert.equal((await post('/v1/kernel/connectors',{subjectId:b.id,status:'connected',ownerId:'b'})).status,404);
    const result=await post('/v1/kernel/connectors',{subjectId:a.id,status:'connected',leaseMs:1000});assert.equal(result.status,200);
    assert.equal((await result.json()).simulation,true);
    f.time(2000);assert.equal((await post('/v1/invocations',{creatureId:a.id,serviceId:'device.preview',context})).status,409);
  }finally{await new Promise(resolve=>server.close(resolve));f.done();}
});

test('connector expiry schedules pre-authorized local fallback once, atomically through restart',()=>{
  const f=setup();try{
    const s=device(f);f.k.mount('a',s.id,'local.report');
    const task=f.k.schedule('a',{subjectId:s.id,serviceId:'local.report',trigger:{kind:'event',type:'connector.lost'},payload:{purpose:'local fallback receipt, not a sent reminder'}});
    f.k.reportConnector('a',{subjectId:s.id,status:'connected',leaseMs:1000});
    f.time(1999);assert.equal(f.k.tick().length,0);
    f.time(2000);f.restart();const results=f.k.tick();
    assert.equal(results.length,1);assert.equal(results[0].taskId,task.id);assert.equal(results[0].effect,'local-only');
    assert.equal(f.k.state.events.filter(e=>e.type==='simulation.connector.lost').length,1);
    const revision=f.k.state.revision;assert.deepEqual(f.k.tick(),[]);assert.equal(f.k.state.revision,revision);
    f.restart();assert.deepEqual(f.k.tick(),[]);assert.equal(f.k.list('a').results.length,1);
    f.k.reportConnector('a',{subjectId:s.id,status:'disconnected'});assert.equal(f.k.state.events.filter(e=>e.type==='simulation.connector.lost').length,1);
  }finally{f.done();}
});
test('renewal before expiry does not lose connection; reconnect can emit another bounded event',()=>{
  const f=setup();try{
    const s=device(f);f.k.mount('a',s.id,'local.report');
    f.k.schedule('a',{subjectId:s.id,serviceId:'local.report',trigger:{kind:'event',type:'connector.lost',repeat:true}});
    f.k.reportConnector('a',{subjectId:s.id,status:'connected',leaseMs:1000});
    f.time(1500);f.k.reportConnector('a',{subjectId:s.id,status:'connected',leaseMs:1000});
    f.time(2000);assert.equal(f.k.tick().length,0);
    f.k.reportConnector('a',{subjectId:s.id,status:'disconnected'});assert.equal(f.k.tick().length,1);
    f.k.reportConnector('a',{subjectId:s.id,status:'disconnected'});assert.equal(f.k.tick().length,0);
    f.k.reportConnector('a',{subjectId:s.id,status:'connected',leaseMs:1000});
    f.time(3000);assert.equal(f.k.tick().length,0); // second loss held by 60s task cooldown
    f.restart();f.time(62000);assert.equal(f.k.tick().length,1);
    assert.equal(f.k.state.events.filter(e=>e.type==='simulation.connector.lost').length,2);
    assert.equal(f.k.list('a').results.length,2);
  }finally{f.done();}
});
test('paused, revoked, cancelled and absent fallback tasks never become unauthorized reminders',()=>{
  const f=setup();try{
    const paused=device(f),revoked=device(f),cancelled=device(f),absent=device(f,'b');
    for(const s of [paused,revoked,cancelled]) {
      f.k.mount('a',s.id,'local.report');
      const task=f.k.schedule('a',{subjectId:s.id,serviceId:'local.report',trigger:{kind:'event',type:'connector.lost'}});
      if(s.id===cancelled.id) f.k.cancel('a',task.id);
      f.k.reportConnector('a',{subjectId:s.id,status:'connected',leaseMs:1000});
    }
    f.k.reportConnector('b',{subjectId:absent.id,status:'connected',leaseMs:1000});
    f.k.transition('a',paused.id,'paused');f.k.mount('a',revoked.id,'local.report',false);
    f.time(2000);assert.deepEqual(f.k.tick(),[]);assert.equal(f.k.list('b').tasks.length,0);
    assert.equal(f.k.list('a').results.length,0);
    f.k.transition('a',paused.id,'active');const results=f.k.tick();assert.equal(results.length,1);assert.equal(results[0].subjectId,paused.id);
    assert.equal(Object.values(f.k.state.tasks).length,3); // no implicit new tasks
  }finally{f.done();}
});
test('renewing an already expired lease preserves the intervening loss event, without duplicating on tick',()=>{
  const f=setup();try{
    const s=device(f);f.k.mount('a',s.id,'local.report');
    f.k.schedule('a',{subjectId:s.id,serviceId:'local.report',trigger:{kind:'event',type:'connector.lost'}});
    f.k.reportConnector('a',{subjectId:s.id,status:'connected',leaseMs:1000});
    f.time(2100);f.k.reportConnector('a',{subjectId:s.id,status:'connected',leaseMs:1000});
    assert.equal(f.k.connectorStatus('a',s.id,'device-simulation').available,true);
    assert.equal(f.k.tick().length,1);assert.equal(f.k.state.events.filter(e=>e.type==='simulation.connector.lost').length,1);
  }finally{f.done();}
});

test('observed expiry cannot resurrect after rollback or restart; only explicit fresh report reacquires',async()=>{
  const f=setup();try{
    const s=device(f);f.k.reportConnector('a',{subjectId:s.id,status:'connected',leaseMs:1000});
    f.time(2001);assert.equal(f.k.connectorStatus('a',s.id,'device-simulation').reason,'connector_expired');
    f.time(1500);f.restart();assert.equal(f.k.connectorStatus('a',s.id,'device-simulation').available,false);
    assert.equal(f.k.list('a').connectors[0].effectiveStatus,'expired');
    await assert.rejects(f.scheduler().invoke('a',{creatureId:s.id,serviceId:'device.preview',context}),{code:'connector_expired'});
    assert.equal(f.k.state.events.filter(e=>e.type==='simulation.connector.lost').length,1);
    f.k.reportConnector('a',{subjectId:s.id,status:'connected',leaseMs:1000});
    assert.equal(f.k.connectorStatus('a',s.id,'device-simulation').available,true);
    f.time(2500);f.k.list('a'); // state listing is also an expiry observer
    f.time(1600);f.restart();assert.equal(f.k.connectorStatus('a',s.id,'device-simulation').available,false);
    assert.equal(f.k.state.events.filter(e=>e.type==='simulation.connector.lost').length,2);
  }finally{f.done();}
});
