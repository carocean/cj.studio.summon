import {DishNarration} from './dish-narration.js';
import {DishSession} from './dish-session.js';
import {ReadingViews} from './reading-views.js';
import {TextInteractionGeneration} from './text-interaction-generation.js';
import {RealUsageHistory} from './real-usage-history.js';
import {InteractionSession} from './interaction-session.js';
import {PrimaryDraftHandoff} from './primary-draft-handoff.js';
import {LocalArtifactMailbox} from './local-artifact-mailbox.js';
import {parseCreatureName} from './spoken-creature.js';
import {hearingSceneCandidate} from './scene-intent.js';
import {FocusService} from './focus-service.js';
import { types } from 'node:util';
import { SnapshotStore } from '../../microkernel/src/store.js';
import { HostIdentity } from '../../microkernel/src/identity.js';
import { GrantLedger } from '../../microkernel/src/grants.js';
import { ControlledContextLab } from '../../microkernel/src/context.js';
import { PermitLab, syntheticInput } from '../../microkernel/src/permits.js';
import { canonical, snapshot, digest } from '../../microkernel/src/canonical.js';
import { fields, deny } from '../../microkernel/src/grants.js';
import {CreatureMarket} from './creature-market.js';
import {CreatureRegistry} from './creature-registry.js';
import {creatureDefinitions as creatures,presentCreature} from './presentation.js';
import {accountDefinitions as definitions,buildChoiceForms,validateChoiceSubmission} from './choice-form.js';
const clean=(raw,required)=>{const v=snapshot('scene-request',raw).value;fields(v,required);return v;};

function withoutTextEntry(v){const {textEntryVisible,...rest}=v;return rest;}
function applySignal(v,s) {
 v=withoutTextEntry(v);
 if(s.signal==='text-entry-request')return {...v,textEntryVisible:true};
 const event={modality:s.modality,signal:s.signal,origin:s.origin??'synthetic-preview',sourceEventId:s.sourceEventId??null,businessMode:'synthetic-only'};
 if(s.signal==='personal-context')return {...v,activeCreatureId:'companion'};
 if(s.signal==='work-context')return {...v,activeCreatureId:'work'};
 const activity=v.activity?{...v.activity,sceneVisible:true}:{id:'task-'+v.nextTask,revision:1,status:'draft',sceneVisible:true,values:{},receipt:null,perception:event,submission:null};
 return {...v,activeCreatureId:'work',nextTask:v.activity?v.nextTask:v.nextTask+1,activity};
}
// One synthetic local demo owner. Not authentication for multi-user deployment.
export class SceneLab {
 #store;#auth;#admin;#worker;#data;#grants;#permits;#clock;#closed=false;#registry;#owner;#market;#focus;#handoff;#interactions;#usage;#textGeneration;#reading;#dish;#dishNarrators=new Set();
 constructor(path,sinkPath,{clock=()=>Date.now(),marketOptions={},handoffOptions={},usageOptions={},textGenerationOptions={},readingOptions={}}={}){
  fields(textGenerationOptions,[],['planner','ttlMs','maxAttempts']);
  readingOptions=snapshot('scene-reading-options',readingOptions).value;fields(readingOptions,[],['installedFontIds','maxResources','maxViewsPerOwner','maxCommandsPerOwner','maxAccessRecords']);
  this.#clock=clock;this.#auth=new HostIdentity();this.#reading=new ReadingViews(this.#auth,readingOptions);this.#store=new SnapshotStore(path);
  this.#owner=this.#auth.authenticate('demo-owner');this.#usage=new RealUsageHistory(this.#store,this.#auth,{clock,...usageOptions});this.#registry=new CreatureRegistry(this.#store,this.#auth);
  for(const c of creatures)if(!this.#registry.list(this.#owner).some(v=>v.id===c.id)){
   this.#registry.create(this.#owner,{...c,kind:c.id==='companion'?'companion':'business'});
   for(const modality of ['hearing','vision'])this.#registry.setSense(this.#owner,{creatureId:c.id,modality,enabled:true,expectedRevision:this.#registry.state(this.#owner).revision});
  }
  this.#market=new CreatureMarket(this.#store,this.#auth,this.#registry,marketOptions);
  this.#focus=new FocusService(this.#store,this.#auth,this.#registry,{clock});
  this.#admin=this.#auth.authenticate('host-admin');this.#worker=this.#auth.authenticate('demo-work');
  this.#grants=new GrantLedger(this.#store,this.#auth,{clock});this.#data=new ControlledContextLab(this.#store,this.#grants);
  this.#permits=new PermitLab(this.#store,this.#auth,sinkPath,{clock,contextLab:this.#data});
  this.#store.transaction(tx=>{if(!tx.get('scene-state'))this.#putScene(tx,{activeCreatureId:'companion',nextTask:1,activity:null},0);return null;});
  this.#interactions=new InteractionSession(this.#store,this.#auth,{clock,currentContext:handle=>{
   if(this.#auth.resolve(handle)!=='demo-owner')deny('unauthenticated');
   return this.captureSenseContext();
  }});
  this.#textGeneration=new TextInteractionGeneration(this.#store,this.#auth,this.#interactions,{...textGenerationOptions,clock,currentContext:handle=>{if(this.#auth.resolve(handle)!=='demo-owner')deny('unauthenticated');return this.captureSenseContext();}});
  const mailbox=new LocalArtifactMailbox(this.#store,this.#auth,this.#data);
  this.#handoff=new PrimaryDraftHandoff(this.#store,this.#auth,{ledger:this.#grants,data:this.#data,mailbox,registry:this.#registry,administratorHandle:this.#admin,...handoffOptions,currentBinding:handle=>{
   if(this.#auth.resolve(handle)!=='demo-owner')deny('handoff_not_authorized');
   const scene=this.#store.get('scene-state'),task=scene.value.activity;
   return {context:{creatureId:scene.value.activeCreatureId,sceneRevision:scene.revision},task:task?{id:task.id,revision:task.revision,status:task.status,values:task.values}:null};
  }});
  this.#dish=new DishSession(this.#store,this.#auth,{administratorHandle:this.#admin,currentContext:handle=>{if(this.#auth.resolve(handle)!=='demo-owner')deny('unauthenticated');return this.captureSenseContext();}});
  this.#handoff.invalidatePending(this.#owner);
 }
 close(){if(this.#closed)return;if(this.#dishNarrators.size)deny('dish_narration_retire_required');this.#dish.close(this.#admin);this.#reading.retireHost(this.#admin);this.#textGeneration.close();this.#permits.close();this.#store.close();this.#closed=true;}
 #open(){if(this.#closed)deny('scene_lab_closed');}
 #putScene(tx,value,expectedRevision){if(this.#dishNarrators.size)deny('dish_narration_retire_required');return tx.put('scene-state','scene-state',value,expectedRevision);}
 #change(apply){this.#open();if(this.#dishNarrators.size)deny('dish_narration_retire_required');this.#store.transaction(tx=>{const r=tx.get('scene-state');const value=apply(withoutTextEntry(r.value));if(r.value.activity&&value.activity?.id!==r.value.activity.id)tx.put('scene-history.'+r.value.activity.id,'scene-history',r.value.activity,0);this.#putScene(tx,value,r.revision);return null;});this.#handoff?.invalidatePending(this.#owner);return this.state();}
 state(){
  this.#open();const scene=this.#store.get('scene-state'),value=scene.value;
  const a=value.activity,registry=this.#registry.state(this.#owner),marketFull=this.#market.state(this.#owner),focus=this.#focus.state(this.#owner);
  // Aggregate-view budget only: retain complete request index and current route.
  // Underlying market history is unchanged; its own view still exposes 16 receipts.
  const market={...marketFull,receipts:marketFull.receipts.slice(-8),receiptWindow:8};
  const choiceForms=buildChoiceForms({context:{creatureId:value.activeCreatureId,sceneRevision:scene.revision},activity:a,market,focus});
  return snapshot('scene-view',{...(value.textEntryVisible?{textEntry:{schema:'scene-text-entry.v1',context:{creatureId:value.activeCreatureId,sceneRevision:scene.revision},maxLength:200,source:'deterministic-policy'}}:{}),mode:'deterministic-synthetic',presentation:presentCreature(value,registry.creatures),creatures:registry.creatures,primaryCreatureId:registry.primaryCreatureId,registryRevision:registry.revision,context:this.captureSenseContext(),market,focus,choiceForms,route:value.routeView??null,activeCreatureId:value.activeCreatureId,activity:a?{id:a.id,status:a.status,sceneVisible:a.sceneVisible,revision:a.revision,
   form:{schema:'synthetic-account.v1',fields:definitions.map(d=>({...d,type:'choice',value:a.values[d.id]??null}))},receipt:a.receipt}:null}).value;
 }
 // Explicit host-only lifecycle: stop/retire adapters before scene change or close.
 createDishNarration(options){
  this.#open();fields(options,['synthesizer','player'],['timeoutMs']);
  const narrator=new DishNarration(this.#dish,this.#auth,{...options,administratorHandle:this.#admin});
  this.#dishNarrators.add(narrator);
  return Object.freeze({
   start:raw=>{this.#open();return narrator.start(this.#owner,raw);},
   pauseForInput:raw=>{this.#open();return narrator.pauseForInput(this.#owner,raw);},
   requestExplanation:raw=>{this.#open();return narrator.requestExplanation(this.#owner,raw);},
   cancel:()=>narrator.cancel(this.#admin),
   close:async()=>{await narrator.close(this.#admin);this.#dishNarrators.delete(narrator);},
  });
 }
 // Dish creation, catalog setup and playback acknowledgements remain host-only.
 installDishCatalog(raw){this.#open();return this.#dish.installCatalog(this.#admin,raw);}
 createDishSession(raw){this.#open();return this.#dish.create(this.#owner,raw);}
 confirmDishStopped(raw){this.#open();return this.#dish.confirmStopped(this.#admin,this.#owner,raw);}
 readDish(raw){this.#open();return this.#dish.read(this.#owner,raw);}
 commandDish(raw){this.#open();const r=clean(raw,['sessionId','command']);this.#dish.command(this.#owner,r);return this.#dish.read(this.#owner,{sessionId:r.sessionId});}
 // Reading resources/access are explicit trusted host inputs, never HTTP payloads.
 installReadingResource(raw){this.#open();return this.#reading.installResource(this.#admin,raw);}
 configureReadingAccess(raw){this.#open();const r=clean(raw,['resourceId','contentDigest','enabled','expectedGeneration']);return this.#reading.setAccess(this.#admin,{...r,ownerId:'demo-owner'});}
 readingState(){this.#open();return Object.freeze({epoch:this.#reading.epoch,persistence:'volatile'});}
 openReading(raw){this.#open();const r=clean(raw,['commandId','epoch','viewId','resourceId','contentDigest','presentation']);const {commandId,...spec}=r;return this.#reading.open(this.#owner,commandId,spec);}
 readReading(raw){this.#open();return this.#reading.read(this.#owner,raw);}
 queryReading(raw){this.#open();return this.#reading.query(this.#owner,raw);}
 closeReading(raw){this.#open();const r=clean(raw,['commandId','epoch','viewId','expectedRevision']);const {commandId,...spec}=r;return this.#reading.close(this.#owner,commandId,spec);}
 // Trusted host only. No HTTP route can configure this owner capability or adapter.
 configureTextGeneration(raw){this.#open();return this.#textGeneration.setEnabled(this.#owner,raw);}
 textGenerationState(){this.#open();return this.#textGeneration.state(this.#owner);}
 generateTextInteraction(raw){this.#open();return this.#textGeneration.generate(this.#owner,raw);}
 queryTextGeneration(raw){this.#open();return this.#textGeneration.query(this.#owner,raw);}
 cancelTextGeneration(raw){this.#open();return this.#textGeneration.cancel(this.#owner,raw);}
 // Host-only proposal installation. No HTTP route accepts programs or source
 // metadata. Source is an audit description, never evidence of model inference.
 createInteraction(raw){
  this.#open();const r=clean(raw,['commandId','sessionId','context','program','source']);const {commandId,...spec}=r;
  return this.#interactions.create(this.#owner,commandId,spec);
 }
 reviseInteraction(raw){return this.#interactionCommand('revise',raw);}
 readInteraction(raw){this.#open();return this.#interactions.read(this.#owner,raw);}
 editInteraction(raw){return this.#interactionCommand('edit',raw);}
 saveInteraction(raw){return this.#interactionCommand('save',raw);}
 closeInteraction(raw){return this.#interactionCommand('close',raw);}
 queryInteraction(raw){this.#open();return this.#interactions.query(this.#owner,raw);}
 readSavedInteraction(raw){this.#open();return this.#interactions.readSaved(this.#owner,raw);}
 #interactionCommand(action,raw){
  this.#open();const r=snapshot('scene-interaction-command',raw).value;
  if(!r||typeof r!=='object'||Array.isArray(r)||!Object.hasOwn(r,'commandId'))deny('invalid_shape');
  const {commandId,...spec}=r;return this.#interactions[action](this.#owner,commandId,spec);
 }
 currentInteraction(){
  this.#open();
  return this.#interactions.currentReference(this.#owner);
 }
 usage(){
  this.#open();const history=this.#usage.state(this.#owner),items=[];
  for(const item of history.items){
   if(item.useCount<2)continue;
   try{
    const label=item.kind==='creature'?this.creature(item.targetId).name:this.readInteraction({sessionId:item.targetId}).program.declaration.title;
    items.push({...item,label});
   }catch(error){if(!['creature_not_found','interaction_session_not_found','interaction_session_expired','interaction_session_closed','interaction_context_changed'].includes(error.code))throw error;}
  }
  items.sort((a,b)=>b.useCount-a.useCount||b.lastUsedAt-a.lastUsedAt||a.kind.localeCompare(b.kind)||a.targetId.localeCompare(b.targetId));
  return {schema:'real-usage-history.v1',sourceTrust:'host-actions-and-client-presentation-reports',minUses:2,learningSaturated:history.learningSaturated,items:items.slice(0,6)};
 }
 queryUsage(raw){this.#open();return this.#usage.query(this.#owner,raw);}
 selectCreatureWithUsage(raw){
  this.#open();const r=clean(raw,['commandId','creatureId','context']);fields(r.context,['creatureId','sceneRevision']);
  const {commandId,...spec}=r;
  const result=this.#usage.perform(this.#owner,commandId,{operation:'creature-select',...spec},{apply:tx=>{
   this.creature(r.creatureId);this.assertSenseContext(r.context);
   const current=tx.get('scene-state'),changed=current.value.activeCreatureId!==r.creatureId;
   const saved=changed?this.#putScene(tx,{...withoutTextEntry(current.value),activeCreatureId:r.creatureId},current.revision):current;
   return {target:{kind:'creature',targetId:r.creatureId},qualifies:changed,ack:{fact:'creature_selection_confirmed',creatureId:r.creatureId,changed,context:{creatureId:r.creatureId,sceneRevision:saved.revision}}};
  }});
  if(!result.replayed&&result.ack.changed)this.#handoff.invalidatePending(this.#owner);
  return result;
 }
 reportInteractionPresented(raw){
  this.#open();const r=clean(raw,['commandId','sessionId','context','expectedRevision','programDigest','confirmation']);fields(r.context,['creatureId','sceneRevision']);
  if(r.confirmation!=='presented-explicitly')deny('usage_presentation_confirmation_required');
  if(!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<1||typeof r.programDigest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(r.programDigest))deny('invalid_usage_binding');
  const {commandId,...spec}=r;
  let observedExpiry=null;
  try{return this.#usage.perform(this.#owner,commandId,{operation:'interaction-presented',...spec},{prepare:()=>{
   const view=this.readInteraction({sessionId:r.sessionId});
   if(canonical(view.context)!==canonical(r.context)||view.revision!==r.expectedRevision||view.program.programDigest!==r.programDigest)deny('usage_binding_changed');
   return view;
  },apply:(_tx,view,now)=>{
   this.assertSenseContext(r.context);if(now>=view.expiresAt){observedExpiry=now;deny('interaction_session_expired');}
   if(view.ownerId!==this.#auth.resolve(this.#owner))deny('unauthenticated');
   return {target:{kind:'interaction-session',targetId:r.sessionId},qualifies:true,ack:{fact:'interaction_presentation_reported',sessionId:r.sessionId,revision:view.revision,programDigest:view.program.programDigest}};
  }});}catch(error){
   // The usage transaction has rolled back. Preserve the expiry observation in
   // its own authenticated transaction, even if the host clock now rolls back.
   if(observedExpiry!==null)this.#interactions.latchObservedExpiry(this.#owner,{sessionId:r.sessionId,observedAt:observedExpiry});
   throw error;
  }
 }
 textEntry(raw){
  const s=clean(raw,['context','visible']);fields(s.context,['creatureId','sceneRevision']);
  if(typeof s.visible!=='boolean')deny('invalid_text_entry');
  this.assertSenseContext(s.context);
  return this.#change(v=>s.visible?{...v,textEntryVisible:true}:v);
 }
 textRequest(raw){
  const s=clean(raw,['context','text','confirmation']);fields(s.context,['creatureId','sceneRevision']);
  this.assertSenseContext(s.context);
  if(!this.#store.get('scene-state').value.textEntryVisible)deny('text_entry_unavailable');
  if(s.confirmation!=='apply-direct-text-scene')deny('text_confirmation_required');
  if(typeof s.text!=='string'||!s.text.trim()||s.text.length>200)deny('invalid_text_request');
  const signal=hearingSceneCandidate(s.text);
  if(!['work-context','personal-context','account-request'].includes(signal))deny('unsupported_text_request');
  // Explicit user input is not sensory evidence. Persist only the finite intent,
  // never the original text, and do not send it to a model or external service.
  return this.#change(v=>applySignal(v,{modality:'direct-text',signal,origin:'direct-user-request'}));
 }
 prepareHandoff(raw){this.#open();return this.#handoff.prepare(this.#owner,raw);}
 confirmHandoff(raw){this.#open();return this.#handoff.confirm(this.#owner,raw);}
 queryHandoff(raw){this.#open();return this.#handoff.status(this.#owner,raw);}
 cancelHandoff(raw){this.#open();return this.#handoff.cancel(this.#owner,raw);}
 listHandoffs(raw){this.#open();return this.#handoff.list(this.#owner,raw);}
 queryFocus(raw){this.#open();return this.#focus.getPlan(this.#owner,raw);}
 grantFocus(raw){this.#open();this.#focus.grant(this.#owner,raw);return this.state();}
 cancelFocus(raw){this.#open();this.#focus.cancel(this.#owner,raw);return this.state();}
 createFocusForm(raw){
  const input=clean(raw,['formId','binding','values','requestId']),current=this.state().choiceForms.focus;
  const values=validateChoiceSubmission(current,{formId:input.formId,binding:input.binding,values:input.values});
  // Fixed synchronous creation gate; historical facts recover through state.
  this.#focus.create(this.#owner,{requestId:input.requestId,binding:current.binding,values});return this.state();
 }
 updateChoiceForm(raw){
  const input=clean(raw,['formId','binding','values']),current=this.state().choiceForms.account;
  const values=validateChoiceSubmission(current,input);
  // Validation and dispatch are synchronous: no authority-changing await gap.
  return this.update({activityId:current.binding.activityId,expectedRevision:current.binding.activityRevision,values});
 }
 routeChoiceForm(raw){
  const input=clean(raw,['formId','binding','values','requestId']),current=this.state().choiceForms.route;
  const values=validateChoiceSubmission(current,{formId:input.formId,binding:input.binding,values:input.values});
  return this.requestRoute({productId:current.binding.productId,instanceId:current.binding.instanceId,from:values.from,to:values.to,requestId:input.requestId});
 }
 subscribeCreature(raw){this.#open();this.#market.subscribe(this.#owner,raw);this.#handoff.invalidatePending(this.#owner);return this.state();}
 grantRoute(raw){this.#open();this.#market.grantRoute(this.#owner,raw);return this.state();}
 cancelRouteRequest(raw){this.#open();this.#market.cancelRequest(this.#owner,raw);return this.state();}
 unsubscribeCreature(raw){this.#open();this.#market.unsubscribe(this.#owner,raw);this.#handoff.invalidatePending(this.#owner);return this.state();}
 async requestRoute(raw){
  this.#open();const frame=this.captureSenseContext();
  const response=await this.#market.route(this.#owner,raw);
  // The receipt is a persistent service fact, but stale UI work cannot replace
  // a newer creature/context chosen while the pure executor was pending.
  this.#open();this.assertSenseContext(frame);
  return this.#change(v=>({...v,activeCreatureId:response.receipt.instanceId,routeView:{...response,visible:true}}));
 }
 routeVisibility(raw){const r=clean(raw,['receiptId','visible']);if(typeof r.visible!=='boolean')deny('invalid_route_visibility');return this.#change(v=>{if(!v.routeView||v.routeView.receipt.receiptId!==r.receiptId)deny('route_receipt_conflict');return {...v,routeView:{...v.routeView,visible:r.visible}};});}
 creature(id){this.#open();return this.#registry.get(this.#owner,id);}
 createCreature(raw){this.#open();this.#registry.create(this.#owner,raw);this.#handoff.invalidatePending(this.#owner);return this.state();}
 primaryCreature(raw){this.#open();this.#registry.setPrimary(this.#owner,raw);this.#handoff.invalidatePending(this.#owner);return this.state();}
 creatureSense(raw){this.#open();this.#registry.setSense(this.#owner,raw);this.#handoff.invalidatePending(this.#owner);return this.state();}
 selectCreature(raw){const r=clean(raw,['creatureId']);this.creature(r.creatureId);if(this.captureSenseContext().creatureId===r.creatureId)return this.state();return this.#change(v=>({...v,activeCreatureId:r.creatureId}));}
 perceive(raw){
  const s=clean(raw,['modality','signal']);
  if(!['hearing','vision'].includes(s.modality)||!['work-context','account-request','personal-context'].includes(s.signal))deny('invalid_synthetic_perception');
  return this.#change(v=>applySignal(v,s));
 }
 // Internal trusted-host bridge. Not exposed as unauthenticated mutation endpoints.
 senseNow(){const now=this.#clock();if(!Number.isSafeInteger(now)||now<0)deny('invalid_clock');return now;}
 captureSenseContext(){this.#open();const r=this.#store.get('scene-state');return {creatureId:r.value.activeCreatureId,sceneRevision:r.revision};}
 assertSenseContext(frame){const current=this.captureSenseContext();if(current.creatureId!==frame.creatureId||current.sceneRevision!==frame.sceneRevision)deny('sensory_context_changed');}
 retainedSensePerceptions(){
  this.#open();return (this.#store.get('sense-index')?.value.ids??[]).flatMap(id=>{const e=this.#store.get('sense-event.'+id)?.value;return e?.metadata?.perceptionId?[e.metadata.perceptionId]:[];});
 }
 recycleSense(){
  this.#store.transaction(tx=>{
   const index=tx.get('sense-index');if(!index)return null;let ids=[...index.value.ids];
   while(ids.length>=64){
    const i=ids.findIndex(id=>{const e=tx.get('sense-event.'+id).value;return ['failed','expired','applied','observation','retired','route_applied','route_unconfirmed','route_cancelled'].includes(e.status)||this.senseNow()>=e.expiresAt;});
    if(i<0)deny('sensory_event_capacity');
    const [id]=ids.splice(i,1),r=tx.get('sense-event.'+id);tx.put('sense-event.'+id,'sense-event',{...r.value,status:'retired'},r.revision);
   }
   if(ids.length!==index.value.ids.length)tx.put('sense-index','sense-index',{ids},index.revision);return null;
  });
 }
 beginSense(eventId,frame,modality,expiresAt){
  this.assertSenseContext(frame);
  this.#store.transaction(tx=>{
   const index=tx.get('sense-index');const ids=index?.value.ids??[];if(ids.length>=128)deny('sensory_event_capacity');
   tx.put('sense-event.'+eventId,'sense-event',{eventId,frame,modality,expiresAt,status:'processing',metadata:null},0);
   tx.put('sense-index','sense-index',{ids:[...ids,eventId]},index?.revision??0);return null;
  });
 }
 finishSense(eventId,metadata){
  return this.#store.transaction(tx=>{
   const r=tx.get('sense-event.'+eventId);if(!r||r.value.status!=='processing')deny('sensory_event_not_processing');
   const event=r.value,current=tx.get('scene-state');
   if(current.revision!==event.frame.sceneRevision||current.value.activeCreatureId!==event.frame.creatureId)deny('sensory_context_changed');
   if(this.senseNow()>=event.expiresAt)deny('sensory_event_expired');
   if(metadata.creatureProposal)this.assertCreatureProposalCurrent(metadata.creatureProposal);
   const value={...event,status:metadata.routeProposal?.status==='ready'?'awaiting_route_confirmation':metadata.candidate?'awaiting_confirmation':'observation',metadata};
   tx.put('sense-event.'+eventId,'sense-event',value,r.revision);return value;
  });
 }
 failSense(eventId,metadata=null){
  this.#store.transaction(tx=>{const r=tx.get('sense-event.'+eventId);if(r?.value.status==='processing')tx.put('sense-event.'+eventId,'sense-event',{...r.value,status:'failed',metadata},r.revision);return null;});
 }
 senseEvent(eventId){
  this.#open();return this.#store.transaction(tx=>{
   const r=tx.get('sense-event.'+eventId);if(!r)deny('sensory_event_not_found');
   if(['processing','awaiting_confirmation','awaiting_route_confirmation','route_dispatching','observation'].includes(r.value.status)&&this.senseNow()>=r.value.expiresAt){const value={...r.value,status:'expired'};tx.put('sense-event.'+eventId,'sense-event',value,r.revision);return value;}
   return r.value;
  });
 }
 makeCreatureProposal(text){
  const name=parseCreatureName(text);if(name===null)return null;
  const registry=this.#registry.state(this.#owner),matches=registry.creatures.filter(c=>c.name===name);
  return snapshot('spoken-creature-proposal',{schema:'spoken-creature.v1',status:matches.length===1?'ready':matches.length?'ambiguous':'unavailable',registryRevision:registry.revision,targetCreatureId:matches.length===1?matches[0].id:null,targetName:matches.length===1?matches[0].name:null}).value;
 }
 assertCreatureProposalCurrent(proposal){
  if(this.#registry.state(this.#owner).revision!==proposal.registryRevision)deny('creature_registry_changed');
 }
 makeSpokenRouteProposal(eventId,frame,parsed,expiresAt){
  this.#open();this.assertSenseContext(frame);
  const input=clean(parsed,['productId','from','to','parser']);
  if(input.productId!=='demo.maps.v1'||input.parser!=='finite-spoken-route.v1'||!['A','B','C'].includes(input.from)||!['A','B','C'].includes(input.to))deny('invalid_spoken_route');
  const event=this.senseEvent(eventId);
  if(event.modality!=='hearing'||event.status!=='processing'||digest('frame',frame)!==digest('frame',event.frame)||expiresAt!==event.expiresAt)deny('spoken_route_event_mismatch');
  const sub=this.#market.state(this.#owner).subscriptions.find(v=>v.productId===input.productId);
  const reason=!sub||sub.status!=='active'?'not_subscribed':!sub.routeGranted?'route_not_granted':null;
  return snapshot('spoken-route-proposal',{
   schema:'spoken-route-proposal.v1',proposalId:'sr-'+eventId,eventId,context:frame,requestId:'speech-'+eventId,
   productId:input.productId,providerId:'demo-maps',instanceId:sub?.instanceId??null,serviceId:'synthetic.route.v1',serviceVersion:1,
   from:input.from,to:input.to,source:input.parser,status:reason?'blocked':'ready',reason,
   subscriptionRevision:sub?.revision??null,subscriptionGeneration:sub?.generation??null,expiresAt,
  }).value;
 }
 #spokenEvent(eventId,expectedProposal){
  this.#open();const r=this.#store.get('sense-event.'+eventId),proposal=snapshot('spoken-route-expected',expectedProposal).value;
  if(!r||r.value.modality!=='hearing'||!r.value.metadata?.routeProposal||digest('spoken-route-binding',r.value.metadata.routeProposal)!==digest('spoken-route-binding',proposal))deny('spoken_route_proposal_mismatch');
  if(proposal.eventId!==eventId||proposal.requestId!=='speech-'+eventId||proposal.schema!=='spoken-route-proposal.v1')deny('spoken_route_proposal_mismatch');
  return {record:r,proposal};
 }
 #spokenSubscription(proposal){
  const sub=this.#market.state(this.#owner).subscriptions.find(v=>v.productId===proposal.productId);
  if(!sub||sub.status!=='active'||!sub.routeGranted||sub.instanceId!==proposal.instanceId||sub.revision!==proposal.subscriptionRevision||sub.generation!==proposal.subscriptionGeneration)deny('spoken_route_authority_changed');
 }
 #spokenGuard(guard){
  if(typeof guard!=='function'||types.isProxy(guard)||types.isAsyncFunction(guard))deny('invalid_spoken_route_guard');
  const result=guard();
  if(types.isPromise(result)){
   if(Object.getPrototypeOf(result)===Promise.prototype&&!Object.hasOwn(result,'constructor'))Promise.prototype.then.call(result,()=>{},()=>{});
   deny('invalid_spoken_route_guard');
  }
  if(result!==undefined&&result!==true)deny('invalid_spoken_route_guard');
 }
 querySpokenRoute(eventId){
  this.#open();const event=this.senseEvent(eventId),p=event.metadata?.routeProposal;
  if(event.modality!=='hearing'||!p)deny('spoken_route_proposal_mismatch');
  const status=this.#market.requestStatus(this.#owner,{requestId:p.requestId});
  // not_started is an observation, NOT permission to replay a dispatching event.
  return {eventId,requestId:p.requestId,eventStatus:event.status,requestStatus:status.status,receiptId:status.receipt?.receiptId??null,state:this.state()};
 }
 async confirmSpokenRoute(eventId,expectedProposal,guard){
  let {record,proposal}=this.#spokenEvent(eventId,expectedProposal);
  if(record.value.status==='route_applied'){this.#handoff.invalidatePending(this.#owner);return {...this.querySpokenRoute(eventId),replayed:true};}
  // Never retry dispatching/unconfirmed after a lost response or process restart.
  if(record.value.status!=='awaiting_route_confirmation'||proposal.status!=='ready')deny('spoken_route_not_ready');
  try{
   this.senseEvent(eventId);this.#spokenGuard(guard);this.#open();
   this.#store.transaction(tx=>{
    const r=tx.get('sense-event.'+eventId);
    if(r.value.status!=='awaiting_route_confirmation')deny('spoken_route_not_ready');
    this.assertSenseContext(proposal.context);this.#spokenSubscription(proposal);
    if(this.senseNow()>=proposal.expiresAt)deny('sensory_event_expired');
    tx.put('sense-event.'+eventId,'sense-event',{...r.value,status:'route_dispatching'},r.revision);return null;
   });
   const response=await this.#market.route(this.#owner,{productId:proposal.productId,instanceId:proposal.instanceId,from:proposal.from,to:proposal.to,requestId:proposal.requestId});
   this.#open();this.senseEvent(eventId);this.#spokenGuard(guard);this.#open();
   this.#store.transaction(tx=>{
    const r=tx.get('sense-event.'+eventId),scene=tx.get('scene-state');
    if(r.value.status!=='route_dispatching')deny('spoken_route_not_ready');
    this.assertSenseContext(proposal.context);this.#spokenSubscription(proposal);
    if(this.senseNow()>=proposal.expiresAt)deny('sensory_event_expired');
    if(response.receipt.instanceId!==proposal.instanceId||response.receipt.requestId!==proposal.requestId)deny('spoken_route_receipt_mismatch');
    this.#putScene(tx,{...withoutTextEntry(scene.value),activeCreatureId:proposal.instanceId,routeView:{...response,visible:true}},scene.revision);
    tx.put('sense-event.'+eventId,'sense-event',{...r.value,status:'route_applied',receiptId:response.receipt.receiptId},r.revision);return null;
   });
  }catch(error){
   // A service receipt may exist even when presentation was denied. Preserve it.
   if(!this.#closed)this.#store.transaction(tx=>{
    const r=tx.get('sense-event.'+eventId);
    if(r&&['awaiting_route_confirmation','route_dispatching','expired'].includes(r.value.status))tx.put('sense-event.'+eventId,'sense-event',{...r.value,status:'route_unconfirmed'},r.revision);
    return null;
   });
   throw error;
  }
  // The route receipt and presentation are already facts. A later handoff
  // revocation-sweep failure must not rewrite them as an unconfirmed route.
  this.#handoff.invalidatePending(this.#owner);
  return {...this.querySpokenRoute(eventId),replayed:false};
 }
 cancelSpokenRoute(eventId,expectedProposal){
  const {proposal}=this.#spokenEvent(eventId,expectedProposal);
  this.#market.cancelRequest(this.#owner,{requestId:proposal.requestId});
  this.#store.transaction(tx=>{
   const r=tx.get('sense-event.'+eventId);
   if(!['route_applied','route_cancelled'].includes(r.value.status))tx.put('sense-event.'+eventId,'sense-event',{...r.value,status:'route_cancelled'},r.revision);
   return null;
  });return this.querySpokenRoute(eventId);
 }
 applySense(eventId,expectedCandidate,frame,expectedCreatureProposal){
  this.senseEvent(eventId); // Persist observed expiration even if later checks deny.
  const result=this.#store.transaction(tx=>{
   const r=tx.get('sense-event.'+eventId),event=r.value;
   if(event.modality!=='hearing'||!event.metadata||event.metadata.candidate!==expectedCandidate)deny('sensory_candidate_unavailable');
   if(frame.creatureId!==event.frame.creatureId||frame.sceneRevision!==event.frame.sceneRevision)deny('sensory_context_changed');
   const creatureProposal=event.metadata.creatureProposal;
   if(expectedCandidate==='creature-request'){
    if(!creatureProposal||creatureProposal.status!=='ready'||expectedCreatureProposal===undefined||digest('spoken-creature',expectedCreatureProposal)!==digest('spoken-creature',creatureProposal))deny('creature_proposal_mismatch');
   }else if(expectedCreatureProposal!==undefined)deny('creature_proposal_mismatch');
   if(event.status==='applied')return {replayed:true};
   if(event.status!=='awaiting_confirmation')deny('sensory_candidate_unavailable');
   if(!['work-context','personal-context','account-request','text-entry-request','creature-request'].includes(expectedCandidate))deny('sensory_candidate_unavailable');
   const current=tx.get('scene-state');
   if(frame.creatureId!==event.frame.creatureId||frame.sceneRevision!==event.frame.sceneRevision||current.revision!==frame.sceneRevision||current.value.activeCreatureId!==frame.creatureId)deny('sensory_context_changed');
   if(expectedCandidate==='creature-request')this.assertCreatureProposalCurrent(creatureProposal);
   const value=expectedCandidate==='creature-request'?{...withoutTextEntry(current.value),activeCreatureId:creatureProposal.targetCreatureId}:applySignal(current.value,{modality:'hearing',signal:expectedCandidate,origin:'confirmed-local-perception',sourceEventId:eventId});
   this.#putScene(tx,value,current.revision);
   tx.put('sense-event.'+eventId,'sense-event',{...event,status:'applied'},r.revision);return {replayed:false};
  });this.#handoff.invalidatePending(this.#owner);return {...result,state:this.state()};
 }
 update(raw){
  const s=clean(raw,['activityId','expectedRevision','values']);fields(s.values,definitions.map(d=>d.id));
  for(const d of definitions)if(!d.options.includes(s.values[d.id]))deny('invalid_synthetic_field');
  return this.#change(v=>{
   const a=v.activity;if(!a||a.id!==s.activityId)deny('activity_conflict');if(v.activeCreatureId!=='work')deny('work_context_required');
   if(a.status!=='draft')deny('task_not_editable');if(a.revision!==s.expectedRevision)deny('revision_conflict');
   return {...v,activity:{...a,values:s.values,revision:a.revision+1}};
  });
 }
 visibility(visible,raw){const s=clean(raw,['activityId']);return this.#change(v=>{if(!v.activity||v.activity.id!==s.activityId)deny('activity_conflict');return {...v,activity:{...v.activity,sceneVisible:visible}};});}
 cancel(raw){
  const s=clean(raw,['activityId']);this.#open();const a=this.#store.get('scene-state').value.activity;if(!a||a.id!==s.activityId)deny('activity_conflict');
  const p=a.submission?this.#store.get('activity.'+a.submission.id):null;
  if(p?.value.permit==='consumed')deny('consumed_requires_reconciliation');
  if(p)this.#permits.cancel(this.#worker,a.submission.id+'-cancel',a.submission.id);
  return this.#change(v=>({...v,activity:{...v.activity,status:'cancelled',sceneVisible:false}}));
 }
 newTask(raw){
  const s=clean(raw,['previousActivityId']);
  return this.#change(v=>{
   if((v.activity?.id??null)!==s.previousActivityId)deny('activity_conflict');
   if(v.activity&&!['completed','expired','cancelled'].includes(v.activity.status))deny('active_task_exists');
   return {...v,activeCreatureId:'work',nextTask:v.nextTask+1,activity:{id:'task-'+v.nextTask,revision:1,status:'draft',sceneVisible:true,values:{},receipt:null,perception:{modality:'explicit',signal:'new-synthetic-task',synthetic:true},submission:null}};
  });
 }
 submit(raw){
  this.#open();const s=clean(raw,['activityId','expectedRevision']);let current=this.#store.get('scene-state').value,a=current.activity;
  if(!a||a.id!==s.activityId)deny('activity_conflict');if(current.activeCreatureId!=='work')deny('work_context_required');
  if(a.submission&&a.submission.revision!==s.expectedRevision&&!(a.status==='uncertain'&&a.revision===s.expectedRevision))deny('revision_conflict');
  if(!a.submission&&a.revision!==s.expectedRevision)deny('revision_conflict');
  if(['completed','expired','cancelled'].includes(a.status))return this.state();
  if(!a.submission){
   const payload=syntheticInput(canonical({scenario:'synthetic-form',synthetic:true,form:a.values}));
   const submission={id:a.id+'-r'+a.revision,revision:a.revision,payload,expiresAt:this.#clock()+86400000};
   this.#change(v=>({...v,activity:{...v.activity,status:'submitting',submission}}));a=this.#store.get('scene-state').value.activity;
  }
  const sub=a.submission,n=sub.id;
  const priorPermit=this.#store.get('activity.'+n);
  if(priorPermit?.value.permit==='consumed'){
   const result=this.#permits.reconcile(this.#worker,n);
   return this.#change(v=>({...v,activity:{...v.activity,status:result.observed?'completed':'uncertain',revision:sub.revision+1,receipt:{mode:'simulation-only',level:result.dispatch,activityId:n}}}));
  }
  if(this.#clock()>=sub.expiresAt){
   if(priorPermit)this.#permits.cancel(this.#worker,n+'-expire-cancel',n);
   return this.#change(v=>({...v,activity:{...v.activity,status:'expired',revision:sub.revision+1}}));
  }
  // Every stage has a fixed command identity. Crash recovery reuses immutable inputs.
  // This is a host-issued synthetic demo policy, not authority from audio content.
  this.#data.createSource(this.#admin,n+'-source',{sourceId:n,controller:'demo-work',content:canonical(sub.payload),purposes:['demo-account'],recipients:['demo-work','local-sink'],retentionUntil:sub.expiresAt});
  this.#grants.issueRoot(this.#admin,n+'-grant',{grantId:n,rootPrincipal:'demo-work',delegate:'demo-work',resources:[n],operations:['derive','disclose','read'],purposes:['demo-account'],recipients:['demo-work','local-sink'],budget:{calls:4,bytes:10000},expiresAt:sub.expiresAt,maxDepth:0});
  this.#data.createContext(this.#worker,n+'-context',{contextId:n,bindings:[{sourceId:n,grantId:n}],stateRefs:[],purpose:'demo-account'});
  this.#data.run(this.#worker,n+'-derive',{contextId:n,artifactId:n});
  this.#permits.allocate(this.#admin,n+'-allocate',{allocationId:n,controller:'demo-work',calls:1,expiresAt:sub.expiresAt});
  const prepared=this.#permits.prepareFromArtifact(this.#worker,n+'-prepare',{activityId:n,allocationId:n,artifactId:n,purpose:'demo-account'}).ack;
  const existing=this.#permits.inspect(this.#worker,n);
  if(existing.permit==='issued')this.#permits.dispatch(this.#worker,n+'-dispatch',{activityId:n,expectedRevision:prepared.revision,bindingDigest:prepared.bindingDigest});
  // A consumed uncertain activity never gets a fresh send, even on explicit retry.
  const result=this.#permits.reconcile(this.#worker,n);
  return this.#change(v=>({...v,activity:{...v.activity,status:result.observed?'completed':'uncertain',revision:sub.revision+1,receipt:{mode:'simulation-only',level:result.dispatch,activityId:n},sceneVisible:v.activity.sceneVisible}}));
 }
}
