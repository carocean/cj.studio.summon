import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {compileUtf8Excerpt,UTF8_EXCERPT_MAX_BYTES} from '../src/utf8-excerpt.js';
const selection=ranges=>({resourceId:'synthetic',provenance:{kind:'host-declared',referenceId:'synthetic-source'},ranges});
const range=(startByte,endByte,blockId='first')=>({blockId,startByte,endByte});
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
test('synthetic full UTF8 preserves BOM CRLF fullwidth spaces emoji and combining marks byte-for-byte',()=>{
 const raw=Buffer.from('\ufeff　甲\r\n😀e\u0301\u200d乙\ufeff'),copy=Buffer.from(raw);
 const {resource,evidence}=compileUtf8Excerpt(raw,selection([range(0,raw.length)]));
 assert.equal(resource.blocks[0].text,'\ufeff　甲\r\n😀e\u0301\u200d乙\ufeff');assert.equal(evidence.leadingBom,true);
 assert.equal(evidence.rawSha256,hash(raw));assert.equal(evidence.ranges[0].rawSliceSha256,hash(raw));assert.deepEqual(raw,copy);
 assert.equal(evidence.contentDigest,resource.contentDigest);assert.notEqual(evidence.rawSha256,resource.contentDigest);
 assert.ok(Object.isFrozen(resource.blocks[0])&&Object.isFrozen(evidence.ranges[0]));
 const without=compileUtf8Excerpt(raw,selection([range(3,raw.length)]));assert.equal(without.resource.blocks[0].text[0],'　');assert.equal(without.evidence.leadingBom,true);
});
test('ordinary Buffer views copy exactly selected bytes, ignore shadowed properties and never retain aliases',()=>{
 const backing=Buffer.from('x甲😀y'),view=backing.subarray(1,backing.length-1),before=Buffer.from(backing);
 let getterCalls=0;for(const key of ['buffer','length','byteOffset','byteLength'])Object.defineProperty(view,key,{get(){getterCalls++;throw Error('untrusted getter');}});
 const result=compileUtf8Excerpt(view,selection([range(0,7)]));assert.equal(result.resource.blocks[0].text,'甲😀');assert.equal(getterCalls,0);assert.deepEqual(backing,before);
 backing.fill(65);assert.equal(result.resource.blocks[0].text,'甲😀');assert.equal(result.evidence.rawByteLength,7);
 const ab=new ArrayBuffer(9),v=Buffer.from(ab,2,3);v.set(Buffer.from('乙'));assert.equal(compileUtf8Excerpt(v,selection([range(0,3)])).resource.blocks[0].text,'乙');
});
test('reject shared memory proxies nonbuffers subclasses and byte cap without changing input',()=>{
 for(const b of [Buffer.from(new SharedArrayBuffer(5)),new Proxy(Buffer.from('a'),{}),new Uint8Array([65]),'a',Buffer.alloc(0),Buffer.alloc(UTF8_EXCERPT_MAX_BYTES+1)])assert.throws(()=>compileUtf8Excerpt(b,selection([range(0,1)])));
 const b=Buffer.from('a');Object.setPrototypeOf(b,Object.create(Buffer.prototype));assert.throws(()=>compileUtf8Excerpt(b,selection([range(0,1)])));
 const max=Buffer.alloc(UTF8_EXCERPT_MAX_BYTES,65);assert.equal(compileUtf8Excerpt(max,selection([range(0,1)])).evidence.rawByteLength,UTF8_EXCERPT_MAX_BYTES);
});
test('whole-file decoding rejects invalid unselected UTF8 and no bytes change on failure',()=>{
 for(const raw of [Buffer.from([65,0xff]),Buffer.from([65,0xc0,0xaf]),Buffer.from([65,0xed,0xa0,0x80]),Buffer.from([65,0xf0,0x9f]),Buffer.from([0xff,0xfe,65,0])]){
  const copy=Buffer.from(raw);assert.throws(()=>compileUtf8Excerpt(raw,selection([range(0,1)])),/excerpt_invalid_utf8/);assert.deepEqual(raw,copy);
 }
});
test('ranges reject scalar and CRLF splits but do not invent grapheme boundaries',()=>{
 const b=Buffer.from('甲\r\n😀e\u0301');
 for(const r of [range(1,3),range(0,2),range(0,4),range(4,5),range(5,7)])assert.throws(()=>compileUtf8Excerpt(b,selection([r])),/excerpt_split_boundary/);
 assert.equal(compileUtf8Excerpt(b,selection([range(10,12)])).resource.blocks[0].text,'\u0301');
});
test('explicit ordered disjoint ranges allow gaps, reject overlaps IDs shapes unsafe indexes',()=>{
 const b=Buffer.from('abcdef');
 assert.deepEqual(compileUtf8Excerpt(b,selection([range(1,2),range(4,6,'last')])).resource.blocks.map(b=>b.text),['b','ef']);
 for(const rs of [[],[range(0,0)],[range(-1,1)],[range(0,7)],[range(0,1.5)],[range(0,Infinity)],[range(2,4),range(0,1,'last')],[range(0,3),range(2,4,'last')],[range(0,1),range(2,3)],[{...range(0,1),extra:true}]])assert.throws(()=>compileUtf8Excerpt(b,selection(rs)));
 assert.throws(()=>compileUtf8Excerpt(b,{...selection([range(0,1)]),url:'https://example.invalid'}));
 const getter={get resourceId(){throw Error('must not call');}};assert.throws(()=>compileUtf8Excerpt(b,getter),/invalid_c1_value/);
});
test('existing reading C1 text and scalar limits apply without truncation',()=>{
 for(const text of ['a'.repeat(2001),'\u0000','\u0085'])assert.throws(()=>compileUtf8Excerpt(Buffer.from(text),selection([range(0,Buffer.byteLength(text))])));
 const raw=Buffer.from('a'.repeat(10000));assert.throws(()=>compileUtf8Excerpt(raw,selection(Array.from({length:5},(_,i)=>range(i*2000,(i+1)*2000,'b'+i)))),/reading_text_limit/);
});
test('raw file identity is distinct from exact compiled excerpt identity',()=>{
 const a=compileUtf8Excerpt(Buffer.from('a!'),selection([range(0,1)])),b=compileUtf8Excerpt(Buffer.from('a?'),selection([range(0,1)]));
 assert.equal(a.resource.contentDigest,b.resource.contentDigest);assert.notEqual(a.evidence.rawSha256,b.evidence.rawSha256);assert.equal(a.evidence.ranges[0].rawSliceSha256,b.evidence.ranges[0].rawSliceSha256);
});
