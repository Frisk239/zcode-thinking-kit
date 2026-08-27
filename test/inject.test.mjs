import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideInject,
  findRoute,
  pathPrefixMatch,
  substitute,
  lookupModelCfg,
  defaultInjectForKind,
} from '../lib/inject.mjs';

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

test('/v1 does not swallow /v10', () => {
  assert.equal(pathPrefixMatch('/v1/chat/completions', '/v1'), true);
  assert.equal(pathPrefixMatch('/v10/chat/completions', '/v1'), false);
  const hit = findRoute('/v10/chat/completions', [{ match: '/v1' }, { match: '/v10' }]);
  assert.equal(hit.match, '/v10');
});

test('missing match is skipped not thrown', () => {
  const hit = findRoute('/x', [{ upstream: 'https://x' }, { match: '/x', upstream: 'https://ok' }]);
  assert.equal(hit.upstream, 'https://ok');
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
  assert.equal(d.levelSource, 'session-fallback');
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

test('no-template leaves body unchanged', () => {
  const d = decideInject({
    parsed: { model: 'x' },
    url: '/zen/go/v1/unknown-api',
    route,
    cfg,
    sessionLevel: 'max',
  });
  assert.equal(d.kind, 'no-template');
  assert.equal(d.body, undefined);
});

test('levelMap applies on session and static', () => {
  const r = {
    ...route,
    models: {
      'ox-alpha-free': { followSession: true, staticLevel: 'xhigh', levelMap: { xhigh: 'high', max: 'high' } },
    },
  };
  const sess = decideInject({
    parsed: { model: 'ox-alpha-free' },
    url: '/zen/go/v1/chat/completions',
    route: r,
    cfg,
    sessionLevel: 'max',
  });
  assert.equal(sess.body.reasoning_effort, 'high');
  const stat = decideInject({
    parsed: { model: 'ox-alpha-free' },
    url: '/zen/go/v1/chat/completions',
    route: { ...r, followSession: false, models: { 'ox-alpha-free': { followSession: false, staticLevel: 'xhigh', levelMap: { xhigh: 'high' } } } },
    cfg,
  });
  assert.equal(stat.levelSource, 'static');
  assert.equal(stat.body.reasoning_effort, 'high');
});

test('two x-session-id values inject different levels', () => {
  const levelsBySession = new Map([
    ['aaa', { level: 'low' }],
    ['bbb', { level: 'max' }],
  ]);
  const a = decideInject({
    parsed: { model: 'ox-alpha-free' },
    url: '/zen/go/v1/chat/completions',
    route,
    cfg,
    sessionLevel: 'medium',
    headers: { 'x-session-id': 'aaa' },
    levelsBySession,
  });
  const b = decideInject({
    parsed: { model: 'ox-alpha-free' },
    url: '/zen/go/v1/chat/completions',
    route,
    cfg,
    sessionLevel: 'medium',
    headers: { 'x-session-id': 'bbb' },
    levelsBySession,
  });
  assert.equal(a.body.reasoning_effort, 'low');
  assert.equal(a.levelSource, 'session');
  assert.equal(b.body.reasoning_effort, 'max');
  assert.equal(b.levelSource, 'session');
});

test('normalizes sess_ and subagent session ids', () => {
  const levelsBySession = new Map([['ee793f4c-2a7f-4314-a6f2-c30abb1d82b9', { level: 'high' }]]);
  const d = decideInject({
    parsed: { model: 'ox-alpha-free' },
    url: '/zen/go/v1/chat/completions',
    route,
    cfg,
    headers: { 'x-session-id': 'sess_subagent_agent_ee793f4c-2a7f-4314-a6f2-c30abb1d82b9' },
    levelsBySession,
  });
  assert.equal(d.body.reasoning_effort, 'high');
  assert.equal(d.levelSource, 'session');
});

test('model suffix (high) is used when session map misses', () => {
  const d = decideInject({
    parsed: { model: 'ox-alpha-free(high)' },
    url: '/zen/go/v1/chat/completions',
    route,
    cfg,
    sessionLevel: 'low',
  });
  assert.equal(d.body.reasoning_effort, 'high');
  assert.equal(d.levelSource, 'model-suffix');
});

test('lookupModelCfg strips suffix', () => {
  const cfgModel = lookupModelCfg(route, 'ox-alpha-free(high)');
  assert.equal(cfgModel.staticLevel, 'max');
});

test('Anthropic budget follows level', () => {
  const r = {
    match: '/api/anthropic',
    followSession: true,
    defaultInject: defaultInjectForKind('anthropic'),
  };
  const d = decideInject({
    parsed: { model: 'GLM-5.3' },
    url: '/api/anthropic/v1/messages',
    route: r,
    cfg,
    sessionLevel: 'low',
  });
  assert.equal(d.kind, 'inject');
  assert.equal(d.body.thinking.type, 'enabled');
  assert.equal(d.body.thinking.budget_tokens, '4096');
});

test('substitute nested templates', () => {
  const out = substitute({ reasoning: { effort: '{level}' } }, 'high');
  assert.deepEqual(out, { reasoning: { effort: 'high' } });
});
