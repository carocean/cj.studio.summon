import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SceneLab} from '../src/scene.js';
import {localSenses} from '../src/local-senses.js';
import {createSceneServer} from '../src/scene-server.js';

test('real local WAV/PNG -> Vosk/Tesseract -> current-creature event over actual HTTP',{skip:process.env.SENSE_BRIDGE_REAL!=='1'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'real-sense-bridge-')),scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite')),senses=localSenses(scene,dir);
 const server=createSceneServer(scene,{bridge:senses.bridge});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  for(const [modality,path,mimeType,engine,thirdId] of [['hearing',process.env.SENSE_TEST_AUDIO,'audio/wav','vosk'],['vision',process.env.SENSE_TEST_IMAGE,'image/png','tesseract'],['hearing',process.env.SENSE_TEST_AUDIO,'audio/wav','vosk','pet-actual']]){
   let currentId='companion';
   if(thirdId){scene.createCreature({id:thirdId,name:'小芽',kind:'pet',personality:'好奇的伙伴',body:'sprout',tone:'playful'});scene.creatureSense({creatureId:thirdId,modality:'hearing',enabled:true,expectedRevision:scene.state().registryRevision});scene.primaryCreature({creatureId:thirdId,expectedRevision:scene.state().registryRevision});scene.selectCreature({creatureId:thirdId});currentId=thirdId;}
   assert.ok(path,'explicit local fixture path required');
   const info=await(await fetch(base+'/scene/sense-capabilities')).json();assert.equal(info.context.creatureId,currentId);assert.equal(info.capabilities[modality].available,true);
   const response=await fetch(base+'/scene/sense',{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify({context:info.context,modality,language:modality==='hearing'?'zh':'en',media:{mimeType,base64:readFileSync(path).toString('base64')}})});
   const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.result.realProcessing,true);assert.equal(value.result.engine,engine);assert.ok(value.result.text.trim());
   assert.equal(value.event.frame.creatureId,currentId);assert.equal(value.event.metadata.textLength,value.result.text.length);assert.equal(value.llmUsed,false);
   if(process.env.VOICE_REAL_TEST==='1'){
    assert.equal(value.voiceAvailable,true);const spoken=await fetch(base+'/scene/speak',{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify({eventId:value.event.eventId,context:value.event.frame})});const audio=await spoken.json();assert.equal(spoken.status,200,JSON.stringify(audio));assert.equal(audio.eventId,value.event.eventId);assert.equal(audio.realProcessing,true);assert.equal(Buffer.from(audio.base64,'base64').toString('ascii',0,4),'RIFF');
   }
   assert.equal(value.companionReply.schema,'creature-reply.v1');assert.equal(value.companionReply.eventId,value.event.eventId);assert.equal(value.companionReply.creatureId,currentId);assert.equal(value.companionReply.source,'deterministic-local');assert.equal(value.companionReply.llmUsed,false);assert.equal(value.companionReply.suggestedScene,null);assert.ok(value.companionReply.text.length>0);
   assert.equal(value.event.metadata.candidate,null,'these opening-hours fixtures are observations, not commands');
   assert.equal(scene.state().activity,null);assert.equal(scene.state().activeCreatureId,currentId);
   assert.equal(readFileSync(join(dir,'core.sqlite')).includes(Buffer.from(value.result.text)),false);
   assert.equal(readFileSync(join(dir,'sensor-authority.json'),'utf8').includes(value.result.text),false);
   assert.equal(readdirSync(join(dir,'sensor-tmp')).length,0);
  }
 }finally{await new Promise(r=>server.close(r));senses.close();scene.close();rmSync(dir,{recursive:true});}
});
