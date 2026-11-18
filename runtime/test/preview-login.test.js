import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {loginHtml,loginScript} from '../src/preview-login.js';
const secret='synthetic-invitation-only-not-a-real-secret-12345';
const ok=()=>({status:200,json:async()=>({csrf:'x'.repeat(43),expiresInMs:1000})});
function fixture(fetch){
 const nodes=Object.fromEntries(['login','invitation','submit','status'].map(id=>[id,{value:'',disabled:false,textContent:'',addEventListener(type,fn){this[type]=fn;}}]));
 const events={},navigations=[],timers=new Map();let timer=0;
 const window={addEventListener:(type,fn)=>events[type]=fn,location:{replace:path=>navigations.push(path)}};
 runInNewContext(loginScript.toString(),{document:{getElementById:id=>nodes[id]},window,fetch,AbortController,setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)});
 const submit=()=>nodes.login.submit({preventDefault(){}});
 return {nodes,events,navigations,timers,submit};
}
test('static shell uses only fixed external script, no inline code or credential transport fields',()=>{
 const html=loginHtml.toString(),script=loginScript.toString();
 assert.match(html,/lang="zh-CN"/);assert.match(html,/登录私有预览/);assert.match(script,/邀请口令无效/);
 assert.match(html,/<script src="\/preview\/login.js" defer><\/script>/);assert.doesNotMatch(html,/<base|<style|\son\w+=|name="invitation"/i);
 assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB|console\.|document\.cookie|location\.search|returnTo/);
 assert.doesNotMatch(html+script,new RegExp(secret));
});
test('explicit submission only; duplicate clicks suppressed, secret cleared, navigation fixed',async()=>{
 let complete,calls=[];const f=fixture((url,options)=>{calls.push({url,options});return new Promise(r=>complete=r)});
 assert.equal(calls.length,0);f.nodes.invitation.value=secret;const pending=f.submit();await f.submit();assert.equal(calls.length,1);
 assert.equal(f.nodes.invitation.value,'');assert.equal(f.nodes.submit.disabled,true);
 assert.equal(calls[0].url,'/preview/login');assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.redirect,'error');assert.deepEqual(JSON.parse(calls[0].options.body),{invitation:secret});
 complete(ok());await pending;assert.deepEqual(f.navigations,['/']);assert.equal(f.nodes.invitation.value,'');
});
test('401/429/network/malformed success show fixed errors without retries or navigation',async()=>{
 for(const response of [{status:401},{status:429},new Error('secret response must never be shown'),{status:200,json:async()=>({csrf:'bad',expiresInMs:1})}]){
  let calls=0;const f=fixture(async()=>{calls++;if(response instanceof Error)throw response;return response});f.nodes.invitation.value=secret;await f.submit();assert.equal(calls,1);assert.deepEqual(f.navigations,[]);assert.equal(f.nodes.submit.disabled,false);assert.equal(f.nodes.invitation.value,'');assert.doesNotMatch(f.nodes.status.textContent,/secret/);assert.notEqual(f.nodes.status.textContent,'');
 }
});
test('pagehide retires late fetch and JSON completion; pageshow starts clean',async()=>{
 for(const stage of ['fetch','json']){
  let release,signal;const f=fixture((_url,options)=>{signal=options.signal;return stage==='fetch'?new Promise(r=>release=()=>r(ok())):Promise.resolve({status:200,json:()=>new Promise(r=>release=()=>r({csrf:'x'.repeat(43),expiresInMs:1}))})});
  f.nodes.invitation.value=secret;const pending=f.submit();for(let i=0;i<10&&!release;i++)await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');f.events.pagehide();assert.equal(signal.aborted,true);f.events.pageshow();release();await pending;assert.deepEqual(f.navigations,[]);assert.equal(f.nodes.invitation.value,'');assert.equal(f.nodes.submit.disabled,false);
 }
});
test('timeout abort prevents late successful navigation',async()=>{
 let release;const f=fixture(()=>new Promise(r=>release=r));f.nodes.invitation.value=secret;const pending=f.submit();[...f.timers.values()][0]();release(ok());await pending;assert.deepEqual(f.navigations,[]);assert.equal(f.nodes.submit.disabled,false);
});
