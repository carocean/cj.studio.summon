import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {SceneLab} from './scene.js';
import {localSenses} from './local-senses.js';
export function createSceneServer(lab,{bridge=null}={}){
 return createServer(async(req,res)=>{
  const voiced=value=>value?.mode==='deterministic-synthetic'?{...value,voiceAvailable:bridge?.voiceAvailable?.()??false}:value;
  const reply=(status,body)=>{body=voiced(body);if(body?.state)body={...body,state:voiced(body.state)};res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  // Local demo only. No cookies, remote hosts, arbitrary origins or wildcard CORS.
  if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host??''))return reply(403,{error:'loopback_only'});
  const origin=req.headers.origin;
  if(origin){let u;try{u=new URL(origin);}catch{return reply(403,{error:'origin_denied'});}
   if(!['localhost','127.0.0.1'].includes(u.hostname)||u.protocol!=='http:'||u.origin!==origin)return reply(403,{error:'origin_denied'});
   res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
  }
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Summon-Lab');res.writeHead(204);return res.end();}
  try{
   if(req.method==='GET'&&req.url==='/scene/reading-state')return reply(200,lab.readingState());
   if(req.method==='GET'&&req.url==='/scene/textgen-state')return reply(200,lab.textGenerationState());
   if(req.method==='GET'&&req.url==='/scene/usage')return reply(200,lab.usage());
   if(req.method==='GET'&&req.url==='/scene/interaction-current')return reply(200,lab.currentInteraction());
   if(req.method==='GET'&&req.url==='/scene/state')return reply(200,lab.state());
   if(req.method==='GET'&&req.url==='/scene/sense-capabilities')return reply(bridge?200:503,bridge?await bridge.capabilities():{error:'sensory_bridge_unavailable'});
   if(req.method!=='POST')return reply(404,{error:'not_found'});
   if(req.headers['x-summon-lab']!=='synthetic'||req.headers['content-type']?.split(';')[0]!=='application/json')return reply(403,{error:'synthetic_header_required'});
   const limit=req.url==='/scene/sense'?6*1024*1024:req.url==='/scene/interaction-edit'?128*1024:req.url==='/scene/textgen-generate'?64*1024:4096;
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>limit){reply(413,{error:'request_too_large'});return;}chunks.push(chunk);}
   let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}catch{return reply(400,{error:'invalid_json'});}
   // Disconnect is an unknown reply, not an explicit generation cancellation.
   if(req.url==='/scene/textgen-generate')return reply(200,await lab.generateTextInteraction(input));
   if(req.url==='/scene/interaction-generate'){
    if(!bridge)return reply(503,{error:'sensory_bridge_unavailable'});
    const abort=new AbortController(),disconnect=()=>{if(!res.writableEnded)abort.abort();};res.on('close',disconnect);if(res.destroyed)abort.abort();
    try{return reply(200,await bridge.generateInteraction(input,{signal:abort.signal}));}finally{res.off('close',disconnect);}
   }
   if(req.url==='/scene/sense'||req.url==='/scene/sense-confirm'||req.url==='/scene/speak'||req.url==='/scene/route-speak'||['/scene/sense-route-confirm','/scene/sense-route-status','/scene/sense-route-cancel'].includes(req.url)){
    if(!bridge)return reply(503,{error:'sensory_bridge_unavailable'});
    if(req.url==='/scene/sense-route-confirm')return reply(200,await bridge.confirmRoute(input));
    if(req.url==='/scene/sense-route-status')return reply(200,bridge.queryRoute(input));
    if(req.url==='/scene/sense-route-cancel')return reply(200,bridge.cancelRoute(input));
    if(req.url==='/scene/route-speak')return reply(200,await bridge.speakRoute(input));
    if(req.url==='/scene/speak')return reply(200,await bridge.speak(input));
    if(req.url==='/scene/sense')return reply(200,await bridge.ingest(input));
    if(!input||typeof input.eventId!=='string')return reply(400,{error:'invalid_shape'});
    const {eventId,...confirmation}=input;return reply(200,bridge.confirm(eventId,confirmation));
   }
   if(req.url==='/scene/market-route')return reply(200,await lab.requestRoute(input));
   if(req.url==='/scene/form-route')return reply(200,await lab.routeChoiceForm(input));
   const routes={'/scene/dish-read':()=>lab.readDish(input),'/scene/dish-command':()=>lab.commandDish(input),'/scene/reading-open':()=>lab.openReading(input),'/scene/reading-read':()=>lab.readReading(input),'/scene/reading-query':()=>lab.queryReading(input),'/scene/reading-close':()=>lab.closeReading(input),'/scene/textgen-query':()=>lab.queryTextGeneration(input),'/scene/textgen-cancel':()=>lab.cancelTextGeneration(input),'/scene/usage-select':()=>lab.selectCreatureWithUsage(input),'/scene/usage-presented':()=>lab.reportInteractionPresented(input),'/scene/usage-query':()=>lab.queryUsage(input),'/scene/interaction-read':()=>lab.readInteraction(input),'/scene/interaction-edit':()=>lab.editInteraction(input),'/scene/interaction-save':()=>lab.saveInteraction(input),'/scene/interaction-query':()=>lab.queryInteraction(input),'/scene/interaction-close':()=>lab.closeInteraction(input),'/scene/interaction-saved':()=>lab.readSavedInteraction(input),'/scene/handoff-prepare':()=>lab.prepareHandoff(input),'/scene/handoff-confirm':()=>lab.confirmHandoff(input),'/scene/handoff-status':()=>lab.queryHandoff(input),'/scene/handoff-cancel':()=>lab.cancelHandoff(input),'/scene/handoff-list':()=>lab.listHandoffs(input),'/scene/text-entry':()=>lab.textEntry(input),'/scene/text-request':()=>lab.textRequest(input),'/scene/focus-status':()=>lab.queryFocus(input),'/scene/focus-grant':()=>lab.grantFocus(input),'/scene/focus-cancel':()=>lab.cancelFocus(input),'/scene/form-focus':()=>lab.createFocusForm(input),'/scene/form-update':()=>lab.updateChoiceForm(input),'/scene/market-cancel':()=>lab.cancelRouteRequest(input),'/scene/market-subscribe':()=>lab.subscribeCreature(input),'/scene/market-grant':()=>lab.grantRoute(input),'/scene/market-unsubscribe':()=>lab.unsubscribeCreature(input),'/scene/route-visible':()=>lab.routeVisibility(input),'/scene/creature-select':()=>lab.selectCreature(input),'/scene/creature-primary':()=>lab.primaryCreature(input),'/scene/creature-create':()=>lab.createCreature(input),'/scene/creature-sense':()=>lab.creatureSense(input),'/scene/perceive':()=>lab.perceive(input),'/scene/update':()=>lab.update(input),'/scene/submit':()=>lab.submit(input),'/scene/new':()=>lab.newTask(input),'/scene/cancel':()=>lab.cancel(input),'/scene/hide':()=>lab.visibility(false,input),'/scene/show':()=>lab.visibility(true,input)};
   if(!routes[req.url])return reply(404,{error:'not_found'});
   return reply(200,routes[req.url]());
  }catch(error){return reply(['stale_dish_focus','revision_conflict','activity_conflict','form_binding_conflict','interaction_revision_conflict'].includes(error.code)?409:400,{error:error.code??'request_failed'});}
 });
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 const dir=resolve(process.env.SUMMON_SCENE_DATA??'.scene-lab');mkdirSync(dir,{recursive:true,mode:0o700});
 const lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));
 const senses=localSenses(lab,dir);
 const server=createSceneServer(lab,{bridge:senses.bridge});server.listen(8091,'127.0.0.1',()=>console.log('Synthetic scene lab: http://127.0.0.1:8091 (local ASR/OCR when configured; no LLM, real banking, or verified device capture)'));
 for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{senses.bridge.close();server.close(()=>{senses.close();lab.close();process.exit(0);});});
}
