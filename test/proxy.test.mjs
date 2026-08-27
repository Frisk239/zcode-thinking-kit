import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createProxyServer } from '../lib/proxy.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request({ port, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body != null) req.end(body);
    else req.end();
  });
}

test('health stays up after unmatched route 502', async () => {
  const cfg = {
    listen: { host: '127.0.0.1', port: 0 },
    routes: [{ match: '/only', upstream: 'http://127.0.0.1:9' }],
  };
  const state = { startedAt: 't', levelsBySession: new Map() };
  const proxy = createProxyServer({ getCfg: () => cfg, state });
  const port = await listen(proxy);
  try {
    const miss = await request({ port, method: 'POST', path: '/nope', body: '{}' });
    assert.equal(miss.status, 502);
    const health = await request({ port, path: '/health' });
    assert.equal(health.status, 200);
    const json = JSON.parse(health.body);
    assert.equal(json.name, 'zcode-thinking-kit');
    assert.equal(json.ok, true);
  } finally {
    await close(proxy);
  }
});

test('invalid upstream is 502 and does not crash', async () => {
  const cfg = {
    listen: { host: '127.0.0.1', port: 0 },
    routes: [{ match: '/bad', upstream: 'not-a-url' }],
  };
  const proxy = createProxyServer({ getCfg: () => cfg, state: { levelsBySession: new Map() } });
  const port = await listen(proxy);
  try {
    const res = await request({ port, method: 'POST', path: '/bad/x', body: '{}' });
    assert.equal(res.status, 502);
    const health = await request({ port, path: '/health' });
    assert.equal(health.status, 200);
  } finally {
    await close(proxy);
  }
});

test('injects per x-session-id and strips hop-by-hop; fail-open on bad json', async () => {
  let seen = [];
  const up = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(up);
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
  const state = {
    sessionLevel: 'medium',
    levelsBySession: new Map([
      ['sess-a', { level: 'low' }],
      ['sess-b', { level: 'max' }],
    ]),
  };
  const proxy = createProxyServer({ getCfg: () => cfg, state });
  const port = await listen(proxy);
  try {
    const a = await request({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'sess-a',
        'proxy-authorization': 'secret',
        te: 'trailers',
      },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(a.status, 200);
    const b = await request({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'x-session-id': 'sess-b' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(b.status, 200);
    const bad = await request({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(bad.status, 200);
    assert.equal(JSON.parse(seen[0].body).reasoning_effort, 'low');
    assert.equal(JSON.parse(seen[1].body).reasoning_effort, 'max');
    assert.equal(seen[2].body, '{not-json');
    assert.equal(seen[0].headers['proxy-authorization'], undefined);
    assert.equal(seen[0].headers.te, undefined);
  } finally {
    await close(proxy);
    await close(up);
  }
});

test('body over max returns 413', async () => {
  const cfg = {
    listen: { host: '127.0.0.1', port: 0 },
    routes: [{ match: '/v1', upstream: 'http://127.0.0.1:9' }],
  };
  const proxy = createProxyServer({ getCfg: () => cfg, state: { levelsBySession: new Map() }, maxBody: 16 });
  const port = await listen(proxy);
  try {
    const res = await request({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      body: 'abcdefghijklmnopqrstuvwxyz',
    });
    assert.equal(res.status, 413);
  } finally {
    await close(proxy);
  }
});
