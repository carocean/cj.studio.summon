import {spawn} from 'node:child_process';
import {readFileSync,mkdirSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createServer} from 'node:https';
import {SceneLab} from '../../../runtime/src/scene.js';
import {localSenses} from '../../../runtime/src/local-senses.js';
import {LocalVoice} from '../../../runtime/src/local-voice.js';
import {LocalDishInterpreter} from '../../../runtime/src/local-dish-interpreter.js';
import {DishHearingTurn} from '../../../runtime/src/dish-hearing.js';
import {DishConfirmationHost} from '../../../runtime/src/dish-confirmation.js';
import {createSceneServer} from '../../../runtime/src/scene-server.js';
import {createProtectedPreview} from '../../../runtime/src/protected-preview.js';
// Opt-in test only: real synthesized input/ASR/LLM, controlled narrator/player.
if(process.env.DISH_REAL_UI!=='1')throw Error('real_ui_opt_in_required');
const expressions={question:'这是什么菜？',explain:'解释一下这道菜。',negation:'不要介绍这道菜。'};
const dir=process.argv[2],caseId=process.argv[3],text=expressions[caseId];
if(!text)throw Error('unknown_fixed_case');
const began=Date.now(),lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));
let senses,confirmation,narrator,gate,server,upstream,closing=false,cleanupPromise,ttsJob,pipelineJob,modelServer,modelExit,modelProcessExit;
const inputAbort=new AbortController();
const active=()=>{if(closing)throw Error('fixture_cancelled');};
function cleanup(){
 if(cleanupPromise)return cleanupPromise;
 closing=true;inputAbort.abort();
 cleanupPromise=Promise.resolve().then(async()=>{
  try {if(confirmation)await confirmation.close();else await narrator?.close();}
  finally {
   try {
    await ttsJob?.catch(()=>{});await pipelineJob?.catch(()=>{});gate?.close();
    if(server)await new Promise(r=>server.close(r));
    if(upstream)await new Promise(r=>upstream.close(r));
    senses?.close();lab.close();
   } finally {
    if(modelServer){
     modelServer.kill('SIGTERM');const killTimer=setTimeout(()=>modelServer.kill('SIGKILL'),5000);
     try {await modelExit;} finally {clearTimeout(killTimer);}
    }
   }
  }
 });return cleanupPromise;
}
process.on('SIGTERM',()=>cleanup().then(()=>process.exit(0),()=>process.exit(1)));
try{
 if(process.env.DISH_REAL_UI_OWN_MODEL==='1'){
  if(process.env.DISH_LLM_ENDPOINT!=='http://127.0.0.1:18083/v1/chat/completions')throw Error('owned_model_endpoint_mismatch');
  const binary=process.env.DISH_REAL_UI_MODEL_BIN,weight=process.env.DISH_REAL_UI_MODEL_FILE;
  if(typeof binary!=='string'||typeof weight!=='string'||!isAbsolute(binary)||!isAbsolute(weight))throw Error('owned_model_paths_required');
  modelServer=spawn(binary,['--model',weight,'--alias',process.env.DISH_LLM_MODEL,'--host','127.0.0.1','--port','18083','--ctx-size','2048','--parallel','1','--threads','2','--threads-batch','2','--gpu-layers','0','--reasoning','off','--cors-origins','localhost','--no-webui','--no-ui-mcp-proxy'],{env:{PATH:'/usr/bin:/bin',HOME:dir,TMPDIR:dir},stdio:['ignore','ignore','pipe']});
  modelExit=new Promise(r=>modelServer.once('close',(code,signal)=>{modelProcessExit={code,signal};r(modelProcessExit);}));
  await new Promise((resolve,reject)=>{
   let tail='';const timer=setTimeout(()=>reject(Error('owned_model_startup_timeout')),120000);
   const done=error=>{clearTimeout(timer);modelServer.stderr.off('data',check);error?reject(error):resolve();};
   const check=data=>{tail=(tail+data.toString()).slice(-4096);if(tail.includes('listening on http://127.0.0.1:18083'))done();};
   modelServer.stderr.on('data',check);modelServer.once('error',done);modelExit.then(({code,signal})=>done(Error('owned_model_exited_'+(signal??code))));
  });
  modelServer.stderr.resume();active();
 }
 senses=localSenses(lab,dir,{ttlMs:60000});let asrMetadata;
 const original=senses.bridge.ingest.bind(senses.bridge);
 senses.bridge.ingest=async(...args)=>{const result=await original(...args);asrMetadata=result.event.metadata;return result;};
 let modelHealth;try{const r=await fetch(new URL('/health',process.env.DISH_LLM_ENDPOINT),{signal:AbortSignal.timeout(3000)});modelHealth={status:r.status};}catch(e){modelHealth={error:e.cause?.code??e.code??e.name};}
 const context=lab.captureSenseContext(),sessionId='meal',dishId='soup',taskId='meal-task';
 lab.installDishCatalog({schema:'synthetic-dish-catalog.v1',catalogId:'menu',items:[{dishId,name:'合成汤',description:'真实软件链确认后同一道菜的合成说明',imageRef:'synthetic-soup'}]});
 lab.createDishSession({sessionId,taskId,catalogId:'menu',context});
 const audio=Buffer.alloc(3244);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(3200,40);
 narrator=lab.createDishNarration({synthesizer:{synthesize:async()=>({audio})},player:{play:async()=>{},stop:async()=>{}}});await narrator.start({sessionId,dishId,expectedRevision:1});active();
 const model=new LocalDishInterpreter({endpoint:process.env.DISH_LLM_ENDPOINT,modelId:process.env.DISH_LLM_MODEL,timeoutMs:60000});let transcript,proposalKind,modelError;
 const interpreter={modelId:model.modelId,interpret:async(input,options)=>{transcript=input.text;try{const result=await model.interpret(input,options);proposalKind=result.proposal.kind;return result;}catch(e){modelError=e.code??'unknown';throw e;}}};
 const turn=new DishHearingTurn(lab,{bridge:senses.bridge,narrator,sessionId,interpreter});confirmation=new DishConfirmationHost(turn);
 const voiceScratch=join(dir,'voice-input');mkdirSync(voiceScratch,{mode:0o700});
 const ttsStart=Date.now();ttsJob=new LocalVoice({scratch:voiceScratch}).synthesize({text,signal:inputAbort.signal});const spoken=await ttsJob,ttsMs=Date.now()-ttsStart;active();
 const ingestStart=Date.now();pipelineJob=confirmation.ingest({expectedRevision:2,context,media:{mimeType:'audio/wav',base64:spoken.audio.toString('base64')},language:'zh'});const result=await pipelineJob,ingestMs=Date.now()-ingestStart;active();
 if(spoken.realProcessing!==true||asrMetadata?.realProcessing!==true||asrMetadata?.engine!=='vosk')throw Error('real_processing_evidence_missing');
 if(lab.readDish({sessionId}).focus.view!=='none')throw Error('unconfirmed_details_visible');
 upstream=createSceneServer(lab);await new Promise(r=>upstream.listen(0,'127.0.0.1',r));active();
 server=createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},(req,res)=>gate(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));active();
 const origin=`https://127.0.0.1:${server.address().port}`;gate=createProtectedPreview({origin,invitation:'synthetic-dish-invitation-aaaaaaaaaaaaaaaaaaaaa',upstream:`http://127.0.0.1:${upstream.address().port}`,dishConfirmation:confirmation});
 console.log(JSON.stringify({origin,sessionId,dishId,taskId,synthetic:true,asr:'real-vosk',model:'real-local-llm',player:'controlled-fixture',caseId,modelHealth,modelServerMode:modelServer?'fixture-owned-after-flutter-start':'external-supervisor',utterance:text,transcript,proposalKind:proposalKind??null,modelError:modelError??null,resultState:result.state,ttsEngine:spoken.engine,ttsModel:spoken.model,asrEngine:asrMetadata.engine,asrModel:asrMetadata.model,modelLabel:model.modelId,timings:{ttsMs,ingestMs,totalToReadyMs:Date.now()-began},microphone:false,physicalPlayback:false,confirmation:'flutter-test-tap'}));

}catch(error){console.log(JSON.stringify({caseId,fixtureFatal:'fixture_setup_failed',modelProcessExit:modelProcessExit??null}));await cleanup();throw error;}
