import fs from 'fs';
import path from 'path';
import { KIT_DIR } from './paths.mjs';
import { runDoctor } from './doctor.mjs';
import { suggestFromZcodeConfig } from './suggest.mjs';

export const SOURCE_LABEL = {
  session: 'session map (x-session-id)',
  'model-suffix': 'model id suffix e.g. foo(high)',
  'session-fallback': 'last main-session level (inherit-shaped, not exact)',
  static: 'staticLevel in config',
};

export function publicDir() {
  return path.join(KIT_DIR, 'public');
}

export function proxiedBaseURL(port, match) {
  const p = match && match.startsWith('/') ? match : `/${match || ''}`;
  return `http://127.0.0.1:${Number(port) || 38771}${p}`;
}

export function originalBaseURL(upstream, match) {
  try {
    const u = new URL(upstream);
    const prefix = match && match.startsWith('/') ? match : `/${match || ''}`;
    return `${u.origin}${prefix}`;
  } catch {
    return `${upstream || ''}${match || ''}`;
  }
}

export function copyBaseurls(cfg) {
  const port = (cfg.listen && cfg.listen.port) || 38771;
  return {
    listen: `http://127.0.0.1:${port}`,
    hint: 'use 127.0.0.1 not localhost; keep the path; start a new ZCode session after changing baseURL',
    routes: (cfg.routes || []).map((r) => ({
      match: r.match,
      upstream: r.upstream,
      followSession: !!r.followSession,
      original: originalBaseURL(r.upstream, r.match),
      proxied: proxiedBaseURL(port, r.match),
    })),
  };
}

export function auditTail(file, limit = 50) {
  const allow = new Set([
    'ts',
    'kind',
    'dir',
    'model',
    'api',
    'level',
    'levelSource',
    'url',
    'status',
    'sess',
  ]);
  if (!file || !fs.existsSync(file)) return [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const slice = lines.slice(-Math.min(200, Math.max(1, Number(limit) || 50)));
  return slice.map((line) => {
    try {
      const o = JSON.parse(line);
      const out = {};
      for (const k of allow) {
        if (o[k] !== undefined) out[k] = o[k];
      }
      return out;
    } catch {
      return { kind: 'unparsed' };
    }
  });
}

export function suggestSafe(raw, port) {
  const out = suggestFromZcodeConfig(raw || {});
  const blob = JSON.stringify(out);
  if (blob.includes('apiKey') || /sk-[A-Za-z0-9]/.test(blob)) {
    throw new Error('suggest refused: secret-looking field in output');
  }
  return {
    listen: out.listen,
    levelSource: out.levelSource,
    routes: (out.routes || []).map((r) => ({
      ...r,
      original: originalBaseURL(r.upstream, r.match),
      proxied: proxiedBaseURL(port || (out.listen && out.listen.port), r.match),
    })),
    summary: out.summary,
    note: 'copy JSON into thinking.config.json; this does not write any file',
  };
}

export function servePublicFile(res, filePath, contentType) {
  const html = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(html);
}

export function tryHandleConsole(req, res, ctx) {
  if (req.method !== 'GET') return false;
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  const p = u.pathname;
  const { getCfg, state, auditPath, v2Path } = ctx;
  const cfg = getCfg();
  const port = (cfg.listen && cfg.listen.port) || 38771;

  const json = (code, obj) => {
    if (res.headersSent) return;
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  };

  if (p === '/' || p === '/index.html') {
    const index = path.join(publicDir(), 'index.html');
    if (!fs.existsSync(index)) {
      json(404, { error: { message: 'console index.html missing' } });
      return true;
    }
    servePublicFile(res, index, 'text/html; charset=utf-8');
    return true;
  }

  if (p === '/api/copy-baseurls') {
    json(200, copyBaseurls(cfg));
    return true;
  }

  if (p === '/api/doctor') {
    json(200, runDoctor(cfg, { v2Path }));
    return true;
  }

  if (p === '/api/suggest') {
    try {
      const file = v2Path;
      if (!file || !fs.existsSync(file)) {
        json(200, { ok: false, error: 'ZCode v2 config not found', routes: [], summary: [] });
        return true;
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      json(200, { ok: true, ...suggestSafe(raw, port) });
    } catch (e) {
      json(200, { ok: false, error: String(e.message || e), routes: [], summary: [] });
    }
    return true;
  }

  if (p === '/api/audit') {
    const limit = u.searchParams.get('limit');
    json(200, { entries: auditTail(auditPath, limit) });
    return true;
  }

  if (p === '/api/meta') {
    json(200, {
      sourceLabel: SOURCE_LABEL,
      lastInject: state.lastInject || null,
      sessionLevel: state.sessionLevel || null,
    });
    return true;
  }

  return false;
}
