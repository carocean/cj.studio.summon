import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {connect as tcpConnect} from 'node:net';
import {connect as tlsConnect} from 'node:tls';
import {restaurantConfig,startRestaurantPreview} from './restaurant_preview.mjs';
import {PREVIEW_RENDER_HTML} from '../../runtime/src/preview-render-profile.js';
test('developer launcher is opt-in and validates mode/port/required paths',()=>{
 assert.throws(()=>restaurantConfig({}),/opt_in/);
 assert.throws(()=>restaurantConfig({RESTAURANT_PREVIEW:'1',RESTAURANT_MODE:'remote'}),/invalid_restaurant_mode/);
 assert.throws(()=>restaurantConfig({RESTAURANT_PREVIEW:'1',RESTAURANT_PORT:'-1'}),/invalid_restaurant_port/);
 assert.throws(()=>restaurantConfig({RESTAURANT_PREVIEW:'1'}),/site_required/);
});
test('loopback prepared assets and fixed dish require TLS login plus explicit confirmation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'restaurant-launch-test-'));let app;
 try{
  const SITE=process.env.RESTAURANT_TEST_SITE??join(dir,'site');
  if(!process.env.RESTAURANT_TEST_SITE){mkdirSync(SITE);writeFileSync(join(SITE,'index.html'),PREVIEW_RENDER_HTML);writeFileSync(join(SITE,'flutter_bootstrap.js'),'/* controlled asset test, not Flutter rendering */');}
  const TLS_KEY=join(dir,'key'),TLS_CERT=join(dir,'cert'),INVITATION_FILE=join(dir,'invite'),invitation='a'.repeat(43);
  writeFileSync(INVITATION_FILE,invitation,{mode:0o600});
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',TLS_KEY,'-out',TLS_CERT,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  app=await startRestaurantPreview({mode:'controlled',port:0,SITE,TLS_KEY,TLS_CERT,INVITATION_FILE});
  assert.equal(app.ready.sessionId,'meal');assert.equal(app.ready.creatureId,'companion');assert.equal(app.ready.sceneRevision,1);assert.equal(app.ready.preparedState,'pending');assert.equal(app.ready.microphone,false);
  const origin=app.ready.origin,ca=readFileSync(TLS_CERT);let auth={};
  const send=(path,body,extra={})=>new Promise((resolve,reject)=>{
   const req=request(origin+path,{ca,method:body===undefined?'GET':'POST',headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...auth,...extra}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,value:res.headers['content-type']?.startsWith('application/json')?JSON.parse(text):null}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  assert.equal((await send('/')).status,401);
  if(process.env.RESTAURANT_TEST_SITE)assert.equal((await send('/main.dart.js')).status,401);
  const login=await send('/preview/login',{invitation});assert.equal(login.status,200);auth={Cookie:login.headers['set-cookie'][0].split(';')[0],'X-Preview-CSRF':login.value.csrf};
  const page=await send('/');assert.equal(page.status,200);assert.match(page.headers['content-security-policy'],/wasm-unsafe-eval/);assert.equal((await send('/flutter_bootstrap.js')).status,200);
  if(process.env.RESTAURANT_TEST_SITE){
   const release=await send('/main.dart.js');assert.equal(release.status,200);
   assert.equal(release.text,readFileSync(join(SITE,'main.dart.js'),'utf8'));
  }
  assert.equal((await send('/scene/state')).status,200);
  assert.equal((await send('/scene/usage')).status,200);
  assert.equal(app.ready.evidence.asr.engine,'controlled-fixture');
  assert.equal(app.ready.evidence.tts,null);
  for(const p of ['dish-command','dish-stopped','dish-confirmation-ingest','usage-select'])assert.equal((await send('/scene/'+p,{})).status,404);
  assert.equal((await send('/scene/dish-read',{sessionId:'other'})).status,400);
  assert.equal((await send('/scene/dish-read',{sessionId:'meal'})).value.focus.view,'none');
  const pending=(await send('/scene/dish-confirmation-read',{})).value;
  assert.equal((await send('/scene/dish-confirmation-respond',{interactionId:pending.interactionId,choice:'show'},{'X-Preview-CSRF':''})).status,403);
  assert.equal((await send('/scene/dish-read',{sessionId:'meal'})).value.focus.view,'none');
  const shown=await send('/scene/dish-confirmation-respond',{interactionId:pending.interactionId,choice:'show'});assert.equal(shown.value.state,'presented');
  assert.equal((await send('/scene/dish-read',{sessionId:'meal'})).value.focus.view,'details');
  assert.equal((await send('/scene/dish-confirmation-respond',{interactionId:pending.interactionId,choice:'show'})).value.state,'expired');
  await send('/preview/logout',{});assert.equal((await send('/')).status,401);
  // Raw pre-handshake TCP and a TLS connection with an incomplete HTTP body
  // must not keep shutdown/ephemeral database cleanup alive indefinitely.
  const port=Number(new URL(origin).port),raw=tcpConnect({host:'127.0.0.1',port});
  let partial;
  try{
   await new Promise((resolve,reject)=>{raw.once('connect',resolve);raw.once('error',reject);});
   partial=tlsConnect({host:'127.0.0.1',port,ca});
   await new Promise((resolve,reject)=>{partial.once('secureConnect',resolve);partial.once('error',reject);});
   partial.write('POST /preview/login HTTP/1.1\r\nHost: '+new URL(origin).host+'\r\nOrigin: '+origin+'\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{');
   await new Promise(resolve=>setTimeout(resolve,20));
   let timeout;
   try{await Promise.race([app.close(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('shutdown_not_bounded')),1000);})]);}
   finally{clearTimeout(timeout);}
   await app.close(); // Idempotent close shares the completed cleanup.
  }finally{raw.destroy();partial?.destroy();}
 }finally{await app?.close();rmSync(dir,{recursive:true,force:true});}
});
