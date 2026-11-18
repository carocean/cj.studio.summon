import {parseSpokenRoute} from './spoken-route.js';
import {types} from 'node:util';
import {validateVoiceWav} from './local-voice.js';
import {LocalCreatureResponder,boundedCreatureReply} from './creature-response.js';
import {randomUUID} from 'node:crypto';
import {snapshot,digest} from '../../microkernel/src/canonical.js';
import {deny,fields} from '../../microkernel/src/grants.js';

import {hearingSceneCandidate} from './scene-intent.js';
export {hearingSceneCandidate} from './scene-intent.js';

// Trusted in-process adapter. Never accepts a client-posted "trusted receipt".
// Legacy sensor authorization remains authoritative; core scene state is separate.
export class PerceptionSceneBridge {
 #scene;#kernel;#service;#owner;#subjects;#ttl;#active=false;#responder;#replyTimeout;#replyAbort=null;#closed=false;#voice;#voiceAbort=null;#voiceBusy=false;#replies=new Map();#resolver;#planner;#hearing=null;#hearingTimer=null;#plannerBusy=false;
 constructor(scene,{kernel,service,ownerId,subjects,ttlMs=30000,exclusiveOwner=false,responder=new LocalCreatureResponder(),replyTimeoutMs=5000,voice=null,resolveSubject=null,interactionPlanner=null}){
  if(!Number.isSafeInteger(replyTimeoutMs)||replyTimeoutMs<1||replyTimeoutMs>30000)deny('invalid_response_timeout');
  if(exclusiveOwner!==true)deny('exclusive_sensory_owner_required');
  if(service.kernel!==kernel||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>60000)deny('invalid_sensory_bridge');
  if(!subjects||typeof subjects!=='object'||types.isProxy(subjects)||![Object.prototype,null].includes(Object.getPrototypeOf(subjects))||Object.getOwnPropertySymbols(subjects).length)deny('invalid_sensory_bridge');
  const entries=snapshot('sensory-subject-map',Object.entries(Object.getOwnPropertyDescriptors(subjects)).map(([creatureId,d])=>{if(!d.enumerable||!Object.hasOwn(d,'value'))deny('invalid_sensory_bridge');return {creatureId,subjectId:d.value};})).value;
  const mapping=Object.fromEntries(entries.map(e=>[e.creatureId,e.subjectId]));if(!resolveSubject)fields(mapping,['companion','work']);
  for(const id of Object.values(mapping))kernel.getSubject(ownerId,id);
  if(new Set(Object.values(mapping)).size!==Object.values(mapping).length)deny('sensory_subject_alias');
  if(interactionPlanner!==null&&(typeof interactionPlanner.generate!=='function'||typeof interactionPlanner.modelId!=='string'||!interactionPlanner.modelId.trim()||[...interactionPlanner.modelId].length>120||/[\u0000-\u001f\u007f]/u.test(interactionPlanner.modelId)))deny('invalid_interaction_planner');
  this.#planner=interactionPlanner;
  this.#scene=scene;this.#kernel=kernel;this.#service=service;this.#owner=ownerId;this.#subjects=mapping;this.#ttl=ttlMs;this.#responder=responder;this.#replyTimeout=replyTimeoutMs;this.#voice=voice;this.#resolver=resolveSubject;
 }
 close(){this.#closed=true;this.#dropHearing();this.#replyAbort?.abort();this.#voiceAbort?.abort();this.#replies.clear();}
 #recycle(){
  this.#scene.recycleSense();
  // This bridge owns a dedicated legacy owner namespace. Core retirement commits
  // first; an interrupted cleanup is retried from the retained-ID set on reopen.
  const retained=new Set(this.#scene.retainedSensePerceptions());
  const old=this.#kernel.listPerceptions(this.#owner).filter(p=>p.status!=='processing'&&!retained.has(p.id));
  if(old.length)this.#kernel.retirePerceptionMetadata(this.#owner,old.map(p=>p.id));
 }
 #subject(id){return this.#resolver?this.#resolver(id):this.#subjects[id];}
 #authority(frame,modality,generation){const c=this.#scene.creature(frame.creatureId);if(!c.senses[modality]||(generation!==undefined&&c.generation!==generation))deny('creature_sensory_authority_changed');return c.generation;}
 currentContext(){return this.#scene.captureSenseContext();}
 async capabilities(){
  const context=this.currentContext(),subject=this.#kernel.getSubject(this.#owner,this.#subject(context.creatureId));
  const capabilities=await this.#service.capabilities();this.#scene.assertSenseContext(context);
  const current=this.#kernel.getSubject(this.#owner,subject.id);
  for(const modality of ['hearing','vision'])if(!this.#scene.creature(context.creatureId).senses[modality]||current.status!=='active'||!current.aibm.serviceAbilities.includes('sense.'+modality))capabilities[modality]={...capabilities[modality],available:false,reason:'outside_sensory_boundary'};
  return {context,capabilities};
 }
 async ingest(raw){
  if(this.#closed)deny('sensory_bridge_closed');
  this.#dropHearing();
  if(this.#active)deny('sensory_bridge_busy');
  fields(raw,['context','modality','media'],['language']);
  const frame=snapshot('sensory-context',raw.context).value;fields(frame,['creatureId','sceneRevision']);
  if(typeof frame.creatureId!=='string'||!Number.isSafeInteger(frame.sceneRevision)||frame.sceneRevision<1)deny('invalid_sensory_context');
  this.#scene.assertSenseContext(frame);
  if(!['hearing','vision'].includes(raw.modality))deny('invalid_modality');
  const creatureGeneration=this.#authority(frame,raw.modality);
  const legacySubject=this.#subject(frame.creatureId);if(!legacySubject)deny('sensory_subject_unmapped');
  const media=raw.media;
  if(!media||typeof media.base64!=='string'||!media.base64||media.base64.length>5592408)deny('invalid_media_size');
  if(!(raw.modality==='hearing'?['audio/wav']:['image/png','image/jpeg']).includes(media.mimeType))deny('unsupported_media_type');
  const bytes=Buffer.from(media.base64,'base64'),valid=bytes.length>0&&bytes.length<=4194304&&bytes.toString('base64')===media.base64;bytes.fill(0);
  if(!valid)deny('invalid_media_encoding');
  if(raw.language!==undefined&&!['zh','en'].includes(raw.language))deny('invalid_perception_language');
  this.#recycle();
  const before=new Set(this.#kernel.listPerceptions(this.#owner).map(p=>p.id));
  const eventId='p-'+randomUUID(),expiresAt=this.#scene.senseNow()+this.#ttl;
  this.#scene.beginSense(eventId,frame,raw.modality,expiresAt);this.#active=true;
  try{
   const result=await this.#service.ingest(this.#owner,{creatureId:legacySubject,modality:raw.modality,media:raw.media,...(raw.language?{language:raw.language}:{}),responseMode:'perception'});
   // No await between final authority/context check and core event commit.
   this.#kernel.assertCompletedPerceptionAuthority(this.#owner,result.id);
   if(result.creatureId!==legacySubject||result.modality!==raw.modality||result.status!=='completed')deny('sensory_receipt_mismatch');
   this.#scene.assertSenseContext(frame);this.#authority(frame,raw.modality,creatureGeneration);
   const creatureProposal=raw.modality==='hearing'?this.#scene.makeCreatureProposal(result.result.text):null;
   const candidate=creatureProposal?.status==='ready'?'creature-request':raw.modality==='hearing'?hearingSceneCandidate(result.result.text):null;
   if(this.#closed)deny('sensory_bridge_closed');
   this.#replyAbort=new AbortController();
   const parsedRoute=raw.modality==='hearing'?parseSpokenRoute(result.result.text):null;
   const routeProposal=parsedRoute?this.#scene.makeSpokenRouteProposal(eventId,frame,parsedRoute,expiresAt):null;
   const companionReply=await boundedCreatureReply(this.#responder,{creatureId:frame.creatureId,tone:this.#scene.creature(frame.creatureId).tone,sceneRevision:frame.sceneRevision,eventId,modality:raw.modality,hasRecognizedText:!!result.result.text.trim(),suggestedScene:candidate,creatureStatus:creatureProposal?.status??null,creatureName:creatureProposal?.targetName??null,routeStatus:routeProposal?.status??null,routeFrom:routeProposal?.from??null,routeTo:routeProposal?.to??null},{timeoutMs:this.#replyTimeout,signal:this.#replyAbort.signal});
   if(this.#closed)deny('sensory_bridge_closed');
   // Response preparation is asynchronous. Recheck authorization and scene again
   // before exposing even a reply; a model/adapter is never an authority issuer.
   this.#kernel.assertCompletedPerceptionAuthority(this.#owner,result.id);
   this.#scene.assertSenseContext(frame);
   this.#authority(frame,raw.modality,creatureGeneration);
   const event=this.#scene.finishSense(eventId,{...(creatureProposal?{creatureProposal}:{}),routeProposal,creatureGeneration,perceptionId:result.id,legacySubject,engine:result.result.engine.slice(0,200),model:result.result.model.slice(0,200),realProcessing:result.result.realProcessing,textLength:result.result.text.length,candidate});
   if(this.#voice){
    for(const [id,cached] of this.#replies)if(this.#scene.senseNow()>=cached.expiresAt)this.#replies.delete(id);
    while(this.#replies.size>=16)this.#replies.delete(this.#replies.keys().next().value);
    this.#replies.set(eventId,{text:companionReply.text,expiresAt});
   }
   if(this.#planner&&event.modality==='hearing'&&event.status==='observation'&&result.result.realProcessing===true&&!candidate&&!routeProposal&&!creatureProposal&&result.result.text.trim()&&Buffer.byteLength(result.result.text)<=16384){
    this.#hearing={eventId,text:result.result.text,state:'ready',abort:null};
    this.#hearingTimer=setTimeout(()=>this.#dropHearing(),Math.max(0,expiresAt-this.#scene.senseNow()));this.#hearingTimer.unref?.();
   }
   return {event,result:result.result,companionReply,voiceAvailable:!!this.#voice,policy:'observation-or-explicitly-confirmed-scene-proposal',llmUsed:false};
  }catch(error){const failed=this.#kernel.listPerceptions(this.#owner).find(p=>!before.has(p.id)&&p.creatureId===legacySubject);this.#scene.failSense(eventId,failed?{perceptionId:failed.id,legacySubject,candidate:null}:null);throw error;}finally{this.#active=false;this.#replyAbort=null;}
 }
 #dropHearing(){
  clearTimeout(this.#hearingTimer);this.#hearingTimer=null;
  if(this.#hearing){this.#hearing.text=null;this.#hearing.abort?.abort();this.#hearing=null;}
 }
 async generateInteraction(raw,{signal}={}){
  if(this.#closed)deny('sensory_bridge_closed');
  const r=snapshot('hearing-interaction-request',raw).value;fields(r,['eventId','context']);fields(r.context,['creatureId','sceneRevision']);
  if(typeof r.eventId!=='string'||!/^p-[a-f0-9-]{36}$/.test(r.eventId))deny('invalid_interaction_event');
  const event=this.#scene.senseEvent(r.eventId);
  if(snapshot('frame',r.context).bytes!==snapshot('frame',event.frame).bytes)deny('sensory_context_changed');
  const suffix=digest('hearing-interaction-id',r.eventId).slice(7,55),commandId='hearing-create-'+suffix,sessionId='hearing-'+suffix;
  const previous=this.#scene.queryInteraction({commandId});
  const response=(kind,creation,proposal=null,replayed=false,modelId=null)=>({schema:'hearing-interaction-generation.v1',eventId:r.eventId,context:r.context,kind,creation,...(proposal?{proposal}:{}),replayed,modelId,sourceTrust:'host-supplied-metadata',plannerInvoked:!replayed,speech:null,voiceAvailable:false});
  // Query committed facts only, never create/read/reopen a historical draft.
  if(previous.status==='completed')return response('form',previous,null,true);
  if(!this.#planner)deny('interaction_planner_unavailable');
  const cached=this.#hearing;
  const validate=()=>{
   if(this.#closed)deny('sensory_bridge_closed');
   if(!cached||this.#hearing!==cached||cached.eventId!==r.eventId||cached.abort?.signal.aborted||signal?.aborted)deny('interaction_source_unavailable');
   const e=this.#scene.senseEvent(r.eventId);
   if(e.status!=='observation'||e.modality!=='hearing'||e.metadata?.realProcessing!==true||e.metadata?.candidate||e.metadata?.routeProposal||e.metadata?.creatureProposal)deny('interaction_source_unavailable');
   this.#scene.assertSenseContext(r.context);this.#routeSource(r.eventId);
   return e;
  };
  const current=validate();
  if(cached.state!=='ready')deny('interaction_generation_already_attempted');
  if(this.#plannerBusy)deny('interaction_planner_busy');
  cached.state='running';cached.abort=new AbortController();this.#replies.delete(r.eventId);
  const abort=()=>cached.abort.abort();signal?.addEventListener('abort',abort,{once:true});
  const modelId=this.#planner.modelId;
  let rejectAbort;
  const cancelled=new Promise((_,reject)=>{rejectAbort=()=>{const e=new Error('interaction_generation_cancelled');e.code='interaction_generation_cancelled';reject(e);};cached.abort.signal.addEventListener('abort',rejectAbort,{once:true});});
  // Both this timer and the retention timer bound waiting. Abort is local only;
  // keep the single-flight lock until even an uncooperative adapter settles.
  const timer=setTimeout(abort,Math.max(0,current.expiresAt-this.#scene.senseNow()));
  this.#plannerBusy=true;
  try{
   const pending=Promise.resolve().then(()=>{validate();return this.#planner.generate({text:cached.text},{signal:cached.abort.signal});}).finally(()=>{this.#plannerBusy=false;});
   const output=snapshot('hearing-planner-result',await Promise.race([pending,cancelled])).value;
   validate();fields(output,['proposal','modelId']);
   if(output.modelId!==modelId)deny('interaction_planner_identity_changed');
   const p=output.proposal;
   if(!p||p.authorityGranted!==false||p.semanticsVerified!==false)deny('invalid_interaction_proposal');
   let creation=null;
   if(p.kind==='form'){
    fields(p,['kind','program','authorityGranted','semanticsVerified']);
    // SceneLab revalidates the compiled program and creates null values only.
    this.#scene.createInteraction({commandId,sessionId,context:r.context,program:p.program,source:{kind:'model-proposal',referenceId:r.eventId,modelId}});
    creation=this.#scene.queryInteraction({commandId});
   }else{
    const key=p.kind==='clarify'?'question':p.kind==='none'?'reason':null;
    if(!key)deny('invalid_interaction_proposal');fields(p,['kind',key,'authorityGranted','semanticsVerified']);
    if(typeof p[key]!=='string'||!p[key].trim()||[...p[key]].length>240||/[\u0000-\u001f\u007f]/u.test(p[key]))deny('invalid_interaction_proposal');
   }
   cached.state=p.kind;return response(p.kind,creation,p,false,modelId);
  }finally{
   if(cached.state==='running')cached.state='failed';cached.text=null;
   clearTimeout(timer);signal?.removeEventListener('abort',abort);cached.abort.signal.removeEventListener('abort',rejectAbort);
  }
 }
 async speak(raw){
  if(this.#closed)deny('sensory_bridge_closed');
  if(!this.#voice)deny('local_voice_unavailable');
  if(this.#voiceBusy)deny('local_voice_busy');
  const request=snapshot('creature-voice-request',raw).value;fields(request,['eventId','context']);
  if(typeof request.eventId!=='string')deny('invalid_voice_event');
  const validate=()=>{
   if(this.#closed)deny('sensory_bridge_closed');
   const event=this.#scene.senseEvent(request.eventId),cached=this.#replies.get(request.eventId);
   if(!cached||!['observation','awaiting_confirmation','awaiting_route_confirmation'].includes(event.status))deny('voice_event_unavailable');
   fields(request.context,['creatureId','sceneRevision']);
   if(event.frame.creatureId!==request.context.creatureId||event.frame.sceneRevision!==request.context.sceneRevision)deny('sensory_context_changed');
   this.#scene.assertSenseContext(request.context);
   if(event.metadata?.creatureProposal)this.#scene.assertCreatureProposalCurrent(event.metadata.creatureProposal);
   if(event.metadata?.legacySubject!==this.#subject(event.frame.creatureId))deny('sensory_subject_unmapped');
   if(!Number.isSafeInteger(event.metadata.creatureGeneration))deny('creature_sensory_authority_changed');
   this.#authority(event.frame,event.modality,event.metadata.creatureGeneration);
   this.#kernel.assertCompletedPerceptionAuthority(this.#owner,event.metadata.perceptionId);
   return cached;
  };
  const cached=validate();this.#voiceBusy=true;this.#voiceAbort=new AbortController();
  try{
   const voice=await this.#voice.synthesize({text:cached.text,signal:this.#voiceAbort.signal});
   validate();
   if(!Buffer.isBuffer(voice.audio)||voice.audio.length>2097152||voice.mimeType!=='audio/wav'||voice.realProcessing!==true||voice.engine!=='sherpa-onnx'||typeof voice.model!=='string'||voice.model.length>200)deny('invalid_voice_result');
   validateVoiceWav(voice.audio);
   return {schema:'creature-voice.v1',eventId:request.eventId,context:request.context,mimeType:'audio/wav',base64:voice.audio.toString('base64'),engine:voice.engine,model:voice.model,realProcessing:true};
  }finally{this.#voiceBusy=false;this.#voiceAbort=null;}
 }
 voiceAvailable(){return !this.#closed&&!!this.#voice;}
 async speakRoute(raw){
  if(!this.voiceAvailable())deny('local_voice_unavailable');if(this.#voiceBusy)deny('local_voice_busy');
  const r=snapshot('route-voice-request',raw).value;fields(r,['receiptId','context']);fields(r.context,['creatureId','sceneRevision']);
  const validate=()=>{
   if(this.#closed)deny('sensory_bridge_closed');this.#scene.assertSenseContext(r.context);
   const route=this.#scene.state().route,receipt=route?.receipt;
   if(!receipt||receipt.receiptId!==r.receiptId||receipt.instanceId!==r.context.creatureId||receipt.providerId!=='demo-maps'||receipt.productId!=='demo.maps.v1'||receipt.source!=='deterministic-synthetic-route'||!Array.isArray(receipt.result.path)||!receipt.result.path.length||receipt.result.path.some(n=>!['A','B','C'].includes(n)))deny('route_voice_receipt_mismatch');
   return receipt;
  };
  const receipt=validate();this.#voiceBusy=true;this.#voiceAbort=new AbortController();
  try{
   const text=`这张演示地图回执记录的合成路线是 ${receipt.result.path.join(' 到 ')}。这是模拟路线，不是真实导航。`;
   const voice=await this.#voice.synthesize({text,signal:this.#voiceAbort.signal});validate();
   if(!Buffer.isBuffer(voice.audio)||voice.audio.length>2097152||voice.mimeType!=='audio/wav'||voice.realProcessing!==true||voice.engine!=='sherpa-onnx'||typeof voice.model!=='string'||voice.model.length>200)deny('invalid_voice_result');validateVoiceWav(voice.audio);
   return {schema:'route-voice.v1',receiptId:r.receiptId,context:r.context,mimeType:'audio/wav',base64:voice.audio.toString('base64'),engine:voice.engine,model:voice.model,realProcessing:true};
  }finally{this.#voiceBusy=false;this.#voiceAbort=null;}
 }
 #routeRequest(raw,confirm=false){
  if(this.#closed)deny('sensory_bridge_closed');
  const r=snapshot('spoken-route-request',raw).value;
  fields(r,confirm?['eventId','context','expectedProposal','confirmation']:['eventId','expectedProposal']);
  if(typeof r.eventId!=='string')deny('invalid_route_event');
  const event=this.#scene.senseEvent(r.eventId),p=event.metadata?.routeProposal;
  if(!p||event.modality!=='hearing'||snapshot('spoken-expect',p).bytes!==snapshot('spoken-expect',r.expectedProposal).bytes)deny('spoken_route_proposal_mismatch');
  if(confirm&&(r.confirmation!=='request-synthetic-route'||snapshot('frame',r.context).bytes!==snapshot('frame',event.frame).bytes))deny('scene_confirmation_required');
  return {request:r,event};
 }
 #routeSource(eventId){
  if(this.#closed)deny('sensory_bridge_closed');
  const event=this.#scene.senseEvent(eventId);
  if(!event.metadata||event.metadata.legacySubject!==this.#subject(event.frame.creatureId))deny('sensory_subject_unmapped');
  if(!Number.isSafeInteger(event.metadata.creatureGeneration))deny('creature_sensory_authority_changed');
  this.#authority(event.frame,'hearing',event.metadata.creatureGeneration);
  this.#kernel.assertCompletedPerceptionAuthority(this.#owner,event.metadata.perceptionId);
 }
 async confirmRoute(raw){
  const {request:r}=this.#routeRequest(raw,true);this.#routeSource(r.eventId);
  return this.#scene.confirmSpokenRoute(r.eventId,r.expectedProposal,()=>{this.#routeSource(r.eventId);return true;});
 }
 queryRoute(raw){const {request:r}=this.#routeRequest(raw);return this.#scene.querySpokenRoute(r.eventId);}
 cancelRoute(raw){const {request:r}=this.#routeRequest(raw);return this.#scene.cancelSpokenRoute(r.eventId,r.expectedProposal);}
 confirm(eventId,raw){
  if(this.#closed)deny('sensory_bridge_closed');
  const request=snapshot('scene-confirmation',raw).value;fields(request,['context','expectedCandidate','confirmation'],['expectedCreatureProposal']);
  fields(request.context,['creatureId','sceneRevision']);
  if(typeof request.context.creatureId!=='string'||!Number.isSafeInteger(request.context.sceneRevision)||request.context.sceneRevision<1)deny('invalid_sensory_context');
  if(request.confirmation!=='apply-scene-proposal')deny('scene_confirmation_required');
  const event=this.#scene.senseEvent(eventId);
  if(!event.metadata||event.metadata.legacySubject!==this.#subject(event.frame.creatureId))deny('sensory_subject_unmapped');
  if(!Number.isSafeInteger(event.metadata.creatureGeneration))deny('creature_sensory_authority_changed');
  this.#authority(event.frame,event.modality,event.metadata.creatureGeneration);
  this.#kernel.assertCompletedPerceptionAuthority(this.#owner,event.metadata.perceptionId);
  // Recognized text is not identity or authorization. The trusted host calls this
  // only for a separate explicit user confirmation of the named candidate.
  return this.#scene.applySense(eventId,request.expectedCandidate,request.context,request.expectedCreatureProposal);
 }
}
