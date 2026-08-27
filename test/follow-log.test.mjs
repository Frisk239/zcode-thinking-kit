import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLogEvent, localDateStamp, replayLogText } from '../lib/follow-log.mjs';

test('localDateStamp uses local calendar not UTC', () => {
  const d = new Date(2026, 7, 27, 1, 0, 0); // 2026-08-27 01:00 local
  assert.equal(localDateStamp(d), '2026-08-27');
});

test('replay keeps last event per session and global last', () => {
  const state = { levelsBySession: new Map() };
  const text = [
    JSON.stringify({
      event: 'session.reasoning_effort.updated',
      sessionId: 'sess_aaaa-bbbb-cccc-dddd-eeeeffff0001',
      context: { thoughtLevel: 'low' },
      timestamp: 't1',
    }),
    JSON.stringify({
      event: 'session.reasoning_effort.updated',
      sessionId: 'sess_aaaa-bbbb-cccc-dddd-eeeeffff0002',
      context: { thoughtLevel: 'max' },
      timestamp: 't2',
    }),
    '{"not":"json"',
    JSON.stringify({ event: 'other', context: { thoughtLevel: 'high' } }),
  ].join('\n');
  const n = replayLogText(text, state);
  assert.equal(n, 2);
  assert.equal(state.sessionLevel, 'max');
  assert.equal(state.levelsBySession.get('aaaa-bbbb-cccc-dddd-eeeeffff0001').level, 'low');
  assert.equal(state.levelsBySession.get('aaaa-bbbb-cccc-dddd-eeeeffff0002').level, 'max');
});

test('applyLogEvent ignores events without thoughtLevel', () => {
  const state = { levelsBySession: new Map() };
  assert.equal(applyLogEvent(state, { event: 'session.reasoning_effort.updated', context: {} }), false);
});
