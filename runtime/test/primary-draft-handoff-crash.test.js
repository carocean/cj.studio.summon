import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {SceneLab} from '../src/scene.js';
import {SnapshotStore} from '../../microkernel/src/store.js';
const worker=fileURLToPath(new URL('./fixtures/primary-handoff-crash-worker.js',import.meta.url));
for(const point of ['confirmed','source','root','child','context','run','mail','termination-intent','root-revoked'])test('actual SIGKILL at '+point+' recovers original handoff without new IDs, grants or disclosure charges',()=>{
 const dir=mkdtempSync(join(tmpdir(),'handoff-kill-'));let scene;
 try{
  const exit=spawnSync(process.execPath,[worker,dir,point],{encoding:'utf8',timeout:10000});assert.equal(exit.signal,'SIGKILL',exit.stderr);assert.equal(exit.status,null);
  const original=JSON.parse(readFileSync(join(dir,'prepared.json'),'utf8'));
  scene=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>100});
  const list=scene.listHandoffs({});assert.equal(list.handoffs.length,1);assert.equal(list.handoffs[0].handoffId,original.handoffId);
  const cancelled=['termination-intent','root-revoked'].includes(point);
  if(cancelled){assert.equal(list.handoffs[0].status,'cancelled');assert.throws(()=>scene.confirmHandoff({handoffId:original.handoffId,confirmation:'share-synthetic-draft'}),{code:'handoff_not_ready'});}
  else{
   assert.equal(list.handoffs[0].status,point==='mail'?'delivered':'running');
   const done=scene.confirmHandoff({handoffId:original.handoffId,confirmation:'share-synthetic-draft'}).handoff;
   assert.equal(done.status,'delivered');assert.equal(done.expiresAt,original.expiresAt);assert.equal(done.receipt.retentionUntil,original.expiresAt);
   assert.deepEqual(scene.confirmHandoff({handoffId:original.handoffId,confirmation:'share-synthetic-draft'}).handoff,done);
  }
  scene.close();scene=null;
  const store=new SnapshotStore(join(dir,'core'));try{
   const p=store.get('primary-handoff.'+original.handoffId).value,root=store.get('grant.'+p.ids.root).value;
   if(cancelled){assert.equal(root.status,'revoked');assert.equal(store.get('local-mail.'+p.mailId),null);}
   else{assert.deepEqual(store.get('grant.'+p.ids.child).value.spent,p.budget);assert.deepEqual(root.allocated,p.budget);assert.equal(store.get('local-mail.'+p.mailId).value.receipt.fact,'local_recipient_copy_saved');}
  }finally{store.close();}
 }finally{scene?.close();rmSync(dir,{recursive:true,force:true});}
});
