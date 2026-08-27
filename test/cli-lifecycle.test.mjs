import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const KIT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(KIT, 'cli.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: KIT,
      env,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          resolve(res.statusCode === 200 && json.name === 'zcode-thinking-kit');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

test('cli start/stop in a temp home does not touch ~/.zcode', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-life-'));
  const port = await freePort();
  const cfgPath = path.join(tmp, 'thinking.config.json');
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      listen: { host: '127.0.0.1', port },
      levelSource: { followZcodeLog: false, staticLevel: 'high' },
      routes: [
        {
          match: '/v1',
          upstream: 'http://127.0.0.1:9',
          followSession: false,
          defaultInject: { 'chat/completions': { reasoning_effort: '{level}' } },
        },
      ],
    }) + '\n',
  );
  const env = {
    ...process.env,
    ZCODE_THINKING_KIT_HOME: tmp,
    ZCODE_THINKING_KIT_CONFIG: cfgPath,
    ZCODE_LOG_DIR: path.join(tmp, 'logs'),
    ZCODE_V2_CONFIG: path.join(tmp, 'no-v2.json'),
  };
  t.after(async () => {
    await runCli(['stop', `--config=${cfgPath}`], env);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const started = await runCli(['start', `--config=${cfgPath}`], env);
  assert.equal(started.code, 0, started.out + started.err);
  assert.match(started.out, /\[OK\] started/);
  assert.equal(await health(port), true);

  const pidFile = path.join(tmp, 'proxy.pid');
  assert.equal(fs.existsSync(pidFile), true);
  const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(rec.port, port);
  assert.equal(rec.name, 'zcode-thinking-kit');

  const stopped = await runCli(['stop', `--config=${cfgPath}`], env);
  assert.equal(stopped.code, 0, stopped.out + stopped.err);
  assert.match(stopped.out, /\[OK\] stopped/);
  assert.equal(await health(port), false);
  assert.equal(fs.existsSync(pidFile), false);

  try {
    process.kill(rec.pid, 0);
    assert.fail(`pid ${rec.pid} still alive after stop`);
  } catch {
    /* expected: process gone */
  }
});
