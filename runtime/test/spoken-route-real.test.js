import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SceneLab} from '../src/scene.js';
import {localSenses} from '../src/local-senses.js';
import {createSceneServer} from '../src/scene-server.js';
import {validateVoiceWav} from '../src/local-voice.js';

test('real unchanged WAV -> Paraformer -> bound finite proposal -> separate confirmation -> receipt scene -> offline spoken receipt',{skip:process.env.SPOKEN_ROUTE_REAL!=='1'},async()=>{
 assert.equal(process.env.SENSE_ASR_ENGINE,'paraformer');assert.ok(process.env.SPOKEN_ROUTE_FIXTURES);
 const dir=mkdtempSync(join(tmpdir(),'spoken-route-real-'));let scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));
 const senses=localSenses(scene,dir),server=createSceneServer(scene,{bridge:senses.bridge});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const post=async(action,body)=>{const r=await fetch(base+'/scene/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 let receiptId;
 try{
  const subscribed=(await post('market-subscribe',{productId:'demo.maps.v1'})).value,sub=subscribed.market.subscriptions[0];
  assert.equal(subscribed.primaryCreatureId,'companion');await post('market-grant',{productId:sub.productId,enabled:true,expectedRevision:sub.revision});
  let accepted;
  for(let n=1;n<=3;n++){
   const info=await(await fetch(base+'/scene/sense-capabilities')).json();assert.equal(info.context.creatureId,'companion');
   const p=await post('sense',{context:info.context,modality:'hearing',language:'zh',media:{mimeType:'audio/wav',base64:readFileSync(join(process.env.SPOKEN_ROUTE_FIXTURES,'route-command-'+n+'.wav')).toString('base64')}});
   assert.equal(p.status,200,JSON.stringify(p.value));assert.equal(p.value.result.engine,'sherpa-onnx-paraformer');assert.equal(p.value.result.realProcessing,true);assert.equal(p.value.llmUsed,false);
   if(n===2){assert.equal(p.value.result.text,'演示地图从甲站到丙站');assert.equal(p.value.event.status,'awaiting_route_confirmation');accepted=p.value;}
   else assert.equal(p.value.event.metadata.routeProposal,null,'real incorrect recognition must not be corrected into a route');
   assert.equal(scene.state().route,null);assert.equal(scene.state().market.requests.length,0);assert.equal(readdirSync(join(dir,'sensor-tmp')).length,0);
   assert.equal(readFileSync(join(dir,'sensor-authority.json'),'utf8').includes(p.value.result.text),false);
  }
  const proposal=accepted.event.metadata.routeProposal;assert.equal(proposal.from,'A');assert.equal(proposal.to,'C');assert.equal(proposal.instanceId,sub.instanceId);
  const confirm={eventId:accepted.event.eventId,context:accepted.event.frame,expectedProposal:proposal,confirmation:'request-synthetic-route'};
  assert.equal((await post('sense-route-confirm',{...confirm,expectedProposal:{...proposal,to:'B'}})).status,400);
  const done=await post('sense-route-confirm',confirm);assert.equal(done.status,200,JSON.stringify(done.value));assert.equal(done.value.requestStatus,'completed');assert.equal(done.value.state.presentation.surface,'synthetic-route');assert.equal(done.value.state.activeCreatureId,sub.instanceId);assert.deepEqual(done.value.state.route.render.nodes,['A','B','C']);receiptId=done.value.receiptId;
  const spoken=await post('route-speak',{receiptId,context:done.value.state.context});assert.equal(spoken.status,200,JSON.stringify(spoken.value));assert.equal(spoken.value.schema,'route-voice.v1');assert.equal(spoken.value.receiptId,receiptId);assert.equal(spoken.value.realProcessing,true);const audio=validateVoiceWav(Buffer.from(spoken.value.base64,'base64'));assert.equal(audio.sampleRate,44100);assert.ok(audio.durationSeconds>1);
  const replay=await post('sense-route-confirm',confirm);assert.equal(replay.value.replayed,true);assert.equal(scene.state().market.receipts.length,1);
  await post('route-visible',{receiptId,visible:false});assert.equal(scene.state().route.visible,false);
 }finally{await new Promise(r=>server.close(r));senses.close();scene.close();}
 try{scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));assert.equal(scene.state().route.receipt.receiptId,receiptId);assert.equal(scene.state().route.visible,false);assert.equal(scene.state().market.receipts.length,1);}finally{scene.close();rmSync(dir,{recursive:true});}
});
