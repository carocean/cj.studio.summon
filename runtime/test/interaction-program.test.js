import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../../microkernel/src/canonical.js';
import {compileInteractionProgram as compile,validateCompiledInteractionProgram as validateProgram,createInteractionDraft as empty,validateInteractionDraft as validate,updateInteractionDraft as edit,reviseInteractionProgram as revise} from '../src/interaction-program.js';
const text=(id='heading',extra={})=>({id,label:'临时字段',type:'text',required:true,maxLength:100,...extra});
const choice=(id='category')=>({id,label:'分组',type:'choice',required:false,options:[{value:'one',label:'一'},{value:'two',label:'二'}]});
const proposal=(fields=[text(),text('body',{type:'multiline',required:false,maxLength:4000}),choice()],title='临时记录')=>({schema:'temporary-interaction.v1',title,fields,save:{primitive:'local-draft.save'}});
const binding=(p,d)=>({expectedProgramDigest:p.programDigest,expectedDraftRevision:d.revision});
const change=(p,d,changes)=>edit(p,d,{...binding(p,d),changes});
const revision=(p,d,moves=[])=>({...binding(p,d),moves});
const copy=v=>structuredClone(v);

test('compiler accepts genuinely variable fields, literal labels and one non-authorizing local primitive',()=>{
 for(const fields of [[text('shoppingItem'),choice('priority')],[text('ideaNote',{type:'multiline',maxLength:800})],[text('next_7'),text('toString')]]){
  const input=proposal(fields),p=compile(input),d=empty(p);
  assert.deepEqual(p.declaration,input);assert.equal(p.revision,1);assert.equal(p.parentDigest,null);assert.equal(p.authorityGranted,false);assert.equal(p.semanticsVerified,false);
  assert.deepEqual(Object.keys(d.values).sort(),fields.map(f=>f.id).sort());assert.ok(Object.values(d.values).every(v=>v===null));assert.equal(d.revision,0);
  assert.deepEqual(validateProgram(p),p);assert.deepEqual(compile(input),p);
 }
 const input=proposal(),p=compile(input);input.fields[0].label='later mutation';assert.equal(p.declaration.fields[0].label,'临时字段');assert.throws(()=>{p.declaration.title='mutate';},TypeError);
 assert.equal(compile(proposal([text('literal',{label:'<tag> is plain text'})])).declaration.fields[0].label,'<tag> is plain text');
});
test('closed syntax refuses external primitives, code, URLs-as-actions, defaults and unknown field types',()=>{
 const cases=[{...proposal(),url:'https://example.com'},{...proposal(),code:'run()'},{...proposal(),save:{primitive:'http.post'}},{...proposal(),save:{primitive:'local-draft.save',path:'/tmp/chosen-by-model'}},proposal([text('x',{default:'invented'})]),proposal([text('x',{type:'password'})]),proposal([text('x',{onChange:'execute'})])];
 for(const p of cases)assert.throws(()=>compile(p));
 assert.equal(Object.hasOwn(compile(proposal()),'receipt'),false);
});
test('IDs, labels, field cardinality and options have closed deterministic bounds',()=>{
 for(const id of ['__proto__','constructor','prototype','a.b','a/b','x'.repeat(33),''])assert.throws(()=>compile(proposal([text(id)])));
 for(const fields of [[],Array.from({length:17},(_,i)=>text('f'+i)),[text('a'),text('a')]])assert.throws(()=>compile(proposal(fields)));
 for(const value of ['', 'x'.repeat(121), 'title\nnew'])assert.throws(()=>compile(proposal([text()],value)));
 for(const field of [text('x',{label:'x'.repeat(81)}),text('x',{maxLength:0}),text('x',{maxLength:2001}),text('x',{maxLength:1.5}),text('x',{required:1})])assert.throws(()=>compile(proposal([field])));
 for(const options of [[],[{value:'same',label:'a'},{value:'same',label:'b'}],[{value:'',label:'a'}],[{value:'a',label:'b',script:'x'}],Array.from({length:17},(_,i)=>({value:''+i,label:'x'}))])assert.throws(()=>compile(proposal([{...choice(),options}])));
 assert.equal(compile(proposal(Array.from({length:16},(_,i)=>text('f'+i)))).declaration.fields.length,16);
});
test('bounded snapshots reject executable accessors, proxies, cycles and oversized declarations without running them',()=>{
 let invoked=false;const bad=proposal();Object.defineProperty(bad,'title',{enumerable:true,get(){invoked=true;return 'unsafe';}});
 assert.throws(()=>compile(bad));assert.throws(()=>compile(new Proxy(proposal(),{ownKeys(){invoked=true;return [];}})));assert.equal(invoked,false);
 const cyclic=proposal();cyclic.self=cyclic;assert.throws(()=>compile(cyclic));
 const options=Array.from({length:16},(_,i)=>({value:(i+'a').padEnd(64,'a'),label:'界'.repeat(80)}));
 assert.throws(()=>compile(proposal(Array.from({length:8},(_,i)=>({...choice('c'+i),options})))),{code:'interaction_size_limit'});
});
test('compiled digest binds declaration/order/version and flags cannot pretend authority or quality',()=>{
 const p=compile(proposal());for(const mutation of [v=>v.declaration.title='another',v=>v.declaration.fields.reverse(),v=>v.revision=2]){const altered=copy(p);mutation(altered);assert.throws(()=>validateProgram(altered));}
 for(const flags of [{authorityGranted:true},{semanticsVerified:true},{extra:'x'}])assert.throws(()=>validateProgram({...p,...flags}));
 assert.notEqual(compile(proposal([choice(),text()])).programDigest,compile(proposal([text(),choice()])).programDigest);
});
test('draft edits are separate host inputs; exact fields, types, unicode lengths and complete validation',()=>{
 const p=compile(proposal([text('title',{maxLength:2}),text('note',{type:'multiline',required:false,maxLength:20}),choice()]));let d=empty(p);
 assert.throws(()=>validate(p,d,{requireComplete:true}),{code:'interaction_required_value'});
 d=change(p,d,{title:'😀界',note:'a\nb\tc',category:'two'});assert.equal(d.revision,1);assert.deepEqual(validate(p,d,{requireComplete:true}),d);
 for(const changes of [{title:'😀界a'},{title:42},{title:false},{title:{}},{title:'a\nb'},{note:'a\u0000b'},{category:'invented'},{other:'unknown'}])assert.throws(()=>change(p,d,changes));
 const blank=change(p,d,{title:' '});assert.throws(()=>validate(p,blank,{requireComplete:true}),{code:'interaction_required_value'});
 assert.throws(()=>validate(p,{...d,values:{title:'hi'}}));assert.throws(()=>validate(p,{...d,programDigest:'sha256:'+'0'.repeat(64)}));
 assert.throws(()=>validate(p,d,{requireComplete:'yes'}));assert.equal(d.values.title,'😀界');
});
test('old program and draft revisions cannot edit or rebase newer input',()=>{
 const p=compile(proposal()),d=empty(p),filled=change(p,d,{heading:'user input'});
 assert.throws(()=>edit(p,filled,{...binding(p,d),changes:{heading:'late'}}),{code:'interaction_version_conflict'});
 assert.throws(()=>revise(p,filled,proposal(),revision(p,d)),{code:'interaction_version_conflict'});
 assert.throws(()=>edit(p,filled,{...binding(p,filled),expectedProgramDigest:'wrong',changes:{}}),{code:'interaction_version_conflict'});
 assert.equal(filled.values.heading,'user input');
});
test('new program versions retain exact input by stable ID and add empty fields, not model defaults',()=>{
 const p=compile(proposal()),d=change(p,empty(p),{heading:'my title',body:'line1\nline2',category:'two'});
 const next=proposal([choice(),text('extra',{required:false}),text('body',{type:'multiline',required:false,maxLength:4000}),text()], '重新组织');
 const result=revise(p,d,next,revision(p,d));
 assert.equal(result.program.revision,2);assert.equal(result.program.parentDigest,p.programDigest);assert.equal(result.draft.revision,d.revision+1);
 assert.deepEqual(result.draft.values,{body:'line1\nline2',category:'two',extra:null,heading:'my title'});assert.deepEqual(validate(result.program,result.draft),result.draft);
 assert.throws(()=>edit(result.program,result.draft,{...binding(p,d),changes:{}}),{code:'interaction_version_conflict'});
});
test('removal, incompatible constraints, option removal and populated type changes never silently lose values',()=>{
 const p=compile(proposal()),d=change(p,empty(p),{heading:'kept',body:'',category:'two'});
 for(const next of [proposal([choice()]),proposal([text('heading',{maxLength:2}),text('body',{type:'multiline',required:false,maxLength:4000}),choice()]),proposal([text(),text('body',{type:'multiline',required:false,maxLength:4000}),{...choice(),options:[{value:'one',label:'一'}]}]),proposal([text('heading',{type:'multiline'}),text('body',{type:'multiline',required:false,maxLength:4000}),choice()])])assert.throws(()=>revise(p,d,next,revision(p,d)));
 assert.deepEqual(d.values,{body:'',category:'two',heading:'kept'});
 // A separately explicit host/user edit can clear a field before removal.
 const cleared=change(p,d,{body:null,category:null});const result=revise(p,cleared,proposal([text()]),revision(p,cleared));assert.deepEqual(result.draft.values,{heading:'kept'});
});
test('explicit field moves preserve exact value; collisions/duplicates/unknown references are rejected',()=>{
 const p=compile(proposal([text('old'),text('other',{required:false})])),d=change(p,empty(p),{old:'保留原文',other:'second'}),next=proposal([text('renamed'),text('other',{required:false})]);
 assert.throws(()=>revise(p,d,next,revision(p,d)),{code:'interaction_value_would_be_lost'});
 const result=revise(p,d,next,revision(p,d,[{from:'old',to:'renamed'}]));assert.equal(result.draft.values.renamed,'保留原文');
 for(const moves of [[{from:'missing',to:'renamed'}],[{from:'old',to:'missing'}],[{from:'old',to:'other'}],[{from:'old',to:'renamed'},{from:'old',to:'other'}],[{from:'old',to:'renamed',value:'changed'}]])assert.throws(()=>revise(p,d,next,revision(p,d,moves)));
 // Explicit swaps are bijections, not coercion or duplication.
 const swapped=revise(p,d,p.declaration,revision(p,d,[{from:'old',to:'other'},{from:'other',to:'old'}]));assert.deepEqual(swapped.draft.values,{old:'second',other:'保留原文'});
});
test('draft byte cap and revision exhaustion fail with immutable previous state intact',()=>{
 const p=compile(proposal(Array.from({length:8},(_,i)=>text('f'+i,{type:'multiline',maxLength:4000})))),d=empty(p);
 assert.throws(()=>change(p,d,Object.fromEntries(p.declaration.fields.map(f=>[f.id,'x'.repeat(4000)]))),{code:'interaction_size_limit'});assert.ok(Object.values(d.values).every(v=>v===null));
 const exhausted={...d,revision:Number.MAX_SAFE_INTEGER};assert.throws(()=>change(p,exhausted,{f0:'x'}),{code:'interaction_revision_exhausted'});
 const core={schema:p.schema,revision:Number.MAX_SAFE_INTEGER,parentDigest:p.programDigest,declaration:p.declaration};
 const terminal={...core,programDigest:digest('interaction-program',core),authorityGranted:false,semanticsVerified:false};
 assert.throws(()=>revise(terminal,empty(terminal),p.declaration,revision(terminal,empty(terminal))),{code:'interaction_revision_exhausted'});
});

test('ASCII labels/values remain usable; real C0/DEL characters obey text versus multiline boundaries',()=>{
 const p=compile(proposal([text('amount',{label:'Quantity / Units 2026'}),text('notes',{label:'Notes: body',type:'multiline',required:false,maxLength:100})],'Budget 2026'));
 const d=change(p,empty(p),{amount:'Number 0-9: value',notes:'ASCII\twords\nnext\rline'});assert.equal(d.values.amount,'Number 0-9: value');
 for(const code of [...Array(32).keys(),127]){
  const c=String.fromCharCode(code);
  assert.throws(()=>compile(proposal([text('x',{label:'a'+c+'b'})])));
  assert.throws(()=>change(p,d,{amount:'a'+c+'b'}));
  if(![9,10,13].includes(code))assert.throws(()=>change(p,d,{notes:'a'+c+'b'}));
 }
});
test('populated stable-ID labels cannot silently change interpretation, especially selected choice labels',()=>{
 const p=compile(proposal()),d=change(p,empty(p),{heading:'remember me',category:'two'});
 const renamed=copy(p.declaration);renamed.fields[0].label='Different meaning';
 assert.throws(()=>revise(p,d,renamed,revision(p,d)),{code:'interaction_populated_label_change'});
 const reversed=copy(p.declaration);reversed.fields[2].options[1].label='Not the previous option';
 assert.throws(()=>revise(p,d,reversed,revision(p,d)),{code:'interaction_populated_label_change'});
 // An explicit host-approved move can retain the exact value under a new field.
 const moved=copy(p.declaration);moved.fields[0].id='renamed';moved.fields[0].label='Explicitly renamed field';
 assert.equal(revise(p,d,moved,revision(p,d,[{from:'heading',to:'renamed'}])).draft.values.renamed,'remember me');
});
