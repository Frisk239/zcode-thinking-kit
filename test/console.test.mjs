import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createProxyServer } from '../lib/proxy.mjs';
import { copyBaseurls, suggestSafe } from '../lib/console-api.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
function request({ port, method = 'GET', path: p = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    if (body != null) req.end(body);
    else req.end();
  });
}

test('copyBaseurls builds proxied http://127.0.0.1:port/match', () => {
  const out = copyBaseurls({
    listen: { port: 38771 },
    routes: [{ match: '/zen/go/v1', upstream: 'https://opencode.ai' }],
  });
  assert.equal(out.routes[0].proxied, 'http://127.0.0.1:38771/zen/go/v1');
  assert.equal(out.routes[0].original, 'https://opencode.ai/zen/go/v1');
});

test('suggestSafe never contains apiKey', () => {
  const out = suggestSafe({
    provider: {
      p: {
        name: 'go',
        kind: 'openai-compatible',
        options: { apiKey: 'sk-SECRETVALUE999', baseURL: 'https://opencode.ai/zen/go/v1' },
        models: { m: { reasoning: { enabled: true, variants: ['max'], defaultVariant: 'max' } } },
      },
    },
  }, 38771);
  const blob = JSON.stringify(out);
  assert.equal(blob.includes('apiKey'), false);
  assert.equal(blob.includes('sk-SECRETVALUE999'), false);
  assert.equal(out.routes[0].proxied, 'http://127.0.0.1:38771/zen/go/v1');
});

test('GET / is html and does not swallow /v1 proxy path', async () => {
  let seen = [];
  const up = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(up);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-con-'));
  const auditPath = path.join(tmp, 'audit.jsonl');
  const v2Path = path.join(tmp, 'v2.json');
  fs.writeFileSync(
    v2Path,
    JSON.stringify({
      provider: {
        p: {
          name: 'x',
          kind: 'openai-compatible',
          options: { apiKey: 'sk-NOTINRESPONSE', baseURL: 'https://example.com/v1' },
          models: { m: { reasoning: { enabled: true, defaultVariant: 'high', variants: ['high'] } } },
        },
      },
    }),
  );
  const cfg = {
    listen: { host: '127.0.0.1', port: 0 },
    routes: [
      {
        match: '/v1',
        upstream: `http://127.0.0.1:${upPort}`,
        followSession: true,
        defaultInject: { 'chat/completions': { reasoning_effort: '{level}' } },
      },
    ],
  };
  const proxy = createProxyServer({
    getCfg: () => ({ ...cfg, listen: { host: '127.0.0.1', port: 0 } }),
    state: { startedAt: 't', levelsBySession: new Map(), lastInject: null },
    auditPath,
    v2Path,
  });
  const port = await listen(proxy);
  try {
    const page = await request({ port, path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'] || '', /text\/html/);
    assert.match(page.body, /zcode-thinking-kit/);
    assert.equal(page.body.includes('<html'), true);

    const sug = await request({ port, path: '/api/suggest' });
    assert.equal(sug.status, 200);
    assert.equal(sug.body.includes('apiKey'), false);
    assert.equal(sug.body.includes('sk-NOTINRESPONSE'), false);

    const urls = await request({ port, path: '/api/copy-baseurls' });
    const u = JSON.parse(urls.body);
    assert.equal(u.routes[0].match, '/v1');

    const proxied = await request({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(proxied.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(JSON.parse(seen[0].body).model, 'm');
  } finally {
    await close(proxy);
    await close(up);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
