import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SceneLab} from '../src/scene.js';
import {localSenses} from '../src/local-senses.js';
import {createSceneServer} from '../src/scene-server.js';

test('unchanged WAV -> local ASR -> exact registered creature -> explicit switch, target senses remain disabled',{skip:process.env.SPOKEN_CREATURE_REAL!=='1'},async()=>{
 assert.ok(process.env.SPOKEN_CREATURE_AUDIO,'explicit synthetic audio fixture required');
 assert.ok(process.env.SPOKEN_CREATURE_REJECT_AUDIO,'explicit misrecognized synthetic fixture required');
 const dir=mkdtempSync(join(tmpdir(),'spoken-creature-real-')),scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));
 const senses=localSenses(scene,dir),server=createSceneServer(scene,{bridge:senses.bridge});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(action,body)=>{const r=await fetch(base+'/scene/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
 try{
  await post('creature-create',{id:'named-pet',name:'工作伙伴',kind:'pet',personality:'独立且尊重边界',body:'sprout',tone:'playful'});
  const rejected=await post('sense',{context:scene.state().context,modality:'hearing',language:'zh',media:{mimeType:'audio/wav',base64:readFileSync(process.env.SPOKEN_CREATURE_REJECT_AUDIO).toString('base64')}});
  console.log('unchanged rejected ASR text:',rejected.result.text);
  assert.equal(rejected.result.realProcessing,true);assert.equal(rejected.event.metadata.candidate,null);assert.equal(rejected.event.metadata.creatureProposal,undefined);assert.equal(scene.state().activeCreatureId,'companion');
  const before=scene.state(),heard=await post('sense',{context:before.context,modality:'hearing',language:'zh',media:{mimeType:'audio/wav',base64:readFileSync(process.env.SPOKEN_CREATURE_AUDIO).toString('base64')}});
  console.log('unchanged ASR text:',heard.result.text);
  assert.equal(heard.result.realProcessing,true);assert.equal(heard.result.engine,'sherpa-onnx-paraformer');assert.equal(heard.llmUsed,false);
  assert.equal(heard.event.metadata.candidate,'creature-request');assert.equal(heard.event.metadata.creatureProposal.targetCreatureId,'named-pet');assert.equal(scene.state().activeCreatureId,'companion');
  const confirm={eventId:heard.event.eventId,context:heard.event.frame,expectedCandidate:'creature-request',expectedCreatureProposal:heard.event.metadata.creatureProposal,confirmation:'apply-scene-proposal'};
  const switched=await post('sense-confirm',confirm);
  assert.equal(switched.state.activeCreatureId,'named-pet');assert.equal(switched.state.presentation.creatureId,'named-pet');assert.equal(switched.state.primaryCreatureId,before.primaryCreatureId);assert.deepEqual(switched.state.creatures,before.creatures);
  const capabilities=await(await fetch(base+'/scene/sense-capabilities')).json();assert.equal(capabilities.context.creatureId,'named-pet');assert.equal(capabilities.capabilities.hearing.available,false);assert.equal(capabilities.capabilities.vision.available,false);
  assert.equal(readdirSync(join(dir,'sensor-tmp')).length,0);
  assert.equal(readFileSync(join(dir,'sensor-authority.json'),'utf8').includes(heard.result.text),false);assert.equal(readFileSync(join(dir,'core.sqlite')).includes(Buffer.from(heard.result.text)),false);
 }finally{await new Promise(r=>server.close(r));senses.close();scene.close();rmSync(dir,{recursive:true,force:true});}
});
