import {types} from 'node:util';
import {snapshot,digest} from '../../microkernel/src/canonical.js';
import {fields,deny,id} from '../../microkernel/src/grants.js';
const seal=v=>{const s=snapshot('real-usage',v);if(Buffer.byteLength(s.bytes)>16384)deny('usage_size_limit');return s.value;};
const key=(owner,part)=>'usage-'+digest('usage-key',[owner,part]).slice(7,55);
const empty=owner=>({ownerId:owner,receiptCount:0,learningCount:0,learningSaturated:false,items:[]});
const sync=f=>typeof f==='function'&&!types.isProxy(f)&&!types.isAsyncFunction(f);

// Small owner-local statistics, not permission, human-attention proof or a
// backfill of model/create/read events. The host alone supplies action callbacks.
export class RealUsageHistory {
 #store;#auth;#clock;#entries;#receipts;#events;
 constructor(store,auth,{clock=()=>Date.now(),maxEntries=32,maxReceipts=1024,maxLearningEvents=1024}={}){
  if(!sync(clock)||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>32||!Number.isSafeInteger(maxReceipts)||maxReceipts<1||maxReceipts>1024||!Number.isSafeInteger(maxLearningEvents)||maxLearningEvents<1||maxLearningEvents>1024)deny('invalid_usage_configuration');
  this.#store=store;this.#auth=auth;this.#clock=clock;this.#entries=maxEntries;this.#receipts=maxReceipts;this.#events=maxLearningEvents;
 }
 #index(reader,owner){const r=reader.get(key(owner,'index'));if(r&&r.value.ownerId!==owner)deny('usage_owner_mismatch');return r;}
 state(handle){const owner=this.#auth.resolve(handle);return seal(this.#index(this.#store,owner)?.value??empty(owner));}
 query(handle,raw){
  const r=seal(raw);fields(r,['commandId']);id(r.commandId);const owner=this.#auth.resolve(handle),receipt=this.#store.get(key(owner,'receipt:'+r.commandId));
  if(receipt)return seal({status:'completed',commandId:r.commandId,ack:receipt.value.ack});
  return this.#index(this.#store,owner)?.value.learningSaturated?{status:'untracked',commandId:r.commandId,reason:'learning-saturated'}:{status:'not_started',commandId:r.commandId};
 }
 perform(handle,commandId,request,{prepare=()=>null,apply}){
  id(commandId);if(!sync(prepare)||!sync(apply))deny('invalid_usage_callback');
  const owner=this.#auth.resolve(handle),spec=seal(request),opKey=key(owner,'receipt:'+commandId),commandKey='usage-'+digest('usage-command',[owner,commandId]).slice(7,55);
  if(this.#store.get(opKey)){
   const prior=this.#store.command(owner,commandKey,spec,()=>deny('usage_receipt_corrupt'));
   return {...prior,receiptStored:true};
  }
  // Preparation may observe/latch a session's expiry in its own transaction.
  // It is synchronous: no asynchronous gap between validation and action commit.
  const prepared=prepare();if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');
  const saturated=this.#index(this.#store,owner)?.value.learningSaturated===true;
  const commit=tx=>{
   if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');
   const now=this.#clock();if(!Number.isSafeInteger(now)||now<0)deny('invalid_clock');
   const outcome=apply(tx,prepared,now),target=outcome.target;
   fields(target,['kind','targetId']);if(!['creature','interaction-session'].includes(target.kind))deny('invalid_usage_target');id(target.targetId);
   if(typeof outcome.qualifies!=='boolean')deny('invalid_usage_outcome');
   const record=this.#index(tx,owner),state=record?.value??empty(owner);
   const existing=state.items.find(i=>i.kind===target.kind&&i.targetId===target.targetId);
   let items=state.items,learningCount=state.learningCount,recorded=false,reason=outcome.qualifies?'learning-saturated':'same-target',useCount=existing?.useCount??null;
   if(outcome.qualifies&&!state.learningSaturated){
    useCount=(existing?.useCount??0)+1;recorded=true;reason='recorded';learningCount++;
    const item={...target,useCount,lastUsedAt:Math.max(now,existing?.lastUsedAt??0)};
    items=existing?items.map(i=>i===existing?item:i):[...items,item];
   }
   const ack=seal({...outcome.ack,usage:{recorded,reason,useCount}});
   if(!saturated){
    const receiptCount=state.receiptCount+1;
    tx.put(key(owner,'index'),'real-usage-index',seal({ownerId:owner,receiptCount,learningCount,learningSaturated:items.length>=this.#entries||receiptCount>=this.#receipts||learningCount>=this.#events,items}),record?.revision??0);
    tx.put(opKey,'real-usage-receipt',{commandId,ack},0);
   }
   if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');
   return ack;
  };
  // Permanently saturated history never creates more receipts or learns again.
  // Selection still uses the host's before-context CAS. Its unrecorded outcome
  // is explicitly not queryable; untracked must never be treated as not_started.
  if(saturated)return {replayed:false,receiptStored:false,ack:this.#store.transaction(commit)};
  return {...this.#store.command(owner,commandKey,spec,commit),receiptStored:true};
 }
}
