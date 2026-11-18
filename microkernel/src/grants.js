import { ContractError, snapshot } from './canonical.js';
export const deny = code => { throw new ContractError(code); };
export const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9.-]{0,63}$/.test(value)) deny('invalid_id');
  return value;
};
export function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) deny('invalid_shape');
}
export function ids(value) {
  if (!Array.isArray(value) || !value.length || value.length > 32) deny('invalid_sorted_set');
  value.forEach(id);
  if (value.some((v,i) => i && value[i-1] >= v)) deny('invalid_sorted_set');
  return value;
}
const subset = (child,parent) => child.every(v => parent.includes(v));
const axes = ['calls','bytes'];
function budget(value) {
  fields(value,axes);
  for (const axis of axes) if (!Number.isSafeInteger(value[axis]) || value[axis] < 0 || value[axis] > (axis==='calls'?10000:1000000)) deny('invalid_budget');
  return value;
}
const zero = () => ({calls:0,bytes:0});
const key = name => 'grant.' + id(name);
export class GrantLedger {
  #store; #identities; #admin; #clock;
  constructor(store, identities, {administrator='host-admin', clock=()=>Date.now()} = {}) { this.#store=store;this.#identities=identities;this.#admin=id(administrator);this.#clock=clock; }
  belongsTo(store, identities) { return this.#store===store&&this.#identities===identities; }
  principal(handle) { return this.#identities.resolve(handle); }
  now() { const now=this.#clock();if(!Number.isSafeInteger(now)||now<0)deny('invalid_clock');return now; }
  #spec(raw, root) {
    const value=snapshot('grant-spec',raw).value;
    fields(value,['grantId','delegate','resources','operations','purposes','recipients','budget','expiresAt','maxDepth'],root?['rootPrincipal']:[]);
    if(root&&!Object.hasOwn(value,'rootPrincipal'))deny('invalid_shape');
    id(value.grantId);id(value.delegate);if(root)id(value.rootPrincipal);
    for(const name of ['resources','operations','purposes','recipients'])ids(value[name]);
    if(value.operations.some(v=>!['derive','disclose','read'].includes(v)))deny('unsupported_operation');
    if(!value.recipients.includes(value.delegate))deny('delegate_not_recipient');
    budget(value.budget);if(value.budget.calls<1)deny('invalid_budget');
    if(!Number.isSafeInteger(value.expiresAt)||value.expiresAt<0||!Number.isInteger(value.maxDepth)||value.maxDepth<0||value.maxDepth>8)deny('invalid_grant_limits');
    return value;
  }
  #load(tx, grantId) { const record=tx.get(key(grantId));if(!record||record.kind!=='grant')deny('grant_not_found');return record; }
  chainIn(tx, grantId, now=this.now()) {
    const chain=[],seen=new Set();let current=grantId;
    while(current!==null) {
      if(seen.has(current)||chain.length>8)deny('invalid_delegation_chain');seen.add(current);
      const record=this.#load(tx,current), grant=record.value;
      if(grant.status!=='active'||now>=grant.expiresAt)deny('grant_inactive');
      chain.push(record);current=grant.parentId;
    }
    return chain;
  }
  // Persist an observed expiration before a later denied transaction rolls back.
  refresh(grantIds, observedAt=this.now()) {
    if(!Number.isSafeInteger(observedAt)||observedAt<0)deny('invalid_clock');
    const now=observedAt;let observedError;
    this.#store.transaction(tx=>{
      const seen=new Set();
      for(const grantId of grantIds) {
        let current=grantId;let depth=0;
        while(current!==null) {
          try {
            if(seen.has(current))break;if(depth++>8)deny('invalid_delegation_chain');seen.add(current);
            const record=this.#load(tx,current),g=record.value;
            if(g.status==='active'&&now>=g.expiresAt)tx.put(key(current),'grant',{...g,status:'expired',epoch:g.epoch+1},record.revision);
            current=g.parentId;
          } catch(error) { observedError??=error;break; }
        }
      }
      return null;
    });
    // A malformed later reference must not roll back an expiration already observed.
    if(observedError)throw observedError;
    return now;
  }
  issueRoot(handle, commandId, raw) {
    const actor=this.principal(handle);if(actor!==this.#admin)deny('not_authorized');
    const spec=this.#spec(raw,true);
    return this.#store.command(actor,commandId,{operation:'grant-root',spec},tx=>{
      if(tx.get(key(spec.grantId)))deny('grant_exists');
      if(spec.expiresAt<=this.now())deny('invalid_grant_limits');
      const grant={...spec,issuer:actor,parentId:null,status:'active',epoch:0,spent:zero(),allocated:zero(),children:[]};
      tx.put(key(spec.grantId),'grant',grant,0);return {grantId:spec.grantId};
    });
  }
  attenuate(handle, commandId, parentId, raw) {
    const actor=this.principal(handle),spec=this.#spec(raw,false), now=this.refresh([parentId]);
    return this.#store.command(actor,commandId,{operation:'grant-child',parentId,spec},tx=>{
      const chain=this.chainIn(tx,parentId,now),record=chain[0],p=record.value;
      if(p.delegate!==actor)deny('not_authorized');
      if(spec.expiresAt<=now)deny('invalid_grant_limits');
      if(!p.maxDepth||spec.maxDepth>=p.maxDepth||spec.expiresAt>p.expiresAt)deny('delegation_not_attenuated');
      for(const name of ['resources','operations','purposes','recipients'])if(!subset(spec[name],p[name]))deny('scope_not_subset');
      if(p.children.length>=64)deny('delegation_capacity');
      if(tx.get(key(spec.grantId)))deny('grant_exists');
      for(const axis of axes)if(spec.budget[axis]>p.budget[axis]-p.spent[axis]-p.allocated[axis])deny('budget_exhausted');
      tx.put(key(parentId),'grant',{...p,allocated:{calls:p.allocated.calls+spec.budget.calls,bytes:p.allocated.bytes+spec.budget.bytes},children:[...p.children,spec.grantId]},record.revision);
      tx.put(key(spec.grantId),'grant',{...spec,rootPrincipal:p.rootPrincipal,issuer:actor,parentId,status:'active',epoch:0,spent:zero(),allocated:zero(),children:[]},0);
      return {grantId:spec.grantId};
    });
  }
  validateIn(tx, {grantId,actor,resourceId,operations,purpose,recipient}, now=this.now()) {
    const chain=this.chainIn(tx,grantId,now),leaf=chain[0].value;
    if(leaf.delegate!==actor)deny('not_authorized');
    if(!leaf.resources.includes(resourceId)||!operations.every(v=>leaf.operations.includes(v))||!leaf.purposes.includes(purpose)||!leaf.recipients.includes(recipient))deny('grant_scope_denied');
    return chain;
  }
  spendIn(tx,grantId,cost,now=this.now()) {
    budget(cost);const record=this.chainIn(tx,grantId,now)[0],g=record.value;
    for(const axis of axes)if(cost[axis]>g.budget[axis]-g.spent[axis]-g.allocated[axis])deny('budget_exhausted');
    tx.put(key(grantId),'grant',{...g,spent:{calls:g.spent.calls+cost.calls,bytes:g.spent.bytes+cost.bytes}},record.revision);
  }
  revoke(handle,commandId,grantId) {
    const actor=this.principal(handle);
    return this.#store.command(actor,commandId,{operation:'grant-revoke',grantId},tx=>{
      const record=this.#load(tx,grantId),g=record.value;
      if(![this.#admin,g.rootPrincipal,g.issuer].includes(actor))deny('not_authorized');
      if(g.status==='active')tx.put(key(grantId),'grant',{...g,status:'revoked',epoch:g.epoch+1},record.revision);
      return {grantId,status:g.status==='active'?'revoked':g.status};
    });
  }
  inspect(handle,grantId) {
    const actor=this.principal(handle);this.refresh([grantId]);
    return this.#store.transaction(tx=>{
      const g=this.#load(tx,grantId).value;
      if(![this.#admin,g.rootPrincipal,g.issuer,g.delegate].includes(actor))deny('not_authorized');return g;
    });
  }
}
