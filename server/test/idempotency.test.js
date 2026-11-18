import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.js';
import { Runtime } from '../src/runtime.js';
import { DemoProvider } from '../src/providers.js';
import { createApi } from '../src/http.js';
const fixture=(options={})=>{const dir=mkdtempSync(join(tmpdir(),'summon-once-'));const path=join(dir,'state.json');let k=new Kernel(path,options);return{
  get k(){return k;},restart(){k.close();k=new Kernel(path,options);},done(){k.close();rmSync(dir,{recursive:true});}};};
test('successful creation and receipt commit together, replay survives restart without duplicate or writes',()=>{
  const f=fixture();try{
    const input={name:'persistent request',requestId:'creation-123'};
    const created=f.k.createSubject('a',input);assert.equal(created.replayed,false);
    f.restart();const rev=f.k.state.revision;
    const replay=f.k.createSubject('a',{requestId:input.requestId,name:input.name});
    assert.equal(replay.id,created.id);assert.equal(replay.replayed,true);assert.equal(f.k.state.revision,rev);
    replay.aibm.serviceAbilities.push('bad');assert.deepEqual(f.k.createSubject('a',input).aibm.serviceAbilities,[]);
    assert.equal(f.k.list('a').subjects.length,1);
    const other=f.k.createSubject('b',input);assert.notEqual(other.id,created.id);assert.equal(other.ownerId,'b');
    assert.throws(()=>f.k.createSubject('a',{...input,name:'changed'}),{code:'request_id_conflict'});
  }finally{f.done();}
});
test('task replays preserve original receipt but never revive cancelled tasks or regrant permissions',()=>{
  const f=fixture();try{
    const s=f.k.createSubject('a',{name:'subject'});f.k.mount('a',s.id,'local.report');
    const input={subjectId:s.id,serviceId:'local.report',requestId:'task-12345',trigger:{kind:'event',type:'connector.lost'},payload:{a:1,b:2}};
    const task=f.k.schedule('a',input);f.k.cancel('a',task.id);f.k.mount('a',s.id,'local.report',false);f.restart();
    const replay=f.k.schedule('a',{...input,payload:{b:2,a:1}});assert.equal(replay.id,task.id);assert.equal(replay.replayed,true);
    assert.equal(f.k.list('a').tasks[0].status,'cancelled');assert.equal(f.k.tick().length,0);
    assert.throws(()=>f.k.schedule('a',{...input,payload:{a:2,b:2}}),{code:'request_id_conflict'});
    assert.throws(()=>f.k.createSubject('a',{name:'conflict',requestId:input.requestId}),{code:'request_id_conflict'});
  }finally{f.done();}
});
test('failed requests do not consume keys, invalid IDs reject and receipt capacity fails closed',()=>{
  const f=fixture();try{
    assert.throws(()=>f.k.createSubject('a',{name:'x',requestId:'bad'}),{code:'invalid_request_id'});
    const s=f.k.createSubject('a',{name:'x'});const request={subjectId:s.id,serviceId:'local.report',requestId:'retryable-task',trigger:{kind:'event',type:'x'}};
    assert.throws(()=>f.k.schedule('a',request),{code:'outside_service_boundary'});
    assert.equal(Object.keys(f.k.state.requests).length,0);
    f.k.mount('a',s.id,'local.report');const task=f.k.schedule('a',request);assert.equal(task.replayed,false);
    for(let i=0;i<999;i++)f.k.state.requests[`fixture-${i}`]={fingerprint:'fixture',result:{}};
    assert.equal(f.k.schedule('a',request).replayed,true);
    assert.throws(()=>f.k.createSubject('a',{name:'blocked',requestId:'new-request'}),{code:'request_capacity'});
    assert.equal(f.k.list('a').subjects.length,1);
    assert.equal(Object.hasOwn(f.k.list('a'),'requests'),false);
  }finally{f.done();}
});

test('parallel HTTP retries commit once, authenticated owner controls the request namespace',async()=>{
  const f=fixture({maxRequestsPerOwner:2});const token='idempotency-test-token-abcdefghijklmnopqrstuvwxyz';
  const server=createApi(new Runtime(new DemoProvider(),{kernel:f.k}),{appToken:token,ownerId:'a',kernel:f.k});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/v1/kernel/`;
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  try{
    const input={name:'once',requestId:'parallel-create',ownerId:'b'};
    const responses=await Promise.all([post('subjects',input),post('subjects',input)]);
    const [a,b]=await Promise.all(responses.map(r=>r.json()));
    assert.equal(a.id,b.id);assert.notEqual(a.replayed,b.replayed);assert.equal(a.ownerId,'a');
    assert.equal(f.k.list('a').subjects.length,1);assert.equal(f.k.list('b').subjects.length,0);
    await post('mounts',{subjectId:a.id,serviceId:'local.report'});
    const task={requestId:'parallel-task',subjectId:a.id,serviceId:'local.report',trigger:{kind:'event',type:'x'}};
    const tasks=await Promise.all([post('tasks',task),post('tasks',task)]);
    const results=await Promise.all(tasks.map(r=>r.json()));assert.equal(results[0].id,results[1].id);
    assert.equal(f.k.list('a').tasks.length,1);
    const blocked=await post('subjects',{name:'blocked',requestId:'third-request',ownerId:'b'});
    assert.equal(blocked.status,429);assert.equal((await blocked.json()).error,'owner_request_capacity');
    const state=await(await fetch(base+'state',{headers})).json();assert.deepEqual(state.requestQuota,{used:2,limit:2});
    assert.equal((await post('subjects',{...input,name:'changed'})).status,409);
    assert.equal((await fetch(base+'subjects',{method:'POST',body:JSON.stringify(input)})).status,401);
  }finally{await new Promise(resolve=>server.close(resolve));f.done();}
});

test('per-owner receipt quota leaves headroom for another owner and never blocks existing replays',()=>{
  const f=fixture({maxRequestsPerOwner:2});try{
    const a=f.k.createSubject('a',{name:'a1',requestId:'request-a1'});
    f.k.mount('a',a.id,'local.report');
    const task={subjectId:a.id,serviceId:'local.report',requestId:'request-a2',trigger:{kind:'event',type:'x'}};
    f.k.schedule('a',task);
    assert.deepEqual(f.k.list('a').requestQuota,{used:2,limit:2});
    assert.throws(()=>f.k.createSubject('a',{name:'blocked',requestId:'request-a3'}),{code:'owner_request_capacity'});
    assert.throws(()=>f.k.schedule('a',{...task,requestId:'request-a4'}),{code:'owner_request_capacity'});
    const b=f.k.createSubject('b',{name:'b1',requestId:'request-a1'});assert.equal(b.ownerId,'b');
    assert.deepEqual(f.k.list('b').requestQuota,{used:1,limit:2});
    f.restart();assert.equal(f.k.createSubject('a',{name:'a1',requestId:'request-a1'}).replayed,true);
    assert.equal(f.k.schedule('a',task).replayed,true);
    assert.equal(f.k.list('a').tasks.length,1);assert.equal(f.k.list('a').subjects.length,1);
    assert.deepEqual(f.k.list('b').requestQuota,{used:1,limit:2});
  }finally{f.done();}
});
test('legacy receipt ownership migrates and preexisting over-quota receipts remain replayable',()=>{
  const options={maxRequestsPerOwner:2};const f=fixture(options);try{
    const input={name:'legacy',requestId:'legacy-create'};const created=f.k.createSubject('a',input);
    const second={name:'legacy2',requestId:'legacy-create2'};f.k.createSubject('a',second);
    for(const record of Object.values(f.k.state.requests)) delete record.ownerId;
    f.k.createSubject('a',{name:'unkeyed compatibility write'}); // persist v0.12 shape
    options.maxRequestsPerOwner=1;f.restart();assert.deepEqual(f.k.list('a').requestQuota,{used:2,limit:1});
    assert.equal(f.k.createSubject('a',second).replayed,true);
    assert.equal(f.k.createSubject('a',input).id,created.id);
    assert.throws(()=>f.k.createSubject('a',{name:'new',requestId:'new-create'}),{code:'owner_request_capacity'});
    assert.equal(f.k.createSubject('b',input).ownerId,'b');
  }finally{f.done();}
});
test('invalid per-owner limits fail before taking the store lock',()=>{
  const dir=mkdtempSync(join(tmpdir(),'summon-quota-'));const path=join(dir,'state.json');
  try{
    for(const maxRequestsPerOwner of [0,-1,1.5,1001,Infinity,'100']) assert.throws(()=>new Kernel(path,{maxRequestsPerOwner}));
    const kernel=new Kernel(path);assert.equal(kernel.maxRequestsPerOwner,100);kernel.close();
  }finally{rmSync(dir,{recursive:true});}
});
