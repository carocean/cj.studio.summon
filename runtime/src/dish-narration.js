import {HostIdentity} from '../../microkernel/src/identity.js';
import {snapshot} from '../../microkernel/src/canonical.js';
import {fields,deny} from '../../microkernel/src/grants.js';
import {validateVoiceWav} from './local-voice.js';
const playbackOwners=new WeakMap();
const spec=(raw,keys)=>{const v=snapshot('dish-narration-request',raw).value;fields(v,keys);return v;};
// Trusted same-device host orchestration, NOT a remote playback acknowledgement.
// The host installs the synthesizer and player. stop() must settle only after
// pending playback is quiescent; adapters remain responsible for real devices.
// No microphone, VAD, transport, natural-completion or full-duplex claim.
export class DishNarration {
 #sessions;#auth;#admin;#adminPrincipal;#synth;#player;#active=null;#closed=false;#timeout;
 constructor(sessions,auth,{administratorHandle,synthesizer,player,timeoutMs=30000}){
  if(!(auth instanceof HostIdentity)||typeof synthesizer?.synthesize!=='function'||typeof player?.play!=='function'||typeof player?.stop!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)deny('invalid_dish_narration_configuration');
  this.#sessions=sessions;this.#auth=auth;this.#admin=administratorHandle;this.#adminPrincipal=auth.resolve(administratorHandle);this.#synth=synthesizer;this.#player=player;this.#timeout=timeoutMs;
 }
 #administrator(handle){if(this.#auth.resolve(handle)!==this.#adminPrincipal)deny('dish_host_authority_required');}
 #open(){if(this.#closed)deny('dish_narration_closed');}
 #live(a,generation){return !this.#closed&&this.#active===a&&a.generation===generation;}
 #bound(a){
  if(this.#auth.resolve(a.handle)!==a.owner)deny('unauthenticated');this.#auth.resolve(this.#admin);
  const view=this.#sessions.read(a.handle,{sessionId:a.sessionId});
  if(view.focus.taskId!==a.taskId||view.focus.catalogDigest!==a.catalogDigest||view.focus.dishId!==a.dishId||view.focus.speech?.sequence!==a.sequence)deny('dish_narration_binding_changed');
  return view;
 }
 async #wait(promise){let timer;try{return await Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('dish_narration_timeout'),{code:'dish_narration_timeout'})),this.#timeout);})]);}finally{clearTimeout(timer);}}
 #stop(a){
  if(a.stopPromise)return a.stopPromise;
  a.stopPromise=Promise.resolve().then(()=>this.#drain(a)).finally(()=>{a.stopPromise=null;});return a.stopPromise;
 }
 async #drain(a){
  // Stop immediately. If a start was already in flight, wait for it to settle
  // and stop again before acknowledging quiescence. Never infer stop from an
  // emitted UI event or from synthesis cancellation alone.
  await this.#player.stop();
  if(a.playPromise){await a.playPromise.catch(()=>{});await this.#player.stop();}
 }
 async start(handle,raw){
  this.#open();if(this.#active||playbackOwners.has(this.#player))deny('dish_narration_busy');
  const owner=this.#auth.resolve(handle);this.#auth.resolve(this.#admin);
  const s=spec(raw,['sessionId','dishId','expectedRevision']);
  const before=this.#sessions.read(handle,{sessionId:s.sessionId});
  if(before.focus.revision!==s.expectedRevision)deny('stale_dish_focus');
  // Reserve four transitions: speak, interrupt, host-confirmed stop, details.
  if(before.focus.revision>252)deny('dish_narration_transition_capacity');
  const selected=this.#sessions.command(handle,{sessionId:s.sessionId,command:{kind:'speak',dishId:s.dishId,expectedRevision:s.expectedRevision}});
  const view=this.#sessions.read(handle,{sessionId:s.sessionId});
  const a={handle,owner,sessionId:s.sessionId,taskId:view.focus.taskId,catalogDigest:view.focus.catalogDigest,dishId:s.dishId,sequence:selected.focus.speech.sequence,generation:1,abort:new AbortController(),playPromise:null,stopPromise:null,phase:'synthesizing'};this.#active=a;playbackOwners.set(this.#player,this);
  const generation=a.generation;
  try{
   // Text is selected from the already-bound catalog, never a caller's script.
   const result=await this.#wait(this.#synth.synthesize({text:view.presentation.name,signal:a.abort.signal}));
   if(!this.#live(a,generation))return {status:'cancelled'};
   const current=this.#bound(a);if(current.focus.revision!==selected.focus.revision||current.focus.speech.phase!=='playback-requested')deny('dish_narration_state_changed');
   validateVoiceWav(result?.audio);a.phase='starting';
   a.playPromise=Promise.resolve().then(()=>{if(!this.#live(a,generation))return;this.#bound(a);return this.#player.play(Buffer.from(result.audio));});
   await this.#wait(a.playPromise);
   if(!this.#live(a,generation))return {status:'cancelled'};
   const after=this.#bound(a);if(after.focus.revision!==selected.focus.revision||after.focus.speech.phase!=='playback-requested')deny('dish_narration_state_changed');a.phase='playback-start-request-completed';
   return {status:a.phase,sessionId:a.sessionId,dishId:a.dishId,speechSequence:a.sequence,physicalPlaybackVerified:false};
  }catch(error){
   if(!this.#live(a,generation))return {status:'cancelled'};
   a.abort.abort();a.phase='blocked';
   try{await this.#wait(this.#stop(a));}catch{deny('dish_narration_stop_unconfirmed');}
   throw error;
  }
 }
 async pauseForInput(handle,raw){return this.#stopForInput(handle,raw,false);}
 async requestExplanation(handle,raw){return this.#stopForInput(handle,raw,true);}
 async #stopForInput(handle,raw,explain){
  this.#open();const s=spec(raw,['sessionId','expectedRevision']);
  const a=this.#active;if(!a||s.sessionId!==a.sessionId)deny('dish_narration_not_active');
  let actor;try{actor=this.#auth.resolve(handle);}catch(error){
   if(handle===a.handle){a.generation++;a.phase='blocked';a.abort.abort();await this.#wait(this.#stop(a));}throw error;
  }
  if(actor!==a.owner)deny('dish_narration_not_active');
  if(a.phase==='stopping')deny('dish_narration_busy');
  let current;try{current=this.#bound(a);}catch(error){a.generation++;a.phase='blocked';a.abort.abort();await this.#wait(this.#stop(a));throw error;}
  if(current.focus.revision!==s.expectedRevision)deny('stale_dish_focus');
  if(current.focus.speech.phase==='stopped'&&a.phase==='awaiting-input'){
   if(!explain)return current;
   this.#sessions.command(a.handle,{sessionId:a.sessionId,command:{kind:'details',expectedRevision:current.focus.revision}});
   const result=this.#sessions.read(a.handle,{sessionId:a.sessionId});this.#active=null;playbackOwners.delete(this.#player);return result;
  }
  if(!['playback-requested','stop-required'].includes(current.focus.speech.phase))deny('dish_narration_state_changed');
  const stopping=current.focus.speech.phase==='playback-requested'?this.#sessions.command(handle,{sessionId:s.sessionId,command:{kind:'interrupt',expectedRevision:s.expectedRevision,speechSequence:a.sequence}}):current;
  a.generation++;const generation=a.generation;a.phase='stopping';a.abort.abort();
  try{
   await this.#wait(this.#stop(a));
   if(!this.#live(a,generation))deny('dish_narration_cancelled');
   const checked=this.#bound(a);if(checked.focus.revision!==stopping.focus.revision||checked.focus.speech.phase!=='stop-required')deny('dish_narration_state_changed');
   const stopped=this.#sessions.confirmStopped(this.#admin,a.handle,{sessionId:a.sessionId,expectedRevision:checked.focus.revision,speechSequence:a.sequence});
   if(!explain){a.phase='awaiting-input';return this.#sessions.read(a.handle,{sessionId:a.sessionId});}
   this.#sessions.command(a.handle,{sessionId:a.sessionId,command:{kind:'details',expectedRevision:stopped.focus.revision}});
   const result=this.#sessions.read(a.handle,{sessionId:a.sessionId});this.#active=null;playbackOwners.delete(this.#player);return result;
  }catch(error){if(this.#active===a&&a.generation===generation)a.phase='blocked';throw error;}
 }
 async cancel(admin){
  this.#administrator(admin);const a=this.#active;if(!a)return;
  a.generation++;const generation=a.generation;a.phase='stopping';a.abort.abort();
  try{await this.#wait(this.#stop(a));if(this.#active===a&&a.generation===generation){this.#active=null;playbackOwners.delete(this.#player);}}catch(error){if(this.#active===a&&a.generation===generation)a.phase='blocked';throw error;}
 }
 async close(admin){this.#administrator(admin);this.#closed=true;await this.cancel(admin);}
}
