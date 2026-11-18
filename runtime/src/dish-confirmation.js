import {randomBytes} from 'node:crypto';
import {DishHearingTurn} from './dish-hearing.js';
import {snapshot} from '../../microkernel/src/canonical.js';
import {fields,deny} from '../../microkernel/src/grants.js';
const owned=new WeakSet();
const same=(a,b)=>snapshot('dish-confirmation-binding',a).bytes===snapshot('dish-confirmation-binding',b).bytes;
const feedback=state=>Object.freeze({schema:'dish-confirmation.v1',state,interactionId:null,expiresAt:null,dishName:null});
// Trusted host adapter, NOT an HTTP endpoint or proof of real user presence.
// Only its separately-held user channel can respond. Never give it to model,
// web/agent resource processors or sensor callbacks. Serialized IDs alone grant
// no access. A future transport must authenticate user + bind origin/CSRF.
export class DishConfirmationHost {
 #turn;#pending=null;#state=feedback('unrecognized');#busy=false;#closed=false;#epoch=0;#channel;#closePromise;
 constructor(turn){
  if(!(turn instanceof DishHearingTurn)||!turn.usesSemanticProposals||owned.has(turn))deny('invalid_dish_confirmation_host');
  owned.add(turn);this.#turn=turn;
  this.#channel=Object.freeze({read:()=>this.#read(),respond:raw=>this.#respond(raw),invalidate:()=>this.close()});
 }
 // Host bootstrap only; do not expose this accessor to external content tools.
 userChannel(){return this.#channel;}
 #discard(){const p=this.#pending;this.#pending=null;if(p)try{this.#turn.discardSemanticProposal({eventId:p.binding.eventId});}catch{/* already retired/consumed */}}
 #read(){
  if(this.#closed)return feedback('expired');
  if(this.#pending){try{if(!same(this.#turn.readPendingSemantic(),this.#pending.binding))throw Error('changed');}catch{this.#discard();this.#state=feedback('expired');}}
  return this.#state;
 }
 async ingest(raw){
  if(this.#closed)deny('dish_confirmation_closed');if(this.#busy)deny('dish_confirmation_busy');
  this.#read();if(this.#pending)deny('dish_confirmation_busy');
  this.#busy=true;const epoch=++this.#epoch;let observedEvent;
  try{
   const result=await this.#turn.ingestAndExplain(raw);
   if(this.#closed||epoch!==this.#epoch)return feedback('expired');
   if(result.status!=='semantic-proposal')return this.#state=feedback(result.status==='unavailable'?'unavailable':'unrecognized');
   observedEvent=result.eventId;const binding=this.#turn.readPendingSemantic();
   if(binding.eventId!==result.eventId||!same(binding.proposal,result.proposal))deny('dish_confirmation_binding_changed');
   if(typeof binding.dishName!=='string'||!binding.dishName.trim()||[...binding.dishName].length>120||/[\u0000-\u001f\u007f]/u.test(binding.dishName))deny('dish_confirmation_invalid_name');
   const id=randomBytes(16).toString('hex');this.#pending={id,binding};
   return this.#state=Object.freeze({schema:'dish-confirmation.v1',state:'pending',interactionId:id,expiresAt:binding.expiresAt,dishName:binding.dishName});
  }catch{
   if(this.#closed||epoch!==this.#epoch)return feedback('expired');
   // If inspection failed before pending was installed, discard by trusted event.
   if(observedEvent)try{this.#turn.discardSemanticProposal({eventId:observedEvent});}catch{}
   this.#discard();return this.#state=feedback('unavailable');
  }finally{this.#busy=false;}
 }
 async #respond(raw){
  const r=snapshot('dish-confirmation-response',raw).value;fields(r,['interactionId','choice']);
  if(typeof r.interactionId!=='string'||!/^[a-f0-9]{32}$/.test(r.interactionId)||!['show','dismiss'].includes(r.choice))deny('dish_confirmation_invalid_choice');
  if(this.#busy)deny('dish_confirmation_busy');
  this.#read();const p=this.#pending;
  if(!p||p.id!==r.interactionId)return feedback('expired');
  // Consume the UI token synchronously before awaiting side effects.
  this.#pending=null;this.#busy=true;const epoch=this.#epoch;
  try{
   if(r.choice==='dismiss'){this.#turn.discardSemanticProposal({eventId:p.binding.eventId});return this.#state=feedback('cancelled');}
   await this.#turn.confirmSemanticProposal({eventId:p.binding.eventId,proposal:p.binding.proposal,confirmation:'show-current-dish-details'});
   if(this.#closed||epoch!==this.#epoch)return feedback('expired');
   return this.#state=feedback('presented');
  }catch{try{this.#turn.discardSemanticProposal({eventId:p.binding.eventId});}catch{}return this.#state=feedback(this.#closed?'expired':'unavailable');}
  finally{this.#busy=false;}
 }
 close(){
  if(this.#closePromise)return this.#closePromise;
  this.#closed=true;this.#epoch++;this.#discard();this.#state=feedback('expired');
  this.#closePromise=Promise.resolve().then(()=>this.#turn.close()).catch(error=>{this.#closePromise=undefined;throw error;});return this.#closePromise;
 }
}
