import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Kernel} from '../src/kernel.js';
import {Runtime} from '../src/runtime.js';
import {DemoProvider,CompatibleProvider} from '../src/providers.js';
import {PerceptionService} from '../src/perception.js';
import {validateScene} from '../src/presentation.js';
function fixture(provider=new DemoProvider()) {
  const dir=mkdtempSync(join(tmpdir(),'summon-voice-dialogue-')), k=new Kernel(join(dir,'state.json'));
  const subject=k.createSubject('a',{name:'语音主体',personality:'沉稳简洁'});k.mount('a',subject.id,'sense.hearing');k.mount('a',subject.id,'conversation');
  const runtime=new Runtime(provider,{kernel:k});
  const service=new PerceptionService(k,{runtime,processor:{capabilities:async()=>({hearing:{available:true,language:'zh'}}),process:async()=>({text:'帮我想想今天怎样安排',engine:'fixture',model:'not-real-ASR',realProcessing:true})}});
  const body={creatureId:subject.id,modality:'hearing',media:{mimeType:'audio/wav',base64:'eA=='}};
  return {dir,k,subject,runtime,service,body,done(){service.close();k.close();rmSync(dir,{recursive:true});}};
}
test('voice defaults to perception only; explicit opt-in continues same subject conversation, labels demo and retention',async()=>{
  const f=fixture();try {
    const only=await f.service.ingest('a',f.body);assert.equal(only.dialogue,undefined);assert.equal(f.k.listSessions('a',f.subject.id).length,0);
    const a=await f.service.ingest('a',{...f.body,responseMode:'dialogue'});assert.equal(a.dialogue.status,'completed');assert.equal(a.dialogue.providerMode,'demo');assert.match(a.dialogue.answer,/演示模式/);assert.equal(a.dialogue.retention,'conversation-text-persisted');
    const b=await f.service.ingest('a',{...f.body,responseMode:'dialogue'});assert.equal(b.dialogue.sessionId,a.dialogue.sessionId);assert.equal(f.runtime.getSession('a',a.dialogue.sessionId).turns.length,4);
    assert.equal(readFileSync(f.k.path,'utf8').includes('帮我想想今天怎样安排'),true);
    await assert.rejects(f.service.ingest('b',{...f.body,responseMode:'dialogue'}),{code:'subject_not_found'});
    f.k.mount('a',f.subject.id,'conversation',false);await assert.rejects(f.service.ingest('a',{...f.body,responseMode:'dialogue'}),{code:'outside_service_boundary'});
  }finally{f.done();}
});
test('compatible scene adapter transmits persona and varied read-only schemas without granting actions',async()=>{
  let call;const provider=new CompatibleProvider({endpoint:'https://fixture.invalid/chat',apiKey:'fixture-key',model:'fixture-not-real',fetchImpl:async(url,request)=>{call=JSON.parse(request.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answer:'可以先整理优先事项。',components:[{type:'bullet_list',title:'建议',items:['处理必要事项','安排休息']},{type:'key_values',title:'当前状态',entries:[{label:'执行',value:'未执行任何现实动作'}]}]})}}]}));}});
  const f=fixture(provider);try{
    const output=await f.service.ingest('a',{...f.body,responseMode:'dialogue'});assert.equal(output.dialogue.status,'completed');assert.equal(output.dialogue.presentation.components.length,2);assert.match(call.messages[0].content,/沉稳简洁/);assert.match(call.messages[0].content,/不要创建输入框/);assert.equal(call.messages.at(-1).content,'帮我想想今天怎样安排');
  }finally{f.done();}
});
test('invalid model scene never persists assistant turn; revocation during dialogue rejects response without losing sensory receipt',async()=>{
  const f=fixture({mode:'llm',respondScene:async()=>JSON.stringify({answer:'unsafe',components:[{type:'button',url:'https://evil.invalid'}]})});
  try{
    const bad=await f.service.ingest('a',{...f.body,responseMode:'dialogue'});assert.equal(bad.status,'completed');assert.equal(bad.dialogue.status,'failed');assert.equal(bad.dialogue.error,'invalid_scene_component');assert.equal(f.k.listSessions('a',f.subject.id)[0].turnCount,0);
    let entered,finish;const started=new Promise(r=>entered=r);
    f.runtime.provider={mode:'demo',respond:()=>{entered();return new Promise(r=>finish=r);}};
    const pending=f.service.ingest('a',{...f.body,responseMode:'dialogue'});await started;f.k.mount('a',f.subject.id,'sense.hearing',false);f.k.mount('a',f.subject.id,'sense.hearing',true);finish('old response');
    const output=await pending;assert.equal(output.dialogue.status,'failed');assert.equal(output.dialogue.error,'authorization_changed');assert.equal(readFileSync(f.k.path,'utf8').includes('old response'),false);
  }finally{f.done();}
});
test('scene validation rejects executable/oversized/invalid components and strips extra attributes',()=>{
  const scene=validateScene(JSON.stringify({answer:'hello',components:[{type:'status_text',text:'read only',url:'https://ignored.invalid'}]}));assert.equal(scene.presentation.components[0].url,undefined);
  for(const components of [[{type:'text_input'}],[{type:'bullet_list',title:'x',items:[{}]}],Array(7).fill({type:'status_text',text:'x'})])assert.throws(()=>validateScene(JSON.stringify({answer:'hi',components})));
});

test('closing perception service during dialogue rejects stale commit',async()=>{
  let entered,finish;const started=new Promise(r=>entered=r);
  const f=fixture({mode:'demo',respond:()=>{entered();return new Promise(r=>finish=r);}});
  try {
    const pending=f.service.ingest('a',{...f.body,responseMode:'dialogue'});await started;f.service.close();finish('late response');
    const output=await pending;assert.equal(output.dialogue.status,'failed');assert.equal(output.dialogue.error,'perception_unavailable');assert.equal(readFileSync(f.k.path,'utf8').includes('late response'),false);
  }finally{f.done();}
});
