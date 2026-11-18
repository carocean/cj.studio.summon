import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SceneLab} from '../src/scene.js';
import {createSceneServer} from '../src/scene-server.js';
const productId='demo.maps.v1';
function fixture(marketOptions={}){const dir=mkdtempSync(join(tmpdir(),'market-scene-'));let lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'),{marketOptions});return {get lab(){return lab;},reopen(){lab.close();lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));},done(){lab.close();rmSync(dir,{recursive:true});}};}
function entitled(lab){const s=lab.subscribeCreature({productId}),sub=s.market.subscriptions[0];lab.grantRoute({productId,enabled:true,expectedRevision:sub.revision});return {productId,instanceId:sub.instanceId,from:'A',to:'C',requestId:'route-test'};}

test('HTTP discovery -> subscription -> separate route grant -> receipt -> generated route surface; hide/restart preserves fact',async()=>{
 const f=fixture(),server=createSceneServer(f.lab);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(action,body)=>{const r=await fetch(base+'/scene/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});return {status:r.status,state:await r.json()};};
 try{
 const discovered=await(await fetch(base+'/scene/state')).json();assert.equal(discovered.market.catalog[0].providerId,'demo-maps');assert.equal(discovered.route,null);
 const s=(await post('market-subscribe',{productId})).state,sub=s.market.subscriptions[0];assert.equal(s.primaryCreatureId,'companion');assert.equal(s.activeCreatureId,'companion');assert.deepEqual(s.creatures.find(c=>c.id===sub.instanceId).senses,{hearing:false,vision:false});
 const input={productId,instanceId:sub.instanceId,from:'A',to:'C',requestId:'http-route'};
 assert.equal((await post('market-route',input)).status,400);assert.equal(f.lab.state().route,null);
 await post('market-grant',{productId,enabled:true,expectedRevision:sub.revision});
 assert.equal((await post('market-route',{...input,productId:'google.maps'})).status,400);assert.equal(f.lab.state().route,null);
 const result=await post('market-route',input);assert.equal(result.status,200);assert.equal(result.state.activeCreatureId,sub.instanceId);assert.equal(result.state.presentation.surface,'synthetic-route');assert.deepEqual(result.state.route.render.nodes,['A','B','C']);
 const receiptId=result.state.route.receipt.receiptId;
 assert.equal(result.state.route.render.receiptId,receiptId);assert.equal(result.state.route.receipt.requestId,input.requestId);
 const replay=await post('market-route',input);assert.equal(replay.state.route.replayed,true);assert.equal(replay.state.market.receipts.length,1);
 await post('route-visible',{receiptId,visible:false});assert.equal(f.lab.state().presentation.surface,'route-summary');
 assert.equal((await post('route-visible',{receiptId:'not-your-receipt',visible:true})).status,400);
 }finally{await new Promise(r=>server.close(r));f.reopen();assert.equal(f.lab.state().route.visible,false);assert.equal(f.lab.state().market.receipts.length,1);f.done();}
});

test('context switch during pure route computation stores receipt but cannot replace the new scene',async()=>{
 let entered,release;const started=new Promise(r=>entered=r);const f=fixture({executor:()=>{entered();return new Promise(r=>release=r);}});
 try{const input=entitled(f.lab),pending=f.lab.requestRoute(input);await started;f.lab.selectCreature({creatureId:'work'});release({path:['A','B','C'],hops:2});await assert.rejects(pending,{code:'sensory_context_changed'});assert.equal(f.lab.state().activeCreatureId,'work');assert.equal(f.lab.state().route,null);assert.equal(f.lab.state().market.receipts.length,1);
 const restored=await f.lab.requestRoute(input);assert.equal(restored.route.replayed,true);assert.equal(restored.route.receipt.instanceId,input.instanceId);
 }finally{f.done();}
});

test('bad service output and route revocation cannot generate a route surface',async()=>{
 const f=fixture({executor:async()=>({path:['A','C'],hops:1})});try{const input=entitled(f.lab);await assert.rejects(f.lab.requestRoute(input),{code:'invalid_route_result'});assert.equal(f.lab.state().route,null);assert.equal(f.lab.state().market.receipts.length,0);}finally{f.done();}
 let release,entered;const ready=new Promise(r=>entered=r);const g=fixture({executor:()=>{entered();return new Promise(r=>release=r);}});
 try{const input=entitled(g.lab),pending=g.lab.requestRoute(input);await ready;const sub=g.lab.state().market.subscriptions[0];g.lab.grantRoute({productId,enabled:false,expectedRevision:sub.revision});release({path:['A','B','C'],hops:2});await assert.rejects(pending);assert.equal(g.lab.state().route,null);assert.equal(g.lab.state().market.receipts.length,0);}finally{g.done();}
});

test('HTTP cancel records an unseen request and blocks a delayed route without fake completion',async()=>{
 let calls=0;const f=fixture({executor:async()=>{calls++;return {path:['A','B','C'],hops:2};}}),server=createSceneServer(f.lab);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(action,body)=>{const r=await fetch(base+'/scene/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 try{const input=entitled(f.lab);const cancelled=await post('market-cancel',{requestId:input.requestId});assert.equal(cancelled.status,200);assert.deepEqual(cancelled.value.market.requests,[{requestId:input.requestId,status:'cancelled'}]);const late=await post('market-route',input);assert.equal(late.value.error,'route_cancelled');assert.equal(calls,0);assert.equal(f.lab.state().route,null);
 const next=await post('market-route',{...input,requestId:'new-explicit-request'});assert.equal(next.status,200);assert.equal(calls,1);const receipt=next.value.route.receipt.receiptId;
 const kept=await post('market-cancel',{requestId:'new-explicit-request'});assert.equal(kept.value.market.requests[1].status,'completed');assert.equal(kept.value.route.receipt.receiptId,receipt);
 }finally{await new Promise(r=>server.close(r));f.reopen();assert.equal(f.lab.state().market.requests[0].status,'cancelled');assert.equal(f.lab.state().market.requests[1].status,'completed');f.done();}
});
