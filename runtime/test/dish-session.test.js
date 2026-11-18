import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostIdentity} from '../../microkernel/src/identity.js';
import {SnapshotStore} from '../../microkernel/src/store.js';
import {DishSession} from '../src/dish-session.js';
const catalog={schema:'synthetic-dish-catalog.v1',catalogId:'menu',items:[{dishId:'soup',name:'合成汤',description:'演示说明',imageRef:'demo-soup'}]};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'dish-session-'));const auth=new HostIdentity(),admin=auth.authenticate('host'),alice=auth.authenticate('alice'),bob=auth.authenticate('bob');
 let context={creatureId:'work',sceneRevision:1},store=new SnapshotStore(join(dir,'core')),callback=()=>context;
 const make=()=>new DishSession(store,auth,{administratorHandle:admin,currentContext:h=>callback(h)});let host=make();host.installCatalog(admin,catalog);
 return {auth,admin,alice,bob,get host(){return host;},get context(){return context;},change(c){context=c;},callback(f){callback=f;},create(handle=alice){return host.create(handle,{sessionId:'meal',taskId:'task-1',catalogId:'menu',context});},step(s,kind,extra={}){return host.command(alice,{sessionId:'meal',command:{kind,expectedRevision:s.focus.revision,...extra}});},restart(){store.close();store=new SnapshotStore(join(dir,'core'));host=make();host.installCatalog(admin,catalog);},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('real kernel identity and SQLite CAS preserve same-dish presentation after trusted stop confirmation',()=>{
 const f=fixture();try{let s=f.create();s=f.step(s,'speak',{dishId:'soup'});s=f.step(s,'interrupt',{speechSequence:1});
  assert.throws(()=>f.step(s,'image'),{code:'dish_playback_not_stopped'});
  assert.throws(()=>f.step(s,'stopped',{speechSequence:1}),{code:'dish_host_authority_required'});
  s=f.host.confirmStopped(f.admin,f.alice,{sessionId:'meal',expectedRevision:s.focus.revision,speechSequence:1});s=f.step(s,'details');s=f.step(s,'image');s=f.step(s,'zoom',{direction:'in'});
  const v=f.host.read(f.alice,{sessionId:'meal'});assert.equal(v.focus.dishId,'soup');assert.equal(v.focus.taskId,'task-1');assert.equal(v.focus.zoomPermille,1250);assert.equal(v.revision,v.focus.revision);
 }finally{f.close();}
});
test('owner isolation, forged handles and revoked credentials fail',()=>{
 const f=fixture();try{f.create();assert.throws(()=>f.host.read(f.bob,{sessionId:'meal'}),{code:'dish_session_not_found'});f.create(f.bob);
  assert.throws(()=>f.host.read(new HostIdentity().authenticate('alice'),{sessionId:'meal'}),{code:'unauthenticated'});
  assert.throws(()=>f.host.installCatalog(f.alice,catalog),{code:'dish_host_authority_required'});
  f.auth.revoke('alice');assert.throws(()=>f.host.read(f.alice,{sessionId:'meal'}),{code:'unauthenticated'});
 }finally{f.close();}
});
test('stale revisions, stale stop sequence, fake administrator and modified catalogs do not commit',()=>{
 const f=fixture();try{const original=f.create();let s=f.step(original,'speak',{dishId:'soup'});assert.throws(()=>f.step(original,'speak',{dishId:'soup'}),{code:'stale_dish_focus'});s=f.step(s,'interrupt',{speechSequence:1});
  assert.throws(()=>f.host.confirmStopped(f.alice,f.alice,{sessionId:'meal',expectedRevision:3,speechSequence:1}),{code:'dish_host_authority_required'});
  assert.throws(()=>f.host.confirmStopped(f.admin,f.alice,{sessionId:'meal',expectedRevision:3,speechSequence:2}),{code:'stale_dish_speech'});
  assert.equal(f.host.read(f.alice,{sessionId:'meal'}).revision,3);
  assert.throws(()=>f.host.installCatalog(f.admin,{...catalog,items:[{...catalog.items[0],imageRef:'other'}]}),{code:'dish_catalog_immutable'});
 }finally{f.close();}
});
test('observed context changes latch closed even if trusted context later rolls back',()=>{
 const f=fixture();try{const old=f.context;f.create();f.change({...old,sceneRevision:2});assert.throws(()=>f.host.read(f.alice,{sessionId:'meal'}),{code:'dish_context_changed'});f.change(old);assert.throws(()=>f.host.read(f.alice,{sessionId:'meal'}),{code:'dish_context_changed'});
 }finally{f.close();}
});
test('restart cannot resume persisted playback or accept a late stop from the previous host epoch',()=>{
 const f=fixture();try{let s=f.create();s=f.step(s,'speak',{dishId:'soup'});s=f.step(s,'interrupt',{speechSequence:1});f.restart();
  assert.throws(()=>f.host.read(f.alice,{sessionId:'meal'}),{code:'dish_host_epoch_changed'});
  assert.throws(()=>f.host.confirmStopped(f.admin,f.alice,{sessionId:'meal',expectedRevision:3,speechSequence:1}),{code:'dish_host_epoch_changed'});
 }finally{f.close();}
});
test('context callback revocation is rechecked before disclosure or commit; retirement stops access',()=>{
 const f=fixture();try{f.create();f.callback(()=>{f.auth.revoke('alice');return f.context;});assert.throws(()=>f.host.read(f.alice,{sessionId:'meal'}),{code:'unauthenticated'});f.host.close(f.admin);assert.throws(()=>f.host.read(f.bob,{sessionId:'meal'}),{code:'dish_host_closed'});
 }finally{f.close();}
});

test('host retirement inside context callback prevents disclosure and writes',()=>{
 for(const action of ['read','command','create']) {
  const f=fixture();try{
   const s=action==='create'?null:f.create();f.callback(()=>{f.host.close(f.admin);return f.context;});
   assert.throws(()=>action==='read'?f.host.read(f.alice,{sessionId:'meal'}):action==='command'?f.step(s,'speak',{dishId:'soup'}):f.create(),{code:'dish_host_closed'});
  }finally{f.close();}
 }
});
test('reentrant context callback cannot make read disclose an obsolete revision',()=>{
 const f=fixture();try{const s=f.create();let once=false;
  f.callback(()=>{if(!once){once=true;f.step(s,'speak',{dishId:'soup'});}return f.context;});
  assert.throws(()=>f.host.read(f.alice,{sessionId:'meal'}),{code:'revision_conflict'});
  f.callback(()=>f.context);assert.equal(f.host.read(f.alice,{sessionId:'meal'}).revision,2);
 }finally{f.close();}
});

test('bounded remote command history refuses writes at capacity but retains readable state',()=>{
 const f=fixture();try{let s=f.create();s=f.step(s,'speak',{dishId:'soup'});s=f.step(s,'interrupt',{speechSequence:1});s=f.host.confirmStopped(f.admin,f.alice,{sessionId:'meal',expectedRevision:3,speechSequence:1});
  while(s.focus.revision<256)s=f.step(s,'details');
  assert.throws(()=>f.step(s,'hide'),{code:'dish_session_command_capacity'});
  assert.equal(f.host.read(f.alice,{sessionId:'meal'}).revision,256);
 }finally{f.close();}
});
