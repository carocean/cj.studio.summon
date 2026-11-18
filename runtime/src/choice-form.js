import { focusDefinitions } from './focus-service.js';
import { snapshot, digest } from '../../microkernel/src/canonical.js';
import { fields, deny, id } from '../../microkernel/src/grants.js';

// Three fixed business contracts. No schema registry, expressions, endpoints or code.
export const accountDefinitions = snapshot('account-definitions', [
  { id: 'customerAlias', label: '合成客户', options: ['demo-a', 'demo-b'] },
  { id: 'accountType', label: '模拟账户类别', options: ['daily', 'savings'] },
  { id: 'contactPreference', label: '模拟联系偏好', options: ['none', 'demo-email'] },
]).value;
const bindingKeys = ['context', 'targetCreatureId', 'activityId', 'activityRevision', 'productId', 'instanceId', 'subscriptionRevision', 'subscriptionGeneration'];
const seal = (kind, v) => snapshot(kind, v).value;
const text = (v, max = 100) => typeof v === 'string' && v.trim().length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
const version = v => Number.isSafeInteger(v) && v >= 1;
export function validateChoiceDeclaration(raw) {
  const d = seal('choice-form', raw);
  fields(d, ['schema', 'contractId', 'contractVersion', 'formId', 'binding', 'fields']);
  if (d.schema !== 'choice-form.v1' || d.contractVersion !== 1 || !['synthetic-account.v1', 'synthetic-route.v1', 'synthetic-focus.v1'].includes(d.contractId)) deny('invalid_choice_contract');
  const focusContract=d.contractId==='synthetic-focus.v1';
  const b = d.binding; fields(b, focusContract?['context','targetCreatureId','registryRevision','grantRevision','grantGeneration','serviceId']:bindingKeys); fields(b.context, ['creatureId', 'sceneRevision']);
  id(b.context.creatureId); id(b.targetCreatureId);
  if (!version(b.context.sceneRevision)) deny('invalid_choice_binding');
  const account = d.contractId === 'synthetic-account.v1';
  if(focusContract){
    if(b.serviceId!=='synthetic.focus.v1'||b.targetCreatureId!==b.context.creatureId||!version(b.registryRevision)||!version(b.grantRevision)||!Number.isSafeInteger(b.grantGeneration)||b.grantGeneration<0)deny('invalid_choice_binding');
  } else if (account) {
    id(b.activityId);
    if (b.targetCreatureId !== 'work' || b.context.creatureId !== 'work' || !version(b.activityRevision) ||
      [b.productId, b.instanceId, b.subscriptionRevision, b.subscriptionGeneration].some(v => v !== null)) deny('invalid_choice_binding');
  } else {
    id(b.instanceId);
    if (b.activityId !== null || b.activityRevision !== null || b.productId !== 'demo.maps.v1' || b.instanceId !== b.targetCreatureId || !version(b.subscriptionRevision) || !Number.isSafeInteger(b.subscriptionGeneration) || b.subscriptionGeneration < 0) deny('invalid_choice_binding');
  }
  if (d.formId !== 'form-' + digest('choice-form-declaration', [d.contractId, d.contractVersion, b, d.fields]).slice(7)) deny('invalid_choice_binding');
  const expected = focusContract?focusDefinitions.map(v=>v.id):account ? accountDefinitions.map(v => v.id) : ['from', 'to'];
  if (!Array.isArray(d.fields) || d.fields.length !== expected.length) deny('invalid_choice_fields');
  const seen = new Set();
  for (const f of d.fields) {
    fields(f, ['id', 'label', 'type', 'required', 'readOnly', 'options', 'value']);
    if (!expected.includes(f.id) || seen.has(f.id) || !text(f.label) || f.type !== 'choice' || f.required !== true || typeof f.readOnly !== 'boolean') deny('invalid_choice_fields');
    seen.add(f.id);
    if (!Array.isArray(f.options) || !f.options.length || f.options.length > 16) deny('invalid_choice_options');
    const values = new Set();
    for (const option of f.options) {
      fields(option, ['value', 'label']);
      if (!text(option.value, 64) || !text(option.label) || values.has(option.value)) deny('invalid_choice_options');
      values.add(option.value);
    }
    if (f.value !== null && !values.has(f.value)) deny('invalid_choice_value');
  }
  return d;
}
function declaration(contractId, binding, definitions, values, readOnly) {
  const formFields = definitions.map(d => ({ id: d.id, label: d.label, type: 'choice', required: true, readOnly,
    options: d.options.map(value => typeof value==='string'?({ value, label: value }):value), value: values[d.id] ?? null }));
  return validateChoiceDeclaration({ schema: 'choice-form.v1', contractId, contractVersion: 1,
    formId: 'form-' + digest('choice-form-declaration', [contractId, 1, binding, formFields]).slice(7), binding, fields: formFields,
  });
}
export function buildChoiceForms({ context, activity, market, focus }) {
  const empty = { context, targetCreatureId: '', activityId: null, activityRevision: null,
    productId: null, instanceId: null, subscriptionRevision: null, subscriptionGeneration: null };
  const account = context.creatureId === 'work' && activity?.sceneVisible === true ? declaration('synthetic-account.v1',
    { ...empty, targetCreatureId: 'work', activityId: activity.id, activityRevision: activity.revision }, accountDefinitions, activity.values, activity.status !== 'draft') : null;
  const sub = market.subscriptions.find(s => s.productId === 'demo.maps.v1' && s.status === 'active' && s.routeGranted === true);
  // Route choices come from the service's existing catalog, not a second node list.
  const catalog = market.catalog.find(c => c.productId === 'demo.maps.v1');
  const route = sub ? declaration('synthetic-route.v1', { ...empty, targetCreatureId: sub.instanceId,
    productId: sub.productId, instanceId: sub.instanceId, subscriptionRevision: sub.revision, subscriptionGeneration: sub.generation },
    [{ id: 'from', label: '合成起点', options: catalog.nodes }, { id: 'to', label: '合成终点', options: catalog.nodes }],
    { from: catalog.nodes[0], to: catalog.nodes.at(-1) }, false) : null;
  const focusForm=focus&&focus.primaryCreatureId===context.creatureId&&focus.grant.enabled&&!focus.activePlan&&focus.requestCount<focus.requestLimit?declaration('synthetic-focus.v1',{context,targetCreatureId:focus.primaryCreatureId,registryRevision:focus.registryRevision,grantRevision:focus.grant.revision,grantGeneration:focus.grant.generation,serviceId:'synthetic.focus.v1'},focusDefinitions,{},false):null;
  return seal('choice-forms', { account, route, ...(focus?{focus:focusForm}:{}) });
}
export function validateChoiceSubmission(current, raw) {
  const input = seal('choice-form-submission', raw); fields(input, ['formId', 'binding', 'values']);
  if (!current) deny('choice_form_unavailable');
  const d = validateChoiceDeclaration(current);
  if (input.formId !== d.formId || digest('choice-binding', input.binding) !== digest('choice-binding', d.binding)) deny('form_binding_conflict');
  if (d.fields.some(f => f.readOnly)) deny('choice_form_readonly');
  try { fields(input.values, d.fields.map(f => f.id)); } catch { deny('invalid_choice_values'); }
  for (const f of d.fields) if (!f.options.some(o => o.value === input.values[f.id])) deny('invalid_choice_values');
  return input.values;
}
