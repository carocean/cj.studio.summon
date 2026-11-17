import { Runtime } from './runtime.js';
import { DemoProvider, CompatibleProvider } from './providers.js';
import { createApi } from './http.js';
const mode = process.env.LLM_MODE || 'demo';
if (!['demo', 'llm'].includes(mode)) throw new Error('LLM_MODE must be demo or llm');
const provider = mode === 'demo' ? new DemoProvider() : new CompatibleProvider({ endpoint: process.env.LLM_ENDPOINT, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL });
const api = createApi(new Runtime(provider), { appToken: process.env.APP_TOKEN });
api.listen(Number(process.env.PORT || 8080), '127.0.0.1', () => console.log(`Summon local API ready, mode=${mode}; no tool execution, in-memory sessions.`));
