import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical, digest, snapshot } from '../src/canonical.js';
import { SnapshotStore } from '../src/store.js';
import { HostIdentity } from '../src/identity.js';
function location() {
  const dir=mkdtempSync(join(tmpdir(),'summon-microkernel-'));
  return {path:join(dir,'core.sqlite'),cleanup(){rmSync(dir,{recursive:true,force:true});}};
}
test('C1 deterministic bytes and domain-separated hash; snapshots never retain caller references',()=>{
  assert.equal(canonical({z:2,a:'中文🐈'}),'{"a":"中文🐈","z":2}');
  assert.equal(digest('input',{z:2,a:1}),digest('input',{a:1,z:2}));
  assert.notEqual(digest('input',{a:1}),digest('context',{a:1}));
  assert.notEqual(digest('input',[1,2]),digest('input',[2,1]));
  const original={context:{text:'private'}};const copy=snapshot('context',original);
  original.context.text='changed';assert.equal(copy.value.context.text,'private');
  assert.throws(()=>{copy.value.context.text='other';},TypeError);
  assert.equal(copy.digest,digest('context',{context:{text:'private'}}));
});
test('C1 rejects ambiguous, executable, invalid Unicode and oversized records without running getters',()=>{
  let touched=false;const accessor={};Object.defineProperty(accessor,'a',{get(){touched=true;return 1;},enumerable:true});
  const cycle={};cycle.self=cycle;
  const sparse=Array(2);sparse[1]=1;
  const bad=[-0,1.2,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,1n,undefined,()=>{},new Date(),Buffer.from('x'),accessor,cycle,sparse,new Proxy({a:1},{}),{'bad-key':1},{constructor:1},'\ud800','\udfff',Array(257).fill(0),{text:'x'.repeat(16385)}];
  for(const value of bad)assert.throws(()=>canonical(value));assert.equal(touched,false);
  let deep={};for(let i=0;i<34;i++)deep={next:deep};assert.throws(()=>canonical(deep),{code:'c1_depth_limit'});
  assert.throws(()=>canonical(Array(5).fill('x'.repeat(16000))),{code:'c1_record_limit'});
});
test('host identities are local authenticated handles, not caller-provided IDs; revoked handles never revive',()=>{
  const host=new HostIdentity(),other=new HostIdentity(),a=host.authenticate('owner');
  assert.equal(host.resolve(a),'owner');assert.throws(()=>host.resolve({principalId:'owner'}),{code:'unauthenticated'});
  assert.throws(()=>other.resolve(a),{code:'unauthenticated'});host.revoke('owner');
  assert.throws(()=>host.resolve(a),{code:'unauthenticated'});const b=host.authenticate('owner');assert.equal(host.resolve(b),'owner');assert.throws(()=>host.resolve(a));
});
test('versioned immutable store supports CAS and releases its exclusive writer lock',()=>{
  const f=location();let store=new SnapshotStore(f.path);
  try{
    assert.throws(()=>new SnapshotStore(f.path),{code:'store_locked'});
    const original={text:'one'};store.transaction(tx=>tx.put('being','manifest',original,0));original.text='mutated';
    assert.equal(store.get('being').value.text,'one');
    assert.throws(()=>store.transaction(tx=>tx.put('being','manifest',{text:'bad'},0)),{code:'revision_conflict'});
    store.transaction(tx=>tx.put('being','manifest',{text:'two'},1));assert.equal(store.get('being',1).value.text,'one');assert.equal(store.get('being').revision,2);
    assert.throws(()=>store.transaction(tx=>tx.put('being','context',{text:'wrong kind'},2)),{code:'resource_kind_immutable'});
    store.close();store=new SnapshotStore(f.path);assert.equal(store.get('being').value.text,'two');
  }finally{store.close();f.cleanup();}
});
test('resource changes and command acknowledgments commit atomically; retries do not rerun callback',()=>{
  const f=location(),store=new SnapshotStore(f.path);let calls=0;
  const apply=(tx,input)=>{calls++;tx.put('sample','context',input,0);return {resource:'sample'};};
  try{
    assert.equal(store.command('owner','request-one',{text:'frozen'},apply).replayed,false);
    assert.equal(store.command('owner','request-one',{text:'frozen'},apply).replayed,true);assert.equal(calls,1);
    assert.throws(()=>store.command('owner','request-one',{text:'different'},apply),{code:'command_conflict'});
    assert.throws(()=>store.command('owner','request-bad',{text:'x'},tx=>{tx.put('rollback','context',{text:'must not survive'},0);throw new Error('abort');}));
    assert.equal(store.get('rollback'),null);
    const retry=store.command('owner','request-bad',{text:'x'},tx=>{tx.put('rollback','context',{text:'valid retry'},0);return {ok:true};});assert.equal(retry.replayed,false);
  }finally{store.close();f.cleanup();}
});
test('transaction handles expire and async/nested callbacks cannot leave partial writes',()=>{
  const f=location(),store=new SnapshotStore(f.path);let retained;
  try{
    store.transaction(tx=>{retained=tx;return null;});assert.throws(()=>retained.put('late','input',{},0),{code:'transaction_ended'});
    assert.throws(()=>store.transaction(tx=>{tx.put('partial','input',{},0);return Promise.resolve(null);}),{code:'async_transaction_forbidden'});assert.equal(store.get('partial'),null);
    assert.throws(()=>store.transaction(()=>store.transaction(()=>null)),{code:'nested_transaction'});
    assert.throws(()=>store.transaction(tx=>{tx.put('partial','input',{},0);store.close();}),{code:'transaction_active'});assert.equal(store.get('partial'),null);
  }finally{store.close();f.cleanup();}
});
for(const phase of ['before-commit','after-commit'])test(`actual child SIGKILL ${phase}: lock release and atomic recovery`,()=>{
  const f=location();try{
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../fixtures/crash-child.mjs',import.meta.url)),f.path,phase],{encoding:'utf8',timeout:15000});
    assert.equal(child.signal,'SIGKILL',child.stderr);
    const store=new SnapshotStore(f.path);try{
      const committed=phase==='after-commit';assert.equal(store.get('sample')!==null,committed);
      let called=false;const result=store.command('owner','create-one',{resource:'sample'},tx=>{called=true;tx.put('sample','context',{text:'retry after rollback'},0);return {resource:'sample',revision:1};});
      assert.equal(result.replayed,committed);assert.equal(called,!committed);assert.equal(store.get('sample').revision,1);
    }finally{store.close();}
  }finally{f.cleanup();}
});
test('a separate live process cannot initialize or write the owned data store',()=>{
  const f=location(),store=new SnapshotStore(f.path);
  try {
    store.transaction(tx=>tx.put('protected','input',{text:'single writer'},0));
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../fixtures/lock-child.mjs',import.meta.url)),f.path],{encoding:'utf8',timeout:15000});
    assert.equal(child.status,0,child.stderr);assert.equal(store.get('protected').revision,1);
  }finally{store.close();f.cleanup();}
});

test('dangling symlinks for data or lock cannot split physical storage ownership',()=>{
  const f=location();
  try {
    const alias=join(f.path,'..','alias.sqlite');
    symlinkSync(f.path,alias);assert.throws(()=>new SnapshotStore(alias),{code:'store_alias_forbidden'});
    rmSync(alias);symlinkSync(join(f.path,'..','missing-lock.sqlite'),f.path+'.lock.sqlite');
    assert.throws(()=>new SnapshotStore(f.path),{code:'store_alias_forbidden'});
  }finally{f.cleanup();}
});
test('native async and returned Promise callbacks cannot cause unhandled late transaction rejection',async()=>{
  const f=location(),store=new SnapshotStore(f.path);let entered=false;
  try {
    assert.throws(()=>store.transaction(async tx=>{entered=true;await Promise.resolve();tx.put('late','input',{},0);}),{code:'async_transaction_forbidden'});
    assert.equal(entered,false);
    assert.throws(()=>store.transaction(tx=>Promise.resolve().then(()=>tx.put('late','input',{},0))),{code:'async_transaction_forbidden'});
    assert.throws(()=>store.command('owner','async-command',{},async tx=>{await Promise.resolve();tx.put('late','input',{},0);return {ok:true};}),{code:'async_transaction_forbidden'});
    assert.throws(()=>store.command('owner','promise-command',{},tx=>Promise.resolve().then(()=>tx.put('late','input',{},0))),{code:'async_transaction_forbidden'});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(store.get('late'),null);
  }finally{store.close();f.cleanup();}
});

test('invalid acknowledgment then accessor or Proxy is rejected without invoking data traps',()=>{
  const f=location(),store=new SnapshotStore(f.path);let calls=0;
  try {
    const getter={};Object.defineProperty(getter,'then',{enumerable:true,get(){calls++;throw new Error('must not run');}});
    const proxy=new Proxy({ok:true},{get(){calls++;throw new Error('must not run');},ownKeys(){calls++;throw new Error('must not run');},getPrototypeOf(){calls++;throw new Error('must not run');}});
    const decoratedPromise=Promise.resolve(null);Object.defineProperty(decoratedPromise,'constructor',{get(){calls++;throw new Error('must not run');}});
    for(const [i,value] of [getter,proxy,decoratedPromise].entries()) {
      assert.throws(()=>store.command('owner',`bad-ack-${i}`,{},tx=>{tx.put(`rollback-${i}`,'input',{},0);return value;}),{code:'invalid_c1_value'});
      assert.equal(store.get(`rollback-${i}`),null);
    }
    assert.equal(calls,0);
    assert.throws(()=>store.transaction(new Proxy(()=>null,{apply(){calls++;return null;}})),{code:'async_transaction_forbidden'});
    assert.equal(calls,0);
  }finally{store.close();f.cleanup();}
});
