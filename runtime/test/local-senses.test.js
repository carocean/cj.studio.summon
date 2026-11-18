import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SceneLab} from '../src/scene.js';
import {localSenses} from '../src/local-senses.js';
import {Kernel} from '../../server/src/kernel.js';

test('persisted dynamic mapping stays distinct; restart and migration do not restore revoked legacy senses',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mapping-registry-')),scene=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'));
 let senses;
 try{
  scene.createCreature({id:'pet-one',name:'芽',kind:'pet',personality:'好奇',body:'sprout',tone:'playful'});
  senses=localSenses(scene,dir);senses.close();senses=null;
  const map=JSON.parse(readFileSync(join(dir,'sensor-map.json')));assert.equal(new Set(Object.values(map)).size,3);
  let kernel=new Kernel(join(dir,'sensor-authority.json'));
  assert.equal(kernel.getSubject('demo-sensory-owner',map['pet-one']).aibm.serviceAbilities.includes('sense.hearing'),false);
  kernel.mount('demo-sensory-owner',map.companion,'sense.hearing',false);kernel.close();
  // Existing installations lack the generation file. Migration must observe, not grant.
  // New synchronization no longer relies on a separately written generation file.
  senses=localSenses(scene,dir);senses.close();senses=null;
  kernel=new Kernel(join(dir,'sensor-authority.json'));assert.equal(kernel.getSubject('demo-sensory-owner',map.companion).aibm.serviceAbilities.includes('sense.hearing'),false);kernel.close();
  for(const enabled of [false,true])scene.creatureSense({creatureId:'companion',modality:'vision',enabled,expectedRevision:scene.state().registryRevision});
  scene.creatureSense({creatureId:'pet-one',modality:'hearing',enabled:true,expectedRevision:scene.state().registryRevision});
  senses=localSenses(scene,dir);senses.close();senses=null;
  kernel=new Kernel(join(dir,'sensor-authority.json'));
  assert.equal(kernel.getSubject('demo-sensory-owner',map['pet-one']).aibm.serviceAbilities.includes('sense.hearing'),true);
  assert.equal(kernel.getSubject('demo-sensory-owner',map['pet-one']).aibm.serviceAbilities.includes('sense.vision'),false);
  assert.equal(kernel.getSubject('demo-sensory-owner',map.companion).aibm.serviceAbilities.includes('sense.hearing'),false);kernel.close();
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'sensor-map.json'))),map);
 }finally{senses?.close();scene.close();rmSync(dir,{recursive:true});}
});
