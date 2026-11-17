import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { creatures, DomainError } from './runtime.js';
import { ServiceScheduler } from './services.js';

function equals(a, b) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function readBody(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16000) throw new DomainError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DomainError(400, 'invalid_json'); }
}
export function createApi(runtime, { appToken, ownerId = 'local-owner' }) {
  if (!appToken || appToken.length < 24) throw new Error('APP_TOKEN must contain at least 24 characters');
  const scheduler = new ServiceScheduler(runtime);
  return createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', mode: runtime.provider.mode });
      if (!equals(req.headers.authorization || '', `Bearer ${appToken}`)) throw new DomainError(401, 'unauthorized');
      if (req.method === 'GET' && req.url === '/v1/creatures') return send(200, { creatures, mode: runtime.provider.mode });
      const discovery = /^\/v1\/creatures\/([a-zA-Z0-9-]+)\/services$/.exec(req.url);
      if (req.method === 'GET' && discovery) return send(200, { services: scheduler.discover(discovery[1]) });
      if (req.method === 'POST' && req.url === '/v1/invocations') return send(200, await scheduler.invoke(ownerId, await readBody(req)));
      if (req.method === 'POST' && req.url === '/v1/plans') {
        const body = await readBody(req);
        return send(200, scheduler.resolve(body?.creatureId, body?.prompt));
      }
      if (req.method === 'POST' && req.url === '/v1/sessions') {
        const body = await readBody(req);
        return send(201, runtime.createSession(ownerId, body?.creatureId));
      }
      const match = /^\/v1\/sessions\/([a-zA-Z0-9-]+)(\/calls)?$/.exec(req.url);
      if (match && !match[2] && req.method === 'GET') return send(200, runtime.getSession(ownerId, match[1]));
      if (match && match[2] && req.method === 'POST') {
        const body = await readBody(req);
        return send(200, await runtime.call(ownerId, match[1], body?.message));
      }
      throw new DomainError(404, 'not_found');
    } catch (error) { send(error instanceof DomainError ? error.status : 502, { error: error instanceof DomainError ? error.code : 'provider_unavailable' }); }
  });
}
