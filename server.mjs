#!/usr/bin/env node
/**
 * Loopback inject proxy between ZCode and an upstream LLM API.
 * Never double-injects. Never logs bodies, headers, or secrets.
 */
import fs from 'fs';
import path from 'path';
import { applyLogEvent, latestLogFile, localDateStamp, replayLogFile } from './lib/follow-log.mjs';
import { writePidRecord, removePidFile } from './lib/pid.mjs';
import { createProxyServer } from './lib/proxy.mjs';
import {
  dataDir,
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

function resolveAuditPath(cfg) {
  if (!cfg.auditLog) return defaultAuditPath();
  if (path.isAbsolute(cfg.auditLog)) return cfg.auditLog;
  return path.join(dataDir(), cfg.auditLog);
}

let cfg = loadConfig();
const listenSnapshot = { host: cfg.listen.host, port: cfg.listen.port };
ensureDataDir();
const AUDIT_PATH = resolveAuditPath(cfg);

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
  let replayed = false;

  const attach = (file) => {
    curFile = file;
    buf = '';
    const n = replayLogFile(file, state);
    try {
      curSize = fs.statSync(file).size;
    } catch {
      curSize = 0;
    }
    replayed = true;
    say(`档位跟随回放 ${n} 条: ${file} (level=${state.sessionLevel || '-'})`);
  };

  const poll = () => {
    try {
      const file = latestLogFile(dir) || path.join(dir, `zcode-${localDateStamp()}.jsonl`);
      if (file !== curFile) {
        if (fs.existsSync(file)) attach(file);
        else {
          curFile = file;
          curSize = 0;
          buf = '';
          say(`档位跟随等待日志: ${file}`);
        }
        return;
      }
      if (!fs.existsSync(file)) return;
      const st = fs.statSync(file);
      if (!replayed) {
        attach(file);
        return;
      }
      if (st.size < curSize) {
        attach(file);
        return;
      }
      if (st.size > curSize) {
        const len = st.size - curSize;
        const fd = fs.openSync(file, 'r');
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
            if (applyLogEvent(state, e)) {
              const sid = e.sessionId || '';
              audit({ kind: 'level-update', level: e.context.thoughtLevel, sess: sid.slice(0, 16) });
              say(`档位跟随 -> ${e.context.thoughtLevel} (sess ${sid.slice(0, 16) || '?'})`);
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

function persistPid() {
  try {
    writePidRecord(pidPath(), {
      pid: process.pid,
      port: listenSnapshot.port,
      startedAt: state.startedAt,
    });
  } catch (e) {
    say(`pid 写入失败: ${e.message}`);
  }
}

function clearPid() {
  removePidFile(pidPath(), process.pid);
}

function watchConfig() {
  try {
    fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
      try {
        const next = loadConfig();
        if (next.listen.port !== listenSnapshot.port) {
          say(`忽略 listen.port 热加载 (${next.listen.port}); 改端口请重启`);
          next.listen.port = listenSnapshot.port;
          next.listen.host = listenSnapshot.host;
        }
        cfg = next;
        say(`配置已热加载(routes/templates/staticLevel): ${CONFIG_PATH}`);
      } catch (e) {
        say(`配置热加载失败, 保持旧配置: ${e.message}`);
      }
    });
  } catch {
    /* ignore */
  }
}

const server = createProxyServer({ getCfg: () => cfg, state, audit, say });

server.listen(listenSnapshot.port, listenSnapshot.host, () => {
  persistPid();
  say(`zcode-thinking-kit 代理已启动: http://${listenSnapshot.host}:${listenSnapshot.port}`);
  say(`配置: ${CONFIG_PATH}`);
  say(`审计日志: ${AUDIT_PATH}`);
  say(`健康检查: http://${listenSnapshot.host}:${listenSnapshot.port}/health`);
  for (const r of cfg.routes || []) say(`路由: ${r.match} -> ${r.upstream}`);
  watchConfig();
  startFollower();
});

server.on('error', (e) => {
  console.error('server error', e);
  clearPid();
  process.exit(1);
});

function shutdown() {
  clearPid();
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', () => {
  try {
    removePidFile(pidPath(), process.pid);
  } catch {
    /* ignore */
  }
});
