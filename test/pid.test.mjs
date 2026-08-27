import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { processExists, readPidRecord, removePidFile, writePidRecord } from '../lib/pid.mjs';

test('pid record roundtrip json and legacy numeric', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-pid-'));
  const file = path.join(dir, 'proxy.pid');
  writePidRecord(file, { pid: 12345, port: 38771, startedAt: 't0' });
  const rec = readPidRecord(file);
  assert.equal(rec.pid, 12345);
  assert.equal(rec.port, 38771);
  assert.equal(rec.name, 'zcode-thinking-kit');
  fs.writeFileSync(file, '99\n');
  assert.equal(readPidRecord(file).pid, 99);
  removePidFile(file, 99);
  assert.equal(fs.existsSync(file), false);
});

test('processExists sees current pid', () => {
  assert.equal(processExists(process.pid), true);
  assert.equal(processExists(1_000_000_000), false);
});
