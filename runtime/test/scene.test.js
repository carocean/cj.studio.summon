import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SceneLab} from '../src/scene.js';
import {createSceneServer} from '../src/scene-server.js';
import {SnapshotStore} from '../../microkernel/src/store.js';
import {syntheticInput} from '../../microkernel/src/permits.js';
import {canonical} from '../../microkernel/src/canonical.js';
const values={customerAlias:'demo-a',accountType:'savings',contactPreference:'none'};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'scene-lab-'));let lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));return {dir,get lab(){return lab;},reopen(){lab.close();lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));},done(){lab.close();rmSync(dir,{recursive:true});}};}
test('synthetic hearing/vision drives creature and structured scene, not execution; closed view survives restart',()=>{
 const f=fixture();try{
  assert.equal(f.lab.state().activeCreatureId,'companion');assert.equal(f.lab.state().activity,null);
  f.lab.perceive({modality:'vision',signal:'work-context'});assert.equal(f.lab.state().activeCreatureId,'work');
  const s=f.lab.perceive({modality:'hearing',signal:'account-request'});assert.equal(s.activity.form.fields.length,3);assert.equal(s.activity.receipt,null);
  f.lab.update({activityId:f.lab.state().activity.id,expectedRevision:1,values});f.lab.visibility(false,{activityId:'task-1'});f.reopen();
  assert.equal(f.lab.state().activity.sceneVisible,false);assert.equal(f.lab.state().activity.form.fields[1].value,'savings');
  f.lab.perceive({modality:'vision',signal:'personal-context'});assert.equal(f.lab.state().activeCreatureId,'companion');
  assert.throws(()=>f.lab.submit({activityId:f.lab.state().activity.id,expectedRevision:2}),{code:'work_context_required'});
  f.lab.perceive({modality:'hearing',signal:'work-context'});assert.equal(f.lab.state().activity.sceneVisible,false);
  const result=f.lab.submit({activityId:f.lab.state().activity.id,expectedRevision:2});assert.equal(result.activity.status,'completed');assert.equal(result.activity.sceneVisible,false);
  assert.equal(result.activity.receipt.mode,'simulation-only');assert.equal(result.activity.receipt.level,'observation_confirmed');
  f.reopen();assert.equal(f.lab.submit({activityId:f.lab.state().activity.id,expectedRevision:2}).activity.status,'completed');
  f.lab.visibility(true,{activityId:'task-1'});assert.equal(f.lab.state().activity.form.fields[1].value,'savings');
  f.lab.close();const store=new SnapshotStore(join(f.dir,'core.sqlite'));
  assert.equal(store.get('grant.task-1-r2').value.spent.calls,3);assert.equal(store.get('allocation.task-1-r2').value.settled,1);
  assert.deepEqual(store.get('activity.task-1-r2').value.input.form,values);store.close();
 }finally{f.done();}
});
test('scene snapshots, revision checks and closed schema prevent stale edits or private free text',()=>{
 const f=fixture();try{
  f.lab.perceive({modality:'hearing',signal:'account-request'});
  assert.throws(()=>{f.lab.state().creatures[0].name='changed';},TypeError);
  assert.throws(()=>f.lab.update({activityId:f.lab.state().activity.id,expectedRevision:1,values:{...values,customerAlias:'Actual customer'}}),{code:'invalid_synthetic_field'});
  assert.throws(()=>f.lab.submit({activityId:f.lab.state().activity.id,expectedRevision:1}));assert.equal(f.lab.state().activity.status,'draft');
  f.lab.update({activityId:f.lab.state().activity.id,expectedRevision:1,values});assert.throws(()=>f.lab.update({activityId:f.lab.state().activity.id,expectedRevision:1,values}),{code:'revision_conflict'});
  f.lab.submit({activityId:f.lab.state().activity.id,expectedRevision:2});assert.throws(()=>f.lab.update({activityId:f.lab.state().activity.id,expectedRevision:3,values}),{code:'task_not_editable'});
  assert.throws(()=>syntheticInput(canonical({scenario:'synthetic-form',synthetic:true,form:{...values,signature:true}})),{code:'invalid_shape'});
 }finally{f.done();}
});
test('actual loopback HTTP links perception, form revision, kernel effect and persisted hidden view',async()=>{
 const f=fixture(),server=createSceneServer(f.lab);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic',...headers},body:JSON.stringify(body)});
 try{
  assert.equal((await fetch(base+'/scene/state')).status,200);
  assert.equal((await post('/scene/perceive',{modality:'hearing',signal:'account-request'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await post('/scene/perceive',{modality:'hearing',signal:'account-request'},{'X-Summon-Lab':'wrong'})).status,403);
  assert.equal(f.lab.state().activity,null);
  assert.equal((await post('/scene/perceive',{modality:'hearing',signal:'account-request'})).status,200);
  assert.equal((await post('/scene/update',{activityId:'task-1',expectedRevision:1,values})).status,200);
  assert.equal((await post('/scene/update',{activityId:'task-1',expectedRevision:1,values})).status,409);
  await post('/scene/hide',{activityId:'task-1'});const result=await(await post('/scene/submit',{activityId:'task-1',expectedRevision:2})).json();
  assert.equal(result.activity.status,'completed');assert.equal(result.activity.sceneVisible,false);
  const repeated=await(await post('/scene/submit',{activityId:'task-1',expectedRevision:2})).json();assert.equal(repeated.activity.receipt.activityId,result.activity.receipt.activityId);
  const cors=await fetch(base+'/scene/state',{headers:{Origin:'http://localhost:9876'}});assert.equal(cors.headers.get('access-control-allow-origin'),'http://localhost:9876');
 }finally{await new Promise(resolve=>server.close(resolve));f.done();}
});

test('interrupted submission expires explicitly; cancellation/new task do not revive old authority',()=>{
 const dir=mkdtempSync(join(tmpdir(),'scene-expiry-'));let count=0,lab;
 try{
  lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'),{clock:()=>{if(++count===2)throw new Error('simulated_interruption');return 100;}});
  lab.perceive({modality:'hearing',signal:'account-request'});lab.update({activityId:lab.state().activity.id,expectedRevision:1,values});
  assert.throws(()=>lab.submit({activityId:lab.state().activity.id,expectedRevision:2}),/simulated_interruption/);assert.equal(lab.state().activity.status,'submitting');
  lab.close();lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'),{clock:()=>86400200});
  assert.equal(lab.submit({activityId:lab.state().activity.id,expectedRevision:2}).activity.status,'expired');
  assert.equal(lab.newTask({previousActivityId:lab.state().activity?.id??null}).activity.id,'task-2');assert.equal(lab.state().activity.status,'draft');
  lab.cancel({activityId:lab.state().activity.id});assert.equal(lab.state().activity.status,'cancelled');assert.equal(lab.newTask({previousActivityId:lab.state().activity?.id??null}).activity.id,'task-3');
  lab.update({activityId:lab.state().activity.id,expectedRevision:1,values});lab.submit({activityId:lab.state().activity.id,expectedRevision:2});assert.equal(lab.newTask({previousActivityId:lab.state().activity?.id??null}).activity.id,'task-4');
  lab.close();const store=new SnapshotStore(join(dir,'core.sqlite'));
  assert.equal(store.get('scene-history.task-1').value.status,'expired');assert.equal(store.get('scene-history.task-3').value.status,'completed');store.close();
 }finally{lab?.close();rmSync(dir,{recursive:true});}
});

test('old task messages cannot edit, submit, hide, cancel or replace a newer task with matching revision',()=>{
 const f=fixture();try{
  f.lab.perceive({modality:'hearing',signal:'account-request'});f.lab.update({activityId:'task-1',expectedRevision:1,values});
  const oldSubmit={activityId:'task-1',expectedRevision:2};f.lab.submit(oldSubmit);
  f.lab.newTask({previousActivityId:'task-1'});f.lab.update({activityId:'task-2',expectedRevision:1,values:{...values,customerAlias:'demo-b'}});
  for(const call of [()=>f.lab.submit(oldSubmit),()=>f.lab.update({activityId:'task-1',expectedRevision:2,values}),()=>f.lab.cancel({activityId:'task-1'}),()=>f.lab.visibility(false,{activityId:'task-1'}),()=>f.lab.newTask({previousActivityId:'task-1'})])assert.throws(call,{code:'activity_conflict'});
  assert.equal(f.lab.state().activity.id,'task-2');assert.equal(f.lab.state().activity.status,'draft');assert.equal(f.lab.state().activity.sceneVisible,true);
  assert.equal(f.lab.state().activity.form.fields[0].value,'demo-b');assert.equal(f.lab.state().activity.receipt,null);
 }finally{f.done();}
});

test('creature presentation follows persistent context and hides work surface without deleting task',()=>{
 const f=fixture();try{
  let p=f.lab.state().presentation;assert.equal(p.body,'sprout');assert.equal(p.surface,'none');
  f.lab.perceive({modality:'hearing',signal:'account-request'});p=f.lab.state().presentation;
  assert.equal(p.creatureId,'work');assert.equal(p.body,'owl');assert.equal(p.surface,'synthetic-account');
  f.lab.update({activityId:'task-1',expectedRevision:1,values});
  f.lab.perceive({modality:'vision',signal:'personal-context'});p=f.lab.state().presentation;
  assert.equal(p.body,'sprout');assert.equal(p.surface,'task-summary');assert.equal(p.activityId,'task-1');
  f.reopen();assert.equal(f.lab.state().presentation.surface,'task-summary');
  f.lab.perceive({modality:'hearing',signal:'work-context'});assert.equal(f.lab.state().presentation.surface,'synthetic-account');
  f.lab.visibility(false,{activityId:'task-1'});assert.equal(f.lab.state().presentation.surface,'task-summary');
  assert.equal(f.lab.state().activity.form.fields[0].value,'demo-a');
 }finally{f.done();}
});

test('actual HTTP registry adds a pet, changes primary independently, controls senses and preserves task',async()=>{
 const f=fixture(),server=createSceneServer(f.lab);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(action,body)=>{const response=await fetch(base+'/scene/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
 try{
  f.lab.perceive({modality:'hearing',signal:'account-request'});const task=f.lab.state().activity.id;
  const definition={id:'pet-http',name:'小芽',kind:'pet',personality:'好奇',body:'sprout',tone:'playful'};
  assert.equal((await post('creature-create',{...definition,ownerId:'someone-else'})).status,400);
  const added=await post('creature-create',definition);assert.equal(added.status,200);assert.equal(added.value.creatures.length,3);assert.equal(added.value.creatures[2].senses.hearing,false);
  const primary=await post('creature-primary',{creatureId:definition.id,expectedRevision:added.value.registryRevision});assert.equal(primary.value.primaryCreatureId,definition.id);assert.equal(primary.value.activeCreatureId,'work');
  assert.equal((await post('creature-primary',{creatureId:'work',expectedRevision:added.value.registryRevision})).status,409);
  const grant=await post('creature-sense',{creatureId:definition.id,modality:'hearing',enabled:true,expectedRevision:primary.value.registryRevision});assert.equal(grant.value.creatures[2].senses.hearing,true);assert.equal(grant.value.creatures[2].senses.vision,false);
  const selected=await post('creature-select',{creatureId:definition.id});assert.equal(selected.value.presentation.creatureId,definition.id);assert.equal(selected.value.presentation.body,'sprout');assert.equal(selected.value.activity.id,task);
  const revision=f.lab.captureSenseContext().sceneRevision;await post('creature-select',{creatureId:definition.id});assert.equal(f.lab.captureSenseContext().sceneRevision,revision);
  assert.equal((await post('creature-select',{creatureId:'missing'})).status,400);
 }finally{await new Promise(r=>server.close(r));f.reopen();assert.equal(f.lab.state().primaryCreatureId,'pet-http');assert.equal(f.lab.state().activeCreatureId,'pet-http');assert.equal(f.lab.creature('pet-http').senses.hearing,true);f.done();}
});
