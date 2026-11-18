import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SnapshotStore} from '../../microkernel/src/store.js';
import {HostIdentity} from '../../microkernel/src/identity.js';
import {GrantLedger} from '../../microkernel/src/grants.js';
import {ControlledContextLab} from '../../microkernel/src/context.js';
import {canonical} from '../../microkernel/src/canonical.js';
import {CreatureRegistry} from '../src/creature-registry.js';
import {LocalArtifactMailbox} from '../src/local-artifact-mailbox.js';
import {PrimaryDraftHandoff,handoffPrincipal} from '../src/primary-draft-handoff.js';
import {SceneLab} from '../src/scene.js';
import {createSceneServer} from '../src/scene-server.js';
import {parseSpokenRoute} from '../src/spoken-route.js';
const values={customerAlias:'demo-a',accountType:'savings',contactPreference:'none'};
const creature=(id)=>({id,name:id,kind:id==='work'?'business':'companion',personality:'synthetic fixture',body:'sprout',tone:'playful'});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'primary-handoff-')),path=join(dir,'core'),auth=new HostIdentity(),owner=auth.authenticate('alice'),other=auth.authenticate('bob'),admin=auth.authenticate('host-admin');
 let now=100,store,ledger,data,registry,mailbox,handoff,stop=null;
 let current={context:{creatureId:'companion',sceneRevision:1},task:{id:'task-1',revision:1,status:'draft',values}};
 const open=()=>{store=new SnapshotStore(path);ledger=new GrantLedger(store,auth,{clock:()=>now});data=new ControlledContextLab(store,ledger);registry=new CreatureRegistry(store,auth);mailbox=new LocalArtifactMailbox(store,auth,data);handoff=new PrimaryDraftHandoff(store,auth,{ledger,data,mailbox,registry,administratorHandle:admin,currentBinding:()=>current,afterStage:stage=>{if(stage===stop)throw new Error('injected-stop');}});};open();registry.create(owner,creature('companion'));registry.create(owner,creature('work'));
 return {dir,auth,owner,other,admin,get store(){return store;},get ledger(){return ledger;},get data(){return data;},get registry(){return registry;},get mailbox(){return mailbox;},get handoff(){return handoff;},get current(){return current;},set current(v){current=v;},time(v){now=v;},stop(stage){stop=stage;},reopen(){store.close();open();},close(){store.close();rmSync(dir,{recursive:true});},prepare(){return handoff.prepare(owner,{context:current.context}).handoff;},confirm(handoffId){return handoff.confirm(owner,{handoffId,confirmation:'share-synthetic-draft'}).handoff;},saved(id){return store.get('primary-handoff.'+id).value;}};
}
test('explicit preparation freezes inputs, narrow delegated budget, only original creature reads delivered copy',()=>{
 const f=fixture();try{
  const prepared=f.prepare(),p=f.saved(prepared.handoffId);assert.equal(prepared.status,'prepared');assert.equal(f.store.get('grant.'+p.ids.root),null);assert.equal(f.store.get('source.'+p.ids.source),null);
  assert.deepEqual(f.prepare(),prepared);assert.equal(f.handoff.list(f.owner).handoffs.length,1);
  assert.throws(()=>f.handoff.confirm(f.owner,{handoffId:p.handoffId,confirmation:'share-synthetic-draft',values:{}}),{code:'invalid_shape'});
  assert.throws(()=>f.handoff.confirm(f.owner,{handoffId:p.handoffId,confirmation:'just-prepare'}),{code:'handoff_confirmation_required'});
  const primary=f.auth.authenticate(handoffPrincipal('alice','companion')),work=f.auth.authenticate(handoffPrincipal('alice','work'));
  assert.throws(()=>f.handoff.read(f.owner,{handoffId:p.handoffId}),{code:'handoff_not_authorized'});
  assert.throws(()=>f.handoff.status(f.other,{handoffId:p.handoffId}),{code:'handoff_not_authorized'});
  const delivered=f.confirm(p.handoffId);assert.equal(delivered.status,'delivered');assert.equal(delivered.receipt.fact,'local_recipient_copy_saved');assert.ok(!JSON.stringify(delivered).includes('content"'));
  assert.equal(f.handoff.read(primary,{handoffId:p.handoffId}).content,canonical(values));
  assert.throws(()=>f.handoff.read(work,{handoffId:p.handoffId}),{code:'handoff_not_authorized'});
  const root=f.store.get('grant.'+p.ids.root).value,child=f.store.get('grant.'+p.ids.child).value;
  assert.equal(root.rootPrincipal,'alice');assert.equal(root.delegate,p.coordinatorPrincipal);assert.equal(root.maxDepth,1);assert.equal(child.delegate,p.workerPrincipal);assert.equal(child.maxDepth,0);assert.deepEqual(child.spent,p.budget);assert.deepEqual(root.allocated,p.budget);assert.deepEqual(root.spent,{calls:0,bytes:0});
  assert.deepEqual(child.resources,[p.ids.source]);assert.deepEqual(child.purposes,['draft-return']);assert.equal(f.store.get('source.'+p.ids.source).value.content,canonical(values));
  assert.throws(()=>f.data.run(primary,'unauthorized-run',{contextId:p.ids.context,artifactId:'other-artifact'}),{code:'not_authorized'});
  f.reopen();assert.deepEqual(f.confirm(p.handoffId),delivered);assert.equal(f.mailbox.list(primary).length,1);assert.deepEqual(f.store.get('grant.'+p.ids.child).value.spent,p.budget);
  assert.equal(f.handoff.cancel(f.owner,{handoffId:p.handoffId}).handoff.status,'delivered');
  f.ledger.revoke(f.owner,'withdraw-owner',p.ids.root);assert.throws(()=>f.handoff.read(primary,{handoffId:p.handoffId}),{code:'grant_inactive'});assert.equal(f.handoff.status(f.owner,{handoffId:p.handoffId}).handoff.status,'delivered');
 }finally{f.close();}
});
for(const stage of ['confirmed','source','root','child','context','run','mail'])test('restart after '+stage+' uses original IDs, deadline and budget; mailbox receipt wins',()=>{
 const f=fixture();try{const prepared=f.prepare(),p=f.saved(prepared.handoffId);f.stop(stage);assert.throws(()=>f.confirm(p.handoffId),/injected-stop/);f.stop(null);f.reopen();
 const pending=f.handoff.status(f.owner,{handoffId:p.handoffId}).handoff;
 assert.equal(pending.status,stage==='mail'?'delivered':'running');
 if(stage==='confirmed'){assert.equal(f.store.get('source.'+p.ids.source),null);assert.equal(f.store.get('grant.'+p.ids.root),null);assert.equal(f.prepare().status,'running');assert.equal(f.handoff.list(f.owner).handoffs[0].status,'running');assert.equal(f.store.get('grant.'+p.ids.root),null);}
 const done=f.confirm(p.handoffId);assert.equal(done.status,'delivered');assert.equal(done.expiresAt,prepared.expiresAt);assert.deepEqual(f.store.get('grant.'+p.ids.child).value.spent,p.budget);assert.equal(f.handoff.list(f.owner).handoffs.length,1);assert.equal(f.mailbox.list(f.auth.authenticate(p.coordinatorPrincipal)).length,1);}finally{f.close();}
});
test('pending binding changes block and revoke root; no new deadline on rollback/reprepare',()=>{
 const f=fixture();try{
  const p=f.prepare();f.stop('context');assert.throws(()=>f.confirm(p.handoffId));f.stop(null);
  const stored=f.saved(p.handoffId);f.current={...f.current,task:{...f.current.task,revision:2}};
  assert.equal(f.handoff.status(f.owner,{handoffId:p.handoffId}).handoff.status,'blocked');assert.equal(f.store.get('grant.'+stored.ids.root).value.status,'revoked');
  f.current={...f.current,task:{...f.current.task,revision:1}};assert.equal(f.prepare().status,'blocked');assert.throws(()=>f.confirm(p.handoffId),{code:'handoff_not_ready'});
  f.current={...f.current,context:{...f.current.context,sceneRevision:2}};const fresh=f.prepare();f.time(fresh.expiresAt);assert.equal(f.handoff.status(f.owner,{handoffId:fresh.handoffId}).handoff.status,'expired');f.time(1);f.reopen();assert.equal(f.prepare().status,'expired');assert.equal(f.prepare().expiresAt,fresh.expiresAt);
 }finally{f.close();}
});
for(const point of ['termination-intent','root-revoked'])test('cancel recovers from '+point+' before terminal state, never grants again',()=>{
 const f=fixture();try{const p=f.prepare();f.stop('root');assert.throws(()=>f.confirm(p.handoffId));f.stop(point);assert.throws(()=>f.handoff.cancel(f.owner,{handoffId:p.handoffId}),/injected-stop/);f.stop(null);f.reopen();assert.equal(f.handoff.status(f.owner,{handoffId:p.handoffId}).handoff.status,'cancelled');assert.equal(f.store.get('grant.'+f.saved(p.handoffId).ids.root).value.status,'revoked');assert.throws(()=>f.confirm(p.handoffId),{code:'handoff_not_ready'});}finally{f.close();}
});
test('foreground primary is not universal authority; registry, draft and foreign identity gates',()=>{
 const f=fixture();try{
  f.current={...f.current,context:{creatureId:'work',sceneRevision:1}};assert.throws(()=>f.prepare(),{code:'handoff_primary_foreground_required'});
  f.registry.setPrimary(f.owner,{creatureId:'work',expectedRevision:f.registry.state(f.owner).revision});assert.throws(()=>f.prepare(),{code:'handoff_primary_foreground_required'});
  f.registry.setPrimary(f.owner,{creatureId:'companion',expectedRevision:f.registry.state(f.owner).revision});f.current={...f.current,context:{creatureId:'companion',sceneRevision:1},task:{...f.current.task,values:{}}};assert.throws(()=>f.prepare());
  f.current={...f.current,task:{...f.current.task,values}};const p=f.prepare();f.registry.create(f.owner,creature('extra'));assert.equal(f.handoff.list(f.owner).handoffs[0].status,'blocked');assert.throws(()=>f.confirm(p.handoffId),{code:'handoff_not_ready'});
  assert.throws(()=>f.handoff.list({}),{code:'unauthenticated'});assert.deepEqual(f.handoff.list(f.other).handoffs,[]);
 }finally{f.close();}
});
test('bounded list has no input fields or body and capacity is durable',()=>{
 const f=fixture();try{for(let i=1;i<=32;i++){f.current={...f.current,context:{...f.current.context,sceneRevision:i}};f.prepare();}const list=f.handoff.list(f.owner);assert.equal(list.handoffs.length,32);assert.equal(JSON.stringify(list).includes('customerAlias'),false);f.current={...f.current,context:{...f.current.context,sceneRevision:33}};assert.throws(()=>f.prepare(),{code:'handoff_capacity'});f.reopen();assert.equal(f.handoff.list(f.owner).handoffs.length,32);}finally{f.close();}
});
test('real Scene HTTP freezes complete synthetic draft, explicit owner confirmation delivers no body',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'handoff-http-')),scene=new SceneLab(join(dir,'core'),join(dir,'sink'));
 const server=createSceneServer(scene);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(path,body)=>{const r=await fetch(base+'/scene/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{
  let state=scene.perceive({modality:'hearing',signal:'account-request'});scene.update({activityId:state.activity.id,expectedRevision:state.activity.revision,values});state=scene.selectCreature({creatureId:'companion'});
  const prepared=await post('handoff-prepare',{context:state.context});assert.equal(prepared.status,200);const id=prepared.body.handoff.handoffId;assert.equal(prepared.body.handoff.coordinatorId,'companion');
  const done=await post('handoff-confirm',{handoffId:id,confirmation:'share-synthetic-draft'});assert.equal(done.status,200);assert.equal(done.body.handoff.status,'delivered');assert.equal(done.body.contentReturned,false);assert.equal(done.body.handoff.receipt.fact,'local_recipient_copy_saved');
  assert.equal(scene.state().activeCreatureId,'companion');assert.equal(scene.state().activity.status,'draft');assert.equal(scene.state().activity.receipt,null);assert.equal(Object.hasOwn(scene.state(),'handoffs'),false);
  assert.equal((await post('handoff-list',{})).body.handoffs.length,1);assert.equal((await post('handoff-status',{handoffId:id,readBody:true})).status,400);
  assert.deepEqual((await post('handoff-confirm',{handoffId:id,confirmation:'share-synthetic-draft'})).body,done.body);
 }finally{await new Promise(r=>server.close(r));scene.close();rmSync(dir,{recursive:true});}
});
test('Scene mutation immediately invalidates a partially authorized handoff and reopening preserves denial',()=>{
 const dir=mkdtempSync(join(tmpdir(),'handoff-scene-'));let stop=true;let scene=new SceneLab(join(dir,'core'),join(dir,'sink'),{handoffOptions:{afterStage:stage=>{if(stop&&stage==='root')throw Error('pause');}}});
 try{let state=scene.perceive({modality:'hearing',signal:'account-request'});scene.update({activityId:state.activity.id,expectedRevision:state.activity.revision,values});state=scene.selectCreature({creatureId:'companion'});const h=scene.prepareHandoff({context:state.context}).handoff;assert.throws(()=>scene.confirmHandoff({handoffId:h.handoffId,confirmation:'share-synthetic-draft'}),/pause/);stop=false;scene.selectCreature({creatureId:'work'});assert.equal(scene.queryHandoff({handoffId:h.handoffId}).handoff.status,'blocked');scene.close();scene=new SceneLab(join(dir,'core'),join(dir,'sink'));assert.equal(scene.queryHandoff({handoffId:h.handoffId}).handoff.status,'blocked');}finally{scene.close();rmSync(dir,{recursive:true});}
});

for(const sweepFailure of [false,true])test('spoken-route scene commit invalidates pending root without rewriting route fact; sweepFailure='+sweepFailure,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'handoff-spoken-'));let pause='root';let scene=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>100,handoffOptions:{afterStage:stage=>{if(stage===pause)throw Error('injected-sweep-stop');}}});
 try{
  scene.subscribeCreature({productId:'demo.maps.v1'});let sub=scene.state().market.subscriptions[0];scene.grantRoute({productId:sub.productId,enabled:true,expectedRevision:sub.revision});
  let state=scene.perceive({modality:'hearing',signal:'account-request'});scene.update({activityId:state.activity.id,expectedRevision:state.activity.revision,values});state=scene.selectCreature({creatureId:'companion'});
  const handoff=scene.prepareHandoff({context:state.context}).handoff;assert.throws(()=>scene.confirmHandoff({handoffId:handoff.handoffId,confirmation:'share-synthetic-draft'}),/injected-sweep-stop/);
  pause=sweepFailure?'termination-intent':null;
  scene.beginSense('handoff-route',state.context,'hearing',200);
  const proposal=scene.makeSpokenRouteProposal('handoff-route',state.context,parseSpokenRoute('请用演示地图从甲站到丙站规划合成路线'),200);
  scene.finishSense('handoff-route',{routeProposal:proposal,candidate:null});
  if(sweepFailure)await assert.rejects(scene.confirmSpokenRoute('handoff-route',proposal,()=>{}),/injected-sweep-stop/);
  else assert.equal((await scene.confirmSpokenRoute('handoff-route',proposal,()=>{})).eventStatus,'route_applied');
  assert.equal(scene.querySpokenRoute('handoff-route').eventStatus,'route_applied');assert.equal(scene.querySpokenRoute('handoff-route').requestStatus,'completed');
  pause=null;scene.close();
  if(!sweepFailure){
   // Inspect BEFORE constructing a new Scene: startup recovery must not mask a
   // missing immediate sweep in confirmSpokenRoute's successful commit path.
   const immediate=new SnapshotStore(join(dir,'core'));try{const saved=immediate.get('primary-handoff.'+handoff.handoffId).value;assert.equal(saved.status,'blocked');assert.equal(immediate.get('grant.'+saved.ids.root).value.status,'revoked');}finally{immediate.close();}
  }
  scene=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>100});
  assert.equal(scene.queryHandoff({handoffId:handoff.handoffId}).handoff.status,'blocked');assert.equal(scene.querySpokenRoute('handoff-route').eventStatus,'route_applied');
  scene.close();const store=new SnapshotStore(join(dir,'core'));try{const p=store.get('primary-handoff.'+handoff.handoffId).value;assert.equal(store.get('grant.'+p.ids.root).value.status,'revoked');}finally{store.close();}
 }finally{scene.close();rmSync(dir,{recursive:true});}
});

test('new work principal and child scope cannot borrow the legacy demo-work account authority',()=>{
 const dir=mkdtempSync(join(tmpdir(),'handoff-legacy-scope-'));let scene=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>100,handoffOptions:{afterStage:stage=>{if(stage==='child')throw Error('pause-child');}}});
 try{
  let state=scene.perceive({modality:'hearing',signal:'account-request'});state=scene.update({activityId:state.activity.id,expectedRevision:state.activity.revision,values});const legacyId=state.activity.id+'-r'+state.activity.revision;
  state=scene.submit({activityId:state.activity.id,expectedRevision:state.activity.revision});state=scene.newTask({previousActivityId:state.activity.id});state=scene.update({activityId:state.activity.id,expectedRevision:state.activity.revision,values});state=scene.selectCreature({creatureId:'companion'});
  const handoff=scene.prepareHandoff({context:state.context}).handoff;assert.throws(()=>scene.confirmHandoff({handoffId:handoff.handoffId,confirmation:'share-synthetic-draft'}),/pause-child/);scene.close();
  const store=new SnapshotStore(join(dir,'core'));try{
   const auth=new HostIdentity(),ledger=new GrantLedger(store,auth,{clock:()=>100}),data=new ControlledContextLab(store,ledger),p=store.get('primary-handoff.'+handoff.handoffId).value;
   const worker=auth.authenticate(p.workerPrincipal),legacy=auth.authenticate('demo-work'),before=store.get('source.'+legacyId).digest;
   assert.notEqual(p.workerPrincipal,'demo-work');
   assert.throws(()=>data.createContext(worker,'deny-legacy-source',{contextId:'borrow-old-source',bindings:[{sourceId:legacyId,grantId:legacyId}],stateRefs:[],purpose:'demo-account'}),{code:'source_scope_denied'});
   assert.throws(()=>store.transaction(tx=>ledger.validateIn(tx,{grantId:legacyId,actor:auth.resolve(worker),resourceId:legacyId,operations:['read'],purpose:'demo-account',recipient:'demo-work'})),{code:'not_authorized'});
   assert.throws(()=>store.transaction(tx=>ledger.validateIn(tx,{grantId:p.ids.child,actor:auth.resolve(worker),resourceId:legacyId,operations:['read'],purpose:'draft-return',recipient:p.workerPrincipal})),{code:'grant_scope_denied'});
   assert.throws(()=>data.createContext(worker,'deny-legacy-purpose',{contextId:'borrow-old-purpose',bindings:[{sourceId:p.ids.source,grantId:p.ids.child}],stateRefs:[],purpose:'demo-account'}),{code:'source_scope_denied'});
   assert.throws(()=>store.transaction(tx=>ledger.validateIn(tx,{grantId:p.ids.child,actor:auth.resolve(legacy),resourceId:p.ids.source,operations:['read'],purpose:'draft-return',recipient:p.workerPrincipal})),{code:'not_authorized'});
   assert.equal(store.get('source.'+legacyId).digest,before);assert.deepEqual(store.get('grant.'+p.ids.child).value.spent,{calls:0,bytes:0});
  }finally{store.close();}
 }finally{scene.close();rmSync(dir,{recursive:true});}
});
