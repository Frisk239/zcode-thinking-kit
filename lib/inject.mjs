export const NATIVE_FIELDS = [
  'reasoning_effort',
  'reasoning',
  'thinking',
  'enable_thinking',
  'effort',
];

export const OFF_LEVELS = new Set(['off', 'none', 'disabled', 'false', '0']);

export function apiKindOf(url) {
  if (!url) return null;
  if (url.includes('/chat/completions')) return 'chat/completions';
  if (url.includes('/responses')) return 'responses';
  if (url.includes('/messages')) return 'messages';
  return null;
}

export function defaultInjectForKind(kind) {
  if (kind === 'anthropic') {
    return {
      messages: { thinking: { type: 'enabled', budget_tokens: 16000 } },
    };
  }
  return {
    'chat/completions': { reasoning_effort: '{level}' },
    responses: { reasoning: { effort: '{level}' } },
  };
}

export function findRoute(url, routes) {
  const list = (routes || []).filter((r) => url.startsWith(r.match));
  list.sort((a, b) => b.match.length - a.match.length);
  return list[0] || null;
}

export function mapLevel(modelCfg, level) {
  const m = (modelCfg && modelCfg.levelMap) || {};
  return m[level] !== undefined ? m[level] : level;
}

export function resolveLevel(modelCfg, route, cfg, sessionLevel) {
  const follow =
    (modelCfg && modelCfg.followSession) ||
    (route && route.followSession);
  if (follow && sessionLevel) {
    return { level: mapLevel(modelCfg, sessionLevel), source: 'session' };
  }
  const lvl =
    (modelCfg && modelCfg.staticLevel) ??
    (route && route.staticLevel) ??
    (cfg.levelSource && cfg.levelSource.staticLevel) ??
    'high';
  return { level: lvl, source: 'static' };
}

export function substitute(node, level) {
  if (typeof node === 'string') return node.replaceAll('{level}', String(level));
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
    (route.defaultInject && route.defaultInject[apiKind]) ||
    null
  );
}

/**
 * Decide whether and how to inject. Never logs secrets.
 * Returns { kind, body?, extra } where body is a mutated clone when injecting.
 */
export function decideInject({ parsed, url, route, cfg, sessionLevel }) {
  const model = parsed.model || '(no-model)';
  const apiKind = apiKindOf(url);
  const modelCfg = (route.models && route.models[model]) || null;
  const template = pickTemplate(modelCfg, route, apiKind);
  const nativeFields = NATIVE_FIELDS.filter((f) => parsed[f] !== undefined);

  if (!template) {
    return { kind: 'no-template', model, api: apiKind };
  }
  if (nativeFields.length) {
    return { kind: 'native-present', model, api: apiKind, fields: nativeFields };
  }

  const { level, source } = resolveLevel(modelCfg, route, cfg, sessionLevel);
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
