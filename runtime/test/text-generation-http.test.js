import test from 'node:test';import assert from 'node:assert/strict';
import {createServer as https,request as httpsRequest} from 'node:https';import {request as httpRequest} from 'node:http';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {SceneLab} from '../src/scene.js';import {createSceneServer} from '../src/scene-server.js';import {createProtectedPreview} from '../src/protected-preview.js';import {compileInteractionProposal} from '../src/interaction-proposal.js';
const output={modelId:'fake-local-no-inference',proposal:compileInteractionProposal({kind:'form',title:'New empty surface',fields:[{key:'body',label:'Text',type:'text',required:false}]})};
const listen=server=>new Promise(r=>server.listen(0,'127.0.0.1',r));const turn=()=>new Promise(r=>setImmediate(r));
async function fixture(tls,run){
 const dir=mkdtempSync(join(tmpdir(),'text-http-'));let lab,up,server,gate,cert,calls=0,impl=()=>output;
 const planner={modelId:output.modelId,generate:(...args)=>{calls++;return impl(...args)}};
 try{
  lab=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>100,textGenerationOptions:{planner}});up=createSceneServer(lab);await listen(up);let origin='http://127.0.0.1:'+up.address().port;
  if(tls){execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});cert=readFileSync(join(dir,'cert'));server=https({key:readFileSync(join(dir,'key')),cert});await listen(server);origin='https://localhost:'+server.address().port;gate=createProtectedPreview({origin,invitation:'synthetic-http-test-invitation-only-not-secret-123',upstream:'http://127.0.0.1:'+up.address().port});server.on('request',gate);}
  let auth={};
  const start=(path,body,headers={})=>{
   let req;const done=new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));req=(tls?httpsRequest:httpRequest)({hostname:'127.0.0.1',servername:tls?'localhost':undefined,port:new URL(origin).port,ca:cert,path,method:data?'POST':'GET',headers:{Host:new URL(origin).host,...auth,...(data?{Origin:origin,'Content-Type':'application/json',...(!tls?{'X-Summon-Lab':'synthetic'}:{})}:{}),...headers}},res=>{let chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,value:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(data);});return {req,done};
  };
  const send=(...args)=>start(...args).done;
  const login=async()=>{const r=await send('/preview/login',{invitation:'synthetic-http-test-invitation-only-not-secret-123'});auth={Cookie:r.headers['set-cookie'][0].split(';')[0],'X-Preview-CSRF':r.value.csrf};};
  await run({lab,send,start,login,get calls(){return calls},impl:f=>impl=f});
 }finally{gate?.close();server?.closeAllConnections();up?.closeAllConnections();await Promise.all([server,up].filter(Boolean).map(s=>new Promise(r=>s.close(r))));lab?.close();rmSync(dir,{recursive:true,force:true});}
}
const input=(f,id='one',text='explicit synthetic form request')=>({commandId:id,context:f.lab.captureSenseContext(),text,confirmation:'generate-from-user-text'});
for(const tls of [false,true])test((tls?'trusted TLS gate':'actual loopback HTTP')+' text generation state/default-off, exact routes, byte limits and independent retained drafts',()=>fixture(tls,async f=>{
 if(tls){assert.equal((await f.send('/scene/textgen-state')).status,401);assert.equal((await f.send('/scene/textgen-generate',input(f))).status,401);await f.login();assert.equal((await f.send('/scene/textgen-generate',input(f),{'X-Preview-CSRF':'bad'})).status,403);}
 const state=await f.send('/scene/textgen-state');assert.equal(state.value.enabled,false);assert.equal(state.value.plannerAvailable,true);assert.equal(state.value.ttlMs,30000);
 assert.equal((await f.send('/scene/textgen-generate',input(f))).value.error,'text_generation_disabled');assert.equal(f.calls,0);
 for(const action of ['textgen-enable','textgen-configure','textgen-model'])assert.equal((await f.send('/scene/'+action,{})).status,404);
 f.lab.configureTextGeneration({enabled:true,expectedGeneration:0});
 for(const extra of [{ownerId:'other'},{modelId:'remote'},{program:output.proposal.program},{enabled:true}])assert.equal((await f.send('/scene/textgen-generate',{...input(f),...extra})).status,400);
 assert.equal(f.calls,0);
 const first=await f.send('/scene/textgen-generate',input(f));assert.equal(first.value.status,'completed');assert.equal((await f.send('/scene/textgen-query',{commandId:'one'})).value.status,'completed');assert.deepEqual((await f.send('/scene/textgen-generate',input(f))).value,first.value);assert.equal(f.calls,1);
 const oldId=first.value.result.creation.sessionId;f.lab.editInteraction({commandId:'old-edit',sessionId:oldId,expectedRevision:1,changes:{body:'retained user draft'}});const old=f.lab.readInteraction({sessionId:oldId});
 const emoji=input(f,'emoji','😀'.repeat(4000));const escaped=Buffer.from(JSON.stringify(emoji).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));assert.ok(escaped.length>4096&&escaped.length<65536);
 const second=await f.send('/scene/textgen-generate',escaped);assert.equal(second.status,200);assert.equal(second.value.status,'completed');assert.deepEqual(f.lab.readInteraction({sessionId:oldId}),old);assert.equal(f.lab.readInteraction({sessionId:second.value.result.creation.sessionId}).draft.values.body,null);
 const exact=JSON.stringify(input(f,'exact-limit'));assert.equal((await f.send('/scene/textgen-generate',Buffer.from(exact+' '.repeat(65536-Buffer.byteLength(exact))))).status,200);
 const query=JSON.stringify({commandId:'one'});assert.equal((await f.send('/scene/textgen-query',Buffer.from(query+' '.repeat(4096-Buffer.byteLength(query))))).value.status,'completed');
 assert.equal((await f.send('/scene/textgen-generate',Buffer.alloc(65537,32))).status,413);assert.equal((await f.send('/scene/textgen-query',Buffer.alloc(4097,32))).status,413);assert.equal((await f.send('/scene/textgen-cancel',Buffer.alloc(4097,32))).status,413);
 assert.equal((await f.send('/scene/textgen-generate',Buffer.from([123,34,120,34,58,34,0xc3,0x28,34,125]))).value.error,'invalid_json');
 assert.equal((await f.send('/scene/textgen-generate')).status,404);assert.equal((await f.send('/scene/textgen-state',{})).status,404);
 assert.equal((await f.send('/scene/textgen-cancel',{commandId:'one'})).value.status,'completed');assert.equal(f.calls,3);
}));
for(const tls of [false,true])test((tls?'TLS':'HTTP')+' cancel before admission is not_started, not a cancellation tombstone',()=>fixture(tls,async f=>{
 if(tls)await f.login();f.lab.configureTextGeneration({enabled:true,expectedGeneration:0});
 assert.equal((await f.send('/scene/textgen-cancel',{commandId:'late'})).value.status,'not_started');
 assert.equal((await f.send('/scene/textgen-query',{commandId:'late'})).value.status,'not_started');
 assert.equal((await f.send('/scene/textgen-generate',input(f,'late'))).value.status,'completed');assert.equal(f.calls,1);
}));
for(const tls of [false,true])test((tls?'TLS':'HTTP')+' disconnect leaves unknown result queryable; explicit cancel rejects late creation',()=>fixture(tls,async f=>{
 if(tls)await f.login();f.lab.configureTextGeneration({enabled:true,expectedGeneration:0});let release;f.impl(()=>new Promise(r=>release=r));
 const pending=f.start('/scene/textgen-generate',input(f));pending.done.catch(()=>{});while(!release)await turn();pending.req.destroy();release(output);
 for(let i=0;i<20;i++){if((await f.send('/scene/textgen-query',{commandId:'one'})).value.status==='completed')break;await turn();}
 assert.equal((await f.send('/scene/textgen-query',{commandId:'one'})).value.status,'completed');assert.equal(f.calls,1);
 release=null;const next=f.send('/scene/textgen-generate',input(f,'cancelled'));while(!release)await turn();assert.equal((await f.send('/scene/textgen-cancel',{commandId:'cancelled'})).value.status,'cancelled');const response=await next;assert.equal(response.value.error,'text_generation_cancelled');release(output);await turn();assert.equal((await f.send('/scene/textgen-query',{commandId:'cancelled'})).value.status,'cancelled');assert.equal(f.calls,2);
}));
test('default SceneLab has no planner; persistent capability does not configure a model and close blocks late writes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'text-http-close-'));let lab;let release;
 try{lab=new SceneLab(join(dir,'core'),join(dir,'sink'));assert.equal(lab.textGenerationState().enabled,false);assert.equal(lab.textGenerationState().plannerAvailable,false);lab.configureTextGeneration({enabled:true,expectedGeneration:0});lab.close();lab=new SceneLab(join(dir,'core'),join(dir,'sink'));assert.equal(lab.textGenerationState().enabled,true);assert.equal(lab.textGenerationState().plannerAvailable,false);await assert.rejects(lab.generateTextInteraction({commandId:'none',context:lab.captureSenseContext(),text:'text',confirmation:'generate-from-user-text'}),{code:'text_planner_unavailable'});lab.close();
 lab=new SceneLab(join(dir,'core'),join(dir,'sink'),{textGenerationOptions:{planner:{modelId:output.modelId,generate:()=>new Promise(r=>release=r)}}});const pending=lab.generateTextInteraction({commandId:'closing',context:lab.captureSenseContext(),text:'text',confirmation:'generate-from-user-text'});const failed=assert.rejects(pending);await turn();lab.close();await failed;release(output);await turn();lab=new SceneLab(join(dir,'core'),join(dir,'sink'));assert.equal(lab.queryTextGeneration({commandId:'closing'}).status,'interrupted');assert.equal(lab.currentInteraction(),null);
 }finally{lab?.close();rmSync(dir,{recursive:true,force:true});}
});
