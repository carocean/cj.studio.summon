import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:https';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createProtectedPreview} from '../src/protected-preview.js';
import {PREVIEW_RENDER_HTML,PREVIEW_RENDER_KIND,DEFAULT_PREVIEW_CSP} from '../src/preview-render-profile.js';
const invitation='synthetic-render-test-invitation-aaaaaaaaaaaaaaaaaaa';
const options={origin:'https://localhost:8443',invitation,upstream:'http://127.0.0.1:8091'};
const assets=()=>new Map([['/',{type:'text/html',body:Buffer.from(PREVIEW_RENDER_HTML)}],['/flutter_bootstrap.js',{type:'text/javascript',body:Buffer.from('// trusted test script; no engine launched')}]]);
const renderProfile={kind:PREVIEW_RENDER_KIND};

test('render opt-in exact configuration and canonical HTML; no getters or aliases',()=>{
 for(const invalid of [undefined,false,true,{},[],{kind:'other'},{kind:PREVIEW_RENDER_KIND,nonce:'fixed'},new Proxy(renderProfile,{})]){
  if(invalid===undefined)continue; // omitted means legacy default
  assert.throws(()=>createProtectedPreview({...options,assets:assets(),renderProfile:invalid}),/invalid_preview_render_profile/);
 }
 const getter={get kind(){throw Error('getter must never execute');}};
 assert.throws(()=>createProtectedPreview({...options,assets:assets(),renderProfile:getter}),/invalid_preview_render_profile/);
 for(const html of [PREVIEW_RENDER_HTML.replace('zh-CN','en'),PREVIEW_RENDER_HTML+'<script>alert(1)</script>',PREVIEW_RENDER_HTML.replace('<head>','<head><base href="https://evil.invalid/">'),PREVIEW_RENDER_HTML.replace('</head>','<meta name="summon-preview-style-nonce" content="injected"></head>'),'<body onload="alert(1)">']){
  const a=assets();a.set('/',{type:'text/html',body:Buffer.from(html)});
  assert.throws(()=>createProtectedPreview({...options,assets:a,renderProfile}),/invalid_preview_render_profile/);
 }
 for(const alias of ['/index.html','/other.html']){const a=assets();a.set(alias,a.get('/'));assert.throws(()=>createProtectedPreview({...options,assets:a,renderProfile}),/invalid_preview_render_profile/);}
 for(const mutate of [a=>a.delete('/'),a=>a.delete('/flutter_bootstrap.js'),a=>a.set('/flutter_bootstrap.js',{type:'application/json',body:Buffer.from('{}')})]){const a=assets();mutate(a);assert.throws(()=>createProtectedPreview({...options,assets:a,renderProfile}),/invalid_preview_render_profile/);}
 const gate=createProtectedPreview({...options,assets:assets(),renderProfile});gate.close();
});

test('real trusted TLS emits fresh bound style nonce only on authenticated root; defaults and login unchanged',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'render-profile-'));let server,gate;
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  const cert=readFileSync(join(dir,'cert'));
  server=createServer({key:readFileSync(join(dir,'key')),cert},(req,res)=>gate(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='https://localhost:'+server.address().port;
  const a=assets();gate=createProtectedPreview({...options,origin,assets:a,renderProfile});
  // The constructor snapshots asset bytes; caller mutation cannot change served HTML/JS.
  a.get('/').body.fill(65);a.get('/flutter_bootstrap.js').body.fill(65);
  const send=(path,{body,headers={}}={})=>new Promise((resolve,reject)=>{
   const r=request({hostname:'127.0.0.1',servername:'localhost',port:server.address().port,ca:cert,path,method:body===undefined?'GET':'POST',headers:{Host:new URL(origin).host,...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});r.on('error',reject);r.end(body===undefined?undefined:JSON.stringify(body));
  });
  const unauthorized=await send('/');assert.equal(unauthorized.status,401);assert.equal(unauthorized.headers['content-security-policy'],DEFAULT_PREVIEW_CSP);assert.equal(unauthorized.headers['cache-control'],'no-store, private');
  const loginPage=await send('/preview/login');assert.equal(loginPage.headers['content-security-policy'],DEFAULT_PREVIEW_CSP);assert.doesNotMatch(loginPage.body,/summon-preview-style-nonce/);
  const login=await send('/preview/login',{body:{invitation}});assert.equal(login.status,200);
  const headers={Cookie:login.headers['set-cookie'][0].split(';')[0]};
  const first=await send('/',{headers}),second=await send('/',{headers:{...headers,'If-None-Match':'anything','If-Modified-Since':new Date().toUTCString()}});
  const nonce=r=>r.body.match(/name="summon-preview-style-nonce" content="([A-Za-z0-9_-]{43})"/)[1];
  assert.notEqual(nonce(first),nonce(second));
  for(const r of [first,second]){
   assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store, private');assert.equal(r.headers.etag,undefined);assert.equal(r.headers['last-modified'],undefined);
   assert.equal(r.body.match(/summon-preview-style-nonce/g).length,1);assert.doesNotMatch(r.body,/__SUMMON_PREVIEW_STYLE_NONCE__/);
   assert.match(r.headers['content-security-policy'],new RegExp("style-src 'self' 'nonce-"+nonce(r)+"'"));
   assert.match(r.headers['content-security-policy'],/script-src 'self' 'wasm-unsafe-eval'/);
   assert.doesNotMatch(r.headers['content-security-policy'],/'unsafe-eval'|'unsafe-inline'|https:|blob:|\*/);
   assert.match(r.headers['content-security-policy'],/worker-src 'none'/);
  }
  const script=await send('/flutter_bootstrap.js',{headers});assert.match(script.body,/trusted test script/);assert.equal(script.headers['content-security-policy'],DEFAULT_PREVIEW_CSP);
  assert.equal((await send('/index.html',{headers})).status,404);
  assert.equal((await send('/?renderProfile=flutter-canvaskit-v1',{headers})).status,400);
  assert.equal((await send('/preview/session',{body:{renderProfile},headers})).status,403); // no CSRF bypass
  gate.close();gate=createProtectedPreview({...options,origin,assets:assets()});
  const oldLogin=await send('/preview/login',{body:{invitation}});const oldHeaders={Cookie:oldLogin.headers['set-cookie'][0].split(';')[0]};
  const legacy=await send('/',{headers:oldHeaders});assert.equal(legacy.body,PREVIEW_RENDER_HTML);assert.equal(legacy.headers['content-security-policy'],DEFAULT_PREVIEW_CSP);
 }finally{gate?.close();if(server)await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
