#!/usr/bin/env node
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {
  dataDir,
  defaultLogDir,
  defaultZcodeV2Config,
  ensureDataDir,
  exampleConfigPath,
  KIT_DIR,
  pidPath,
  resolveConfigPath,
} from './lib/paths.mjs';
import { processExists, readPidRecord, removePidFile } from './lib/pid.mjs';
import { readJson, suggestFromZcodeConfig } from './lib/suggest.mjs';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const configArg = rest.find((a) => a.startsWith('--config='))?.slice('--config='.length);

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function configPath() {
  return resolveConfigPath(configArg);
}

function ensureConfig() {
  const dest = configPath();
  if (fs.existsSync(dest)) return dest;
  const example = exampleConfigPath();
  if (!fs.existsSync(example)) die(`missing example config: ${example}`);
  fs.copyFileSync(example, dest);
  console.log(`created ${dest} from example`);
  return dest;
}

function listenFromConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ensureConfig(), 'utf8'));
    return {
      host: '127.0.0.1',
      port: Number(cfg.listen && cfg.listen.port) || 38771,
    };
  } catch {
    return { host: '127.0.0.1', port: 38771 };
  }
}

function fetchHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          resolve({ ok: res.statusCode === 200 && json.name === 'zcode-thinking-kit', json });
        } catch {
          resolve({ ok: false, json: null });
        }
      });
    });
    req.on('error', () => resolve({ ok: false, json: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, json: null });
    });
  });
}

async function waitHealth(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h = await fetchHealth(port);
    if (h.ok) return h;
    await sleep(150);
  }
  return { ok: false, json: null };
}

function tailFile(file, maxBytes = 4000) {
  try {
    const buf = fs.readFileSync(file);
    const slice = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
    return slice.toString('utf8').trim();
  } catch {
    return '';
  }
}

async function cmdStatus() {
  const { port } = listenFromConfig();
  const rec = readPidRecord(pidPath());
  const health = await fetchHealth(port);
  const alive = rec ? processExists(rec.pid) : false;
  console.log(`config:  ${configPath()}`);
  console.log(`pid:     ${rec ? rec.pid : '-'} ${alive ? '(alive)' : rec ? '(stale)' : ''}`);
  console.log(`listen:  http://127.0.0.1:${port}`);
  console.log(`health:  ${health.ok ? 'ok' : 'down'}`);
  if (health.json) {
    console.log(`level:   ${health.json.sessionLevel || '-'} @ ${health.json.sessionLevelAt || '-'}`);
    console.log(`sessions:${health.json.sessionCount ?? '-'}`);
    for (const r of health.json.routes || []) {
      console.log(`route:   ${r.match} -> ${r.upstream}`);
    }
  }
  process.exit(health.ok ? 0 : 1);
}

async function cmdStart() {
  ensureDataDir();
  const cfg = ensureConfig();
  const { port } = listenFromConfig();
  const health = await fetchHealth(port);
  if (health.ok) {
    const rec = readPidRecord(pidPath());
    console.log(`[OK] already running pid=${rec ? rec.pid : '?'} http://127.0.0.1:${port}`);
    return;
  }
  const rec = readPidRecord(pidPath());
  if (rec && processExists(rec.pid) && !health.ok) {
    die(`port ${port} is not this kit, but pid ${rec.pid} is still alive; not starting`);
  }
  if (rec && !processExists(rec.pid)) removePidFile(pidPath());

  const errLog = path.join(dataDir(), 'proxy.err.log');
  const outLog = path.join(dataDir(), 'proxy.out.log');
  const outFd = fs.openSync(outLog, 'a');
  const errFd = fs.openSync(errLog, 'a');
  const child = spawn(process.execPath, [path.join(KIT_DIR, 'server.mjs'), `--config=${cfg}`], {
    cwd: KIT_DIR,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    env: process.env,
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  child.unref();

  const ready = await waitHealth(port);
  if (!ready.ok) {
    const tail = tailFile(errLog);
    console.error(`[FAIL] started pid=${child.pid} but /health did not come up on :${port}`);
    if (tail) console.error(tail);
    process.exit(1);
  }
  console.log(`[OK] started pid=${child.pid} http://127.0.0.1:${port}/health`);
  console.log(`config ${cfg}`);
}

async function cmdStop() {
  const { port } = listenFromConfig();
  const rec = readPidRecord(pidPath());
  const health = await fetchHealth(port);

  if (health.ok && rec && processExists(rec.pid)) {
    try {
      process.kill(rec.pid);
    } catch (e) {
      die(`stop failed: ${e.message}`);
    }
    for (let i = 0; i < 20; i++) {
      if (!processExists(rec.pid)) break;
      await sleep(100);
    }
    removePidFile(pidPath(), rec.pid);
    console.log(`[OK] stopped pid=${rec.pid}`);
    return;
  }

  if (health.ok && (!rec || !processExists(rec && rec.pid))) {
    console.log('[WARN] /health is up but pid file does not match; not killing unknown process');
    process.exit(1);
  }

  if (rec && processExists(rec.pid) && !health.ok) {
    console.log(`[WARN] pid ${rec.pid} is alive but is not this kit on :${port}; not killing`);
    removePidFile(pidPath(), rec.pid);
    process.exit(1);
  }

  if (rec) {
    removePidFile(pidPath());
    console.log('not running (stale pid removed)');
    return;
  }
  console.log('not running (no pid file)');
}

function cmdRun() {
  const cfg = ensureConfig();
  const child = spawn(process.execPath, [path.join(KIT_DIR, 'server.mjs'), `--config=${cfg}`], {
    cwd: KIT_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function cmdDoctor() {
  const cfgPath = ensureConfig();
  const problems = [];
  console.log(`node     ${process.version}`);
  console.log(`kit      ${KIT_DIR}`);
  console.log(`data     ${dataDir()}`);
  console.log(`config   ${cfgPath}`);
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const routes = cfg.routes || [];
    console.log(`routes   ${routes.length}`);
    for (const r of routes) {
      console.log(`  ${r.match} -> ${r.upstream}`);
      if (!r.defaultInject) problems.push(`route ${r.match} has no defaultInject`);
    }
    if (!routes.length) problems.push('no routes configured');
  } catch (e) {
    problems.push(`config parse: ${e.message}`);
  }
  const logDir = defaultLogDir();
  console.log(`zcode log dir  ${logDir} ${fs.existsSync(logDir) ? '(exists)' : '(missing)'}`);
  if (!fs.existsSync(logDir)) problems.push('ZCode log dir not found; UI level follow will stay on staticLevel');
  const v2 = defaultZcodeV2Config();
  console.log(`zcode v2 cfg   ${v2} ${fs.existsSync(v2) ? '(exists)' : '(missing)'}`);
  if (problems.length) {
    console.log('\nproblems:');
    for (const p of problems) console.log(`- ${p}`);
    process.exit(1);
  }
  console.log('\n[OK] doctor passed');
}

function cmdSuggest() {
  const v2 = rest.find((a) => !a.startsWith('--')) || defaultZcodeV2Config();
  if (!fs.existsSync(v2)) die(`ZCode config not found: ${v2}`);
  const raw = readJson(v2);
  const out = suggestFromZcodeConfig(raw);
  console.log('# providers (no secrets)');
  for (const row of out.summary) {
    const names = row.providers.map((p) => p.name).join(', ');
    console.log(`- ${row.match} -> ${row.upstream}  [${names}] models=${row.modelCount}`);
  }
  const suggested = {
    listen: out.listen,
    levelSource: out.levelSource,
    routes: out.routes,
  };
  const write = rest.includes('--write');
  if (write) {
    const dest = configPath();
    fs.writeFileSync(dest, JSON.stringify(suggested, null, 2) + '\n');
    console.log(`\nwrote ${dest}`);
  } else {
    console.log('\n# suggested thinking.config.json  (pass --write to save)');
    console.log(JSON.stringify(suggested, null, 2));
  }
}

function cmdHelp() {
  console.log(`zcode-thinking-kit — inject reasoning/thinking for ZCode custom models

Usage:
  node cli.mjs start              start detached on 127.0.0.1; waits for /health
  node cli.mjs stop               stop only if /health is this kit
  node cli.mjs status
  node cli.mjs run                foreground
  node cli.mjs doctor
  node cli.mjs suggest [--write]  build routes from ~/.zcode/v2/config.json
  node cli.mjs help

Config search: --config=PATH, $ZCODE_THINKING_KIT_CONFIG,
./thinking.config.json, kit dir, then ~/.zcode-thinking-kit/

Env: ZCODE_THINKING_KIT_HOME, ZCODE_LOG_DIR, ZCODE_V2_CONFIG
`);
}

const commands = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  run: cmdRun,
  doctor: cmdDoctor,
  suggest: cmdSuggest,
  help: cmdHelp,
  '-h': cmdHelp,
  '--help': cmdHelp,
};

const fn = commands[cmd];
if (!fn) {
  cmdHelp();
  die(`unknown command: ${cmd}`);
}
await fn();
