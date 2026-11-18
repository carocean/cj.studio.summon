// Test-only failure injection at the HTTP response boundary. Never imported by runtime.
import {join} from 'node:path';
import {SceneLab} from '../../src/scene.js';
import {createSceneServer} from '../../src/scene-server.js';
const lab=new SceneLab(join(process.env.CRASH_DATA,'core.sqlite'),join(process.env.CRASH_DATA,'sink.sqlite'),{clock:()=>100});
const server=createSceneServer(lab);
server.prependListener('request',(req,res)=>{
 if(req.url!==process.env.PAUSE_PATH)return;
 // Scene mutation and its view are already complete when reply calls end().
 // Suppress all response bytes, leaving a real caller uncertain, then SIGKILL.
 res.end=body=>{process.send({type:'durable',status:res.statusCode,body:JSON.parse(body)});return res;};
});
server.listen(0,'127.0.0.1',()=>process.send({type:'ready',port:server.address().port}));
