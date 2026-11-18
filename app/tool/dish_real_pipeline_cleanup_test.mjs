import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
// Actual offline TTS cancellation, no inference server required: cancel while
// the fixture's own detached synthesizer is running, not an unrelated process.
test('opt-in real pipeline startup cancellation awaits TTS settlement and clears owned scratch',{skip:process.env.DISH_REAL_UI_CLEANUP!=='1',timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dish-real-cancel-'));let child,exited,stderr='';
 try{
  child=spawn(process.execPath,['app/test/fixtures/dish-real-pipeline-http.mjs',dir,'question'],{cwd:root,env:{...process.env,DISH_REAL_UI:'1',DISH_LLM_ENDPOINT:'http://127.0.0.1:18083/v1/chat/completions',DISH_LLM_MODEL:'cleanup-test-local-model'},stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',b=>stderr+=b);exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
  const voiceScratch=join(dir,'voice-input'),end=Date.now()+10000;
  let seen=false;
  while(Date.now()<end&&!seen){try{seen=readdirSync(voiceScratch).length>0;}catch{}if(!seen)await new Promise(r=>setTimeout(r,10));}
  assert.ok(seen,'owned TTS scratch not observed: '+stderr);await new Promise(r=>setTimeout(r,100));
  child.kill('SIGTERM');const result=await exited;assert.equal(result.signal,null);assert.equal(result.code,0,stderr);
  assert.deepEqual(readdirSync(voiceScratch),[],'TTS scratch remains');
 }finally{if(child?.exitCode===null){child.kill('SIGTERM');await exited;}rmSync(dir,{recursive:true,force:true});}
});
