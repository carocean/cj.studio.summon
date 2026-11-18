import {types} from 'node:util';
import {snapshot,digest,canonical} from '../../microkernel/src/canonical.js';
import {fields,deny,id} from '../../microkernel/src/grants.js';
import {accountDefinitions} from './choice-form.js';

const seal=v=>snapshot('primary-draft-handoff',v).value;
const spec=(raw,keys)=>{const v=seal(raw);fields(v,keys);return v;};
const recordKey=handoffId=>'primary-handoff.'+id(handoffId);
const indexKey=owner=>'primary-handoff-index.'+digest('handoff-owner',owner).slice(7,55);
export const handoffPrincipal=(owner,creature)=>'agent-'+digest('handoff-principal',[owner,creature]).slice(7,55);
const purpose='draft-return';
const terminal=new Set(['delivered','blocked','expired','cancelled']);

// Fixed trusted-host choreography, not a general agent scheduler or owner proxy.
// Every resource, identity, command, scope, deadline and budget is frozen before
// the separate explicit confirmation. The only computation is exact concatenation.
export class PrimaryDraftHandoff {
 #store;#auth;#ledger;#data;#mailbox;#registry;#current;#admin;#after;
 constructor(store,identities,{ledger,data,mailbox,registry,currentBinding,administratorHandle,afterStage=()=>{}}){
  if(!ledger.belongsTo(store,identities)||!registry.belongsTo(store,identities))deny('handoff_domain_mismatch');
  data.assertBrokerDomain(store,identities);mailbox.assertDomain(store,identities);
  if(ledger.principal(administratorHandle)!=='host-admin')deny('not_authorized');
  if(typeof currentBinding!=='function'||types.isAsyncFunction(currentBinding)||types.isProxy(currentBinding)||typeof afterStage!=='function'||types.isAsyncFunction(afterStage)||types.isProxy(afterStage))deny('invalid_handoff_host');
  this.#store=store;this.#auth=identities;this.#ledger=ledger;this.#data=data;this.#mailbox=mailbox;this.#registry=registry;this.#current=currentBinding;this.#admin=administratorHandle;this.#after=afterStage;
 }
 #stage(name,p){const value=this.#after(name,p.handoffId);if(types.isPromise(value))deny('async_handoff_hook');}
 #record(owner,handoffId){id(handoffId);const r=this.#store.get(recordKey(handoffId));if(!r||r.value.ownerId!==owner)deny('handoff_not_authorized');return r;}
 #save(p,patch){this.#store.transaction(tx=>{const r=tx.get(recordKey(p.handoffId));tx.put(recordKey(p.handoffId),'primary-handoff',{...r.value,...patch},r.revision);return null;});return this.#record(p.ownerId,p.handoffId).value;}
 #handles(p){return {primary:this.#auth.authenticate(p.coordinatorPrincipal),worker:this.#auth.authenticate(p.workerPrincipal)};}
 #binding(handle){
  const ownerId=this.#auth.resolve(handle),registry=this.#registry.state(handle),current=seal(this.#current(handle));
  fields(current,['context','task']);fields(current.context,['creatureId','sceneRevision']);id(current.context.creatureId);
  if(!Number.isSafeInteger(current.context.sceneRevision)||current.context.sceneRevision<1)deny('invalid_handoff_context');
  const coordinatorId=registry.primaryCreatureId;
  if(!coordinatorId||coordinatorId==='work'||current.context.creatureId!==coordinatorId)deny('handoff_primary_foreground_required');
  this.#registry.get(handle,'work');this.#registry.get(handle,coordinatorId);
  const t=current.task;
  if(!t||t.status!=='draft'||!Number.isSafeInteger(t.revision)||t.revision<1)deny('handoff_draft_required');
  id(t.id);fields(t.values,accountDefinitions.map(d=>d.id));
  for(const d of accountDefinitions)if(!d.options.includes(t.values[d.id]))deny('handoff_synthetic_values_required');
  const values=seal(t.values),binding={ownerId,coordinatorId,workerId:'work',registryRevision:registry.revision,context:current.context,activityId:t.id,activityRevision:t.revision,valuesDigest:digest('handoff-values',values)};
  return {binding,values};
 }
 #receipt(p){
  let receipt;try{receipt=this.#mailbox.inspect(this.#handles(p).primary,p.mailId);}catch(error){if(error.code==='local_mail_not_authorized')return null;throw error;}
  if(receipt.mailId!==p.mailId||receipt.sender!==p.workerPrincipal||receipt.recipientId!==p.coordinatorPrincipal||receipt.artifactId!==p.ids.artifact||receipt.purpose!==purpose||receipt.retentionUntil!==p.expiresAt||receipt.fact!=='local_recipient_copy_saved')deny('handoff_receipt_mismatch');
  return receipt;
 }
 #terminate(p,status,reason){
  if(p.status!=='invalidating'){p=this.#save(p,{status:'invalidating',terminalStatus:status,reason});this.#stage('termination-intent',p);}
  const root=this.#store.get('grant.'+p.ids.root);
  if(root){this.#ledger.revoke(this.#admin,p.ids.revoke,p.ids.root);this.#stage('root-revoked',p);}
  return this.#save(p,{status:p.terminalStatus,terminalStatus:null});
 }
 #reconcile(handle,p){
  const receipt=this.#receipt(p);
  if(receipt){if(p.status!=='delivered')p=this.#save(p,{status:'delivered',reason:null,terminalStatus:null});return {p,receipt};}
  if(p.status==='invalidating')return {p:this.#terminate(p,p.terminalStatus,p.reason),receipt:null};
  if(terminal.has(p.status))return {p,receipt:null};
  if(this.#ledger.now()>=p.expiresAt)return {p:this.#terminate(p,'expired','deadline_observed'),receipt:null};
  let binding;
  try{binding=this.#binding(handle).binding;}catch{return {p:this.#terminate(p,'blocked','binding_changed'),receipt:null};}
  if(digest('handoff-binding',binding)!==digest('handoff-binding',p.binding))return {p:this.#terminate(p,'blocked','binding_changed'),receipt:null};
  for(const grantId of [p.ids.root,p.ids.child]){
   const g=this.#store.get('grant.'+grantId);
   if(g&&g.value.status!=='active')return {p:this.#terminate(p,'blocked','authority_withdrawn'),receipt:null};
  }
  const source=this.#store.get('source.'+p.ids.source);
  if(source&&source.value.status!=='active')return {p:this.#terminate(p,'blocked','source_withdrawn'),receipt:null};
  return {p,receipt:null};
 }
 #view({p,receipt}){return seal({handoff:{handoffId:p.handoffId,status:p.status,coordinatorId:p.binding.coordinatorId,workerId:p.binding.workerId,values:p.values,binding:p.binding,expiresAt:p.expiresAt,budget:p.budget,reason:p.reason,receipt},mode:'deterministic-synthetic-draft-return',contentReturned:false});}
 prepare(handle,raw){
  const ownerId=this.#auth.resolve(handle),r=spec(raw,['context']);fields(r.context,['creatureId','sceneRevision']);
  const {binding,values}=this.#binding(handle);if(digest('handoff-frame',r.context)!==digest('handoff-frame',binding.context))deny('handoff_context_changed');
  const suffix=digest('primary-draft-handoff',[ownerId,binding]).slice(7,55),handoffId='handoff-'+suffix;
  const prior=this.#store.get(recordKey(handoffId));if(prior)return this.#view(this.#reconcile(handle,this.#record(ownerId,handoffId).value));
  const createdAt=this.#ledger.now(),expiresAt=createdAt+300000;if(!Number.isSafeInteger(expiresAt))deny('invalid_clock');
  const coordinatorPrincipal=handoffPrincipal(ownerId,binding.coordinatorId),workerPrincipal=handoffPrincipal(ownerId,'work');
  const ids={source:'hs-'+suffix,root:'hr-'+suffix,child:'hg-'+suffix,context:'hx-'+suffix,artifact:'ha-'+suffix,sourceCommand:'hsc-'+suffix,rootCommand:'hrc-'+suffix,childCommand:'hgc-'+suffix,contextCommand:'hxc-'+suffix,runCommand:'hac-'+suffix,deliveryCommand:'hmc-'+suffix,revoke:'hrev-'+suffix};
  const content=canonical(values),budget={calls:3,bytes:3*Buffer.byteLength(content)};
  const p={handoffId,ownerId,binding,values,content,coordinatorPrincipal,workerPrincipal,ids,mailId:'mail-'+digest('mail-delivery',[workerPrincipal,ids.deliveryCommand]).slice(7,55),createdAt,expiresAt,budget,status:'prepared',reason:null,terminalStatus:null};
  this.#store.transaction(tx=>{const index=tx.get(indexKey(ownerId)),ids=index?.value.ids??[];if(ids.length>=32)deny('handoff_capacity');tx.put(recordKey(handoffId),'primary-handoff',p,0);tx.put(indexKey(ownerId),'primary-handoff-index',{ids:[...ids,handoffId]},index?.revision??0);return null;});
  return this.#view({p,receipt:null});
 }
 confirm(handle,raw){
  const ownerId=this.#auth.resolve(handle),r=spec(raw,['handoffId','confirmation']);if(r.confirmation!=='share-synthetic-draft')deny('handoff_confirmation_required');
  let current=this.#reconcile(handle,this.#record(ownerId,r.handoffId).value);
  if(current.receipt)return this.#view(current);if(!['prepared','running'].includes(current.p.status))deny('handoff_not_ready');
  if(current.p.status==='prepared'){current={...current,p:this.#save(current.p,{status:'running'})};this.#stage('confirmed',current.p);}
  const p=current.p,{primary,worker}=this.#handles(p),recipients=[p.coordinatorPrincipal,p.workerPrincipal].sort();
  const grant={resources:[p.ids.source],operations:['derive','disclose','read'],purposes:[purpose],recipients,budget:p.budget,expiresAt:p.expiresAt};
  const stages=[
   ['source',()=>this.#data.createSource(this.#admin,p.ids.sourceCommand,{sourceId:p.ids.source,controller:ownerId,content:p.content,purposes:[purpose],recipients,retentionUntil:p.expiresAt})],
   ['root',()=>this.#ledger.issueRoot(this.#admin,p.ids.rootCommand,{...grant,grantId:p.ids.root,rootPrincipal:ownerId,delegate:p.coordinatorPrincipal,maxDepth:1})],
   ['child',()=>this.#ledger.attenuate(primary,p.ids.childCommand,p.ids.root,{...grant,grantId:p.ids.child,delegate:p.workerPrincipal,maxDepth:0})],
   ['context',()=>this.#data.createContext(worker,p.ids.contextCommand,{contextId:p.ids.context,bindings:[{sourceId:p.ids.source,grantId:p.ids.child}],stateRefs:[],purpose})],
   ['run',()=>this.#data.run(worker,p.ids.runCommand,{contextId:p.ids.context,artifactId:p.ids.artifact})],
   ['mail',()=>this.#mailbox.deliver(worker,p.ids.deliveryCommand,{artifactId:p.ids.artifact,purpose,recipientId:p.coordinatorPrincipal})],
  ];
  for(const [name,apply] of stages){
   current=this.#reconcile(handle,this.#record(ownerId,p.handoffId).value);
   if(current.receipt)return this.#view(current);if(current.p.status!=='running')deny('handoff_not_ready');
   apply();this.#stage(name,p);
  }
  current=this.#reconcile(handle,this.#record(ownerId,p.handoffId).value);
  if(!current.receipt)deny('handoff_receipt_missing');return this.#view(current);
 }
 status(handle,raw){const owner=this.#auth.resolve(handle),r=spec(raw,['handoffId']);return this.#view(this.#reconcile(handle,this.#record(owner,r.handoffId).value));}
 cancel(handle,raw){
  const owner=this.#auth.resolve(handle),r=spec(raw,['handoffId']);let p=this.#record(owner,r.handoffId).value;
  const receipt=this.#receipt(p);if(receipt)return this.#view(this.#reconcile(handle,p));
  if(p.status==='invalidating')p=this.#terminate(p,p.terminalStatus,p.reason);
  else if(!terminal.has(p.status))p=this.#terminate(p,'cancelled','owner_cancelled');
  return this.#view({p,receipt:null});
 }
 list(handle,raw={}){
  const owner=this.#auth.resolve(handle);spec(raw,[]);
  return seal({handoffs:(this.#store.get(indexKey(owner))?.value.ids??[]).map(handoffId=>{
   const {p,receipt}=this.#reconcile(handle,this.#record(owner,handoffId).value);
   return {handoffId,status:p.status,coordinatorId:p.binding.coordinatorId,workerId:p.binding.workerId,activityId:p.binding.activityId,expiresAt:p.expiresAt,receipt};
  }),limit:32,contentReturned:false});
 }
 invalidatePending(handle){this.list(handle);}
 // Host-only recipient entry point. An owner's handle is NOT a creature handle.
 read(handle,raw){
  const principal=this.#auth.resolve(handle),r=spec(raw,['handoffId']),record=this.#store.get(recordKey(r.handoffId));
  if(!record||record.value.coordinatorPrincipal!==principal)deny('handoff_not_authorized');
  return this.#mailbox.read(handle,record.value.mailId);
 }
}
