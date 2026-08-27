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
import { readJson, suggestFromZcodeConfig } from './lib/suggest.mjs';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const configArg = rest.find((a) => a.startsWith('--config='))?.slice('--config='.length);

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
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

function readPid() {
  try {
    const raw = fs.readFileSync(pidPath(), 'utf8').trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fetchHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, json: JSON.parse(buf) });
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

async function cmdStatus() {
  const { port } = listenFromConfig();
  const pid = readPid();
  const health = await fetchHealth(port);
  const alive = isAlive(pid);
  console.log(`config:  ${configPath()}`);
  console.log(`pid:     ${pid || '-'} ${alive ? '(alive)' : pid ? '(stale)' : ''}`);
  console.log(`listen:  http://127.0.0.1:${port}`);
  console.log(`health:  ${health.ok ? 'ok' : 'down'}`);
  if (health.json) {
    console.log(`level:   ${health.json.sessionLevel || '-'} @ ${health.json.sessionLevelAt || '-'}`);
    for (const r of health.json.routes || []) {
      console.log(`route:   ${r.match} -> ${r.upstream}`);
    }
  }
  process.exit(health.ok ? 0 : 1);
}

function cmdStart() {
  ensureDataDir();
  const cfg = ensureConfig();
  const { port } = listenFromConfig();
  const pid = readPid();
  if (isAlive(pid)) {
    console.log(`[OK] already running pid=${pid} http://127.0.0.1:${port}`);
    return;
  }
  const child = spawn(process.execPath, [path.join(KIT_DIR, 'server.mjs'), `--config=${cfg}`], {
    cwd: KIT_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log(`[OK] started pid=${child.pid} http://127.0.0.1:${port}/health`);
  console.log(`config ${cfg}`);
}

function cmdStop() {
  const pid = readPid();
  if (!pid) {
    console.log('not running (no pid file)');
    return;
  }
  if (!isAlive(pid)) {
    try {
      fs.unlinkSync(pidPath());
    } catch {
      /* ignore */
    }
    console.log('not running (stale pid removed)');
    return;
  }
  try {
    process.kill(pid);
    console.log(`[OK] stopped pid=${pid}`);
  } catch (e) {
    die(`stop failed: ${e.message}`);
  }
}

function cmdRun() {
  const cfg = ensureConfig();
  const child = spawn(process.execPath, [path.join(KIT_DIR, 'server.mjs'), `--config=${cfg}`], {
    cwd: KIT_DIR,
    stdio: 'inherit',
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
    for (const r of routes) console.log(`  ${r.match} -> ${r.upstream}`);
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
  node cli.mjs start              start detached on 127.0.0.1
  node cli.mjs stop
  node cli.mjs status
  node cli.mjs run                foreground
  node cli.mjs doctor
  node cli.mjs suggest [--write]  build routes from ~/.zcode/v2/config.json
  node cli.mjs help

Config search: --config=PATH, $ZCODE_THINKING_KIT_CONFIG,
./thinking.config.json, kit dir, then ~/.zcode-thinking-kit/
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
