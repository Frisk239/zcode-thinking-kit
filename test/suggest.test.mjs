import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestFromZcodeConfig } from '../lib/suggest.mjs';

test('suggest never copies apiKey', () => {
  const raw = {
    provider: {
      'p1': {
        name: 'custom-go',
        kind: 'openai-compatible',
        source: 'custom',
        options: {
          apiKey: 'sk-SECRET-DO-NOT-COPY',
          baseURL: 'https://opencode.ai/zen/go/v1',
        },
        models: {
          'ox-alpha-free': {
            reasoning: { enabled: true, variants: ['low', 'max'], defaultVariant: 'max' },
          },
        },
      },
    },
  };
  const out = suggestFromZcodeConfig(raw);
  const blob = JSON.stringify(out);
  assert.equal(blob.includes('sk-SECRET'), false);
  assert.equal(blob.includes('apiKey'), false);
  assert.equal(out.routes.length, 1);
  assert.equal(out.routes[0].upstream, 'https://opencode.ai');
  assert.equal(out.routes[0].match, '/zen/go/v1');
  assert.equal(out.routes[0].models['ox-alpha-free'].staticLevel, 'max');
});

test('suggest skips loopback baseURL', () => {
  const out = suggestFromZcodeConfig({
    provider: {
      p: {
        name: 'already-proxied',
        kind: 'openai-compatible',
        options: { apiKey: 'x', baseURL: 'http://127.0.0.1:38771/zen/go/v1' },
        models: { m: { reasoning: { enabled: true, variants: ['max'] } } },
      },
    },
  });
  assert.equal(out.routes.length, 0);
});
