import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../../microkernel/src/canonical.js';
import { SceneLab } from '../src/scene.js';
import { createSceneServer } from '../src/scene-server.js';
import { buildChoiceForms, validateChoiceDeclaration } from '../src/choice-form.js';
const values={customerAlias:'demo-a',accountType:'daily',contactPreference:'none'},productId='demo.maps.v1';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'choice-forms-'));let scene=new SceneLab(join(dir,'core'),join(dir,'sink'));return {get scene(){return scene;},reopen(){scene.close();scene=new SceneLab(join(dir,'core'),join(dir,'sink'));},close(){scene.close();rmSync(dir,{recursive:true});}};}
const submission=(form,values)=>({formId:form.formId,binding:form.binding,values});
function account(f){f.scene.perceive({modality:'hearing',signal:'account-request'});return f.scene.state().choiceForms.account;}
function route(f){f.scene.subscribeCreature({productId});const sub=f.scene.state().market.subscriptions[0];f.scene.grantRoute({productId,enabled:true,expectedRevision:sub.revision});return f.scene.state().choiceForms.route;}
test('two forms share a closed declaration; reading/displaying never executes or grants',()=>{
 const f=fixture();try{
  assert.deepEqual(f.scene.state().choiceForms,{account:null,route:null,focus:null});
  const a=account(f);assert.equal(a.contractId,'synthetic-account.v1');assert.equal(a.binding.productId,null);assert.equal(a.fields.length,3);
  const r=route(f);assert.equal(r.contractId,'synthetic-route.v1');assert.equal(r.binding.context.creatureId,'work');assert.equal(r.binding.targetCreatureId,r.binding.instanceId);assert.equal(r.binding.activityId,null);
  assert.deepEqual(r.fields.map(v=>v.value),['A','C']);assert.deepEqual(r.fields[0].options.map(v=>v.value),f.scene.state().market.catalog[0].nodes);
  assert.equal(f.scene.state().market.requestCount,0);assert.equal(f.scene.state().activity.receipt,null);
  assert.equal(Object.isFrozen(a.fields[0].options),true);
  f.reopen();assert.deepEqual(f.scene.state().choiceForms,{account:a,route:r,focus:null});
 }finally{f.close();}
});
test('account save is task/context/revision-bound; hidden and terminal form cannot mutate',()=>{
 const f=fixture();try{
  const a=account(f);const updated=f.scene.updateChoiceForm(submission(a,values));assert.equal(updated.activity.revision,2);assert.notEqual(updated.choiceForms.account.formId,a.formId);
  assert.throws(()=>f.scene.updateChoiceForm(submission(a,values)),{code:'form_binding_conflict'});
  const current=updated.choiceForms.account;f.scene.selectCreature({creatureId:'companion'});f.scene.selectCreature({creatureId:'work'});
  assert.throws(()=>f.scene.updateChoiceForm(submission(current,values)),{code:'form_binding_conflict'});
  const beforeHide=f.scene.state().choiceForms.account;f.scene.visibility(false,{activityId:'task-1'});
  assert.equal(f.scene.state().choiceForms.account,null);assert.throws(()=>f.scene.updateChoiceForm(submission(beforeHide,values)),{code:'choice_form_unavailable'});
  f.scene.visibility(true,{activityId:'task-1'});f.scene.submit({activityId:'task-1',expectedRevision:2});
  const terminal=f.scene.state().choiceForms.account;assert.ok(terminal.fields.every(v=>v.readOnly));assert.throws(()=>f.scene.updateChoiceForm(submission(terminal,values)),{code:'choice_form_readonly'});
 }finally{f.close();}
});
test('route form refuses changed scene, instance and subscription generation before new execution',async()=>{
 const f=fixture();try{
  const r=route(f);assert.equal(r.binding.context.creatureId,'companion');
  await assert.rejects(async()=>f.scene.routeChoiceForm({...submission(r,{from:'A',to:'C'}),binding:{...r.binding,instanceId:'other'},requestId:'bad'}),{code:'form_binding_conflict'});
  let sub=f.scene.state().market.subscriptions[0];f.scene.grantRoute({productId,enabled:false,expectedRevision:sub.revision});
  assert.equal(f.scene.state().choiceForms.route,null);
  sub=f.scene.state().market.subscriptions[0];f.scene.grantRoute({productId,enabled:true,expectedRevision:sub.revision});
  assert.throws(()=>f.scene.routeChoiceForm({...submission(r,{from:'A',to:'C'}),requestId:'old-grant'}),{code:'form_binding_conflict'});
  const fresh=f.scene.state().choiceForms.route;f.scene.selectCreature({creatureId:'work'});f.scene.selectCreature({creatureId:'companion'});
  assert.throws(()=>f.scene.routeChoiceForm({...submission(fresh,{from:'A',to:'C'}),requestId:'old-context'}),{code:'form_binding_conflict'});
  assert.equal(f.scene.state().market.requestCount,0);
  const result=await f.scene.routeChoiceForm({...submission(f.scene.state().choiceForms.route,{from:'C',to:'A'}),requestId:'explicit'});
  assert.deepEqual(result.route.receipt.input,{from:'C',to:'A'});assert.equal(result.market.requestCount,1);
 }finally{f.close();}
});
test('exact submission rejects extra fields, unknown values and client-supplied options',()=>{
 const f=fixture();try{
  const a=account(f);
  for(const bad of [{...values,accountType:'real'},{...values,extra:'x'},{customerAlias:'demo-a'},[{id:'accountType',value:'daily'},{id:'accountType',value:'savings'}]])assert.throws(()=>f.scene.updateChoiceForm(submission(a,bad)),{code:'invalid_choice_values'});
  assert.throws(()=>f.scene.updateChoiceForm({...submission(a,values),options:['override']}),{code:'invalid_shape'});
  assert.equal(f.scene.state().activity.revision,1);
 }finally{f.close();}
});
test('closed declaration rejects duplicate/unknown fields, duplicate options and unknown component types',()=>{
 const f=fixture();try{
  const a=account(f);
  for(const mutate of [d=>d.fields.push(d.fields[0]),d=>d.fields[1].id=d.fields[0].id,d=>d.fields[0].id='execute',d=>d.fields[0].type='script',d=>d.fields[0].options.push(d.fields[0].options[0]),d=>d.fields[0].options[0].url='https://untrusted.example',d=>d.fields[0].value='unknown']){
   const d=structuredClone(a);mutate(d);d.formId='form-'+digest('choice-form-declaration',[d.contractId,d.contractVersion,d.binding,d.fields]).slice(7);assert.throws(()=>validateChoiceDeclaration(d));
  }
  const change=structuredClone(a);change.fields[0].label='不同标签';assert.throws(()=>validateChoiceDeclaration(change),{code:'invalid_choice_binding'});
  const ctx={creatureId:'work',sceneRevision:3},market=f.scene.state().market;
  const base={id:'fixed',revision:1,status:'draft',sceneVisible:true,values:{}};
  const first=buildChoiceForms({context:ctx,activity:base,market}).account;
  const second=buildChoiceForms({context:ctx,activity:{...base,values},market}).account;
  const terminal=buildChoiceForms({context:ctx,activity:{...base,status:'expired'},market}).account;
  assert.notEqual(first.formId,second.formId);assert.notEqual(first.formId,terminal.formId);
 }finally{f.close();}
});
test('real loopback HTTP exposes fixed form endpoints and conflicts; route needs explicit request',async()=>{
 const f=fixture(),server=createSceneServer(f.scene);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});
 try{
  const a=account(f),r=route(f);
  assert.equal((await fetch(base+'/scene/state')).status,200);assert.equal(f.scene.state().market.requestCount,0);
  const saved=await post('/scene/form-update',submission(a,values));assert.equal(saved.status,200);
  assert.equal((await post('/scene/form-update',submission(a,values))).status,409);
  assert.equal((await post('/scene/form-route',{...submission(r,{from:'A',to:'C'}),requestId:'stale'})).status,409);
  const current=f.scene.state().choiceForms.route;
  const routed=await post('/scene/form-route',{...submission(current,{from:'A',to:'C'}),requestId:'http-route'});assert.equal(routed.status,200);
  const body=await routed.json();assert.equal(body.route.receipt.source,'deterministic-synthetic-route');assert.equal(body.market.requestCount,1);
 }finally{await new Promise(r=>server.close(r));f.close();}
});

test('shared synthetic JSON fixture exactly matches generator; legitimate ordering changes require new digest',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/choice-forms.json',import.meta.url),'utf8'));
 assert.deepEqual(buildChoiceForms(fixture.input),fixture.choiceForms);
 for(const form of Object.values(fixture.choiceForms)){
  assert.deepEqual(validateChoiceDeclaration(form),form);
  const reordered=structuredClone(form);reordered.fields.reverse();reordered.fields[0].options.reverse();
  assert.throws(()=>validateChoiceDeclaration(reordered),{code:'invalid_choice_binding'});
  reordered.formId='form-'+digest('choice-form-declaration',[reordered.contractId,reordered.contractVersion,reordered.binding,reordered.fields]).slice(7);
  assert.notEqual(reordered.formId,form.formId);assert.deepEqual(validateChoiceDeclaration(reordered),reordered);
 }
});
