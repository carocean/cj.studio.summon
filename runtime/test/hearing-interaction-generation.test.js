import test from 'node:test';
import {request as httpRequest} from 'node:http';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Kernel} from '../../server/src/kernel.js';
import {PerceptionService} from '../../server/src/perception.js';
import {SceneLab} from '../src/scene.js';
import {PerceptionSceneBridge} from '../src/perception-bridge.js';
import {compileInteractionProposal} from '../src/interaction-proposal.js';
import {createSceneServer} from '../src/scene-server.js';
// Fixture ASR and planner test host state transitions, NOT actual inference.
const form=()=>compileInteractionProposal({kind:'form',title:'Fixture form',fields:[{key:'detail',label:'Detail',type:'text',required:false}]});
function fixture({generate=async()=>({proposal:form(),modelId:'fixture-not-model'}),planner=true,ttlMs=1000,voice=null}={}){
 const dir=mkdtempSync(join(tmpdir(),'hearing-generation-'));let now=100,text='这是一个自由表达的请求',real=true,calls=0;
 const scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'),{clock:()=>now});
 const kernel=new Kernel(join(dir,'legacy.json'),{clock:()=>now}),ownerId='test';
 const subjects=Object.fromEntries(['companion','work'].map(name=>[name,kernel.createSubject(ownerId,{name}).id]));
 for(const id of Object.values(subjects))for(const m of ['hearing','vision'])kernel.mount(ownerId,id,'sense.'+m);
 const service=new PerceptionService(kernel,{processor:{capabilities:async()=>({hearing:{available:true},vision:{available:true}}),process:async()=>({text,engine:'fixture',model:'fixture-asr',realProcessing:real})}});
 const options={kernel,service,ownerId,subjects,ttlMs,exclusiveOwner:true,voice,interactionPlanner:planner?{modelId:'fixture-not-model',generate:async(...args)=>{calls++;return generate(...args);}}:null};
 let bridge=new PerceptionSceneBridge(scene,options);
 return {scene,kernel,subjects,dir,get bridge(){return bridge;},get calls(){return calls;},text(v){text=v;},real(v){real=v;},time(v){now=v;},reopen(){bridge.close();bridge=new PerceptionSceneBridge(scene,options);},async ingest(modality='hearing'){return bridge.ingest({context:bridge.currentContext(),modality,media:{mimeType:modality==='hearing'?'audio/wav':'image/png',base64:Buffer.from('fixture').toString('base64')}});},done(){bridge.close();service.close();kernel.close();scene.close();rmSync(dir,{recursive:true,force:true});}};
}
const request=p=>({eventId:p.event.eventId,context:p.event.frame});
test('explicit current hearing creates only empty draft, revokes old speech, durable replay never invokes/reopens',async()=>{
 const f=fixture({voice:{synthesize:async()=>{throw Error('must not run');}}});try{
  const p=await f.ingest(),r=await f.bridge.generateInteraction(request(p));
  assert.equal(r.kind,'form');assert.equal(r.plannerInvoked,true);assert.equal(r.speech,null);assert.equal(r.voiceAvailable,false);
  const sessionId=r.creation.ack.sessionId,draft=f.scene.readInteraction({sessionId});assert.deepEqual(draft.draft.values,{detail:null});assert.equal(draft.saveCount,0);
  await assert.rejects(f.bridge.speak(request(p)),{code:'voice_event_unavailable'});
  f.scene.closeInteraction({sessionId,commandId:'close-test',expectedRevision:1});f.reopen();
  const again=await f.bridge.generateInteraction(request(p));assert.equal(again.replayed,true);assert.equal(again.plannerInvoked,false);assert.equal(again.modelId,null);assert.equal(again.proposal,undefined);assert.equal(f.calls,1);
  assert.throws(()=>f.scene.readInteraction({sessionId}),{code:'interaction_session_closed'});
  assert.equal(readFileSync(join(f.dir,'legacy.json'),'utf8').includes('这是一个自由表达的请求'),false);
 }finally{f.done();}
});
test('default disabled; no client transcript/program; non-real, visual, candidates, stale round and restart cannot infer',async()=>{
 let f=fixture({planner:false});try{const p=await f.ingest();await assert.rejects(f.bridge.generateInteraction(request(p)),{code:'interaction_planner_unavailable'});}finally{f.done();}
 f=fixture();try{
  const p=await f.ingest();for(const extra of [{text:'forged'},{program:form().program}])await assert.rejects(f.bridge.generateInteraction({...request(p),...extra}),{code:'invalid_shape'});
  f.reopen();await assert.rejects(f.bridge.generateInteraction(request(p)),{code:'interaction_source_unavailable'});
  for(const [text,modality] of [['模拟开户','hearing'],['随便','vision'],['从A到B','hearing']]){f.text(text);const q=await f.ingest(modality);if(q.event.status!=='observation'||modality==='vision')await assert.rejects(f.bridge.generateInteraction(request(q)),{code:'interaction_source_unavailable'});}
  f.text('自由请求');const old=await f.ingest();await assert.rejects(f.bridge.ingest({}));await assert.rejects(f.bridge.generateInteraction(request(old)),{code:'interaction_source_unavailable'});assert.equal(f.calls,0);
 }finally{f.done();}
});
test('clarify/none create nothing and are once-only; failed attempt cannot retry',async()=>{
 for(const kind of ['clarify','none','failure']){
  const f=fixture({generate:async()=>{if(kind==='failure')throw Error('fixture-failure');return {modelId:'fixture-not-model',proposal:compileInteractionProposal(kind==='clarify'?{kind,question:'Which fields?'}:{kind,reason:'No form needed'})};}});
  try{const p=await f.ingest();if(kind==='failure')await assert.rejects(f.bridge.generateInteraction(request(p)));else{const r=await f.bridge.generateInteraction(request(p));assert.equal(r.kind,kind);assert.equal(r.creation,null);}await assert.rejects(f.bridge.generateInteraction(request(p)),{code:'interaction_generation_already_attempted'});assert.equal(f.calls,1);assert.equal(f.scene.currentInteraction(),null);}finally{f.done();}
 }
});
test('late inference loses authority on context/generation/legacy/clock changes',async()=>{
 for(const change of [f=>f.scene.perceive({modality:'vision',signal:'work-context'}),f=>f.scene.creatureSense({creatureId:'companion',modality:'hearing',enabled:false,expectedRevision:f.scene.state().registryRevision}),f=>f.kernel.mount('test',f.subjects.companion,'sense.hearing',false),f=>f.time(2000)]){
  let release;const f=fixture({generate:()=>new Promise(r=>release=r)});try{const p=await f.ingest(),pending=f.bridge.generateInteraction(request(p));await new Promise(r=>setImmediate(r));change(f);release({proposal:form(),modelId:'fixture-not-model'});await assert.rejects(pending);assert.equal(f.scene.currentInteraction(),null);}finally{f.done();}
 }
});
test('TTL, close, new ingest and caller cancel bound wait even for abort-ignoring planner; single flight remains locked',async()=>{
 for(const action of ['ttl','close','ingest','caller']){
  let release,observed;const f=fixture({ttlMs:action==='ttl'?30:1000,generate:(_,{signal})=>{observed=signal;return new Promise(r=>release=r);}});
  try{const p=await f.ingest(),controller=new AbortController(),pending=f.bridge.generateInteraction(request(p),{signal:controller.signal});await new Promise(r=>setImmediate(r));
   await assert.rejects(f.bridge.generateInteraction(request(p)),{code:'interaction_generation_already_attempted'});
   const rejected=assert.rejects(pending,{code:'interaction_generation_cancelled'});
   if(action==='close')f.bridge.close();if(action==='ingest'){const q=await f.ingest();await assert.rejects(f.bridge.generateInteraction(request(q)),{code:'interaction_planner_busy'});}if(action==='caller')controller.abort();
   await rejected;assert.equal(observed.aborted,true);release({proposal:form(),modelId:'fixture-not-model'});await new Promise(r=>setImmediate(r));assert.equal(f.scene.currentInteraction(),null);assert.equal(f.calls,1);
  }finally{f.done();}
 }
});
test('HTTP accepts only event/context and normal request end does not cancel generation',async()=>{
 const f=fixture(),server=createSceneServer(f.scene,{bridge:f.bridge});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const post=(path,body)=>fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});
 try{const p=await f.ingest();assert.equal((await post('/scene/interaction-generate',{...request(p),text:'forged'})).status,400);const r=await post('/scene/interaction-generate',request(p));assert.equal(r.status,200);assert.equal((await r.json()).kind,'form');assert.equal(f.calls,1);}finally{await new Promise(r=>server.close(r));f.done();}
});

test('HTTP disconnect cancels local wait and late result cannot create',async()=>{
 let release,started;const entered=new Promise(r=>started=r);let observed;
 const f=fixture({generate:(_,{signal})=>{observed=signal;started();return new Promise(r=>release=r);}}),server=createSceneServer(f.scene,{bridge:f.bridge});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const p=await f.ingest(),req=httpRequest({host:'127.0.0.1',port:server.address().port,path:'/scene/interaction-generate',method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'}});req.on('error',()=>{});req.end(JSON.stringify(request(p)));await entered;req.destroy();
  for(let i=0;i<30&&!observed.aborted;i++)await new Promise(r=>setTimeout(r,5));assert.equal(observed.aborted,true);
  release({proposal:form(),modelId:'fixture-not-model'});await new Promise(r=>setImmediate(r));assert.equal(f.scene.currentInteraction(),null);
 }finally{await new Promise(r=>server.close(r));f.done();}
});
test('preflight checks and malformed model results never create or retry',async()=>{
 for(const mutate of [f=>f.time(2000),f=>f.scene.perceive({modality:'vision',signal:'work-context'}),f=>f.kernel.mount('test',f.subjects.companion,'sense.hearing',false)]){
  const f=fixture();try{const p=await f.ingest();mutate(f);await assert.rejects(f.bridge.generateInteraction(request(p)));assert.equal(f.calls,0);}finally{f.done();}
 }
 for(const output of [{proposal:{...form(),authorityGranted:true},modelId:'fixture-not-model'},{proposal:form(),modelId:'wrong'},{proposal:{kind:'form',program:{},authorityGranted:false,semanticsVerified:false},modelId:'fixture-not-model'},{proposal:{kind:'none',reason:'ok',action:'save',authorityGranted:false,semanticsVerified:false},modelId:'fixture-not-model'}]){
  const f=fixture({generate:async()=>output});try{const p=await f.ingest();await assert.rejects(f.bridge.generateInteraction(request(p)));await assert.rejects(f.bridge.generateInteraction(request(p)),{code:'interaction_generation_already_attempted'});assert.equal(f.calls,1);assert.equal(f.scene.currentInteraction(),null);}finally{f.done();}
 }
 const f=fixture();try{f.real(false);await assert.rejects(f.ingest());assert.equal(f.calls,0);}finally{f.done();}
});
