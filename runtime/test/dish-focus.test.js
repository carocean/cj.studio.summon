import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDishCatalog, createDishFocus, advanceDishFocus, validateDishFocus} from '../src/dish-focus.js';
const declaration = () => ({schema:'synthetic-dish-catalog.v1',catalogId:'demo',items:[{dishId:'first',name:'演示面条',description:null,imageRef:null},{dishId:'second',name:'陌生菜名',description:'合成资料：丸子与汤',imageRef:'synthetic-soup'}]});
const fixture = () => {const c=compileDishCatalog(declaration());return {c,s:createDishFocus(c,'task-1')};};
const step=(c,s,kind,extra={})=>advanceDishFocus(c,s,{kind,expectedRevision:s.revision,...extra});
const stop=(c,s)=>step(c,step(c,s,'interrupt',{speechSequence:s.speech.sequence}),'stopped',{speechSequence:s.speech.sequence});
test('menu interruption preserves exact second dish and task through details/image/zoom/hide',()=>{
 let {c,s}=fixture();s=stop(c,step(c,s,'speak',{dishId:'first'}));s=step(c,s,'speak',{dishId:'second'});
 const pending=step(c,s,'interrupt',{speechSequence:2});assert.equal(pending.dishId,'second');assert.equal(pending.speech.phase,'stop-required');
 assert.throws(()=>step(c,pending,'details'));s=step(c,pending,'stopped',{speechSequence:2});
 s=step(c,s,'details');assert.equal(s.view,'details');s=step(c,s,'image');s=step(c,s,'zoom',{direction:'in'});
 assert.equal(s.zoomPermille,1250);assert.equal(s.taskId,'task-1');assert.equal(s.dishId,'second');
 s=step(c,s,'hide');assert.equal(s.dishId,'second');assert.equal(s.view,'none');assert.equal(s.zoomPermille,1000);
});
test('old revisions, old audio completion and repeat interruption cannot change newer focus',()=>{
 let {c,s}=fixture();s=step(c,s,'speak',{dishId:'first'});const old=s;s=stop(c,s);s=step(c,s,'speak',{dishId:'second'});
 assert.throws(()=>advanceDishFocus(c,s,{kind:'interrupt',expectedRevision:old.revision,speechSequence:1}));
 assert.throws(()=>step(c,s,'interrupt',{speechSequence:1}));s=step(c,s,'interrupt',{speechSequence:2});
 assert.throws(()=>step(c,s,'stopped',{speechSequence:1}));assert.throws(()=>step(c,s,'interrupt',{speechSequence:2}));
 assert.equal(s.dishId,'second');assert.equal(s.speech.phase,'stop-required');
});
test('no silent dish switch while audio is pending; no view before confirmed stop',()=>{
 let {c,s}=fixture();assert.throws(()=>step(c,s,'image'));s=step(c,s,'speak',{dishId:'first'});
 assert.throws(()=>step(c,s,'speak',{dishId:'second'}));assert.throws(()=>step(c,s,'details'));assert.throws(()=>step(c,s,'stopped',{speechSequence:1}));
});
test('missing image and unknown description remain absent; zoom bounds reject without mutation',()=>{
 let {c,s}=fixture();s=stop(c,step(c,s,'speak',{dishId:'first'}));s=step(c,s,'details');assert.equal(c.declaration.items[0].description,null);
 assert.throws(()=>step(c,s,'image'));s=stop(c,step(c,s,'speak',{dishId:'second'}));s=step(c,s,'image');
 assert.throws(()=>step(c,s,'zoom',{direction:'out'}));for(let i=0;i<8;i++)s=step(c,s,'zoom',{direction:'in'});
 assert.equal(s.zoomPermille,3000);assert.throws(()=>step(c,s,'zoom',{direction:'in'}));assert.equal(s.zoomPermille,3000);
});
test('catalog edits cannot silently rebind old focus; malformed/foreign shapes rejected',()=>{
 let {c,s}=fixture();const d=declaration();d.items[1].imageRef='changed';assert.throws(()=>validateDishFocus(compileDishCatalog(d),s));
 assert.throws(()=>step(c,s,'speak',{dishId:'missing'}));assert.throws(()=>step(c,s,'speak',{dishId:'first',ownerId:'other'}));
 assert.throws(()=>step(c,s,'pay'));assert.throws(()=>validateDishFocus(c,{...s,view:'image'}));assert.throws(()=>validateDishFocus(c,{...s,zoomPermille:1250}));
});
test('inputs immutable, limits enforced, references not arbitrary URLs, speech IDs never reused',()=>{
 let {c,s}=fixture();const original=JSON.stringify(s);const n=step(c,s,'speak',{dishId:'first'});assert.equal(JSON.stringify(s),original);assert.ok(Object.isFrozen(n));
 let d=declaration();d.items[0].imageRef='https://example.invalid/x';assert.throws(()=>compileDishCatalog(d));
 d=declaration();d.items.push(d.items[0]);assert.throws(()=>compileDishCatalog(d));
 assert.throws(()=>step(c,{...s,revision:Number.MAX_SAFE_INTEGER},'speak',{dishId:'first'}));
 const max=Number.MAX_SAFE_INTEGER;
 const exhausted={...n,lastSpeechSequence:max,speech:{sequence:max,phase:'stopped'}};
 assert.throws(()=>step(c,exhausted,'speak',{dishId:'first'}),{code:'dish_speech_sequence_exhausted'});
});

test('validator rejects impossible selected/empty and visible-unconfirmed states',()=>{
 const {c,s}=fixture();assert.throws(()=>validateDishFocus(c,{...s,dishId:'first'}));
 assert.throws(()=>validateDishFocus(c,{...s,lastSpeechSequence:1}));
 const speaking=step(c,s,'speak',{dishId:'second'});
 assert.throws(()=>validateDishFocus(c,{...speaking,view:'image'}));
 assert.throws(()=>validateDishFocus(c,{...speaking,view:'details'}));
});

test('non-string command kinds cannot coerce into accepted no-op revisions',()=>{
 let {c,s}=fixture();s=stop(c,step(c,s,'speak',{dishId:'second'}));
 for(const kind of [['image'],['details'],['hide'],null,{},0]) {
   assert.throws(()=>step(c,s,kind),{code:'unsupported_dish_focus_command'});
 }
 assert.equal(s.view,'none');assert.equal(s.revision,4);
});
