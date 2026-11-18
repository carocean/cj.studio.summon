import {request} from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SceneLab} from '../src/scene.js';
import {createSceneServer} from '../src/scene-server.js';
import {compileInteractionProgram} from '../src/interaction-program.js';
const program=compileInteractionProgram({schema:'temporary-interaction.v1',title:'本机笔记',fields:[{id:'body',label:'内容',type:'multiline',required:true,maxLength:4000}],save:{primitive:'local-draft.save'}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'interaction-scene-'));let now=1000,lab;const open=()=>lab=new SceneLab(join(dir,'core.sqlite'),join(dir,'sink.sqlite'),{clock:()=>now});open();return {get lab(){return lab;},tick(){now+=300001;},reopen(){lab.close();open();},done(){lab.close();rmSync(dir,{recursive:true});}};}
const create=(lab,id='note-session')=>{const spec={commandId:'create-'+id,sessionId:id,context:lab.captureSenseContext(),program,source:{kind:'host-declaration',referenceId:'test',modelId:null}};lab.createInteraction(spec);return spec;};
test('atomic derived reference survives restart and old create replay never replaces latest',()=>{const f=fixture();try{
 assert.equal(f.lab.currentInteraction(),null);const first=create(f.lab);const context=f.lab.captureSenseContext();assert.deepEqual(f.lab.currentInteraction(),{sessionId:first.sessionId,context});assert.equal(JSON.stringify(f.lab.state()).includes('compiled-interaction'),false);
 create(f.lab,'second');f.reopen();assert.equal(f.lab.currentInteraction().sessionId,'second');assert.equal(f.lab.createInteraction(first).replayed,true);assert.equal(f.lab.currentInteraction().sessionId,'second');
 f.lab.closeInteraction({commandId:'close',sessionId:'second',expectedRevision:1});assert.equal(f.lab.currentInteraction(),null);
 }finally{f.done();}});
test('scene ABA invalidates drafts; saved facts and notes remain queryable after close and expiry',()=>{const f=fixture();try{
 const spec=create(f.lab);f.lab.editInteraction({commandId:'edit',sessionId:spec.sessionId,expectedRevision:1,changes:{body:'我的笔记'}});
 const req={commandId:'save',sessionId:spec.sessionId,expectedRevision:2,confirmation:'save-local-draft'};const result=f.lab.saveInteraction(req);f.lab.selectCreature({creatureId:'work'});f.lab.selectCreature({creatureId:'companion'});
 assert.equal(f.lab.currentInteraction(),null);assert.throws(()=>f.lab.readInteraction({sessionId:spec.sessionId}),{code:'interaction_context_changed'});
 f.tick();f.reopen();assert.equal(f.lab.queryInteraction({commandId:'save'}).ack.noteId,result.ack.noteId);assert.equal(f.lab.saveInteraction(req).replayed,true);assert.equal(f.lab.readSavedInteraction({noteId:result.ack.noteId}).draft.values.body,'我的笔记');assert.equal(f.lab.queryInteraction({commandId:'unknown'}).status,'not_started');
 }finally{f.done();}});
test('HTTP accepts bounded draft text not host proposals; CAS, confirmation, recovery and origin boundaries',async()=>{const f=fixture();create(f.lab);const server=createSceneServer(f.lab);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;const post=async(path,body,headers={})=>{const r=await fetch(url+'/scene/interaction-'+path,{method:'POST',headers:{'content-type':'application/json','x-summon-lab':'synthetic',...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};try{
 assert.equal((await (await fetch(url+'/scene/interaction-current')).json()).sessionId,'note-session');
 const view=(await post('read',{sessionId:'note-session'})).body;assert.equal(view.program.programDigest,program.programDigest);assert.equal(view.draft.values.body,null);
 assert.equal((await post('create',{})).status,404);assert.equal((await post('revise',{})).status,404);
 const text='中'.repeat(3900)+'\n😀';const edited=await post('edit',{commandId:'edit',sessionId:'note-session',expectedRevision:1,changes:{body:text}});assert.equal(edited.status,200);
 assert.equal((await post('edit',{commandId:'stale',sessionId:'note-session',expectedRevision:1,changes:{body:'bad'}})).status,409);
 assert.equal((await post('save',{commandId:'bad',sessionId:'note-session',expectedRevision:2,confirmation:'model-approved'})).status,400);
 const saved=await post('save',{commandId:'save',sessionId:'note-session',expectedRevision:2,confirmation:'save-local-draft'});assert.equal(saved.status,200);
 const closed=await post('close',{commandId:'close',sessionId:'note-session',expectedRevision:3});assert.equal(closed.status,200);
 assert.deepEqual((await post('query',{commandId:'save'})).body.ack,saved.body.ack);assert.equal((await post('saved',{noteId:saved.body.ack.noteId})).body.draft.values.body,text);
 assert.equal((await post('edit',{padding:'x'.repeat(128*1024)})).status,413);assert.equal((await post('read',{sessionId:'note-session'},{origin:'https://evil.example'})).status,403);
 }finally{await new Promise(r=>server.close(r));f.done();}});

test('HTTP strictly decodes UTF8, preserving split multibyte text and rejecting lossy bytes or BOM without writes',async()=>{
 const f=fixture();create(f.lab);const server=createSceneServer(f.lab);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const raw=chunks=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/scene/interaction-edit',method:'POST',headers:{'content-type':'application/json','x-summon-lab':'synthetic'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);let i=0;const next=()=>{if(i===chunks.length)return req.end();req.write(chunks[i++]);setImmediate(next);};next();});
 try{
  const spec={commandId:'utf8-edit',sessionId:'note-session',expectedRevision:1,changes:{body:'中文😀'}};
  const bytes=Buffer.from(JSON.stringify(spec)),at=bytes.indexOf(Buffer.from('中'));
  // Split inside both Chinese and supplementary-plane UTF8 sequences.
  const result=await raw([bytes.subarray(0,at+1),bytes.subarray(at+1,at+7),bytes.subarray(at+7)]);assert.equal(result.status,200);
  assert.equal(f.lab.readInteraction({sessionId:'note-session'}).draft.values.body,'中文😀');
  const bad=Buffer.from(JSON.stringify({...spec,commandId:'invalid-utf8',expectedRevision:2,changes:{body:'X'}}));bad[bad.indexOf(Buffer.from('"X"'))+1]=0xff;
  assert.deepEqual(await raw([bad]),{status:400,body:{error:'invalid_json'}});
  const bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify({...spec,commandId:'bom',expectedRevision:2}))]);
  assert.deepEqual(await raw([bom]),{status:400,body:{error:'invalid_json'}});
  assert.equal(f.lab.queryInteraction({commandId:'invalid-utf8'}).status,'not_started');assert.equal(f.lab.queryInteraction({commandId:'bom'}).status,'not_started');
  const current=f.lab.readInteraction({sessionId:'note-session'});assert.equal(current.revision,2);assert.equal(current.draft.values.body,'中文😀');
 }finally{await new Promise(r=>server.close(r));f.done();}
});
