import { randomUUID } from 'node:crypto';
import { SnapshotStore } from './store.js';
import { snapshot, digest, canonical } from './canonical.js';
import { deny, id, fields } from './grants.js';
const manifest=snapshot('manifest',{service:'simulated.record.v1',effect:'simulation-only',profile:'synthetic.empty.v1',issuer:'local-sink',success:'observation_confirmed'});
const artifactManifest=snapshot('manifest',{service:'simulated.record.v1',effect:'simulation-only',profile:'controlled.artifact.v1',issuer:'local-sink',success:'observation_confirmed'});
const key=(kind,name)=>kind+'.'+id(name);
const load=(tx,kind,name)=>{const r=tx.get(key(kind,name));if(!r||r.kind!==kind)deny('resource_not_found');return r;};
const spec=(raw,keys)=>{const v=snapshot('request',raw).value;fields(v,keys);return v;};

// Closed synthetic business schema. No names, addresses, account numbers or free text.
export function syntheticInput(content) {
 if(['synthetic-form','synthetic-scene'].includes(content))return {scenario:content,synthetic:true};
 let value;try{value=JSON.parse(content);}catch{deny('non_synthetic_payload');}
 if(canonical(value)!==content)deny('non_synthetic_payload');
 fields(value,['scenario','synthetic','form']);fields(value.form,['customerAlias','accountType','contactPreference']);
 if(value.scenario!=='synthetic-form'||value.synthetic!==true||!['demo-a','demo-b'].includes(value.form.customerAlias)||!['daily','savings'].includes(value.form.accountType)||!['none','demo-email'].includes(value.form.contactPreference))deny('non_synthetic_payload');
 return value;
}
// Private deterministic sink. No caller-supplied endpoint, issuer, callback or raw data.
class SimulationSink {
 #store;
 constructor(path){this.#store=new SnapshotStore(path);}
 close(){this.#store.close();}
 accept(binding,input){
  const payload=snapshot('simulation-payload',input).value;
  const checked=Object.hasOwn(payload,'form')?syntheticInput(canonical(payload)):syntheticInput(payload.scenario);
  if(digest('input',checked)!==digest('input',payload)||binding.inputDigest!==digest('input',payload)||binding.effectDigest!==digest('simulation-effect',payload))deny('sink_payload_mismatch');
  return this.#store.transaction(tx=>{
   const effectKey='effect.'+digest('effect-key',[binding.domain,binding.effectId]).slice(7);
   const slotKey='fence.'+digest('fence-key',[binding.domain,binding.activityId]).slice(7);
   const old=tx.get(effectKey),slot=tx.get(slotKey);
   if(slot&&binding.fence<slot.value.fence)deny('stale_fence');
   if(old&&(old.value.bindingDigest!==digest('binding',binding)))deny('effect_conflict');
   if(!slot||slot.value.fence<binding.fence)tx.put(slotKey,'sink-fence',{fence:binding.fence},slot?.revision??0);
   if(old)return old.value;
   const receipt={bindingDigest:digest('binding',binding),domain:binding.domain,activityId:binding.activityId,controller:binding.controller,effectId:binding.effectId,fence:binding.fence,issuer:'local-sink',level:'observation_confirmed'};
   tx.put(effectKey,'sink-effect',receipt,0);return receipt;
  });
 }
 query(binding){
  const r=this.#store.get('effect.'+digest('effect-key',[binding.domain,binding.effectId]).slice(7));
  if(!r)return null;
  if(r.value.bindingDigest!==digest('binding',binding))deny('effect_conflict');
  return r.value;
 }
}

// Trusted-host lab only. Synthetic payloads, controlled context bridge, no LLM/real writes.
// Separate admin simulation allocations are NOT Grant read/disclose authority.
export class PermitLab {
 #store;#auth;#sink;#clock;#admin;#domain;#fault;#closed=false;#data;
 constructor(store,identities,sinkPath,{administrator='host-admin',clock=()=>Date.now(),testFault=null,contextLab=null}={}){
  if(![null,'after-consume','after-sink','kill-after-consume','kill-after-sink'].includes(testFault))deny('invalid_test_fault');
  if(contextLab!==null)contextLab.assertBrokerDomain(store,identities);
  this.#store=store;this.#auth=identities;this.#clock=clock;this.#admin=id(administrator);this.#fault=testFault;this.#data=contextLab;
  this.#domain=store.transaction(tx=>{
   const old=tx.get('permit-domain');if(old)return old.value.domain;
   const domain='d-'+randomUUID();tx.put('permit-domain','authority-domain',{domain},0);return domain;
  });
  this.#sink=new SimulationSink(sinkPath);
 }
 close(){if(this.#closed)return;this.#sink.close();this.#closed=true;}
 #now(){const n=this.#clock();if(!Number.isSafeInteger(n)||n<0)deny('invalid_clock');return n;}
 #principal(handle){if(this.#closed)deny('permit_lab_closed');return this.#auth.resolve(handle);}
 #refresh(allocationId,observedAt=this.#now()){
  if(!Number.isSafeInteger(observedAt)||observedAt<0)deny('invalid_clock');
  const now=observedAt;this.#store.transaction(tx=>{
   const r=load(tx,'allocation',allocationId),a=r.value;
   if(a.status==='active'&&now>=a.expiresAt)tx.put(key('allocation',allocationId),'allocation',{...a,status:'expired',epoch:a.epoch+1},r.revision);
   return null;
  });return now;
 }
 #authorized(tx,allocationId,actor,now){
  const r=load(tx,'allocation',allocationId),a=r.value;
  if(a.controller!==actor)deny('not_authorized');
  if(a.status!=='active'||now>=a.expiresAt)deny('allocation_inactive');return r;
 }
 allocate(handle,commandId,raw){
  const actor=this.#principal(handle);if(actor!==this.#admin)deny('not_authorized');
  const s=spec(raw,['allocationId','controller','calls','expiresAt']);id(s.allocationId);id(s.controller);
  if(!Number.isSafeInteger(s.calls)||s.calls<1||s.calls>1000||!Number.isSafeInteger(s.expiresAt)||s.expiresAt<=this.#now())deny('invalid_allocation');
  return this.#store.command(actor,commandId,{operation:'simulation-allocate',s},tx=>{
   if(tx.get(key('allocation',s.allocationId)))deny('resource_exists');
   tx.put(key('allocation',s.allocationId),'allocation',{...s,reserved:0,settled:0,epoch:0,status:'active'},0);return {allocationId:s.allocationId};
  });
 }
 revoke(handle,commandId,allocationId){
  const actor=this.#principal(handle);
  return this.#store.command(actor,commandId,{operation:'simulation-revoke',allocationId},tx=>{
   const r=load(tx,'allocation',allocationId),a=r.value;if(![this.#admin,a.controller].includes(actor))deny('not_authorized');
   if(a.status==='active')tx.put(key('allocation',allocationId),'allocation',{...a,status:'revoked',epoch:a.epoch+1},r.revision);
   return {allocationId};
  });
 }
 prepare(handle,commandId,raw){
  const actor=this.#principal(handle),s=spec(raw,['activityId','allocationId','scenario']);id(s.activityId);id(s.allocationId);
  if(!['synthetic-form','synthetic-scene'].includes(s.scenario))deny('unsupported_scenario');
  const now=this.#refresh(s.allocationId);
  return this.#store.command(actor,commandId,{operation:'simulation-prepare',s},tx=>{
   const ar=this.#authorized(tx,s.allocationId,actor,now),a=ar.value;
   if(tx.get(key('activity',s.activityId)))deny('active_or_terminal_activity');
   if(a.reserved+a.settled>=a.calls)deny('budget_exhausted');
   const input={scenario:s.scenario,synthetic:true};
   const context=snapshot('execution-context',{profile:'synthetic.empty.v1',origins:[],inputDigest:digest('input',input)});
   const binding={domain:this.#domain,activityId:s.activityId,attemptId:s.activityId+'.a1',effectId:s.activityId+'.e1',controller:actor,executor:'fixed-broker',recipient:'local-sink',purpose:'simulation',fence:1,manifestDigest:manifest.digest,inputDigest:digest('input',input),contextDigest:context.digest,effectDigest:digest('simulation-effect',input),allocationId:s.allocationId,allocationEpoch:a.epoch,cost:1,expiresAt:a.expiresAt};
   tx.put(key('allocation',s.allocationId),'allocation',{...a,reserved:a.reserved+1},ar.revision);
   const saved=tx.put(key('activity',s.activityId),'activity',{binding,input,context:context.value,intent:'active',permit:'issued',dispatch:'not_dispatched',receipt:null,budget:'reserved'},0);
   return {activityId:s.activityId,revision:saved.revision,bindingDigest:digest('binding',binding)};
  });
 }
 prepareFromArtifact(handle,commandId,raw){
  const actor=this.#principal(handle),s=spec(raw,['activityId','allocationId','artifactId','purpose']);
  for(const name of ['activityId','allocationId','artifactId','purpose'])id(s[name]);
  if(!this.#data)deny('context_bridge_unavailable');
  const observedAt=Math.max(this.#now(),this.#data.nowForPermit());
  this.#refresh(s.allocationId,observedAt);const now=this.#data.refreshForPermit(handle,s.artifactId,observedAt);
  return this.#store.command(actor,commandId,{operation:'simulation-prepare-artifact',s},tx=>{
   const ar=this.#authorized(tx,s.allocationId,actor,now),a=ar.value;
   if(tx.get(key('activity',s.activityId)))deny('active_or_terminal_activity');
   if(a.reserved+a.settled>=a.calls)deny('budget_exhausted');
   const artifact=this.#data.permitInputIn(tx,{actor,artifactId:s.artifactId,purpose:s.purpose,recipient:'local-sink'},now);
   const input=syntheticInput(artifact.content);
   const context=snapshot('execution-context',{profile:'controlled.artifact.v1',artifactId:s.artifactId,artifactDigest:artifact.artifactDigest,contextId:artifact.contextId,contextDigest:artifact.contextDigest,origins:artifact.origins});
   const binding={domain:this.#domain,activityId:s.activityId,attemptId:s.activityId+'.a1',effectId:s.activityId+'.e1',controller:actor,executor:'fixed-broker',recipient:'local-sink',purpose:s.purpose,fence:1,manifestDigest:artifactManifest.digest,inputDigest:digest('input',input),contextDigest:context.digest,effectDigest:digest('simulation-effect',input),allocationId:s.allocationId,allocationEpoch:a.epoch,cost:1,expiresAt:Math.min(a.expiresAt,artifact.retentionUntil)};
   tx.put(key('allocation',s.allocationId),'allocation',{...a,reserved:a.reserved+1},ar.revision);
   const saved=tx.put(key('activity',s.activityId),'activity',{binding,input,context:context.value,intent:'active',permit:'issued',dispatch:'not_dispatched',receipt:null,budget:'reserved'},0);
   return {activityId:s.activityId,revision:saved.revision,bindingDigest:digest('binding',binding)};
  });
 }
 #owned(actor,activityId){const r=this.#store.get(key('activity',activityId));if(!r||r.kind!=='activity'||r.value.binding.controller!==actor)deny('not_authorized');return r;}
 dispatch(handle,commandId,raw){
  const actor=this.#principal(handle),s=spec(raw,['activityId','expectedRevision','bindingDigest']);const before=this.#owned(actor,s.activityId);
  const linked=before.value.context.profile==='controlled.artifact.v1';
  if(linked&&!this.#data)deny('context_bridge_unavailable');
  const observedAt=Math.max(this.#now(),linked?this.#data.nowForPermit():0);
  let now=this.#refresh(before.value.binding.allocationId,observedAt);
  if(linked)now=this.#data.refreshForPermit(handle,before.value.context.artifactId,observedAt);
  const result=this.#store.command(actor,commandId,{operation:'simulation-dispatch',s},tx=>{
   const r=load(tx,'activity',s.activityId),v=r.value,b=v.binding;
   if(r.revision!==s.expectedRevision)deny('revision_conflict');
   if(digest('binding',b)!==s.bindingDigest)deny('binding_mismatch');
   if(v.intent!=='active'||v.permit!=='issued')deny('permit_not_issued');
   const a=this.#authorized(tx,b.allocationId,actor,now).value;
   if(a.epoch!==b.allocationEpoch||b.manifestDigest!==(v.context.profile==='controlled.artifact.v1'?artifactManifest.digest:manifest.digest)||b.contextDigest!==digest('execution-context',v.context)||b.inputDigest!==digest('input',v.input)||b.effectDigest!==digest('simulation-effect',v.input))deny('binding_mismatch');
   if(v.context.profile==='controlled.artifact.v1'){
    const artifact=this.#data.permitInputIn(tx,{actor,artifactId:v.context.artifactId,purpose:b.purpose,recipient:b.recipient,expectedDigest:v.context.artifactDigest,charge:true},now);
    if(artifact.contextDigest!==v.context.contextDigest||digest('origins',artifact.origins)!==digest('origins',v.context.origins)||digest('input',syntheticInput(artifact.content))!==b.inputDigest||now>=b.expiresAt)deny('binding_mismatch');
   }
   tx.put(key('activity',s.activityId),'activity',{...v,permit:'consumed',dispatch:'uncertain'},r.revision);
   tx.event('dispatch-recorded',{activityId:s.activityId,bindingDigest:s.bindingDigest});
   return {activityId:s.activityId,dispatch:'dispatch_recorded'};
  });
  // Only this private synchronous path can reach the sink. Historical ack cannot.
  if(result.replayed)return result;
  if(this.#fault==='kill-after-consume')process.kill(process.pid,'SIGKILL');
  if(this.#fault==='after-consume')deny('simulated_process_interruption');
  const current=this.#owned(actor,s.activityId).value;
  const receipt=this.#sink.accept(current.binding,current.input);
  if(this.#fault==='kill-after-sink')process.kill(process.pid,'SIGKILL');
  if(this.#fault==='after-sink')deny('simulated_process_interruption');
  this.#record(s.activityId,receipt);
  return result; // ack explicitly means dispatched, not successful business completion
 }
 #record(activityId,receipt){
  this.#store.transaction(tx=>{
   const r=load(tx,'activity',activityId),v=r.value;
   if(v.permit!=='consumed'||receipt.bindingDigest!==digest('binding',v.binding)||receipt.issuer!=='local-sink')deny('receipt_mismatch');
   if(v.receipt)return null;
   const a=load(tx,'allocation',v.binding.allocationId);
   if(v.budget!=='reserved'||a.value.reserved<1)deny('budget_invariant');
   tx.put(key('allocation',v.binding.allocationId),'allocation',{...a.value,reserved:a.value.reserved-1,settled:a.value.settled+1},a.revision);
   tx.put(key('activity',activityId),'activity',{...v,dispatch:'observation_confirmed',receipt,budget:'settled'},r.revision);return null;
  });
 }
 reconcile(handle,activityId){
  const actor=this.#principal(handle),v=this.#owned(actor,activityId).value;
  // Controller may inspect its own already-consumed synthetic fact after revoke.
  if(v.permit!=='consumed')deny('not_dispatched');
  const receipt=this.#sink.query(v.binding);if(receipt)this.#record(activityId,receipt);
  return {activityId,observed:receipt!==null,dispatch:receipt?'observation_confirmed':'uncertain'};
 }
 cancel(handle,commandId,activityId){
  const actor=this.#principal(handle);this.#owned(actor,activityId);
  return this.#store.command(actor,commandId,{operation:'simulation-cancel',activityId},tx=>{
   const r=load(tx,'activity',activityId),v=r.value;
   if(v.intent!=='active')return {activityId,intent:v.intent};
   const consumed=v.permit==='consumed';
   if(!consumed){const a=load(tx,'allocation',v.binding.allocationId);if(a.value.reserved<1)deny('budget_invariant');tx.put(key('allocation',v.binding.allocationId),'allocation',{...a.value,reserved:a.value.reserved-1},a.revision);}
   tx.put(key('activity',activityId),'activity',{...v,intent:consumed?'cancel_requested':'cancelled',permit:consumed?v.permit:'invalidated',budget:consumed?v.budget:'released'},r.revision);
   return {activityId,intent:consumed?'cancel_requested':'cancelled'};
  });
 }
 inspect(handle,activityId){const r=this.#owned(this.#principal(handle),activityId);if(r.value.context.profile==='controlled.artifact.v1'){const {input,context,...status}=r.value;return {revision:r.revision,...status};}return {revision:r.revision,...r.value};}
}
