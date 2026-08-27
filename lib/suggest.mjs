import fs from 'fs';
import { defaultInjectForKind } from './inject.mjs';

function safeUrl(baseURL) {
  try {
    return new URL(baseURL);
  } catch {
    return null;
  }
}

function providerKind(kind) {
  if (kind === 'anthropic') return 'anthropic';
  return 'openai-compatible';
}

/**
 * Build proxy routes from ZCode v2 config.json.
 * Never copies apiKey or other secrets.
 */
export function suggestFromZcodeConfig(raw) {
  const providers = (raw && raw.provider) || (raw && raw.providers) || {};
  const routesByKey = new Map();

  for (const [id, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') continue;
    const baseURL = provider.options && provider.options.baseURL;
    if (!baseURL || typeof baseURL !== 'string') continue;
    if (baseURL.includes('127.0.0.1') || baseURL.includes('localhost')) continue;

    const u = safeUrl(baseURL);
    if (!u) continue;

    const match = u.pathname.replace(/\/$/, '') || '/';
    const key = `${u.origin}${match}`;
    if (!routesByKey.has(key)) {
      const pk = providerKind(provider.kind);
      routesByKey.set(key, {
        match,
        upstream: u.origin,
        followSession: true,
        staticLevel: 'high',
        defaultInject: defaultInjectForKind(pk),
        models: {},
        _providers: [],
      });
    }

    const route = routesByKey.get(key);
    route._providers.push({
      id,
      name: provider.name || id,
      kind: provider.kind || 'unknown',
      source: provider.source || 'unknown',
    });

    const models = provider.models || {};
    for (const [modelId, model] of Object.entries(models)) {
      const reasoning = model && model.reasoning;
      if (!reasoning || reasoning.enabled === false) continue;
      const variants = Array.isArray(reasoning.variants) ? reasoning.variants : [];
      route.models[modelId] = {
        followSession: true,
        staticLevel: reasoning.defaultVariant || variants[0] || 'high',
      };
    }
  }

  const routes = [];
  const summary = [];
  for (const route of routesByKey.values()) {
    const { _providers, ...pub } = route;
    if (!Object.keys(pub.models).length) delete pub.models;
    routes.push(pub);
    summary.push({
      match: pub.match,
      upstream: pub.upstream,
      providers: _providers,
      modelCount: pub.models ? Object.keys(pub.models).length : 0,
    });
  }

  return {
    listen: { host: '127.0.0.1', port: 38771 },
    levelSource: { followZcodeLog: true, staticLevel: 'high' },
    routes,
    summary,
  };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
