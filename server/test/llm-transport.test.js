import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

test('real HTTPS transport to local compatible LLM mock, no paid inference', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'summon-tls-')); let child; let server;
  try {
    const key = join(dir, 'key.pem'); const cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    let captured;
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      captured = { path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'LOCAL HTTPS MOCK RESPONSE, not model inference' } }] }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const token = 'local-transport-test-token-abcdefghijklmnopqrstuvwxyz';
    child = spawn(process.execPath, ['src/main.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', APP_TOKEN: token, KERNEL_STORE: join(dir, 'state.json'), LLM_MODE: 'llm', LLM_ENDPOINT: `https://127.0.0.1:${server.address().port}/v1/chat/completions`, LLM_API_KEY: 'synthetic-test-key', LLM_MODEL: 'local-mock-only', NODE_EXTRA_CA_CERTS: cert }, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startup timeout')), 5000);
      child.stdout.on('data', d => { const m = /port=(\d+)/.exec(d.toString()); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`early exit ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}/v1/`; const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const creatures = await (await fetch(base + 'creatures', { headers })).json();
    const c = creatures.creatures.find(c => c.templateId === 'companion');
    const s = await (await fetch(base + 'sessions', { method: 'POST', headers, body: JSON.stringify({ creatureId: c.id }) })).json();
    const result = await fetch(base + `sessions/${s.id}/calls`, { method: 'POST', headers, body: JSON.stringify({ message: 'verify local TLS contract' }) });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).turns[1].content, 'LOCAL HTTPS MOCK RESPONSE, not model inference');
    assert.equal(captured.path, '/v1/chat/completions'); assert.equal(captured.auth, 'Bearer synthetic-test-key');
    assert.equal(captured.body.model, 'local-mock-only'); assert.equal(captured.body.messages[0].role, 'system');
  } finally {
    if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    if (server) await new Promise(r => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
