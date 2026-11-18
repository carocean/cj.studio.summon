import { DomainError } from './model.js';
export const sceneInstruction = '本次请求采用受限情境呈现。只返回JSON对象：{"answer":"完整文字回应","components":[...] }。components最多6项，可按需求选择status_text {type,text}、bullet_list {type,title,items:[字符串]}、key_values {type,title,entries:[{label,value}]}。不要创建输入框、按钮、链接、执行动作或声称完成工具调用。不要为了填满组件重复回答；不需要卡片时components为空。';
const bounded = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
export function validateScene(raw) {
  let object;
  try { object = JSON.parse(raw); } catch { throw new DomainError(502, 'invalid_scene_response'); }
  if (!object || typeof object !== 'object' || !bounded(object.answer, 12000) || !Array.isArray(object.components) || object.components.length > 6) throw new DomainError(502, 'invalid_scene_response');
  const components = object.components.map(c => {
    if (!c || typeof c !== 'object') throw new DomainError(502, 'invalid_scene_component');
    if (c.type === 'status_text' && bounded(c.text, 2000)) return { type: 'status_text', text: c.text };
    if (c.type === 'bullet_list' && bounded(c.title, 100) && Array.isArray(c.items) && c.items.length > 0 && c.items.length <= 10 && c.items.every(v => bounded(v, 500))) return { type: 'bullet_list', title: c.title, items: [...c.items] };
    if (c.type === 'key_values' && bounded(c.title, 100) && Array.isArray(c.entries) && c.entries.length > 0 && c.entries.length <= 10 && c.entries.every(v => v && bounded(v.label, 100) && bounded(v.value, 500))) return { type: 'key_values', title: c.title, entries: c.entries.map(v => ({label:v.label,value:v.value})) };
    throw new DomainError(502, 'invalid_scene_component');
  });
  return { answer: object.answer, presentation: { strategy: 'bounded-model-scene-v1', generatedByModel: true, components } };
}
