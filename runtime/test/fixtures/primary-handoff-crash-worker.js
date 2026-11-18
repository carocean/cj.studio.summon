// Test-only child: real SIGKILL after a durable protocol boundary.
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {SceneLab} from '../../src/scene.js';
const [dir,point]=process.argv.slice(2);let cancelling=false;
const cancelCase=['termination-intent','root-revoked'].includes(point);
const scene=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>100,handoffOptions:{afterStage:stage=>{
 if(cancelCase&&!cancelling&&stage==='root')throw Error('pause-for-cancel');
 if(stage===point)process.kill(process.pid,'SIGKILL');
}}});
let state=scene.perceive({modality:'hearing',signal:'account-request'});
scene.update({activityId:state.activity.id,expectedRevision:state.activity.revision,values:{customerAlias:'demo-a',accountType:'savings',contactPreference:'none'}});
state=scene.selectCreature({creatureId:'companion'});
const prepared=scene.prepareHandoff({context:state.context}).handoff;
writeFileSync(join(dir,'prepared.json'),JSON.stringify(prepared));
try{scene.confirmHandoff({handoffId:prepared.handoffId,confirmation:'share-synthetic-draft'});}catch(e){if(!cancelCase||e.message!=='pause-for-cancel')throw e;}
if(cancelCase){cancelling=true;scene.cancelHandoff({handoffId:prepared.handoffId});}
throw Error('expected SIGKILL did not occur');
