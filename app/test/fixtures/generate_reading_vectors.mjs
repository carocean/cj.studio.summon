import {writeFileSync} from 'node:fs';
import {compileReadingResource,createReadingState,updateReadingAnchor} from '../../../runtime/src/reading-surface.js';
const capabilities={installedFontIds:['SummonPreviewSC']};
const presentation={background:'#ffffff',fontRef:'SummonPreviewSC',textScalePermille:1000,flow:'scroll',pageControls:false};
const documents=[
 {id:'synthetic-chinese',blocks:[{id:'first',text:'甲乙😀e\u0301。'+'这里只是合成阅读文本。'.repeat(90)},{id:'second',text:'换颜色和尺寸不改原位置。'.repeat(100)}],anchor:{blockId:'second',scalarOffset:700}},
 {id:'synthetic-english',blocks:[{id:'first',text:'A separate synthetic document, not an acquired book. '.repeat(30)},{id:'second',text:'Reading location belongs to content, not page numbers. '.repeat(30)}],anchor:{blockId:'second',scalarOffset:900}},
 {id:'synthetic-literal',blocks:[{id:'first',text:'<script>untrusted()</script> https://example.invalid/ <button>not a control</button>'}],anchor:{blockId:'first',scalarOffset:0}},
 {id:'synthetic-unicode',blocks:[{id:'first',text:'甲😀e\u0301尾'},{id:'second',text:'合成片段'}],anchor:{blockId:'first',scalarOffset:3}}
];
const vectors=documents.map(d=>{const resource=compileReadingResource({schema:'reading-resource.v1',resourceId:d.id,provenance:{kind:'host-declared',referenceId:'synthetic-fixture'},blocks:d.blocks});const state=updateReadingAnchor(resource,createReadingState(resource,presentation,capabilities),{expectedRevision:1,anchor:d.anchor});return {resource,state,capabilities};});
const unicode='甲😀e\u0301尾';
const maximumResource=compileReadingResource({schema:'reading-resource.v1',resourceId:'synthetic-max',provenance:{kind:'host-declared',referenceId:'synthetic-fixture'},blocks:Array.from({length:4},(_,i)=>({id:'block'+i,text:'😀'.repeat(2000)}))});
writeFileSync(new URL('./reading_vectors.json',import.meta.url),JSON.stringify({schema:'synthetic-node-reading-vectors.v1',vectors,maximumResource,unicode,mappings:Array.from({length:[...unicode].length+1},(_,scalarOffset)=>({scalarOffset,utf16Offset:[...unicode].slice(0,scalarOffset).join('').length}))},null,2)+'\n');
