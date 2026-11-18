import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {SnapshotStore} from '../../microkernel/src/store.js';import {HostIdentity} from '../../microkernel/src/identity.js';
import {InteractionSession} from '../src/interaction-session.js';import {TextInteractionGeneration} from '../src/text-interaction-generation.js';import {compileInteractionProposal} from '../src/interaction-proposal.js';
const proposal=compileInteractionProposal({kind:'form',title:'Unfilled generated surface',fields:[{key:'body',label:'Text',type:'multiline',required:false}]});
const output={proposal,modelId:'fixture-not-model-proof'};
const req=(id='one')=>({commandId:id,context:{creatureId:'companion',sceneRevision:1},text:'synthetic-private-input-no-echo',confirmation:'generate-from-user-text'});
function fixture(options={},directory=null){
 const dir=directory??mkdtempSync(join(tmpdir(),'text-generation-'));let now=100,context={creatureId:'companion',sceneRevision:1},calls=0,impl=()=>Promise.resolve(output);
 let store=new SnapshotStore(join(dir,'core')),auth=new HostIdentity(),a=auth.authenticate('alice'),b=auth.authenticate('bob'),sessions,service;
 const planner={modelId:output.modelId,generate:(...args)=>{calls++;return impl(...args)}};
 const open=()=>{sessions=new InteractionSession(store,auth,{clock:()=>now,currentContext:()=>context});service=new TextInteractionGeneration(store,auth,sessions,{planner,currentContext:()=>context,clock:()=>now,...options});};open();
 return {dir,auth,a,b,get store(){return store},get sessions(){return sessions},get service(){return service},get calls(){return calls},impl:f=>impl=f,time:n=>now=n,context:v=>context=v,enable:(h=a)=>service.setEnabled(h,{enabled:true,expectedGeneration:0}),restart(){service.close();store.close();store=new SnapshotStore(join(dir,'core'));open();},replaceService(){service.close();open();},done(){service.close();store.close();if(!directory)rmSync(dir,{recursive:true,force:true})}};
}
const turn=()=>new Promise(r=>setImmediate(r));
if(process.argv[2]==='crash-worker'){
 const f=fixture({},process.argv[3]);f.enable();const point=process.argv[4];
 if(point==='admitted')f.impl(()=>{process.kill(process.pid,'SIGKILL')});
 if(point==='before-commit'){const original=f.store.command.bind(f.store);f.store.command=(...args)=>{const apply=args[3];args[3]=(...values)=>{const result=apply(...values);process.kill(process.pid,'SIGKILL');return result};return original(...args)};}
 await f.service.generate(f.a,req());process.kill(process.pid,'SIGKILL');
}else{
 test('disabled by default; exact completion/replay/conflict, empty form, owner isolation and private input not stored',async()=>{
  const f=fixture();try{
   await assert.rejects(f.service.generate(f.a,req()),{code:'text_generation_disabled'});assert.equal(f.calls,0);f.enable();
   const result=await f.service.generate(f.a,req());assert.equal(result.status,'completed');assert.equal(result.result.inputKind,'user-text');
   const view=f.sessions.read(f.a,{sessionId:result.result.creation.sessionId});assert.equal(view.draft.values.body,null);assert.deepEqual(Object.keys(view.source).sort(),['kind','modelId','referenceId']);assert.match(view.source.referenceId,/^textgen-/);
   assert.equal(readFileSync(join(f.dir,'core')).includes(Buffer.from(req().text)),false);
   assert.deepEqual(await f.service.generate(f.a,req()),result);assert.equal(f.calls,1);await assert.rejects(f.service.generate(f.a,{...req(),text:'changed'}),{code:'command_conflict'});
   assert.equal(f.service.query(f.b,{commandId:'one'}).status,'not_started');f.enable(f.b);assert.equal((await f.service.generate(f.b,req())).status,'completed');
   const next=await f.service.generate(f.a,req('new'));assert.equal(next.status,'completed');assert.notEqual(next.result.creation.sessionId,result.result.creation.sessionId);assert.deepEqual(f.sessions.read(f.a,{sessionId:view.sessionId}),view);
   f.restart();assert.deepEqual(await f.service.generate(f.a,req()),result);assert.equal(f.calls,3);
  }finally{f.done();}
 });
 test('independent generations preserve prior edited/saved sessions across success, failure, cancel, timeout and concurrent edit',async()=>{
  for(const mode of ['success','failure','cancel','timeout','concurrent-edit']){
   const f=fixture({ttlMs:mode==='timeout'?10:30000});let release;
   try{
    f.enable();
    const initial=await f.service.generate(f.a,req('initial'));const oldId=initial.result.creation.sessionId;
    f.sessions.edit(f.a,'edit-old',{sessionId:oldId,expectedRevision:1,changes:{body:'private prior draft'}});
    const saved=f.sessions.save(f.a,'save-old',{sessionId:oldId,expectedRevision:2,confirmation:'save-local-draft'});
    f.sessions.edit(f.a,'edit-after-save',{sessionId:oldId,expectedRevision:3,changes:{body:'unsaved newer draft'}});
    let old=f.sessions.read(f.a,{sessionId:oldId});const note=f.sessions.readSaved(f.a,{noteId:saved.ack.noteId});
    f.impl(()=>new Promise(r=>release=r));const pending=f.service.generate(f.a,req('new'));const outcome=pending.then(value=>({value}),error=>({error}));await turn();
    if(mode==='concurrent-edit'){f.sessions.edit(f.a,'concurrent-edit',{sessionId:oldId,expectedRevision:old.revision,changes:{body:'user edited old while new generates'}});old=f.sessions.read(f.a,{sessionId:oldId});}
    if(mode==='cancel')assert.equal(f.service.cancel(f.a,{commandId:'new'}).status,'cancelled');
    if(mode==='timeout'){const result=await outcome;assert.ok(result.error);assert.equal(f.service.query(f.a,{commandId:'new'}).status,'expired');}
    release(mode==='failure'?{...output,proposal:{...proposal,authorityGranted:true}}:output);
    const result=await outcome;await turn();
    assert.deepEqual(f.sessions.read(f.a,{sessionId:oldId}),old);
    assert.deepEqual(f.sessions.readSaved(f.a,{noteId:saved.ack.noteId}),note);
    assert.equal(f.sessions.query(f.a,{commandId:'save-old'}).ack.noteId,note.noteId);
    if(['success','concurrent-edit'].includes(mode)){
     assert.equal(result.value.status,'completed');const fresh=f.sessions.read(f.a,{sessionId:result.value.result.creation.sessionId});assert.equal(fresh.draft.values.body,null);assert.equal(fresh.saveCount,0);assert.equal(fresh.lastNoteId,null);assert.equal(f.sessions.currentReference(f.a).sessionId,fresh.sessionId);
    }else{assert.ok(result.error);assert.equal(f.sessions.currentReference(f.a).sessionId,oldId);}
   }finally{if(release)release(output);f.done();}
  }
 });
 test('cancel is terminal and single flight stays locked until uncooperative planner actually settles',async()=>{
  const f=fixture();let finish;try{f.enable();f.impl(()=>new Promise(r=>finish=r));const pending=f.service.generate(f.a,req());const failure=assert.rejects(pending,{code:'text_generation_cancelled'});await turn();assert.equal(f.service.query(f.a,{commandId:'one'}).status,'running');assert.equal(f.service.cancel(f.a,{commandId:'one'}).status,'cancelled');await failure;await assert.rejects(f.service.generate(f.a,req('two')),{code:'text_planner_busy'});finish(output);await turn();assert.equal(f.sessions.currentReference(f.a),null);assert.equal((await f.service.generate(f.a,req())).status,'cancelled');assert.equal(f.calls,1);}finally{f.done();}
 });
 test('context ABA, policy generation changes, revoked owner and TTL all reject late inference',async()=>{
  for(const mode of ['context','policy','revoke','expiry']){const f=fixture();let finish;try{f.enable();f.impl(()=>new Promise(r=>finish=r));const pending=f.service.generate(f.a,req());const fail=assert.rejects(pending);await turn();
   if(mode==='context')f.context({creatureId:'companion',sceneRevision:3});if(mode==='policy')f.service.setEnabled(f.a,{enabled:false,expectedGeneration:1});if(mode==='revoke')f.auth.revoke('alice');if(mode==='expiry')f.time(30100);
   finish(output);await fail;assert.equal(f.sessions.currentReference(mode==='revoke'?f.auth.authenticate('alice'):f.a),null);
   if(mode==='expiry'){f.time(1);assert.equal(f.service.query(f.a,{commandId:'one'}).status,'expired');}
  }finally{f.done();}}
 });
 test('restart interrupts unresolved attempts without recount, retains shared single-flight lock in process',async()=>{
  const f=fixture();let finish;try{f.enable();f.impl(()=>new Promise(r=>finish=r));const pending=f.service.generate(f.a,req());const fail=assert.rejects(pending);await turn();f.replaceService();await fail;assert.equal(f.service.query(f.a,{commandId:'one'}).status,'interrupted');await assert.rejects(f.service.generate(f.a,req('two')),{code:'text_planner_busy'});finish(output);await turn();assert.equal((await f.service.generate(f.a,req())).status,'interrupted');assert.equal(f.calls,1);}finally{f.done();}
 });
 test('clarify/none are bounded terminal receipts; cap never evicts and queries never infer',async()=>{
  const f=fixture({maxAttempts:2});try{f.enable();f.impl(()=>({proposal:compileInteractionProposal({kind:'clarify',question:'Which fields?'}),modelId:output.modelId}));assert.equal((await f.service.generate(f.a,req())).result.kind,'clarify');f.impl(()=>({proposal:compileInteractionProposal({kind:'none',reason:'No surface needed'}),modelId:output.modelId}));assert.equal((await f.service.generate(f.a,req('two'))).result.kind,'none');await assert.rejects(f.service.generate(f.a,req('three')),{code:'text_attempt_capacity'});assert.equal(f.calls,2);assert.equal(f.service.query(f.a,{commandId:'one'}).status,'completed');assert.equal(f.sessions.currentReference(f.a),null);}finally{f.done();}
 });
 test('attempt completion and session/command write rollback together on after-write failure',async()=>{
  const f=fixture();try{f.enable();const original=f.store.command.bind(f.store);f.store.command=(...args)=>{const apply=args[3];args[3]=(...values)=>{apply(...values);throw Object.assign(Error('injected'),{code:'injected_after_write'})};return original(...args)};await assert.rejects(f.service.generate(f.a,req()),{code:'text_generation_failed'});assert.equal(f.sessions.currentReference(f.a),null);assert.equal(f.service.query(f.a,{commandId:'one'}).status,'failed');}finally{f.done();}
 });
 test('policy revocation inside context callback is rechecked before planner dispatch',async()=>{
  let f,checks=0;f=fixture({currentContext:()=>{if(++checks===2)f.service.setEnabled(f.a,{enabled:false,expectedGeneration:1});return req().context;}});
  try{f.enable();await assert.rejects(f.service.generate(f.a,req()),{code:'text_generation_cancelled'});assert.equal(f.calls,0);assert.equal(f.service.query(f.a,{commandId:'one'}).status,'cancelled');}finally{f.done();}
 });
 test('expiry immediately before adapter invocation never calls planner',async()=>{
  let n=0;const f=fixture({clock:()=>++n===1?100:30100});try{f.enable();await assert.rejects(f.service.generate(f.a,req()));assert.equal(f.calls,0);assert.equal(f.service.query(f.a,{commandId:'one'}).status,'expired');}finally{f.done();}
 });
 test('planner errors never persist or echo arbitrary message or code',async()=>{
  const f=fixture();try{f.enable();f.impl(()=>{throw Object.assign(Error(req().text),{code:req().text})});await assert.rejects(f.service.generate(f.a,req()),error=>error.code==='text_generation_failed'&&error.message==='text_generation_failed');assert.equal(f.service.query(f.a,{commandId:'one'}).reason,'text_generation_failed');assert.equal(readFileSync(join(f.dir,'core')).includes(Buffer.from(req().text)),false);}finally{f.done();}
 });
 test('expiry observed inside create composition rolls back and remains latched after clock rollback',async()=>{
  let times=[100,100,100,100,30100];const f=fixture({clock:()=>times.length?times.shift():1});try{f.enable();await assert.rejects(f.service.generate(f.a,req()),{code:'text_attempt_expired'});assert.equal(f.sessions.currentReference(f.a),null);assert.equal(f.service.query(f.a,{commandId:'one'}).status,'expired');assert.equal(f.service.state(f.a).attemptCount,1);}finally{f.done();}
 });
 test('final context callback crossing TTL cannot commit a session or completed attempt',async()=>{
  let calls=0,f;f=fixture({currentContext:()=>{if(++calls===5)f.time(30100);return req().context;}});
  try{f.enable();await assert.rejects(f.service.generate(f.a,req()),{code:'text_attempt_expired'});assert.equal(f.sessions.currentReference(f.a),null);assert.equal(f.service.query(f.a,{commandId:'one'}).status,'expired');f.time(1);assert.equal(f.service.query(f.a,{commandId:'one'}).status,'expired');}finally{f.done();}
 });
 test('invalid proposal cannot create or save, and actual deadline terminates waiting without unlocking inference',async()=>{
  const f=fixture({ttlMs:10});let finish;try{f.enable();f.impl(()=>new Promise(r=>finish=r));await assert.rejects(f.service.generate(f.a,req()),{code:'text_generation_cancelled'});assert.equal(f.service.query(f.a,{commandId:'one'}).status,'expired');await assert.rejects(f.service.generate(f.a,req('two')),{code:'text_planner_busy'});finish(output);await turn();f.impl(()=>({...output,proposal:{...proposal,authorityGranted:true}}));await assert.rejects(f.service.generate(f.a,req('two')),{code:'invalid_text_proposal'});assert.equal(f.sessions.currentReference(f.a),null);assert.equal(f.service.query(f.a,{commandId:'two'}).status,'failed');}finally{f.done();}
 });
 test('create composition hooks reject extra keys/accessors/async without side effects',()=>{
  const f=fixture();try{const spec={sessionId:'manual',context:req().context,program:proposal.program,source:{kind:'host-declaration',referenceId:'fixture',modelId:null}};
   for(const hooks of [{extra:true},{before:async()=>null},Object.defineProperty({},'before',{get(){throw Error('accessor ran')},enumerable:true})])assert.throws(()=>f.sessions.createComposed(f.a,'manual',spec,hooks),{code:'invalid_interaction_hook'});
   assert.throws(()=>f.sessions.createComposed(f.a,'manual',spec,{after:()=>Promise.reject(Error('not sync'))}),{code:'invalid_interaction_hook_result'});assert.equal(f.sessions.currentReference(f.a),null);assert.equal(f.sessions.query(f.a,{commandId:'manual'}).status,'not_started');
  }finally{f.done();}
 });
 for(const point of ['admitted','before-commit','after-commit'])test('SIGKILL '+point+' preserves exact durable attempt meaning',()=>{
  const dir=mkdtempSync(join(tmpdir(),'text-crash-'));try{const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'crash-worker',dir,point]);assert.equal(child.signal,'SIGKILL');const f=fixture({},dir);try{const view=f.service.query(f.a,{commandId:'one'});assert.equal(view.status,point==='after-commit'?'completed':'interrupted');assert.equal(f.calls,0);assert.equal(f.sessions.currentReference(f.a)!==null,point==='after-commit');}finally{f.done();}}finally{rmSync(dir,{recursive:true,force:true});}
 });
}
