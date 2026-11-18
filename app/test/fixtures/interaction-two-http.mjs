import {SceneLab} from '../../../runtime/src/scene.js';
import {createSceneServer} from '../../../runtime/src/scene-server.js';
import {compileInteractionProgram} from '../../../runtime/src/interaction-program.js';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
// Trusted fixture declarations, not a model invocation or HTTP create route.
const lab=new SceneLab(join(process.argv[2],'core.sqlite'),join(process.argv[2],'sink.sqlite'));
const program=compileInteractionProgram({schema:'temporary-interaction.v1',title:'双稿宿主测试',fields:[{id:'contents',label:'内容',type:'multiline',maxLength:4000,required:false}],save:{primitive:'local-draft.save'}});
function create(sessionId){lab.createInteraction({commandId:'host-'+sessionId,sessionId,context:lab.captureSenseContext(),program,source:{kind:'host-declaration',referenceId:'dual-draft-fixture',modelId:null}});}
create('first-draft');
const server=createSceneServer(lab);server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
const input=createInterface({input:process.stdin});input.on('line',line=>{if(line==='next'){create('second-draft');console.log('second-created');}});
process.on('SIGTERM',()=>server.close(()=>{input.close();lab.close();process.exit(0);}));
