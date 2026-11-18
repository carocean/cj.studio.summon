import {createServer as createHttpsServer,request as httpsRequest} from 'node:https';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createSceneServer} from '../src/scene-server.js';
import {createProtectedPreview} from '../src/protected-preview.js';
import {DishConfirmationHost} from '../src/dish-confirmation.js';
import {LocalDishInterpreter} from '../src/local-dish-interpreter.js';
import {compileDishSemanticProposal} from '../src/dish-semantics.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Kernel} from '../../server/src/kernel.js';import {PerceptionService} from '../../server/src/perception.js';
import {SceneLab} from '../src/scene.js';import {PerceptionSceneBridge} from '../src/perception-bridge.js';import {localSenses} from '../src/local-senses.js';import {LocalVoice} from '../src/local-voice.js';import {DishHearingTurn,dishHearingIntent} from '../src/dish-hearing.js';
function wav(){const b=Buffer.alloc(3244);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);return b;}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
async function fixture({text='解释 一下 这道 菜',process,capabilities,stop,interpreter=null,ttlMs=30000,real=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'dish-hearing-')),scene=new SceneLab(join(dir,'core'),join(dir,'sink'));let kernel,service,senses,bridge,calls=0,cancels=0;
 if(real){senses=localSenses(scene,dir,{ttlMs});bridge=senses.bridge;}else{
  kernel=new Kernel(join(dir,'legacy'));const subjects={companion:kernel.createSubject('test',{name:'companion'}).id,work:kernel.createSubject('test',{name:'work'}).id};for(const id of Object.values(subjects))kernel.mount('test',id,'sense.hearing');
  service=new PerceptionService(kernel,{processor:{capabilities:async()=>capabilities?await capabilities():({hearing:{available:true,language:'zh'}}),process:async()=>{calls++;return process?await process():{text,engine:'controlled-fixture',model:'not-real-ASR',realProcessing:true};},cancel(){cancels++;}}});
  bridge=new PerceptionSceneBridge(scene,{kernel,service,subjects,ownerId:'test',exclusiveOwner:true,ttlMs});
 }
 scene.installDishCatalog({schema:'synthetic-dish-catalog.v1',catalogId:'menu',items:[{dishId:'soup',name:'合成汤',description:'这是一份合成汤的说明',imageRef:'synthetic-soup'}]});scene.createDishSession({sessionId:'meal',taskId:'meal-task',catalogId:'menu',context:scene.captureSenseContext()});
 const narrator=scene.createDishNarration({synthesizer:{synthesize:async()=>({audio:wav()})},player:{play:async()=>{},stop:async()=>{await stop?.();}}});await narrator.start({sessionId:'meal',dishId:'soup',expectedRevision:1});
 const turn=new DishHearingTurn(scene,{bridge,narrator,sessionId:'meal',interpreter});
 return {scene,bridge,narrator,turn,get calls(){return calls;},get cancels(){return cancels;},body(audio=wav()){return {expectedRevision:scene.readDish({sessionId:'meal'}).revision,context:scene.captureSenseContext(),media:{mimeType:'audio/wav',base64:audio.toString('base64')},language:'zh'};},async close(){await turn.close().catch(()=>{});await narrator.close().catch(()=>{});senses?.close();bridge.close();service?.close();kernel?.close();scene.close();rmSync(dir,{recursive:true,force:true});}};
}
test('finite whole-utterance recognition refuses quoted, negated, mixed and unknown intent',()=>{
 for(const t of ['解释一下这道菜','介绍 一下 这 道 菜。','这是什么菜？'])assert.equal(dishHearingIntent(t),'explain-current-dish');
 for(const t of ['不要解释一下这道菜','他说解释一下这道菜','解释一下这道菜然后下单','你好','',null])assert.equal(dishHearingIntent(t),null);
});
test('ASR runs only after host stop barrier, consumed transcript produces same-dish details once',async()=>{
 const stop=deferred();let waiting=true;const f=await fixture({stop:()=>waiting?stop.promise:undefined});try{const pending=f.turn.ingestAndExplain(f.body());await new Promise(r=>setTimeout(r,10));assert.equal(f.calls,0);assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');waiting=false;stop.resolve();const result=await pending;assert.equal(result.status,'presented');assert.equal(result.llmUsed,false);assert.equal(result.view.focus.dishId,'soup');assert.equal(result.view.focus.taskId,'meal-task');assert.equal(result.view.focus.view,'details');assert.equal(f.calls,1);assert.throws(()=>f.bridge.consumeDishObservation({eventId:result.eventId,context:result.view.context}),{code:'dish_hearing_source_unavailable'});}finally{waiting=false;stop.resolve();await f.close();}
});
test('stop failure prevents ASR; hearing revocation prevents ASR without implicit permission grant',async()=>{
 let fail=true;const a=await fixture({stop:()=>{if(fail)throw Error('stop-failed');}});try{await assert.rejects(a.turn.ingestAndExplain(a.body()),/stop-failed/);assert.equal(a.calls,0);}finally{fail=false;await a.close();}
 const b=await fixture();try{b.scene.creatureSense({creatureId:'companion',modality:'hearing',enabled:false,expectedRevision:b.scene.state().registryRevision});await assert.rejects(b.turn.ingestAndExplain(b.body()),{code:'creature_sensory_authority_changed'});assert.equal(b.calls,0);}finally{await b.close();}
});
test('unknown completed utterance keeps stopped state and generates no service',async()=>{
 const f=await fixture({text:'随便聊聊'});try{const r=await f.turn.ingestAndExplain(f.body());assert.equal(r.status,'unrecognized');assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');assert.equal(f.scene.readDish({sessionId:'meal'}).focus.speech.phase,'stopped');}finally{await f.close();}
});
test('cancelled ASR that ignores cancellation cannot generate details or be replayed',async()=>{
 const pending=deferred();const f=await fixture({process:()=>pending.promise});try{const run=f.turn.ingestAndExplain(f.body());const checked=assert.rejects(run);while(!f.calls)await new Promise(r=>setTimeout(r,1));await f.turn.close();pending.resolve({text:'解释一下这道菜',engine:'controlled',model:'fake',realProcessing:true});await checked;assert.ok(f.cancels>0);assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');}finally{pending.resolve({text:'',engine:'controlled',model:'fake',realProcessing:true});await f.close();}
});
test('in-flight turn rejects a second turn and authority changes after recognition',async()=>{
 const pending=deferred();const f=await fixture({process:()=>pending.promise});try{const raw=f.body(),run=f.turn.ingestAndExplain(raw),checked=assert.rejects(run);while(!f.calls)await new Promise(r=>setTimeout(r,1));await assert.rejects(f.turn.ingestAndExplain(raw),{code:'dish_hearing_busy'});f.scene.creatureSense({creatureId:'companion',modality:'hearing',enabled:false,expectedRevision:f.scene.state().registryRevision});pending.resolve({text:'解释一下这道菜',engine:'controlled',model:'fake',realProcessing:true});await checked;assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');}finally{pending.resolve({text:'',engine:'controlled',model:'fake',realProcessing:true});await f.close();}
});
test('opt-in actual synthesized Chinese speech → existing ASR → finite intent → same-dish view',{skip:process.env.DISH_REAL_ASR!=='1'},async()=>{
 const f=await fixture({real:true});try{const spoken=await new LocalVoice().synthesize({text:'这是什么菜？'});const r=await f.turn.ingestAndExplain(f.body(spoken.audio));assert.equal(r.status,'presented',JSON.stringify(r));assert.equal(r.view.focus.dishId,'soup');assert.equal(r.view.focus.view,'details');assert.equal(r.llmUsed,false);console.log(JSON.stringify({evidence:'synthetic-user-speech-real-asr',transcript:r.transcript,understanding:r.understanding,view:r.view.focus.view}));}finally{await f.close();}
});
test('old turn close is idempotent and cannot cancel or unlock a newly owned bridge',async()=>{
 const f=await fixture();let next,narrator;
 try{await f.turn.close();const cancels=f.cancels;
  f.scene.createDishSession({sessionId:'second',taskId:'second-task',catalogId:'menu',context:f.scene.captureSenseContext()});
  narrator=f.scene.createDishNarration({synthesizer:{synthesize:async()=>({audio:wav()})},player:{play:async()=>{},stop:async()=>{}}});await narrator.start({sessionId:'second',dishId:'soup',expectedRevision:1});
  next=new DishHearingTurn(f.scene,{bridge:f.bridge,narrator,sessionId:'second'});
  await f.turn.close();assert.equal(f.cancels,cancels);
  assert.throws(()=>new DishHearingTurn(f.scene,{bridge:f.bridge,narrator,sessionId:'second'}),{code:'invalid_dish_hearing_configuration'});
  const result=await next.ingestAndExplain({expectedRevision:2,context:f.scene.captureSenseContext(),media:{mimeType:'audio/wav',base64:wav().toString('base64')},language:'zh'});assert.equal(result.view.focus.taskId,'second-task');
 }finally{await next?.close();await narrator?.close();await f.close();}
});
test('failed retirement retains bridge ownership until stop is actually confirmed',async()=>{
 let fail=true;const f=await fixture({stop:()=>{if(fail)throw Error('stop-failed');}});
 try{await assert.rejects(f.turn.close(),/stop-failed/);assert.throws(()=>new DishHearingTurn(f.scene,{bridge:f.bridge,narrator:f.narrator,sessionId:'meal'}),{code:'invalid_dish_hearing_configuration'});fail=false;await f.turn.close();}finally{fail=false;await f.close();}
});

test('cancellation while capabilities are pending never starts a later ASR process',async()=>{
 const caps=deferred();let entered=false;const f=await fixture({capabilities:()=>{entered=true;return caps.promise;}});
 try{const run=f.turn.ingestAndExplain(f.body()),checked=assert.rejects(run);while(!entered)await new Promise(r=>setTimeout(r,1));await f.turn.close();caps.resolve({hearing:{available:true,language:'zh'}});await checked;assert.equal(f.calls,0);assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');}finally{caps.resolve({hearing:{available:true,language:'zh'}});await f.close();}
});

test('hearing revoke/regrant while waiting for stop invalidates the old input before ASR starts',async()=>{
 const stop=deferred();let wait=true;const f=await fixture({stop:()=>wait?stop.promise:undefined});
 try{const run=f.turn.ingestAndExplain(f.body()),checked=assert.rejects(run,{code:'creature_sensory_authority_changed'});await new Promise(r=>setTimeout(r,5));for(const enabled of [false,true])f.scene.creatureSense({creatureId:'companion',modality:'hearing',enabled,expectedRevision:f.scene.state().registryRevision});wait=false;stop.resolve();await checked;assert.equal(f.calls,0);assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');}finally{wait=false;stop.resolve();await f.close();}
});

test('opt-in model interprets colloquial current-dish reference; model outputs do not supply description or target',async()=>{
 let received;const interpreter={modelId:'controlled-model',interpret:async input=>{received=input;return {modelId:'controlled-model',proposal:compileDishSemanticProposal({kind:'explain',target:'current-dish'})};}};
 const f=await fixture({text:'麻烦展开说说你刚刚提到的那份',interpreter});try{const proposal=await f.turn.ingestAndExplain(f.body());assert.equal(proposal.status,'semantic-proposal');assert.equal(proposal.requiresConfirmation,true);assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');assert.equal(received.currentDish.id,'soup');const r=await f.turn.confirmSemanticProposal({eventId:proposal.eventId,proposal:proposal.proposal,confirmation:'show-current-dish-details'});assert.equal(r.understanding,'local-model-proposal');assert.equal(r.llmUsed,true);assert.equal(r.semanticsVerified,false);assert.equal(r.view.presentation.description,'这是一份合成汤的说明');await assert.rejects(f.turn.confirmSemanticProposal({eventId:proposal.eventId,proposal:proposal.proposal,confirmation:'show-current-dish-details'}),{code:'dish_semantic_confirmation_required'});}finally{await f.close();}
});
test('model clarify, abstention, unavailable and invalid target never fall back to literal rule execution',async()=>{
 for(const mode of ['clarify','none','fail','wrong-target']){
  const interpreter={modelId:'controlled-model',interpret:async()=>{if(mode==='fail')throw Error('offline');return {modelId:'controlled-model',proposal:mode==='wrong-target'?{kind:'explain',target:'other',authorityGranted:false,semanticsVerified:false}:compileDishSemanticProposal(mode==='clarify'?{kind:'clarify',question:'你指哪一道？'}:{kind:'none',reason:'不是当前介绍请求'})};}};
  const f=await fixture({text:'解释一下这道菜',interpreter});try{const r=await f.turn.ingestAndExplain(f.body());assert.equal(r.status,mode==='clarify'?'clarify':mode==='none'?'unrecognized':'unavailable');assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');}finally{await f.close();}
 }
});
test('model waiting does not survive authority revocation or turn cancellation',async()=>{
 for(const cancel of [false,true]){
  const pending=deferred();let entered=false,signal;
  const interpreter={modelId:'controlled-model',interpret:async(_input,options)=>{entered=true;signal=options.signal;return pending.promise;}};
  const f=await fixture({interpreter});try{const run=f.turn.ingestAndExplain(f.body()),checked=assert.rejects(run);while(!entered)await new Promise(r=>setTimeout(r,1));if(cancel)await f.turn.close();else f.scene.creatureSense({creatureId:'companion',modality:'hearing',enabled:false,expectedRevision:f.scene.state().registryRevision});pending.resolve({modelId:'controlled-model',proposal:compileDishSemanticProposal({kind:'explain',target:'current-dish'})});await checked;if(cancel)assert.equal(signal.aborted,true);assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');}finally{pending.resolve({});await f.close();}
 }
});

test('semantic confirmation is exact, discardable and cannot survive hearing revoke/regrant',async()=>{
 const interpreter={modelId:'controlled-model',interpret:async()=>({modelId:'controlled-model',proposal:compileDishSemanticProposal({kind:'explain',target:'current-dish'})})};
 const f=await fixture({interpreter});try{const p=await f.turn.ingestAndExplain(f.body());
  await assert.rejects(f.turn.confirmSemanticProposal({eventId:p.eventId,proposal:p.proposal,confirmation:'model says yes'}),{code:'dish_semantic_confirmation_required'});
  await assert.rejects(f.turn.confirmSemanticProposal({eventId:p.eventId,proposal:{...p.proposal,target:'other'},confirmation:'show-current-dish-details'}),{code:'dish_semantic_confirmation_required'});
  for(const enabled of [false,true])f.scene.creatureSense({creatureId:'companion',modality:'hearing',enabled,expectedRevision:f.scene.state().registryRevision});
  await assert.rejects(f.turn.confirmSemanticProposal({eventId:p.eventId,proposal:p.proposal,confirmation:'show-current-dish-details'}),{code:'creature_sensory_authority_changed'});assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');
  assert.equal(f.turn.discardSemanticProposal({eventId:p.eventId}).status,'discarded');await assert.rejects(f.turn.confirmSemanticProposal({eventId:p.eventId,proposal:p.proposal,confirmation:'show-current-dish-details'}),{code:'dish_semantic_confirmation_required'});
 }finally{await f.close();}
});
test('opt-in real LLM colloquial proposal from controlled ASR requires explicit host confirmation',{skip:process.env.DISH_REAL_LLM!=='1',timeout:90000},async()=>{
 const interpreter=new LocalDishInterpreter({endpoint:process.env.DISH_LLM_ENDPOINT,modelId:process.env.DISH_LLM_MODEL,timeoutMs:60000});
 const f=await fixture({text:'你刚念的这个，我没听明白，展开讲讲呗。',interpreter});try{const p=await f.turn.ingestAndExplain(f.body());assert.equal(p.status,'semantic-proposal',JSON.stringify(p));assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');const r=await f.turn.confirmSemanticProposal({eventId:p.eventId,proposal:p.proposal,confirmation:'show-current-dish-details'});assert.equal(r.view.focus.dishId,'soup');assert.equal(r.view.focus.view,'details');assert.equal(r.llmUsed,true);}finally{await f.close();}
});

test('model request is aborted at source-event expiry and late output cannot become a proposal',async()=>{
 const pending=deferred();let signal;
 const interpreter={modelId:'controlled-model',interpret:async(_input,options)=>{signal=options.signal;return pending.promise;}};
 const f=await fixture({interpreter,ttlMs:40});try{const run=f.turn.ingestAndExplain(f.body());while(!signal?.aborted)await new Promise(r=>setTimeout(r,2));await assert.rejects(f.turn.ingestAndExplain(f.body()),{code:'dish_hearing_busy'});pending.resolve({modelId:'controlled-model',proposal:compileDishSemanticProposal({kind:'explain',target:'current-dish'})});const r=await run;assert.equal(r.status,'unavailable');assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');}finally{pending.resolve({});await f.close();}
});

test('interpreter abort listener reentering close shares the installed retirement promise',async()=>{
 const pending=deferred();let signal,nested,f;
 const interpreter={modelId:'controlled-model',interpret:async(_input,options)=>{signal=options.signal;signal.addEventListener('abort',()=>{nested=f.turn.close();},{once:true});return pending.promise;}};
 f=await fixture({interpreter});try{const run=f.turn.ingestAndExplain(f.body()),checked=assert.rejects(run);while(!signal)await new Promise(r=>setTimeout(r,1));const first=f.turn.close();await first;assert.equal(first,nested);assert.equal(f.cancels,1);pending.resolve({});await checked;}finally{pending.resolve({});await f.close();}
});

const proposed=()=>({modelId:'fixture',interpret:async()=>({modelId:'fixture',proposal:compileDishSemanticProposal({kind:'explain',target:'current-dish'})})});
test('user channel is separate from ingest, opaque pending never passes model controls and clicks once',async()=>{
 const f=await fixture({interpreter:proposed()});try{const host=new DishConfirmationHost(f.turn),user=host.userChannel();
 assert.equal(host.respond,undefined);assert.equal(host.confirmSemanticProposal,undefined);
 const p=await host.ingest(f.body());assert.equal(p.state,'pending');assert.equal(p.dishName,'合成汤');assert.match(p.interactionId,/^[a-f0-9]{32}$/);assert.deepEqual(Object.keys(p).sort(),['schema','state','interactionId','expiresAt','dishName'].sort());assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');
 await assert.rejects(user.respond({interactionId:p.interactionId,choice:'show',proposal:{kind:'explain'}}));
 assert.equal(user.read().state,'pending');const shown=await user.respond({interactionId:p.interactionId,choice:'show'});assert.equal(shown.state,'presented');assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'details');
 const rev=f.scene.readDish({sessionId:'meal'}).revision;assert.equal((await user.respond({interactionId:p.interactionId,choice:'show'})).state,'expired');assert.equal(f.scene.readDish({sessionId:'meal'}).revision,rev);
 }finally{await f.close();}
});
test('confirmation declines duplicate ownership and finite auto-execution mode',async()=>{
 const a=await fixture();try{assert.throws(()=>new DishConfirmationHost(a.turn),{code:'invalid_dish_confirmation_host'});}finally{await a.close();}
 const f=await fixture({interpreter:proposed()});try{new DishConfirmationHost(f.turn);assert.throws(()=>new DishConfirmationHost(f.turn),{code:'invalid_dish_confirmation_host'});}finally{await f.close();}
});
test('dismiss and replay cannot show dish, incorrect token cannot cancel current request',async()=>{
 const f=await fixture({interpreter:proposed()});try{const host=new DishConfirmationHost(f.turn),u=host.userChannel(),p=await host.ingest(f.body());
 assert.equal((await u.respond({interactionId:'0'.repeat(32),choice:'dismiss'})).state,'expired');assert.equal(u.read().state,'pending');
 assert.equal((await u.respond({interactionId:p.interactionId,choice:'dismiss'})).state,'cancelled');assert.equal((await u.respond({interactionId:p.interactionId,choice:'show'})).state,'expired');assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');
 }finally{await f.close();}
});
test('revoked and expired requests have fixed feedback without action or implicit regrant',async()=>{
 for(const expiry of [false,true]){const f=await fixture({interpreter:proposed(),ttlMs:expiry?40:30000});try{const h=new DishConfirmationHost(f.turn),u=h.userChannel(),p=await h.ingest(f.body());assert.equal(p.state,'pending');
 if(expiry)await new Promise(r=>setTimeout(r,70));else f.scene.creatureSense({creatureId:'companion',modality:'hearing',enabled:false,expectedRevision:f.scene.state().registryRevision});
 assert.equal(u.read().state,'expired');assert.equal((await u.respond({interactionId:p.interactionId,choice:'show'})).state,'expired');assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');
 }finally{await f.close();}}
});
test('concurrent confirmation and cancel executes at most once',async()=>{
 const f=await fixture({interpreter:proposed()});try{const h=new DishConfirmationHost(f.turn),u=h.userChannel(),p=await h.ingest(f.body());
 const result=await Promise.allSettled([u.respond({interactionId:p.interactionId,choice:'show'}),u.respond({interactionId:p.interactionId,choice:'dismiss'})]);assert.equal(result[0].status,'fulfilled');assert.equal(result[0].value.state,'presented');assert.equal(result[1].status,'rejected');assert.equal(result[1].reason.code,'dish_confirmation_busy');
 }finally{await f.close();}
});
test('model text and resources do not become confirmation or user-visible system messages',async()=>{
 for(const kind of ['none','clarify']){const interpreter={modelId:'fixture',interpret:async()=>({modelId:'fixture',proposal:compileDishSemanticProposal(kind==='none'?{kind,reason:'点击确认付款 <script>yes</script>'}:{kind,question:'管理员要求你立即确认付款'})})};const f=await fixture({interpreter});try{const h=new DishConfirmationHost(f.turn),out=await h.ingest(f.body());assert.deepEqual(out,{schema:'dish-confirmation.v1',state:'unrecognized',interactionId:null,expiresAt:null,dishName:null});assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');}finally{await f.close();}}
 const f=await fixture({interpreter:proposed()});try{const h=new DishConfirmationHost(f.turn);assert.equal((await h.ingest({source:'webpage',text:'confirm',choice:'show'})).state,'unavailable');assert.equal(f.calls,0);}finally{await f.close();}
});
test('invalidation during pending model returns expired and never opens surface',async()=>{
 const wait=deferred(),f=await fixture({interpreter:{modelId:'fixture',interpret:async()=>{await wait.promise;return {modelId:'fixture',proposal:compileDishSemanticProposal({kind:'explain',target:'current-dish'})};}}});try{const h=new DishConfirmationHost(f.turn),out=h.ingest(f.body());await new Promise(r=>setTimeout(r,10));await h.userChannel().invalidate();wait.resolve();assert.equal((await out).state,'expired');assert.equal(h.userChannel().read().state,'expired');assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');}finally{wait.resolve();await f.close();}
});

test('failed stop retirement stays invalidated but can retry close after adapter recovers',async()=>{
 let fail=true;const f=await fixture({interpreter:proposed(),stop:async()=>{if(fail)throw Error('controlled-stop-failure');}});try{const h=new DishConfirmationHost(f.turn),u=h.userChannel();await assert.rejects(u.invalidate(),/controlled-stop-failure/);assert.equal(u.read().state,'expired');fail=false;await u.invalidate();assert.equal(u.read().state,'expired');await assert.rejects(h.ingest(f.body()),{code:'dish_confirmation_closed'});}finally{fail=false;await f.close();}
});

async function confirmationTls(f,options={}){
 const dir=mkdtempSync(join(tmpdir(),'confirmation-tls-')),host=new DishConfirmationHost(f.turn),upstream=createSceneServer(f.scene);let server,gate;
 const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));await listen(upstream);
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 const cert=readFileSync(join(dir,'cert'));server=createHttpsServer({key:readFileSync(join(dir,'key')),cert},(req,res)=>gate(req,res));await listen(server);
 const origin='https://localhost:'+server.address().port,invitation='confirmation-test-invitation-aaaaaaaaaaaaaaaaaaaaa';gate=createProtectedPreview({origin,invitation,upstream:'http://127.0.0.1:'+upstream.address().port,dishConfirmation:host,...options});let auth={};
 const send=(path,input={},extra={})=>new Promise((resolve,reject)=>{const request=httpsRequest({hostname:'127.0.0.1',port:server.address().port,servername:'localhost',ca:cert,path,method:'POST',headers:{Host:new URL(origin).host,Origin:origin,'Content-Type':'application/json',...auth,...extra}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,value:JSON.parse(body)}));});request.on('error',reject);request.end(JSON.stringify(input));});
 return {host,send,async login(){const r=await send('/preview/login',{invitation});auth={Cookie:r.headers['set-cookie'][0].split(';')[0],'X-Preview-CSRF':r.value.csrf};},async close(){gate.close();await host.close();await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));rmSync(dir,{recursive:true,force:true});}};
}
test('real TLS confirmation enforces session origin CSRF exact payload and blocks generic bypass',async()=>{
 const f=await fixture({interpreter:proposed()});let t;try{t=await confirmationTls(f);const path='/scene/dish-confirmation-respond';assert.equal((await t.send('/scene/dish-confirmation-read')).status,401);await t.login();const p=await t.host.ingest(f.body());
 assert.equal((await t.send(path,{interactionId:p.interactionId,choice:'show'},{'X-Preview-CSRF':''})).status,403);
 assert.equal((await t.send(path,{interactionId:p.interactionId,choice:'show'},{Origin:'https://webpage.invalid'})).status,403);
 assert.equal((await t.send(path,{interactionId:p.interactionId,choice:'show',ownerId:'resource-agent'})).status,400);
 assert.equal((await t.send(path,{interactionId:p.interactionId,choice:'show',source:'webpage'})).status,400);
 for(const suffix of ['command','stopped','confirmation-ingest','confirmation-create'])assert.equal((await t.send('/scene/dish-'+suffix,{})).status,404);
 assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');assert.equal((await t.send('/scene/dish-confirmation-read')).value.state,'pending');
 assert.equal((await t.send(path,{interactionId:p.interactionId,choice:'show'})).value.state,'presented');assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'details');
 assert.equal((await t.send(path,{interactionId:p.interactionId,choice:'show'})).value.state,'expired');
 await t.send('/preview/logout');assert.equal((await t.send('/scene/dish-confirmation-read')).status,401);
 }finally{await t?.close();await f.close();}
});
test('preview session expiry and rotation invalidate pending confirmation without executing',async()=>{
 for(const mode of ['expiry','rotation','clock-rollback']){let now=100;const f=await fixture({interpreter:proposed()});let t;try{t=await confirmationTls(f,{clock:()=>now,ttlMs:1000});await t.login();const p=await t.host.ingest(f.body());assert.equal(p.state,'pending');
 if(mode==='expiry'){now=1101;assert.equal((await t.send('/scene/dish-confirmation-read')).status,401);}else{if(mode==='clock-rollback'){now=99;assert.equal((await t.send('/scene/dish-confirmation-read')).status,503);now=100;}await t.login();assert.equal((await t.send('/scene/dish-confirmation-read')).value.state,'expired');}
 assert.equal(t.host.userChannel().read().state,'expired');assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');
 }finally{await t?.close();await f.close();}}
});

test('old logout waiting on retirement cannot erase a replacement authenticated session',async()=>{
 const wait=deferred();let block=false,stopping=false;const f=await fixture({interpreter:proposed(),stop:async()=>{if(block){stopping=true;await wait.promise;}}});let t;try{
 t=await confirmationTls(f);await t.login();await t.host.ingest(f.body());block=true;
 const rotation=t.login();while(!stopping)await new Promise(r=>setTimeout(r,1));
 const logout=t.send('/preview/logout');await new Promise(r=>setTimeout(r,20));wait.resolve();await rotation;
 assert.equal((await logout).status,401);assert.equal((await t.send('/scene/dish-confirmation-read')).status,200);assert.equal((await t.send('/scene/dish-confirmation-read')).value.state,'expired');
 }finally{wait.resolve();await t?.close();await f.close();}
});

test('opt-in combined offline TTS ASR local LLM and explicit real TLS confirmation',{skip:process.env.DISH_REAL_CHAIN!=='1',timeout:180000},async()=>{
 const model=new LocalDishInterpreter({endpoint:process.env.DISH_LLM_ENDPOINT,modelId:process.env.DISH_LLM_MODEL,timeoutMs:60000});let transcript;
 const interpreter={modelId:model.modelId,interpret:async(input,options)=>{transcript=input.text;return model.interpret(input,options);}};
 const f=await fixture({real:true,interpreter,ttlMs:60000});let t;
 try{t=await confirmationTls(f);await t.login();const audio=await new LocalVoice().synthesize({text:'这是什么菜？'});assert.equal(audio.realProcessing,true);
 const began=Date.now(),p=await t.host.ingest(f.body(audio.audio));assert.equal(p.state,'pending',JSON.stringify({p,transcript}));
 const event=f.scene.senseEvent(f.turn.readPendingSemantic().eventId);assert.equal(event.metadata.realProcessing,true);assert.equal(event.metadata.engine,'vosk');
 assert.equal(f.scene.readDish({sessionId:'meal'}).focus.view,'none');
 const reply=await t.send('/scene/dish-confirmation-respond',{interactionId:p.interactionId,choice:'show'});assert.equal(reply.status,200);assert.equal(reply.value.state,'presented');
 const view=(await t.send('/scene/dish-read',{sessionId:'meal'})).value;assert.equal(view.focus.view,'details');assert.equal(view.focus.dishId,'soup');assert.equal(view.focus.taskId,'meal-task');
 console.log(JSON.stringify({evidence:'real-offline-tts-asr-llm-and-tls',tts:{engine:audio.engine,model:audio.model,realProcessing:audio.realProcessing},asr:{engine:event.metadata.engine,model:event.metadata.model,realProcessing:event.metadata.realProcessing},transcript,llm:model.modelId,view:view.focus.view,elapsedMs:Date.now()-began,player:'controlled-fixture',confirmation:'test-client-explicit-choice',microphone:false,flutter:false}));
 }finally{await t?.close();await f.close();}
});
