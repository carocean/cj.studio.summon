import test from 'node:test';
import assert from 'node:assert/strict';
import {compileReadingResource,validateReadingResource,createReadingState,validateReadingState,validateReadingPresentationCapabilities,updateReadingPresentation,updateReadingAnchor,READING_LIMITS} from '../src/reading-surface.js';
const clone=v=>JSON.parse(JSON.stringify(v));
const caps={installedFontIds:['synthetic-sc','synthetic-serif']};
const style={background:'#ffffff',fontRef:'synthetic-sc',textScalePermille:1000,flow:'scroll',pageControls:false};
const declaration=(id='synthetic-a')=>({schema:'reading-resource.v1',resourceId:id,provenance:{kind:'host-declared',referenceId:'synthetic-fixture'},blocks:id==='synthetic-b'?[{id:'opening',text:'另一份测试文档：风、雨与😀。'},{id:'ending',text:'这份内容独立，不代表已核验书籍。'}]:[{id:'opening',text:'天地😀e\u0301。\n第二行。'},{id:'ending',text:'仅为测试文本，不是真实书籍。'}]});
const resource=(id)=>compileReadingResource(declaration(id));
const denied=(fn,code)=>assert.throws(fn,e=>!code||e.code===code);

test('two synthetic resources: immutable bounded compiled bytes, deterministic digest and explicit font capability',()=>{
 for(const id of ['synthetic-a','synthetic-b']){const raw=declaration(id),r=compileReadingResource(raw);assert.deepEqual(r,compileReadingResource(raw));assert(Object.isFrozen(r.blocks[0]));assert.equal(r.authorityGranted,false);raw.blocks[0].text='changed';assert.notEqual(r.blocks[0].text,raw.blocks[0].text);const s=createReadingState(r,style,caps);assert(Object.isFrozen(s.presentation));assert.deepEqual(s.anchor,{blockId:'opening',scalarOffset:0});assert.equal(s.revision,1);assert.equal(s.presentation.pageControls,false);assert.deepEqual(validateReadingState(r,s),s);denied(()=>createReadingState(r,style));denied(()=>createReadingState(r,style,{installedFontIds:[]}),'reading_font_unavailable');}
 assert.notDeepEqual(resource('synthetic-a').blocks,resource('synthetic-b').blocks);
 assert.notEqual(resource('synthetic-a').contentDigest,resource('synthetic-b').contentDigest);
});
test('style changes retain exact anchor; position changes retain exact presentation, including end-of-block',()=>{
 const r=resource();let s=createReadingState(r,style,caps);
 s=updateReadingAnchor(r,s,{expectedRevision:1,anchor:{blockId:'opening',scalarOffset:4}});const a=clone(s.anchor);
 for(const changes of [{background:'#ffc0cb'},{fontRef:'synthetic-serif'},{textScalePermille:1500},{flow:'paged'},{pageControls:true}]){const previous=s;s=updateReadingPresentation(r,s,{expectedRevision:s.revision,changes},caps);assert.deepEqual(s.anchor,a);assert.equal(s.revision,previous.revision+1);assert.notEqual(s,previous);}
 const old=clone(s.presentation);s=updateReadingAnchor(r,s,{expectedRevision:s.revision,anchor:{blockId:'ending',scalarOffset:[...r.blocks[1].text].length}});assert.deepEqual(s.presentation,old);
});
test('scalar offsets count supplementary Unicode once; combining boundary is valid but not a grapheme guarantee',()=>{
 const r=resource(),s=createReadingState(r,style,caps),text=r.blocks[0].text;assert.equal([...text][2],'😀');assert.equal([...text][3],'e');assert.equal([...text][4],'\u0301');
 const between=updateReadingAnchor(r,s,{expectedRevision:1,anchor:{blockId:'opening',scalarOffset:4}});assert.equal(between.anchor.scalarOffset,4);assert.equal([...text].slice(0,4).join(''),'天地😀e');assert.equal(text.slice(0,4),'天地😀');
 denied(()=>updateReadingAnchor(r,s,{expectedRevision:1,anchor:{blockId:'opening',scalarOffset:[...text].length+1}}),'invalid_reading_anchor');
 for(const text of ['\ud800','\udfff','a\ud800b'])denied(()=>compileReadingResource({...declaration(),blocks:[{id:'b',text}]}),'invalid_c1_value');
});
test('synthetic reflow projection changes page ordinal, never canonical anchor or persisted state',()=>{
 // Test-only scalar-width projection. NOT typography, Flutter pagination or a reader.
 const project=(r,s,viewport)=>{const prefix=r.blocks.slice(0,r.blocks.findIndex(b=>b.id===s.anchor.blockId)).reduce((n,b)=>n+[...b.text].length,0);return Math.floor((prefix+s.anchor.scalarOffset)/viewport);};
 for(const id of ['synthetic-a','synthetic-b']){const r=resource(id);let s=createReadingState(r,style,caps);s=updateReadingAnchor(r,s,{expectedRevision:1,anchor:{blockId:'ending',scalarOffset:6}});const before=clone(s);assert.notEqual(project(r,s,4),project(r,s,11));assert.deepEqual(s,before);const styled=updateReadingPresentation(r,s,{expectedRevision:s.revision,changes:{textScalePermille:2000,flow:'paged',pageControls:true}},caps);assert.deepEqual(styled.anchor,s.anchor);}
});
test('CAS conflict, overflow and unsupported font leave original state exactly unchanged',()=>{
 const r=resource(),s=createReadingState(r,style,caps),before=clone(s);
 for(const expectedRevision of [0,2,-1]){denied(()=>updateReadingPresentation(r,s,{expectedRevision,changes:{background:'#ffc0cb'}},caps),'reading_revision_conflict');denied(()=>updateReadingAnchor(r,s,{expectedRevision,anchor:{blockId:'ending',scalarOffset:0}}),'reading_revision_conflict');}
 denied(()=>updateReadingPresentation(r,s,{expectedRevision:1.5,changes:{pageControls:true}},caps),'invalid_c1_value');
 denied(()=>updateReadingPresentation(r,s,{expectedRevision:1,changes:{fontRef:'unverified-lishu'}},caps),'reading_font_unavailable');
 const max={...s,revision:Number.MAX_SAFE_INTEGER};denied(()=>updateReadingAnchor(r,max,{expectedRevision:max.revision,anchor:s.anchor}),'reading_revision_exhausted');denied(()=>updateReadingPresentation(r,max,{expectedRevision:max.revision,changes:{pageControls:true}},caps),'reading_revision_exhausted');assert.deepEqual(s,before);
});
test('font availability is not structural validity and never silently changes stored font or position',()=>{
 const r=resource();const s=updateReadingAnchor(r,createReadingState(r,style,caps),{expectedRevision:1,anchor:{blockId:'ending',scalarOffset:2}}),before=clone(s);
 denied(()=>validateReadingPresentationCapabilities(s.presentation,{installedFontIds:[]}),'reading_font_unavailable');assert.deepEqual(validateReadingState(r,s),before);assert.equal(s.presentation.fontRef,'synthetic-sc');assert.deepEqual(s.anchor,before.anchor);
 denied(()=>updateReadingPresentation(r,s,{expectedRevision:s.revision,changes:{background:'#ffc0cb'}},{installedFontIds:[]}),'reading_font_unavailable');
});
test('resource identity/content version and forged digest reject without migration',()=>{
 const r=resource(),s=createReadingState(r,style,caps),raw=declaration();raw.blocks[0].text+='新';const changed=compileReadingResource(raw);
 denied(()=>validateReadingState(changed,s),'reading_resource_mismatch');denied(()=>validateReadingState(resource('synthetic-b'),s),'reading_resource_mismatch');const forged=clone(r);forged.blocks[0].text='tamper';denied(()=>validateReadingResource(forged),'reading_digest_mismatch');
 const claim=declaration();claim.provenance.referenceId='another-host-claim';assert.equal(compileReadingResource(claim).contentDigest,r.contentDigest);
});
test('closed schemas reject executable/configuration fields and URL/CSS font/color values; literal body is inert',()=>{
 const r=resource(),s=createReadingState(r,style,caps),literal='<script>globalThis.readingExecuted = true</script> https://example.invalid/';const withLiteral=compileReadingResource({...declaration(),blocks:[{id:'literal',text:literal}]});assert.equal(withLiteral.blocks[0].text,literal);assert.equal(globalThis.readingExecuted,undefined);
 for(const field of ['onTap','url','pageIndex','pixelOffset','ownerId']){denied(()=>compileReadingResource({...declaration(),[field]:'bad'}));denied(()=>validateReadingState(r,{...s,[field]:0}));denied(()=>updateReadingPresentation(r,s,{expectedRevision:1,changes:{[field]:'bad'}},caps));}
 for(const background of ['pink','#fff','url(https://bad.invalid)','expression(alert(1))'])denied(()=>createReadingState(r,{...style,background},caps),'invalid_reading_background');
 for(const fontRef of ['https://bad.invalid/a.ttf','<style>bad</style>'])denied(()=>createReadingState(r,{...style,fontRef},caps),'invalid_reading_id');
 for(const anchor of [{blockId:'missing',scalarOffset:0},{blockId:'opening',scalarOffset:-1},{blockId:'opening',scalarOffset:0.5},{blockId:'opening',scalarOffset:0,pageIndex:1}])denied(()=>updateReadingAnchor(r,s,{expectedRevision:1,anchor}));
});
test('bounds: unique blocks, total scalars, block text, bytes, font list and style range',()=>{
 denied(()=>compileReadingResource({...declaration(),blocks:[]}));denied(()=>compileReadingResource({...declaration(),blocks:Array.from({length:65},(_,i)=>({id:'b'+i,text:'a'}))}));denied(()=>compileReadingResource({...declaration(),blocks:[{id:'same',text:'a'},{id:'same',text:'b'}]}),'duplicate_reading_block');
 denied(()=>compileReadingResource({...declaration(),blocks:[{id:'a',text:'😀'.repeat(2001)}]}),'invalid_reading_text');
 const blocks=Array.from({length:4},(_,i)=>({id:'b'+i,text:'😀'.repeat(2000)}));assert.equal(compileReadingResource({...declaration(),blocks}).blocks.length,4);denied(()=>compileReadingResource({...declaration(),blocks:[...blocks,{id:'extra',text:'a'}]}),'reading_text_limit');
 denied(()=>compileReadingResource({...declaration(),padding:'x'.repeat(READING_LIMITS.resourceBytes)}));
 const r=resource();for(const textScalePermille of [799,2001,1200.5])denied(()=>createReadingState(r,{...style,textScalePermille},caps));for(const pageControls of ['yes',1])denied(()=>createReadingState(r,{...style,pageControls},caps));
 denied(()=>createReadingState(r,style,{installedFontIds:Array(17).fill('synthetic-sc')}));denied(()=>createReadingState(r,style,{installedFontIds:['synthetic-sc','synthetic-sc']}));
});
test('C1 rejects getters/proxies/cycles without executing a supplied getter',()=>{
 let calls=0;const raw=declaration();Object.defineProperty(raw,'blocks',{enumerable:true,get(){calls++;return [];}});denied(()=>compileReadingResource(raw),'invalid_c1_value');assert.equal(calls,0);denied(()=>compileReadingResource(new Proxy(declaration(),{})),'invalid_c1_value');const cycle=declaration();cycle.extra=cycle;denied(()=>compileReadingResource(cycle),'invalid_c1_value');
});
