import fs from 'fs';
import path from 'path';
import { sessionKeysFor } from './inject.mjs';

export function localDateStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function applyLogEvent(state, e) {
  if (!e || e.event !== 'session.reasoning_effort.updated') return false;
  const level = e.context && e.context.thoughtLevel;
  if (!level) return false;
  const sid = e.sessionId || '';
  const at = e.timestamp || new Date().toISOString();
  state.sessionLevel = level;
  state.sessionLevelAt = at;
  if (!state.levelsBySession) state.levelsBySession = new Map();
  for (const key of sessionKeysFor(sid)) {
    state.levelsBySession.set(key, { level, at, sessionId: sid });
  }
  return true;
}

export function replayLogText(text, state) {
  let n = 0;
  for (const line of String(text).split(/\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      if (applyLogEvent(state, JSON.parse(t))) n += 1;
    } catch {
      /* skip truncated / non-json */
    }
  }
  return n;
}

export function replayLogFile(file, state) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return replayLogText(text, state);
  } catch {
    return 0;
  }
}

export function latestLogFile(dir, now = new Date()) {
  if (!dir) return null;
  const preferred = path.join(dir, `zcode-${localDateStamp(now)}.jsonl`);
  if (fs.existsSync(preferred)) return preferred;
  try {
    const names = fs.readdirSync(dir).filter((n) => /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    if (!names.length) return null;
    names.sort();
    return path.join(dir, names[names.length - 1]);
  } catch {
    return null;
  }
}
