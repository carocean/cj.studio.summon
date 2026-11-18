import {snapshot,digest} from '../../microkernel/src/canonical.js';
import {fields,deny} from '../../microkernel/src/grants.js';

// Pure, bounded compiler. It performs no IO, does not authorize saving, and does
// not attest that a model understood the user. This is only the optional program
// branch: clarification, unsupported and no-presentation belong to the outer
// proposal protocol. There is no screen size, Flutter or device assumption.
// Text is literal, never HTML,
// templates, expressions or executable URLs. A future host must bind these values
// to owner/creature/scene/permissions and compare versions atomically at commit.
const seal=(kind,value,limit=16384)=>{const s=snapshot(kind,value);if(Buffer.byteLength(s.bytes)>limit)deny('interaction_size_limit');return s.value;};
const safeId=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(v)&&!['constructor','prototype'].includes(v);
const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const hash=v=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
const label=(v,max)=>typeof v==='string'&&v.trim().length>0&&[...v].length<=max&&!/[\u0000-\u001f\u007f]/u.test(v);
const next=v=>{if(v===Number.MAX_SAFE_INTEGER)deny('interaction_revision_exhausted');return v+1;};

function declaration(raw){
 const p=seal('interaction-declaration',raw);
 fields(p,['schema','title','fields','save']);
 if(p.schema!=='temporary-interaction.v1'||!label(p.title,120))deny('invalid_interaction_declaration');
 fields(p.save,['primitive']);if(p.save.primitive!=='local-draft.save')deny('unsupported_interaction_primitive');
 if(!Array.isArray(p.fields)||p.fields.length<1||p.fields.length>16)deny('invalid_interaction_fields');
 const seen=new Set();
 for(const f of p.fields){
  if(!f||!['text','multiline','choice'].includes(f.type))deny('invalid_interaction_field_type');
  fields(f,['id','label','type','required',f.type==='choice'?'options':'maxLength']);
  if(!safeId(f.id)||seen.has(f.id)||!label(f.label,80)||typeof f.required!=='boolean')deny('invalid_interaction_field');seen.add(f.id);
  if(f.type==='choice'){
   if(!Array.isArray(f.options)||f.options.length<1||f.options.length>16)deny('invalid_interaction_options');
   const values=new Set();for(const o of f.options){fields(o,['value','label']);if(!label(o.value,64)||!label(o.label,80)||values.has(o.value))deny('invalid_interaction_options');values.add(o.value);}
  }else if(!integer(f.maxLength,1)||f.maxLength>(f.type==='text'?2000:4000))deny('invalid_interaction_length');
 }
 return p;
}
function compiled(p,revision,parentDigest){
 const core={schema:'compiled-interaction.v1',revision,parentDigest,declaration:p};
 return seal('compiled-interaction',{...core,programDigest:digest('interaction-program',core),authorityGranted:false,semanticsVerified:false},18000);
}
export function compileInteractionProgram(proposal){return compiled(declaration(proposal),1,null);}
export function validateCompiledInteractionProgram(raw){
 const p=seal('compiled-interaction',raw,18000);
 fields(p,['schema','revision','parentDigest','declaration','programDigest','authorityGranted','semanticsVerified']);
 if(p.schema!=='compiled-interaction.v1'||!integer(p.revision,1)||p.authorityGranted!==false||p.semanticsVerified!==false||!hash(p.programDigest)||(p.revision===1?p.parentDigest!==null:!hash(p.parentDigest)))deny('invalid_compiled_interaction');
 const expected=compiled(declaration(p.declaration),p.revision,p.parentDigest);
 if(expected.programDigest!==p.programDigest)deny('interaction_digest_mismatch');
 return expected;
}
function checkDraft(p,raw,requireComplete){
 const d=seal('interaction-draft',raw);fields(d,['schema','programDigest','revision','values']);
 if(d.schema!=='interaction-draft.v1'||d.programDigest!==p.programDigest||!integer(d.revision))deny('invalid_interaction_draft');
 fields(d.values,p.declaration.fields.map(f=>f.id));
 for(const f of p.declaration.fields){
  const value=d.values[f.id];
  if(value!==null){
   if(typeof value!=='string')deny('invalid_interaction_value');
   if(f.type==='choice'){if(!f.options.some(o=>o.value===value))deny('invalid_interaction_value');}
   else if([...value].length>f.maxLength||(f.type==='text'?/[\u0000-\u001f\u007f]/u:/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u).test(value))deny('invalid_interaction_value');
  }
  if(requireComplete&&f.required&&(value===null||!value.trim()))deny('interaction_required_value');
 }
 return d;
}
export function createInteractionDraft(program){
 const p=validateCompiledInteractionProgram(program);
 return checkDraft(p,{schema:'interaction-draft.v1',programDigest:p.programDigest,revision:0,values:Object.fromEntries(p.declaration.fields.map(f=>[f.id,null]))},false);
}
export function validateInteractionDraft(program,draft,options={requireComplete:false}){
 const o=seal('interaction-validation',options);fields(o,['requireComplete']);if(typeof o.requireComplete!=='boolean')deny('invalid_interaction_validation');
 return checkDraft(validateCompiledInteractionProgram(program),draft,o.requireComplete);
}
function bound(p,d,r){if(r.expectedProgramDigest!==p.programDigest||r.expectedDraftRevision!==d.revision)deny('interaction_version_conflict');}
// A host/user edit, NOT model output. Pure validation here supplies no approval.
export function updateInteractionDraft(program,draft,request){
 const p=validateCompiledInteractionProgram(program),d=checkDraft(p,draft,false),r=seal('interaction-edit',request);
 fields(r,['expectedProgramDigest','expectedDraftRevision','changes']);bound(p,d,r);
 fields(r.changes,[],p.declaration.fields.map(f=>f.id));
 return checkDraft(p,{...d,revision:next(d.revision),values:{...d.values,...r.changes}},false);
}
// Full replacement declaration rather than an executable patch language. Moves
// are a separate host-approved migration choice, never accepted inside proposal.
// No conversion, default insertion, duplication or deletion of a non-null value.
export function reviseInteractionProgram(program,draft,proposal,request){
 const p=validateCompiledInteractionProgram(program),d=checkDraft(p,draft,false),r=seal('interaction-revision',request);
 fields(r,['expectedProgramDigest','expectedDraftRevision','moves']);bound(p,d,r);
 if(!Array.isArray(r.moves)||r.moves.length>16)deny('invalid_interaction_migration');
 const proposed=declaration(proposal),oldFields=new Map(p.declaration.fields.map(f=>[f.id,f])),newFields=new Map(proposed.fields.map(f=>[f.id,f])),moves=new Map(),destinations=new Set();
 for(const m of r.moves){fields(m,['from','to']);if(!oldFields.has(m.from)||!newFields.has(m.to)||m.from===m.to||moves.has(m.from)||destinations.has(m.to))deny('invalid_interaction_migration');moves.set(m.from,m.to);destinations.add(m.to);}
 const values=Object.fromEntries(proposed.fields.map(f=>[f.id,null])),assigned=new Set();
 for(const [id,field] of oldFields){
  const target=moves.get(id)??id,value=d.values[id];
  if(!newFields.has(target)){if(value!==null)deny('interaction_value_would_be_lost');continue;}
  if(assigned.has(target))deny('interaction_migration_collision');assigned.add(target);
  const targetField=newFields.get(target);
  if(value!==null&&field.type!==targetField.type)deny('interaction_populated_type_change');
  // Stable IDs preserve displayed meaning too, to the extent syntax can check.
  // A distinct-ID move is explicit host migration; it is not model permission.
  if(value!==null&&!moves.has(id)){
   if(field.label!==targetField.label)deny('interaction_populated_label_change');
   if(field.type==='choice'&&field.options.find(o=>o.value===value)?.label!==targetField.options.find(o=>o.value===value)?.label)deny('interaction_populated_label_change');
  }
  values[target]=value;
 }
 const result=compiled(proposed,next(p.revision),p.programDigest);
 const migrated=checkDraft(result,{...d,programDigest:result.programDigest,revision:next(d.revision),values},false);
 return seal('interaction-revision-result',{program:result,draft:migrated},36000);
}
