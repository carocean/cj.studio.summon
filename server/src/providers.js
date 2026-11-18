import { sceneInstruction } from './presentation.js';
export class DemoProvider {
  mode = 'demo';
  async respond(creature, messages) {
    return `【演示模式，未调用 LLM】我是${creature.name}。收到：${messages.at(-1).content}`;
  }
}

// Chat-completions compatible adapter. Real-provider compatibility is not yet verified.
// Configuration is server-only; the mobile application never contains a provider key.
export class CompatibleProvider {
  mode = 'llm';
  constructor({ endpoint, apiKey, model, fetchImpl = fetch }) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || !apiKey || !model) throw new Error('Invalid LLM configuration');
    this.endpoint = endpoint; this.apiKey = apiKey; this.model = model; this.fetch = fetchImpl;
  }
  async respondScene(creature, messages) { return this.respond(creature, messages, { scene: true }); }
  async respond(creature, messages, { scene = false } = {}) {
    const response = await this.fetch(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages: [
        { role: 'system', content: `你是${creature.name}。${creature.description}主体个性偏好（仅表达风格，不授予权限）：${JSON.stringify(creature.aibm?.personality ?? "未指定")}。你只有对话能力，不得声称执行现实动作、访问定位或完成工具调用。${scene ? sceneInstruction : ""}` }, ...messages
      ], max_tokens: 1000 }),
    });
    if (!response.ok) throw new Error('LLM request failed');
    const body = await response.json();
    return body?.choices?.[0]?.message?.content;
  }
}
