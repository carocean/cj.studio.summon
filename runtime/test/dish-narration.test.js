import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {HostIdentity} from '../../microkernel/src/identity.js';import {SnapshotStore} from '../../microkernel/src/store.js';
import {DishSession} from '../src/dish-session.js';import {DishNarration} from '../src/dish-narration.js';import {LocalVoice} from '../src/local-voice.js';
function wav(){const b=Buffer.alloc(3244);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);return b;}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,1));}throw Error('deadline');}
function fixture({synthesize,play,stop,timeoutMs=1000}={}){
 const dir=mkdtempSync(join(tmpdir(),'dish-narration-')),auth=new HostIdentity(),admin=auth.authenticate('host'),owner=auth.authenticate('alice'),other=auth.authenticate('bob'),store=new SnapshotStore(join(dir,'core'));let context={creatureId:'work',sceneRevision:1};const events=[];
 const sessions=new DishSession(store,auth,{administratorHandle:admin,currentContext:()=>context});sessions.installCatalog(admin,{schema:'synthetic-dish-catalog.v1',catalogId:'menu',items:[{dishId:'soup',name:'合成汤',description:'合成说明',imageRef:'synthetic-soup'},{dishId:'tea',name:'合成茶',description:null,imageRef:null}]});
 const player={play:async bytes=>{events.push('play');assert.ok(Buffer.isBuffer(bytes));await play?.();},stop:async()=>{events.push('stop');await stop?.();}};
 const synthesizer={synthesize:async input=>{events.push('synthesize');assert.equal(input.text,'合成汤');return synthesize?await synthesize(input):{audio:wav()};}};
 const narration=new DishNarration(sessions,auth,{administratorHandle:admin,synthesizer,player,timeoutMs});
 const create=(sessionId='meal')=>sessions.create(owner,{sessionId,taskId:'task-'+sessionId,catalogId:'menu',context});create();
 return {auth,admin,owner,other,sessions,player,synthesizer,narration,events,create,view:()=>sessions.read(owner,{sessionId:'meal'}),change:()=>{context={...context,sceneRevision:2};},start:()=>narration.start(owner,{sessionId:'meal',dishId:'soup',expectedRevision:1}),explain:()=>narration.requestExplanation(owner,{sessionId:'meal',expectedRevision:sessions.read(owner,{sessionId:'meal'}).revision}),close:async()=>{await narration.close(admin).catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('trusted synthesis/start then interrupted stop barrier produces same-dish details in real SQLite',async()=>{
 const stop=deferred();let blocked=false;const f=fixture({stop:()=>blocked?stop.promise:undefined});try{
  const started=await f.start();assert.equal(started.physicalPlaybackVerified,false);blocked=true;const pending=f.explain();await until(()=>f.events.includes('stop'));
  assert.equal(f.view().focus.speech.phase,'stop-required');assert.equal(f.view().focus.view,'none');stop.resolve();const result=await pending;
  assert.equal(result.focus.dishId,'soup');assert.equal(result.focus.taskId,'task-meal');assert.equal(result.focus.view,'details');assert.equal(result.presentation.description,'合成说明');assert.deepEqual(f.events,['synthesize','play','stop','stop']);
 }finally{stop.resolve();await f.close();}
});
test('late synthesis ignoring abort cannot play after explanation stop has completed',async()=>{
 const synth=deferred();const f=fixture({synthesize:()=>synth.promise});try{const pending=f.start();await until(()=>f.events.includes('synthesize'));const result=await f.explain();assert.equal(result.focus.view,'details');synth.resolve({audio:wav()});assert.equal((await pending).status,'cancelled');assert.equal(f.events.includes('play'),false);}finally{synth.resolve({audio:wav()});await f.close();}
});
test('in-flight play must settle and a final stop must complete before details',async()=>{
 const play=deferred();const f=fixture({play:()=>play.promise});try{const pending=f.start();await until(()=>f.events.includes('play'));const explained=f.explain();await until(()=>f.events.includes('stop'));assert.equal(f.view().focus.view,'none');assert.equal(f.events.filter(x=>x==='stop').length,1);play.resolve();assert.equal((await pending).status,'cancelled');assert.equal((await explained).focus.view,'details');assert.equal(f.events.filter(x=>x==='stop').length,2);}finally{play.resolve();await f.close();}
});
test('stop failure blocks presentation and new playback until explicit trusted cleanup succeeds',async()=>{
 let fail=true;const f=fixture({stop:()=>{if(fail)throw Error('adapter-stop-failed');}});try{await f.start();await assert.rejects(f.explain(),/adapter-stop-failed/);assert.equal(f.view().focus.speech.phase,'stop-required');assert.equal(f.view().focus.view,'none');await assert.rejects(f.start(),{code:'dish_narration_busy'});fail=false;await f.narration.cancel(f.admin);assert.equal(f.view().focus.speech.phase,'stop-required');}finally{fail=false;await f.close();}
});
test('stop timeout cannot confirm or release output channel',async()=>{
 const stop=deferred();const f=fixture({stop:()=>stop.promise,timeoutMs:20});try{await f.start();await assert.rejects(f.explain(),{code:'dish_narration_timeout'});await assert.rejects(f.start(),{code:'dish_narration_busy'});assert.equal(f.view().focus.view,'none');stop.resolve();await f.narration.cancel(f.admin);}finally{stop.resolve();await f.close();}
});
test('revocation while synthesizing prevents play and still performs safety stop',async()=>{
 const synth=deferred();const f=fixture({synthesize:()=>synth.promise});try{const pending=f.start();const checked=assert.rejects(pending,{code:'unauthenticated'});f.auth.revoke('alice');synth.resolve({audio:wav()});await checked;assert.equal(f.events.includes('play'),false);assert.ok(f.events.includes('stop'));await f.narration.cancel(f.admin);}finally{synth.resolve({audio:wav()});await f.close();}
});
test('context change during stop cannot authorize details, but safety stop still settles',async()=>{
 const stop=deferred();const f=fixture({stop:()=>stop.promise});try{await f.start();const p=f.explain();const checked=assert.rejects(p,{code:'dish_context_changed'});f.change();stop.resolve();await checked;await f.narration.cancel(f.admin);}finally{stop.resolve();await f.close();}
});
test('trusted cancellation merges pending stops and prevents stale confirmation',async()=>{
 const stop=deferred();const f=fixture({stop:()=>stop.promise});try{await f.start();const p=f.explain();const checked=assert.rejects(p,{code:'dish_narration_cancelled'});const cancel=f.narration.cancel(f.admin);await until(()=>f.events.includes('stop'));assert.equal(f.events.filter(x=>x==='stop').length,1);stop.resolve();await Promise.all([checked,cancel]);assert.equal(f.view().focus.view,'none');f.create('next');await f.narration.start(f.owner,{sessionId:'next',dishId:'soup',expectedRevision:1});assert.equal(f.events.filter(x=>x==='stop').length,2);}finally{stop.resolve();await f.close();}
});
test('shared player has one owner; hostile inputs and foreign cancellation do not alter active work',async()=>{
 const f=fixture();try{await f.start();const another=new DishNarration(f.sessions,f.auth,{administratorHandle:f.admin,synthesizer:f.synthesizer,player:f.player});await assert.rejects(another.start(f.owner,{sessionId:'meal',dishId:'soup',expectedRevision:2}),{code:'dish_narration_busy'});await assert.rejects(f.narration.cancel(f.other),{code:'dish_host_authority_required'});assert.equal(f.view().focus.speech.phase,'playback-requested');await f.narration.close(f.admin);await assert.rejects(f.start(),{code:'dish_narration_closed'});}finally{await f.close();}
});
test('invalid audio never enters playback and reserves stop/explanation transitions',async()=>{
 const f=fixture({synthesize:async()=>({audio:Buffer.alloc(2)})});try{await assert.rejects(f.start(),{code:'invalid_voice_audio'});assert.equal(f.events.includes('play'),false);assert.equal((await f.explain()).focus.view,'details');let v=f.view();while(v.revision<253){f.sessions.command(f.owner,{sessionId:'meal',command:{kind:'details',expectedRevision:v.revision}});v=f.view();}await assert.rejects(f.narration.start(f.owner,{sessionId:'meal',dishId:'soup',expectedRevision:253}),{code:'dish_narration_transition_capacity'});assert.equal(f.view().revision,253);}finally{await f.close();}
});
test('opt-in actual offline TTS feeds controlled synthetic player, not a sound-card claim',{skip:process.env.DISH_REAL_TTS!=='1'},async()=>{
 const voice=new LocalVoice();let bytes=0;const f=fixture({synthesize:input=>voice.synthesize(input),play:()=>{bytes++;},timeoutMs:30000});try{const result=await f.start();assert.equal(result.physicalPlaybackVerified,false);assert.equal(bytes,1);assert.equal((await f.explain()).focus.view,'details');}finally{await f.close();}
});

test('timed out stop remains the shared barrier; retry cannot unlock around its late completion',async()=>{
 const first=deferred();let calls=0;const f=fixture({stop:()=>++calls===1?first.promise:undefined,timeoutMs:15});try{
  await f.start();await assert.rejects(f.explain(),{code:'dish_narration_timeout'});
  await assert.rejects(f.narration.cancel(f.admin),{code:'dish_narration_timeout'});assert.equal(calls,1);
  await assert.rejects(f.start(),{code:'dish_narration_busy'});
  first.resolve();await f.narration.cancel(f.admin);assert.equal(calls,2);
  f.create('next');await f.narration.start(f.owner,{sessionId:'next',dishId:'soup',expectedRevision:1});assert.equal(calls,2);
 }finally{first.resolve();await f.close();}
});

test('already-observed revocation or stale context still stops active output without business confirmation',async()=>{
 for(const revoke of [false,true]){
  const f=fixture();try{await f.start();if(revoke)f.auth.revoke('alice');else f.change();
   await assert.rejects(f.narration.requestExplanation(f.owner,{sessionId:'meal',expectedRevision:2}),{code:revoke?'unauthenticated':'dish_context_changed'});
   assert.ok(f.events.includes('stop'));await f.narration.cancel(f.admin);
  }finally{await f.close();}
 }
});
test('SceneLab host factory runs narration chain and requires explicit retirement before context change or close',async()=>{
 const {SceneLab}=await import('../src/scene.js');const dir=mkdtempSync(join(tmpdir(),'dish-narration-scene-'));let lab,narrator;
 try{lab=new SceneLab(join(dir,'core'),join(dir,'sink'));
  lab.installDishCatalog({schema:'synthetic-dish-catalog.v1',catalogId:'menu',items:[{dishId:'soup',name:'合成汤',description:'说明',imageRef:'synthetic-soup'}]});lab.createDishSession({sessionId:'meal',taskId:'task-meal',catalogId:'menu',context:lab.captureSenseContext()});
  narrator=lab.createDishNarration({synthesizer:{synthesize:async()=>({audio:wav()})},player:{play:async()=>{},stop:async()=>{}}});
  await narrator.start({sessionId:'meal',dishId:'soup',expectedRevision:1});
  assert.throws(()=>lab.selectCreature({creatureId:'work'}),{code:'dish_narration_retire_required'});assert.throws(()=>lab.selectCreatureWithUsage({commandId:'switch',creatureId:'work',context:lab.captureSenseContext()}),{code:'dish_narration_retire_required'});assert.equal(lab.captureSenseContext().creatureId,'companion');assert.throws(()=>lab.close(),{code:'dish_narration_retire_required'});
  assert.equal((await narrator.requestExplanation({sessionId:'meal',expectedRevision:2})).focus.view,'details');await narrator.close();lab.selectCreature({creatureId:'work'});lab.close();
 }finally{await narrator?.close();lab?.close();rmSync(dir,{recursive:true,force:true});}
});

test('new same-principal administrator can safely retire after old admin revocation without restoring business authority',async()=>{
 const f=fixture();let replacement;
 try{await f.start();f.auth.revoke('host');replacement=f.auth.authenticate('host');
  await assert.rejects(f.explain(),{code:'unauthenticated'});assert.equal(f.view().focus.view,'none');
  await f.narration.close(replacement);assert.ok(f.events.includes('stop'));
  await assert.rejects(f.start(),{code:'dish_narration_closed'});
 }finally{if(replacement)await f.narration.close(replacement);await f.close();}
});
test('synchronous abort reentry cannot inherit a newer cancel generation and confirm details',async()=>{
 const synth=deferred();let f,cancel;
 f=fixture({synthesize:({signal})=>{signal.addEventListener('abort',()=>{cancel=f.narration.cancel(f.admin);},{once:true});return synth.promise;}});
 try{const pending=f.start();await until(()=>f.events.includes('synthesize'));await assert.rejects(f.explain(),{code:'dish_narration_cancelled'});await cancel;synth.resolve({audio:wav()});assert.equal((await pending).status,'cancelled');assert.equal(f.view().focus.view,'none');assert.equal(f.events.includes('play'),false);}finally{synth.resolve({audio:wav()});await f.close();}
});

test('synchronous stop callback reentry shares an already-installed stop barrier',async()=>{
 const first=deferred();let f,nested,calls=0;
 f=fixture({stop:()=>{calls++;if(calls===1){nested=f.narration.cancel(f.admin);return first.promise;}}});
 try{await f.start();const explained=f.explain();const checked=assert.rejects(explained,{code:'dish_narration_cancelled'});await until(()=>calls===1);await assert.rejects(f.start(),{code:'dish_narration_busy'});assert.equal(calls,1);first.resolve();await Promise.all([checked,nested]);assert.equal(calls,2);assert.equal(f.view().focus.view,'none');}finally{first.resolve();await f.close();}
});
