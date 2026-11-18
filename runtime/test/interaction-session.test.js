import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SnapshotStore} from '../../microkernel/src/store.js';
import {HostIdentity} from '../../microkernel/src/identity.js';
import {digest} from '../../microkernel/src/canonical.js';
import {compileInteractionProgram} from '../src/interaction-program.js';
import {InteractionSession} from '../src/interaction-session.js';
const declaration={schema:'temporary-interaction.v1',title:'My temporary note',fields:[{id:'body',label:'Note',type:'multiline',required:true,maxLength:500}],save:{primitive:'local-draft.save'}};
const program=compileInteractionProgram(declaration),source={kind:'host-declaration',referenceId:'request-one',modelId:null};
const saveRequest={sessionId:'one',expectedRevision:2,confirmation:'save-local-draft'};
const key=(kind,owner,extra='')=>'interaction-'+kind+'.'+digest('interaction-key',[owner,extra]).slice(7,55);
function fixture(existingDir=null){
 const dir=existingDir??mkdtempSync(join(tmpdir(),'interaction-session-'));let store,host,now=100,current={creatureId:'companion',sceneRevision:1};
 const auth=new HostIdentity(),alice=auth.authenticate('alice'),bob=auth.authenticate('bob');
 const open=()=>{store=new SnapshotStore(join(dir,'core'));host=new InteractionSession(store,auth,{currentContext:()=>current,clock:()=>now,ttlMs:1000});};open();
 return {dir,auth,alice,bob,get store(){return store;},get host(){return host;},get current(){return current;},context(v){current=v;},time(v){now=v;},reopen(){store.close();open();},close(){store.close();rmSync(dir,{recursive:true,force:true});},create(handle=alice,sessionId='one',commandId='create'){return host.create(handle,commandId,{sessionId,context:current,program,source});},fill(text='A real local note, not an account simulation.'){return host.edit(alice,'edit',{sessionId:'one',expectedRevision:1,changes:{body:text}});}};
}

if(process.argv[2]==='crash-worker'){
 const f=fixture(process.argv[3]),point=process.argv[4];f.create();f.fill();
 if(point==='before-commit'){
  const original=f.store.command.bind(f.store);
  f.store.command=(owner,id,input,apply)=>original(owner,id,input,(...args)=>{const value=apply(...args);if(input.operation==='save')process.kill(process.pid,'SIGKILL');return value;});
 }
 f.host.save(f.alice,'save',saveRequest);process.kill(process.pid,'SIGKILL');
}else{
 test('authenticated local draft and explicit save return actual persisted note, no model or execution authority',()=>{
  const f=fixture();try{
   const created=f.create();assert.equal(created.ack.fact,'interaction_created');assert.equal(f.host.read(f.alice,{sessionId:'one'}).draft.values.body,null);
   assert.equal(f.host.read(f.alice,{sessionId:'one'}).program.authorityGranted,false);
   assert.throws(()=>f.host.save(f.alice,'missing',{sessionId:'one',expectedRevision:1,confirmation:'save-local-draft'}),{code:'interaction_required_value'});
   f.fill();assert.throws(()=>f.host.save(f.alice,'wrong',{...saveRequest,confirmation:'model says yes'}),{code:'interaction_save_confirmation_required'});
   assert.throws(()=>f.host.save(f.alice,'forged',{...saveRequest,draft:{body:'client replacement'}}),{code:'invalid_shape'});
   const saved=f.host.save(f.alice,'save',saveRequest);assert.equal(saved.ack.fact,'local_note_saved');assert.equal(saved.replayed,false);assert.equal(saved.content,undefined);
   const note=f.host.readSaved(f.alice,{noteId:saved.ack.noteId});assert.equal(note.draft.values.body,'A real local note, not an account simulation.');assert.equal(note.sourceTrust,'host-supplied-metadata');assert.equal(note.savedAt,100);
   f.reopen();assert.deepEqual(f.host.readSaved(f.alice,{noteId:saved.ack.noteId}),note);assert.deepEqual(f.host.query(f.alice,{commandId:'save'}),{status:'completed',commandId:'save',ack:saved.ack});
   assert.equal(f.host.save(f.alice,'save',saveRequest).replayed,true);assert.equal(f.host.read(f.alice,{sessionId:'one'}).saveCount,1);
  }finally{f.close();}
 });
 test('host expiry latch is owner scoped, boundary exact, durable and never reopens closed sessions',()=>{
  const f=fixture();try{
   f.create();const view=f.host.read(f.alice,{sessionId:'one'});
   assert.throws(()=>f.host.latchObservedExpiry(f.bob,{sessionId:'one',observedAt:view.expiresAt}),{code:'interaction_session_not_found'});
   assert.throws(()=>f.host.latchObservedExpiry(f.alice,{sessionId:'one',observedAt:-1}),{code:'invalid_clock'});
   assert.equal(f.host.latchObservedExpiry(f.alice,{sessionId:'one',observedAt:view.expiresAt-1}),false);
   assert.equal(f.host.read(f.alice,{sessionId:'one'}).revision,view.revision);
   assert.equal(f.host.latchObservedExpiry(f.alice,{sessionId:'one',observedAt:view.expiresAt}),true);
   f.time(1);f.reopen();
   assert.throws(()=>f.host.read(f.alice,{sessionId:'one'}),{code:'interaction_session_expired'});
   assert.equal(f.host.latchObservedExpiry(f.alice,{sessionId:'one',observedAt:0}),false);
   f.create(f.alice,'closed','create-closed');
   f.host.close(f.alice,'close',{sessionId:'closed',expectedRevision:1});
   assert.equal(f.host.latchObservedExpiry(f.alice,{sessionId:'closed',observedAt:999999}),false);
   assert.throws(()=>f.host.read(f.alice,{sessionId:'closed'}),{code:'interaction_session_closed'});
   f.auth.revoke('alice');assert.throws(()=>f.host.latchObservedExpiry(f.alice,{sessionId:'one',observedAt:view.expiresAt}),{code:'unauthenticated'});
  }finally{f.close();}
 });
 test('owners share neither session IDs nor command results; foreign and revoked handles fail',()=>{
  const f=fixture();try{
   f.create();f.fill('Alice only');const saved=f.host.save(f.alice,'save',saveRequest);
   assert.throws(()=>f.host.read(f.bob,{sessionId:'one'}),{code:'interaction_session_not_found'});assert.deepEqual(f.host.query(f.bob,{commandId:'save'}),{status:'not_started',commandId:'save'});
   assert.throws(()=>f.host.readSaved(f.bob,{noteId:saved.ack.noteId}),{code:'interaction_note_not_found'});
   f.create(f.bob);assert.equal(f.host.read(f.bob,{sessionId:'one'}).draft.values.body,null);
   assert.throws(()=>f.host.read(new HostIdentity().authenticate('alice'),{sessionId:'one'}),{code:'unauthenticated'});
   assert.throws(()=>f.host.assertDomain(f.store,new HostIdentity()),{code:'interaction_domain_mismatch'});
   f.auth.revoke('alice');assert.throws(()=>f.host.query(f.alice,{commandId:'save'}),{code:'unauthenticated'});assert.throws(()=>f.host.readSaved(f.alice,{noteId:saved.ack.noteId}),{code:'unauthenticated'});
  }finally{f.close();}
 });
 test('CAS uses current database draft; stale writes/changed command replay never substitute client content',()=>{
  const f=fixture();try{
   f.create();const edited=f.fill('current');
   assert.equal(f.fill('current').replayed,true);
   assert.throws(()=>f.fill('different replay'),{code:'command_conflict'});
   assert.throws(()=>f.host.edit(f.alice,'late',{sessionId:'one',expectedRevision:1,changes:{body:'late'}}),{code:'interaction_revision_conflict'});
   assert.throws(()=>f.host.save(f.alice,'stale',{...saveRequest,expectedRevision:1}),{code:'interaction_revision_conflict'});
   assert.equal(f.host.query(f.alice,{commandId:'stale'}).status,'not_started');
   assert.equal(f.host.read(f.alice,{sessionId:'one'}).revision,edited.ack.revision);
   assert.throws(()=>f.host.edit(f.alice,'edit',{sessionId:'one',expectedRevision:1,changes:{body:'current'},programDigest:'fake'}),{code:'invalid_shape'});
   const saved=f.host.save(f.alice,'save',saveRequest);assert.equal(f.host.readSaved(f.alice,{noteId:saved.ack.noteId}).draft.values.body,'current');
  }finally{f.close();}
 });
 test('host revision preserves entered values, rejects incompatible model replacement and records metadata only as description',()=>{
  const f=fixture();try{
   f.create();f.fill('Keep my words');const proposal={...declaration,title:'Expanded note',fields:[...declaration.fields,{id:'tag',label:'Tag',type:'text',required:false,maxLength:30}]};
   const request={sessionId:'one',expectedRevision:2,proposal,moves:[],source:{kind:'model-proposal',referenceId:'attempt-two',modelId:'local-model-description-not-attestation'}};
   const revised=f.host.revise(f.alice,'revise',request);const current=f.host.read(f.alice,{sessionId:'one'});
   assert.equal(current.draft.values.body,'Keep my words');assert.equal(current.draft.values.tag,null);assert.equal(current.program.revision,2);assert.equal(current.program.semanticsVerified,false);assert.equal(current.revision,revised.ack.revision);
   assert.throws(()=>f.host.revise(f.alice,'discard',{...request,expectedRevision:current.revision,proposal:{...proposal,fields:[proposal.fields[1]]}}),{code:'interaction_value_would_be_lost'});
   assert.equal(f.host.query(f.alice,{commandId:'discard'}).status,'not_started');assert.equal(f.host.read(f.alice,{sessionId:'one'}).draft.values.body,'Keep my words');
   assert.throws(()=>f.host.revise(f.alice,'metadata',{...request,source:{...request.source,llmUsed:true}}),{code:'invalid_shape'});
   assert.equal(f.host.revise(f.alice,'revise',request).replayed,true);
  }finally{f.close();}
 });
 test('closing presentation blocks late edits but never deletes saved notes or historical receipt queries',()=>{
  const f=fixture();try{
   f.create();f.fill();const saved=f.host.save(f.alice,'save',saveRequest),closed=f.host.close(f.alice,'close',{sessionId:'one',expectedRevision:saved.ack.revision});
   assert.equal(closed.ack.fact,'interaction_presentation_closed');
   assert.throws(()=>f.host.read(f.alice,{sessionId:'one'}),{code:'interaction_session_closed'});
   assert.throws(()=>f.host.edit(f.alice,'late',{sessionId:'one',expectedRevision:closed.ack.revision,changes:{body:'late'}}),{code:'interaction_session_closed'});
   assert.throws(()=>f.host.save(f.alice,'new',{...saveRequest,expectedRevision:closed.ack.revision}),{code:'interaction_session_closed'});
   f.context({creatureId:'other',sceneRevision:2});f.time(5000);f.reopen();
   assert.equal(f.host.query(f.alice,{commandId:'save'}).ack.noteId,saved.ack.noteId);assert.equal(f.host.save(f.alice,'save',saveRequest).replayed,true);
   assert.ok(f.host.readSaved(f.alice,{noteId:saved.ack.noteId}).draft.values.body);
   assert.equal(f.host.create(f.alice,'create',{sessionId:'one',context:{creatureId:'companion',sceneRevision:1},program,source}).replayed,true);
   assert.throws(()=>f.create(),{code:'command_conflict'});
   assert.throws(()=>f.create(f.alice,'one','recreate'),{code:'interaction_session_exists'});
  }finally{f.close();}
 });
 test('observed expiry locks before rejected operations and survives clock rollback; query never resumes anything',()=>{
  const f=fixture();try{
   f.create();f.fill();f.time(1100);
   assert.throws(()=>f.host.save(f.alice,'save',saveRequest),{code:'interaction_session_expired'});
   assert.equal(f.host.query(f.alice,{commandId:'save'}).status,'not_started');
   f.time(100);f.reopen();assert.throws(()=>f.host.read(f.alice,{sessionId:'one'}),{code:'interaction_session_expired'});
   assert.throws(()=>f.host.save(f.alice,'retry',{...saveRequest,expectedRevision:3}),{code:'interaction_session_expired'});assert.equal(f.host.query(f.alice,{commandId:'retry'}).status,'not_started');
   assert.equal(f.host.query(f.alice,{commandId:'edit'}).ack.fact,'interaction_draft_updated');
  }finally{f.close();}
 });
 test('context invalidation latches on observation and monotonic revisions reveal ABA even without a sweep',()=>{
  const f=fixture();try{
   f.create();f.fill();f.context({creatureId:'work',sceneRevision:2});
   assert.throws(()=>f.host.read(f.alice,{sessionId:'one'}),{code:'interaction_context_changed'});
   f.context({creatureId:'companion',sceneRevision:1});f.reopen();assert.throws(()=>f.host.read(f.alice,{sessionId:'one'}),{code:'interaction_context_changed'});
   f.create(f.alice,'second','create-second');f.context({creatureId:'work',sceneRevision:2});f.context({creatureId:'companion',sceneRevision:3});
   assert.throws(()=>f.host.edit(f.alice,'aba',{sessionId:'second',expectedRevision:1,changes:{body:'late'}}),{code:'interaction_context_changed'});
   assert.equal(f.host.query(f.alice,{commandId:'aba'}).status,'not_started');
  }finally{f.close();}
 });
 test('closed host configuration and create metadata forbid client execution or media claims',()=>{
  const f=fixture();try{
   assert.throws(()=>new InteractionSession(f.store,f.auth,{currentContext:async()=>f.current}),{code:'invalid_interaction_host'});
   assert.throws(()=>new InteractionSession(f.store,f.auth,{currentContext:()=>f.current,ttlMs:0}),{code:'invalid_interaction_host'});
   for(const patch of [{source:{...source,transcript:'secret'}},{source:{...source,llmUsed:true}},{context:{creatureId:'other',sceneRevision:1}},{url:'https://external.invalid'}])assert.throws(()=>f.host.create(f.alice,'bad',{sessionId:'one',context:f.current,program,source,...patch}));
   assert.equal(f.host.query(f.alice,{commandId:'bad'}).status,'not_started');
   const modelSource={kind:'model-proposal',referenceId:'model-attempt',modelId:'Qwen3-4B Local ASCII 2026'};
   f.host.create(f.alice,'model',{sessionId:'model',context:f.current,program,source:modelSource});
   assert.equal(f.host.read(f.alice,{sessionId:'model'}).source.modelId,modelSource.modelId);
   for(const code of [...Array(32).keys(),127])assert.throws(()=>f.host.create(f.alice,'control',{sessionId:'control',context:f.current,program,source:{...modelSource,modelId:'model'+String.fromCharCode(code)}}),{code:'invalid_interaction_source'});
   f.time(Number.MAX_SAFE_INTEGER);assert.throws(()=>f.create(),{code:'invalid_clock'});
  }finally{f.close();}
 });
 test('session, note, mutation and command capacities bound persistent growth without dropping existing notes',()=>{
  const f=fixture();try{
   for(let i=0;i<16;i++)f.create(f.alice,'s'+i,'c'+i);assert.throws(()=>f.create(f.alice,'overflow','overflow'),{code:'interaction_session_capacity'});
   for(let i=0;i<32;i++)f.host.edit(f.alice,'e'+i,{sessionId:'s0',expectedRevision:i+1,changes:{body:'value-'+i}});
   assert.throws(()=>f.host.edit(f.alice,'e-over',{sessionId:'s0',expectedRevision:33,changes:{body:'x'}}),{code:'interaction_change_capacity'});
   let first;for(let i=0;i<64;i++){const result=f.host.save(f.alice,'s-save'+i,{sessionId:'s0',expectedRevision:33+i,confirmation:'save-local-draft'});first??=result.ack;}
   assert.throws(()=>f.host.save(f.alice,'save-over',{sessionId:'s0',expectedRevision:97,confirmation:'save-local-draft'}),{code:'interaction_note_capacity'});
   assert.equal(f.host.readSaved(f.alice,{noteId:first.noteId}).draft.values.body,'value-31');
   f.store.transaction(tx=>{const k=key('index','alice'),r=tx.get(k);tx.put(k,'interaction-index',{...r.value,commandCount:1024},r.revision);return null;});
   assert.throws(()=>f.host.close(f.alice,'quota-close',{sessionId:'s0',expectedRevision:97}),{code:'interaction_command_capacity'});
   assert.equal(f.host.query(f.alice,{commandId:'s-save0'}).status,'completed');
  }finally{f.close();}
 });
 test('exception after all note writes but before commit rolls back note, session revision and command receipt together',()=>{
  const f=fixture();try{
   f.create();f.fill();const command=f.store.command.bind(f.store);
   f.store.command=(owner,id,input,apply)=>command(owner,id,input,(...args)=>{const result=apply(...args);if(input.operation==='save')throw Error('after writes, before commit');return result;});
   assert.throws(()=>f.host.save(f.alice,'save',saveRequest),/after writes/);f.store.command=command;
   assert.equal(f.host.query(f.alice,{commandId:'save'}).status,'not_started');assert.equal(f.host.read(f.alice,{sessionId:'one'}).revision,2);assert.equal(f.host.read(f.alice,{sessionId:'one'}).saveCount,0);
   const noteId='note-'+digest('interaction-note',['alice','save']).slice(7,55);assert.throws(()=>f.host.readSaved(f.alice,{noteId}),{code:'interaction_note_not_found'});
   f.reopen();const saved=f.host.save(f.alice,'save',saveRequest);assert.equal(saved.replayed,false);assert.equal(saved.ack.noteId,noteId);assert.equal(f.host.read(f.alice,{sessionId:'one'}).saveCount,1);
  }finally{f.close();}
 });
 for(const stage of ['context','clock'])test('create rolls back when '+stage+' callback revokes owner after initial authentication',()=>{
  const f=fixture();try{
   let armed=true;
   const revoke=()=>{if(armed){armed=false;f.auth.revoke('alice');}};
   const host=new InteractionSession(f.store,f.auth,{currentContext:()=>{if(stage==='context')revoke();return f.current;},clock:()=>{if(stage==='clock')revoke();return 100;}});
   const request={sessionId:'one',context:f.current,program,source};
   assert.throws(()=>host.create(f.alice,'create',request),{code:'unauthenticated'});
   assert.equal(f.store.get(key('session','alice','one')),null);assert.equal(f.store.get(key('index','alice')),null);
   const fresh=f.auth.authenticate('alice');assert.equal(host.query(fresh,{commandId:'create'}).status,'not_started');
   f.reopen();assert.equal(f.host.query(fresh,{commandId:'create'}).status,'not_started');
   assert.equal(f.host.create(fresh,'create',request).replayed,false);assert.equal(f.host.read(fresh,{sessionId:'one'}).status,'open');
  }finally{f.close();}
 });
 for(const stage of ['context','clock'])for(const action of ['read','save'])test(action+' cannot disclose or latch invalidation after '+stage+' callback revokes owner',()=>{
  const f=fixture();try{
   let armed=false;
   const host=new InteractionSession(f.store,f.auth,{ttlMs:1000,
    currentContext:()=>{if(armed&&stage==='context'){armed=false;f.auth.revoke('alice');return {creatureId:'changed',sceneRevision:2};}return f.current;},
    clock:()=>{if(armed&&stage==='clock'){armed=false;f.auth.revoke('alice');return 1100;}return 100;},
   });
   host.create(f.alice,'create',{sessionId:'one',context:f.current,program,source});host.edit(f.alice,'edit',{sessionId:'one',expectedRevision:1,changes:{body:'unchanged'}});
   armed=true;assert.throws(()=>action==='read'?host.read(f.alice,{sessionId:'one'}):host.save(f.alice,'save',saveRequest),{code:'unauthenticated'});
   const record=f.store.get(key('session','alice','one'));assert.equal(record.revision,2);assert.equal(record.value.status,'open');assert.equal(record.value.saveCount,0);
   const fresh=f.auth.authenticate('alice');assert.equal(host.query(fresh,{commandId:'save'}).status,'not_started');assert.equal(host.read(fresh,{sessionId:'one'}).draft.values.body,'unchanged');
   f.reopen();assert.equal(f.host.read(fresh,{sessionId:'one'}).revision,2);
  }finally{f.close();}
 });
 for(const point of ['before-commit','after-commit'])test('actual SIGKILL '+point+' recovers original save identity and never auto-saves on query',()=>{
  const dir=mkdtempSync(join(tmpdir(),'interaction-save-kill-'));let f;
  try{
   const exit=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'crash-worker',dir,point],{encoding:'utf8',timeout:10000});assert.equal(exit.signal,'SIGKILL',exit.stderr);assert.equal(exit.status,null);
   f=fixture(dir);const query=f.host.query(f.alice,{commandId:'save'});assert.equal(query.status,point==='before-commit'?'not_started':'completed');assert.equal(f.host.read(f.alice,{sessionId:'one'}).saveCount,point==='before-commit'?0:1);
   const recovered=f.host.save(f.alice,'save',saveRequest);assert.equal(recovered.replayed,point==='after-commit');assert.equal(f.host.readSaved(f.alice,{noteId:recovered.ack.noteId}).draft.values.body,'A real local note, not an account simulation.');assert.equal(f.host.read(f.alice,{sessionId:'one'}).saveCount,1);
   assert.equal(f.host.save(f.alice,'save',saveRequest).replayed,true);
  }finally{if(f)f.close();else rmSync(dir,{recursive:true,force:true});}
 });
}
