import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SnapshotStore} from '../../microkernel/src/store.js';
import {HostIdentity} from '../../microkernel/src/identity.js';
import {digest} from '../../microkernel/src/canonical.js';
import {CreatureRegistry} from '../src/creature-registry.js';
import {FocusService} from '../src/focus-service.js';
import {SceneLab} from '../src/scene.js';
import {createSceneServer} from '../src/scene-server.js';
const values={topic:'study',duration:'5',pace:'gentle'};
const definition=id=>({id,name:'伙伴',kind:'pet',personality:'好奇',body:'sprout',tone:'playful'});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'focus-service-')),path=join(dir,'core');let now=100,store,registry,focus;const auth=new HostIdentity(),alice=auth.authenticate('alice'),bob=auth.authenticate('bob');const open=()=>{store=new SnapshotStore(path);registry=new CreatureRegistry(store,auth);focus=new FocusService(store,auth,registry,{clock:()=>now});};open();return {dir,auth,alice,bob,get store(){return store;},get registry(){return registry;},get focus(){return focus;},clock(v){now=v;},reopen(){store.close();open();},close(){store.close();rmSync(dir,{recursive:true});},enable(handle=alice,id='pet'){registry.create(handle,definition(id));return focus.grant(handle,{creatureId:id,enabled:true,expectedRevision:0});},request(requestId='r1',handle=alice){const state=focus.state(handle);return {requestId,binding:{context:{creatureId:state.primaryCreatureId,sceneRevision:1},targetCreatureId:state.primaryCreatureId,registryRevision:state.registryRevision,grantRevision:state.grant.revision,grantGeneration:state.grant.generation,serviceId:'synthetic.focus.v1'},values};}};}
test('explicit grants, one active owner plan, persisted fact and historical replay independent of current authority',()=>{
 const f=fixture();try{
  f.registry.create(f.alice,definition('pet'));assert.equal(f.focus.state(f.alice).grant.enabled,false);
  f.focus.grant(f.alice,{creatureId:'pet',enabled:true,expectedRevision:0});const input=f.request(),r=f.focus.create(f.alice,input);
  assert.equal(r.plan.dueAt,300100);assert.equal(r.plan.receipt.fact,'plan_saved');assert.equal(r.plan.status,'active');
  assert.throws(()=>f.focus.create(f.alice,f.request('r2')),{code:'focus_plan_active'});
  f.focus.grant(f.alice,{creatureId:'pet',enabled:false,expectedRevision:1});f.reopen();
  assert.equal(f.focus.create(f.alice,input).replayed,true);assert.equal(f.focus.getPlan(f.alice,{requestId:'r1'}).plan.planId,r.plan.planId);
  assert.throws(()=>f.focus.create(f.alice,{...input,values:{...values,duration:'15'}}),{code:'focus_request_conflict'});
  const cancelled=f.focus.cancel(f.alice,{requestId:'r1'});assert.equal(cancelled.status,'completed');assert.equal(cancelled.plan.status,'cancelled');assert.deepEqual(cancelled.plan.receipt,r.plan.receipt);
 }finally{f.close();}
});
test('primary/grant ABA fails old binding, independent creature grants remain explicit',()=>{
 const f=fixture();try{
  f.enable();const old=f.request();f.registry.create(f.alice,definition('second'));
  f.registry.setPrimary(f.alice,{creatureId:'second',expectedRevision:2});assert.equal(f.focus.state(f.alice).grant.enabled,false);
  assert.throws(()=>f.focus.grant(f.alice,{creatureId:'pet',enabled:false,expectedRevision:1}),{code:'focus_primary_required'});
  f.registry.setPrimary(f.alice,{creatureId:'pet',expectedRevision:3});assert.equal(f.focus.state(f.alice).grant.enabled,true);
  assert.throws(()=>f.focus.create(f.alice,old),{code:'focus_authority_changed'});
  const next=f.request();f.focus.grant(f.alice,{creatureId:'pet',enabled:false,expectedRevision:1});f.focus.grant(f.alice,{creatureId:'pet',enabled:true,expectedRevision:2});
  assert.throws(()=>f.focus.create(f.alice,next),{code:'focus_authority_changed'});
 }finally{f.close();}
});
test('observed elapsed commits even when later create fails, survives restart/rollback, never means user completion',()=>{
 const f=fixture();try{
  f.enable();f.focus.create(f.alice,f.request());const stale=f.request('bad');f.clock(300100);
  assert.throws(()=>f.focus.create(f.alice,{...stale,binding:{...stale.binding,grantGeneration:999}}),{code:'focus_authority_changed'});
  f.reopen();f.clock(100);const plan=f.focus.getPlan(f.alice,{requestId:'r1'}).plan;
  assert.equal(plan.status,'elapsed');assert.equal(plan.receipt.fact,'plan_saved');assert.equal(f.focus.state(f.alice).activePlan,null);
  assert.equal(f.focus.cancel(f.alice,{requestId:'r1'}).plan.status,'elapsed');
 }finally{f.close();}
});
test('owner isolation, unknown cancellation tombstone, invalid clock and domain rejection',()=>{
 const f=fixture();try{
  f.enable();f.enable(f.bob);f.focus.cancel(f.alice,{requestId:'late'});f.reopen();
  assert.throws(()=>f.focus.create(f.alice,f.request('late')),{code:'focus_request_cancelled'});
  f.focus.create(f.bob,f.request('late',f.bob));assert.equal(f.focus.getPlan(f.alice,{requestId:'late'}).plan,null);
  assert.deepEqual(f.focus.getPlan(f.alice,{requestId:'unknown'}),{requestId:'unknown',status:'not_started',plan:null});
  assert.throws(()=>f.focus.state({id:'bob'}),{code:'unauthenticated'});
  assert.throws(()=>new FocusService(f.store,new HostIdentity(),f.registry),{code:'focus_domain_mismatch'});
  f.clock(Number.MAX_SAFE_INTEGER);assert.throws(()=>f.focus.create(f.alice,f.request('overflow')),{code:'invalid_clock'});
 }finally{f.close();}
});
test('actual HTTP focus form binds context/primary/grant; explicit cancel and query recover saved records',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'focus-http-'));const scene=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>100});const server=createSceneServer(scene);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});
 try{
  assert.equal(scene.state().choiceForms.focus,null);
  let state=await(await post('/scene/focus-grant',{creatureId:'companion',enabled:true,expectedRevision:0})).json();const form=state.choiceForms.focus;
  assert.deepEqual(form.fields.map(f=>f.id),['topic','duration','pace']);assert.equal(form.fields[1].label,'计划时长（分钟）');
  scene.selectCreature({creatureId:'work'});scene.selectCreature({creatureId:'companion'});
  const body={formId:form.formId,binding:form.binding,values,requestId:'http-plan'};
  assert.equal((await post('/scene/form-focus',body)).status,409);
  const fresh=scene.state().choiceForms.focus;state=await(await post('/scene/form-focus',{...body,formId:fresh.formId,binding:fresh.binding})).json();
  assert.equal(state.focus.activePlan.receipt.fact,'plan_saved');assert.equal(state.choiceForms.focus,null);
  const status=await(await post('/scene/focus-status',{requestId:'http-plan'})).json();assert.equal(status.status,'completed');assert.equal(status.plan.status,'active');
  state=await(await post('/scene/focus-cancel',{requestId:'http-plan'})).json();assert.equal(state.focus.plans[0].status,'cancelled');assert.equal(state.focus.requests[0].status,'completed');
 }finally{await new Promise(r=>server.close(r));scene.close();rmSync(dir,{recursive:true});}
});
test('mixed maximum registry and two 128-request ledgers remain below Scene C1 byte limit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'focus-max-')),path=join(dir,'core'),sink=join(dir,'sink');let scene=new SceneLab(path,sink,{clock:()=>100});
 try{
  scene.subscribeCreature({productId:'demo.maps.v1'});let sub=scene.state().market.subscriptions[0];scene.grantRoute({productId:sub.productId,enabled:true,expectedRevision:sub.revision});
  for(let i=0;i<13;i++)scene.createCreature({...definition(('extra'+i).padEnd(64,'x')),name:'😀'.repeat(64),personality:'😀'.repeat(512)});
  for(let i=0;i<128;i++)await scene.requestRoute({productId:sub.productId,instanceId:sub.instanceId,from:'A',to:'C',requestId:('route'+i).padEnd(64,'x')});
  scene.selectCreature({creatureId:'companion'});scene.grantFocus({creatureId:'companion',enabled:true,expectedRevision:0});
  for(let i=0;i<127;i++){
   const form=scene.state().choiceForms.focus,requestId=('focus'+i).padEnd(64,'x');
   scene.createFocusForm({formId:form.formId,binding:form.binding,values,requestId});scene.cancelFocus({requestId});
  }
  // Test worst-case stored descriptive fields for all 16, including seeded/service creatures.
  scene.close();const store=new SnapshotStore(path),k='creature-registry.'+digest('creature-owner','demo-owner').slice(7);
  store.transaction(tx=>{const r=tx.get(k);tx.put(k,'creature-registry',{...r.value,creatures:r.value.creatures.map(c=>({...c,name:'😀'.repeat(64),personality:'😀'.repeat(512)}))},r.revision);return null;});store.close();
  scene=new SceneLab(path,sink,{clock:()=>100});
  scene.primaryCreature({creatureId:'work',expectedRevision:scene.state().registryRevision});
  scene.grantFocus({creatureId:'work',enabled:true,expectedRevision:0});
  scene.perceive({modality:'hearing',signal:'account-request'});
  const three=scene.state();assert.ok(three.choiceForms.account&&three.choiceForms.route&&three.choiceForms.focus);
  console.log('maximum three-form Scene bytes:',Buffer.byteLength(JSON.stringify(three)));
  const last=three.choiceForms.focus;scene.createFocusForm({formId:last.formId,binding:last.binding,values,requestId:'focus127'.padEnd(64,'x')});
  const state=scene.state(),bytes=Buffer.byteLength(JSON.stringify(state));
  assert.equal(state.creatures.length,16);assert.equal(state.market.requestCount,128);assert.equal(state.focus.requestCount,128);assert.equal(state.focus.plans.length,1);assert.equal(state.focus.requests.length,4);assert.ok(bytes<65536,`bytes=${bytes}`);
  assert.equal(scene.queryFocus({requestId:'focus0'.padEnd(64,'x')}).status,'completed');
  assert.throws(()=>scene.cancelFocus({requestId:'new-overflow'}),{code:'focus_request_capacity'});
  console.log('maximum mixed Scene bytes:',bytes);
  scene.cancelFocus({requestId:('focus127').padEnd(64,'x')});
  scene.perceive({modality:'hearing',signal:'account-request'});
  assert.equal(scene.state().market.receiptWindow,8);assert.equal(scene.state().market.receipts.length,8);
  console.log('maximum account-visible Scene bytes:',Buffer.byteLength(JSON.stringify(scene.state())));
 }finally{scene.close();rmSync(dir,{recursive:true});}
});
test('shared HTTP fixture matches live generator with only random receipt/plan IDs normalized',async()=>{
 const expected=JSON.parse(readFileSync(new URL('./fixtures/focus-http.json',import.meta.url),'utf8'));
 const dir=mkdtempSync(join(tmpdir(),'focus-shared-')),scene=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>100});
 const server=createSceneServer(scene);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
 try{
  const before=await post('/scene/focus-grant',{creatureId:'companion',enabled:true,expectedRevision:0}),form=before.choiceForms.focus;
  const after=await post('/scene/form-focus',{formId:form.formId,binding:form.binding,values,requestId:'http-plan'}),status=await post('/scene/focus-status',{requestId:'http-plan'});
  const actual=JSON.parse(JSON.stringify({fixture:'synthetic-focus-http.v1',before,after,status},(_k,v)=>v===status.plan.planId?'focus-example':v===status.plan.receipt.receiptId?'saved-example':v));
  assert.deepEqual(actual,expected);
 }finally{await new Promise(r=>server.close(r));scene.close();rmSync(dir,{recursive:true});}
});
