import { randomUUID } from 'node:crypto';
import { snapshot, digest } from '../../microkernel/src/canonical.js';
import { fields, deny, id } from '../../microkernel/src/grants.js';
export const focusDefinitions = snapshot('focus-definitions', [
 {id:'topic',label:'专注主题',options:[{value:'study',label:'学习'},{value:'tidy',label:'整理'},{value:'write',label:'写作'}]},
 {id:'duration',label:'计划时长（分钟）',options:[{value:'5',label:'5 分钟'},{value:'15',label:'15 分钟'},{value:'25',label:'25 分钟'}]},
 {id:'pace',label:'节奏偏好（不产生提醒）',options:[{value:'steady',label:'平稳'},{value:'gentle',label:'轻柔'}]},
]).value;
const key=(kind,owner,extra='')=>'focus.'+kind+'.'+digest('focus-key',[owner,extra]).slice(7);
const seal=v=>snapshot('focus-view',v).value;
const spec=(raw,keys)=>{const v=seal(raw);fields(v,keys);return v;};
const serviceId='synthetic.focus.v1';
// Owner-authorized local records only. No scheduler, notification or external effect.
export class FocusService {
 #store;#auth;#registry;#clock;
 constructor(store,auth,registry,{clock=()=>Date.now()}={}){
  if(!registry.belongsTo(store,auth))deny('focus_domain_mismatch');
  this.#store=store;this.#auth=auth;this.#registry=registry;this.#clock=clock;
 }
 #now(){const t=this.#clock();if(!Number.isSafeInteger(t)||t<0)deny('invalid_clock');return t;}
 #index(reader,owner){return reader.get(key('index',owner));}
 #grant(reader,owner,creatureId){const r=creatureId?reader.get(key('grant',owner,creatureId)):null;return r?{...r.value,revision:r.revision}:{creatureId,enabled:false,revision:0,generation:0};}
 #refresh(owner,force=false){
  const ids=this.#index(this.#store,owner)?.value.ids??[];
  if(!force&&!ids.some(v=>this.#store.get(key('request',owner,v)).value.plan?.status==='active'))return null;
  const now=this.#now();
  // Separate durable expiry observation: subsequent denied operations cannot undo it.
  this.#store.transaction(tx=>{
   for(const requestId of this.#index(tx,owner)?.value.ids??[]){
    const r=tx.get(key('request',owner,requestId));
    if(r?.value.plan?.status==='active'&&now>=r.value.plan.dueAt)tx.put(key('request',owner,requestId),'focus-request',{...r.value,plan:{...r.value.plan,status:'elapsed'}},r.revision);
   }return null;
  });return now;
 }
 state(handle){
  const owner=this.#auth.resolve(handle);this.#refresh(owner);
  const registry=this.#registry.state(handle),ids=this.#index(this.#store,owner)?.value.ids??[],records=ids.map(v=>this.#store.get(key('request',owner,v)).value),plans=records.filter(r=>r.plan).map(r=>r.plan);
  return seal({primaryCreatureId:registry.primaryCreatureId,registryRevision:registry.revision,grant:this.#grant(this.#store,owner,registry.primaryCreatureId),activePlan:plans.find(p=>p.status==='active')??null,plans:plans.slice(-1),planWindow:1,requestWindow:4,requests:records.map((r,i)=>({requestId:ids[i],status:r.status,planId:r.plan?.planId??null})).slice(-4),requestCount:ids.length,requestLimit:128});
 }
 getPlan(handle,raw){const owner=this.#auth.resolve(handle),s=spec(raw,['requestId']);id(s.requestId);this.#refresh(owner);const r=this.#store.get(key('request',owner,s.requestId));return seal({requestId:s.requestId,status:r?.value.status??'not_started',plan:r?.value.plan??null});}
 grant(handle,raw){
  const owner=this.#auth.resolve(handle),s=spec(raw,['creatureId','enabled','expectedRevision']);id(s.creatureId);
  if(typeof s.enabled!=='boolean'||!Number.isSafeInteger(s.expectedRevision)||s.expectedRevision<0)deny('invalid_focus_grant');
  this.#refresh(owner);
  return this.#store.transaction(tx=>{
   if(this.#registry.state(handle).primaryCreatureId!==s.creatureId)deny('focus_primary_required');
   const g=this.#grant(tx,owner,s.creatureId);if(g.revision!==s.expectedRevision)deny('revision_conflict');
   if(g.enabled===s.enabled)return seal(g);
   if(g.generation===Number.MAX_SAFE_INTEGER)deny('generation_exhausted');
   const r=tx.put(key('grant',owner,s.creatureId),'focus-grant',{creatureId:s.creatureId,enabled:s.enabled,generation:g.generation+1},g.revision);return seal({...r.value,revision:r.revision});
  });
 }
 create(handle,raw){
  const owner=this.#auth.resolve(handle),s=spec(raw,['requestId','binding','values']);id(s.requestId);
  const b=s.binding;fields(b,['context','targetCreatureId','registryRevision','grantRevision','grantGeneration','serviceId']);fields(b.context,['creatureId','sceneRevision']);id(b.targetCreatureId);id(b.context.creatureId);
  if(b.serviceId!==serviceId||b.context.creatureId!==b.targetCreatureId||![b.context.sceneRevision,b.registryRevision,b.grantRevision].every(v=>Number.isSafeInteger(v)&&v>=1)||!Number.isSafeInteger(b.grantGeneration)||b.grantGeneration<0)deny('invalid_focus_binding');
  fields(s.values,focusDefinitions.map(d=>d.id));for(const d of focusDefinitions)if(!d.options.some(o=>o.value===s.values[d.id]))deny('invalid_focus_values');
  const now=this.#refresh(owner,true),inputDigest=digest('focus-input',s);
  return this.#store.transaction(tx=>{
   const k=key('request',owner,s.requestId),prior=tx.get(k);
   if(prior){if(prior.value.status==='cancelled')deny('focus_request_cancelled');if(prior.value.inputDigest!==inputDigest)deny('focus_request_conflict');return seal({replayed:true,plan:prior.value.plan});}
   const registry=this.#registry.state(handle),g=this.#grant(tx,owner,b.targetCreatureId);
   if(registry.primaryCreatureId!==b.targetCreatureId||registry.revision!==b.registryRevision||!g.enabled||g.revision!==b.grantRevision||g.generation!==b.grantGeneration)deny('focus_authority_changed');
   const index=this.#index(tx,owner),ids=index?.value.ids??[];if(ids.length>=128)deny('focus_request_capacity');
   if(ids.some(v=>tx.get(key('request',owner,v)).value.plan?.status==='active'))deny('focus_plan_active');
   const dueAt=now+Number(s.values.duration)*60000;if(!Number.isSafeInteger(dueAt))deny('invalid_clock');
   const planId='focus-'+randomUUID(),receipt={receiptId:'saved-'+randomUUID(),fact:'plan_saved',source:'deterministic-synthetic-focus',serviceId,serviceVersion:1,requestId:s.requestId,planId,creatureId:b.targetCreatureId,input:s.values,createdAt:now,dueAt};
   const plan={planId,requestId:s.requestId,creatureId:b.targetCreatureId,serviceId,input:s.values,createdAt:now,dueAt,status:'active',receipt};
   tx.put(k,'focus-request',{status:'completed',inputDigest,plan},0);tx.put(key('index',owner),'focus-index',{ids:[...ids,s.requestId]},index?.revision??0);
   return seal({replayed:false,plan});
  });
 }
 cancel(handle,raw){
  const owner=this.#auth.resolve(handle),s=spec(raw,['requestId']);id(s.requestId);this.#refresh(owner);
  return this.#store.transaction(tx=>{
   const k=key('request',owner,s.requestId),r=tx.get(k);
   if(r){
    if(r.value.plan?.status==='active')tx.put(k,'focus-request',{...r.value,plan:{...r.value.plan,status:'cancelled'}},r.revision);
    const current=tx.get(k).value;return seal({requestId:s.requestId,status:current.status,plan:current.plan});
   }
   const index=this.#index(tx,owner),ids=index?.value.ids??[];if(ids.length>=128)deny('focus_request_capacity');
   tx.put(k,'focus-request',{status:'cancelled',inputDigest:null,plan:null},0);tx.put(key('index',owner),'focus-index',{ids:[...ids,s.requestId]},index?.revision??0);
   return seal({requestId:s.requestId,status:'cancelled',plan:null});
  });
 }
}
