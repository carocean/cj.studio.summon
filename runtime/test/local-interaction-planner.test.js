import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {LocalInteractionPlanner} from '../src/local-interaction-planner.js';
// Fixed HTTP fixtures exercise transport and validation, not model inference.
const form = {kind:'form',title:'测试登记',fields:[{key:'subject',label:'主题',type:'text',required:true},{key:'details',label:'说明',type:'multiline',required:false},{key:'state',label:'状态',type:'choice',required:false,choices:['甲','乙']}]};
const completion = (proposal = form) => ({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(proposal)}}]});
async function fixture(t, handler, timeoutMs = 1000) {
 const server = http.createServer(handler);
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 t.after(() => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));});
 const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
 return {server,endpoint,planner:new LocalInteractionPlanner({endpoint,modelId:'fixture-audit-label',timeoutMs})};
}
const json = (res, value) => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
const generate = planner => planner.generate({text:'请设计一个测试登记表'});
test('explicit opt-in configuration and literal loopback endpoint only', () => {
 const valid = {endpoint:'http://127.0.0.1:8080/v1/chat/completions',modelId:'audit',timeoutMs:1000};
 for (const endpoint of ['http://localhost:8080/v1/chat/completions','http://127.1:8080/v1/chat/completions','http://127.0.0.1/v1/chat/completions','http://127.0.0.1:0/v1/chat/completions','http://127.0.0.1:65536/v1/chat/completions','http://user@127.0.0.1:8080/v1/chat/completions',valid.endpoint+'?',valid.endpoint+'#',valid.endpoint+'/',valid.endpoint.replace('http:', 'https:')]) assert.throws(() => new LocalInteractionPlanner({...valid,endpoint}),{code:'planner_invalid_configuration'});
 for (const timeoutMs of [undefined,0,60001,1.5,'1000']) assert.throws(() => new LocalInteractionPlanner({...valid,timeoutMs}),{code:'planner_invalid_configuration'});
 assert.throws(() => new LocalInteractionPlanner(),{code:'planner_invalid_configuration'});
 assert.throws(() => new LocalInteractionPlanner({...valid,token:'secret'}),{code:'planner_invalid_configuration'});
 assert.equal(new LocalInteractionPlanner({...valid,modelId:'😀'.repeat(120)}).modelId,'😀'.repeat(120));
 assert.throws(() => new LocalInteractionPlanner({...valid,modelId:'😀'.repeat(121)}),{code:'planner_invalid_configuration'});
 const planner = new LocalInteractionPlanner(valid); assert.throws(() => {planner.modelId='changed';});
});
test('native HTTP request is plain JSON; compiler returns host constants without authority', async t => {
 let request;
 const {planner} = await fixture(t,async (req,res) => {let body='';for await (const chunk of req) body+=chunk;request={url:req.url,headers:req.headers,body:JSON.parse(body)};json(res,completion());});
 const result = await generate(planner);
 assert.equal(result.modelId,'fixture-audit-label');assert.equal(result.proposal.kind,'form');
 assert.equal(result.proposal.authorityGranted,false);assert.equal(result.proposal.semanticsVerified,false);
 assert.equal(result.proposal.program.declaration.save.primitive,'local-draft.save');
 assert.deepEqual(request.body.response_format,{type:'json_object'});assert.equal(request.body.temperature,0);assert.equal(request.body.seed,42);assert.equal(request.body.max_tokens,700);
 assert.equal(request.body.messages[1].content,'请设计一个测试登记表');assert.equal(request.headers.authorization,undefined);
 assert.deepEqual(Object.keys(request.body).sort(),['model','messages','response_format','temperature','seed','max_tokens','stream'].sort());
 assert.ok(!request.body.messages[0].content.includes('所有输入为合成'));assert.ok(Object.isFrozen(result));
});
test('clarification and abstention preserved; no model identity proof',async t => {
 let value = {kind:'clarify',question:'需要哪些字段？'};
 const {planner}=await fixture(t,(_req,res)=>json(res,{...completion(value),model:'unverified-server-label'}));
 assert.equal((await generate(planner)).proposal.kind,'clarify');value={kind:'none',reason:'不需要界面'};
 assert.equal((await generate(planner)).proposal.kind,'none');
});
test('unknown input/options, malformed Unicode and scalar bounds rejected without IO',async t => {
 let requests=0;const {planner}=await fixture(t,(_req,res)=>{requests++;json(res,completion());});
 for(const input of [{text:'ok',extra:true},{text:'\ud800'},{text:'x'.repeat(4001)},{text:''},{text:1},null])await assert.rejects(planner.generate(input),{code:'planner_invalid_input'});
 await assert.rejects(planner.generate({text:'ok'},{extra:true}),{code:'planner_invalid_input'});
 let invoked=false;await assert.rejects(planner.generate({get text(){invoked=true;return 'ok';}}),{code:'planner_invalid_input'});assert.equal(invoked,false);assert.equal(requests,0);
 await planner.generate({text:'😀'.repeat(4000)});assert.equal(requests,1);
});
test('compiler rejects unknown IR attributes, missing types, and never repairs model JSON',async t => {
 let content;const {planner}=await fixture(t,(_req,res)=>{const c=completion();c.choices[0].message.content=content;json(res,c);});
 for(const value of [{...form,save:true},{...form,fields:[{key:'a',label:'A',required:true}]},{...form,fields:[{...form.fields[0],default:'secret'}]}]){content=JSON.stringify(value);await assert.rejects(generate(planner),{code:'planner_invalid_proposal'});}
 for(content of ['```json\n'+JSON.stringify(form)+'\n```','{"kind":"form"',JSON.stringify(JSON.stringify(form))])await assert.rejects(generate(planner),{code:'planner_invalid_proposal'});
 content=JSON.stringify(form);assert.equal((await generate(planner)).proposal.kind,'form');
});
test('rejects truncated completions, multiple choices, nonassistant and tool/refusal properties',async t => {
 let value;const {planner}=await fixture(t,(_req,res)=>json(res,value));
 const cases=[];for(const finish_reason of ['length','tool_calls',null]){const c=completion();c.choices[0].finish_reason=finish_reason;cases.push(c);}
 for(const key of ['tool_calls','function_call','refusal','unknown']){const c=completion();c.choices[0].message[key]=null;cases.push(c);}
 const multiple=completion();multiple.choices.push(multiple.choices[0]);cases.push(multiple);
 const role=completion();role.choices[0].message.role='user';cases.push(role);
 for(value of cases)await assert.rejects(generate(planner),{code:'planner_invalid_response'});
});
test('HTTP errors and redirect are opaque and redirect target never requested',async t => {
 let status=500,hits=0;const {planner,endpoint}=await fixture(t,(_req,res)=>{hits++;res.writeHead(status,{Location:endpoint});res.end('private raw response');});
 for(const [s,code] of [[500,'planner_http_error'],[302,'planner_redirect']]){status=s;await assert.rejects(generate(planner),error=>error.code===code&&error.message===code&&!error.cause);}
 assert.equal(hits,2);
});
test('strict UTF8, JSON and streamed or declared 64 KiB bounds',async t => {
 let mode;const {planner}=await fixture(t,(_req,res)=>{
  if(mode==='utf8')res.end(Buffer.from([0xc3,0x28]));
  else if(mode==='json')res.end('not JSON');
  else if(mode==='declared'){res.setHeader('Content-Length','65537');res.end('x');}
  else {res.write('x'.repeat(32768));res.end('x'.repeat(32769));}
 });
 for(mode of ['utf8','json','declared','streamed'])await assert.rejects(generate(planner),{code:mode==='utf8'||mode==='json'?'planner_invalid_response':'planner_response_too_large'});
});
test('single-flight, caller cancellation, preabort and all cleanup permit reuse',async t => {
 let hang=true;let started;const seen=new Promise(resolve=>{started=resolve;});
 const {planner}=await fixture(t,(_req,res)=>{started();if(!hang)json(res,completion());});
 const controller=new AbortController();const pending=planner.generate({text:'测试'},{signal:controller.signal});await seen;
 await assert.rejects(generate(planner),{code:'planner_busy'});
 controller.abort('private reason');await assert.rejects(pending,{code:'planner_aborted'});
 await assert.rejects(planner.generate({text:'测试'},{signal:controller.signal}),{code:'planner_aborted'});
 hang=false;assert.equal((await generate(planner)).proposal.kind,'form');
});
test('timeout bounds delayed headers and stalled response body; releases concurrency',async t => {
 let mode='headers';const {planner}=await fixture(t,(_req,res)=>{if(mode==='body'){res.writeHead(200);res.write('{');}else if(mode==='ok')json(res,completion());},50);
 for(mode of ['headers','body'])await assert.rejects(generate(planner),{code:'planner_timeout'});
 mode='ok';assert.equal((await generate(planner)).proposal.kind,'form');
});
test('connection failure is opaque and releases concurrency',async t => {
 const {planner,server}=await fixture(t,(_req,res)=>json(res,completion()));
 await new Promise(resolve=>server.close(resolve));
 for(let i=0;i<2;i++)await assert.rejects(generate(planner),{code:'planner_transport_error'});
});
