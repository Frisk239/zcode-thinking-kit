#!/usr/bin/env node
/**
 * Loopback inject proxy between ZCode and an upstream LLM API.
 * Injects reasoning/thinking fields when ZCode omitted them.
 * Never double-injects. Never logs bodies, headers, or secrets.
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { decideInject, findRoute } from './lib/inject.mjs';
import {
  defaultAuditPath,
  defaultLogDir,
  ensureDataDir,
  pidPath,
  resolveConfigPath,
} from './lib/paths.mjs';

const args = process.argv.slice(2);
const configArg = args.find((a) => a.startsWith('--config='))?.slice('--config='.length);
const CONFIG_PATH = resolveConfigPath(configArg);

function say(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const listen = { ...(cfg.listen || {}) };
  listen.host = '127.0.0.1';
  listen.port = Number(listen.port) || 38771;
  if (cfg.listen && cfg.listen.host && cfg.listen.host !== '127.0.0.1') {
    say(`listen.host 强制为 127.0.0.1（忽略 ${cfg.listen.host}）`);
  }
  const src = cfg.levelSource || {};
  if (!src.zcodeLogDir) src.zcodeLogDir = defaultLogDir();
  cfg.listen = listen;
  cfg.levelSource = src;
  return cfg;
}

let cfg = loadConfig();
ensureDataDir();
const AUDIT_PATH = cfg.auditLog && !cfg.auditLog.includes('\\') && !cfg.auditLog.includes(':')
  ? defaultAuditPath()
  : (cfg.auditLog ? cfg.auditLog : defaultAuditPath());

const state = {
  sessionLevel: null,
  sessionLevelAt: null,
  levelsBySession: new Map(),
  startedAt: new Date().toISOString(),
  lastInject: null,
};

function audit(obj) {
  try {
    fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch {
    /* ignore */
  }
}

function startFollower() {
  const src = cfg.levelSource || {};
  if (!src.followZcodeLog) {
    say('档位跟随未启用, 仅用静态档位');
    return;
  }
  const dir = src.zcodeLogDir || defaultLogDir();
  let curFile = null;
  let curSize = 0;
  let buf = '';
  const poll = () => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const f = path.join(dir, `zcode-${day}.jsonl`);
      const st = fs.statSync(f);
      if (f !== curFile) {
        curFile = f;
        buf = '';
        curSize = st.size;
        say(`档位跟随开始监视(跳过历史): ${f}`);
      }
      if (st.size < curSize) {
        curSize = 0;
        buf = '';
      }
      if (st.size > curSize) {
        const len = st.size - curSize;
        const fd = fs.openSync(f, 'r');
        const chunk = Buffer.alloc(len);
        fs.readSync(fd, chunk, 0, len, curSize);
        fs.closeSync(fd);
        curSize = st.size;
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const e = JSON.parse(line);
            if (e.event === 'session.reasoning_effort.updated' && e.context && e.context.thoughtLevel) {
              const level = e.context.thoughtLevel;
              const sid = e.sessionId || '';
              state.sessionLevel = level;
              state.sessionLevelAt = e.timestamp || new Date().toISOString();
              if (sid) state.levelsBySession.set(sid, { level, at: state.sessionLevelAt });
              audit({ kind: 'level-update', level, sess: sid.slice(5, 13) });
              say(`档位跟随 -> ${level} (sess ${sid.slice(5, 13) || '?'})`);
            }
          } catch {
            /* ignore truncated line */
          }
        }
      }
    } catch {
      /* today's log may not exist yet */
    }
  };
  setInterval(poll, 1500);
  poll();
  say(`档位跟随已启动, 监视目录: ${dir}`);
}

function healthPayload() {
  return {
    ok: true,
    name: 'zcode-thinking-kit',
    listen: `http://${cfg.listen.host}:${cfg.listen.port}`,
    config: CONFIG_PATH,
    auditLog: AUDIT_PATH,
    startedAt: state.startedAt,
    sessionLevel: state.sessionLevel,
    sessionLevelAt: state.sessionLevelAt,
    routes: (cfg.routes || []).map((r) => ({
      match: r.match,
      upstream: r.upstream,
      followSession: !!r.followSession,
    })),
    lastInject: state.lastInject,
  };
}

function writeJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    writeJson(res, 200, healthPayload());
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    const route = findRoute(req.url, cfg.routes || []);
    if (!route) {
      const msg = `no route matches ${req.url} (check routes[].match)`;
      say(msg);
      writeJson(res, 502, { error: { message: 'zcode-thinking-kit: ' + msg } });
      return;
    }

    let auditInfo = { kind: 'non-post' };
    if (req.method === 'POST' && body.length) {
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        const decision = decideInject({
          parsed,
          url: req.url,
          route,
          cfg,
          sessionLevel: state.sessionLevel,
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
    audit({ dir: 'request', method: req.method, url: req.url, ...auditInfo });

    const up = new URL(route.upstream);
    const headers = { ...req.headers, host: up.host };
    delete headers['content-length'];
    if (body.length) headers['content-length'] = String(body.length);
    const transport = up.protocol === 'http:' ? http : https;
    const upReq = transport.request(
      {
        hostname: up.hostname,
        port: up.port || (up.protocol === 'http:' ? 80 : 443),
        path: req.url,
        method: req.method,
        headers,
      },
      (upRes) => {
        audit({ dir: 'response', url: req.url, status: upRes.statusCode });
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upReq.on('error', (e) => {
      audit({ dir: 'proxyError', url: req.url, error: String(e) });
      say(`上游错误: ${e}`);
      if (!res.headersSent) writeJson(res, 502, { error: { message: 'zcode-thinking-kit upstream error: ' + String(e) } });
    });
    upReq.end(body);
  });
});

function persistPid() {
  try {
    fs.writeFileSync(pidPath(), String(process.pid), 'utf8');
  } catch {
    /* ignore */
  }
}

function watchConfig() {
  try {
    fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
      try {
        cfg = loadConfig();
        say(`配置已热加载: ${CONFIG_PATH}`);
      } catch (e) {
        say(`配置热加载失败, 保持旧配置: ${e.message}`);
      }
    });
  } catch {
    /* ignore */
  }
}

server.listen(cfg.listen.port, cfg.listen.host, () => {
  persistPid();
  say(`zcode-thinking-kit 代理已启动: http://${cfg.listen.host}:${cfg.listen.port}`);
  say(`配置: ${CONFIG_PATH}`);
  say(`审计日志: ${AUDIT_PATH}`);
  say(`健康检查: http://${cfg.listen.host}:${cfg.listen.port}/health`);
  for (const r of cfg.routes || []) say(`路由: ${r.match} -> ${r.upstream}`);
  watchConfig();
  startFollower();
});

server.on('error', (e) => {
  console.error('server error', e);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
