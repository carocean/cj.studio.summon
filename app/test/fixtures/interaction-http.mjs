import {SceneLab} from '../../../runtime/src/scene.js';
import {createSceneServer} from '../../../runtime/src/scene-server.js';
import {compileInteractionProgram} from '../../../runtime/src/interaction-program.js';
import {join} from 'node:path';
const lab=new SceneLab(join(process.argv[2],'core.sqlite'),join(process.argv[2],'sink.sqlite'));
const program=compileInteractionProgram({schema:'temporary-interaction.v1',title:'任意安全结构',fields:[{id:'arbitrarySubject',label:'主题',type:'text',maxLength:20,required:true},{id:'details',label:'详情',type:'multiline',maxLength:4000,required:false},{id:'selection',label:'选择',type:'choice',required:true,options:[{value:'x',label:'方案甲'},{value:'y',label:'方案乙'}]}],save:{primitive:'local-draft.save'}});
lab.createInteraction({commandId:'host-create',sessionId:'trial-form',context:lab.captureSenseContext(),program,source:{kind:'host-declaration',referenceId:'dart-test',modelId:null}});
const server=createSceneServer(lab);server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
process.on('SIGTERM',()=>server.close(()=>{lab.close();process.exit(0);}));
