import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {Kernel} from '../../server/src/kernel.js';
import {PerceptionService,LocalSenseProcessor} from '../../server/src/perception.js';
import {LocalVoice} from './local-voice.js';
import {PerceptionSceneBridge} from './perception-bridge.js';

// Local single-owner demo, not production authentication/device permission.
// Registry grants gate every inference; legacy subject authority is an additional
// boundary. Sync only after an explicit registry generation change, never silently
// regrant an independently revoked legacy capability merely because of restart.
export function localSenses(scene,dir,{interactionPlanner=null,ttlMs=30000}={}){
 const ownerId='demo-sensory-owner',kernel=new Kernel(join(dir,'sensor-authority.json'));
 let service;
 try{
  const mapPath=join(dir,'sensor-map.json');
  const save=(path,value)=>{writeFileSync(path+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(path+'.tmp',path);};
  const subjects=existsSync(mapPath)?JSON.parse(readFileSync(mapPath,'utf8')):{};
  const resolveSubject=id=>{
   const creature=scene.creature(id),fresh=!Object.hasOwn(subjects,id);
   if(fresh){
    subjects[id]=kernel.createSubject(ownerId,{name:creature.name,requestId:'bridge-'+id}).id;
    save(mapPath,subjects);
   }
   const current=creature.senseGenerations??{hearing:0,vision:0};
   for(const modality of ['hearing','vision'])kernel.syncRegistrySense(ownerId,subjects[id],{modality,generation:current[modality],enabled:creature.senses[modality],initializeOnly:!fresh});
   return subjects[id];
  };
  for(const c of scene.state().creatures)resolveSubject(c.id);
  service=new PerceptionService(kernel,{processor:new LocalSenseProcessor(),scratch:join(dir,'sensor-tmp')});
  const bridge=new PerceptionSceneBridge(scene,{kernel,service,ownerId,subjects,resolveSubject,exclusiveOwner:true,interactionPlanner,ttlMs,voice:process.env.VOICE_MODEL_DIR?new LocalVoice():null});
  return {bridge,close(){bridge.close();service.close();kernel.close();}};
 }catch(error){service?.close();kernel.close();throw error;}
}
