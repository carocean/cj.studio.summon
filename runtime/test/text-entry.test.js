import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SceneLab} from '../src/scene.js';
import {createSceneServer} from '../src/scene-server.js';
import {hearingSceneCandidate} from '../src/scene-intent.js';
const make=()=>{const dir=mkdtempSync(join(tmpdir(),'text-entry-'));let scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));return {dir,get scene(){return scene;},reopen(){scene.close();scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));},close(){scene.close();rmSync(dir,{recursive:true,force:true});}};};
const command=(state,text)=>({context:state.context,text,confirmation:'apply-direct-text-scene'});
test('finite explicit input request; no negation, quotation, OCR or broader language inference',()=>{
 for(const text of ['我要输入','我要打字。','打开文字输入','改用文字'])assert.equal(hearingSceneCandidate(text),'text-entry-request');
 for(const text of ['不要我要输入','他说我要输入','“我要输入”','如果我要输入','我要输入并开户',null,'x'.repeat(4001)])assert.equal(hearingSceneCandidate(text),null);
});
test('no default editor; explicit declaration bound to current creature, no sensory grant or raw-text persistence',()=>{
 const f=make();try{
  assert.equal(f.scene.state().textEntry,undefined);
  for(const modality of ['hearing','vision'])f.scene.creatureSense({creatureId:'companion',modality,enabled:false,expectedRevision:f.scene.state().registryRevision});
  let state=f.scene.textEntry({context:f.scene.state().context,visible:true});
  assert.deepEqual(state.textEntry,{schema:'scene-text-entry.v1',context:state.context,maxLength:200,source:'deterministic-policy'});
  const privateText='private-unrecognized-note-DO-NOT-STORE';
  assert.throws(()=>f.scene.textRequest(command(state,privateText)),{code:'unsupported_text_request'});
  assert.deepEqual(f.scene.state().textEntry,state.textEntry);
  assert.throws(()=>f.scene.textRequest(command(state,'不许开始工作')),{code:'unsupported_text_request'});
  assert.throws(()=>f.scene.textRequest(command(state,'x'.repeat(201))),{code:'invalid_text_request'});
  assert.throws(()=>f.scene.textRequest({...command(state,'开始工作'),confirmation:'yes'}),{code:'text_confirmation_required'});
  const raw='  打开模拟开户表单  ';
  const done=f.scene.textRequest(command(state,raw));
  assert.equal(done.activeCreatureId,'work');assert.equal(done.activity.status,'draft');assert.equal(done.activity.receipt,null);assert.equal(done.textEntry,undefined);
  assert.throws(()=>f.scene.textRequest(command(state,raw)),{code:'sensory_context_changed'});
  f.reopen();assert.equal(f.scene.state().activity.status,'draft');assert.equal(f.scene.state().textEntry,undefined);
  const bytes=readFileSync(join(f.dir,'core.sqlite'));for(const text of [privateText,raw])assert.equal(bytes.includes(Buffer.from(text)),false);
  assert.ok(bytes.includes(Buffer.from('direct-user-request')));
 }finally{f.close();}
});
test('close, creature switch and stale ABA reject old drafts without replacing saved business state',()=>{
 const f=make();try{
  const first=f.scene.textEntry({context:f.scene.state().context,visible:true});
  f.scene.textEntry({context:first.context,visible:false});
  assert.throws(()=>f.scene.textRequest(command(f.scene.state(),'开始工作')),{code:'text_entry_unavailable'});
  assert.throws(()=>f.scene.textEntry({context:first.context,visible:true}),{code:'sensory_context_changed'});
  const next=f.scene.textEntry({context:f.scene.state().context,visible:true});
  f.scene.selectCreature({creatureId:'work'});f.scene.selectCreature({creatureId:'companion'});
  assert.equal(f.scene.state().textEntry,undefined);assert.throws(()=>f.scene.textRequest(command(next,'模拟开户')),{code:'sensory_context_changed'});
 }finally{f.close();}
});
test('actual HTTP on-demand declaration -> explicit text -> generated synthetic form, no default chat',async()=>{
 const f=make(),server=createSceneServer(f.scene);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(path,body)=>{const r=await fetch(base+'/scene/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{
  const initial=await(await fetch(base+'/scene/state')).json();assert.equal(initial.textEntry,undefined);
  const opened=await post('text-entry',{context:initial.context,visible:true});assert.equal(opened.status,200);
  const unknown=await post('text-request',command(opened.body,'帮我做所有事情'));assert.equal(unknown.status,400);assert.equal(unknown.body.error,'unsupported_text_request');
  const applied=await post('text-request',command(opened.body,'模拟开户'));assert.equal(applied.status,200);
  assert.equal(applied.body.presentation.surface,'synthetic-account');assert.equal(applied.body.textEntry,undefined);assert.equal(applied.body.choiceForms.account.fields.length,3);assert.equal(applied.body.activity.receipt,null);
 }finally{await new Promise(r=>server.close(r));f.close();}
});
