import test from 'node:test';import assert from 'node:assert/strict';import {createServer as http} from 'node:http';import {createServer as https,request} from 'node:https';import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {createProtectedPreview} from '../src/protected-preview.js';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));const close=s=>new Promise(r=>s.close(r));
test('actual trusted temporary TLS: auth, CSRF, private assets, proxy, expiry, logout and restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'preview-cert-'));let upstream,server,gate;let now=0,calls=0,last,hold=false,release;const invitation='synthetic-test-invitation-not-a-real-secret';
 try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),' -out'.trim(),join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 const cert=readFileSync(join(dir,'cert'));upstream=http((req,res)=>{calls++;last=req.headers;res.setHeader('Content-Type','application/json');if(req.url==='/scene/interaction-close'){res.writeHead(302,{Location:'https://evil.invalid'});res.end();return;}req.resume();req.on('end',()=>{if(hold)release=()=>res.end('{"ok":true}');else res.end('{"ok":true}');});});await listen(upstream);
 server=https({key:readFileSync(join(dir,'key')),cert});await listen(server);const origin='https://localhost:'+server.address().port;
 const options={origin,invitation,upstream:'http://127.0.0.1:'+upstream.address().port,clock:()=>now,ttlMs:1000,maxConcurrent:1,upstreamTimeoutMs:100,assets:new Map([['/',{body:Buffer.from('private app'),type:'text/html'}]])};gate=createProtectedPreview(options);server.on('request',gate);
 const send=(path,method='GET',body,headers={})=>new Promise((resolve,reject)=>{const data=body===undefined?null:JSON.stringify(body);const r=request({hostname:'127.0.0.1',servername:'localhost',port:server.address().port,ca:cert,path,method,headers:{Host:new URL(origin).host,...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...headers}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:b}));});r.on('error',reject);r.end(data);});
 assert.equal((await send('/','GET',undefined,{Host:'evil.invalid'})).status,403);assert.equal((await send('/')).status,401);assert.equal((await send('/scene/state')).status,401);
 const page=await send('/preview/login');assert.equal(page.status,200);assert.match(page.headers['content-type'],/^text\/html/);assert.match(page.body,/<script src="\/preview\/login.js" defer>/);assert.equal(page.headers['set-cookie'],undefined);assert.match(page.headers['content-security-policy'],/default-src 'self'/);assert.doesNotMatch(page.headers['content-security-policy'],/unsafe-inline|unsafe-eval/);assert.doesNotMatch(page.body,new RegExp(invitation));
 const script=await send('/preview/login.js');assert.equal(script.status,200);assert.match(script.headers['content-type'],/^text\/javascript/);assert.equal(script.headers['cache-control'],'no-store, private');assert.doesNotMatch(script.body,new RegExp(invitation));
 assert.equal((await send('/preview/login.js?returnTo=https://evil.invalid')).status,400);assert.equal((await send('/preview/other.js')).status,401);
 assert.equal((await send('/scene/state?invitation=x')).status,400);
 assert.equal((await send('/preview/login','POST',{invitation,extra:true})).status,401);
 assert.equal((await send('/preview/login','POST',{invitation},{Origin:'https://evil.invalid'})).status,403);
 assert.equal((await send('/preview/login','POST',{invitation},{'X-Forwarded-Proto':'https'})).status,403);
 let login=await send('/preview/login','POST',{invitation});assert.equal(login.status,200);const cookie=login.headers['set-cookie'][0].split(';')[0],csrf=JSON.parse(login.body).csrf,auth={Cookie:cookie,'X-Preview-CSRF':csrf};assert.match(login.headers['set-cookie'][0],/HttpOnly; Secure; SameSite=Strict/);
 assert.equal((await send('/','GET',undefined,auth)).body,'private app');assert.equal((await send('/scene/state','GET',undefined,auth)).status,200);assert.equal(last.cookie,undefined);assert.equal(last.authorization,undefined);assert.equal(last.origin,undefined);
 hold=true;const pending=send('/scene/state','GET',undefined,auth);while(!release)await new Promise(r=>setTimeout(r,2));assert.equal((await send('/','GET',undefined,auth)).status,429);release();assert.equal((await pending).status,200);release=null;assert.equal((await send('/scene/state','GET',undefined,auth)).status,502);hold=false;
 assert.equal((await send('/scene/interaction-close','POST',{}, {Cookie:cookie})).status,403);
 assert.equal((await send('/scene/usage-select','POST',{ownerId:'someone'},auth)).status,400);
 assert.equal((await send('/scene/usage-select','POST',{}, {...auth,Authorization:'Bearer injected'})).status,403);
 assert.equal((await send('/scene/usage-select','POST',{},auth)).status,200);assert.equal(last['x-summon-lab'],'synthetic');
 assert.equal((await send('/scene/interaction-close','POST',{},auth)).status,502);
 assert.equal((await send('/unknown','POST',{},auth)).status,404);
 assert.equal((await send('/scene/usage-select','POST',{text:'x'.repeat(5000)},auth)).status,413);
 assert.equal((await send('/preview/logout','POST',{},auth)).status,200);assert.equal((await send('/','GET',undefined,auth)).status,401);
 login=await send('/preview/login','POST',{invitation});const cookie2=login.headers['set-cookie'][0].split(';')[0];now=1001;assert.equal((await send('/','GET',undefined,{Cookie:cookie2})).status,401);
 login=await send('/preview/login','POST',{invitation});server.removeListener('request',gate);gate.close();gate=createProtectedPreview(options);server.on('request',gate);assert.equal((await send('/','GET',undefined,{Cookie:login.headers['set-cookie'][0].split(';')[0]})).status,401);
 now+=60000;login=await send('/preview/login','POST',{invitation});const lockedCookie=login.headers['set-cookie'][0].split(';')[0];for(let i=0;i<4;i++)assert.equal((await send('/preview/login','POST',{invitation:'wrong'})).status,401);assert.equal((await send('/preview/login','POST',{invitation})).status,429);assert.equal((await send('/','GET',undefined,{Cookie:lockedCookie})).status,200); // Failed unauthenticated logins must not evict the owner.
 now+=60000;login=await send('/preview/login','POST',{invitation});const rollbackCookie=login.headers['set-cookie'][0].split(';')[0];now-=1;assert.equal((await send('/','GET',undefined,{Cookie:rollbackCookie})).status,503);now+=2;assert.equal((await send('/','GET',undefined,{Cookie:rollbackCookie})).status,401);assert.ok(calls>=3);
 }finally{gate?.close();if(server)await close(server);if(upstream)await close(upstream);rmSync(dir,{recursive:true,force:true});}
});
test('configuration forbids remote upstream, short invitations and request-supplied asset traversal',()=>{
 const options={origin:'https://preview.example',invitation:'synthetic-test-invitation-not-a-real-secret-1234',upstream:'http://127.0.0.1:8091'};
 for(const upstream of ['http://localhost:8091','https://127.0.0.1:8091','http://127.0.0.1:8091/scene/state','http://user@127.0.0.1:8091','http://1.2.3.4:8091'])assert.throws(()=>createProtectedPreview({...options,upstream}));
 assert.throws(()=>createProtectedPreview({...options,invitation:'short'}));assert.throws(()=>createProtectedPreview({...options,assets:new Map([['/../secret',{body:Buffer.from('x'),type:'text/html'}]])}));
});
test('plain HTTP cannot impersonate direct TLS through forwarded headers',async()=>{
 const gate=createProtectedPreview({origin:'https://preview.example',invitation:'synthetic-test-invitation-not-a-real-secret-1234',upstream:'http://127.0.0.1:8091'});const server=http(gate);await listen(server);
 try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/preview/login',{headers:{Host:'preview.example','X-Forwarded-Proto':'https'}});assert.equal(r.status,403);assert.equal((await r.json()).error,'tls_host_required');}finally{gate.close();await close(server);}
});

test('real SceneLab through trusted TLS: text edits, explicit save, usage replay and strict transport boundaries',async()=>{
 const {SceneLab}=await import('../src/scene.js');
 const {createSceneServer}=await import('../src/scene-server.js');
 const {compileInteractionProgram}=await import('../src/interaction-program.js');
 const dir=mkdtempSync(join(tmpdir(),'preview-real-'));let lab,upstream,server,gate;
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  const cert=readFileSync(join(dir,'cert'));
  lab=new SceneLab(join(dir,'core'),join(dir,'sink'),{clock:()=>100});
  const program=compileInteractionProgram({schema:'temporary-interaction.v1',title:'Local text fixture',fields:[{id:'body',label:'Text',type:'multiline',required:true,maxLength:4000}],save:{primitive:'local-draft.save'}});
  lab.createInteraction({commandId:'create',sessionId:'text',context:lab.captureSenseContext(),program,source:{kind:'host-declaration',referenceId:'isolated-test',modelId:null}});
  upstream=createSceneServer(lab);await listen(upstream);
  server=https({key:readFileSync(join(dir,'key')),cert});await listen(server);
  const origin='https://localhost:'+server.address().port,invitation='synthetic-integration-invitation-only-not-secret-123';
  gate=createProtectedPreview({origin,invitation,upstream:'http://127.0.0.1:'+upstream.address().port});server.on('request',gate);
  let auth={};
  const send=(path,input,extra={})=>new Promise((resolve,reject)=>{
   const post=input!==undefined,data=post?(Buffer.isBuffer(input)?input:Buffer.from(JSON.stringify(input))):null;
   const r=request({hostname:'127.0.0.1',servername:'localhost',port:server.address().port,ca:cert,path,method:post?'POST':'GET',headers:{Host:new URL(origin).host,...auth,...(post?{Origin:origin,'Content-Type':'application/json'}:{}),...extra}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,value:JSON.parse(body)}));});r.on('error',reject);r.end(data);
  });
  assert.equal((await send('/scene/usage')).status,401);
  const login=await send('/preview/login',{invitation});assert.equal(login.status,200);auth={Cookie:login.headers['set-cookie'][0].split(';')[0],'X-Preview-CSRF':login.value.csrf};
  assert.deepEqual((await send('/scene/usage')).value.items,[]);
  assert.equal((await send('/scene/interaction-current')).value.sessionId,'text');
  assert.equal((await send('/scene/sense-capabilities')).status,404);
  assert.equal((await send('/scene/interaction-read')).status,404);
  assert.equal((await send('/scene/usage',{})).status,404);
  const initial=(await send('/scene/interaction-read',{sessionId:'text'})).value;
  const presented={commandId:'shown',sessionId:'text',context:initial.context,expectedRevision:initial.revision,programDigest:initial.program.programDigest,confirmation:'presented-explicitly'};
  assert.equal((await send('/scene/usage-presented',presented)).value.ack.usage.useCount,1);
  assert.equal((await send('/scene/usage-presented',presented)).value.replayed,true);
  assert.equal((await send('/scene/usage-query',{commandId:'shown'})).value.status,'completed');
  // >4 KiB UTF-8 request succeeds only on interaction-edit, not other routes.
  const text='文'.repeat(2000),edit={commandId:'edit',sessionId:'text',expectedRevision:1,changes:{body:text}};
  assert.equal((await send('/scene/interaction-edit',edit,{'X-Preview-CSRF':'wrong'})).status,403);
  assert.equal((await send('/scene/interaction-edit',edit)).status,200);
  assert.equal((await send('/scene/interaction-read',{sessionId:'text'})).value.draft.values.body,text);
  assert.equal((await send('/scene/interaction-save',{commandId:'bad-save',sessionId:'text',expectedRevision:2,confirmation:'not-confirmed'})).status,400);
  const save={commandId:'save',sessionId:'text',expectedRevision:2,confirmation:'save-local-draft'};
  const saved=await send('/scene/interaction-save',save);assert.equal(saved.status,200);assert.equal(saved.value.ack.fact,'local_note_saved');
  assert.equal((await send('/scene/interaction-save',save)).value.replayed,true);
  assert.equal((await send('/scene/interaction-query',{commandId:'save'})).value.status,'completed');
  assert.equal((await send('/scene/interaction-saved',{noteId:saved.value.ack.noteId})).value.draft.values.body,text);
  const afterSave=(await send('/scene/interaction-read',{sessionId:'text'})).value;
  assert.equal((await send('/scene/interaction-close',{commandId:'close',sessionId:'text',expectedRevision:afterSave.revision})).status,200);
  assert.equal((await send('/scene/interaction-read',{sessionId:'text'})).value.error,'interaction_session_closed');
  assert.equal((await send('/scene/interaction-saved',{noteId:saved.value.ack.noteId})).value.draft.values.body,text);
  const select={commandId:'select',creatureId:'work',context:lab.captureSenseContext()};
  assert.equal((await send('/scene/usage-select',select)).value.ack.usage.recorded,true);
  assert.equal((await send('/scene/usage-select',select)).value.replayed,true);
  assert.equal((await send('/scene/usage-query',{commandId:'x',padding:'文'.repeat(2000)})).status,413);
  assert.equal((await send('/scene/interaction-edit',Buffer.from('x'.repeat(128*1024+1)))).status,413);
  const malformed=Buffer.concat([Buffer.from('{"commandId":"invalid'),Buffer.from([0xc3,0x28]),Buffer.from('"}')]);
  assert.equal((await send('/scene/usage-query',malformed)).value.error,'invalid_json');
  for(const path of ['interaction-generate','interaction-create','interaction-revise','handoff-prepare','text-request','sense','sense-confirm','speak','route-speak','sense-route-confirm','creature-select','unknown'])assert.equal((await send('/scene/'+path,{})).status,404);
  assert.equal((await send('/scene/interaction-read',{sessionId:'text',ownerId:'other'})).status,400);
  assert.equal((await send('/scene/usage-select',{...select,commandId:'evil'},{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await send('/preview/logout',{})).status,200);
  assert.equal((await send('/scene/interaction-saved',{noteId:saved.value.ack.noteId})).status,401);
 }finally{gate?.close();if(server)await close(server);if(upstream)await close(upstream);lab?.close();rmSync(dir,{recursive:true,force:true});}
});
