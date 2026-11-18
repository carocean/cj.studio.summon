import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {snapshot,digest} from '../../microkernel/src/canonical.js';
import {fields,id,deny} from '../../microkernel/src/grants.js';
import {validateCompiledInteractionProgram} from './interaction-program.js';
const key=(owner,part)=>'textgen-'+digest('text-generation-key',[owner,part]).slice(7,55);
const seal=value=>snapshot('text-generation',value).value;
const same=(a,b)=>digest('text-generation-binding',a)===digest('text-generation-binding',b);
const sync=fn=>typeof fn==='function'&&!types.isProxy(fn)&&!types.isAsyncFunction(fn);
const FAILURE_CODES=new Set(['unauthenticated','text_generation_closed','text_attempt_not_running','text_policy_changed','text_context_changed','text_attempt_expired','text_generation_cancelled','text_planner_identity_changed','invalid_text_proposal','interaction_context_changed','interaction_session_exists','interaction_session_capacity','interaction_command_capacity','invalid_interaction_source','invalid_clock','invalid_c1_value','c1_record_limit','c1_depth_limit','invalid_shape','planner_aborted','planner_timeout','planner_busy','planner_invalid_input','planner_redirect','planner_http_error','planner_invalid_response','planner_response_too_large','planner_invalid_proposal','planner_transport_error']);
const failureCode=error=>{const code=error&&typeof error==='object'&&!types.isProxy(error)?Object.getOwnPropertyDescriptor(error,'code')?.value:null;return FAILURE_CODES.has(code)?code:'text_generation_failed';};
const domains=new WeakMap();
const frame=value=>{fields(value,['creatureId','sceneRevision']);id(value.creatureId);if(!Number.isSafeInteger(value.sceneRevision)||value.sceneRevision<1)deny('invalid_text_context');return value;};
// Host-only protocol. No HTTP, model startup, raw-text persistence or automatic retry.
export class TextInteractionGeneration {
 #store;#auth;#sessions;#planner;#modelId;#current;#clock;#ttl;#max;#run=randomUUID();#closed=false;#domain;#pending=new Map();
 constructor(store,auth,sessions,{planner=null,currentContext,clock=()=>Date.now(),ttlMs=30000,maxAttempts=64}={}){
  if(!sync(currentContext)||!sync(clock)||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>60000||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>64)deny('invalid_text_generation_configuration');
  let modelId=null;if(planner!==null){if(types.isProxy(planner)||typeof planner.generate!=='function')deny('invalid_text_planner');modelId=seal(planner.modelId);if(typeof modelId!=='string'||!modelId.trim()||[...modelId].length>120||/[\u0000-\u001f\u007f]/u.test(modelId))deny('invalid_text_planner');}
  sessions.assertDomain(store,auth);const prior=domains.get(store);if(prior?.service&&!prior.service.#closed)deny('text_generation_already_open');
  this.#domain=prior??{busy:false,service:null};this.#domain.service=this;domains.set(store,this.#domain);
  this.#store=store;this.#auth=auth;this.#sessions=sessions;this.#planner=planner;this.#modelId=modelId;this.#current=currentContext;this.#clock=clock;this.#ttl=ttlMs;this.#max=maxAttempts;
 }
 #owner(handle){if(this.#closed)deny('text_generation_closed');return this.#auth.resolve(handle);}
 #now(){const now=this.#clock();if(!Number.isSafeInteger(now)||now<0)deny('invalid_clock');return now;}
 #index(reader,owner){return reader.get(key(owner,'index'));}
 #policy(reader,owner){return reader.get(key(owner,'policy'))?.value??{enabled:false,generation:0};}
 #record(reader,owner,commandId){return reader.get(key(owner,'attempt:'+commandId));}
 #view(record){return seal(record?{status:record.value.status,commandId:record.value.commandId,...(record.value.result?{result:record.value.result}:{}),...(record.value.reason?{reason:record.value.reason}:{})}:null);}
 #finish(tx,record,status,extra={}){if(record.value.status==='running')tx.put(record.id,'text-generation-attempt',{...record.value,status,...extra},record.revision);}
 #observe(handle,owner,commandId){
  let record=this.#record(this.#store,owner,commandId);if(!record||record.value.status!=='running')return record;
  const now=this.#now();if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');
  let status=(record.value.runId!==this.#run||!this.#pending.has(key(owner,commandId)))?'interrupted':now>=record.value.expiresAt?'expired':null;
  if(status){this.#store.transaction(tx=>{if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');this.#finish(tx,this.#record(tx,owner,commandId),status);return null;});this.#pending.get(key(owner,commandId))?.abort();record=this.#record(this.#store,owner,commandId);}
  return record;
 }
 state(handle){const owner=this.#owner(handle);return seal({...this.#policy(this.#store,owner),plannerAvailable:this.#planner!==null,ttlMs:this.#ttl,attemptCount:this.#index(this.#store,owner)?.value.commands.length??0,attemptLimit:this.#max});}
 query(handle,raw){const r=seal(raw);fields(r,['commandId']);id(r.commandId);const owner=this.#owner(handle);return this.#view(this.#observe(handle,owner,r.commandId))??{status:'not_started',commandId:r.commandId};}
 setEnabled(handle,raw){
  const r=seal(raw);fields(r,['enabled','expectedGeneration']);if(typeof r.enabled!=='boolean'||!Number.isSafeInteger(r.expectedGeneration)||r.expectedGeneration<0)deny('invalid_text_policy');const owner=this.#owner(handle);
  const result=this.#store.transaction(tx=>{const previous=tx.get(key(owner,'policy')),policy=this.#policy(tx,owner);if(policy.generation!==r.expectedGeneration)deny('text_policy_conflict');if(policy.generation===Number.MAX_SAFE_INTEGER)deny('text_policy_exhausted');
   const next={enabled:r.enabled,generation:policy.generation+1};tx.put(key(owner,'policy'),'text-generation-policy',next,previous?.revision??0);
   for(const commandId of this.#index(tx,owner)?.value.commands??[]){const record=this.#record(tx,owner,commandId);this.#finish(tx,record,'cancelled',{reason:'policy-changed'});}
   if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');return next;});
  for(const commandId of this.#index(this.#store,owner)?.value.commands??[])this.#pending.get(key(owner,commandId))?.abort();return result;
 }
 cancel(handle,raw){const r=seal(raw);fields(r,['commandId']);id(r.commandId);const owner=this.#owner(handle);const record=this.#observe(handle,owner,r.commandId);if(!record)return {status:'not_started',commandId:r.commandId};
  this.#store.transaction(tx=>{if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');this.#finish(tx,this.#record(tx,owner,r.commandId),'cancelled',{reason:'explicit-cancel'});return null;});this.#pending.get(key(owner,r.commandId))?.abort();return this.query(handle,r);
 }
 #validate(handle,owner,record,reader=this.#store){
  if(this.#owner(handle)!==owner)deny('unauthenticated');if(record.value.status!=='running')deny('text_attempt_not_running');
  const policy=this.#policy(reader,owner);if(!policy.enabled||policy.generation!==record.value.policyGeneration)deny('text_policy_changed');
  const current=frame(seal(this.#current(handle)));if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');if(!same(current,record.value.context))deny('text_context_changed');
  const after=this.#policy(reader,owner),live=this.#record(reader,owner,record.value.commandId);if(!after.enabled||after.generation!==record.value.policyGeneration)deny('text_policy_changed');if(live&&live.value.status!=='running')deny('text_attempt_not_running');
 }
 async generate(handle,raw){
  const r=seal(raw);fields(r,['commandId','context','text','confirmation']);id(r.commandId);frame(r.context);
  if(r.confirmation!=='generate-from-user-text'||typeof r.text!=='string'||!r.text.trim()||[...r.text].length>4000||Buffer.byteLength(r.text)>16000)deny('invalid_text_generation_request');
  const owner=this.#owner(handle),requestDigest=digest('text-generation-request',r),prior=this.#observe(handle,owner,r.commandId);
  if(prior){if(prior.value.requestDigest!==requestDigest)deny('command_conflict');return this.#view(prior);}
  if(!this.#planner)deny('text_planner_unavailable');if(this.#domain.busy)deny('text_planner_busy');
  const policy=this.#policy(this.#store,owner);if(!policy.enabled)deny('text_generation_disabled');
  const now=this.#now(),expiresAt=now+this.#ttl;if(!Number.isSafeInteger(expiresAt))deny('invalid_clock');
  const commandId=r.commandId,sessionId='text-'+digest('text-session',[owner,commandId]).slice(7,55),createId='text-create-'+digest('text-create',[owner,commandId]).slice(7,51);
  const attempt={ownerId:owner,commandId,requestDigest,inputKind:'user-text',sourceReference:key(owner,'source:'+commandId),context:r.context,policyGeneration:policy.generation,status:'running',runId:this.#run,expiresAt};
  this.#store.transaction(tx=>{const idx=this.#index(tx,owner),commands=idx?.value.commands??[];if(commands.length>=this.#max)deny('text_attempt_capacity');this.#validate(handle,owner,{value:attempt},tx);tx.put(key(owner,'attempt:'+commandId),'text-generation-attempt',attempt,0);tx.put(key(owner,'index'),'text-generation-index',{commands:[...commands,commandId]},idx?.revision??0);return null;});
  const controller=new AbortController();this.#pending.set(key(owner,commandId),controller);this.#domain.busy=true;
  const modelId=this.#modelId;let rejectAbort;
  const cancelled=new Promise((_,reject)=>{rejectAbort=()=>reject(Object.assign(Error('text_generation_cancelled'),{code:'text_generation_cancelled'}));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
  const timer=setTimeout(()=>{try{const record=this.#record(this.#store,owner,commandId);this.#store.transaction(tx=>{if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');this.#finish(tx,record,'expired');return null;});}catch{}controller.abort();},this.#ttl);
  let observedExpiry=false;
  try{
   const pending=Promise.resolve().then(()=>{this.#validate(handle,owner,this.#record(this.#store,owner,commandId));this.#observe(handle,owner,commandId);const live=this.#record(this.#store,owner,commandId),policy=this.#policy(this.#store,owner);if(live.value.status!=='running')deny('text_attempt_not_running');if(!policy.enabled||policy.generation!==attempt.policyGeneration)deny('text_policy_changed');return this.#planner.generate({text:r.text},{signal:controller.signal});}).finally(()=>{this.#domain.busy=false;});
   const output=seal(await Promise.race([pending,cancelled]));fields(output,['proposal','modelId']);if(output.modelId!==modelId)deny('text_planner_identity_changed');
   const observed=this.#observe(handle,owner,commandId);this.#validate(handle,owner,observed);
   const p=output.proposal;if(!p||p.authorityGranted!==false||p.semanticsVerified!==false)deny('invalid_text_proposal');
   let result;
    const before=tx=>{const record=this.#record(tx,owner,commandId);this.#validate(handle,owner,record,tx);const at=this.#now();if(at>=record.value.expiresAt){observedExpiry=true;deny('text_attempt_expired');}if(this.#owner(handle)!==owner)deny('unauthenticated');const policy=this.#policy(tx,owner),live=this.#record(tx,owner,commandId);if(!policy.enabled||policy.generation!==attempt.policyGeneration)deny('text_policy_changed');if(live.value.status!=='running')deny('text_attempt_not_running');return null;};
   if(p.kind==='form'){
    fields(p,['kind','program','authorityGranted','semanticsVerified']);validateCompiledInteractionProgram(p.program);
    this.#sessions.createComposed(handle,createId,{sessionId,context:r.context,program:p.program,source:{kind:'model-proposal',referenceId:attempt.sourceReference,modelId}}, {before,after:(tx,ack)=>{before(tx);result={kind:'form',creation:ack,inputKind:'user-text',sourceTrust:'host-supplied-metadata',modelId};this.#finish(tx,this.#record(tx,owner,commandId),'completed',{result});return null;}});
   }else{
    const field=p.kind==='clarify'?'question':p.kind==='none'?'reason':null;if(!field)deny('invalid_text_proposal');fields(p,['kind',field,'authorityGranted','semanticsVerified']);if(typeof p[field]!=='string'||!p[field].trim()||[...p[field]].length>240||/[\u0000-\u001f\u007f]/u.test(p[field]))deny('invalid_text_proposal');
    result={kind:p.kind,[field]:p[field],inputKind:'user-text',sourceTrust:'host-supplied-metadata',modelId};this.#store.transaction(tx=>{before(tx);this.#finish(tx,this.#record(tx,owner,commandId),'completed',{result});return null;});
   }
   return this.query(handle,{commandId});
  }catch(error){
   const code=failureCode(error);
   // No revoked handle writes. A later authenticated owner query after reopening
   // can reconcile the surviving running marker as interrupted.
   if(!this.#closed&&this.#auth.resolve(handle)===owner)this.#store.transaction(tx=>{const record=this.#record(tx,owner,commandId);this.#finish(tx,record,observedExpiry?'expired':'failed',{reason:code});return null;});
   deny(code);
  }finally{clearTimeout(timer);controller.signal.removeEventListener('abort',rejectAbort);this.#pending.delete(key(owner,commandId));}
 }
 close(){if(this.#closed)return;this.#closed=true;for(const controller of this.#pending.values())controller.abort();}
}
