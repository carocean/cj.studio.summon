import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {snapshot} from '../../microkernel/src/canonical.js';
import {fields,deny} from '../../microkernel/src/grants.js';
import {compileReadingResource,READING_LIMITS} from './reading-surface.js';

export const UTF8_EXCERPT_MAX_BYTES=8*1024*1024;
const typedArray=Object.getPrototypeOf(Uint8Array.prototype);
const get=name=>Object.getOwnPropertyDescriptor(typedArray,name).get;
const byteLength=get('byteLength'),byteOffset=get('byteOffset'),buffer=get('buffer');
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const decode=bytes=>{try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{deny('excerpt_invalid_utf8');}};
const boundary=(bytes,n)=>n===0||n===bytes.length||(bytes[n]&0xc0)!==0x80;
const splitsCrlf=(bytes,n)=>n>0&&n<bytes.length&&bytes[n-1]===13&&bytes[n]===10;

/** Pure host-only extraction. No acquisition, permissions, normalization or IO. */
export function compileUtf8Excerpt(rawBytes,rawSelection){
 if(types.isProxy(rawBytes)||!Buffer.isBuffer(rawBytes)||Object.getPrototypeOf(rawBytes)!==Buffer.prototype)deny('excerpt_buffer_required');
 // Intrinsic getters bypass shadowed Buffer properties. Size is checked before copy.
 const length=byteLength.call(rawBytes),backing=buffer.call(rawBytes),offset=byteOffset.call(rawBytes);
 if(types.isSharedArrayBuffer(backing))deny('excerpt_shared_memory');
 if(length<1||length>UTF8_EXCERPT_MAX_BYTES)deny('excerpt_byte_limit');
 const bytes=Buffer.from(new Uint8Array(backing,offset,length));
 decode(bytes); // Validate the ENTIRE file, including all unselected bytes.
 const selection=snapshot('utf8-excerpt-selection',rawSelection);
 if(Buffer.byteLength(selection.bytes)>16384)deny('excerpt_selection_limit');
 const s=selection.value;fields(s,['resourceId','provenance','ranges']);
 if(!Array.isArray(s.ranges)||s.ranges.length<1||s.ranges.length>READING_LIMITS.blocks)deny('excerpt_invalid_ranges');
 const blocks=[],ranges=[],ids=new Set();let previousEnd=0;
 for(const range of s.ranges){
  fields(range,['blockId','startByte','endByte']);
  const {blockId,startByte,endByte}=range;
  if(!Number.isSafeInteger(startByte)||!Number.isSafeInteger(endByte)||startByte<0||endByte<=startByte||endByte>length||startByte<previousEnd)deny('excerpt_invalid_range');
  if(ids.has(blockId))deny('excerpt_duplicate_block');ids.add(blockId);
  if(!boundary(bytes,startByte)||!boundary(bytes,endByte)||splitsCrlf(bytes,startByte)||splitsCrlf(bytes,endByte))deny('excerpt_split_boundary');
  const slice=bytes.subarray(startByte,endByte),text=decode(slice);
  if(!Buffer.from(text,'utf8').equals(slice))deny('excerpt_roundtrip_mismatch');
  blocks.push({id:blockId,text});ranges.push({blockId,startByte,endByte,rawSliceSha256:sha(slice)});
  previousEnd=endByte;
 }
 const resource=compileReadingResource({schema:'reading-resource.v1',resourceId:s.resourceId,provenance:s.provenance,blocks});
 const evidence=snapshot('utf8-excerpt-evidence',{schema:'utf8-excerpt-evidence.v1',rawByteLength:length,rawSha256:sha(bytes),encoding:'utf-8',leadingBom:length>=3&&bytes[0]===239&&bytes[1]===187&&bytes[2]===191,resourceId:resource.resourceId,contentDigest:resource.contentDigest,ranges,provenance:resource.provenance});
 if(Buffer.byteLength(evidence.bytes)>16384)deny('excerpt_evidence_limit');
 return Object.freeze({resource,evidence:evidence.value});
}
