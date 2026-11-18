import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.js';
import { PerceptionService, requestsText } from '../src/perception.js';
import { Runtime } from '../src/runtime.js';
import { DemoProvider } from '../src/providers.js';
import { createApi } from '../src/http.js';
const result = text => ({text,engine:'unit-test-fixture',model:'fixture-not-real-model',realProcessing:true,limitations:['Mock processor for boundary testing only.']});
const caps = {vision:{available:true,languages:['eng']},hearing:{available:true,language:'zh'}};
function setup(processor={capabilities:async()=>caps,process:async()=>result('我要输入')}) {
  const dir=mkdtempSync(join(tmpdir(),'summon-perception-'));const k=new Kernel(join(dir,'state.json'));
  const subject=k.createSubject('a',{name:'sensory subject'});k.mount('a',subject.id,'sense.hearing');k.mount('a',subject.id,'sense.vision');
  const service=new PerceptionService(k,{processor});
  return {dir,k,subject,service,body(modality='hearing'){return {creatureId:subject.id,modality,media:{mimeType:modality==='hearing'?'audio/wav':'image/png',base64:Buffer.from('unit fixture bytes, not valid media').toString('base64')}};},done(){service.close();k.close();rmSync(dir,{recursive:true});}};
}
test('perception binds owner/creature, records metadata not content, deletes temporary media, and permits requested text only',async()=>{
  let observedPath;
  const f=setup({capabilities:async()=>caps,process:async({path})=>{observedPath=path;assert.equal(existsSync(path),true);return result('我要输入');}});
  try{
    const p=await f.service.ingest('a',f.body());assert.equal(p.status,'completed');assert.equal(p.creatureId,f.subject.id);
    assert.equal(p.presentation.components.some(c=>c.type==='text_input'),true);assert.equal(existsSync(observedPath),false);
    assert.equal(f.k.listPerceptions('b').length,0);assert.equal(f.k.listPerceptions('a')[0].result.textLength,4);
    assert.equal(readFileSync(f.k.path,'utf8').includes('我要输入'),false);
    assert.equal(f.service.text('a',{creatureId:f.subject.id,perceptionId:p.id,text:'我的任务'}).presentation.components.some(c=>c.type==='text_input'),true);
    assert.throws(()=>f.service.text('b',{creatureId:f.subject.id,perceptionId:p.id,text:'x'}),{code:'perception_not_found'});
    const vision=await f.service.ingest('a',f.body('vision'));
    assert.equal(vision.presentation.components.some(c=>c.type==='text_input'),false);
    assert.throws(()=>f.service.text('a',{creatureId:f.subject.id,perceptionId:vision.id,text:'x'}),{code:'text_input_not_requested'});
  }finally{f.done();}
});
test('revocation and regrant during perception rejects old result and cleans all files',async()=>{
  let finish, entered;
  const began=new Promise(resolve=>entered=resolve);
  const f=setup({capabilities:async()=>caps,process:()=>{entered();return new Promise(resolve=>finish=resolve);}});
  try{
    const pending=f.service.ingest('a',f.body());await began;
    await assert.rejects(f.service.ingest('a',f.body()),{code:'perception_busy'});
    f.k.mount('a',f.subject.id,'sense.hearing',false);f.k.mount('a',f.subject.id,'sense.hearing',true);finish(result('private phrase'));
    await assert.rejects(pending,{code:'authorization_changed'});assert.equal(readdirSync(f.service.scratch).length,0);
    assert.equal(f.k.listPerceptions('a')[0].status,'failed');assert.equal(JSON.stringify(f.k.state).includes('private phrase'),false);
  }finally{f.done();}
});
test('invalid/oversized media, ownership and missing sensory grant fail before model work',async()=>{
  let processed=0;const f=setup({capabilities:async()=>caps,process:async()=>{processed++;return result('text');}});
  try{
    await assert.rejects(f.service.ingest('b',f.body()),{code:'subject_not_found'});
    f.k.mount('a',f.subject.id,'sense.hearing',false);await assert.rejects(f.service.ingest('a',f.body()),{code:'outside_sensory_boundary'});
    for(const media of [{mimeType:'audio/wav',base64:'not base64'},{mimeType:'audio/wav',base64:'a'.repeat(6*1024*1024)},{mimeType:'text/html',base64:'aGVsbG8='}])await assert.rejects(f.service.ingest('a',{...f.body(),media}));
    assert.equal(processed,0);assert.equal(f.k.listPerceptions('a').length,0);
    assert.equal(requestsText('网页说“我要输入”'),false);assert.equal(requestsText('我 要 输 入'),true);
  }finally{f.done();}
});
test('empty speech is an actual empty result, engine failure not fabricated success, restart interrupts pending records',async()=>{
  const f=setup({capabilities:async()=>caps,process:async()=>result('')});try{
    const empty=await f.service.ingest('a',f.body());assert.equal(empty.result.text,'');assert.equal(empty.presentation.components.some(c=>c.type==='text_input'),false);
    f.service.processor.process=async()=>{throw new Error('private machine detail');};await assert.rejects(f.service.ingest('a',f.body()),{code:'perception_processing_failed'});
    assert.equal(readdirSync(f.service.scratch).length,0);assert.equal(JSON.stringify(f.k.state).includes('private machine detail'),false);
    const pending=f.k.beginPerception('a',{creatureId:f.subject.id,modality:'vision',mimeType:'image/png',byteLength:10});
    f.service.close();f.k.close();const reopened=new Kernel(f.k.path);try{assert.equal(reopened.listPerceptions('a').find(p=>p.id===pending.id).status,'interrupted');}finally{reopened.close();}
  }finally{f.done();}
});
test('actual HTTP enforces authentication and separate media body limit with metadata-only history',async()=>{
  const f=setup();const token='sensory-synthetic-token-abcdefghijklmnopqrstuvwxyz';
  const server=createApi(new Runtime(new DemoProvider(),{kernel:f.k}),{kernel:f.k,perceptions:f.service,ownerId:'a',appToken:token});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  try{
    assert.equal((await fetch(base+'/v1/perceptions',{method:'POST',body:JSON.stringify(f.body())})).status,401);
    const response=await fetch(base+'/v1/perceptions',{method:'POST',headers,body:JSON.stringify({...f.body(),ownerId:'b'})});assert.equal(response.status,200);
    const p=await response.json();assert.equal(p.creatureId,f.subject.id);
    const list=await(await fetch(base+'/v1/perceptions',{headers})).json();assert.equal(list.perceptions[0].result.text,undefined);
    const typed=await fetch(base+'/v1/perceptions/text',{method:'POST',headers,body:JSON.stringify({creatureId:f.subject.id,perceptionId:p.id,text:'我的任务'})});assert.equal(typed.status,200);
  }finally{await new Promise(resolve=>server.close(resolve));f.done();}
});
test('revocation while capabilities load prevents processor start; close during inference cleans media',async()=>{
  let release, processed=0;
  const f=setup({capabilities:()=>new Promise(resolve=>release=resolve),process:async()=>{processed++;return result('text');}});
  try {
    const pending=f.service.ingest('a',f.body());
    f.k.mount('a',f.subject.id,'sense.hearing',false); f.k.mount('a',f.subject.id,'sense.hearing',true);
    release(caps); await assert.rejects(pending,{code:'authorization_changed'});
    assert.equal(processed,0); assert.equal(readdirSync(f.service.scratch).length,0);
    let finish, entered;
    const began=new Promise(resolve=>entered=resolve);
    f.service.processor.process=()=>{entered();return new Promise(resolve=>finish=resolve);};
    const next=f.service.ingest('a',f.body()); await began;
    f.service.close(); finish(result('must not commit'));
    await assert.rejects(next,{code:'perception_unavailable'});
    assert.equal(readdirSync(f.service.scratch).length,0);
    assert.equal(JSON.stringify(f.k.state).includes('must not commit'),false);
  } finally {f.done();}
});

test('public sensory capabilities advertise only media accepted by HTTP adapter',async()=>{
  const f=setup({capabilities:async()=>({...caps,hearing:{available:true,language:'zh',supportedMime:['audio/wav','audio/webm','audio/mp4']}}),process:async()=>result('text')});
  try {
    const advertised=await f.service.capabilities();assert.deepEqual(advertised.hearing.supportedMime,['audio/wav']);
    advertised.hearing.supportedMime.push('audio/webm');assert.deepEqual((await f.service.capabilities()).hearing.supportedMime,['audio/wav']);
    await assert.rejects(f.service.ingest('a',{...f.body(),media:{mimeType:'audio/webm',base64:'eA=='}}),{code:'unsupported_media_type'});
  } finally {f.done();}
});
