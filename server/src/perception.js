import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from './model.js';
const MAX_BYTES = 4 * 1024 * 1024;
export const requestsText = text => /^(我要输入|我想输入|文字输入|打开文字输入|请让我输入|iwanttotype|opentextinput)[。.!！]?$/i.test(text.replace(/\s+/g, ''));
function presentation(modality, text, allowText = false) {
  return { strategy: 'bounded-rules-v1', generatedByModel: false, components: [
    { type: modality === 'vision' ? 'ocr_text' : modality === 'text' ? 'status_text' : 'transcript', text },
    ...(allowText ? [{ type: 'text_input', label: '按你的要求生成的文字输入' }] : []),
  ] };
}
export class LocalSenseProcessor {
  constructor({ python = process.env.SENSE_PYTHON || 'python3', timeoutMs = 30000 } = {}) {
    this.python = python; this.timeoutMs = timeoutMs; this.children = new Set();
  }
  cancel() { for (const child of this.children) this.#kill(child); }
  #kill(child) { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }
  run(args) {
    const script = fileURLToPath(new URL('../senses/processor.py', import.meta.url));
    const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONNOUSERSITE: '1' };
    for (const key of ['SENSE_VOSK_MODEL', 'SENSE_VOSK_LANGUAGE', 'SENSE_TESSDATA_DIR', 'SENSE_ASR_ENGINE', 'SENSE_PARAFORMER_MODEL']) if (process.env[key]) env[key] = process.env[key];
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      this.children.add(child); let output = Buffer.alloc(0), stopped = false;
      const timer = setTimeout(() => { stopped = true; this.#kill(child); reject(new DomainError(504, 'perception_timeout')); }, this.timeoutMs);
      child.stdout.on('data', bytes => { output = Buffer.concat([output, bytes]); if (output.length > 65536) { stopped = true; this.#kill(child); reject(new DomainError(502, 'perception_output_limit')); } });
      child.stderr.resume(); // Never expose/log media, model diagnostics or local paths.
      child.on('error', () => { clearTimeout(timer); this.children.delete(child); reject(new DomainError(503, 'perception_engine_unavailable')); });
      child.on('close', code => {
        clearTimeout(timer); this.children.delete(child); if (stopped) return;
        try {
          const result = JSON.parse(output.toString('utf8'));
          if (code !== 0 || result.error) {
            const error = /^[a-z_]{1,80}$/.test(result.error || '') ? result.error : 'perception_processing_failed';
            reject(new DomainError(/missing|configured/.test(error) ? 503 : 422, error));
          } else resolve(result);
        } catch { reject(new DomainError(502, 'invalid_perception_output')); }
      });
    });
  }
  capabilities() { return this.run(['--capabilities']); }
  process({ modality, path, root, mimeType, language }) {
    return this.run(['--modality', modality, '--input', path, '--input-root', root, '--mime', mimeType, '--language', language]);
  }
}
export class PerceptionService {
  constructor(kernel, { runtime = null, processor = new LocalSenseProcessor(), scratch = join(dirname(kernel.path), 'sense-tmp') } = {}) {
    this.runtime = runtime; this.kernel = kernel; this.processor = processor; this.scratch = scratch; this.active = new Set(); this.dirs = new Set(); this.closed = false;
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    // Kernel owns the store lock. Recover only our dedicated job directories.
    for (const name of readdirSync(scratch)) if (name.startsWith('job-')) rmSync(join(scratch, name), { recursive: true, force: true });
  }
  close() { this.closed = true; this.processor.cancel?.(); for (const dir of this.dirs) rmSync(dir, { recursive: true, force: true }); }
  async capabilities() {
    if (this.capabilitiesCache && Date.now() < this.capabilitiesUntil) return structuredClone(this.capabilitiesCache);
    this.capabilitiesPromise ??= this.processor.capabilities();
    try {
      const result = structuredClone(await this.capabilitiesPromise);
      // Advertise the public HTTP adapter, not every format the private CLI decodes.
      if (result.hearing) result.hearing.supportedMime = ['audio/wav'];
      if (result.vision) result.vision.supportedMime = ['image/png', 'image/jpeg'];
      this.capabilitiesCache = result; this.capabilitiesUntil = Date.now() + 3000;
      return structuredClone(result);
    } finally { this.capabilitiesPromise = null; }
  }
  async ingest(ownerId, body) {
    if (this.closed) throw new DomainError(503, 'perception_unavailable');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError(400, 'invalid_perception');
    const { creatureId, modality, media, responseMode = 'perception' } = body;
    if (!['perception', 'dialogue'].includes(responseMode) || (responseMode === 'dialogue' && modality !== 'hearing')) throw new DomainError(400, 'invalid_response_mode');
    if (responseMode === 'dialogue') {
      if (!this.runtime) throw new DomainError(503, 'dialogue_unavailable');
      const subject = this.runtime.getCreature(ownerId, creatureId);
      if (!subject.aibm.serviceAbilities.includes('conversation')) throw new DomainError(403, 'outside_service_boundary');
    }
    if (!['vision', 'hearing'].includes(modality)) throw new DomainError(400, 'invalid_modality');
    if (!media || typeof media.base64 !== 'string' || !media.base64 || media.base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw new DomainError(413, 'invalid_media_size');
    const mimes = modality === 'vision' ? ['image/png', 'image/jpeg'] : ['audio/wav'];
    if (!mimes.includes(media.mimeType)) throw new DomainError(415, 'unsupported_media_type');
    const bytes = Buffer.from(media.base64, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== media.base64) throw new DomainError(400, 'invalid_media_encoding');
    if (body.language !== undefined && !['zh', 'en'].includes(body.language)) throw new DomainError(400, 'invalid_perception_language');
    if (this.active.has(ownerId) || this.active.size >= 2) throw new DomainError(429, 'perception_busy');
    // Subject authorization is checked before spawning any processor.
    const perception = this.kernel.beginPerception(ownerId, { creatureId, modality, mimeType: media.mimeType, byteLength: bytes.length });
    this.active.add(ownerId); let dir;
    try {
      const caps = await this.capabilities();
      if (!caps[modality]?.available) throw new DomainError(503, 'perception_engine_unavailable');
      const language = body.language || (modality === 'hearing' ? caps.hearing.language : caps.vision.languages?.includes('chi_sim') ? 'zh' : 'en') || 'en';
      if (this.closed) throw new DomainError(503, 'perception_unavailable');
      this.kernel.assertPerceptionAuthority(ownerId, perception.id);
      dir = mkdtempSync(join(this.scratch, 'job-')); this.dirs.add(dir);
      const path = join(dir, 'input.media'); writeFileSync(path, bytes, { mode: 0o600 });
      const result = await this.processor.process({ modality, path, root: dir, mimeType: media.mimeType, language });
      if (this.closed) throw new DomainError(503, 'perception_unavailable');
      if (typeof result.text !== 'string' || result.text.length > 16000 || result.realProcessing !== true || typeof result.engine !== 'string' || typeof result.model !== 'string') throw new DomainError(502, 'invalid_perception_output');
      const allowsTextInput = modality === 'hearing' && requestsText(result.text);
      const record = this.kernel.finishPerception(ownerId, perception.id, {
        engine: result.engine.slice(0, 200), model: result.model.slice(0, 200), realProcessing: true,
        textLength: result.text.length, allowsTextInput, empty: !result.text.trim(),
      });
      const rendered = presentation(modality, result.text, allowsTextInput);
      if (modality === 'hearing' && /^(我的任务|查看任务|任务)[。.!！]?$/.test(result.text.replace(/\s+/g, ''))) {
        const pending = this.kernel.list(ownerId).tasks.filter(t => t.subjectId === creatureId && t.status === 'scheduled').length;
        rendered.components.push({ type: 'status_text', text: `当前主体有 ${pending} 项待执行任务；此处只读取状态。` });
      }
      let dialogue;
      if (responseMode === 'dialogue') {
        try {
          if (!result.text.trim() || result.text.length > 4000) throw new DomainError(422, 'speech_not_suitable_for_dialogue');
          // Opt-in explicitly changes retention: only this text becomes a normal
          // persisted conversation turn. Media is never sent to the LLM.
          this.kernel.assertCompletedPerceptionAuthority(ownerId, record.id);
          const session = this.runtime.resumeSession(ownerId, creatureId);
          const response = await this.runtime.call(ownerId, session.id, result.text, { scene: true, commitGuard: () => {
            if (this.closed) throw new DomainError(503, 'perception_unavailable');
            this.kernel.assertCompletedPerceptionAuthority(ownerId, record.id);
          } });
          dialogue = { status: 'completed', providerMode: response.providerMode, sessionId: session.id,
            answer: response.turns.at(-1).content, presentation: response.presentation, retention: 'conversation-text-persisted' };
        } catch (error) {
          dialogue = { status: 'failed', providerMode: this.runtime.provider.mode,
            error: error instanceof DomainError ? error.code : 'dialogue_processing_failed' };
        }
      }
      return { id: record.id, creatureId, modality, status: 'completed', result, ...(dialogue ? { dialogue } : {}),
        retention: record.retention, presentation: rendered };
    } catch (error) {
      try { this.kernel.failPerception(ownerId, perception.id, error instanceof DomainError ? error.code : 'perception_processing_failed'); } catch {}
      if (error instanceof DomainError) throw error;
      throw new DomainError(502, 'perception_processing_failed');
    } finally { this.active.delete(ownerId); bytes.fill(0); if (dir) { rmSync(dir, { recursive: true, force: true }); this.dirs.delete(dir); } }
  }
  text(ownerId, { creatureId, perceptionId, text } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new DomainError(400, 'invalid_text');
    this.kernel.acceptRequestedText(ownerId, perceptionId, creatureId, text.length);
    const state = this.kernel.list(ownerId);
    const normalized = text.trim();
    const answer = /^(我的任务|查看任务|任务)$/.test(normalized)
      ? `当前主体有 ${state.tasks.filter(t => t.subjectId === creatureId && t.status === 'scheduled').length} 项待执行任务；此处只查询，不创建或执行任务。`
      : `已接收文字：${normalized}\n当前仅使用受限本地规则，未调用通用语言模型或执行外部动作。`;
    return { id: perceptionId, creatureId, modality: 'text', status: 'completed', result: { text: answer, engine: 'bounded-local-rules', model: 'none', realProcessing: false, limitations: ['Not a general language model.'] }, presentation: presentation('text', answer, true) };
  }
}
