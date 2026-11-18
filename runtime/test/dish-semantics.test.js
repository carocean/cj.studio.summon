import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {compileDishSemanticProposal} from '../src/dish-semantics.js';import {LocalDishInterpreter} from '../src/local-dish-interpreter.js';
const completion=proposal=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(proposal)}}]});
async function fixture(t,handler){const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return new LocalDishInterpreter({endpoint:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,modelId:'controlled-fixture',timeoutMs:200});}
const input={text:'这碗讲讲呗',currentDish:{id:'soup',name:'菌菇汤'}};
const send=(res,body)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
test('proposal compiler confines explanation to current dish, preserves abstention and grants no authority',()=>{
 const p=compileDishSemanticProposal({kind:'explain',target:'current-dish'});assert.equal(p.authorityGranted,false);assert.equal(p.semanticsVerified,false);assert.ok(Object.isFrozen(p));
 for(const bad of [{kind:'explain',target:'other'},{kind:'explain',target:'current-dish',action:'pay'},{kind:'order'},{kind:'clarify',question:''},{kind:'none',reason:'x'.repeat(241)}])assert.throws(()=>compileDishSemanticProposal(bad));
 assert.equal(compileDishSemanticProposal({kind:'clarify',question:'你指哪道菜？'}).kind,'clarify');
});
test('local model adapter sends bounded JSON context and rejects remote/configured authority',async t=>{
 let request;const interpreter=await fixture(t,async(req,res)=>{let text='';for await(const c of req)text+=c;request={headers:req.headers,body:JSON.parse(text)};send(res,completion({kind:'explain',target:'current-dish'}));});
 const result=await interpreter.interpret(input);assert.equal(result.proposal.kind,'explain');assert.equal(request.headers.authorization,undefined);assert.deepEqual(JSON.parse(request.body.messages[1].content),{utterance:input.text,currentDish:input.currentDish});assert.equal(request.body.chat_template_kwargs.enable_thinking,false);
 for(const endpoint of ['https://example.com/v1/chat/completions','http://localhost:123/v1/chat/completions','http://127.0.0.1:123/v1/chat/completions?key=x'])assert.throws(()=>new LocalDishInterpreter({endpoint,modelId:'x',timeoutMs:200}));
 await assert.rejects(interpreter.interpret({...input,text:'x'.repeat(4001)}));await assert.rejects(interpreter.interpret({...input,currentDish:{...input.currentDish,ownerId:'x'}}));
});
test('malformed, tool, wrong target and truncated model outputs never become a valid proposal',async t=>{
 let value;const interpreter=await fixture(t,(_req,res)=>send(res,value));
 for(const c of [completion({kind:'explain',target:'another'}),completion({kind:'explain',target:'current-dish',permission:true}),{choices:[{finish_reason:'length',message:{role:'assistant',content:'{}'}}]},{choices:[{finish_reason:'stop',message:{role:'assistant',content:'{}',tool_calls:[]}}]}]){value=c;await assert.rejects(interpreter.interpret(input));}
 value=completion({kind:'none',reason:'不是当前介绍请求'});assert.equal((await interpreter.interpret(input)).proposal.kind,'none');
});
test('preabort, in-flight abort and concurrency fail without keyword fallback',async t=>{
 let entered;const started=new Promise(r=>entered=r);const interpreter=await fixture(t,(_req,res)=>{entered();setTimeout(()=>send(res,completion({kind:'explain',target:'current-dish'})),80);});
 await assert.rejects(interpreter.interpret(input,{signal:AbortSignal.abort()}),{code:'planner_aborted'});
 const controller=new AbortController(),p=interpreter.interpret(input,{signal:controller.signal}),checked=assert.rejects(p,{code:'planner_aborted'});await started;await assert.rejects(interpreter.interpret(input),{code:'planner_busy'});controller.abort();await checked;
});
