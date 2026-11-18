import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SnapshotStore} from '../src/store.js';
import {HostIdentity} from '../src/identity.js';
import {PermitLab} from '../src/permits.js';
function fixture(fault=null){
 const dir=mkdtempSync(join(tmpdir(),'permit-lab-')),path=join(dir,'core.sqlite'),sink=join(dir,'sink.sqlite');
 const auth=new HostIdentity(),admin=auth.authenticate('host-admin'),owner=auth.authenticate('owner'),other=auth.authenticate('other');
 let store,lab,clock=100;const open=f=>{store=new SnapshotStore(path);lab=new PermitLab(store,auth,sink,{clock:()=>clock,testFault:f});};open(fault);
 lab.allocate(admin,'allocate',{allocationId:'budget',controller:'owner',calls:2,expiresAt:500});
 return {admin,owner,other,auth,get lab(){return lab;},get store(){return store;},clock(v){clock=v;},reopen(f=null){lab.close();store.close();open(f);},done(){lab.close();store.close();rmSync(dir,{recursive:true});}};
}
const prepare=(f,id='work')=>f.lab.prepare(f.owner,'prepare-'+id,{activityId:id,allocationId:'budget',scenario:'synthetic-form'}).ack;
const request=ack=>({activityId:ack.activityId,expectedRevision:ack.revision,bindingDigest:ack.bindingDigest});
test('synthetic dispatch binds immutable input, records observed fact once and replays only historical ack',()=>{
 const f=fixture();try{
  const a=prepare(f);assert.throws(()=>f.lab.dispatch(f.other,'wrong',request(a)),{code:'not_authorized'});
  assert.throws(()=>f.lab.dispatch(f.owner,'bad',{...request(a),bindingDigest:'wrong'}),{code:'binding_mismatch'});
  assert.equal(f.lab.inspect(f.owner,'work').permit,'issued');
  const r=f.lab.dispatch(f.owner,'send',request(a));assert.equal(r.ack.dispatch,'dispatch_recorded');
  assert.equal(f.lab.inspect(f.owner,'work').dispatch,'observation_confirmed');
  assert.equal(f.lab.dispatch(f.owner,'send',request(a)).replayed,true);
  assert.throws(()=>f.lab.dispatch(f.owner,'send-again',request(a)),{code:'revision_conflict'});
  assert.equal(f.store.get('allocation.budget').value.settled,1);
  f.reopen();assert.equal(f.lab.reconcile(f.owner,'work').observed,true);
  assert.equal(f.store.get('allocation.budget').value.settled,1);
 }finally{f.done();}
});
test('single slot, reserved capacity, cancelled release once and no activity resurrection',()=>{
 const f=fixture();try{
  prepare(f);prepare(f,'second');
  assert.throws(()=>prepare(f,'third'),{code:'budget_exhausted'});
  assert.throws(()=>f.lab.prepare(f.owner,'different',{activityId:'work',allocationId:'budget',scenario:'synthetic-scene'}),{code:'active_or_terminal_activity'});
  f.lab.cancel(f.owner,'cancel','work');f.lab.cancel(f.owner,'cancel-again','work');
  assert.equal(f.store.get('allocation.budget').value.reserved,1);prepare(f,'third');
  assert.throws(()=>f.lab.prepare(f.owner,'resurrect',{activityId:'work',allocationId:'budget',scenario:'synthetic-form'}),{code:'active_or_terminal_activity'});
 }finally{f.done();}
});
test('revoked or observed expired allocation cannot dispatch after restart or time rollback',()=>{
 for(const expired of [false,true]){
  const f=fixture();try{
   const a=prepare(f);
   if(expired){f.clock(501);assert.throws(()=>f.lab.dispatch(f.owner,'expired',request(a)),{code:'allocation_inactive'});f.reopen();f.clock(100);}
   else f.lab.revoke(f.owner,'revoke','budget');
   assert.throws(()=>f.lab.dispatch(f.owner,'attempt',request(a)),{code:'allocation_inactive'});
   assert.equal(f.lab.inspect(f.owner,'work').permit,'issued');
  }finally{f.done();}
 }
});
test('interruption after consume never resends on reopen or replay; missing observation remains uncertain',()=>{
 const f=fixture('after-consume');try{
  const a=prepare(f);assert.throws(()=>f.lab.dispatch(f.owner,'send',request(a)),{code:'simulated_process_interruption'});
  f.reopen();assert.equal(f.lab.dispatch(f.owner,'send',request(a)).replayed,true);
  assert.deepEqual(f.lab.reconcile(f.owner,'work'),{activityId:'work',observed:false,dispatch:'uncertain'});
  assert.equal(f.store.get('allocation.budget').value.reserved,1);
  f.lab.cancel(f.owner,'cancel','work');assert.equal(f.lab.inspect(f.owner,'work').intent,'cancel_requested');
  assert.equal(f.store.get('allocation.budget').value.reserved,1);
 }finally{f.done();}
});
test('sink committed but receipt lost: cancel/revoke does not erase protected late fact or double settle',()=>{
 const f=fixture('after-sink');try{
  const a=prepare(f);assert.throws(()=>f.lab.dispatch(f.owner,'send',request(a)),{code:'simulated_process_interruption'});
  f.reopen();f.lab.cancel(f.owner,'cancel','work');f.lab.revoke(f.owner,'revoke','budget');
  assert.throws(()=>f.lab.reconcile(f.other,'work'),{code:'not_authorized'});
  assert.equal(f.lab.reconcile(f.owner,'work').observed,true);f.lab.reconcile(f.owner,'work');
  const state=f.lab.inspect(f.owner,'work');assert.equal(state.intent,'cancel_requested');assert.equal(state.dispatch,'observation_confirmed');
  assert.equal(f.store.get('allocation.budget').value.settled,1);assert.equal(f.store.get('allocation.budget').value.reserved,0);
 }finally{f.done();}
});
test('only administrative synthetic allocations accepted, no caller context/issuer/raw fields',()=>{
 const f=fixture();try{
  assert.throws(()=>f.lab.allocate(f.owner,'hack',{allocationId:'hack',controller:'owner',calls:10,expiresAt:500}),{code:'not_authorized'});
  for(const extra of [{content:'private'},{contextDigest:'forged'},{issuer:'local-sink'}])assert.throws(()=>f.lab.prepare(f.owner,'bad',{activityId:'work',allocationId:'budget',scenario:'synthetic-form',...extra}),{code:'invalid_shape'});
  assert.throws(()=>f.lab.prepare(f.owner,'real',{activityId:'work',allocationId:'budget',scenario:'real-account'}),{code:'unsupported_scenario'});
 }finally{f.done();}
});

for(const point of ['kill-after-consume','kill-after-sink'])test('actual SIGKILL '+point+' releases both databases without automatic send',async()=>{
 const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'permit-crash-'));
 let store,lab;
 try{
  const child=spawnSync(process.execPath,[new URL('../fixtures/permit-crash-child.mjs',import.meta.url).pathname,dir,point],{timeout:10000,encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const auth=new HostIdentity(),owner=auth.authenticate('owner');store=new SnapshotStore(join(dir,'core.sqlite'));
  lab=new PermitLab(store,auth,join(dir,'sink.sqlite'),{clock:()=>100});
  assert.equal(lab.inspect(owner,'work').dispatch,'uncertain');
  const observed=point==='kill-after-sink';assert.equal(lab.reconcile(owner,'work').observed,observed);
  const a=store.get('allocation.budget').value;assert.equal(a.reserved,observed?0:1);assert.equal(a.settled,observed?1:0);
  assert.equal(lab.reconcile(owner,'work').observed,observed);
 }finally{lab?.close();store?.close();rmSync(dir,{recursive:true});}
});

test('issued permit survives reopen but second controller cannot inspect/cancel or spend its slot',()=>{
 const f=fixture();try{
  const a=prepare(f),binding=f.lab.inspect(f.owner,'work').binding;
  assert.throws(()=>{binding.recipient='other';},TypeError);
  assert.throws(()=>f.lab.inspect(f.other,'work'),{code:'not_authorized'});
  assert.throws(()=>f.lab.cancel(f.other,'cancel-other','work'),{code:'not_authorized'});
  f.reopen();assert.equal(f.lab.inspect(f.owner,'work').binding.domain,binding.domain);
  f.lab.dispatch(f.owner,'send',request(a));assert.equal(f.lab.reconcile(f.owner,'work').observed,true);
  assert.equal(f.store.get('allocation.budget').value.settled,1);
 }finally{f.done();}
});

test('closed broker rejects before consuming a permit or changing reserved budget',()=>{
 const f=fixture();try{
  const a=prepare(f);f.lab.close();f.lab.close();
  assert.throws(()=>f.lab.dispatch(f.owner,'send',request(a)),{code:'permit_lab_closed'});
  assert.throws(()=>f.lab.cancel(f.owner,'cancel','work'),{code:'permit_lab_closed'});
  assert.equal(f.store.get('activity.work').value.permit,'issued');
  assert.equal(f.store.get('allocation.budget').value.reserved,1);
  f.reopen();f.lab.dispatch(f.owner,'send',request(a));assert.equal(f.lab.inspect(f.owner,'work').dispatch,'observation_confirmed');
 }finally{f.done();}
});
