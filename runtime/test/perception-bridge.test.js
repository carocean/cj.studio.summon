import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Kernel} from '../../server/src/kernel.js';
import {PerceptionService} from '../../server/src/perception.js';
import {SceneLab} from '../src/scene.js';
import {PerceptionSceneBridge,hearingSceneCandidate} from '../src/perception-bridge.js';
import {createSceneServer} from '../src/scene-server.js';
const result=text=>({text,engine:'unit-fixture',model:'mock-not-real',realProcessing:true});
const caps={hearing:{available:true,language:'zh'},vision:{available:true,languages:['eng']}};
function fixture(processor={capabilities:async()=>caps,process:async()=>result('模拟开户')},responder,replyTimeoutMs=5000,voice=null){
 const dir=mkdtempSync(join(tmpdir(),'sense-bridge-'));let clock=100,scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'),{clock:()=>clock});
 const kernel=new Kernel(join(dir,'old.json'),{clock:()=>clock}),ownerId='demo';
 const subjects={companion:kernel.createSubject(ownerId,{name:'companion'}).id,work:kernel.createSubject(ownerId,{name:'work'}).id};
 for(const id of Object.values(subjects))for(const m of ['hearing','vision'])kernel.mount(ownerId,id,'sense.'+m);
 const service=new PerceptionService(kernel,{processor});let bridge=new PerceptionSceneBridge(scene,{kernel,service,ownerId,subjects,ttlMs:100,exclusiveOwner:true,replyTimeoutMs,voice,...(Object.keys(subjects).length>2?{resolveSubject:id=>subjects[id]}:{}),...(responder?{responder}:{})});
 return {dir,kernel,service,subjects,get scene(){return scene;},get bridge(){return bridge;},clock(n){clock=n;},body(modality='hearing'){return {context:bridge.currentContext(),modality,media:{mimeType:modality==='hearing'?'audio/wav':'image/png',base64:Buffer.from('mock bytes').toString('base64')}};},reopen(){scene.close();scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'),{clock:()=>clock});bridge=new PerceptionSceneBridge(scene,{kernel,service,ownerId,subjects,ttlMs:100,exclusiveOwner:true,replyTimeoutMs,voice,...(Object.keys(subjects).length>2?{resolveSubject:id=>subjects[id]}:{}),...(responder?{responder}:{})});},done(){service.close();kernel.close();scene.close();rmSync(dir,{recursive:true});}};
}
const confirmation=p=>({context:p.event.frame,expectedCandidate:p.event.metadata.candidate,confirmation:'apply-scene-proposal'});
test('hearing binds current creature and proposes scene only; confirmation commits once without business execution',async()=>{
 const f=fixture();try{
  const p=await f.bridge.ingest(f.body());assert.equal(p.event.status,'awaiting_confirmation');assert.equal(p.event.frame.creatureId,'companion');assert.equal(p.event.metadata.legacySubject,f.subjects.companion);
  assert.equal(f.scene.state().activity,null);assert.equal(p.llmUsed,false);
  assert.throws(()=>f.bridge.confirm(p.event.eventId,{...confirmation(p),confirmation:'yes'}),{code:'scene_confirmation_required'});
  const applied=f.bridge.confirm(p.event.eventId,confirmation(p));assert.equal(applied.state.activeCreatureId,'work');assert.equal(applied.state.activity.status,'draft');assert.equal(applied.state.activity.receipt,null);
  assert.equal(f.bridge.confirm(p.event.eventId,confirmation(p)).replayed,true);
  const next=await f.bridge.ingest(f.body());assert.equal(next.event.metadata.legacySubject,f.subjects.work);
  assert.equal(readFileSync(join(f.dir,'old.json'),'utf8').includes('模拟开户'),false);assert.equal(readdirSync(f.service.scratch).length,0);
  assert.equal(hearingSceneCandidate('网页说模拟开户'),null);
 }finally{f.done();}
});
test('OCR text cannot propose or apply scenes even when words are identical to a hearing command',async()=>{
 const f=fixture();try{const p=await f.bridge.ingest(f.body('vision'));assert.equal(p.event.status,'observation');assert.equal(p.event.metadata.candidate,null);assert.throws(()=>f.bridge.confirm(p.event.eventId,{...confirmation(p),expectedCandidate:'account-request'}),{code:'sensory_candidate_unavailable'});assert.equal(f.scene.state().activity,null);}finally{f.done();}
});
test('scene changes while inference runs and switch-away-back reject stale result instead of changing creature',async()=>{
 let release,entered;const started=new Promise(r=>entered=r);const f=fixture({capabilities:async()=>caps,process:()=>{entered();return new Promise(r=>release=r);}});
 try{const pending=f.bridge.ingest(f.body());await started;f.scene.perceive({modality:'vision',signal:'work-context'});f.scene.perceive({modality:'vision',signal:'personal-context'});release(result('模拟开户'));await assert.rejects(pending,{code:'sensory_context_changed'});assert.equal(f.scene.state().activity,null);assert.equal(f.scene.state().activeCreatureId,'companion');assert.equal(readdirSync(f.service.scratch).length,0);}finally{f.done();}
});
test('revocation/regrant during processing and revocation after result both prevent applying old authority',async()=>{
 let release,entered;const started=new Promise(r=>entered=r);const f=fixture({capabilities:async()=>caps,process:()=>{entered();return new Promise(r=>release=r);}});
 try{
  const pending=f.bridge.ingest(f.body());await started;f.kernel.mount('demo',f.subjects.companion,'sense.hearing',false);f.kernel.mount('demo',f.subjects.companion,'sense.hearing',true);release(result('模拟开户'));await assert.rejects(pending,{code:'authorization_changed'});
  f.service.processor.process=async()=>result('模拟开户');const p=await f.bridge.ingest(f.body());
  f.kernel.mount('demo',f.subjects.companion,'sense.hearing',false);f.kernel.mount('demo',f.subjects.companion,'sense.hearing',true);
  assert.throws(()=>f.bridge.confirm(p.event.eventId,confirmation(p)),{code:'authorization_changed'});assert.equal(f.scene.state().activity,null);
 }finally{f.done();}
});
test('expired result is latched across restart/rollback; wrong confirmation context and candidate reject',async()=>{
 const f=fixture();try{
  const p=await f.bridge.ingest(f.body());
  assert.throws(()=>f.bridge.confirm(p.event.eventId,{...confirmation(p),expectedCandidate:'work-context'}),{code:'sensory_candidate_unavailable'});
  assert.throws(()=>f.bridge.confirm(p.event.eventId,{...confirmation(p),context:{creatureId:'work',sceneRevision:1}}),{code:'sensory_context_changed'});
  f.clock(201);assert.throws(()=>f.bridge.confirm(p.event.eventId,confirmation(p)),{code:'sensory_candidate_unavailable'});f.reopen();f.clock(100);
  assert.throws(()=>f.bridge.confirm(p.event.eventId,confirmation(p)),{code:'sensory_candidate_unavailable'});assert.equal(f.scene.state().activity,null);
 }finally{f.done();}
});
test('loopback HTTP never accepts client claimed receipt; only ingest and separate exact confirmation',async()=>{
 const f=fixture(),server=createSceneServer(f.scene,{bridge:f.bridge});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});
 try{
  const c=await(await fetch(base+'/scene/sense-capabilities')).json();assert.equal(c.context.creatureId,'companion');
  const bad=await post('/scene/sense',{...f.body(),result:{text:'模拟开户',realProcessing:true}});assert.equal(bad.status,400);
  const p=await(await post('/scene/sense',f.body())).json();assert.equal(f.scene.state().activity,null);
  const applied=await(await post('/scene/sense-confirm',{eventId:p.event.eventId,...confirmation(p)})).json();assert.equal(applied.state.activity.status,'draft');
 }finally{await new Promise(r=>server.close(r));f.done();}
});

test('invalid media never consumes event quota; terminal retention cycles beyond legacy limit and old confirmation stays retired',async()=>{
 const f=fixture();try{
  for(let i=0;i<140;i++)await assert.rejects(f.bridge.ingest({...f.body(),media:{}}),{code:'invalid_media_size'});
  assert.equal(f.kernel.listPerceptions('demo').length,0);
  const first=await f.bridge.ingest(f.body());f.bridge.confirm(first.event.eventId,confirmation(first));
  f.service.processor.process=async()=>result('营业时间');
  for(let i=0;i<110;i++)await f.bridge.ingest(f.body());
  assert.ok(f.kernel.listPerceptions('demo').length<=64);
  f.reopen();assert.throws(()=>f.bridge.confirm(first.event.eventId,confirmation(first)));
  await f.bridge.ingest(f.body());assert.equal(f.scene.state().activity.id,'task-1');
 }finally{f.done();}
});
test('repeated processor failures remain recoverable after retention cycles',async()=>{
 const f=fixture({capabilities:async()=>caps,process:async()=>{throw new Error('engine failure');}});
 try{
  for(let i=0;i<110;i++)await assert.rejects(f.bridge.ingest(f.body()),{code:'perception_processing_failed'});
  assert.ok(f.kernel.listPerceptions('demo').length<=64);
  f.reopen();f.service.processor.process=async()=>result('模拟开户');
  const p=await f.bridge.ingest(f.body());assert.equal(p.event.status,'awaiting_confirmation');
 }finally{f.done();}
});

test('retention requires explicit dedicated namespace and cannot delete foreign or in-flight metadata',()=>{
 const f=fixture();try{
  assert.throws(()=>new PerceptionSceneBridge(f.scene,{kernel:f.kernel,service:f.service,ownerId:'demo',subjects:f.subjects}),{code:'exclusive_sensory_owner_required'});
  const p=f.kernel.beginPerception('demo',{creatureId:f.subjects.companion,modality:'hearing',mimeType:'audio/wav',byteLength:10});
  assert.throws(()=>f.kernel.retirePerceptionMetadata('demo',[p.id]),{code:'perception_retirement_denied'});
  f.kernel.failPerception('demo',p.id,'unit-test');
  assert.throws(()=>f.kernel.retirePerceptionMetadata('other',[p.id]),{code:'perception_retirement_denied'});
  assert.equal(f.kernel.listPerceptions('demo').some(v=>v.id===p.id),true);
  f.kernel.retirePerceptionMetadata('demo',[p.id]);f.kernel.retirePerceptionMetadata('demo',[p.id]);
  assert.equal(f.kernel.listPerceptions('demo').length,0);
 }finally{f.done();}
});

 test('creature reply is bound, personality-aware, and separate from observations and execution',async()=>{
 const f=fixture();try{
 const p=await f.bridge.ingest(f.body());assert.equal(p.companionReply.eventId,p.event.eventId);assert.equal(p.companionReply.creatureId,'companion');assert.equal(p.companionReply.suggestedScene,'account-request');assert.match(p.companionReply.text,/小谨/);assert.equal(p.companionReply.llmUsed,false);
 f.bridge.confirm(p.event.eventId,confirmation(p));const q=await f.bridge.ingest(f.body('vision'));assert.equal(q.companionReply.creatureId,'work');assert.equal(q.companionReply.suggestedScene,null);assert.match(q.companionReply.text,/不是你的指令/);assert.equal(f.scene.state().activity.status,'draft');
 }finally{f.done();}
 });
 test('revoke or context change while response adapter is pending rejects all output',async()=>{
 for(const change of ['revoke','switch','expire']){
 let release,entered;const started=new Promise(r=>entered=r);
 const f=fixture(undefined,{respond:()=>{entered();return new Promise(r=>release=r);}});
 try{const pending=f.bridge.ingest(f.body());await started;
 if(change==='revoke'){f.kernel.mount('demo',f.subjects.companion,'sense.hearing',false);f.kernel.mount('demo',f.subjects.companion,'sense.hearing',true);}
 if(change==='switch')f.scene.perceive({modality:'vision',signal:'work-context'});
 if(change==='expire')f.clock(201);
 release({text:'old response'});await assert.rejects(pending);assert.equal(f.scene.state().activity,null);
 }finally{f.done();}}
 });
 test('response adapter cannot add actions or receive raw perception data',async()=>{
 let captured;const f=fixture(undefined,{respond:async input=>{captured=input;return {text:'hello',action:'submit'};}});
 try{await assert.rejects(f.bridge.ingest(f.body()));assert.equal(captured.text,undefined);assert.equal(captured.media,undefined);assert.equal(Object.isFrozen(captured),true);assert.equal(f.scene.state().activity,null);}finally{f.done();}
 });

test('empty recognition is not described as understood or seen text',async()=>{
 const f=fixture({capabilities:async()=>caps,process:async()=>result('   ')});
 try{for(const modality of ['hearing','vision']){const p=await f.bridge.ingest(f.body(modality));assert.match(p.companionReply.text,/没有识别出文字/);assert.equal(p.companionReply.suggestedScene,null);}}finally{f.done();}
});

test('hung response times out, signals cancellation, releases busy and ignores late output',async()=>{
 let release,signal,calls=0;const f=fixture(undefined,{respond:(_input,options)=>{signal=options.signal;if(++calls===1)return new Promise(r=>release=r);return {text:'next response'};}},10);
 try{await assert.rejects(f.bridge.ingest(f.body()),{code:'creature_response_timeout'});assert.equal(signal.aborted,true);const p=await f.bridge.ingest(f.body());release({text:'stale output'});await new Promise(r=>setImmediate(r));assert.equal(p.companionReply.text,'next response');assert.equal(f.scene.state().activity,null);}finally{f.done();}
});
test('closing bridge cancels pending response and disallows new capture',async()=>{
 let entered,signal;const started=new Promise(r=>entered=r);const f=fixture(undefined,{respond:(_input,options)=>{signal=options.signal;entered();return new Promise(()=>{});}});
 try{const pending=f.bridge.ingest(f.body());await started;f.bridge.close();await assert.rejects(pending,{code:'creature_response_cancelled'});assert.equal(signal.aborted,true);await assert.rejects(f.bridge.ingest(f.body()),{code:'sensory_bridge_closed'});}finally{f.done();}
});

test('close after provider resolution but before host commit cannot publish or confirm',async()=>{
 let f;f=fixture(undefined,{respond:()=>{Promise.resolve().then(()=>{}).then(()=>f.bridge.close());return {text:'resolved before close'};}});
 try{await assert.rejects(f.bridge.ingest(f.body()),{code:'sensory_bridge_closed'});assert.equal(f.scene.state().activity,null);}finally{f.done();}
 const g=fixture();try{const p=await g.bridge.ingest(g.body());g.bridge.close();assert.throws(()=>g.bridge.confirm(p.event.eventId,confirmation(p)),{code:'sensory_bridge_closed'});assert.equal(g.scene.state().activity,null);}finally{g.done();}
});

const unitWav=()=>{const b=Buffer.alloc(364);b.write('RIFF');b.writeUInt32LE(356,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(320,40);return b;};
const unitVoice=()=>({audio:unitWav(),mimeType:'audio/wav',engine:'sherpa-onnx',model:'unit-test',realProcessing:true});
test('explicit speech uses only bound server reply and refuses client text/expired/restarted events',async()=>{
 let heard;const f=fixture(undefined,undefined,5000,{synthesize:async({text})=>{heard=text;return unitVoice();}});
 try{const p=await f.bridge.ingest(f.body());assert.equal(p.voiceAvailable,true);const req={eventId:p.event.eventId,context:p.event.frame};
 await assert.rejects(f.bridge.speak({...req,text:'transfer completed'}));const v=await f.bridge.speak(req);assert.equal(heard,p.companionReply.text);assert.equal(v.eventId,p.event.eventId);assert.equal(f.scene.state().activity,null);
 f.clock(201);await assert.rejects(f.bridge.speak(req));f.reopen();f.clock(100);await assert.rejects(f.bridge.speak(req));
 }finally{f.done();}
});
test('speech rechecks authority/context/close after synthesis and prevents concurrent synthesis',async()=>{
 for(const change of ['revoke','switch','close']){
 let release,entered;const started=new Promise(r=>entered=r);const f=fixture(undefined,undefined,5000,{synthesize:()=>{entered();return new Promise(r=>release=r);}});
 try{const p=await f.bridge.ingest(f.body()),req={eventId:p.event.eventId,context:p.event.frame};const pending=f.bridge.speak(req);await started;
 await assert.rejects(f.bridge.speak(req),{code:'local_voice_busy'});
 if(change==='revoke')f.kernel.mount('demo',f.subjects.companion,'sense.hearing',false);
 if(change==='switch')f.scene.perceive({modality:'vision',signal:'work-context'});
 if(change==='close')f.bridge.close();
 release(unitVoice());await assert.rejects(pending);assert.equal(f.scene.state().activity,null);
 }finally{f.done();}}
});

test('third creature has independent sensory authority; primary never enables senses and registry ABA rejects late results',async()=>{
 const f=fixture();try{
  const definition={id:'pet-1',name:'小芽',kind:'pet',personality:'好奇',body:'sprout',tone:'playful'};
  f.scene.createCreature(definition);const before=f.scene.state();f.scene.primaryCreature({creatureId:'pet-1',expectedRevision:before.registryRevision});
  assert.equal(f.scene.state().activeCreatureId,'companion');assert.equal(f.scene.creature('pet-1').senses.hearing,false);
  f.subjects['pet-1']=f.kernel.createSubject('demo',{name:'third'}).id;
  f.kernel.mount('demo',f.subjects['pet-1'],'sense.hearing');
  const bridge=new PerceptionSceneBridge(f.scene,{kernel:f.kernel,service:f.service,ownerId:'demo',subjects:f.subjects,resolveSubject:id=>f.subjects[id],exclusiveOwner:true});
  f.scene.selectCreature({creatureId:'pet-1'});const body={...f.body(),context:bridge.currentContext()};
  await assert.rejects(bridge.ingest(body),{code:'creature_sensory_authority_changed'});
  f.scene.creatureSense({creatureId:'pet-1',modality:'hearing',enabled:true,expectedRevision:f.scene.state().registryRevision});
  const p=await bridge.ingest(body);assert.equal(p.event.frame.creatureId,'pet-1');assert.equal(p.companionReply.creatureId,'pet-1');assert.equal(p.event.metadata.legacySubject,f.subjects['pet-1']);
  await assert.rejects(bridge.ingest({...body,modality:'vision',media:{mimeType:'image/png',base64:Buffer.from('fake').toString('base64')}}),{code:'creature_sensory_authority_changed'});
  let release,entered;const started=new Promise(r=>entered=r);f.service.processor.process=()=>{entered();return new Promise(r=>release=r);};
  const pending=bridge.ingest(body);await started;
  for(const enabled of [false,true])f.scene.creatureSense({creatureId:'pet-1',modality:'hearing',enabled,expectedRevision:f.scene.state().registryRevision});
  release(result('hello'));await assert.rejects(pending,{code:'creature_sensory_authority_changed'});
  assert.equal(f.scene.creature('companion').senses.hearing,true);assert.equal(f.scene.state().primaryCreatureId,'pet-1');
  f.reopen();assert.equal(f.scene.state().activeCreatureId,'pet-1');assert.equal(f.scene.state().primaryCreatureId,'pet-1');assert.equal(f.scene.state().creatures.length,3);
 }finally{f.done();}
});

test('pre-registry pending event cannot gain confirmation authority after migration',async()=>{
 const f=fixture();try{const p=await f.bridge.ingest(f.body());f.scene.beginSense('legacy-event',p.event.frame,'hearing',200);const metadata={...p.event.metadata};delete metadata.creatureGeneration;f.scene.finishSense('legacy-event',metadata);assert.throws(()=>f.bridge.confirm('legacy-event',confirmation(p)),{code:'creature_sensory_authority_changed'});assert.equal(f.scene.state().activity,null);}finally{f.done();}
});
test('dynamic subject mapping rejects accessors and proxies without evaluating them',()=>{
 const f=fixture();try{let invoked=false;const bad={...f.subjects};Object.defineProperty(bad,'pet-one',{enumerable:true,get(){invoked=true;return f.subjects.companion;}});
 for(const subjects of [bad,new Proxy(f.subjects,{ownKeys(){invoked=true;return [];}})])assert.throws(()=>new PerceptionSceneBridge(f.scene,{kernel:f.kernel,service:f.service,ownerId:'demo',subjects,exclusiveOwner:true}));assert.equal(invoked,false);
 }finally{f.done();}
});

test('hearing finite route is only a bound proposal; confirmation yields one receipt and can speak only its current route',async()=>{
 let narrated;const f=fixture({capabilities:async()=>caps,process:async()=>result('演示地图从甲站到丙站')},undefined,5000,{synthesize:async({text})=>{narrated=text;return unitVoice();}});
 try{
  const blocked=await f.bridge.ingest(f.body());assert.equal(blocked.event.metadata.routeProposal.status,'blocked');assert.equal(blocked.event.status,'observation');assert.equal(f.scene.state().market.subscriptions.length,0);
  const subscribed=f.scene.subscribeCreature({productId:'demo.maps.v1'}),sub=subscribed.market.subscriptions[0];f.scene.grantRoute({productId:sub.productId,enabled:true,expectedRevision:sub.revision});
  const p=await f.bridge.ingest(f.body()),proposal=p.event.metadata.routeProposal;
  assert.equal(p.event.status,'awaiting_route_confirmation');assert.equal(f.scene.state().route,null);assert.equal(p.companionReply.suggestedScene,null);
  const request={eventId:p.event.eventId,context:p.event.frame,expectedProposal:proposal,confirmation:'request-synthetic-route'};
  await assert.rejects(f.bridge.confirmRoute({...request,expectedProposal:{...proposal,to:'B'}}),{code:'spoken_route_proposal_mismatch'});
  const done=await f.bridge.confirmRoute(request);assert.equal(done.requestStatus,'completed');assert.equal(done.state.presentation.surface,'synthetic-route');assert.equal(done.state.route.receipt.requestId,proposal.requestId);
  const voice=await f.bridge.speakRoute({receiptId:done.receiptId,context:f.scene.captureSenseContext()});assert.equal(voice.schema,'route-voice.v1');assert.match(narrated,/A 到 B 到 C/);assert.match(narrated,/不是真实导航/);
  const again=await f.bridge.confirmRoute(request);assert.equal(again.replayed,true);assert.equal(f.scene.state().market.receipts.length,1);
  const view=f.bridge.queryRoute({eventId:p.event.eventId,expectedProposal:proposal});assert.equal(view.receiptId,done.receiptId);
  f.scene.selectCreature({creatureId:'companion'});await assert.rejects(f.bridge.speakRoute({receiptId:done.receiptId,context:f.scene.captureSenseContext()}));
  const image=await f.bridge.ingest(f.body('vision'));assert.equal(image.event.metadata.routeProposal,null);
 }finally{f.done();}
});
test('spoken route revoke/regrant prevents dispatch, but explicit cancellation of the old proposal stays available',async()=>{
 const f=fixture({capabilities:async()=>caps,process:async()=>result('演示地图从甲站到丙站')});try{
  const sub=f.scene.subscribeCreature({productId:'demo.maps.v1'}).market.subscriptions[0];f.scene.grantRoute({productId:sub.productId,enabled:true,expectedRevision:sub.revision});
  const p=await f.bridge.ingest(f.body()),proposal=p.event.metadata.routeProposal;
  for(const enabled of [false,true])f.scene.creatureSense({creatureId:'companion',modality:'hearing',enabled,expectedRevision:f.scene.state().registryRevision});
  await assert.rejects(f.bridge.confirmRoute({eventId:p.event.eventId,context:p.event.frame,expectedProposal:proposal,confirmation:'request-synthetic-route'}),{code:'creature_sensory_authority_changed'});
  assert.equal(f.scene.state().route,null);const cancel=f.bridge.cancelRoute({eventId:p.event.eventId,expectedProposal:proposal});assert.equal(cancel.requestStatus,'cancelled');assert.equal(f.scene.state().market.receipts.length,0);
 }finally{f.done();}
});

test('hearing explicitly proposes text entry; confirm opens it for same creature, OCR never does',async()=>{
 const processor={capabilities:async()=>caps,process:async()=>result('我要输入')};
 const f=fixture(processor);try{
  const visual=await f.bridge.ingest(f.body('vision'));assert.equal(visual.event.metadata.candidate,null);assert.equal(f.scene.state().textEntry,undefined);
  const p=await f.bridge.ingest(f.body());assert.equal(p.event.metadata.candidate,'text-entry-request');assert.equal(p.companionReply.suggestedScene,'text-entry-request');assert.equal(f.scene.state().textEntry,undefined);
  const applied=f.bridge.confirm(p.event.eventId,confirmation(p));assert.equal(applied.state.activeCreatureId,'companion');assert.deepEqual(applied.state.textEntry.context,applied.state.context);assert.equal(applied.state.activity,null);
  assert.equal(f.bridge.confirm(p.event.eventId,confirmation(p)).replayed,true);
  const later=await f.bridge.ingest(f.body());
  f.scene.creatureSense({creatureId:'companion',modality:'hearing',enabled:false,expectedRevision:f.scene.state().registryRevision});
  assert.throws(()=>f.bridge.confirm(later.event.eventId,confirmation(later)),{code:'creature_sensory_authority_changed'});
 }finally{f.done();}
});

const namedDefinition=(id='named-pet',name='工作伙伴')=>({id,name,kind:'pet',personality:'保持独立权限',body:'sprout',tone:'playful'});
const namedConfirmation=p=>({...confirmation(p),expectedCreatureProposal:p.event.metadata.creatureProposal});
const namedProcessor=text=>({capabilities:async()=>caps,process:async()=>result(text)});
test('literal named creature proposal confirms one exact instance without primary or sensory expansion, preserves tasks',async()=>{
 const f=fixture(namedProcessor('切换到工作伙伴'));try{
  f.scene.createCreature(namedDefinition());f.scene.perceive({modality:'hearing',signal:'account-request'});const task=f.scene.state().activity;
  const p=await f.bridge.ingest(f.body()),proposal=p.event.metadata.creatureProposal;
  assert.deepEqual(proposal,{schema:'spoken-creature.v1',status:'ready',registryRevision:f.scene.state().registryRevision,targetCreatureId:'named-pet',targetName:'工作伙伴'});
  assert.equal(p.event.metadata.candidate,'creature-request');assert.equal(p.event.status,'awaiting_confirmation');assert.equal(f.scene.state().activeCreatureId,'work');
  assert.throws(()=>f.bridge.confirm(p.event.eventId,confirmation(p)),{code:'creature_proposal_mismatch'});
  assert.throws(()=>f.bridge.confirm(p.event.eventId,{...namedConfirmation(p),expectedCreatureProposal:{...proposal,targetCreatureId:'companion'}}),{code:'creature_proposal_mismatch'});
  const applied=f.bridge.confirm(p.event.eventId,namedConfirmation(p));assert.equal(applied.state.activeCreatureId,'named-pet');assert.equal(applied.state.primaryCreatureId,'companion');assert.deepEqual(applied.state.activity,task);
  assert.deepEqual(applied.state.creatures.find(c=>c.id==='named-pet').senses,{hearing:false,vision:false});
  f.scene.selectCreature({creatureId:'companion'});assert.equal(f.bridge.confirm(p.event.eventId,namedConfirmation(p)).replayed,true);assert.equal(f.scene.state().activeCreatureId,'companion','historical replay must not switch again');
  f.reopen();assert.equal(f.scene.state().activity.id,task.id);assert.equal(f.scene.state().activeCreatureId,'companion');
  assert.equal(readFileSync(join(f.dir,'core.sqlite')).includes(Buffer.from('切换到工作伙伴')),false);
 }finally{f.done();}
});
test('duplicate or absent literal names stay observations; OCR and compound phrases never select a shorter name',async()=>{
 for(const [text,duplicate,status] of [['切换到工作伙伴',true,'ambiguous'],['切换到不存在',false,'unavailable'],['切换到工作伙伴并开户',false,'unavailable']]){
  const f=fixture(namedProcessor(text));try{
   f.scene.createCreature(namedDefinition());if(duplicate)f.scene.createCreature(namedDefinition('second-pet'));
   const p=await f.bridge.ingest(f.body());assert.equal(p.event.metadata.creatureProposal.status,status);assert.equal(p.event.metadata.creatureProposal.targetCreatureId,null);assert.equal(p.event.metadata.creatureProposal.targetName,null);assert.equal(p.event.metadata.candidate,null);assert.equal(p.event.status,'observation');assert.equal(f.scene.state().activeCreatureId,'companion');
   assert.throws(()=>f.bridge.confirm(p.event.eventId,{...namedConfirmation(p),expectedCandidate:'creature-request'}),{code:'sensory_candidate_unavailable'});
   const visual=await f.bridge.ingest(f.body('vision'));assert.equal(visual.event.metadata.creatureProposal,undefined);assert.equal(visual.event.metadata.candidate,null);
  }finally{f.done();}
 }
});
test('named proposals fail registry mutation, source revoke, context ABA and expiry before switching',async()=>{
 for(const change of ['registry','revoke','scene','expiry']){
  const f=fixture(namedProcessor('切换到工作伙伴'));try{
   f.scene.createCreature(namedDefinition());const p=await f.bridge.ingest(f.body());
   if(change==='registry')f.scene.createCreature(namedDefinition('another','另一个'));
   if(change==='revoke')f.scene.creatureSense({creatureId:'companion',modality:'hearing',enabled:false,expectedRevision:f.scene.state().registryRevision});
   if(change==='scene'){f.scene.selectCreature({creatureId:'work'});f.scene.selectCreature({creatureId:'companion'});}
   if(change==='expiry')f.clock(201);
   assert.throws(()=>f.bridge.confirm(p.event.eventId,namedConfirmation(p)));assert.equal(f.scene.state().activeCreatureId,'companion');
  }finally{f.done();}
 }
});
test('registry changes during reply generation suppress stale named proposal output',async()=>{
 let entered,release;const started=new Promise(r=>entered=r);
 const f=fixture(namedProcessor('切换到工作伙伴'),{respond:()=>{entered();return new Promise(r=>release=r);}});try{
  f.scene.createCreature(namedDefinition());const pending=f.bridge.ingest(f.body());await started;
  f.scene.createCreature(namedDefinition('duplicate'));release({text:'old response'});
  await assert.rejects(pending,{code:'creature_registry_changed'});assert.equal(f.scene.state().activeCreatureId,'companion');
 }finally{f.done();}
});
test('named proposal is no longer speakable after registry change',async()=>{
 let synthesised=0;const f=fixture(namedProcessor('切换到工作伙伴'),undefined,5000,{synthesize:async()=>{synthesised++;throw Error('must not run');}});try{
  f.scene.createCreature(namedDefinition());const p=await f.bridge.ingest(f.body());f.scene.createCreature(namedDefinition('duplicate'));
  await assert.rejects(f.bridge.speak({eventId:p.event.eventId,context:p.event.frame}),{code:'creature_registry_changed'});assert.equal(synthesised,0);
 }finally{f.done();}
});
