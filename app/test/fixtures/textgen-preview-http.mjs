import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:https';
import {SceneLab} from '../../../runtime/src/scene.js';
import {createSceneServer} from '../../../runtime/src/scene-server.js';
import {createProtectedPreview} from '../../../runtime/src/protected-preview.js';
import {compileInteractionProposal} from '../../../runtime/src/interaction-proposal.js';
import {LocalInteractionPlanner} from '../../../runtime/src/local-interaction-planner.js';
const dir=process.argv[2],real=process.env.SUMMON_REAL_TEXTGEN==='1';
// Never starts a model. Real mode requires a separately supervised existing local endpoint.
if(real&&(!process.env.SUMMON_TEXTGEN_MODEL_ENDPOINT||!process.env.SUMMON_TEXTGEN_MODEL_ID))throw Error('explicit_real_model_configuration_required');
const delegate=real?new LocalInteractionPlanner({endpoint:process.env.SUMMON_TEXTGEN_MODEL_ENDPOINT,modelId:process.env.SUMMON_TEXTGEN_MODEL_ID,timeoutMs:55000}):{
 modelId:'deterministic-textgen-fixture',async generate(){return {modelId:this.modelId,proposal:compileInteractionProposal({kind:'form',title:'明确的宿主测试提案',fields:[{key:'arbitrary',label:'测试字段',type:'multiline',required:false}]})};}
};
let calls=0;
const planner={modelId:delegate.modelId,async generate(input,options){calls++;writeFileSync(join(dir,'planner-request.json'),JSON.stringify({mode:real?'real-local-adapter':'deterministic-fixture',calls,input},null,2));const result=await delegate.generate(input,options);writeFileSync(join(dir,'planner-result.json'),JSON.stringify(result,null,2));return result;}};
const lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'),{textGenerationOptions:{planner,ttlMs:real?60000:30000}});
lab.configureTextGeneration({enabled:true,expectedGeneration:0});
const upstream=createSceneServer(lab);await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
let gate;
const server=createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},(req,res)=>gate(req,res));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`https://127.0.0.1:${server.address().port}`;
gate=createProtectedPreview({origin,invitation:'synthetic-test-invitation-aaaaaaaaaaaaaaaaaaa',upstream:`http://127.0.0.1:${upstream.address().port}`,upstreamTimeoutMs:60000});
console.log(JSON.stringify({origin,dir,real}));
process.on('SIGTERM',()=>{gate.close();server.close(()=>upstream.close(()=>{lab.close();process.exit(0);}));});
