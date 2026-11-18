import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSenseProcessor } from '../src/perception.js';
test('trusted ASR deployment settings pass to child without arbitrary credential env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sense-env-'));
  const keys = ['SENSE_ASR_ENGINE', 'SENSE_PARAFORMER_MODEL', 'SENSE_TEST_SECRET'];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const python = join(dir, 'env-probe');
  try {
    process.env.SENSE_ASR_ENGINE = 'paraformer';
    process.env.SENSE_PARAFORMER_MODEL = '/trusted/model';
    process.env.SENSE_TEST_SECRET = 'must-not-be-inherited';
    writeFileSync(python, '#!/bin/sh\nprintf \'{"engine":"%s","model":"%s","secret":"%s"}\\n\' "$SENSE_ASR_ENGINE" "$SENSE_PARAFORMER_MODEL" "$SENSE_TEST_SECRET"\n', { mode: 0o700 });
    const r = await new LocalSenseProcessor({ python }).capabilities();
    assert.deepEqual(r, { engine: 'paraformer', model: '/trusted/model', secret: '' });
  } finally {
    for (const k of keys) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    rmSync(dir, { recursive: true, force: true });
  }
});
