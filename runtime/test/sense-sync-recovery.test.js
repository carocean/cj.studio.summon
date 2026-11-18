import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SceneLab} from '../src/scene.js';
import {localSenses} from '../src/local-senses.js';
import {Kernel} from '../../server/src/kernel.js';

for(const modality of ['hearing','vision'])test('failed split sync persistence must not revive independently revoked '+modality,()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-recovery-')),scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));
 try{
  scene.createCreature({id:'pet-r',name:'R',kind:'pet',personality:'test',body:'sprout',tone:'playful'});
  localSenses(scene,dir).close();const id=JSON.parse(readFileSync(join(dir,'sensor-map.json')))['pet-r'];
  scene.creatureSense({creatureId:'pet-r',modality,enabled:true,expectedRevision:scene.state().registryRevision});
  const obsolete=join(dir,'sensor-registry-generation.json.tmp');mkdirSync(obsolete);
  try{localSenses(scene,dir).close();}catch{/* old implementation fails after the grant commit */}
  rmSync(obsolete,{recursive:true});
  let k=new Kernel(join(dir,'sensor-authority.json'));k.mount('demo-sensory-owner',id,'sense.'+modality,false);k.close();
  localSenses(scene,dir).close();
  k=new Kernel(join(dir,'sensor-authority.json'));try{assert.equal(k.getSubject('demo-sensory-owner',id).aibm.serviceAbilities.includes('sense.'+modality),false);}finally{k.close();}
 }finally{scene.close();rmSync(dir,{recursive:true});}
});

for(const modality of ['hearing','vision'])test('atomic legacy write failure plus independent revoke stays denied across restart: '+modality,()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-atomic-failure-')),scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));
 try{
  scene.createCreature({id:'pet-f',name:'F',kind:'pet',personality:'test',body:'sprout',tone:'playful'});localSenses(scene,dir).close();
  const id=JSON.parse(readFileSync(join(dir,'sensor-map.json')))['pet-f'],path=join(dir,'sensor-authority.json'),backup=path+'.backup';
  scene.creatureSense({creatureId:'pet-f',modality,enabled:true,expectedRevision:scene.state().registryRevision});
  let k=new Kernel(path);renameSync(path,backup);mkdirSync(path);
  try{assert.throws(()=>k.syncRegistrySense('demo-sensory-owner',id,{modality,generation:1,enabled:true}));assert.equal(k.getSubject('demo-sensory-owner',id).registrySenseGenerations[modality],0);assert.equal(k.getSubject('demo-sensory-owner',id).aibm.serviceAbilities.includes('sense.'+modality),false);}
  finally{rmSync(path,{recursive:true});renameSync(backup,path);}
  k.mount('demo-sensory-owner',id,'sense.'+modality,false);k.close();localSenses(scene,dir).close();
  k=new Kernel(path);try{assert.equal(k.getSubject('demo-sensory-owner',id).registrySenseGenerations[modality],1);assert.equal(k.getSubject('demo-sensory-owner',id).aibm.serviceAbilities.includes('sense.'+modality),false);}
  finally{k.close();}
 }finally{scene.close();rmSync(dir,{recursive:true});}
});

for(const modality of ['hearing','vision'])test('old disabled JSON without markers remains blocked after registry-only enable: '+modality,()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-old-disabled-')),scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));
 try{
  scene.createCreature({id:'pet-old',name:'Old',kind:'pet',personality:'test',body:'sprout',tone:'playful'});localSenses(scene,dir).close();
  const id=JSON.parse(readFileSync(join(dir,'sensor-map.json')))['pet-old'],path=join(dir,'sensor-authority.json');
  const data=JSON.parse(readFileSync(path));delete data.subjects[id].registrySenseGenerations;delete data.subjects[id].independentSenseRevocations;writeFileSync(path,JSON.stringify(data),{mode:0o600});
  localSenses(scene,dir).close();
  scene.creatureSense({creatureId:'pet-old',modality,enabled:true,expectedRevision:scene.state().registryRevision});localSenses(scene,dir).close();
  let k=new Kernel(path);try{assert.equal(k.getSubject('demo-sensory-owner',id).aibm.serviceAbilities.includes('sense.'+modality),false);k.mount('demo-sensory-owner',id,'sense.'+modality,true);}finally{k.close();}
  localSenses(scene,dir).close();k=new Kernel(path);try{assert.equal(k.getSubject('demo-sensory-owner',id).aibm.serviceAbilities.includes('sense.'+modality),true);const other=modality==='hearing'?'vision':'hearing';assert.equal(k.getSubject('demo-sensory-owner',id).aibm.serviceAbilities.includes('sense.'+other),false);}finally{k.close();}
 }finally{scene.close();rmSync(dir,{recursive:true});}
});
