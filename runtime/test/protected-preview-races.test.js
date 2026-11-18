import test from 'node:test';import assert from 'node:assert/strict';import {createServer as http} from 'node:http';import {createServer as https,request} from 'node:https';import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {createProtectedPreview} from '../src/protected-preview.js';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
async function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),'preview-independent-'));let up,server,gate;
 try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 const cert=readFileSync(join(dir,'cert'));let now=0,calls=0,upHandler=(req,res)=>{req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end('{"ok":true}')})};
 up=http((req,res)=>{calls++;upHandler(req,res)});await listen(up);
 server=https({key:readFileSync(join(dir,'key')),cert});await listen(server);const origin='https://localhost:'+server.address().port,invitation='synthetic-review-invitation-is-not-production-secret-1234';
 gate=createProtectedPreview({origin,invitation,upstream:'http://127.0.0.1:'+up.address().port,ttlMs:1000,clock:()=>now,upstreamTimeoutMs:2000});server.on('request',gate);
 function start(path,{method='GET',body,auth={},headers={}}={}){
  let req;const done=new Promise((resolve,reject)=>{
   req=request({hostname:'127.0.0.1',servername:'localhost',port:server.address().port,ca:cert,path,method,headers:{host:new URL(origin).host,...auth,...(method==='POST'?{origin,'content-type':'application/json'}:{}),...headers}},res=>{let chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject)});req.on('error',reject);
  });if(body!==undefined)req.end(Buffer.isBuffer(body)?body:JSON.stringify(body));return {req,done};
 }
 async function send(path,o={}){const p=start(path,o);if(o.body===undefined)p.req.end();return p.done}
 async function login(){const r=await send('/preview/login',{method:'POST',body:{invitation}});assert.equal(r.status,200);return {Cookie:r.headers['set-cookie'][0].split(';')[0],'X-Preview-CSRF':JSON.parse(r.body).csrf}}
 await fn({start,send,login,setNow:n=>now=n,setUp:f=>upHandler=f,getCalls:()=>calls});
 }finally{gate?.close();server?.closeAllConnections();up?.closeAllConnections();await Promise.all([server,up].filter(Boolean).map(s=>new Promise(r=>s.close(r))));rmSync(dir,{recursive:true,force:true})}
}
const delay=()=>new Promise(r=>setTimeout(r,30));
test('old authenticated slow logout cannot revoke replacement login',()=>fixture(async f=>{
 const old=await f.login();const slow=f.start('/preview/logout',{method:'POST',auth:old,headers:{'content-length':2}});slow.req.write('{');await delay();const current=await f.login();slow.req.end('}');const result=await slow.done;
 assert.equal(result.status,401,'old session must be rechecked after logout body');assert.equal(result.headers['set-cookie'],undefined,'stale logout must not clear replacement cookie');assert.equal((await f.send('/preview/session',{auth:current})).status,200);
}));
test('old in-flight upstream response suppressed on replacement login',()=>fixture(async f=>{
 let release;f.setUp((req,res)=>{req.resume();req.on('end',()=>release=()=>{res.setHeader('content-type','application/json');res.end('{"private":true}')})});
 const old=await f.login();const result=f.send('/scene/state',{auth:old});while(!release)await delay();await f.login();release();assert.equal((await result).status,401);
}));
test('slow mutation whose session expires never dispatches',()=>fixture(async f=>{
 const auth=await f.login(),before=f.getCalls();const slow=f.start('/scene/interaction-read',{method:'POST',auth,headers:{'content-length':2}});slow.req.write('{');await delay();f.setNow(1000);slow.req.end('}');assert.equal((await slow.done).status,401);assert.equal(f.getCalls(),before);
}));
test('malformed request UTF8 and duplicate cookies fail closed',()=>fixture(async f=>{
 const auth=await f.login(),before=f.getCalls();assert.equal((await f.send('/scene/usage-query',{method:'POST',auth,body:Buffer.from([123,34,120,34,58,34,0xc3,0x28,34,125])})).status,400);assert.equal((await f.send('/scene/state',{auth:{Cookie:auth.Cookie+'; '+auth.Cookie}})).status,401);assert.equal(f.getCalls(),before);
}));
test('client disconnect aborts pending upstream transport',()=>fixture(async f=>{
 let arrived=false,closed=false;f.setUp((req,res)=>{req.resume();req.on('end',()=>arrived=true);res.on('close',()=>closed=true)});const auth=await f.login();const p=f.start('/scene/state',{auth});p.done.catch(()=>{});p.req.end();while(!arrived)await delay();p.req.destroy();for(let i=0;i<30&&!closed;i++)await delay();assert.equal(closed,true);
}));
test('observed clock rollback kills old authentication even after recovery',()=>fixture(async f=>{
 f.setNow(100);const auth=await f.login();f.setNow(99);assert.equal((await f.send('/preview/session',{auth})).status,503);f.setNow(101);assert.equal((await f.send('/preview/session',{auth})).status,401);
}));
test('upstream redirect/html/oversize/truncated response fail closed',()=>fixture(async f=>{
 const auth=await f.login();
 for(const mode of ['redirect','html','oversize','truncated']){
  f.setUp((req,res)=>{req.resume();req.on('end',()=>{
   if(mode==='redirect'){res.writeHead(302,{'content-type':'application/json',location:'https://never-contact.invalid'});res.end('{}')}
   if(mode==='html'){res.setHeader('content-type','text/html');res.end('<html>no</html>')}
   if(mode==='oversize'){res.setHeader('content-type','application/json');res.end(Buffer.alloc(8*1024*1024+1,32))}
   if(mode==='truncated'){res.writeHead(200,{'content-type':'application/json','content-length':200});res.flushHeaders();res.write('{');setTimeout(()=>res.destroy(),10)}
  })});const r=await f.send('/scene/state',{auth});assert.equal(r.status,502,mode);assert.equal(r.headers['set-cookie'],undefined);
 }
}));
