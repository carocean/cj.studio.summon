import {snapshot} from '../../microkernel/src/canonical.js';
import {fields,deny} from '../../microkernel/src/grants.js';
import {compileInteractionProgram} from './interaction-program.js';

// Pure model IR boundary, not a model call, authorization, persistence or semantic
// verifier. Host policy supplies constants only; user fields are never guessed.
export function compileInteractionProposal(raw){
 const sealed=snapshot('interaction-proposal-ir',raw);
 if(Buffer.byteLength(sealed.bytes)>16384)deny('interaction_proposal_size_limit');
 const p=sealed.value;
 if(p.kind==='clarify'||p.kind==='none'){
  const key=p.kind==='clarify'?'question':'reason';fields(p,['kind',key]);
  const t=p[key];if(typeof t!=='string'||!t.trim()||[...t].length>240||/[\u0000-\u001f\u007f]/u.test(t))deny('invalid_interaction_proposal_text');
  return snapshot('interaction-proposal-result',{kind:p.kind,[key]:t,authorityGranted:false,semanticsVerified:false}).value;
 }
 fields(p,['kind','title','fields']);if(p.kind!=='form'||!Array.isArray(p.fields)||p.fields.length<1||p.fields.length>16)deny('invalid_interaction_proposal');
 const mapped=p.fields.map(f=>{
  if(!f||!['text','multiline','choice'].includes(f.type))deny('invalid_interaction_proposal_type');
  fields(f,['key','label','type','required',...(f.type==='choice'?['choices']:[])]);
  const common={id:f.key,label:f.label,type:f.type,required:f.required};
  if(f.type!=='choice')return {...common,maxLength:f.type==='text'?2000:4000};
  if(!Array.isArray(f.choices))deny('invalid_interaction_proposal_choices');
  return {...common,options:f.choices.map(value=>({value,label:value}))};
 });
 const program=compileInteractionProgram({schema:'temporary-interaction.v1',title:p.title,fields:mapped,save:{primitive:'local-draft.save'}});
 return snapshot('interaction-proposal-result',{kind:'form',program,authorityGranted:false,semanticsVerified:false}).value;
}
