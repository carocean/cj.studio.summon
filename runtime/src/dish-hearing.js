import {compileDishSemanticProposal} from './dish-semantics.js';
import {snapshot} from '../../microkernel/src/canonical.js';
import {fields,deny} from '../../microkernel/src/grants.js';
import {PerceptionSceneBridge} from './perception-bridge.js';
const owners=new WeakMap();
const same=(a,b)=>snapshot('dish-hearing-binding',a).bytes===snapshot('dish-hearing-binding',b).bytes;
export function dishHearingIntent(text){
 if(typeof text!=='string'||text.length>120)return null;
 const value=text.replace(/\s+/g,'').replace(/[。.!！?？]$/,'');
 return ['解释一下这道菜','介绍一下这道菜','这是什么菜','这道菜是什么'].includes(value)?'explain-current-dish':null;
}
// Trusted local host, dedicated bridge/narrator. Input is prerecorded WAV;
// pause occurs before ASR, not proof that acquisition happened after stopping.
export class DishHearingTurn {
 #scene;#bridge;#narrator;#sessionId;#busy=false;#closed=false;#epoch=0;#retired=false;#closePromise=null;#interpreter;#modelId;#abort=null;#pendingSemantic=null;
 constructor(scene,{bridge,narrator,sessionId,interpreter=null}){
  if(!(bridge instanceof PerceptionSceneBridge)||typeof narrator?.pauseForInput!=='function'||typeof narrator?.requestExplanation!=='function'||typeof narrator?.close!=='function'||owners.has(bridge))deny('invalid_dish_hearing_configuration');
  if(interpreter!==null&&(typeof interpreter.interpret!=='function'||typeof interpreter.modelId!=='string'||!interpreter.modelId.trim()))deny('invalid_dish_interpreter');
  this.#interpreter=interpreter;this.#modelId=interpreter?.modelId??null;
  this.#scene=scene;this.#bridge=bridge;this.#narrator=narrator;this.#sessionId=sessionId;scene.readDish({sessionId});owners.set(bridge,this);
 }
 #check(epoch,expected,creatureGeneration){
  if(this.#closed||epoch!==this.#epoch)deny('dish_hearing_cancelled');
  const current=this.#scene.readDish({sessionId:this.#sessionId});
  if(!same(current,expected))deny('dish_hearing_binding_changed');
  const creature=this.#scene.creature(current.context.creatureId);if(!creature.senses.hearing||creature.generation!==creatureGeneration)deny('creature_sensory_authority_changed');
  return current;
 }
 async ingestAndExplain(raw){
  if(this.#closed)deny('dish_hearing_closed');if(this.#busy||this.#pendingSemantic)deny('dish_hearing_busy');
  fields(raw,['expectedRevision','context','media'],['language']);
  fields(raw.media,['mimeType','base64']);
  const media={mimeType:raw.media.mimeType,base64:raw.media.base64},language=raw.language;
  const before=this.#scene.readDish({sessionId:this.#sessionId});
  if(before.revision!==raw.expectedRevision||!same(before.context,raw.context))deny('dish_hearing_binding_changed');
  const creatureGeneration=this.#scene.creature(before.context.creatureId).generation;
  this.#busy=true;const epoch=++this.#epoch;
  try{
   this.#check(epoch,before,creatureGeneration);
   const paused=await this.#narrator.pauseForInput({sessionId:this.#sessionId,expectedRevision:before.revision});
   this.#check(epoch,paused,creatureGeneration);if(paused.focus.speech?.phase!=='stopped')deny('dish_playback_not_stopped');
   const result=await this.#bridge.ingest({context:paused.context,modality:'hearing',media,...(language?{language}:{})});
   this.#check(epoch,paused,creatureGeneration);
   const observed=this.#bridge.consumeDishObservation({eventId:result.event.eventId,context:paused.context});
   this.#check(epoch,paused,creatureGeneration);
   let intent,understanding='finite-whole-utterance-rules',llmUsed=false;
   if(this.#interpreter){
    this.#abort=new AbortController();
    let proposal,modelTimer;
    const controller=this.#abort;
    try{
     const source=this.#scene.senseEvent(observed.eventId);
     modelTimer=setTimeout(()=>controller.abort(),Math.max(0,source.expiresAt-this.#scene.senseNow()));
     const result=await this.#interpreter.interpret({text:observed.text,currentDish:{id:paused.focus.dishId,name:paused.presentation.name}},{signal:this.#abort.signal});
     this.#check(epoch,paused,creatureGeneration);this.#bridge.assertDishObservationAuthority({eventId:observed.eventId,context:paused.context});
     fields(result,['proposal','modelId']);if(result.modelId!==this.#modelId||this.#interpreter.modelId!==this.#modelId)deny('dish_interpreter_changed');
     const {authorityGranted,semanticsVerified,...rawProposal}=result.proposal;
     if(authorityGranted!==false||semanticsVerified!==false)deny('dish_semantic_authority_denied');
     proposal=compileDishSemanticProposal(rawProposal);
    }catch(error){
     this.#check(epoch,paused,creatureGeneration);
     return {status:'unavailable',eventId:observed.eventId,understanding:'local-model-proposal',modelId:this.#modelId,modelAttempted:true,llmUsed:false,error:'dish_semantic_unavailable'};
    }finally{clearTimeout(modelTimer);}
    understanding='local-model-proposal';llmUsed=true;
    if(proposal.kind!=='explain')return {status:proposal.kind==='clarify'?'clarify':'unrecognized',eventId:observed.eventId,transcript:observed.text,proposal,understanding,modelId:this.#modelId,llmUsed};
    this.#pendingSemantic={eventId:observed.eventId,proposal,paused,creatureGeneration,epoch};
    return {status:'semantic-proposal',eventId:observed.eventId,proposal,understanding,modelId:this.#modelId,llmUsed,requiresConfirmation:true};
   }else intent=dishHearingIntent(observed.text);
   if(!intent)return {status:'unrecognized',eventId:observed.eventId,transcript:observed.text,understanding,llmUsed};
   const view=await this.#narrator.requestExplanation({sessionId:this.#sessionId,expectedRevision:paused.revision});
   if(this.#closed||epoch!==this.#epoch)deny('dish_hearing_cancelled');
   return {status:'presented',eventId:observed.eventId,transcript:observed.text,intent,understanding,llmUsed,...(this.#modelId?{modelId:this.#modelId,semanticsVerified:false}:{}),view};
  }finally{this.#abort=null;this.#busy=false;if(this.#retired&&owners.get(this.#bridge)===this)owners.delete(this.#bridge);}
 }
 get usesSemanticProposals(){return this.#interpreter!==null;}
 // Trusted host inspection only. Never serialize this proposal to an input channel.
 readPendingSemantic(){
  const p=this.#pendingSemantic;if(!p)deny('dish_semantic_proposal_unavailable');
  this.#check(p.epoch,p.paused,p.creatureGeneration);
  this.#bridge.assertDishObservationAuthority({eventId:p.eventId,context:p.paused.context});
  return snapshot('dish-semantic-host-pending',{eventId:p.eventId,proposal:p.proposal,dishName:p.paused.presentation.name,expiresAt:this.#scene.senseEvent(p.eventId).expiresAt}).value;
 }
 async confirmSemanticProposal(raw){
  const r=snapshot('dish-semantic-confirmation',raw).value;fields(r,['eventId','proposal','confirmation']);
  const p=this.#pendingSemantic;if(this.#busy||!p||r.eventId!==p.eventId||r.confirmation!=='show-current-dish-details'||!same(r.proposal,p.proposal))deny('dish_semantic_confirmation_required');
  this.#check(p.epoch,p.paused,p.creatureGeneration);this.#bridge.assertDishObservationAuthority({eventId:p.eventId,context:p.paused.context});
  this.#pendingSemantic=null;this.#busy=true;
  try{
   const view=await this.#narrator.requestExplanation({sessionId:this.#sessionId,expectedRevision:p.paused.revision});
   if(this.#closed||p.epoch!==this.#epoch)deny('dish_hearing_cancelled');
   return {status:'presented',eventId:p.eventId,understanding:'local-model-proposal',modelId:this.#modelId,llmUsed:true,semanticsVerified:false,confirmation:'explicit-host-confirmation',view};
  }finally{this.#busy=false;if(this.#retired&&owners.get(this.#bridge)===this)owners.delete(this.#bridge);}
 }
 discardSemanticProposal(raw){
  const r=snapshot('dish-semantic-discard',raw).value;fields(r,['eventId']);
  if(this.#closed||!this.#pendingSemantic||this.#pendingSemantic.eventId!==r.eventId)deny('dish_semantic_proposal_unavailable');
  this.#pendingSemantic=null;return {status:'discarded'};
 }
 close(){
  if(this.#retired)return Promise.resolve();if(this.#closePromise)return this.#closePromise;
  if(owners.get(this.#bridge)!==this)return Promise.reject(Object.assign(new Error('dish_hearing_owner_changed'),{code:'dish_hearing_owner_changed'}));
  this.#closed=true;this.#epoch++;this.#pendingSemantic=null;const controller=this.#abort;
  this.#closePromise=Promise.resolve().then(async()=>{
   if(owners.get(this.#bridge)!==this)deny('dish_hearing_owner_changed');
   controller?.abort();this.#bridge.cancelDishInput();await this.#narrator.close();this.#retired=true;
   if(!this.#busy&&owners.get(this.#bridge)===this)owners.delete(this.#bridge);
  }).finally(()=>{this.#closePromise=null;});return this.#closePromise;
 }
}
