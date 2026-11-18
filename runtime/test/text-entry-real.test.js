import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SceneLab} from '../src/scene.js';
import {localSenses} from '../src/local-senses.js';
import {createSceneServer} from '../src/scene-server.js';

test('unchanged synthetic WAV -> actual local ASR -> confirmed keyboard -> direct text -> generated account form',{skip:process.env.TEXT_ENTRY_REAL!=='1'},async()=>{
 assert.ok(process.env.TEXT_ENTRY_AUDIO,'explicit local synthetic audio fixture required');
 const dir=mkdtempSync(join(tmpdir(),'text-entry-real-')),scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));
 const senses=localSenses(scene,dir),server=createSceneServer(scene,{bridge:senses.bridge});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const post=async(action,body)=>{const r=await fetch(base+'/scene/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
 try{
  assert.equal(scene.state().textEntry,undefined);
  const heard=await post('sense',{context:scene.state().context,modality:'hearing',language:'zh',media:{mimeType:'audio/wav',base64:readFileSync(process.env.TEXT_ENTRY_AUDIO).toString('base64')}});
  console.log('unchanged ASR text:',heard.result.text);
  assert.equal(heard.result.realProcessing,true);assert.equal(heard.result.engine,'sherpa-onnx-paraformer');assert.equal(heard.llmUsed,false);
  assert.equal(heard.event.metadata.candidate,'text-entry-request');assert.equal(scene.state().textEntry,undefined);
  const opened=await post('sense-confirm',{eventId:heard.event.eventId,context:heard.event.frame,expectedCandidate:'text-entry-request',confirmation:'apply-scene-proposal'});
  assert.equal(opened.state.textEntry.schema,'scene-text-entry.v1');assert.equal(opened.state.activeCreatureId,'companion');
  const result=await post('text-request',{context:opened.state.context,text:'模拟开户',confirmation:'apply-direct-text-scene'});
  assert.equal(result.textEntry,undefined);assert.equal(result.activeCreatureId,'work');assert.equal(result.activity.status,'draft');assert.equal(result.activity.receipt,null);assert.equal(result.choiceForms.account.fields.length,3);
  assert.equal(readdirSync(join(dir,'sensor-tmp')).length,0);
  assert.equal(readFileSync(join(dir,'sensor-authority.json'),'utf8').includes(heard.result.text),false);
  assert.equal(readFileSync(join(dir,'core.sqlite')).includes(Buffer.from(heard.result.text)),false);
 }finally{await new Promise(r=>server.close(r));senses.close();scene.close();rmSync(dir,{recursive:true,force:true});}
});
