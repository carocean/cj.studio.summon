import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SnapshotStore} from '../src/store.js';
import {HostIdentity} from '../src/identity.js';
import {GrantLedger} from '../src/grants.js';
import {ControlledContextLab} from '../src/context.js';
import {PermitLab} from '../src/permits.js';
function fixture({content='synthetic-form',recipients=['local-sink','owner','worker'],calls=10,fault=null}={}){
 const dir=mkdtempSync(join(tmpdir(),'linked-permit-')),path=join(dir,'core.sqlite');let clock=100,permitClock=null,store,grants,data,lab;
 const auth=new HostIdentity(),admin=auth.authenticate('host-admin'),owner=auth.authenticate('owner'),worker=auth.authenticate('worker');
 function open(){store=new SnapshotStore(path);grants=new GrantLedger(store,auth,{clock:()=>clock});data=new ControlledContextLab(store,grants);lab=new PermitLab(store,auth,join(dir,'sink.sqlite'),{clock:()=>permitClock??clock,contextLab:data,testFault:fault});}open();
 data.createSource(admin,'source',{sourceId:'form',controller:'owner',content,purposes:['work'],recipients,retentionUntil:600});
 grants.issueRoot(admin,'grant',{grantId:'root',rootPrincipal:'owner',delegate:'worker',resources:['form'],operations:['derive','disclose','read'],purposes:['work'],recipients,budget:{calls,bytes:10000},expiresAt:500,maxDepth:2});
 data.createContext(worker,'context',{contextId:'context',bindings:[{sourceId:'form',grantId:'root'}],stateRefs:[],purpose:'work'});
 data.run(worker,'run',{contextId:'context',artifactId:'artifact'});
 lab.allocate(admin,'allocate',{allocationId:'budget',controller:'worker',calls:2,expiresAt:700});
 return {admin,owner,worker,auth,get store(){return store;},get grants(){return grants;},get data(){return data;},get lab(){return lab;},clock(v){clock=v;},permitClock(v){permitClock=v;},reopen(){lab.close();store.close();open();},done(){lab.close();store.close();rmSync(dir,{recursive:true});}};
}
const prepare=f=>f.lab.prepareFromArtifact(f.worker,'prepare',{activityId:'activity',allocationId:'budget',artifactId:'artifact',purpose:'work'}).ack;
const req=a=>({activityId:a.activityId,expectedRevision:a.revision,bindingDigest:a.bindingDigest});
test('linked context and grants are bound, checked and debited atomically with permit consumption',()=>{
 const f=fixture();try{
  const a=prepare(f);assert.equal(f.grants.inspect(f.worker,'root').spent.calls,2);
  assert.equal(f.lab.inspect(f.worker,'activity').input,undefined);
  f.reopen();f.lab.dispatch(f.worker,'dispatch',req(a));
  assert.equal(f.lab.reconcile(f.worker,'activity').observed,true);
  assert.equal(f.grants.inspect(f.worker,'root').spent.calls,3);
  assert.equal(f.lab.dispatch(f.worker,'dispatch',req(a)).replayed,true);
  assert.equal(f.grants.inspect(f.worker,'root').spent.calls,3);
 }finally{f.done();}
});
test('revocation of source or grant after prepare blocks consumption and sink',()=>{
 for(const source of [true,false]){const f=fixture();try{
  const a=prepare(f);
  if(source)f.data.revokeSource(f.owner,'revoke','form');else f.grants.revoke(f.owner,'revoke','root');
  assert.throws(()=>f.lab.dispatch(f.worker,'dispatch',req(a)));
  assert.equal(f.lab.inspect(f.worker,'activity').permit,'issued');
  assert.equal(f.store.get('grant.root').value.spent.calls,2);
  assert.equal(f.store.get('allocation.budget').value.reserved,1);
  assert.throws(()=>f.lab.reconcile(f.worker,'activity'),{code:'not_dispatched'});
 }finally{f.done();}}
});
test('missing destination permission, wrong purpose, foreign actor and non synthetic bytes cannot prepare',()=>{
 for(const options of [{recipients:['owner','worker']},{content:'real sensitive data'}]){
  const f=fixture(options);try{assert.throws(()=>prepare(f));assert.equal(f.store.get('allocation.budget').value.reserved,0);}finally{f.done();}
 }
 const f=fixture();try{
  assert.throws(()=>f.lab.prepareFromArtifact(f.worker,'bad',{activityId:'activity',allocationId:'budget',artifactId:'artifact',purpose:'marketing'}),{code:'purpose_denied'});
  assert.throws(()=>f.lab.prepareFromArtifact(f.owner,'bad-owner',{activityId:'activity',allocationId:'budget',artifactId:'artifact',purpose:'work'}),{code:'not_authorized'});
 }finally{f.done();}
});
test('data grant exhausted after prepare leaves permit issued and all consumption changes rolled back',()=>{
 const f=fixture({calls:2});try{
  const a=prepare(f);assert.throws(()=>f.lab.dispatch(f.worker,'dispatch',req(a)),{code:'budget_exhausted'});
  assert.equal(f.lab.inspect(f.worker,'activity').permit,'issued');assert.equal(f.store.get('allocation.budget').value.reserved,1);
  assert.equal(f.grants.inspect(f.worker,'root').spent.calls,2);
 }finally{f.done();}
});
test('observed data expiry survives restart/time rollback and cannot revive prepared authority',()=>{
 const f=fixture();try{
  const a=prepare(f);f.clock(501);assert.throws(()=>f.lab.dispatch(f.worker,'dispatch',req(a)));
  f.reopen();f.clock(100);assert.throws(()=>f.lab.dispatch(f.worker,'dispatch',req(a)));
  assert.equal(f.store.get('grant.root').value.status,'expired');assert.equal(f.lab.inspect(f.worker,'activity').permit,'issued');
 }finally{f.done();}
});
test('unknown result keeps data cost charged once; revocation still permits protected receipt reconciliation',()=>{
 const f=fixture({fault:'after-sink'});try{
  const a=prepare(f);assert.throws(()=>f.lab.dispatch(f.worker,'dispatch',req(a)),{code:'simulated_process_interruption'});
  f.grants.revoke(f.owner,'revoke','root');f.reopen();
  assert.equal(f.lab.reconcile(f.worker,'activity').observed,true);
  assert.equal(f.store.get('grant.root').value.spent.calls,3);
  assert.equal(f.store.get('allocation.budget').value.settled,1);
 }finally{f.done();}
});

test('inherited memory closure and attenuated ancestor authority remain enforced at consume',()=>{
 const f=fixture();try{
  f.grants.attenuate(f.worker,'child','root',{grantId:'child',delegate:'worker',resources:['form'],operations:['derive','disclose','read'],purposes:['work'],recipients:['local-sink','owner','worker'],budget:{calls:6,bytes:2000},expiresAt:450,maxDepth:1});
  f.data.createContext(f.worker,'child-context',{contextId:'child-context',bindings:[{sourceId:'form',grantId:'child'}],stateRefs:[],purpose:'work'});
  f.data.run(f.worker,'child-run',{contextId:'child-context',artifactId:'memory'});
  f.data.createContext(f.worker,'inherited-context',{contextId:'inherited',bindings:[],stateRefs:['memory'],purpose:'work'});
  f.data.run(f.worker,'inherited-run',{contextId:'inherited',artifactId:'inherited-artifact'});
  const a=f.lab.prepareFromArtifact(f.worker,'prepare',{activityId:'activity',allocationId:'budget',artifactId:'inherited-artifact',purpose:'work'}).ack;
  const v=f.store.get('activity.activity').value;assert.equal(v.context.origins[0].grantEpochs.length,2);
  f.grants.revoke(f.owner,'revoke-parent','root');
  assert.throws(()=>f.lab.dispatch(f.worker,'dispatch',req(a)),{code:'grant_inactive'});
  assert.equal(f.store.get('grant.child').value.spent.calls,4);
  assert.equal(f.lab.inspect(f.worker,'activity').permit,'issued');
 }finally{f.done();}
});
test('broker rejects context service connected to a different transaction or identity domain',()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'wrong-domain-'));let other;
 try{
  other=new SnapshotStore(join(dir,'other.sqlite'));
  assert.throws(()=>new PermitLab(other,f.auth,join(dir,'sink.sqlite'),{contextLab:f.data}),{code:'context_domain_mismatch'});
  assert.throws(()=>new PermitLab(f.store,new HostIdentity(),join(dir,'sink.sqlite'),{contextLab:f.data}),{code:'context_domain_mismatch'});
  assert.equal(other.get('permit-domain'),null);
 }finally{other?.close();f.done();rmSync(dir,{recursive:true});}
});

test('different trusted clock observations latch data and execution expiry before rollback',()=>{
 for(const faster of ['permit','ledger']){const f=fixture();try{
  const a=prepare(f);
  if(faster==='permit')f.permitClock(550);else{f.clock(750);f.permitClock(100);}
  assert.throws(()=>f.lab.dispatch(f.worker,'first',req(a)));
  if(faster==='permit')assert.equal(f.store.get('grant.root').value.status,'expired');
  else assert.equal(f.store.get('allocation.budget').value.status,'expired');
  f.reopen();f.clock(100);f.permitClock(100);
  assert.throws(()=>f.lab.dispatch(f.worker,'second',req(a)));
  assert.equal(f.lab.inspect(f.worker,'activity').permit,'issued');
 }finally{f.done();}}
});
