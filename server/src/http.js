import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DomainError } from './model.js';
import { ServiceScheduler } from './services.js';

function equals(a, b) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function readBody(req, maxBytes = 16000) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new DomainError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DomainError(400, 'invalid_json'); }
}
export function createApi(runtime, { appToken, ownerId = 'local-owner', kernel = null, corsOrigin = null, perceptions = null, openports = null }) {
  if (!appToken || appToken.length < 24) throw new Error('APP_TOKEN must contain at least 24 characters');
  if (corsOrigin) {
    const origin = new URL(corsOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1'].includes(origin.hostname) || origin.origin !== corsOrigin) throw new Error('CORS origin must be an exact local development origin');
  }
  const scheduler = new ServiceScheduler(runtime, { openports });
  return createServer(async (req, res) => {
    const allowedOrigin = corsOrigin && req.headers.origin === corsOrigin;
    const cors = allowedOrigin ? { 'Access-Control-Allow-Origin': corsOrigin, 'Vary': 'Origin' } : {};
    const send = (status, data) => {
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'OPTIONS') {
        if (!allowedOrigin) throw new DomainError(403, 'origin_not_allowed');
        res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '300' });
        return res.end();
      }
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', mode: runtime.provider.mode });
      if (!equals(req.headers.authorization || '', `Bearer ${appToken}`)) throw new DomainError(401, 'unauthorized');
      if (req.method === 'GET' && req.url === '/v1/creatures') return send(200, { creatures: runtime.listCreatures(ownerId), mode: runtime.provider.mode });
      if (req.url?.startsWith('/v1/perceptions')) {
        if (!perceptions || !kernel) throw new DomainError(503, 'perception_unavailable');
        if (req.method === 'GET' && req.url === '/v1/perceptions/capabilities') return send(200, await perceptions.capabilities());
        if (req.method === 'GET' && req.url === '/v1/perceptions') return send(200, { perceptions: kernel.listPerceptions(ownerId) });
        if (req.method === 'POST' && req.url === '/v1/perceptions') return send(200, await perceptions.ingest(ownerId, await readBody(req, 6 * 1024 * 1024)));
        if (req.method === 'POST' && req.url === '/v1/perceptions/text') return send(200, perceptions.text(ownerId, await readBody(req)));
        throw new DomainError(404, 'not_found');
      }
      if (req.url?.startsWith('/v1/kernel/')) {
        if (!kernel) throw new DomainError(503, 'kernel_unavailable');
        if (req.method === 'GET' && req.url === '/v1/kernel/state') return send(200, kernel.list(ownerId));
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError(400, 'invalid_payload');
          if (req.url === '/v1/kernel/connectors') return send(200, kernel.reportConnector(ownerId, body));
          if (req.url === '/v1/kernel/subjects') return send(201, kernel.createSubject(ownerId, body));
          if (req.url === '/v1/kernel/transitions') return send(200, kernel.transition(ownerId, body.subjectId, body.status));
          if (req.url === '/v1/kernel/mounts') return send(200, kernel.mount(ownerId, body.subjectId, body.serviceId, body.enabled));
          if (req.url === '/v1/kernel/tasks') return send(201, kernel.schedule(ownerId, body));
          if (req.url === '/v1/kernel/signals') return send(200, kernel.signal(ownerId, body));
          if (req.url === '/v1/kernel/cancellations') return send(200, kernel.cancel(ownerId, body.taskId));
        }
        throw new DomainError(404, 'not_found');
      }
      if (req.method === 'POST' && req.url === '/v1/discovery') return send(200, scheduler.discoverAcross(ownerId, await readBody(req)));
      const discovery = /^\/v1\/creatures\/([a-zA-Z0-9-]+)\/services$/.exec(req.url);
      if (req.method === 'GET' && discovery) return send(200, { services: scheduler.discover(ownerId, discovery[1]) });
      if (req.method === 'POST' && req.url === '/v1/invocations') return send(200, await scheduler.invoke(ownerId, await readBody(req)));
      if (req.method === 'POST' && req.url === '/v1/plans') {
        const body = await readBody(req);
        return send(200, scheduler.resolve(ownerId, body?.creatureId, body?.prompt));
      }
      const sessionListing = /^\/v1\/creatures\/([a-zA-Z0-9-]+)\/sessions$/.exec(req.url);
      if (req.method === 'GET' && sessionListing) return send(200, runtime.listSessions(ownerId, sessionListing[1]));
      if (req.method === 'POST' && req.url === '/v1/sessions/resume') {
        const body = await readBody(req);
        return send(200, runtime.resumeSession(ownerId, body?.creatureId));
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
