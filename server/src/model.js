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
  { id: 'ecm.hello.read', title: 'ECM 只读连接探针', effect: 'external-read-only', renderer: 'text', inputs: [], requiresConfirmation: false },
  { id: 'sense.hearing', title: '离线语音感知', effect: 'local-media-processing', renderer: 'transcript', inputs: ['audio'], requiresConfirmation: false },
  { id: 'sense.vision', title: '离线图像文字感知', effect: 'local-media-processing', renderer: 'ocr-text', inputs: ['image'], requiresConfirmation: false },
  { id: 'device.preview', title: '模拟设备操作预检', effect: 'local-only', renderer: 'receipt-card', inputs: [], requiresConfirmation: false, requiresConnector: 'device-simulation' },
  { id: 'local.report', title: '本地回执', effect: 'local-only', renderer: 'receipt-card', inputs: [], requiresConfirmation: false },
  { id: 'capabilities.describe', title: '说明自身能力', effect: 'read-only', renderer: 'capability-card', inputs: [], requiresConfirmation: false },
  { id: 'conversation', title: '交流', effect: 'model-request', renderer: 'text', inputs: ['message'], requiresConfirmation: false },
  { id: 'menu.read', title: '查看演示菜单', effect: 'read-only', renderer: 'menu-card', inputs: [], requiresConfirmation: false },
  { id: 'order.preview', title: '生成点餐预览', effect: 'local-preview', renderer: 'order-card', inputs: ['itemId', 'quantity'], requiresConfirmation: false },
]);
