import {snapshot} from '../../microkernel/src/canonical.js';
import {fields,deny} from '../../microkernel/src/grants.js';
// Syntactic model-proposal boundary, never proof of understood intent or authority.
export function compileDishSemanticProposal(raw){
 const p=snapshot('dish-semantic-ir',raw).value;
 if(p.kind==='explain'){
  fields(p,['kind','target']);if(p.target!=='current-dish')deny('dish_semantic_target_denied');
 }else if(p.kind==='clarify'||p.kind==='none'){
  const key=p.kind==='clarify'?'question':'reason';fields(p,['kind',key]);const value=p[key];
  if(typeof value!=='string'||!value.trim()||[...value].length>240||/[\u0000-\u001f\u007f]/u.test(value))deny('dish_semantic_invalid_text');
 }else deny('dish_semantic_kind_denied');
 return snapshot('dish-semantic-proposal',{...p,authorityGranted:false,semanticsVerified:false}).value;
}
