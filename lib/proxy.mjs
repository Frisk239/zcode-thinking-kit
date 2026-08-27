import http from 'http';
import https from 'https';
import { decideInject, findRoute, upstreamPath } from './inject.mjs';
import { filterHopByHop } from './headers.mjs';
import { tryHandleConsole } from './console-api.mjs';

export const DEFAULT_MAX_BODY = 32 * 1024 * 1024;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120000;

export function createProxyServer(opts) {
  const {
    getCfg,
    state,
    audit = () => {},
    say = () => {},
    maxBody = DEFAULT_MAX_BODY,
    upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    auditPath = '',
    v2Path = '',
  } = opts;

  function writeJson(res, code, obj) {
    if (res.headersSent) return;
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    const cfg = getCfg();
    const url = req.url || '/';
    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
      writeJson(res, 200, {
        ok: true,
        name: 'zcode-thinking-kit',
        listen: `http://${cfg.listen.host}:${cfg.listen.port}`,
        startedAt: state.startedAt,
        sessionLevel: state.sessionLevel,
        sessionLevelAt: state.sessionLevelAt,
        sessionCount: state.levelsBySession ? state.levelsBySession.size : 0,
        routes: (cfg.routes || []).map((r) => ({
          match: r.match,
          upstream: r.upstream,
          followSession: !!r.followSession,
          stripPrefix: r.stripPrefix || undefined,
        })),
        lastInject: state.lastInject,
        hotReload: 'routes, templates, staticLevel (listen.port requires restart)',
      });
      return;
    }

    if (
      tryHandleConsole(req, res, {
        getCfg,
        state,
        auditPath,
        v2Path,
      })
    ) {
      return;
    }

    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBody) {
        aborted = true;
        chunks.length = 0;
        writeJson(res, 413, { error: { message: 'zcode-thinking-kit: request body too large' } });
        return;
      }
      chunks.push(c);
    });

    req.on('error', (e) => {
      audit({ dir: 'requestError', error: String(e).slice(0, 120) });
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        handleEnd();
      } catch (e) {
        audit({ dir: 'handlerError', url, error: String(e).slice(0, 160) });
        say(`handler error: ${e}`);
        writeJson(res, 502, { error: { message: 'zcode-thinking-kit: ' + String(e.message || e) } });
      }
    });

    function handleEnd() {
      let body = Buffer.concat(chunks);
      const route = findRoute(url, cfg.routes || []);
      if (!route) {
        const msg = `no route matches ${url} (check routes[].match; prefix must be unique)`;
        say(msg);
        writeJson(res, 502, { error: { message: 'zcode-thinking-kit: ' + msg } });
        return;
      }

      let up;
      try {
        up = new URL(route.upstream);
      } catch {
        writeJson(res, 502, { error: { message: 'zcode-thinking-kit: invalid routes[].upstream' } });
        return;
      }

      let auditInfo = { kind: 'non-post' };
      if (req.method === 'POST' && body.length) {
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          const decision = decideInject({
            parsed,
            url,
            route,
            cfg,
            sessionLevel: state.sessionLevel,
            headers: req.headers,
            levelsBySession: state.levelsBySession,
          });
          auditInfo = { ...decision };
          delete auditInfo.body;
          if (decision.kind === 'inject' && decision.body) {
            body = Buffer.from(JSON.stringify(decision.body), 'utf8');
            state.lastInject = {
              at: new Date().toISOString(),
              model: decision.model,
              api: decision.api,
              level: decision.level,
              source: decision.levelSource,
            };
            say(`注入 ${decision.model} [${decision.api}] level=${decision.level}(${decision.levelSource})`);
          }
        } catch (e) {
          auditInfo = { kind: 'parse-fail', error: String(e).slice(0, 120) };
        }
      }
      audit({ dir: 'request', method: req.method, url, ...auditInfo });

      const headers = filterHopByHop({ ...req.headers, host: up.host });
      if (body.length) headers['content-length'] = String(body.length);
      const destPath = upstreamPath(url, route);
      const transport = up.protocol === 'http:' ? http : https;
      const upReq = transport.request(
        {
          hostname: up.hostname,
          port: up.port || (up.protocol === 'http:' ? 80 : 443),
          path: destPath,
          method: req.method,
          headers,
        },
        (upRes) => {
          audit({ dir: 'response', url, status: upRes.statusCode });
          try {
            res.writeHead(upRes.statusCode || 502, filterHopByHop(upRes.headers));
            upRes.pipe(res);
          } catch (e) {
            audit({ dir: 'responseWriteError', url, error: String(e).slice(0, 120) });
            writeJson(res, 502, { error: { message: 'zcode-thinking-kit: failed to write upstream response' } });
          }
        },
      );
      upReq.setTimeout(upstreamTimeoutMs, () => {
        upReq.destroy();
        audit({ dir: 'upstreamTimeout', url });
        writeJson(res, 504, { error: { message: 'zcode-thinking-kit: upstream timeout' } });
      });
      upReq.on('error', (e) => {
        audit({ dir: 'proxyError', url, error: String(e) });
        say(`上游错误: ${e}`);
        writeJson(res, 502, { error: { message: 'zcode-thinking-kit upstream error: ' + String(e) } });
      });
      upReq.end(body);
    }
  });

  return server;
}
