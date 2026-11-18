import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {SnapshotStore} from '../../microkernel/src/store.js';
import {HostIdentity} from '../../microkernel/src/identity.js';
import {RealUsageHistory} from '../src/real-usage-history.js';
import {SceneLab} from '../src/scene.js';
import {compileInteractionProgram} from '../src/interaction-program.js';
import {createSceneServer} from '../src/scene-server.js';
function moduleFixture(options={}){
 const dir=mkdtempSync(join(tmpdir(),'real-usage-'));let store=new SnapshotStore(join(dir,'core')),now=100;
 const auth=new HostIdentity(),a=auth.authenticate('alice'),b=auth.authenticate('bob');let usage=new RealUsageHistory(store,auth,{clock:()=>now,...options});
 return {dir,auth,a,b,get store(){return store;},get usage(){return usage;},time(v){now=v;},reopen(){store.close();store=new SnapshotStore(join(dir,'core'));usage=new RealUsageHistory(store,auth,{clock:()=>now,...options});},done(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const presentation=(f,handle,commandId,targetId='session',options={})=>f.usage.perform(handle,commandId,{sessionId:targetId},{apply:()=>({target:{kind:'interaction-session',targetId},qualifies:true,ack:{fact:'reported',sessionId:targetId}}),...options});
test('empty isolated owner history; stable commands replay once across restart and conflicts do not count',()=>{
 const f=moduleFixture();try{
  assert.deepEqual(f.usage.state(f.a).items,[]);const first=presentation(f,f.a,'use');assert.equal(first.receiptStored,true);assert.equal(first.ack.usage.useCount,1);
  f.reopen();assert.equal(presentation(f,f.a,'use').replayed,true);assert.equal(f.usage.state(f.a).items[0].useCount,1);
  assert.throws(()=>presentation(f,f.a,'use','other'),{code:'command_conflict'});
  assert.deepEqual(f.usage.query(f.b,{commandId:'use'}),{status:'not_started',commandId:'use'});assert.deepEqual(f.usage.state(f.b).items,[]);
  presentation(f,f.b,'use');assert.equal(f.usage.state(f.b).items[0].useCount,1);
  f.time(200);presentation(f,f.a,'second');assert.equal(f.usage.state(f.a).items[0].lastUsedAt,200);
  f.time(50);presentation(f,f.a,'third');assert.equal(f.usage.state(f.a).items[0].lastUsedAt,200);
  assert.deepEqual(Object.keys(f.usage.state(f.a).items[0]).sort(),['kind','lastUsedAt','targetId','useCount']);
 }finally{f.done();}
});
test('bounded receipts saturate permanently without blocking actions or evicting dedup; untracked is not not_started',()=>{
 const f=moduleFixture({maxReceipts:2});try{
  presentation(f,f.a,'one');presentation(f,f.a,'two');assert.equal(f.usage.state(f.a).learningSaturated,true);
  f.reopen();let applied=0;
  for(let i=0;i<20;i++){const r=presentation(f,f.a,'after-'+i,'session',{apply:()=>{applied++;return {target:{kind:'interaction-session',targetId:'session'},qualifies:true,ack:{fact:'reported'}};}});assert.equal(r.receiptStored,false);assert.equal(r.ack.usage.recorded,false);}
  const audit=new DatabaseSync(join(f.dir,'core'),{readOnly:true});
  try{assert.equal(audit.prepare("SELECT count(*) AS n FROM resources WHERE kind='real-usage-receipt'").get().n,2);assert.equal(audit.prepare("SELECT count(*) AS n FROM resources WHERE kind='real-usage-index'").get().n,2);assert.equal(audit.prepare('SELECT count(*) AS n FROM commands').get().n,2);}finally{audit.close();}
  assert.equal(applied,20);assert.equal(f.usage.state(f.a).receiptCount,2);assert.equal(f.usage.state(f.a).items[0].useCount,2);
  assert.deepEqual(f.usage.query(f.a,{commandId:'after-0'}),{status:'untracked',commandId:'after-0',reason:'learning-saturated'});
  assert.equal(presentation(f,f.a,'one').replayed,true);assert.throws(()=>presentation(f,f.a,'one','changed'),{code:'command_conflict'});
 }finally{f.done();}
});
test('entry/event caps latch, sizes bound, prepare/apply/clock identity changes cannot commit',()=>{
 for(const options of [{maxEntries:1},{maxLearningEvents:1}]){const f=moduleFixture(options);try{presentation(f,f.a,'one');assert.equal(f.usage.state(f.a).learningSaturated,true);assert.equal(presentation(f,f.a,'two','different').receiptStored,false);assert.equal(f.usage.state(f.a).items.length,1);}finally{f.done();}}
 for(const stage of ['prepare','apply','clock']){
  const f=moduleFixture();try{
   if(stage==='clock'){const u=new RealUsageHistory(f.store,f.auth,{clock:()=>{f.auth.revoke('alice');return 100;}});assert.throws(()=>u.perform(f.a,'revoke',{}, {apply:()=>({target:{kind:'creature',targetId:'one'},qualifies:true,ack:{fact:'x'}})}),{code:'unauthenticated'});}
   else assert.throws(()=>presentation(f,f.a,'revoke','one',{[stage]:(...args)=>{f.auth.revoke('alice');if(stage==='prepare')return null;args[0].put('provisional','test',{value:1},0);return {target:{kind:'creature',targetId:'one'},qualifies:true,ack:{fact:'x'}};}}),{code:'unauthenticated'});
   const fresh=f.auth.authenticate('alice');assert.equal(f.usage.state(fresh).receiptCount,0);assert.equal(f.store.get('provisional'),null);
  }finally{f.done();}
 }
 const f=moduleFixture();try{assert.throws(()=>f.usage.perform(f.a,'large',{a:'x'.repeat(16000),b:'y'.repeat(1000)},{apply:()=>null}),{code:'usage_size_limit'});assert.equal(f.usage.state(f.a).receiptCount,0);assert.throws(()=>presentation(f,f.a,'huge-ack','session',{apply:tx=>{tx.put('temporary-write','test',{ok:true},0);return {target:{kind:'interaction-session',targetId:'session'},qualifies:true,ack:{a:'x'.repeat(16000),b:'y'.repeat(1000)}};}}),{code:'usage_size_limit'});assert.equal(f.store.get('temporary-write'),null);assert.equal(f.usage.state(f.a).receiptCount,0);}finally{f.done();}
});
function sceneFixture(usageOptions={}){
 const dir=mkdtempSync(join(tmpdir(),'scene-usage-'));let now=100,scene=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>now,usageOptions});
 return {get scene(){return scene;},time(v){now=v;},reopen(){scene.close();scene=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>now,usageOptions});},done(){scene.close();rmSync(dir,{recursive:true,force:true});}};
}
const select=(f,commandId,creatureId)=>f.scene.selectCreatureWithUsage({commandId,creatureId,context:f.scene.captureSenseContext()});
const program=compileInteractionProgram({schema:'temporary-interaction.v1',title:'Not an app or copied body',fields:[{id:'text',label:'Text',type:'text',required:false,maxLength:100}],save:{primitive:'local-draft.save'}});
function create(f,sessionId='session'){return f.scene.createInteraction({commandId:'create-'+sessionId,sessionId,context:f.scene.captureSenseContext(),program,source:{kind:'model-proposal',referenceId:'fixture-not-real-inference',modelId:'fixture'}});}
const report=(f,commandId,sessionId='session')=>{const view=f.scene.readInteraction({sessionId});return {commandId,sessionId,context:view.context,expectedRevision:view.revision,programDigest:view.program.programDigest,confirmation:'presented-explicitly'};};
test('default/seeds/legacy automatic selection/create/read/query never populate bar; explicit successful uses need threshold',()=>{
 const f=sceneFixture();try{
  assert.deepEqual(f.scene.usage().items,[]);f.scene.selectCreature({creatureId:'work'});f.scene.selectCreature({creatureId:'companion'});create(f);f.scene.currentInteraction();f.scene.readInteraction({sessionId:'session'});f.scene.queryInteraction({commandId:'create-session'});assert.deepEqual(f.scene.usage().items,[]);
  const once=report(f,'shown-one');f.scene.reportInteractionPresented(once);f.scene.reportInteractionPresented(once);assert.deepEqual(f.scene.usage().items,[]);
  const second=f.scene.reportInteractionPresented(report(f,'shown-two'));assert.equal(second.ack.usage.useCount,2);assert.deepEqual(f.scene.usage().items,[{kind:'interaction-session',targetId:'session',useCount:2,lastUsedAt:100,label:program.declaration.title}]);
  const before=f.scene.creature('companion').senses;select(f,'work1','work');select(f,'companion1','companion');select(f,'work2','work');assert.equal(f.scene.usage().items.some(i=>i.targetId==='work'),true);assert.deepEqual(f.scene.creature('companion').senses,before);
  assert.equal(f.scene.usage().items.some(i=>i.kind==='interaction-session'),false,'scene transition invalidates old session, history does not revive it');
 }finally{f.done();}
});
test('selection receipt and history atomic; stale context/ABA cannot act; saturated CAS works across restart',()=>{
 const f=sceneFixture({maxReceipts:2});try{
  const same=select(f,'same','companion');assert.equal(same.ack.changed,false);assert.equal(same.ack.usage.reason,'same-target');assert.equal(same.ack.context.sceneRevision,1);
  const input={commandId:'switch',creatureId:'work',context:f.scene.captureSenseContext()},r=f.scene.selectCreatureWithUsage(input);assert.equal(r.ack.context.sceneRevision,2);assert.equal(r.ack.usage.useCount,1);assert.equal(f.scene.usage().learningSaturated,true);
  f.reopen();assert.deepEqual(f.scene.selectCreatureWithUsage(input),{...r,replayed:true});
  const fresh={commandId:'untracked',creatureId:'companion',context:f.scene.captureSenseContext()},next=f.scene.selectCreatureWithUsage(fresh);assert.equal(next.receiptStored,false);assert.equal(next.ack.changed,true);
  assert.throws(()=>f.scene.selectCreatureWithUsage(fresh),{code:'sensory_context_changed'});
  select(f,'new-untracked','work');f.reopen();assert.throws(()=>f.scene.selectCreatureWithUsage(fresh),{code:'sensory_context_changed'});
  const changedUntracked=f.scene.selectCreatureWithUsage({commandId:'untracked',creatureId:'companion',context:f.scene.captureSenseContext()});assert.equal(changedUntracked.receiptStored,false);assert.equal(changedUntracked.ack.usage.recorded,false,'untracked IDs do not claim stored payload-conflict detection; fresh CAS is ordinary selection only');
  assert.equal(f.scene.queryUsage({commandId:'untracked'}).status,'untracked');assert.equal(f.scene.queryUsage({commandId:'switch'}).status,'completed');assert.deepEqual(f.scene.usage().items,[]);
  assert.throws(()=>f.scene.selectCreatureWithUsage({...input,creatureId:'companion'}),{code:'command_conflict'});
 }finally{f.done();}
});
test('presentation strict binding, only references, repeat fact remains queryable after close/expiry, notes unsupported',()=>{
 const f=sceneFixture();try{
  create(f);const p=report(f,'shown');
  for(const extra of [{ownerId:'other'},{useCount:99},{text:'body'},{noteId:'note'}])assert.throws(()=>f.scene.reportInteractionPresented({...p,...extra}),{code:'invalid_shape'});
  assert.throws(()=>f.scene.reportInteractionPresented({...p,expectedRevision:2}),{code:'usage_binding_changed'});assert.throws(()=>f.scene.reportInteractionPresented({...p,confirmation:'model says shown'}),{code:'usage_presentation_confirmation_required'});
  f.scene.reportInteractionPresented(p);f.scene.reportInteractionPresented(report(f,'twice'));assert.equal(f.scene.usage().items.length,1);
  f.scene.closeInteraction({commandId:'close',sessionId:'session',expectedRevision:1});assert.deepEqual(f.scene.usage().items,[]);assert.equal(f.scene.reportInteractionPresented(p).replayed,true);
  assert.throws(()=>f.scene.reportInteractionPresented({...p,commandId:'late'}),{code:'interaction_session_closed'});
  create(f,'second');const q=report(f,'second-once','second');f.scene.reportInteractionPresented(q);f.scene.reportInteractionPresented({...q,commandId:'second-twice'});f.time(300100);assert.deepEqual(f.scene.usage().items,[]);f.time(100);assert.throws(()=>f.scene.readInteraction({sessionId:'second'}),{code:'interaction_session_expired'});
  f.reopen();assert.equal(f.scene.queryUsage({commandId:'shown'}).status,'completed');
 }finally{f.done();}
});
test('actual loopback HTTP exposes strict bounded history APIs, not arbitrary usage logs',async()=>{
 const f=sceneFixture(),server=createSceneServer(f.scene);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=(path,body)=>fetch(base+'/scene/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});
 try{
  assert.deepEqual((await(await fetch(base+'/scene/usage')).json()).items,[]);
  const bad=await post('usage-select',{commandId:'bad',creatureId:'work',context:f.scene.captureSenseContext(),ownerId:'other'});assert.equal(bad.status,400);
  const req={commandId:'one',creatureId:'work',context:f.scene.captureSenseContext()},first=await(await post('usage-select',req)).json();assert.equal(first.ack.changed,true);assert.equal((await(await post('usage-select',req)).json()).replayed,true);
  assert.equal((await(await post('usage-query',{commandId:'one'})).json()).status,'completed');assert.equal((await post('usage-presented',{kind:'saved-note',targetId:'x'})).status,400);
 }finally{await new Promise(r=>server.close(r));f.done();}
});

const expiryProgram=compileInteractionProgram({schema:'temporary-interaction.v1',title:'review',fields:[{id:'text',label:'Text',type:'text',required:false,maxLength:100}],save:{primitive:'local-draft.save'}});
test('observed expiry during usage commit stays latched after clock rollback',()=>{
 const dir=mkdtempSync('/tmp/usage-extra-');let times=[],now=100;
 const scene=new SceneLab(dir+'/core',dir+'/sink',{clock:()=>times.length?times.shift():now});
 try {
 scene.createInteraction({commandId:'create',sessionId:'session',context:scene.captureSenseContext(),program:expiryProgram,source:{kind:'model-proposal',referenceId:'fixture',modelId:'fixture'}});
 const view=scene.readInteraction({sessionId:'session'});
 const req={commandId:'shown',sessionId:'session',context:view.context,expectedRevision:view.revision,programDigest:view.program.programDigest,confirmation:'presented-explicitly'};
 times=[100,view.expiresAt];
 assert.throws(()=>scene.reportInteractionPresented(req),{code:'interaction_session_expired'});
 assert.equal(scene.queryUsage({commandId:'shown'}).status,'not_started');
 now=100;
 assert.throws(()=>scene.readInteraction({sessionId:'session'}),{code:'interaction_session_expired'});
 }finally {scene.close();rmSync(dir,{recursive:true,force:true});}
});
