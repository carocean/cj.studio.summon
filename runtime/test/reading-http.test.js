import test from 'node:test';import assert from 'node:assert/strict';
import {createServer as https,request as httpsRequest} from 'node:https';import {request as httpRequest} from 'node:http';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {SceneLab} from '../src/scene.js';import {createSceneServer} from '../src/scene-server.js';import {createProtectedPreview} from '../src/protected-preview.js';import {compileReadingResource} from '../src/reading-surface.js';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r)),close=s=>new Promise(r=>s.close(r));
const resource=(id,text)=>compileReadingResource({schema:'reading-resource.v1',resourceId:id,provenance:{kind:'host-declared',referenceId:'synthetic'},blocks:[{id:'first',text}]});
const presentation={background:'#ffccdd',fontRef:'SummonPreviewSC',textScalePermille:1000,flow:'scroll',pageControls:false};
for(const tls of [false,true])test(`${tls?'trusted temporary TLS':'real loopback HTTP'} reading refs only: auth/defaults, two resources, unknown response, revoke, bytes and restart`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'reading-http-'));let lab,upstream,server,gate,db;
 try{
  lab=new SceneLab(join(dir,'core'),join(dir,'sink'),{readingOptions:{installedFontIds:['SummonPreviewSC'],maxCommandsPerOwner:3}});upstream=createSceneServer(lab);await listen(upstream);server=upstream;
  let origin='http://127.0.0.1:'+server.address().port,cert,auth={};const invitation='synthetic-reading-invitation-aaaaaaaaaaaaaaaaaaaa';
  if(tls){execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});cert=readFileSync(join(dir,'cert'));server=https({key:readFileSync(join(dir,'key')),cert},(req,res)=>gate(req,res));await listen(server);origin='https://localhost:'+server.address().port;gate=createProtectedPreview({origin,invitation,upstream:'http://127.0.0.1:'+upstream.address().port});}
  const send=(path,input,extra={})=>new Promise((resolve,reject)=>{const data=input===undefined?undefined:Buffer.isBuffer(input)?input:Buffer.from(JSON.stringify(input));const request=tls?httpsRequest:httpRequest;
   const r=request({hostname:'127.0.0.1',port:server.address().port,...(tls?{servername:'localhost',ca:cert}:{}),path,method:data?'POST':'GET',headers:{Host:new URL(origin).host,...auth,...(data?{'Content-Type':'application/json',...(tls?{Origin:origin}:{'X-Summon-Lab':'synthetic'})}:{}),...extra}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,value:JSON.parse(body)}));});r.on('error',reject);r.end(data);});
  if(tls){assert.equal((await send('/scene/reading-state')).status,401);const login=await send('/preview/login',{invitation});auth={Cookie:login.headers['set-cookie'][0].split(';')[0],'X-Preview-CSRF':login.value.csrf};assert.equal((await send('/scene/reading-open',{}, {'X-Preview-CSRF':''})).status,403);assert.equal((await send('/scene/reading-open',{}, {Origin:'https://evil.invalid'})).status,403);}
  const state=await send('/scene/reading-state');assert.equal(state.status,200);assert.equal(state.value.persistence,'volatile');const epoch=state.value.epoch;
  const a=resource('book-a','这是合成甲😀'),b=resource('book-b','这是合成乙');const ref=r=>({resourceId:r.resourceId,contentDigest:r.contentDigest});
  const openA={commandId:'open-a',epoch,viewId:'a',...ref(a),presentation};assert.equal((await send('/scene/reading-open',openA)).value.error,'reading_resource_not_installed');
  lab.installReadingResource(a);lab.installReadingResource(b);assert.equal((await send('/scene/reading-open',openA)).value.error,'reading_access_denied');
  for(const r of [a,b])lab.configureReadingAccess({...ref(r),enabled:true,expectedGeneration:0});
  db=new DatabaseSync(join(dir,'core'),{readOnly:true});const persisted=()=>JSON.stringify(['resources','commands','events'].map(t=>db.prepare('SELECT * FROM '+t).all()));const baseline=persisted(),usage=lab.usage();
  for(const extra of [{ownerId:'other'},{resource:a},{url:'https://example.invalid'},{enable:true},{evidence:{}}])assert.equal((await send('/scene/reading-open',{...openA,...extra})).status,400);
  const originalOpen=lab.openReading.bind(lab);let dropped=false,socket;
  upstream.on('request',req=>{if(req.url==='/scene/reading-open')socket=req.socket;});
  lab.openReading=raw=>{const result=originalOpen(raw);if(raw.commandId==='open-a'&&!dropped){dropped=true;socket.destroy();}return result;};
  try{const response=await send('/scene/reading-open',openA);assert.notEqual(response.status,200);}catch(e){assert.match(e.code??'',/ECONNRESET|EPIPE/);}
  assert.equal(dropped,true);const q=await send('/scene/reading-query',{epoch,commandId:'open-a'});assert.equal(q.value.status,'completed');assert.equal('resource' in q.value.ack,false);assert.equal(JSON.stringify(q.value).includes('合成'),false);
  assert.equal((await send('/scene/reading-open',openA)).value.replayed,true);assert.equal((await send('/scene/reading-open',{...openA,viewId:'changed'})).value.error,'reading_command_conflict');
  await send('/scene/reading-open',{...openA,...ref(b),commandId:'open-b',viewId:'b'});
  for(const [viewId,r] of [['a',a],['b',b]]){const read=await send('/scene/reading-read',{epoch,viewId});assert.equal(read.value.resource.contentDigest,r.contentDigest);assert.equal(read.value.resource.blocks[0].text,r.blocks[0].text);}
  const payload=JSON.stringify({epoch,commandId:'missing'});assert.equal((await send('/scene/reading-query',Buffer.from(payload+' '.repeat(4096-Buffer.byteLength(payload))))).value.status,'not_started');assert.equal((await send('/scene/reading-query',Buffer.from(payload+' '.repeat(4097-Buffer.byteLength(payload))))).status,413);
  assert.equal((await send('/scene/reading-read',Buffer.from([123,34,120,34,58,34,255,34,125]))).value.error,'invalid_json');
  for(const suffix of ['install','access','retire','presentation','anchor'])assert.equal((await send('/scene/reading-'+suffix,{})).status,404);
  lab.configureReadingAccess({...ref(a),enabled:false,expectedGeneration:1});assert.equal((await send('/scene/reading-read',{epoch,viewId:'a'})).value.error,'reading_access_denied');assert.equal((await send('/scene/reading-query',{epoch,commandId:'open-a'})).value.status,'completed');
  lab.configureReadingAccess({...ref(a),enabled:true,expectedGeneration:2});assert.equal((await send('/scene/reading-read',{epoch,viewId:'a'})).value.error,'reading_access_changed');
  assert.equal((await send('/scene/reading-close',{epoch,viewId:'a',commandId:'close-a',expectedRevision:1})).value.ack.fact,'reading_view_closed');assert.equal((await send('/scene/reading-read',{epoch,viewId:'a'})).value.error,'reading_view_closed');assert.equal((await send('/scene/reading-open',{...openA,viewId:'c',commandId:'capacity'})).value.error,'reading_command_capacity');
  assert.equal(persisted(),baseline);assert.deepEqual(lab.usage(),usage);db.close();db=null;
  lab.close();assert.equal((await send('/scene/reading-state')).value.error,'scene_lab_closed');assert.equal((await send('/scene/reading-query',{epoch,commandId:'open-a'})).value.error,'scene_lab_closed');
  const next=new SceneLab(join(dir,'core'),join(dir,'sink'),{readingOptions:{installedFontIds:['SummonPreviewSC']}});
  try{const nextEpoch=next.readingState().epoch;assert.notEqual(nextEpoch,epoch);assert.throws(()=>next.queryReading({epoch,commandId:'open-a'}),/reading_instance_lost/);assert.equal(next.queryReading({epoch:nextEpoch,commandId:'open-a'}).status,'not_started');next.installReadingResource(a);assert.throws(()=>next.openReading({...openA,epoch:nextEpoch}),/reading_access_denied/);}finally{next.close();}
 }finally{db?.close();gate?.close();if(server&&server!==upstream)await close(server);if(upstream)await close(upstream);lab?.close();rmSync(dir,{recursive:true,force:true});}
});
test('SceneLab default font capability is empty and host setup refuses injected authority',()=>{
 const dir=mkdtempSync(join(tmpdir(),'reading-default-'));let lab;try{lab=new SceneLab(join(dir,'core'),join(dir,'sink'));const r=resource('sample','synthetic');lab.installReadingResource(r);const ref={resourceId:r.resourceId,contentDigest:r.contentDigest};assert.throws(()=>lab.configureReadingAccess({...ref,enabled:true,expectedGeneration:0,ownerId:'other'}));lab.configureReadingAccess({...ref,enabled:true,expectedGeneration:0});assert.throws(()=>lab.openReading({commandId:'open',epoch:lab.readingState().epoch,viewId:'v',...ref,presentation}),/reading_font_unavailable/);}finally{lab?.close();rmSync(dir,{recursive:true,force:true});}
});
