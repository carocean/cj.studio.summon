import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {LocalDishInterpreter} from '../src/local-dish-interpreter.js';
const cases=JSON.parse(readFileSync(new URL('../evaluation/dish-semantics-cases.json',import.meta.url)));
test('opt-in real local LLM dish semantics evaluation, no keyword fallback',{skip:process.env.DISH_REAL_LLM!=='1',timeout:600000},async()=>{
 const interpreter=new LocalDishInterpreter({endpoint:process.env.DISH_LLM_ENDPOINT,modelId:process.env.DISH_LLM_MODEL,timeoutMs:60000});const rows=[];
 for(const c of cases){const began=Date.now();let actual,error;try{actual=(await interpreter.interpret({text:c.text,currentDish:{id:'soup',name:'菌菇汤'}})).proposal.kind;}catch(e){error=e.code??'unknown';}
  const row={id:c.id,expected:c.expected,actual:actual??null,error:error??null,pass:c.expected.includes(actual),elapsedMs:Date.now()-began};rows.push(row);console.log(JSON.stringify(row));
 }
 const failed=rows.filter(r=>!r.pass);console.log(JSON.stringify({evidence:'real-local-llm',modelLabel:interpreter.modelId,total:rows.length,passed:rows.length-failed.length,falseExplanations:failed.filter(r=>r.actual==='explain').length}));assert.equal(failed.length,0,JSON.stringify(failed));
});
