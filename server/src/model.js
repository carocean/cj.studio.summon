const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
export const creatures = deepFreeze([
  { id: 'companion', name: '同行者', role: 'companion', description: '陪伴用户探索现实生活的数字角色。', capabilities: ['conversation'],
    aibm: { personality: '友善、简洁', activitySpace: { mode: 'follow-owner', zones: ['demo-world'] }, serviceAbilities: ['conversation', 'capabilities.describe'], renderingAbilities: ['text', 'capability-card'] } },
  { id: 'guide', name: '向导', role: 'guide', description: '帮助梳理计划和问题的数字角色。', capabilities: ['conversation'],
    aibm: { personality: '清晰、有条理', activitySpace: { mode: 'stationary', zones: ['demo-world'] }, serviceAbilities: ['conversation', 'capabilities.describe'], renderingAbilities: ['text', 'capability-card'] } },
  { id: 'restaurant', name: '演示餐馆替身', role: 'restaurant', description: '提供演示菜单和点餐预览，不连接真实商户。', capabilities: ['menu.read', 'order.preview'],
    aibm: { personality: '热情、诚实', activitySpace: { mode: 'stationary', zones: ['demo-restaurant'] }, serviceAbilities: ['menu.read', 'order.preview', 'capabilities.describe'], renderingAbilities: ['menu-card', 'order-card', 'capability-card'] } },
]);

export class DomainError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export const serviceCatalog = deepFreeze([
  { id: 'local.report', title: '本地回执', effect: 'local-only', renderer: 'receipt-card', inputs: [], requiresConfirmation: false },
  { id: 'capabilities.describe', title: '说明自身能力', effect: 'read-only', renderer: 'capability-card', inputs: [], requiresConfirmation: false },
  { id: 'conversation', title: '交流', effect: 'model-request', renderer: 'text', inputs: ['message'], requiresConfirmation: false },
  { id: 'menu.read', title: '查看演示菜单', effect: 'read-only', renderer: 'menu-card', inputs: [], requiresConfirmation: false },
  { id: 'order.preview', title: '生成点餐预览', effect: 'local-preview', renderer: 'order-card', inputs: ['itemId', 'quantity'], requiresConfirmation: false },
]);
