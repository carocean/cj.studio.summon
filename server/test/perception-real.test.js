import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.js';
import { PerceptionService } from '../src/perception.js';
import { Runtime } from '../src/runtime.js';
import { DemoProvider } from '../src/providers.js';
import { createApi } from '../src/http.js';
// Opt-in real-engine fixtures are supplied locally, never downloaded by tests.
for (const [modality, variable, mimeType, engine] of [
  ['vision','SENSE_TEST_IMAGE','image/png','tesseract'],
  ['hearing','SENSE_TEST_AUDIO','audio/wav','vosk'],
]) {
  test(`real local ${engine} through authenticated sensory HTTP, no media/transcript persistence`, {
    skip: process.env.SENSE_REAL_TESTS !== '1' || !process.env[variable], timeout:60000,
  }, async()=>{
    const dir=mkdtempSync(join(tmpdir(),'summon-real-sense-'));const k=new Kernel(join(dir,'state.json'));
    const subject=k.createSubject('owner',{name:'real local processor fixture'});k.mount('owner',subject.id,`sense.${modality}`);
    const runtime=new Runtime(new DemoProvider(),{kernel:k});
    const service=new PerceptionService(k,{runtime});const token='real-sensory-test-token-abcdefghijklmnopqrstuvwxyz';
    const server=createApi(new Runtime(new DemoProvider(),{kernel:k}),{kernel:k,perceptions:service,ownerId:'owner',appToken:token});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const bytes=readFileSync(process.env[variable]);
      const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/perceptions`,{
        method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:JSON.stringify({creatureId:subject.id,modality,media:{mimeType,base64:bytes.toString('base64')}}),
      });
      const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
      assert.equal(body.result.engine,engine);assert.equal(body.result.realProcessing,true);assert.ok(body.result.text.trim().length>0);
      if(modality==='vision') assert.match(body.result.text,/SUMMON\s+VISION\s+42/);
      assert.equal(readdirSync(service.scratch).length,0);
      const persisted=readFileSync(k.path,'utf8');assert.equal(persisted.includes(body.result.text),false);
      assert.equal(k.listPerceptions('owner')[0].result.engine,engine);
      assert.equal(k.listPerceptions('someone-else').length,0);
      if(modality==='hearing') {
        k.mount('owner',subject.id,'conversation');
        const spoken=await fetch(`http://127.0.0.1:${server.address().port}/v1/perceptions`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({creatureId:subject.id,modality,responseMode:'dialogue',media:{mimeType,base64:bytes.toString('base64')}})});
        const result=await spoken.json();assert.equal(spoken.status,200);assert.equal(result.result.engine,'vosk');assert.equal(result.dialogue.status,'completed');assert.equal(result.dialogue.providerMode,'demo');assert.match(result.dialogue.answer,/演示模式/);assert.equal(runtime.getSession('owner',result.dialogue.sessionId).turns[0].content,result.result.text);
      }
    }finally{service.close();await new Promise(resolve=>server.close(resolve));k.close();rmSync(dir,{recursive:true});}
  });
}
