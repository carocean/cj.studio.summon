import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';

const values={topic:'study',duration:'5',pace:'gentle'};
const worker=new URL('./fixtures/focus-http-crash-worker.js',import.meta.url);
function start(dir,pausePath=''){
 const child=fork(worker,[],{env:{...process.env,CRASH_DATA:dir,PAUSE_PATH:pausePath},stdio:['ignore','ignore','pipe','ipc']});
 let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-2000);});
 const exit=once(child,'exit');
 const messages=new Map(),waiting=new Map();
 child.on('message',m=>{messages.set(m.type,m);waiting.get(m.type)?.(m);});
 const message=type=>messages.has(type)?Promise.resolve(messages.get(type)):new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error(`worker timed out before ${type}: ${stderr}`)),5000);
  waiting.set(type,value=>{clearTimeout(timer);resolve(value);});
  exit.then(()=>{clearTimeout(timer);if(!messages.has(type))reject(Error(`worker exited before ${type}: ${stderr}`));});
 });
 return {child,message,async stop(){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;},async base(){return 'http://127.0.0.1:'+(await message('ready')).port;}};
}
const post=async(base,path,body)=>{
 const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Summon-Lab':'synthetic'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 return {status:response.status,body:await response.json()};
};
async function enable(base){const r=await post(base,'/scene/focus-grant',{creatureId:'companion',enabled:true,expectedRevision:0});assert.equal(r.status,200);return r.body.choiceForms.focus;}
const input=(form,requestId)=>({formId:form.formId,binding:form.binding,values,requestId});

for(const action of ['create','cancel','pre-cancel'])test(`focus HTTP ${action}: actual SIGKILL after commit before response preserves recoverable fact`,{timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'focus-http-crash-'));
 const path=action==='create'?'/scene/form-focus':'/scene/focus-cancel';
 let running=start(dir,path);
 try{
  const base=await running.base(),form=await enable(base),body=input(form,'uncertain-1');
  let original;
  if(action==='cancel'){
   const created=await post(base,'/scene/form-focus',body);assert.equal(created.status,200);original=created.body.focus.activePlan.receipt;
  }
  // Attach rejection handling immediately: a real HTTP peer vanishes with SIGKILL.
  const pending=post(base,path,action==='create'?body:{requestId:'uncertain-1'}).then(value=>({value}),error=>({error}));
  const committed=await running.message('durable');assert.equal(committed.status,200);
  await running.stop();assert.ok((await pending).error,'no success response reached client');
  running=start(dir);const recoveredBase=await running.base();
  const recovered=await post(recoveredBase,'/scene/focus-status',{requestId:'uncertain-1'});assert.equal(recovered.status,200);
  if(action==='pre-cancel'){
   assert.deepEqual(recovered.body,{requestId:'uncertain-1',status:'cancelled',plan:null});
   const late=await post(recoveredBase,'/scene/form-focus',body);assert.equal(late.status,400);assert.equal(late.body.error,'focus_request_cancelled');
  }else{
   assert.equal(recovered.body.status,'completed');assert.equal(recovered.body.plan.status,action==='create'?'active':'cancelled');
   const receipt=action==='create'?committed.body.focus.activePlan.receipt:original;
   assert.deepEqual(recovered.body.plan.receipt,receipt);
   // A repeated old form must never create another plan, even after cancellation.
   const late=await post(recoveredBase,'/scene/form-focus',body);
   if(action==='create'){assert.equal(late.status,400);assert.equal(late.body.error,'choice_form_unavailable');}else{assert.equal(late.status,200);assert.equal(late.body.focus.activePlan,null);}
  }
  const state=await(await fetch(recoveredBase+'/scene/state')).json();
  assert.equal(state.focus.requestCount,1);assert.equal(state.focus.requests[0].requestId,'uncertain-1');
  assert.equal(state.focus.activePlan!==null,action==='create');
 }finally{await running.stop();rmSync(dir,{recursive:true,force:true});}
});
