import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const MAX = 2 * 1024 * 1024;
let activeJob = false; // One synthesis process per Node process, across instances.
export class VoiceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function validateVoiceWav(bytes) {
  const bad = () => { throw new VoiceError('invalid_voice_audio'); };
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > MAX || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) bad();
  let offset = 12, format, size;
  while (offset + 8 <= bytes.length) {
    const tag = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length;
    if (end > bytes.length) bad();
    if (tag === 'fmt ') {
      if (format || length !== 16) bad();
      const encoding = bytes.readUInt16LE(start), channels = bytes.readUInt16LE(start + 2), sampleRate = bytes.readUInt32LE(start + 4), rate = bytes.readUInt32LE(start + 8), align = bytes.readUInt16LE(start + 12), bits = bytes.readUInt16LE(start + 14);
      if (encoding !== 1 || channels !== 1 || ![16000, 22050, 24000, 44100, 48000].includes(sampleRate) || bits !== 16 || align !== 2 || rate !== sampleRate * 2) bad();
      format = { sampleRate, channels };
    } else if (tag === 'data') { if (size !== undefined || !length || length % 2) bad(); size = length; }
    else bad(); // No unvalidated metadata or embedded media.
    offset = end + length % 2;
  }
  if (offset !== bytes.length || !format || !size) bad();
  return { ...format, durationSeconds: size / (format.sampleRate * 2) };
}

// Internal service only. Caller supplies a server-generated, authorized response;
// never expose this as an arbitrary client text-to-speech or filesystem endpoint.
export class LocalVoice {
  constructor({ python = process.env.VOICE_PYTHON || 'python3', modelDir = process.env.VOICE_MODEL_DIR,
    timeoutMs = 30000, scratch = tmpdir(), script = fileURLToPath(new URL('../voice/synthesize.py', import.meta.url)) } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new VoiceError('invalid_voice_configuration');
    this.python = python; this.modelDir = modelDir; this.timeoutMs = timeoutMs; this.scratch = scratch; this.script = script;
    this.busy = false;
  }
  async synthesize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['text', 'signal'].includes(k)) || typeof input.text !== 'string' || !input.text.trim() || [...input.text].length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.text)) throw new VoiceError('invalid_voice_input');
    const { text, signal } = input;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new VoiceError('invalid_voice_input');
    if (signal?.aborted) throw new VoiceError('voice_cancelled');
    if (!this.modelDir || !isAbsolute(this.modelDir)) throw new VoiceError('voice_model_unavailable');
    if (activeJob) throw new VoiceError('voice_busy');
    this.busy = true; activeJob = true; let dir;
    try {
      dir = await mkdtemp(join(this.scratch, 'summon-voice-'));
      const output = join(dir, 'output.wav');
      await this.#run(text, output, signal);
      if (signal?.aborted) throw new VoiceError('voice_cancelled');
      const info = await lstat(output);
      if (!info.isFile() || info.size > MAX || info.mode & 0o077) throw new VoiceError('invalid_voice_audio');
      const audio = await readFile(output);
      const metadata = validateVoiceWav(audio);
      if (signal?.aborted) throw new VoiceError('voice_cancelled');
      return { audio, ...metadata, mimeType: 'audio/wav', engine: 'sherpa-onnx', model: 'vits-melo-tts-zh_en', realProcessing: true };
    } catch (error) { if (error instanceof VoiceError) throw error; throw new VoiceError('voice_processing_failed'); }
    finally { try { if (dir) await rm(dir, { force: true, recursive: true }); } finally { this.busy = false; activeJob = false; } }
  }
  #run(text, output, signal) {
    return new Promise((resolve, reject) => {
      const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1' };
      const child = spawn(this.python, [this.script, '--model-dir', this.modelDir, '--output', output], { env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      let failure, stdout = 0, stderr = 0, closed = false;
      const stop = code => {
        if (closed) return;
        failure ??= code;
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      };
      const abort = () => stop('voice_cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop('voice_timeout'), this.timeoutMs);
      const monitor = setInterval(async () => { try { const info = await lstat(output); if (info.size > MAX) stop('voice_output_limit'); } catch {} }, 25);
      child.stdout.on('data', data => { stdout += data.length; if (stdout > 4096) stop('voice_output_limit'); });
      child.stderr.on('data', data => { stderr += data.length; if (stderr > 65536) stop('voice_output_limit'); });
      child.on('error', () => { failure ??= 'voice_engine_unavailable'; });
      child.stdin.on('error', () => { failure ??= 'voice_processing_failed'; });
      child.on('close', code => {
        closed = true;
        clearTimeout(timer); clearInterval(monitor); signal?.removeEventListener('abort', abort);
        // close occurs after process termination and stdio closure: no race-only cancellation.
        if (failure || code !== 0) reject(new VoiceError(failure || 'voice_processing_failed')); else resolve();
      });
      if (signal?.aborted) abort();
      child.stdin.end(JSON.stringify({ text }));
    });
  }
}
