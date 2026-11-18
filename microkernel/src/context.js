import { snapshot, digest } from './canonical.js';
import { deny, id, ids, fields } from './grants.js';
const key = (type,name) => type+'.'+id(name);
const intersect = (a,b) => a.filter(value=>b.includes(value));
const unique = list => [...new Set(list)];

// A CLOSED deterministic environment, not a plugin/model sandbox. Only this
// environment constructs context provenance; callers cannot submit source labels.
export class ControlledContextLab {
  #store; #ledger; #admin;
  constructor(store,ledger,{administrator='host-admin'}={}) {this.#store=store;this.#ledger=ledger;this.#admin=id(administrator);}
  #load(tx,type,name,revision) {
    const record=tx.get(key(type,name),revision);
    if(!record||record.kind!==type)deny('resource_not_found');return record;
  }
  #spec(raw,required,optional=[]) {const v=snapshot('data-request',raw).value;fields(v,required,optional);return v;}
  createSource(handle,commandId,raw) {
    const actor=this.#ledger.principal(handle);if(actor!==this.#admin)deny('not_authorized');
    const spec=this.#spec(raw,['sourceId','controller','content','purposes','recipients','retentionUntil']);
    id(spec.sourceId);id(spec.controller);ids(spec.purposes);ids(spec.recipients);
    if(typeof spec.content!=='string'||Buffer.byteLength(spec.content)>4096||!Number.isSafeInteger(spec.retentionUntil)||spec.retentionUntil<0)deny('invalid_source');
    return this.#store.command(actor,commandId,{operation:'source-create',spec},tx=>{
      if(tx.get(key('source',spec.sourceId)))deny('resource_exists');
      if(spec.retentionUntil<=this.#ledger.now())deny('source_expired');
      tx.put(key('source',spec.sourceId),'source',{...spec,status:'active',epoch:0},0);return {sourceId:spec.sourceId};
    });
  }
  revokeSource(handle,commandId,sourceId) {
    const actor=this.#ledger.principal(handle);
    return this.#store.command(actor,commandId,{operation:'source-revoke',sourceId},tx=>{
      const record=this.#load(tx,'source',sourceId),source=record.value;
      if(![this.#admin,source.controller].includes(actor))deny('not_authorized');
      if(source.status==='active')tx.put(key('source',sourceId),'source',{...source,status:'revoked',epoch:source.epoch+1},record.revision);
      return {sourceId,status:source.status==='active'?'revoked':source.status};
    });
  }
  #refresh(origins, observedAt=this.#ledger.now()) {
    const now=this.#ledger.refresh(unique(origins.map(o=>o.grantId)),observedAt);let observedError;
    this.#store.transaction(tx=>{
      for(const sourceId of unique(origins.map(o=>o.sourceId))) {
        try {
          const record=this.#load(tx,'source',sourceId),s=record.value;
          if(s.status==='active'&&now>=s.retentionUntil)tx.put(key('source',sourceId),'source',{...s,status:'expired',epoch:s.epoch+1},record.revision);
        } catch(error) { observedError??=error; }
      }
      return null;
    });
    if(observedError)throw observedError;
    return now;
  }
  #origin(tx,sourceId,grantId,actor,purpose,now) {
    const sourceRecord=this.#load(tx,'source',sourceId),source=sourceRecord.value;
    if(source.status!=='active'||now>=source.retentionUntil)deny('source_inactive');
    if(!source.purposes.includes(purpose)||!source.recipients.includes(actor))deny('source_scope_denied');
    const chain=this.#ledger.validateIn(tx,{grantId,actor,resourceId:sourceId,operations:['read'],purpose,recipient:actor},now);
    if(chain.at(-1).value.rootPrincipal!==source.controller)deny('source_controller_mismatch');
    return {sourceId,sourceRevision:sourceRecord.revision,sourceDigest:sourceRecord.digest,sourceEpoch:source.epoch,grantId,
      grantEpochs:chain.map(r=>({grantId:r.value.grantId,epoch:r.value.epoch}))};
  }
  #validate(tx,origins,actor,purpose,recipient,operations,now) {
    if(!origins.length||origins.length>32)deny('provenance_limit');
    let recipients=null,deadline=Number.MAX_SAFE_INTEGER;
    for(const origin of origins) {
      const current=this.#load(tx,'source',origin.sourceId).value;
      const original=this.#load(tx,'source',origin.sourceId,origin.sourceRevision);
      if(original.digest!==origin.sourceDigest||current.epoch!==origin.sourceEpoch||current.status!=='active'||now>=current.retentionUntil)deny('stale_source');
      if(!current.purposes.includes(purpose)||!current.recipients.includes(recipient))deny('source_scope_denied');
      const chain=this.#ledger.validateIn(tx,{grantId:origin.grantId,actor,resourceId:origin.sourceId,operations,purpose,recipient},now);
      if(chain.at(-1).value.rootPrincipal!==current.controller||digest('epochs',chain.map(r=>({grantId:r.value.grantId,epoch:r.value.epoch})))!==digest('epochs',origin.grantEpochs))deny('stale_grant');
      const allowed=intersect(current.recipients,chain[0].value.recipients);
      recipients=recipients===null?allowed:intersect(recipients,allowed);
      deadline=Math.min(deadline,current.retentionUntil,...chain.map(r=>r.value.expiresAt));
    }
    return {recipients,retentionUntil:deadline};
  }
  #owned(handle,type,name) {
    const actor=this.#ledger.principal(handle),record=this.#store.get(key(type,name));
    if(!record||record.kind!==type||record.value.actor!==actor)deny('not_authorized');return {actor,record};
  }
  createContext(handle,commandId,raw) {
    const actor=this.#ledger.principal(handle),spec=this.#spec(raw,['contextId','bindings','stateRefs','purpose']);
    id(spec.contextId);id(spec.purpose);
    if(!Array.isArray(spec.bindings)||!Array.isArray(spec.stateRefs)||spec.bindings.length+spec.stateRefs.length<1||spec.bindings.length+spec.stateRefs.length>16)deny('invalid_context');
    for(const binding of spec.bindings){fields(binding,['sourceId','grantId']);id(binding.sourceId);id(binding.grantId);}
    spec.stateRefs.forEach(id);if(unique(spec.stateRefs).length!==spec.stateRefs.length)deny('invalid_context');
    const earlier=[];
    for(const stateId of spec.stateRefs) {
      const prior=this.#owned(handle,'artifact',stateId).record.value;
      if(prior.purpose!==spec.purpose)deny('purpose_denied');earlier.push(...prior.origins);
    }
    const refreshOrigins=[...earlier,...spec.bindings.map(b=>({sourceId:b.sourceId,grantId:b.grantId}))];
    const now=this.#refresh(refreshOrigins);
    return this.#store.command(actor,commandId,{operation:'context-create',spec},tx=>{
      if(tx.get(key('context',spec.contextId)))deny('resource_exists');
      const inputRefs=[],origins=[...earlier];
      for(const binding of spec.bindings) {
        origins.push(this.#origin(tx,binding.sourceId,binding.grantId,actor,spec.purpose,now));
        const resource=this.#load(tx,'source',binding.sourceId);
        inputRefs.push({type:'source',id:binding.sourceId,revision:resource.revision,digest:resource.digest});
      }
      for(const stateId of spec.stateRefs) {
        const resource=this.#load(tx,'artifact',stateId);
        inputRefs.push({type:'artifact',id:stateId,revision:resource.revision,digest:resource.digest});
      }
      const byDigest=new Map(origins.map(origin=>[digest('origin',origin),origin]));
      const closure=[...byDigest.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,origin])=>origin);
      const labels=this.#validate(tx,closure,actor,spec.purpose,actor,['read'],now);
      const inputBytes=inputRefs.reduce((sum,ref)=>sum+Buffer.byteLength(this.#load(tx,ref.type,ref.id,ref.revision).value.content),0);
      if(inputBytes>8192)deny('context_input_limit');
      for(const grantId of unique(closure.map(o=>o.grantId)))this.#ledger.spendIn(tx,grantId,{calls:1,bytes:inputBytes},now);
      const context={contextId:spec.contextId,actor,purpose:spec.purpose,profile:'deterministic.concat.v1',inputRefs,origins:closure,...labels};
      const saved=tx.put(key('context',spec.contextId),'context',context,0);
      return {contextId:spec.contextId,contextDigest:saved.digest};
    });
  }
  run(handle,commandId,raw) {
    const spec=this.#spec(raw,['contextId','artifactId']);id(spec.contextId);id(spec.artifactId);
    const {actor,record}=this.#owned(handle,'context',spec.contextId),context=record.value;
    const now=this.#refresh(context.origins);
    return this.#store.command(actor,commandId,{operation:'context-run',spec,contextDigest:record.digest},tx=>{
      if(tx.get(key('artifact',spec.artifactId)))deny('resource_exists');
      const labels=this.#validate(tx,context.origins,actor,context.purpose,actor,['read','derive'],now);
      if(context.profile!=='deterministic.concat.v1')deny('unknown_executor_profile');
      const parts=context.inputRefs.map(ref=>{
        const data=this.#load(tx,ref.type,ref.id,ref.revision);
        if(data.digest!==ref.digest)deny('context_binding_mismatch');return data.value.content;
      });
      const content=parts.join('\n'),bytes=Buffer.byteLength(content);
      if(bytes>8192)deny('output_limit');
      for(const grantId of unique(context.origins.map(o=>o.grantId)))this.#ledger.spendIn(tx,grantId,{calls:1,bytes},now);
      tx.put(key('artifact',spec.artifactId),'artifact',{artifactId:spec.artifactId,actor,purpose:context.purpose,content,
        contextId:spec.contextId,contextDigest:record.digest,origins:context.origins,...labels},0);
      return {artifactId:spec.artifactId,contextDigest:record.digest};
    });
  }
  assertBrokerDomain(store, identities) {
    if(this.#store!==store||!this.#ledger.belongsTo(store,identities))deny('context_domain_mismatch');
  }
  // Trusted broker bridge only. Never expose these transaction methods to agents.
  // Refresh preserves observed expirations outside the later command transaction.
  nowForPermit() { return this.#ledger.now(); }
  refreshForPermit(handle, artifactId, observedAt=this.#ledger.now()) {
    const {record}=this.#owned(handle,'artifact',artifactId);
    return this.#refresh(record.value.origins,observedAt);
  }
  permitInputIn(tx, {actor,artifactId,purpose,recipient,expectedDigest=null,charge=false}, now) {
    const record=this.#load(tx,'artifact',artifactId),artifact=record.value;
    if(artifact.actor!==actor)deny('not_authorized');
    if(artifact.purpose!==purpose)deny('purpose_denied');
    if(expectedDigest!==null&&record.digest!==expectedDigest)deny('binding_mismatch');
    const context=this.#load(tx,'context',artifact.contextId);
    if(context.digest!==artifact.contextDigest||context.value.profile!=='deterministic.concat.v1')deny('context_binding_mismatch');
    const labels=this.#validate(tx,artifact.origins,actor,purpose,recipient,['read','disclose'],now);
    if(charge)for(const grantId of unique(artifact.origins.map(o=>o.grantId)))this.#ledger.spendIn(tx,grantId,{calls:1,bytes:Buffer.byteLength(artifact.content)},now);
    return {artifactId,artifactDigest:record.digest,contextId:artifact.contextId,contextDigest:artifact.contextDigest,
      origins:artifact.origins,content:artifact.content,...labels};
  }

  // Local test-host delivery only: no sockets, UI renderer or production broker.
  // Replays return history WITHOUT content, so they cannot send bytes twice for one budget debit.
  disclose(handle,commandId,raw) {
    const recipient=this.#ledger.principal(handle),spec=this.#spec(raw,['artifactId','purpose']);id(spec.artifactId);id(spec.purpose);
    const record=this.#store.get(key('artifact',spec.artifactId));
    if(!record||record.kind!=='artifact'||!record.value.recipients.includes(recipient))deny('not_authorized');
    const artifact=record.value;if(artifact.purpose!==spec.purpose)deny('purpose_denied');
    const now=this.#refresh(artifact.origins);
    // Revalidate even on command replay; historical acknowledgments never authorize new disclosure.
    this.#store.transaction(tx=>{this.#validate(tx,artifact.origins,artifact.actor,spec.purpose,recipient,['disclose'],now);return null;});
    const result=this.#store.command(recipient,commandId,{operation:'artifact-disclose',spec},tx=>{
      this.#validate(tx,artifact.origins,artifact.actor,spec.purpose,recipient,['disclose'],now);
      for(const grantId of unique(artifact.origins.map(o=>o.grantId)))this.#ledger.spendIn(tx,grantId,{calls:1,bytes:Buffer.byteLength(artifact.content)},now);
      return {artifactId:spec.artifactId,recipient};
    });
    return result.replayed?{...result,delivered:false}:{...result,delivered:true,content:artifact.content};
  }
}
