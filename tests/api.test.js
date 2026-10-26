'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server.js');
const { Store } = require('../src/store.js');
const { hashApiKey } = require('../src/crypto.js');
const { RateLimiter } = require('../src/rate-limiter.js');

function startServer(store, extra = {}) {
  const server = createServer(Object.assign({ store, logger: { error: () => {} } }, extra));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: Object.assign(
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
          headers
        )
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch (err) {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('GET /healthz 返回 ok', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const server = await startServer(store);
  const res = await request(server, { path: '/healthz' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  server.close();
  store.close();
});

test('POST /api/v1/process 缺少 Authorization 返回 401', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const server = await startServer(store);
  const res = await request(server, { method: 'POST', path: '/api/v1/process', body: { text: 'hi' } });
  assert.equal(res.status, 401);
  assert.equal(res.json.success, false);
  assert.equal(res.json.error.code, 'UNAUTHORIZED');
  server.close();
  store.close();
});

test('POST /api/v1/process 缺少 text 返回 400', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = 'wr_live_testkey';
  store.createApiKey('tester', rawKey, hashApiKey(rawKey));
  const server = await startServer(store);
  const res = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: {}
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'INVALID_REQUEST');
  server.close();
  store.close();
});

test('POST /api/v1/process 文本超长返回 413', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  store.updateConfig({ maxTextLength: 10 });
  const rawKey = 'wr_live_testkey2';
  store.createApiKey('tester', rawKey, hashApiKey(rawKey));
  const server = await startServer(store);
  const res = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: { text: 'this text is definitely longer than ten characters' }
  });
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'TEXT_TOO_LONG');
  server.close();
  store.close();
});

test('POST /api/v1/process 未配置供应商时返回 500', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = 'wr_live_testkey3';
  store.createApiKey('tester', rawKey, hashApiKey(rawKey));
  const server = await startServer(store);
  const res = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: { text: 'hello' }
  });
  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, 'INTERNAL_ERROR');
  server.close();
  store.close();
});

test('限流器在超出窗口请求数后拒绝', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = 'wr_live_testkey4';
  store.createApiKey('tester', rawKey, hashApiKey(rawKey));
  const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1 });
  const server = await startServer(store, { rateLimiter: limiter });

  const first = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: { text: 'hello' }
  });
  // 第一次因为没有供应商会是 500，但会消耗一次限流名额
  assert.equal(first.status, 500);

  const second = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: { text: 'hello' }
  });
  assert.equal(second.status, 429);
  assert.equal(second.json.error.code, 'RATE_LIMITED');

  server.close();
  store.close();
});

test('管理后台首次访问提示需要初始化', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const server = await startServer(store);
  const res = await request(server, { path: '/api/admin/bootstrap-status' });
  assert.equal(res.status, 200);
  assert.equal(res.json.needsSetup, true);
  server.close();
  store.close();
});

test('管理后台创建管理员账号并登录成功', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const server = await startServer(store);

  const bootstrapRes = await request(server, {
    method: 'POST',
    path: '/api/admin/bootstrap',
    body: { username: 'admin', password: 'password123' }
  });
  assert.equal(bootstrapRes.status, 200);

  const loginRes = await request(server, {
    method: 'POST',
    path: '/api/admin/login',
    body: { username: 'admin', password: 'password123' }
  });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.json.success);

  const loginFail = await request(server, {
    method: 'POST',
    path: '/api/admin/login',
    body: { username: 'admin', password: 'wrong-password' }
  });
  assert.equal(loginFail.status, 401);

  server.close();
  store.close();
});

test('未登录访问需鉴权的管理接口返回 401', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const server = await startServer(store);
  const res = await request(server, { path: '/api/admin/prompts' });
  assert.equal(res.status, 401);
  server.close();
  store.close();
});
