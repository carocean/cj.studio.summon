import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SnapshotStore} from '../src/store.js';
import {HostIdentity} from '../src/identity.js';
import {GrantLedger} from '../src/grants.js';
import {ControlledContextLab} from '../src/context.js';
const all=['derive','disclose','read'];
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'summon-boundary-')),path=join(dir,'core.sqlite');let store=new SnapshotStore(path),clock=100;
 const auth=new HostIdentity(),handles=Object.fromEntries(['host-admin','owner','worker','assistant','restaurant','other'].map(p=>[p,auth.authenticate(p)]));
 let grants=new GrantLedger(store,auth,{clock:()=>clock}),data=new ControlledContextLab(store,grants);let serial=0;
 return {auth,handles,get store(){return store;},get grants(){return grants;},get data(){return data;},next:()=>`cmd-${++serial}`,setClock(v){clock=v;},reopen(){store.close();store=new SnapshotStore(path);grants=new GrantLedger(store,auth,{clock:()=>clock});data=new ControlledContextLab(store,grants);},done(){store.close();rmSync(dir,{recursive:true});}};
}
function source(f,name,recipients=['owner','worker'],content='private schedule') {
 return f.data.createSource(f.handles['host-admin'],f.next(),{sourceId:name,controller:'owner',content,purposes:['work'],recipients,retentionUntil:900});
}
function root(f,grantId,resources,options={}) {
 return f.grants.issueRoot(f.handles['host-admin'],f.next(),{grantId,rootPrincipal:'owner',delegate:'worker',resources,operations:all,purposes:['work'],recipients:['owner','worker'],budget:{calls:10,bytes:10000},expiresAt:800,maxDepth:3,...options});
}
function context(f,contextId,bindings,stateRefs=[]) {
 return f.data.createContext(f.handles.worker,f.next(),{contextId,bindings,stateRefs,purpose:'work'});
}
test('only host issues roots; child grants preserve root and attenuate all scopes, expiry and budget',()=>{
 const f=fixture();try {
  root(f,'root',['menu','schedule'],{recipients:['assistant','owner','worker']});
  const spec={grantId:'child',delegate:'assistant',resources:['schedule'],operations:['read'],purposes:['work'],recipients:['assistant','owner'],budget:{calls:6,bytes:4000},expiresAt:700,maxDepth:2};
  assert.throws(()=>f.grants.issueRoot(f.handles.worker,f.next(),{...spec,rootPrincipal:'worker'}),{code:'not_authorized'});
  f.grants.attenuate(f.handles.worker,'child-command','root',spec);
  const child=f.grants.inspect(f.handles.assistant,'child');assert.equal(child.rootPrincipal,'owner');assert.equal(child.issuer,'worker');
  assert.equal(f.grants.attenuate(f.handles.worker,'child-command','root',spec).replayed,true);
  assert.equal(f.grants.inspect(f.handles.worker,'root').allocated.calls,6);
  for(const change of [{recipients:['assistant','restaurant']},{resources:['secrets']},{purposes:['marketing']},{operations:['derive','read']},{expiresAt:900},{maxDepth:3}]) {
   const based={...spec,grantId:'bad',operations:['read']};
   // Parent supports derive, so test operation expansion from the read-only child instead.
   if(change.operations){assert.throws(()=>f.grants.attenuate(f.handles.assistant,f.next(),'child',{...based,grantId:'grand',delegate:'assistant',maxDepth:1,...change}),{code:'scope_not_subset'});continue;}
   assert.throws(()=>f.grants.attenuate(f.handles.worker,f.next(),'root',{...based,...change}));
  }
  assert.throws(()=>f.grants.attenuate(f.handles.worker,f.next(),'root',{...spec,grantId:'second',budget:{calls:5,bytes:1}}),{code:'budget_exhausted'});
  assert.equal(f.grants.inspect(f.handles.worker,'root').children.length,1);
  f.grants.revoke(f.handles.owner,f.next(),'root');
  assert.throws(()=>f.store.transaction(tx=>f.grants.validateIn(tx,{grantId:'child',actor:'assistant',resourceId:'schedule',operations:['read'],purpose:'work',recipient:'assistant'})),{code:'grant_inactive'});
 }finally{f.done();}
});
test('ancestor revocation and observed expiry survive restart/clock rollback and do not refund allocated budget',()=>{
 const f=fixture();try {
  root(f,'root',['schedule'],{recipients:['assistant','owner','worker']});
  f.grants.attenuate(f.handles.worker,f.next(),'root',{grantId:'child',delegate:'assistant',resources:['schedule'],operations:['read'],purposes:['work'],recipients:['assistant','owner'],budget:{calls:4,bytes:100},expiresAt:200,maxDepth:1});
  f.setClock(201);assert.equal(f.grants.inspect(f.handles.assistant,'child').status,'expired');f.reopen();f.setClock(150);
  assert.throws(()=>f.store.transaction(tx=>f.grants.validateIn(tx,{grantId:'child',actor:'assistant',resourceId:'schedule',operations:['read'],purpose:'work',recipient:'assistant'},150)),{code:'grant_inactive'});
  assert.equal(f.grants.inspect(f.handles.worker,'root').allocated.calls,4);
  f.grants.revoke(f.handles.owner,f.next(),'root');
  assert.equal(f.grants.inspect(f.handles.owner,'root').status,'revoked');
 }finally{f.done();}
});
test('context source closure is built by environment, frozen, and inherited through previous artifacts',()=>{
 const f=fixture();try {
  source(f,'schedule');source(f,'menu',['owner','restaurant','worker'],'public menu');root(f,'private',['schedule']);root(f,'public',['menu'],{recipients:['owner','restaurant','worker']});
  const bindings=[{sourceId:'schedule',grantId:'private'}];context(f,'first',bindings);bindings[0].sourceId='menu';
  f.data.run(f.handles.worker,'run-first',{contextId:'first',artifactId:'memory'});
  const output=f.data.disclose(f.handles.owner,'read-private',{artifactId:'memory',purpose:'work'});assert.equal(output.content,'private schedule');
  assert.equal(f.data.disclose(f.handles.owner,'read-private',{artifactId:'memory',purpose:'work'}).content,undefined);
  context(f,'second',[{sourceId:'menu',grantId:'public'}],['memory']);
  f.data.run(f.handles.worker,f.next(),{contextId:'second',artifactId:'scene'});
  assert.throws(()=>f.data.disclose(f.handles.restaurant,f.next(),{artifactId:'scene',purpose:'work'}),{code:'not_authorized'});
  assert.equal(f.data.disclose(f.handles.owner,f.next(),{artifactId:'scene',purpose:'work'}).content,'public menu\nprivate schedule');
  assert.throws(()=>f.data.createContext(f.handles.worker,f.next(),{contextId:'forged',bindings:[],stateRefs:['memory'],purpose:'work',origins:[]}),{code:'invalid_shape'});
  assert.throws(()=>f.data.run(f.handles.other,f.next(),{contextId:'second',artifactId:'stolen'}),{code:'not_authorized'});
 }finally{f.done();}
});
test('secret state cannot be laundered after revocation; fresh deterministic context has no hidden history',()=>{
 const f=fixture();try {
  source(f,'schedule');source(f,'menu',['owner','restaurant','worker'],'public menu');root(f,'private',['schedule']);root(f,'public',['menu'],{recipients:['owner','restaurant','worker']});
  context(f,'secret',[{sourceId:'schedule',grantId:'private'}]);f.data.run(f.handles.worker,f.next(),{contextId:'secret',artifactId:'memory'});
  context(f,'prepared',[{sourceId:'menu',grantId:'public'}],['memory']);f.data.revokeSource(f.handles.owner,f.next(),'schedule');f.reopen();
  assert.throws(()=>f.data.run(f.handles.worker,f.next(),{contextId:'prepared',artifactId:'leaked'}),{code:'stale_source'});
  assert.throws(()=>context(f,'laundered',[{sourceId:'menu',grantId:'public'}],['memory']),{code:'stale_source'});
  context(f,'fresh',[{sourceId:'menu',grantId:'public'}]);f.data.run(f.handles.worker,f.next(),{contextId:'fresh',artifactId:'safe'});
  assert.equal(f.data.disclose(f.handles.restaurant,f.next(),{artifactId:'safe',purpose:'work'}).content,'public menu');
  assert.equal(f.store.get('artifact.leaked'),null);
 }finally{f.done();}
});
test('separate read and disclose grants cannot be combined to release an old artifact',()=>{
 const f=fixture();try {
  source(f,'schedule',['owner','restaurant','worker']);root(f,'read-only',['schedule'],{operations:['derive','read'],recipients:['owner','restaurant','worker']});
  root(f,'send-only',['schedule'],{operations:['disclose'],recipients:['owner','restaurant','worker']});
  context(f,'read-context',[{sourceId:'schedule',grantId:'read-only'}]);f.data.run(f.handles.worker,f.next(),{contextId:'read-context',artifactId:'derived'});
  assert.throws(()=>f.data.disclose(f.handles.restaurant,f.next(),{artifactId:'derived',purpose:'work'}),{code:'grant_scope_denied'});
  assert.throws(()=>context(f,'combine',[{sourceId:'schedule',grantId:'send-only'}],['derived']),{code:'grant_scope_denied'});
 }finally{f.done();}
});
test('run budget and output commit atomically; retries do not charge again; revoke blocks disclosure replay',()=>{
 const f=fixture();try {
  source(f,'menu',['owner','worker'],'menu');root(f,'limited',['menu'],{budget:{calls:3,bytes:100}});context(f,'ctx',[{sourceId:'menu',grantId:'limited'}]);
  const spec={contextId:'ctx',artifactId:'result'};f.data.run(f.handles.worker,'one-run',spec);f.data.run(f.handles.worker,'one-run',spec);
  assert.equal(f.grants.inspect(f.handles.worker,'limited').spent.calls,2);
  f.data.disclose(f.handles.owner,'one-read',{artifactId:'result',purpose:'work'});
  assert.equal(f.grants.inspect(f.handles.worker,'limited').spent.calls,3);
  assert.throws(()=>f.data.run(f.handles.worker,f.next(),{contextId:'ctx',artifactId:'over-budget'}),{code:'budget_exhausted'});assert.equal(f.store.get('artifact.over-budget'),null);
  f.grants.revoke(f.handles.owner,f.next(),'limited');
  assert.throws(()=>f.data.disclose(f.handles.owner,'one-read',{artifactId:'result',purpose:'work'}),{code:'grant_inactive'});
 }finally{f.done();}
});
test('context allocation consumes bounded budget and cannot grow snapshots without limit',()=>{
 const f=fixture();try {
  source(f,'menu');root(f,'one-context',['menu'],{budget:{calls:1,bytes:1000}});
  context(f,'one',[{sourceId:'menu',grantId:'one-context'}]);
  assert.throws(()=>context(f,'two',[{sourceId:'menu',grantId:'one-context'}]),{code:'budget_exhausted'});
  assert.equal(f.store.get('context.two'),null);
 }finally{f.done();}
});

test('a failed later reference cannot undo observed grant or source expiry across restart and clock rollback',()=>{
 const f=fixture();try {
  source(f,'short-grant-source');root(f,'short-grant',['short-grant-source'],{expiresAt:200});
  f.setClock(250);
  assert.throws(()=>context(f,'bad-grants',[{sourceId:'short-grant-source',grantId:'short-grant'},{sourceId:'short-grant-source',grantId:'missing-grant'}]),{code:'grant_not_found'});
  assert.equal(f.store.get('grant.short-grant').value.status,'expired');f.reopen();f.setClock(150);
  assert.throws(()=>context(f,'revived-grant',[{sourceId:'short-grant-source',grantId:'short-grant'}]),{code:'grant_inactive'});
  f.data.createSource(f.handles['host-admin'],f.next(),{sourceId:'short-source',controller:'owner',content:'x',purposes:['work'],recipients:['owner','worker'],retentionUntil:200});
  root(f,'long-grant',['missing-source','short-source']);f.setClock(250);
  assert.throws(()=>context(f,'bad-sources',[{sourceId:'short-source',grantId:'long-grant'},{sourceId:'missing-source',grantId:'long-grant'}]),{code:'resource_not_found'});
  assert.equal(f.store.get('source.short-source').value.status,'expired');f.reopen();f.setClock(150);
  assert.throws(()=>context(f,'revived-source',[{sourceId:'short-source',grantId:'long-grant'}]),{code:'source_inactive'});
 }finally{f.done();}
});

test('multi-source budget failures roll back every debit; mismatched data controller never authorizes reading',()=>{
 const f=fixture();try {
  source(f,'a');source(f,'b');root(f,'ga',['a'],{budget:{calls:3,bytes:1000}});root(f,'gb',['b'],{budget:{calls:1,bytes:1000}});
  context(f,'pair',[{sourceId:'a',grantId:'ga'},{sourceId:'b',grantId:'gb'}]);
  assert.throws(()=>f.data.run(f.handles.worker,f.next(),{contextId:'pair',artifactId:'failed-pair'}),{code:'budget_exhausted'});
  assert.equal(f.grants.inspect(f.handles.worker,'ga').spent.calls,1);assert.equal(f.store.get('artifact.failed-pair'),null);
  root(f,'wrong-controller',['a'],{rootPrincipal:'other'});
  assert.throws(()=>context(f,'wrong',[{sourceId:'a',grantId:'wrong-controller'}]),{code:'source_controller_mismatch'});
  assert.equal(f.grants.inspect(f.handles.worker,'wrong-controller').spent.calls,0);
 }finally{f.done();}
});
