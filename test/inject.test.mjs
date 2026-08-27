import test from 'node:test';
import assert from 'node:assert/strict';
import { decideInject, findRoute, substitute } from '../lib/inject.mjs';

const route = {
  match: '/zen/go/v1',
  upstream: 'https://opencode.ai',
  followSession: true,
  staticLevel: 'high',
  defaultInject: { 'chat/completions': { reasoning_effort: '{level}' } },
  models: {
    'ox-alpha-free': { followSession: true, staticLevel: 'max' },
  },
};
const cfg = { levelSource: { staticLevel: 'high' } };

test('longest prefix wins', () => {
  const hit = findRoute('/zen/go/v1/chat/completions', [
    { match: '/zen' },
    { match: '/zen/go/v1' },
  ]);
  assert.equal(hit.match, '/zen/go/v1');
});

test('injects when native fields are missing', () => {
  const d = decideInject({
    parsed: { model: 'ox-alpha-free', messages: [] },
    url: '/zen/go/v1/chat/completions',
    route,
    cfg,
    sessionLevel: 'max',
  });
  assert.equal(d.kind, 'inject');
  assert.equal(d.body.reasoning_effort, 'max');
  assert.equal(d.levelSource, 'session');
});

test('does not double-inject', () => {
  const d = decideInject({
    parsed: { model: 'ox-alpha-free', reasoning_effort: 'low' },
    url: '/zen/go/v1/chat/completions',
    route,
    cfg,
    sessionLevel: 'max',
  });
  assert.equal(d.kind, 'native-present');
  assert.equal(d.body, undefined);
});

test('skips inject when level is off', () => {
  const d = decideInject({
    parsed: { model: 'ox-alpha-free' },
    url: '/zen/go/v1/chat/completions',
    route,
    cfg,
    sessionLevel: 'off',
  });
  assert.equal(d.kind, 'level-off');
});

test('substitute nested templates', () => {
  const out = substitute({ reasoning: { effort: '{level}' } }, 'high');
  assert.deepEqual(out, { reasoning: { effort: 'high' } });
});
