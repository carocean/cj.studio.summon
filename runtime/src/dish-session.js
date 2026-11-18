import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {snapshot,digest} from '../../microkernel/src/canonical.js';
import {fields,deny,id} from '../../microkernel/src/grants.js';
import {compileDishCatalog,createDishFocus,advanceDishFocus} from './dish-focus.js';
const seal=(kind,v)=>snapshot(kind,v).value;
const key=(owner,sessionId)=>'dish-session.'+digest('dish-session-key',[owner,sessionId]).slice(7,55);
const same=(a,b)=>digest('dish-frame',a)===digest('dish-frame',b);
function frame(raw){const v=seal('dish-context',raw);fields(v,['creatureId','sceneRevision']);id(v.creatureId);if(!Number.isSafeInteger(v.sceneRevision)||v.sceneRevision<1)deny('invalid_dish_context');return v;}
// Local trusted-host adapter, not a transport or a remote permission system.
// Catalog installation and stopped acknowledgements require the configured host
// administrator. User requests cannot assert a physical playback outcome.
// Persisted records are valid only in this adapter epoch; restart fails closed.
export class DishSession {
 #store;#auth;#admin;#context;#catalogs=new Map();#epoch=randomUUID();#closed=false;
 constructor(store,auth,{administratorHandle,currentContext}){
  if(typeof currentContext!=='function'||types.isProxy(currentContext)||types.isAsyncFunction(currentContext))deny('invalid_dish_context_provider');
  this.#store=store;this.#auth=auth;this.#admin=auth.resolve(administratorHandle);this.#context=currentContext;
 }
 #open(){if(this.#closed)deny('dish_host_closed');}
 #administrator(handle){this.#open();if(this.#auth.resolve(handle)!==this.#admin)deny('dish_host_authority_required');}
 #current(handle,owner){const current=frame(this.#context(handle));this.#open();if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');return current;}
 #spec(raw,keys){const s=seal('dish-session-request',raw);fields(s,keys);return s;}
 installCatalog(admin,raw){this.#administrator(admin);const c=compileDishCatalog(raw);const old=this.#catalogs.get(c.declaration.catalogId);if(old&&old.catalogDigest!==c.catalogDigest)deny('dish_catalog_immutable');this.#catalogs.set(c.declaration.catalogId,c);return {catalogId:c.declaration.catalogId,catalogDigest:c.catalogDigest};}
 #record(reader,owner,sessionId){id(sessionId);const r=reader.get(key(owner,sessionId));if(!r||r.kind!=='dish-session'||r.value.ownerId!==owner)deny('dish_session_not_found');return r;}
 #active(handle,owner,sessionId){
  this.#open();const r=this.#record(this.#store,owner,sessionId);
  if(r.value.epoch!==this.#epoch)deny('dish_host_epoch_changed');
  if(r.value.status!=='open')deny('dish_context_changed');
  const current=this.#current(handle,owner);
  if(this.#record(this.#store,owner,sessionId).revision!==r.revision)deny('revision_conflict');
  if(!same(current,r.value.context)){
   this.#store.transaction(tx=>{const now=this.#record(tx,owner,sessionId);if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');tx.put(key(owner,sessionId),'dish-session',{...now.value,status:'stale'},now.revision);return null;});
   deny('dish_context_changed');
  }
  return r;
 }
 create(handle,raw){
  this.#open();const owner=this.#auth.resolve(handle),s=this.#spec(raw,['sessionId','taskId','catalogId','context']);id(s.sessionId);
  const context=frame(s.context),current=this.#current(handle,owner),catalog=this.#catalogs.get(s.catalogId);
  if(!same(context,current))deny('dish_context_changed');if(!catalog)deny('dish_catalog_not_installed');
  const focus=createDishFocus(catalog,s.taskId);
  return this.#store.transaction(tx=>{
   if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');
   const r=tx.put(key(owner,s.sessionId),'dish-session',{ownerId:owner,epoch:this.#epoch,status:'open',context,catalog,focus},0);
   return {sessionId:s.sessionId,revision:r.revision,focus};
  });
 }
 read(handle,raw){const owner=this.#auth.resolve(handle),s=this.#spec(raw,['sessionId']);const r=this.#active(handle,owner,s.sessionId);const item=r.value.catalog.declaration.items.find(d=>d.dishId===r.value.focus.dishId);return seal('dish-session-view',{sessionId:s.sessionId,revision:r.revision,context:r.value.context,focus:r.value.focus,presentation:item?{name:item.name,description:item.description,imageRef:item.imageRef,synthetic:true}:null});}
 #apply(handle,raw,allowStopped,admin=null){
  const owner=this.#auth.resolve(handle),s=this.#spec(raw,['sessionId','command']);
  if(!allowStopped&&s.command?.kind==='stopped')deny('dish_host_authority_required');
  const observed=this.#active(handle,owner,s.sessionId);
  if(observed.value.focus.revision>=256)deny('dish_session_command_capacity');
  return this.#store.transaction(tx=>{
   if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');if(allowStopped)this.#administrator(admin);
   const r=this.#record(tx,owner,s.sessionId);
   if(r.revision!==observed.revision)deny('revision_conflict');
   const focus=advanceDishFocus(r.value.catalog,r.value.focus,s.command);
   const saved=tx.put(key(owner,s.sessionId),'dish-session',{...r.value,focus},r.revision);
   return {sessionId:s.sessionId,revision:saved.revision,focus};
  });
 }
 command(handle,raw){return this.#apply(handle,raw,false);}
 confirmStopped(admin,ownerHandle,raw){
  this.#administrator(admin);const s=this.#spec(raw,['sessionId','expectedRevision','speechSequence']);
  return this.#apply(ownerHandle,{sessionId:s.sessionId,command:{kind:'stopped',expectedRevision:s.expectedRevision,speechSequence:s.speechSequence}},true,admin);
 }
 close(admin){this.#administrator(admin);this.#catalogs.clear();this.#closed=true;}
}
