import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenPortsReadBridge } from '../src/openports.js';
import { createApi } from '../src/http.js';
import { Kernel } from '../src/kernel.js';
import { Runtime } from '../src/runtime.js';
import { DemoProvider } from '../src/providers.js';
import { ServiceScheduler } from '../src/services.js';
const payload = (text='Hello Summon!') => JSON.stringify({status:200,message:'ok',dataText:JSON.stringify(text)});
async function local(handler, work) {
  const server=createServer(handler); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {await work(`http://127.0.0.1:${server.address().port}/hello/helloworld.ports`);} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
}
test('OpenPorts actual gzip HTTP decodes envelope and nested data without identity leakage',async()=>{
  await local((req,res)=>{
    assert.equal(req.url,'/hello/helloworld.ports?name=Summon');
    assert.equal(req.headers['rest-command'],'helloworld'); assert.equal(req.headers['accept-encoding'],'gzip');
    assert.equal(req.headers.cjtoken,'fixture-connector-token'); assert.equal(req.headers.authorization,undefined);
    res.writeHead(200,{'Content-Type':'text/html','Content-Encoding':'gzip'});res.end(gzipSync(payload()));
  },async endpoint=>{
    const data=await new OpenPortsReadBridge({endpoint,token:'fixture-connector-token'}).readHello();
    assert.equal(data.text,'Hello Summon!');assert.equal(data.identityForwarded,false);assert.equal(JSON.stringify(data).includes('fixture-connector-token'),false);
  });
});
test('OpenPorts rejects unsafe config, redirects, framing, malformed and oversized responses',async()=>{
  for(const endpoint of ['http://example.com/helloworld.ports','https://user:pass@example.com/helloworld.ports','https://example.com/anything','https://example.com/helloworld.ports?token=x'])assert.throws(()=>new OpenPortsReadBridge({endpoint}));
  const cases=[
    [(q,r)=>{r.writeHead(302,{Location:'http://127.0.0.1:1/'});r.end();},'openports_unavailable'],
    [(q,r)=>{r.writeHead(401);r.end('private details');},'openports_http_failure'],
    [(q,r)=>{r.writeHead(200,{'Content-Length':0});r.end();},'openports_empty_response'],
    [(q,r)=>r.end('bad json'),'openports_invalid_json'],
    [(q,r)=>r.end(JSON.stringify({status:500,message:'secret'})),'openports_business_failure'],
    [(q,r)=>r.end(JSON.stringify({status:200,dataText:'not nested json'})),'openports_invalid_data'],
    [(q,r)=>{r.writeHead(200,{'Content-Encoding':'gzip'});r.end(gzipSync('a'.repeat(40000)));},'openports_response_limit'],
  ];
  for(const [handler,code] of cases)await local(handler,async endpoint=>assert.rejects(new OpenPortsReadBridge({endpoint}).readHello(),{code}));
  await local(()=>{},async endpoint=>assert.rejects(new OpenPortsReadBridge({endpoint,timeoutMs:30}).readHello(),{code:'openports_timeout'}));
});
test('bridge scheduling checks owner, grant, space, renderer and generation, never discovers by executing',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'summon-bridge-'));const k=new Kernel(join(dir,'state.json'));
  const subject=k.createSubject('owner',{name:'bridge subject'});k.mount('owner',subject.id,'ecm.hello.read');
  const runtime=new Runtime(new DemoProvider(),{kernel:k});let count=0,finish;
  const scheduler=new ServiceScheduler(runtime,{openports:{readHello(){count++;return new Promise(r=>finish=r);}}});
  const request={creatureId:subject.id,serviceId:'ecm.hello.read',arguments:{},context:{zone:'demo-world',renderers:['text']}};
  try {
    const discovered=scheduler.discoverAcross('owner',{serviceId:'ecm.hello.read',context:request.context});assert.equal(discovered.executed,false);assert.equal(count,0);
    await assert.rejects(scheduler.invoke('other',request),{code:'subject_not_found'});
    await assert.rejects(scheduler.invoke('owner',{...request,arguments:{endpoint:'https://evil.test'}}),{code:'unsupported_bridge_arguments'});
    const pending=scheduler.invoke('owner',request);assert.equal(count,1);
    k.mount('owner',subject.id,'ecm.hello.read',false);k.mount('owner',subject.id,'ecm.hello.read',true);finish({text:'old output'});
    await assert.rejects(pending,{code:'authorization_changed'});
    const disabled=new ServiceScheduler(runtime);await assert.rejects(disabled.invoke('owner',request),{code:'business_bridge_unavailable'});
  } finally {k.close();rmSync(dir,{recursive:true});}
});
test('opt-in actual ECM OpenPorts runtime through AIOS scheduler', {skip:!process.env.OPENPORTS_REAL_TEST_ENDPOINT},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'summon-real-bridge-'));const k=new Kernel(join(dir,'state.json'));
  try {
    const subject=k.createSubject('owner',{name:'ECM protocol probe'});k.mount('owner',subject.id,'ecm.hello.read');
    const token='test-token-not-real-credential-12345';
    const api=createApi(new Runtime(new DemoProvider(),{kernel:k}),{appToken:token,ownerId:'owner',kernel:k,openports:new OpenPortsReadBridge({endpoint:process.env.OPENPORTS_REAL_TEST_ENDPOINT})});
    await new Promise(r=>api.listen(0,'127.0.0.1',r));
    try {
      const url=`http://127.0.0.1:${api.address().port}/v1/invocations`;
      const body=JSON.stringify({creatureId:subject.id,serviceId:'ecm.hello.read',context:{zone:'demo-world',renderers:['text']}});
      assert.equal((await fetch(url,{method:'POST',body})).status,401);
      const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body});
      assert.equal(response.status,200);const result=await response.json();
      assert.equal(result.data.text,'Hello Summon!');assert.equal(result.status,'completed');assert.equal(result.demo,false);assert.equal(result.data.readOnly,true);
    } finally {api.closeAllConnections();await new Promise(r=>api.close(r));}
  } finally {k.close();rmSync(dir,{recursive:true});}
});

test('bridge refuses credential echoes and bounds concurrent upstream work with release',async()=>{
  const token='fixture-sensitive-connector-token';
  for(const text of [token,encodeURIComponent(token),Buffer.from(token).toString('base64')]) {
    await local((q,r)=>r.end(payload('echo '+text)),async endpoint=>{
      const bridge=new OpenPortsReadBridge({endpoint,token});
      await assert.rejects(bridge.readHello(),{code:'openports_sensitive_response'});assert.equal(bridge.active,0);
    });
  }
  let calls=0;const resolvers=[];
  const bridge=new OpenPortsReadBridge({endpoint:'http://127.0.0.1/hello/helloworld.ports',fetchImpl:async()=>{calls++;return new Promise(r=>resolvers.push(()=>r(new Response(payload()))));}});
  const a=bridge.readHello(),b=bridge.readHello();await assert.rejects(bridge.readHello(),{code:'openports_busy'});assert.equal(calls,2);
  resolvers.splice(0).forEach(r=>r());await Promise.all([a,b]);assert.equal(bridge.active,0);
  const c=bridge.readHello();resolvers.pop()();await c;assert.equal(bridge.active,0);
});
