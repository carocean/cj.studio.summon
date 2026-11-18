import test from 'node:test';import assert from 'node:assert/strict';
import {compileInteractionProposal as compile} from '../src/interaction-proposal.js';
import {compileInteractionProgram} from '../src/interaction-program.js';
const field={key:'body',label:'内容',type:'multiline',required:true};
const base={kind:'form',title:'合成记录',fields:[field]};
test('pure exact mapping supplies only disclosed host constants, preserving field order and identity',()=>{
 const raw={...base,fields:[{key:'title',label:'主题',type:'text',required:false},field,{key:'stage',label:'状态',type:'choice',required:false,choices:['甲','乙']}]};
 const before=JSON.stringify(raw),result=compile(raw);
 assert.deepEqual(result.program,compileInteractionProgram({schema:'temporary-interaction.v1',title:raw.title,fields:[{id:'title',label:'主题',type:'text',required:false,maxLength:2000},{id:'body',label:'内容',type:'multiline',required:true,maxLength:4000},{id:'stage',label:'状态',type:'choice',required:false,options:[{value:'甲',label:'甲'},{value:'乙',label:'乙'}]}],save:{primitive:'local-draft.save'}}));
 assert.equal(result.authorityGranted,false);assert.equal(result.semanticsVerified,false);assert.equal(JSON.stringify(raw),before);assert.deepEqual(compile(raw),result);assert.ok(Object.isFrozen(result));
});
test('clarify and none do not compile programs or grant authority',()=>{for(const raw of [{kind:'clarify',question:'哪些字段？'},{kind:'none',reason:'并未请求界面'}]){const r=compile(raw);assert.equal(r.kind,raw.kind);assert.equal(r.program,undefined);assert.equal(r.authorityGranted,false);assert.equal(r.semanticsVerified,false);}});
test('closed envelopes reject tools, execution, defaults, values, moves and internal constants',()=>{
 for(const key of ['save','schema','values','moves','tools','authorityGranted','program'])assert.throws(()=>compile({...base,[key]:{}}));
 for(const key of ['id','default','value','maxLength','options','onChange'])assert.throws(()=>compile({...base,fields:[{...field,[key]:'x'}]}));
 for(const raw of [{kind:'none',reason:'x',fields:[]},{kind:'clarify',question:'x',save:true},{kind:'other'},{...base,fields:[]}])assert.throws(()=>compile(raw));
});
test('missing/invalid field types are never inferred or coerced',()=>{
 for(const key of Object.keys(field)){const f={...field};delete f[key];assert.throws(()=>compile({...base,fields:[f]}));}
 for(const type of ['string','Text',null,4])assert.throws(()=>compile({...base,fields:[{...field,type}]}));
 for(const required of ['true',0,null])assert.throws(()=>compile({...base,fields:[{...field,required}]}));
 for(const key of ['constructor','prototype','1body','bad-key','x'.repeat(33)])assert.throws(()=>compile({...base,fields:[{...field,key}]}));
});
test('production compiler rejects duplicate IDs, duplicate choices and all field bounds',()=>{
 assert.throws(()=>compile({...base,fields:[field,field]}));
 for(const choices of [[],['甲','甲'],[''],[1],Array.from({length:17},(_,i)=>String(i)),['x'.repeat(65)]])assert.throws(()=>compile({...base,fields:[{...field,type:'choice',choices}]}));
 for(const title of ['', ' '.repeat(3),'x'.repeat(121),'bad\n'])assert.throws(()=>compile({...base,title}));
 assert.throws(()=>compile({...base,fields:Array.from({length:17},(_,i)=>({...field,key:'k'+i}))}));
 assert.throws(()=>compile({...base,fields:[{...field,label:'x'.repeat(81)}]}));
});
test('plain strings, fenced JSON, proxies and accessors are not repaired or executed',()=>{
 assert.throws(()=>compile(JSON.stringify(base)));assert.throws(()=>compile('```json\n'+JSON.stringify(base)+'\n```'));let invoked=false;
 assert.throws(()=>compile({...base,get title(){invoked=true;return 'x';}}));assert.equal(invoked,false);
 assert.throws(()=>compile(new Proxy(base,{})));
});
test('abstention text is bounded and unambiguous but not certified truthful',()=>{
 for(const reason of ['', ' ', 'x'.repeat(241),'bad\n',null])assert.throws(()=>compile({kind:'none',reason}));
 const r=compile({kind:'none',reason:'已保存'});assert.equal(r.semanticsVerified,false); // semantics requires independent evaluation
});
test('aggregate IR byte cap rejects oversized otherwise bounded fields before mapping',()=>{
 const fields=Array.from({length:16},(_,i)=>({key:'f'+i,label:'选项',type:'choice',required:false,choices:Array.from({length:16},(_,j)=>String(j)+'界'.repeat(50))}));
 assert.throws(()=>compile({...base,fields}),{code:'interaction_proposal_size_limit'});
});
