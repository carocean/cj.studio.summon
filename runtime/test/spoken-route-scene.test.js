import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SceneLab } from '../src/scene.js';
import { parseSpokenRoute } from '../src/spoken-route.js';
import { syntheticRoute } from '../src/creature-market.js';
const productId='demo.maps.v1';
function fixture(marketOptions={}){
 const dir=mkdtempSync(join(tmpdir(),'spoken-scene-'));let now=100,scene;
 const open=()=>scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'),{clock:()=>now,marketOptions});open();
 return {get scene(){return scene;},clock(n){now=n;},enable(){scene.subscribeCreature({productId});const sub=scene.state().market.subscriptions[0];scene.grantRoute({productId,enabled:true,expectedRevision:sub.revision});},
 proposal(eventId='p-one',modality='hearing'){
  const frame=scene.captureSenseContext();scene.beginSense(eventId,frame,modality,200);
  const p=scene.makeSpokenRouteProposal(eventId,frame,parseSpokenRoute('请用演示地图从甲站到丙站规划合成路线'),200);
  scene.finishSense(eventId,{routeProposal:p,candidate:null});return p;
 },reopen(){scene.close();open();},close(){scene.close();rmSync(dir,{recursive:true});}};
}
test('spoken proposal is immutable, blocked without explicit subscription/grant, and OCR cannot mint one',async()=>{
 const f=fixture();try{
  let p=f.proposal();assert.equal(p.status,'blocked');assert.equal(p.reason,'not_subscribed');assert.equal(p.instanceId,null);
  assert.equal(Object.isFrozen(p),true);await assert.rejects(f.scene.confirmSpokenRoute(p.eventId,p,()=>{}),{code:'spoken_route_not_ready'});
  assert.equal(f.scene.state().market.subscriptions.length,0);
  f.scene.subscribeCreature({productId});p=f.proposal('p-two');assert.equal(p.reason,'route_not_granted');
  assert.equal(f.scene.state().market.subscriptions[0].routeGranted,false);
  assert.throws(()=>f.proposal('p-vision','vision'),{code:'spoken_route_event_mismatch'});
 }finally{f.close();}
});
test('exact confirmed route commits presentation and event once; replay after restart never retargets scene',async()=>{
 let calls=0;const f=fixture({executor:input=>{calls++;return syntheticRoute(input);}});try{
  f.enable();const p=f.proposal();assert.equal(f.scene.senseEvent(p.eventId).status,'awaiting_route_confirmation');
  await assert.rejects(f.scene.confirmSpokenRoute(p.eventId,{...p,to:'B'},()=>{}),{code:'spoken_route_proposal_mismatch'});
  const result=await f.scene.confirmSpokenRoute(p.eventId,p,()=>{});
  assert.equal(result.requestStatus,'completed');assert.equal(result.eventStatus,'route_applied');assert.equal(result.replayed,false);
  assert.equal(result.state.route.receipt.receiptId,result.receiptId);assert.equal(result.state.activeCreatureId,p.instanceId);
  f.scene.selectCreature({creatureId:'companion'});f.reopen();
  const replay=await f.scene.confirmSpokenRoute(p.eventId,p,()=>{throw Error('must not execute guard for historical ack');});
  assert.equal(replay.replayed,true);assert.equal(replay.receiptId,result.receiptId);assert.equal(replay.state.activeCreatureId,'companion');assert.equal(calls,1);
 }finally{f.close();}
});
test('late source guard rejection preserves service fact without presenting success or allowing redispatch',async()=>{
 const f=fixture();try{
  f.enable();const p=f.proposal();let checks=0;
  await assert.rejects(f.scene.confirmSpokenRoute(p.eventId,p,()=>{if(++checks===2)throw Error('source revoked');}),/source revoked/);
  let q=f.scene.querySpokenRoute(p.eventId);assert.equal(q.eventStatus,'route_unconfirmed');assert.equal(q.requestStatus,'completed');assert.ok(q.receiptId);assert.equal(q.state.route,null);
  f.reopen();await assert.rejects(f.scene.confirmSpokenRoute(p.eventId,p,()=>{}),{code:'spoken_route_not_ready'});
  q=f.scene.cancelSpokenRoute(p.eventId,p);assert.equal(q.eventStatus,'route_cancelled');assert.equal(q.requestStatus,'completed');assert.ok(q.receiptId);assert.equal(q.state.route,null);
 }finally{f.close();}
});
test('scene ABA, expiry and subscription ABA during execution prevent scene commit',async()=>{
 for(const change of ['scene','expiry','subscription']){
  let release,entered;const ready=new Promise(r=>entered=r);
  const f=fixture({executor:input=>{entered();return new Promise(r=>release=()=>r(syntheticRoute(input)));}});
  try{
   f.enable();const p=f.proposal(),pending=f.scene.confirmSpokenRoute(p.eventId,p,()=>{});await ready;
   if(change==='scene'){f.scene.selectCreature({creatureId:'work'});f.scene.selectCreature({creatureId:'companion'});}
   if(change==='expiry')f.clock(201);
   if(change==='subscription'){let s=f.scene.state().market.subscriptions[0];f.scene.grantRoute({productId,enabled:false,expectedRevision:s.revision});s=f.scene.state().market.subscriptions[0];f.scene.grantRoute({productId,enabled:true,expectedRevision:s.revision});}
   release();await assert.rejects(pending);assert.equal(f.scene.state().route,null);assert.equal(f.scene.querySpokenRoute(p.eventId).eventStatus,'route_unconfirmed');
   f.clock(100);f.reopen();await assert.rejects(f.scene.confirmSpokenRoute(p.eventId,p,()=>{}),{code:'spoken_route_not_ready'});
  }finally{f.close();}
 }
});
test('cancel before dispatch writes tombstone; cancel pending excludes late receipt and repeated confirmation',async()=>{
 const f=fixture();try{
  f.enable();const p=f.proposal();assert.equal(f.scene.querySpokenRoute(p.eventId).requestStatus,'not_started');
  f.clock(201);const q=f.scene.cancelSpokenRoute(p.eventId,p);assert.equal(q.requestStatus,'cancelled');assert.equal(q.eventStatus,'route_cancelled');
  f.reopen();await assert.rejects(f.scene.confirmSpokenRoute(p.eventId,p,()=>{}),{code:'spoken_route_not_ready'});
  assert.equal(f.scene.state().route,null);
 }finally{f.close();}
 let release,entered;const ready=new Promise(r=>entered=r),g=fixture({executor:input=>{entered();return new Promise(r=>release=()=>r(syntheticRoute(input)));}});
 try{
  g.enable();const p=g.proposal(),pending=g.scene.confirmSpokenRoute(p.eventId,p,()=>{});await ready;
  await assert.rejects(g.scene.confirmSpokenRoute(p.eventId,p,()=>{}),{code:'spoken_route_not_ready'});
  assert.equal(g.scene.cancelSpokenRoute(p.eventId,p).requestStatus,'cancelled');release();await assert.rejects(pending,{code:'route_cancelled'});
  assert.equal(g.scene.querySpokenRoute(p.eventId).eventStatus,'route_cancelled');assert.equal(g.scene.state().route,null);
 }finally{g.close();}
});
test('async guards rejected before execution and expiry cannot revive after rollback',async()=>{
 const f=fixture();try{
  f.enable();let ran=false;const p=f.proposal();
  await assert.rejects(f.scene.confirmSpokenRoute(p.eventId,p,async()=>{ran=true;}),{code:'invalid_spoken_route_guard'});assert.equal(ran,false);
  const second=f.proposal('p-expire');f.clock(201);await assert.rejects(f.scene.confirmSpokenRoute(second.eventId,second,()=>{}));
  f.reopen();f.clock(100);await assert.rejects(f.scene.confirmSpokenRoute(second.eventId,second,()=>{}),{code:'spoken_route_not_ready'});
  assert.equal(f.scene.state().market.requestCount,0);
 }finally{f.close();}
});

test('query latches observed expiry across restart and clock rollback',async()=>{
 const f=fixture();try{
  f.enable();const p=f.proposal();f.clock(201);
  assert.equal(f.scene.querySpokenRoute(p.eventId).eventStatus,'expired');
  f.reopen();f.clock(100);
  assert.equal(f.scene.querySpokenRoute(p.eventId).eventStatus,'expired');
  await assert.rejects(f.scene.confirmSpokenRoute(p.eventId,p,()=>{}),{code:'spoken_route_not_ready'});
  assert.equal(f.scene.state().market.requestCount,0);
 }finally{f.close();}
});
