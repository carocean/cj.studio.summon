import { DomainError } from './model.js';

// One deployment-configured read-only probe. No request/model-controlled URL,
// command, identity or token. The probe sends only the constant name 'Summon'.
export class OpenPortsReadBridge {
  constructor({ endpoint, token, timeoutMs = 5000, maxBytes = 32768, fetchImpl = fetch } = {}) {
    const url = new URL(endpoint);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/helloworld.ports')) throw new Error('Invalid fixed OpenPorts hello endpoint');
    if (token !== undefined && (typeof token !== 'string' || !token || /[\r\n]/.test(token))) throw new Error('Invalid OpenPorts token');
    this.active = 0; this.maxConcurrent = 2;
    this.url = url.toString(); this.token = token; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes; this.fetch = fetchImpl;
  }
  async readHello() {
    if (this.active >= this.maxConcurrent) throw new DomainError(429, 'openports_busy');
    this.active++;
    const url = new URL(this.url); url.searchParams.set('name', 'Summon');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { 'Rest-Command': 'helloworld', 'Accept-Encoding': 'gzip', Accept: 'application/json' };
      if (this.token) headers.cjtoken = this.token;
      const response = await this.fetch(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new DomainError(502, 'openports_http_failure'); }
      if (!response.body) throw new DomainError(502, 'openports_empty_response');
      // Native fetch decodes gzip. Limit the decoded stream, not Content-Length.
      const reader = response.body.getReader(); let length = 0; const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > this.maxBytes) { await reader.cancel(); throw new DomainError(502, 'openports_response_limit'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      if (!length) throw new DomainError(502, 'openports_empty_response');
      let envelope, value;
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DomainError(502, 'openports_invalid_json'); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || ![200, '200'].includes(envelope.status)) throw new DomainError(502, 'openports_business_failure');
      if (typeof envelope.dataText !== 'string') throw new DomainError(502, 'openports_invalid_data');
      try { value = JSON.parse(envelope.dataText); } catch { throw new DomainError(502, 'openports_invalid_data'); }
      if (typeof value !== 'string' || !value || value.length > 4000) throw new DomainError(502, 'openports_invalid_data');
      if (this.token && [this.token, encodeURIComponent(this.token), Buffer.from(this.token).toString('base64')].some(secret => value.includes(secret))) throw new DomainError(502, 'openports_sensitive_response');
      // Never return headers, remote diagnostic messages, endpoint or credentials.
      return { text: value, bridge: 'openports-http', operation: 'helloworld', readOnly: true, identityForwarded: false, notice: '真实只读协议探针，不是菜单业务或 ECM 集群集成。' };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'openports_timeout' : 'openports_unavailable');
    } finally { clearTimeout(timeout); this.active--; }
  }
}
