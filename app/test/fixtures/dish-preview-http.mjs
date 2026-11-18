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
let view=lab.readDish({sessionId});
const command=(kind,extra={})=>{view=lab.commandDish({sessionId,command:{kind,expectedRevision:view.focus.revision,...extra}});};
command('speak',{dishId});
command('interrupt',{speechSequence:view.focus.speech.sequence});
lab.confirmDishStopped({sessionId,expectedRevision:view.focus.revision,speechSequence:view.focus.speech.sequence});
view=lab.readDish({sessionId});
command('details');
const upstream=createSceneServer(lab);
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
let gate;
const server=createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},(req,res)=>gate(req,res));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`https://127.0.0.1:${server.address().port}`;
gate=createProtectedPreview({origin,invitation:'synthetic-dish-invitation-aaaaaaaaaaaaaaaaaaaaa',upstream:`http://127.0.0.1:${upstream.address().port}`});
console.log(JSON.stringify({origin,sessionId,taskId,dishId,context,revision:view.revision,synthetic:true}));
process.on('SIGTERM',()=>{gate.close();server.close(()=>upstream.close(()=>{lab.close();process.exit(0);}));});
