import { resolve } from 'node:path';
import { Runtime } from './runtime.js';
import { DemoProvider, CompatibleProvider } from './providers.js';
import { createApi } from './http.js';
import { Kernel } from './kernel.js';
const mode = process.env.LLM_MODE || 'demo';
if (!['demo', 'llm'].includes(mode)) throw new Error('LLM_MODE must be demo or llm');
if (!process.env.APP_TOKEN || process.env.APP_TOKEN.length < 24) throw new Error('APP_TOKEN must contain at least 24 characters');
const provider = mode === 'demo' ? new DemoProvider() : new CompatibleProvider({ endpoint: process.env.LLM_ENDPOINT, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL });
const kernel = new Kernel(resolve(process.env.KERNEL_STORE || '../data/kernel.json'));
kernel.bootstrap('local-owner');
const api = createApi(new Runtime(provider, { kernel }), { appToken: process.env.APP_TOKEN, kernel });
const ticker = setInterval(() => {
  try { kernel.tick(); } catch { console.error('Kernel tick failed; local task state retained. Inspect storage availability.'); }
}, 1000);
ticker.unref();
let closing = false;
function shutdown() {
  if (closing) return; closing = true; clearInterval(ticker);
  api.close(() => kernel.close());
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
api.on('error', () => { clearInterval(ticker); kernel.close(); });
api.listen(Number(process.env.PORT || 8080), '127.0.0.1', () => console.log(`Summon local API ready, port=${api.address().port}, mode=${mode}; persistent local-only kernel; subjects and chat sessions share the persistent kernel.`));
