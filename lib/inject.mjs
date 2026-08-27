export const NATIVE_FIELDS = [
  'reasoning_effort',
  'reasoning',
  'thinking',
  'enable_thinking',
];

export const OFF_LEVELS = new Set(['off', 'none', 'disabled', 'false', '0', 'nothink']);

export const ANTHROPIC_BUDGET = {
  low: 4096,
  medium: 8192,
  high: 16000,
  xhigh: 32000,
  max: 32000,
  minimal: 2048,
};

export function apiKindOf(url) {
  if (!url) return null;
  if (url.includes('/chat/completions')) return 'chat/completions';
  if (url.includes('/responses')) return 'responses';
  if (url.includes('/messages')) return 'messages';
  return null;
}

export function budgetForLevel(level) {
  const key = String(level || '').toLowerCase();
  return ANTHROPIC_BUDGET[key] || 16000;
}

export function defaultInjectForKind(kind) {
  if (kind === 'anthropic') {
    return {
      messages: { thinking: { type: 'enabled', budget_tokens: '{budget}' } },
    };
  }
  return {
    'chat/completions': { reasoning_effort: '{level}' },
    responses: { reasoning: { effort: '{level}' } },
  };
}

/** Prefix match that does not let /v1 swallow /v10. */
export function pathPrefixMatch(urlPath, match) {
  if (!match || typeof match !== 'string' || !urlPath) return false;
  const pathOnly = String(urlPath).split('?')[0];
  if (!pathOnly.startsWith(match)) return false;
  if (pathOnly.length === match.length) return true;
  const next = pathOnly[match.length];
  return next === '/' || next === '?' || next === '#';
}

export function findRoute(url, routes) {
  const list = (routes || []).filter((r) => r && r.match && pathPrefixMatch(url, r.match));
  list.sort((a, b) => b.match.length - a.match.length);
  return list[0] || null;
}

export function stripModelSuffix(model) {
  if (!model) return model;
  const m = String(model).match(/^(.*)\(([^)]+)\)\s*$/);
  return m ? m[1] : model;
}

export function suffixThoughtLevel(model) {
  const m = String(model || '').match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : null;
}

export function lookupModelCfg(route, model) {
  const models = (route && route.models) || {};
  if (model && models[model]) return models[model];
  const stripped = stripModelSuffix(model);
  if (stripped && models[stripped]) return models[stripped];
  return null;
}

export function mapLevel(cfgLike, level) {
  if (level == null) return level;
  const m = (cfgLike && cfgLike.levelMap) || {};
  return m[level] !== undefined ? m[level] : level;
}

export function normalizeSessionKey(id) {
  if (!id) return '';
  let s = String(id).trim();
  if (s.startsWith('sess_subagent_agent_')) s = s.slice('sess_subagent_agent_'.length);
  else if (s.startsWith('sess_')) s = s.slice('sess_'.length);
  return s;
}

export function sessionKeysFor(sid) {
  const keys = new Set();
  if (!sid) return keys;
  const raw = String(sid).trim();
  keys.add(raw);
  const norm = normalizeSessionKey(raw);
  if (norm) keys.add(norm);
  const uuid = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) keys.add(uuid[0]);
  return keys;
}

export function sessionKeyFromHeaders(headers) {
  if (!headers) return '';
  const h = headers['x-session-id'] || headers['X-Session-Id'] || headers['X-SESSION-ID'] || '';
  return String(h).trim();
}

export function lookupSessionLevel(levelsBySession, headers) {
  if (!levelsBySession || !headers) return null;
  const raw = sessionKeyFromHeaders(headers);
  if (!raw) return null;
  for (const key of sessionKeysFor(raw)) {
    const hit = levelsBySession.get(key);
    if (hit && hit.level) return hit;
  }
  return null;
}

export function pickFollowedLevel({ headers, sessionLevel, levelsBySession, model }) {
  const hit = lookupSessionLevel(levelsBySession, headers);
  if (hit) return { level: hit.level, source: 'session' };
  const suffix = suffixThoughtLevel(model);
  if (suffix) return { level: suffix, source: 'model-suffix' };
  if (sessionLevel) return { level: sessionLevel, source: 'session-fallback' };
  return { level: null, source: null };
}

export function resolveLevel(modelCfg, route, cfg, followed) {
  const follow =
    (modelCfg && modelCfg.followSession) ||
    (route && route.followSession);
  if (follow && followed && followed.level) {
    const mapped = mapLevel(route, mapLevel(modelCfg, followed.level));
    return { level: mapped, source: followed.source || 'session' };
  }
  const raw =
    (modelCfg && modelCfg.staticLevel) ??
    (route && route.staticLevel) ??
    (cfg.levelSource && cfg.levelSource.staticLevel) ??
    'high';
  return { level: mapLevel(route, mapLevel(modelCfg, raw)), source: 'static' };
}

export function substitute(node, level) {
  const budget = String(budgetForLevel(level));
  const lvl = String(level);
  if (typeof node === 'string') {
    return node.replaceAll('{level}', lvl).replaceAll('{budget}', budget);
  }
  if (Array.isArray(node)) return node.map((v) => substitute(v, level));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substitute(v, level);
    return out;
  }
  return node;
}

export function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      target[k] &&
      typeof target[k] === 'object' &&
      !Array.isArray(target[k])
    ) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export function pickTemplate(modelCfg, route, apiKind) {
  if (!apiKind) return null;
  return (
    (modelCfg && modelCfg.inject && modelCfg.inject[apiKind]) ||
    (route && route.defaultInject && route.defaultInject[apiKind]) ||
    null
  );
}

export function upstreamPath(reqUrl, route) {
  if (!route || !route.stripPrefix) return reqUrl;
  const prefix = route.stripPrefix;
  const pathOnly = String(reqUrl);
  if (pathOnly === prefix) return '/';
  if (pathOnly.startsWith(prefix + '/') || pathOnly.startsWith(prefix + '?')) {
    const rest = pathOnly.slice(prefix.length);
    return rest || '/';
  }
  return reqUrl;
}

/**
 * Decide whether and how to inject. Never logs secrets.
 */
export function decideInject({
  parsed,
  url,
  route,
  cfg,
  sessionLevel,
  headers,
  levelsBySession,
}) {
  const model = parsed.model || '(no-model)';
  const apiKind = apiKindOf(url);
  const modelCfg = lookupModelCfg(route, model);
  const template = pickTemplate(modelCfg, route, apiKind);
  const nativeFields = NATIVE_FIELDS.filter((f) => parsed[f] !== undefined);

  if (!template) {
    return { kind: 'no-template', model, api: apiKind };
  }
  if (nativeFields.length) {
    return { kind: 'native-present', model, api: apiKind, fields: nativeFields };
  }

  const followed = pickFollowedLevel({
    headers,
    sessionLevel,
    levelsBySession,
    model,
  });
  const { level, source } = resolveLevel(modelCfg, route, cfg, followed);
  if (OFF_LEVELS.has(String(level).toLowerCase())) {
    return { kind: 'level-off', model, api: apiKind, level, levelSource: source };
  }

  const patch = substitute(template, level);
  const next = JSON.parse(JSON.stringify(parsed));
  deepMerge(next, patch);
  return {
    kind: 'inject',
    model,
    api: apiKind,
    level,
    levelSource: source,
    injected: patch,
    body: next,
  };
}
