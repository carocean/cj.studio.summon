import {types} from 'node:util';
import {snapshot,digest} from '../../microkernel/src/canonical.js';
import {fields,deny,id} from '../../microkernel/src/grants.js';
import {validateCompiledInteractionProgram,createInteractionDraft,validateInteractionDraft,updateInteractionDraft,reviseInteractionProgram} from './interaction-program.js';

const seal=(kind,value)=>snapshot(kind,value).value;
const key=(kind,owner,extra='')=>'interaction-'+kind+'.'+digest('interaction-key',[owner,extra]).slice(7,55);
const revision=v=>Number.isSafeInteger(v)&&v>=1;
const same=(a,b)=>digest('interaction-frame',a)===digest('interaction-frame',b);
const sync=f=>typeof f==='function'&&!types.isProxy(f)&&!types.isAsyncFunction(f);
function frame(raw){const f=seal('interaction-frame',raw);fields(f,['creatureId','sceneRevision']);id(f.creatureId);if(!revision(f.sceneRevision))deny('invalid_interaction_context');return f;}
function source(raw){
 const s=seal('interaction-source',raw);fields(s,['kind','referenceId','modelId']);id(s.referenceId);
 if(!['host-declaration','model-proposal'].includes(s.kind)||(s.kind==='host-declaration'?s.modelId!==null:typeof s.modelId!=='string'||!s.modelId.trim()||[...s.modelId].length>120||/[\u0000-\u001f\u007f]/u.test(s.modelId)))deny('invalid_interaction_source');
 return s;
}
const index=()=>({sessions:[],notes:[],commandCount:0});

// Trusted local host only; no HTTP, model calls, background work or device UI.
// The host supplies declarations/source metadata and any explicitly approved
// field moves. Metadata is not proof that inference happened. This class neither
// authenticates a model nor extends the deterministic kernel's provenance proof.
// Owner handles are not creature handles. Saved notes belong to that same owner;
// an expired/closed temporary presentation cannot revoke the owner's saved copy.
// Invalidation is observed on active read/new mutation, not by a background sweep.
// The host must provide monotonic scene revisions to reveal unobserved context ABA.
// Experimental lifetime caps: 16 sessions, 64 saved snapshots, 1024 commands per
// owner and 32 draft mutations per session. No deletion/reclamation is provided.
export class InteractionSession {
 #store;#auth;#current;#clock;#ttl;
 constructor(store,identities,{currentContext,clock=()=>Date.now(),ttlMs=300000}={}){
  if(!sync(currentContext)||!sync(clock)||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>900000)deny('invalid_interaction_host');
  this.#store=store;this.#auth=identities;this.#current=currentContext;this.#clock=clock;this.#ttl=ttlMs;
 }
 assertDomain(store,identities){if(store!==this.#store||identities!==this.#auth)deny('interaction_domain_mismatch');}
 #now(){const n=this.#clock();if(!Number.isSafeInteger(n)||n<0)deny('invalid_clock');return n;}
 #spec(raw,keys){const s=seal('interaction-request',raw);fields(s,keys);return s;}
 #record(reader,owner,sessionId){id(sessionId);const r=reader.get(key('session',owner,sessionId));if(!r||r.value.ownerId!==owner)deny('interaction_session_not_found');return r;}
 #context(handle){return frame(this.#current(handle));}
 #observe(handle,owner,sessionId){
  const r=this.#record(this.#store,owner,sessionId);if(r.value.status!=='open')return;
  const now=this.#now();let status=null;
  if(now>=r.value.expiresAt)status='expired';
  else {try{if(!same(this.#context(handle),r.value.context))status='stale';}catch{status='stale';}}
  // Host callbacks are synchronous but may revoke the owner handle. Recheck
  // before even the independent invalidation write, not only before disclosure.
  if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');
  // Latch even if a later command is denied; clock/context rollback cannot revive.
  if(status)this.#store.transaction(tx=>{const current=this.#record(tx,owner,sessionId);if(current.value.status==='open')tx.put(key('session',owner,sessionId),'interaction-session',{...current.value,status},current.revision);return null;});
  return now;
 }
 // Trusted host composition only. Preserve an expiry already observed during a
 // surrounding transaction which then rolled back. Never resample a clock that
 // may have moved backwards; this cannot reopen, extend or disclose a session.
 latchObservedExpiry(handle,raw){
  const owner=this.#auth.resolve(handle),r=this.#spec(raw,['sessionId','observedAt']);id(r.sessionId);
  if(!Number.isSafeInteger(r.observedAt)||r.observedAt<0)deny('invalid_clock');
  return this.#store.transaction(tx=>{
   const current=this.#record(tx,owner,r.sessionId);
   if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');
   if(current.value.status==='open'&&r.observedAt>=current.value.expiresAt){
    tx.put(key('session',owner,r.sessionId),'interaction-session',{...current.value,status:'expired'},current.revision);
    return true;
   }
   return false;
  });
 }
 #active(r,expectedRevision){
  if(r.value.status!=='open')deny(r.value.status==='expired'?'interaction_session_expired':r.value.status==='closed'?'interaction_session_closed':'interaction_context_changed');
  if(expectedRevision!==undefined&&r.revision!==expectedRevision)deny('interaction_revision_conflict');
 }
 #execute(handle,commandId,operation,spec,apply){
  const owner=this.#auth.resolve(handle);id(commandId);
  const commandKey='ix-'+digest('interaction-command',[owner,commandId]).slice(7,55),opKey=key('operation',owner,commandId),input={operation,spec};
  // Atomic command receipt and operation index always exist together. A historical
  // replay returns only its original ack; it never restores editing or note data.
  if(this.#store.get(opKey))return this.#store.command(owner,commandKey,input,()=>deny('interaction_command_corrupt'));
  const observedAt=operation!=='create'?this.#observe(handle,owner,spec.sessionId):null;
  return this.#store.command(owner,commandKey,input,tx=>{
   if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');
   const idx=tx.get(key('index',owner));if((idx?.value.commandCount??0)>=1024)deny('interaction_command_capacity');
   const ack=apply(tx,owner,observedAt);
   // create() invokes context/clock callbacks inside apply(). Revocation there
   // must roll back all provisional writes, not leave a new open session.
   if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');
   tx.put(opKey,'interaction-operation',{commandId,ack},0);
   const current=tx.get(key('index',owner));const value=current?.value??index();
   tx.put(key('index',owner),'interaction-index',{...value,commandCount:value.commandCount+1},current?.revision??0);
   return ack;
  });
 }
 create(handle,commandId,raw){return this.createComposed(handle,commandId,raw);}
 // Trusted host composition only. Hooks run inside the existing command transaction;
 // replay does not run hooks. No HTTP surface exposes these callbacks.
 createComposed(handle,commandId,raw,hooks={}){
  if(!hooks||types.isProxy(hooks)||![Object.prototype,null].includes(Object.getPrototypeOf(hooks)))deny('invalid_interaction_hook');
  const descriptors=Object.getOwnPropertyDescriptors(hooks);
  if(Reflect.ownKeys(hooks).some(k=>!['before','after'].includes(k)||!descriptors[k].enumerable||!Object.hasOwn(descriptors[k],'value')))deny('invalid_interaction_hook');
  const {before=()=>null,after=()=>null}=hooks;
  if(!sync(before)||!sync(after))deny('invalid_interaction_hook');
  const hook=(fn,...args)=>{const result=fn(...args);if(types.isPromise(result)&&Object.getPrototypeOf(result)===Promise.prototype&&!Object.hasOwn(result,'constructor'))Promise.prototype.then.call(result,()=>{},()=>{});if(result!==null)deny('invalid_interaction_hook_result');};
  const r=this.#spec(raw,['sessionId','context','program','source']);id(r.sessionId);frame(r.context);const p=validateCompiledInteractionProgram(r.program),origin=source(r.source);
  if(p.revision!==1)deny('interaction_initial_program_required');
  return this.#execute(handle,commandId,'create',r,(tx,owner)=>{
   hook(before,tx);
   if(!same(this.#context(handle),r.context))deny('interaction_context_changed');
   if(tx.get(key('session',owner,r.sessionId)))deny('interaction_session_exists');
   const idx=tx.get(key('index',owner)),value=idx?.value??index();if(value.sessions.length>=16)deny('interaction_session_capacity');
   const createdAt=this.#now(),expiresAt=createdAt+this.#ttl;if(!Number.isSafeInteger(expiresAt))deny('invalid_clock');
   const session={ownerId:owner,sessionId:r.sessionId,context:r.context,source:origin,sourceTrust:'host-supplied-metadata',program:p,draft:createInteractionDraft(p),status:'open',createdAt,expiresAt,changeCount:0,saveCount:0,lastNoteId:null};
   const saved=tx.put(key('session',owner,r.sessionId),'interaction-session',session,0);
   tx.put(key('index',owner),'interaction-index',{...value,sessions:[...value.sessions,r.sessionId]},idx?.revision??0);
   const ack={fact:'interaction_created',sessionId:r.sessionId,revision:saved.revision,programDigest:p.programDigest,draftRevision:0,expiresAt};
   hook(after,tx,ack);return ack;
  });
 }
 // A reference derived from the same atomic index as create, not a separately
 // committed UI pointer. An old create replay cannot resurrect a prior surface.
 currentReference(handle){
  const owner=this.#auth.resolve(handle),ids=this.#store.get(key('index',owner))?.value.sessions;
  if(!ids?.length)return null;
  const sessionId=ids.at(-1);this.#observe(handle,owner,sessionId);
  if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');
  const r=this.#record(this.#store,owner,sessionId);
  return r.value.status==='open'?seal('interaction-reference',{sessionId,context:r.value.context}):null;
 }
 read(handle,raw){
  const owner=this.#auth.resolve(handle),r=this.#spec(raw,['sessionId']);this.#observe(handle,owner,r.sessionId);
  this.#auth.resolve(handle);const record=this.#record(this.#store,owner,r.sessionId);this.#active(record);
  return seal('interaction-view',{...record.value,revision:record.revision});
 }
 edit(handle,commandId,raw){
  const r=this.#spec(raw,['sessionId','expectedRevision','changes']);id(r.sessionId);if(!revision(r.expectedRevision))deny('invalid_interaction_revision');
  return this.#execute(handle,commandId,'edit',r,(tx,owner)=>{
   const record=this.#record(tx,owner,r.sessionId);this.#active(record,r.expectedRevision);const s=record.value;if(s.changeCount>=32)deny('interaction_change_capacity');
   const draft=updateInteractionDraft(s.program,s.draft,{expectedProgramDigest:s.program.programDigest,expectedDraftRevision:s.draft.revision,changes:r.changes});
   const saved=tx.put(key('session',owner,r.sessionId),'interaction-session',{...s,draft,changeCount:s.changeCount+1},record.revision);
   return {fact:'interaction_draft_updated',sessionId:r.sessionId,revision:saved.revision,programDigest:s.program.programDigest,draftRevision:draft.revision};
  });
 }
 revise(handle,commandId,raw){
  const r=this.#spec(raw,['sessionId','expectedRevision','proposal','moves','source']);id(r.sessionId);if(!revision(r.expectedRevision))deny('invalid_interaction_revision');const origin=source(r.source);
  return this.#execute(handle,commandId,'revise',r,(tx,owner)=>{
   const record=this.#record(tx,owner,r.sessionId);this.#active(record,r.expectedRevision);const s=record.value;if(s.changeCount>=32)deny('interaction_change_capacity');
   const next=reviseInteractionProgram(s.program,s.draft,r.proposal,{expectedProgramDigest:s.program.programDigest,expectedDraftRevision:s.draft.revision,moves:r.moves});
   const saved=tx.put(key('session',owner,r.sessionId),'interaction-session',{...s,...next,source:origin,changeCount:s.changeCount+1},record.revision);
   return {fact:'interaction_program_revised',sessionId:r.sessionId,revision:saved.revision,programDigest:next.program.programDigest,draftRevision:next.draft.revision};
  });
 }
 close(handle,commandId,raw){
  const r=this.#spec(raw,['sessionId','expectedRevision']);id(r.sessionId);if(!revision(r.expectedRevision))deny('invalid_interaction_revision');
  return this.#execute(handle,commandId,'close',r,(tx,owner)=>{
   const record=this.#record(tx,owner,r.sessionId);if(record.revision!==r.expectedRevision)deny('interaction_revision_conflict');
   if(record.value.status!=='open')return {fact:'interaction_already_inactive',sessionId:r.sessionId,revision:record.revision};
   const saved=tx.put(key('session',owner,r.sessionId),'interaction-session',{...record.value,status:'closed'},record.revision);
   return {fact:'interaction_presentation_closed',sessionId:r.sessionId,revision:saved.revision};
  });
 }
 // The confirmation marker is a host protocol check, not proof of human intent.
 // Never accept a model's self-issued confirmation as permission to call this.
 save(handle,commandId,raw){
  const r=this.#spec(raw,['sessionId','expectedRevision','confirmation']);id(r.sessionId);if(!revision(r.expectedRevision))deny('invalid_interaction_revision');if(r.confirmation!=='save-local-draft')deny('interaction_save_confirmation_required');
  return this.#execute(handle,commandId,'save',r,(tx,owner,observedAt)=>{
   const record=this.#record(tx,owner,r.sessionId);this.#active(record,r.expectedRevision);const s=record.value;
   const draft=validateInteractionDraft(s.program,s.draft,{requireComplete:true});
   const idx=tx.get(key('index',owner)),value=idx.value;if(value.notes.length>=64)deny('interaction_note_capacity');
   // One sampled time for this synchronous operation; no await or second clock
   // observation inside a transaction that might roll an observed expiry back.
   const savedAt=observedAt;if(!Number.isSafeInteger(savedAt)||savedAt>=s.expiresAt)deny('interaction_session_expired');
   const noteId='note-'+digest('interaction-note',[owner,commandId]).slice(7,55);
   const note={schema:'local-note.v1',noteId,ownerId:owner,sessionId:r.sessionId,context:s.context,program:s.program,draft,source:s.source,sourceTrust:s.sourceTrust,savedAt};
   const saved=tx.put(key('note',owner,noteId),'interaction-note',note,0);
   tx.put(key('index',owner),'interaction-index',{...value,notes:[...value.notes,noteId]},idx.revision);
   const updated=tx.put(key('session',owner,r.sessionId),'interaction-session',{...s,saveCount:s.saveCount+1,lastNoteId:noteId},record.revision);
   return {fact:'local_note_saved',sessionId:r.sessionId,noteId,noteDigest:saved.digest,revision:updated.revision,programDigest:s.program.programDigest,draftRevision:draft.revision,savedAt};
  });
 }
 // not_started means no completed local command transaction was observed; it
 // never schedules a retry and is not an assertion about any external system.
 query(handle,raw){
  const owner=this.#auth.resolve(handle),r=this.#spec(raw,['commandId']);id(r.commandId);const recorded=this.#store.get(key('operation',owner,r.commandId));
  return seal('interaction-query',recorded?{status:'completed',...recorded.value}:{status:'not_started',commandId:r.commandId});
 }
 readSaved(handle,raw){
  const owner=this.#auth.resolve(handle),r=this.#spec(raw,['noteId']);id(r.noteId);const note=this.#store.get(key('note',owner,r.noteId));
  if(!note||note.value.ownerId!==owner)deny('interaction_note_not_found');return seal('interaction-saved-view',note.value);
 }
}
