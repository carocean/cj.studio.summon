import {DishHearingTurn} from '../../../runtime/src/dish-hearing.js';
import {localSenses} from '../../../runtime/src/local-senses.js';
import {LocalVoice} from '../../../runtime/src/local-voice.js';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:https';
import {SceneLab} from '../../../runtime/src/scene.js';
import {createSceneServer} from '../../../runtime/src/scene-server.js';
import {createProtectedPreview} from '../../../runtime/src/protected-preview.js';

// Deterministic synthetic host only: no microphone, audio playback or model.
// The explicit host stop acknowledgement below is a protocol fixture, NOT
// evidence that real audio was played, interrupted or physically stopped.
const dir=process.argv[2];
const lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));
const sessionId='synthetic-meal',taskId='synthetic-meal-task',dishId='soup';
const context=lab.captureSenseContext();
lab.installDishCatalog({schema:'synthetic-dish-catalog.v1',catalogId:'synthetic-menu',items:[
 {dishId,name:'合成汤',description:'仅用于合成链路验收的菜品说明',imageRef:'synthetic-soup'},
]});
lab.createDishSession({sessionId,taskId,catalogId:'synthetic-menu',context});
// Controlled PCM fixture and player: no physical speaker or user audio.
const audio=Buffer.alloc(3244);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(3200,40);
const narrator=lab.createDishNarration({synthesizer:{synthesize:async()=>({audio})},player:{play:async()=>{},stop:async()=>{}}});
await narrator.start({sessionId,dishId,expectedRevision:1});
let view,hearingEvidence=null;
if(process.env.DISH_REAL_ASR==='1'){
 const senses=localSenses(lab,dir),turn=new DishHearingTurn(lab,{bridge:senses.bridge,narrator,sessionId});
 try{
  const spoken=await new LocalVoice().synthesize({text:'这是什么菜？'});
  const result=await turn.ingestAndExplain({expectedRevision:2,context,media:{mimeType:'audio/wav',base64:spoken.audio.toString('base64')},language:'zh'});
  if(result.status!=='presented')throw Error('dish_asr_intent_not_recognized');
  view=result.view;hearingEvidence={transcript:result.transcript,understanding:result.understanding,llmUsed:result.llmUsed,source:'synthetic-user-speech-real-offline-asr'};
 }finally{await turn.close();senses.close();}
}else{view=await narrator.requestExplanation({sessionId,expectedRevision:2});await narrator.close();}

const upstream=createSceneServer(lab);
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
let gate;
const server=createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},(req,res)=>gate(req,res));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`https://127.0.0.1:${server.address().port}`;
gate=createProtectedPreview({origin,invitation:'synthetic-dish-invitation-aaaaaaaaaaaaaaaaaaaaa',upstream:`http://127.0.0.1:${upstream.address().port}`});
console.log(JSON.stringify({origin,sessionId,taskId,dishId,context,revision:view.revision,synthetic:true,hearingEvidence}));
process.on('SIGTERM',()=>{gate.close();server.close(()=>upstream.close(()=>{lab.close();process.exit(0);}));});
