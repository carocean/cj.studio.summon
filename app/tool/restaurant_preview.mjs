import {readFileSync,mkdtempSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:https';
import {createServer as createHttpServer} from 'node:http';
import {SceneLab} from '../../runtime/src/scene.js';
import {Kernel} from '../../server/src/kernel.js';
import {PerceptionService} from '../../server/src/perception.js';
import {PerceptionSceneBridge} from '../../runtime/src/perception-bridge.js';
import {localSenses} from '../../runtime/src/local-senses.js';
import {LocalVoice} from '../../runtime/src/local-voice.js';
import {LocalDishInterpreter} from '../../runtime/src/local-dish-interpreter.js';
import {compileDishSemanticProposal} from '../../runtime/src/dish-semantics.js';
import {DishHearingTurn} from '../../runtime/src/dish-hearing.js';
import {DishConfirmationHost} from '../../runtime/src/dish-confirmation.js';
import {createProtectedPreview} from '../../runtime/src/protected-preview.js';
import {collectPreviewAssets} from '../../runtime/src/preview-assets.js';
import {PREVIEW_RENDER_KIND} from '../../runtime/src/preview-render-profile.js';

// Developer-only, single prepared utterance. No microphone, physical playback,
// remote hosting, client ingest, implicit confirmation, or certificate installation.
export function restaurantConfig(env=process.env){
 if(env.RESTAURANT_PREVIEW!=='1')throw Error('restaurant_preview_opt_in_required');
 const mode=env.RESTAURANT_MODE??'controlled';
 if(!['controlled','real'].includes(mode))throw Error('invalid_restaurant_mode');
 const port=Number(env.RESTAURANT_PORT??'8443');
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('invalid_restaurant_port');
 const paths={};for(const key of ['SITE','TLS_KEY','TLS_CERT','INVITATION_FILE']){
  const value=env['RESTAURANT_'+key];if(!value)throw Error('restaurant_'+key.toLowerCase()+'_required');paths[key]=resolve(value);
 }
 return {mode,port,...paths};
}
function privateText(path){
 const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.size>4096)throw Error('private_invitation_file_required');
 const value=readFileSync(path,'utf8').trim();if(!/^[A-Za-z0-9_-]{43,128}$/.test(value))throw Error('invalid_invitation');return value;
}
function wav(){const b=Buffer.alloc(3244);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);return b;}
export async function startRestaurantPreview(config,{onReady=()=>{}}={}){
 const {assets}=collectPreviewAssets(config.SITE),invitation=privateText(config.INVITATION_FILE);
 const tls={key:readFileSync(config.TLS_KEY),cert:readFileSync(config.TLS_CERT)};
 const dir=mkdtempSync(join(tmpdir(),'summon-restaurant-')),lab=new SceneLab(join(dir,'core'),join(dir,'sink'));
 const abort=new AbortController();let senses,narrator,host,gate,server,upstream,voiceJob,pipelineJob,closePromise,closing=false;
 const sockets=new Map();
 const track=listener=>{const connected=new Set();sockets.set(listener,connected);listener.on('connection',socket=>{connected.add(socket);socket.once('close',()=>connected.delete(socket));});return listener;};
 const stopServer=listener=>new Promise(resolve=>{listener.close(resolve);for(const socket of sockets.get(listener)??[])socket.destroy();});
 let asrMetadata=null,transcript=null,proposalKind=null,modelError=null,ttsEvidence=null;
 function close(){
  if(closePromise)return closePromise;closing=true;
  closePromise=Promise.resolve().then(async()=>{
   abort.abort();
   try{if(host)await host.close();else await narrator?.close();}
   finally{await voiceJob?.catch(()=>{});await pipelineJob?.catch(()=>{});gate?.close();
    if(server)await stopServer(server);if(upstream)await stopServer(upstream);
    senses?.close();lab.close();rmSync(dir,{recursive:true,force:true});
    process.off('SIGTERM',signal);process.off('SIGINT',signal);
   }
  });return closePromise;
 }
 const signal=()=>{close().catch(()=>{process.exitCode=1;});};
 process.on('SIGTERM',signal);process.on('SIGINT',signal);
 const active=()=>{if(closing)throw Error('restaurant_cancelled');};
 try{
  if(config.mode==='real')senses=localSenses(lab,dir,{ttlMs:60000});
  else{
   const kernel=new Kernel(join(dir,'legacy')),subjects={};
   for(const id of ['companion','work']){subjects[id]=kernel.createSubject('test',{name:id}).id;kernel.mount('test',subjects[id],'sense.hearing');}
   const service=new PerceptionService(kernel,{processor:{capabilities:async()=>({hearing:{available:true,language:'zh'}}),process:async()=>({text:'这是什么菜',engine:'controlled-fixture',model:'not-real-ASR',realProcessing:true}),cancel(){}}});
   const bridge=new PerceptionSceneBridge(lab,{kernel,service,subjects,ownerId:'test',exclusiveOwner:true,ttlMs:60000});
   senses={bridge,close(){bridge.close();service.close();kernel.close();}};
  }
  const originalIngest=senses.bridge.ingest.bind(senses.bridge);
  senses.bridge.ingest=async(...args)=>{const result=await originalIngest(...args);asrMetadata=result.event.metadata;return result;};
  const sessionId='meal',context=lab.captureSenseContext();
  lab.installDishCatalog({schema:'synthetic-dish-catalog.v1',catalogId:'menu',items:[{dishId:'soup',name:'合成汤',description:'本地餐厅演示：这是一份合成汤的说明，不是真实菜单。',imageRef:'synthetic-soup'}]});
  lab.createDishSession({sessionId,taskId:'meal-task',catalogId:'menu',context});
  narrator=lab.createDishNarration({synthesizer:{synthesize:async()=>({audio:wav()})},player:{play:async()=>{},stop:async()=>{}}});
  await narrator.start({sessionId,dishId:'soup',expectedRevision:1});active();
  const engine=config.mode==='real'?new LocalDishInterpreter({endpoint:process.env.DISH_LLM_ENDPOINT,modelId:process.env.DISH_LLM_MODEL,timeoutMs:60000}):{modelId:'controlled-not-real',interpret:async()=>({modelId:'controlled-not-real',proposal:compileDishSemanticProposal({kind:'explain',target:'current-dish'})})};
  const interpreter={modelId:engine.modelId,interpret:async(input,options)=>{transcript=input.text;try{const result=await engine.interpret(input,options);proposalKind=result.proposal.kind;return result;}catch(error){modelError=error.code??'model_unavailable';throw error;}}};
  host=new DishConfirmationHost(new DishHearingTurn(lab,{bridge:senses.bridge,narrator,sessionId,interpreter}));
  let audio=wav();if(config.mode==='real'){voiceJob=new LocalVoice({scratch:dir}).synthesize({text:'这是什么菜？',signal:abort.signal});const spoken=await voiceJob;audio=spoken.audio;ttsEvidence={engine:spoken.engine,model:spoken.model,realProcessing:spoken.realProcessing};active();}
  pipelineJob=host.ingest({expectedRevision:2,context,media:{mimeType:'audio/wav',base64:audio.toString('base64')},language:'zh'});
  const proposal=await pipelineJob;active();
  if(lab.readDish({sessionId}).focus.view!=='none')throw Error('unexpected_unconfirmed_details');
  upstream=track(createHttpServer());await new Promise((r,j)=>{upstream.once('error',j);upstream.listen(0,'127.0.0.1',r);});active();
  // Only these precise existing routes are reachable from this developer entry.
  // In particular no general scene mutation, host ingest/stop, or chosen session.
  server=createServer(tls,(req,res)=>{
   const allowed=req.method==='GET'?(!req.url.startsWith('/scene/')||['/scene/state','/scene/usage'].includes(req.url)):['/preview/login','/preview/logout','/scene/dish-read','/scene/dish-confirmation-read','/scene/dish-confirmation-respond','/scene/dish-confirmation-invalidate'].includes(req.url);
   if(!allowed){res.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"endpoint_denied"}');return;}
   if(!gate){res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"preview_starting"}');return;}
   gate(req,res);
  });
  track(server);
  // Fixed-session enforcement occurs at the trusted loopback upstream boundary.
  upstream.on('request',(req,res)=>{
   if(req.method==='GET'&&['/scene/state','/scene/usage'].includes(req.url)){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/scene/state'?lab.state():lab.usage()));return;}
   if(req.method!=='POST'||req.url!=='/scene/dish-read'){res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"endpoint_denied"}');return;}
   // No alternate session can exist in this ephemeral host; still validate the
   // request explicitly rather than accepting a client-chosen session selector.
   let raw='';req.on('data',b=>{raw+=b;if(raw.length>4096)req.destroy();});req.on('end',()=>{
    try{const body=JSON.parse(raw);if(Object.keys(body).length!==1||body.sessionId!=='meal')throw Error();
     res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(lab.readDish({sessionId:'meal'})));
    }catch{res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"invalid_fixed_session"}');}
   });
  });
  await new Promise((r,j)=>{server.once('error',j);server.listen(config.port,'127.0.0.1',r);});active();
  const origin=`https://127.0.0.1:${server.address().port}`;
  gate=createProtectedPreview({origin,invitation,upstream:`http://127.0.0.1:${upstream.address().port}`,assets,renderProfile:{kind:PREVIEW_RENDER_KIND},dishConfirmation:host});
  const ready={origin,login:origin+'/preview/login',sessionId,creatureId:context.creatureId,sceneRevision:context.sceneRevision,mode:config.mode,preparedState:proposal.state,expiresAt:proposal.expiresAt,syntheticInput:true,controlledPlayer:true,microphone:false,realUserConfirmationRequired:true,evidence:{tts:ttsEvidence,asr:asrMetadata?{engine:asrMetadata.engine,model:asrMetadata.model,realProcessing:asrMetadata.realProcessing}:null,model:engine.modelId,transcript,proposalKind,modelError}};
  onReady(ready);return {ready,close};
 }catch(error){await close();throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await startRestaurantPreview(restaurantConfig(),{onReady:value=>console.log(JSON.stringify(value))});}
 catch(error){console.error(error.code??error.message);process.exitCode=1;}
}
