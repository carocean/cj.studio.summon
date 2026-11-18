import {randomBytes} from 'node:crypto';
import {snapshot,digest} from '../../microkernel/src/canonical.js';
import {fields,deny} from '../../microkernel/src/grants.js';
import {validateReadingResource,createReadingState,updateReadingPresentation,updateReadingAnchor} from './reading-surface.js';
const seal=(kind,value)=>snapshot(kind,value).value;
const id=v=>{if(typeof v!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v))deny('invalid_reading_view_id');};
const ownerId=v=>{if(typeof v!=='string'||!/^[A-Za-z][A-Za-z0-9.-]{0,99}$/.test(v))deny('invalid_principal');};
const tuple=(...v)=>JSON.stringify(v);
const capacity=(n,max)=>{if(!Number.isSafeInteger(n)||n<1||n>max)deny('invalid_reading_host');};

// Single trusted host instance; all state is volatile. No IO, grants, bookmarks or usage.
export class ReadingViews {
 #auth;#admin;#epoch;#retired=false;#limits;#fonts;#resources=new Map();#access=new Map();#owners=new Map();
 constructor(identities,raw={}){
  const o=seal('reading-view-host',raw);fields(o,[],['administrator','installedFontIds','maxResources','maxViewsPerOwner','maxCommandsPerOwner','maxAccessRecords']);
  this.#auth=identities;this.#admin=o.administrator??'host-admin';ownerId(this.#admin);
  this.#limits={resources:o.maxResources??16,views:o.maxViewsPerOwner??64,commands:o.maxCommandsPerOwner??256,access:o.maxAccessRecords??256};
  for(const [k,max] of [['resources',64],['views',256],['commands',1024],['access',1024]])capacity(this.#limits[k],max);
  this.#fonts=seal('reading-view-fonts',{installedFontIds:o.installedFontIds??[]});
  if(!Array.isArray(this.#fonts.installedFontIds)||this.#fonts.installedFontIds.length>16||new Set(this.#fonts.installedFontIds).size!==this.#fonts.installedFontIds.length)deny('invalid_reading_host');
  this.#fonts.installedFontIds.forEach(id);this.#epoch=randomBytes(24).toString('base64url');
 }
 get epoch(){return this.#epoch;}
 #adminActor(handle){const actor=this.#auth.resolve(handle);if(actor!==this.#admin)deny('not_authorized');return actor;}
 #check(handle,owner){if(this.#auth.resolve(handle)!==owner)deny('unauthenticated');}
 #alive(){if(this.#retired)deny('reading_host_retired');}
 retireHost(handle){
  this.#adminActor(handle);const alreadyRetired=this.#retired;
  this.#retired=true;this.#resources.clear();this.#access.clear();this.#owners.clear();
  return Object.freeze({fact:'reading_host_retired',epoch:this.#epoch,alreadyRetired});
 }
 #request(raw,keys){const r=seal('reading-view-request',raw);fields(r,['epoch',...keys]);if(r.epoch!==this.#epoch)deny('reading_instance_lost');return r;}
 #resource(ref){const r=this.#resources.get(tuple(ref.resourceId,ref.contentDigest));if(!r)deny('reading_resource_not_installed');return r;}
 #allowed(owner,ref){const a=this.#access.get(tuple(owner,ref.resourceId,ref.contentDigest));if(!a?.enabled)deny('reading_access_denied');return a;}
 #view(owner,viewId){id(viewId);const v=this.#owners.get(owner)?.views.get(viewId);if(!v)deny('reading_view_not_found');return v;}
 #active(owner,v){if(v.status!=='open')deny('reading_view_closed');const a=this.#allowed(owner,v);if(a.generation!==v.accessGeneration)deny('reading_access_changed');return this.#resource(v);}
 installResource(handle,raw){
  const actor=this.#adminActor(handle);this.#alive();const r=validateReadingResource(raw),key=tuple(r.resourceId,r.contentDigest),prior=this.#resources.get(key);
  if(prior){if(digest('reading-installed-resource',prior)!==digest('reading-installed-resource',r))deny('reading_resource_conflict');this.#check(handle,actor);return r;}
  if(this.#resources.size>=this.#limits.resources)deny('reading_resource_capacity');
  this.#check(handle,actor);this.#resources.set(key,r);return r;
 }
 setAccess(handle,raw){
  const actor=this.#adminActor(handle);this.#alive();const r=seal('reading-view-access',raw);fields(r,['ownerId','resourceId','contentDigest','enabled','expectedGeneration']);ownerId(r.ownerId);this.#resource(r);
  if(typeof r.enabled!=='boolean'||!Number.isSafeInteger(r.expectedGeneration)||r.expectedGeneration<0)deny('invalid_reading_access');
  const key=tuple(r.ownerId,r.resourceId,r.contentDigest),prior=this.#access.get(key),generation=prior?.generation??0;
  if(generation!==r.expectedGeneration)deny('reading_access_conflict');if(generation===Number.MAX_SAFE_INTEGER)deny('reading_access_exhausted');
  if(!prior&&this.#access.size>=this.#limits.access)deny('reading_access_capacity');
  const next=seal('reading-view-access-state',{enabled:r.enabled,generation:generation+1});this.#check(handle,actor);this.#access.set(key,next);return next;
 }
 #execute(handle,commandId,operation,raw,keys,prepare){
  const owner=this.#auth.resolve(handle);this.#alive();id(commandId);const r=this.#request(raw,keys),inputDigest=digest('reading-view-command',{operation,request:r});
  const domain=this.#owners.get(owner),prior=domain?.commands.get(commandId);
  if(prior){if(prior.inputDigest!==inputDigest)deny('reading_command_conflict');this.#check(handle,owner);return seal('reading-view-response',{replayed:true,ack:prior.ack});}
  if((domain?.commands.size??0)>=this.#limits.commands)deny('reading_command_capacity');
  const {view,ack}=prepare(owner,r,domain); // Pure preparation, no mutation before final checks.
  const receipt=seal('reading-view-receipt',{inputDigest,ack:{...ack,resourceId:view.resourceId,contentDigest:view.contentDigest,accessGeneration:view.accessGeneration}});
  this.#check(handle,owner);
  if(operation!=='close')this.#active(owner,view);
  const target=domain??{views:new Map(),commands:new Map()};
  target.views.set(r.viewId,view);target.commands.set(commandId,receipt);this.#owners.set(owner,target);
  return seal('reading-view-response',{replayed:false,ack:receipt.ack});
 }
 open(handle,commandId,raw){return this.#execute(handle,commandId,'open',raw,['viewId','resourceId','contentDigest','presentation'],(owner,r,domain)=>{
  id(r.viewId);if(domain?.views.has(r.viewId))deny('reading_view_exists');if((domain?.views.size??0)>=this.#limits.views)deny('reading_view_capacity');
  const resource=this.#resource(r),access=this.#allowed(owner,r),state=createReadingState(resource,r.presentation,this.#fonts);
  const view=Object.freeze({resourceId:resource.resourceId,contentDigest:resource.contentDigest,accessGeneration:access.generation,status:'open',state});
  return {view,ack:{fact:'reading_view_opened',epoch:this.#epoch,viewId:r.viewId,revision:state.revision}};
 });}
 updatePresentation(handle,commandId,raw){return this.#update(handle,commandId,'presentation',raw,'changes');}
 updateAnchor(handle,commandId,raw){return this.#update(handle,commandId,'anchor',raw,'anchor');}
 #update(handle,commandId,operation,raw,valueKey){return this.#execute(handle,commandId,operation,raw,['viewId','expectedRevision',valueKey],(owner,r)=>{
  const current=this.#view(owner,r.viewId),resource=this.#active(owner,current);
  const state=operation==='presentation'?updateReadingPresentation(resource,current.state,{expectedRevision:r.expectedRevision,changes:r.changes},this.#fonts):updateReadingAnchor(resource,current.state,{expectedRevision:r.expectedRevision,anchor:r.anchor});
  return {view:Object.freeze({...current,state}),ack:{fact:'reading_view_updated',epoch:this.#epoch,viewId:r.viewId,revision:state.revision}};
 });}
 close(handle,commandId,raw){return this.#execute(handle,commandId,'close',raw,['viewId','expectedRevision'],(owner,r)=>{
  const current=this.#view(owner,r.viewId); // Closing is allowed after resource revocation.
  if(current.status!=='open')deny('reading_view_closed');if(r.expectedRevision!==current.state.revision)deny('reading_revision_conflict');
  return {view:Object.freeze({...current,status:'closed'}),ack:{fact:'reading_view_closed',epoch:this.#epoch,viewId:r.viewId,revision:current.state.revision}};
 });}
 read(handle,raw){
  const owner=this.#auth.resolve(handle);this.#alive();const r=this.#request(raw,['viewId']),v=this.#view(owner,r.viewId),resource=this.#active(owner,v);
  const result=Object.freeze({epoch:this.#epoch,viewId:r.viewId,resource,state:v.state});this.#check(handle,owner);this.#active(owner,v);return result;
 }
 query(handle,raw){
  const owner=this.#auth.resolve(handle);this.#alive();const r=this.#request(raw,['commandId']);id(r.commandId);const receipt=this.#owners.get(owner)?.commands.get(r.commandId);
  const result=seal('reading-view-query',receipt?{status:'completed',epoch:this.#epoch,ack:receipt.ack}:{status:'not_started',epoch:this.#epoch});this.#check(handle,owner);return result;
 }
}
