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
  // 返回 headers 以便检查 Set-Cookie / Location
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
          resolve({ status: res.statusCode, json, raw, headers: res.headers });
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

test('未登录访问需鉴权的管理接口返回 401', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const server = await startServer(store);
  const res = await request(server, { path: '/api/admin/prompts' });
  assert.equal(res.status, 401);
  server.close();
  store.close();
});

// ---------------- 统一账号中心登录 + 设置/API Key ----------------

const crypto = require('node:crypto');
const { createAccAuth } = require('../src/acc-auth.js');

const ACC = 'https://acc.example.test';
const CLIENT_ID = 'app_TEST';
const REDIRECT = 'http://wr.test/api/auth/callback';

/** 伪造 acc：自签 RS256 id_token，JWKS 返回对应公钥 */
function makeFakeAcc({ role = 'admin', aud = CLIENT_ID, iss = ACC } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
  let lastAuthorize = null;
  function sign(payload) {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url');
    return h + '.' + p + '.' + sig;
  }
  const fetch = async (url, init = {}) => {
    if (url === ACC + '/.well-known/jwks.json') return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
    if (url === ACC + '/v1/oauth/token') {
      const body = JSON.parse(init.body);
      const expect = crypto.createHash('sha256').update(body.code_verifier).digest('base64url');
      if (body.code !== 'good-code' || expect !== lastAuthorize.get('code_challenge') || body.redirect_uri !== REDIRECT) {
        return { ok: false, status: 400, json: async () => ({ message: 'INVALID_GRANT' }) };
      }
      const now = Math.floor(Date.now() / 1000);
      const idToken = sign({ iss, aud, sub: 'U1', role, email: 'boss@example.com', name: 'Boss', nonce: lastAuthorize.get('nonce'), iat: now, exp: now + 3600 });
      return { ok: true, status: 200, json: async () => ({ access_token: 'x', id_token: idToken }) };
    }
    throw new Error('unexpected fetch ' + url);
  };
  const accAuth = createAccAuth({ accBase: ACC, clientId: CLIENT_ID, redirectUri: REDIRECT, requiredRole: 'admin', fetch });
  return { accAuth, setAuthorize: (u) => { lastAuthorize = new URL(u).searchParams; } };
}

function cookiesFrom(res) {
  const sc = res.headers['set-cookie'] || [];
  return sc.map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
}

async function loginViaAcc(server, fake) {
  const start = await request(server, { path: '/api/auth/login' });
  assert.equal(start.status, 302);
  fake.setAuthorize(start.headers.location);
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await request(server, {
    path: '/api/auth/callback?code=good-code&state=' + encodeURIComponent(state),
    headers: { cookie: cookiesFrom(start) }
  });
  return cb;
}

test('/api/auth/login 302 到 acc 授权页，携带 PKCE S256 与 state cookie', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const fake = makeFakeAcc();
  const server = await startServer(store, { accAuth: fake.accAuth });
  const res = await request(server, { path: '/api/auth/login' });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.location);
  assert.equal(loc.origin + loc.pathname, ACC + '/v1/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(loc.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(loc.searchParams.get('code_challenge'));
  assert.match(String(res.headers['set-cookie']), /wenrong_oauth_state=/);
  server.close();
  store.close();
});

test('acc 回调成功后签发会话，可访问管理接口与 /api/auth/me', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const fake = makeFakeAcc();
  const server = await startServer(store, { accAuth: fake.accAuth });
  const cb = await loginViaAcc(server, fake);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.location, '/');
  const cookie = cookiesFrom(cb);
  assert.match(cookie, /wenrong_session=/);

  const me = await request(server, { path: '/api/auth/me', headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'boss@example.com');
  assert.equal(me.json.user.role, 'admin');

  const prompts = await request(server, { path: '/api/admin/prompts', headers: { cookie } });
  assert.equal(prompts.status, 200);

  const logout = await request(server, { method: 'POST', path: '/api/auth/logout', headers: { cookie } });
  assert.equal(logout.status, 200);
  const after = await request(server, { path: '/api/admin/prompts', headers: { cookie } });
  assert.equal(after.status, 401);
  server.close();
  store.close();
});

test('acc 回调：state 与 cookie 不一致时拒绝（防登录 CSRF）', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const fake = makeFakeAcc();
  const server = await startServer(store, { accAuth: fake.accAuth });
  const start = await request(server, { path: '/api/auth/login' });
  fake.setAuthorize(start.headers.location);
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await request(server, { path: '/api/auth/callback?code=good-code&state=' + encodeURIComponent(state) });
  assert.equal(cb.status, 400);
  assert.ok(!String(cb.headers['set-cookie'] || '').includes('wenrong_session=s'));
  server.close();
  store.close();
});

test('acc 回调：非 admin 角色拒绝登录', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const fake = makeFakeAcc({ role: 'user' });
  const server = await startServer(store, { accAuth: fake.accAuth });
  const cb = await loginViaAcc(server, fake);
  assert.equal(cb.status, 403);
  server.close();
  store.close();
});

test('acc 回调：id_token 受众不匹配时拒绝', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const fake = makeFakeAcc({ aud: 'app_OTHER' });
  const server = await startServer(store, { accAuth: fake.accAuth });
  const cb = await loginViaAcc(server, fake);
  assert.equal(cb.status, 401);
  server.close();
  store.close();
});

test('旧 /admin 路由已移除，管理台托管在根路径', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const server = await startServer(store);
  const old = await request(server, { path: '/admin/' });
  assert.equal(old.status, 404);
  const old2 = await request(server, { path: '/admin' });
  assert.equal(old2.status, 404);
  const root = await request(server, { path: '/' });
  assert.equal(root.status, 200);
  assert.match(root.raw, /src="\/app\.js"/);
  const js = await request(server, { path: '/app.js' });
  assert.equal(js.status, 200);
  server.close();
  store.close();
});

test('设置：可创建多个 API Key，各自可调用业务 API；禁用/删除后立即失效', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const fake = makeFakeAcc();
  const server = await startServer(store, { accAuth: fake.accAuth });
  const cookie = cookiesFrom(await loginViaAcc(server, fake));

  const a = await request(server, { method: 'POST', path: '/api/admin/api-keys', headers: { cookie }, body: { label: 'caller-a' } });
  const b = await request(server, { method: 'POST', path: '/api/admin/api-keys', headers: { cookie }, body: { label: 'caller-b' } });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.json.data.apiKey, b.json.data.apiKey);

  const list = await request(server, { path: '/api/admin/api-keys', headers: { cookie } });
  assert.equal(list.json.data.length, 2);
  assert.equal(list.json.data[0].createdBy, 'acc:boss@example.com');
  assert.ok(!JSON.stringify(list.json).includes(a.json.data.apiKey), '列表不得返回完整 key');

  // 未配置供应商时，合法 key 走到 500（说明鉴权已通过）；无效 key 401
  const callWith = (k) => request(server, { method: 'POST', path: '/api/v1/process', headers: { authorization: 'Bearer ' + k }, body: { text: 'hi' } });
  assert.equal((await callWith(a.json.data.apiKey)).status, 500);
  assert.equal((await callWith(b.json.data.apiKey)).status, 500);
  assert.equal((await callWith('wr_live_bogus')).status, 401);

  // 重命名
  const ren = await request(server, { method: 'PUT', path: '/api/admin/api-keys/' + a.json.data.id, headers: { cookie }, body: { label: 'caller-a2' } });
  assert.equal(ren.status, 200);

  // 禁用 a → a 401，b 不受影响
  await request(server, { method: 'PUT', path: '/api/admin/api-keys/' + a.json.data.id, headers: { cookie }, body: { enabled: false } });
  assert.equal((await callWith(a.json.data.apiKey)).status, 401);
  assert.equal((await callWith(b.json.data.apiKey)).status, 500);

  // 删除 b → b 401
  await request(server, { method: 'DELETE', path: '/api/admin/api-keys/' + b.json.data.id, headers: { cookie } });
  assert.equal((await callWith(b.json.data.apiKey)).status, 401);

  // 不存在的 id → 404；空名称 → 400
  assert.equal((await request(server, { method: 'DELETE', path: '/api/admin/api-keys/key_nope', headers: { cookie } })).status, 404);
  assert.equal((await request(server, { method: 'POST', path: '/api/admin/api-keys', headers: { cookie }, body: { label: '  ' } })).status, 400);

  server.close();
  store.close();
});

/** 本地假上游：按 path 返回固定状态，不访问真实模型 */
function fakeUpstream(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function withProvider(store, baseUrl, { maxRetries = 0 } = {}) {
  const rawKey = 'wr_live_' + Math.random().toString(16).slice(2, 10);
  store.createApiKey('tester', rawKey, hashApiKey(rawKey));
  store.createProvider({
    name: 'fake',
    baseUrl,
    apiKey: 'sk-test',
    model: 'fake-model',
    timeoutMs: 5000,
    maxRetries,
    isDefault: true
  });
  return rawKey;
}

test('上游返回 429 时原样透传 UPSTREAM_RATE_LIMITED 与 Retry-After', async () => {
  const upstream = await fakeUpstream((req, raw, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' });
    res.end(JSON.stringify({ error: { message: 'slow down' } }));
  });
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = withProvider(store, 'http://127.0.0.1:' + upstream.address().port);
  const server = await startServer(store);
  const res = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: { text: 'hello world' }
  });
  assert.equal(res.status, 429);
  assert.equal(res.json.error.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(res.headers['retry-after'], '7');
  server.close();
  upstream.close();
  store.close();
});

test('上游返回 500 时映射为 502 LLM_UPSTREAM_ERROR', async () => {
  const upstream = await fakeUpstream((req, raw, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = withProvider(store, 'http://127.0.0.1:' + upstream.address().port);
  const server = await startServer(store);
  const res = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: { text: 'hello world' }
  });
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, 'LLM_UPSTREAM_ERROR');
  assert.match(res.json.error.message, /boom/);
  server.close();
  upstream.close();
  store.close();
});

test('上游 500 会按 maxRetries 重试后再失败', async () => {
  let hits = 0;
  const upstream = await fakeUpstream((req, raw, res) => {
    hits += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = withProvider(store, 'http://127.0.0.1:' + upstream.address().port, { maxRetries: 1 });
  const server = await startServer(store);
  const res = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: { text: 'hello world' }
  });
  assert.equal(res.status, 502);
  assert.equal(hits, 2);
  server.close();
  upstream.close();
  store.close();
});

test('成功响应去掉「专名（专名）」重复括注，并支持幂等回放', async () => {
  let hits = 0;
  const upstream = await fakeUpstream((req, raw, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'fake-model',
        choices: [{ message: { content: 'Acme Robotics（Acme Robotics）宣布融资。' } }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
      })
    );
  });
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = withProvider(store, 'http://127.0.0.1:' + upstream.address().port);
  const server = await startServer(store);
  const call = () =>
    request(server, {
      method: 'POST',
      path: '/api/v1/process',
      headers: { Authorization: 'Bearer ' + rawKey, 'Idempotency-Key': 'idem-key-001', 'X-Request-Id': 'req-from-caller' },
      body: { text: 'Acme Robotics raised a round.' }
    });
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.json.requestId, 'req-from-caller');
  assert.equal(first.json.data.result, 'Acme Robotics宣布融资。');
  assert.equal(hits, 1);

  const second = await call();
  assert.equal(second.status, 200);
  assert.equal(second.json.idempotentReplay, true);
  assert.equal(hits, 1);

  const conflict = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey, 'Idempotency-Key': 'idem-key-001' },
    body: { text: 'different text' }
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');

  server.close();
  upstream.close();
  store.close();
});

test('本机限流 429 带 Retry-After', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = 'wr_live_ratelimit';
  store.createApiKey('tester', rawKey, hashApiKey(rawKey));
  const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1 });
  const server = await startServer(store, { rateLimiter: limiter });
  await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: { text: 'hello' }
  });
  const second = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: { text: 'hello' }
  });
  assert.equal(second.status, 429);
  assert.equal(second.json.error.code, 'RATE_LIMITED');
  assert.ok(Number(second.headers['retry-after']) > 0);
  server.close();
  store.close();
});

function rawRequest(server, { method = 'POST', path, headers = {}, raw }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (err) { json = null; }
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    req.end(raw);
  });
}

test('响应头带 X-Request-Id 与 X-RateLimit-*，错误体带 retryable', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = 'wr_live_headers01';
  store.createApiKey('tester', rawKey, hashApiKey(rawKey));
  const server = await startServer(store, { rateLimiter: new RateLimiter({ windowMs: 60000, maxRequests: 5 }) });
  const res = await request(server, { method: 'POST', path: '/api/v1/process', headers: { Authorization: 'Bearer ' + rawKey }, body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.headers['x-request-id'], res.json.requestId);
  assert.equal(res.headers['x-ratelimit-limit'], '5');
  assert.equal(res.headers['x-ratelimit-remaining'], '4');
  assert.ok(Number(res.headers['x-ratelimit-reset']) > 0);
  assert.equal(res.json.error.retryable, false);
  server.close();
  store.close();
});

test('非法 JSON 返回 MALFORMED_JSON，超大请求体返回 413 BODY_TOO_LARGE', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = 'wr_live_bodyerr01';
  store.createApiKey('tester', rawKey, hashApiKey(rawKey));
  const server = await startServer(store);
  const bad = await rawRequest(server, { path: '/api/v1/process', headers: { Authorization: 'Bearer ' + rawKey }, raw: '{"text": ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'MALFORMED_JSON');
  const big = await rawRequest(server, {
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    raw: JSON.stringify({ text: 'a'.repeat(2 * 1024 * 1024 + 10) })
  });
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, 'BODY_TOO_LARGE');
  assert.equal(big.json.error.unit, 'bytes');
  server.close();
  store.close();
});

test('TEXT_TOO_LONG 返回 limit / actualLength / unit', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  store.updateConfig({ maxTextLength: 10 });
  const rawKey = 'wr_live_toolong01';
  store.createApiKey('tester', rawKey, hashApiKey(rawKey));
  const server = await startServer(store);
  const res = await request(server, { method: 'POST', path: '/api/v1/process', headers: { Authorization: 'Bearer ' + rawKey }, body: { text: 'x'.repeat(25) } });
  assert.equal(res.status, 413);
  assert.deepEqual([res.json.error.limit, res.json.error.actualLength, res.json.error.unit], [10, 25, 'chars']);
  server.close();
  store.close();
});

test('可选字段校验：targetLang / glossary / temperature / instruction', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = 'wr_live_optval01';
  store.createApiKey('tester', rawKey, hashApiKey(rawKey));
  const server = await startServer(store);
  const call = (extra) => request(server, { method: 'POST', path: '/api/v1/process', headers: { Authorization: 'Bearer ' + rawKey }, body: Object.assign({ text: 'hi' }, extra) });
  assert.equal((await call({ targetLang: 'xx' })).json.error.field, 'targetLang');
  assert.equal((await call({ glossary: ['a'] })).json.error.field, 'glossary');
  assert.equal((await call({ temperature: 3 })).json.error.field, 'temperature');
  assert.equal((await call({ instruction: 1 })).json.error.field, 'instruction');
  assert.equal((await call({ prompt: 1 })).json.error.field, 'prompt');
  server.close();
  store.close();
});

test('成功响应带 promptVersion / detectedLang / targetLang，并把追加层与 temperature 传给上游', async () => {
  let seen = null;
  const upstream = await fakeUpstream((req, raw, res) => {
    seen = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content: 'Bonjour' } }], usage: {} }));
  });
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = withProvider(store, 'http://127.0.0.1:' + upstream.address().port);
  const server = await startServer(store);
  const res = await request(server, {
    method: 'POST',
    path: '/api/v1/process',
    headers: { Authorization: 'Bearer ' + rawKey },
    body: { text: 'Hello world', targetLang: 'fr', glossary: { world: 'monde' }, instruction: '保持简短', temperature: 0 }
  });
  assert.equal(res.status, 200);
  assert.match(res.json.data.promptVersion, /^pv_[0-9a-f]{12}$/);
  assert.equal(res.json.data.detectedLang, 'en');
  assert.equal(res.json.data.targetLang, 'fr');
  assert.equal(res.json.data.usedPrompt, 'default_translate_polish');
  assert.equal(seen.temperature, 0);
  const user = seen.messages[1].content;
  assert.match(user, /Français（fr）/);
  assert.match(user, /- world → monde/);
  assert.match(user, /保持简短/);

  // 不带追加层时 promptVersion 不同（追加层计入版本）
  const plain = await request(server, { method: 'POST', path: '/api/v1/process', headers: { Authorization: 'Bearer ' + rawKey }, body: { text: 'Hello world' } });
  assert.notEqual(plain.json.data.promptVersion, res.json.data.promptVersion);
  assert.equal(plain.json.data.targetLang, 'zh');
  server.close();
  upstream.close();
  store.close();
});

test('上游 400 不标 retryable，上游 500 标 retryable', async () => {
  let code = 400;
  const upstream = await fakeUpstream((req, raw, res) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'x' } }));
  });
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const rawKey = withProvider(store, 'http://127.0.0.1:' + upstream.address().port);
  const server = await startServer(store);
  const call = () => request(server, { method: 'POST', path: '/api/v1/process', headers: { Authorization: 'Bearer ' + rawKey }, body: { text: 'hi' } });
  const r400 = await call();
  assert.equal(r400.status, 502);
  assert.equal(r400.json.error.retryable, false);
  code = 500;
  const r500 = await call();
  assert.equal(r500.json.error.retryable, true);
  server.close();
  upstream.close();
  store.close();
});

test('/readyz：无可用供应商 503，配好后 200；/api/v1/health 带 version', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const server = await startServer(store);
  const notReady = await request(server, { path: '/readyz' });
  assert.equal(notReady.status, 503);
  assert.equal(notReady.json.checks.database, true);
  assert.equal(notReady.json.checks.defaultProvider, false);
  withProvider(store, 'http://127.0.0.1:9');
  const ready = await request(server, { path: '/readyz' });
  assert.equal(ready.status, 200);
  const health = await request(server, { path: '/api/v1/health' });
  assert.equal(health.json.version, require('../package.json').version);
  assert.equal(server.keepAliveTimeout, 65000);
  server.close();
  store.close();
});

test('GET /api/v1/openapi.json 返回与实际契约一致的文档', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const server = await startServer(store);
  const res = await request(server, { method: 'GET', path: '/api/v1/openapi.json' });
  assert.equal(res.status, 200);
  const doc = res.json;
  // 基本结构
  assert.equal(doc.openapi, '3.0.3');
  assert.ok(doc.info.title.includes('WenRong'));
  assert.ok(doc.paths['/api/v1/process']);
  assert.ok(doc.paths['/api/v1/process'].post.security);
  // 请求字段与 validateOptions 实际支持的一致
  const props = doc.components.schemas.ProcessRequest.properties;
  for (const f of ['text', 'prompt', 'instruction', 'targetLang', 'glossary', 'temperature', 'providerId']) {
    assert.ok(props[f], '缺少字段 ' + f);
  }
  assert.deepEqual(doc.components.schemas.ProcessRequest.required, ['text']);
  // 错误码枚举与 README 错误码表一致
  const codes = doc.paths['/api/v1/process'].post.responses[400].content['application/json'].schema.properties.error.properties.code.enum;
  for (const c of ['INVALID_REQUEST', 'MALFORMED_JSON', 'UNAUTHORIZED', 'PROVIDER_NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'TEXT_TOO_LONG', 'BODY_TOO_LARGE', 'RATE_LIMITED', 'UPSTREAM_RATE_LIMITED', 'LLM_UPSTREAM_ERROR', 'INTERNAL_ERROR']) {
    assert.ok(codes.includes(c), '错误码表缺少 ' + c);
  }
  // temperature 的取值范围与校验一致（0～1）
  assert.equal(props.temperature.minimum, 0);
  assert.equal(props.temperature.maximum, 1);
  server.close();
  store.close();
});

test('GET /api/v1/docs 返回 Scalar 文档页', async () => {
  const store = new Store({ file: ':memory:', encryptionKey: 'test' });
  const server = await startServer(store);
  try {
    const res = await request(server, { method: 'GET', path: '/api/v1/docs' });
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('data-url="/api/v1/openapi.json"'), '应引用同源 openapi.json');
    assert.ok(res.raw.includes('/vendor/scalar-standalone.js'), '应引用本地打包的 Scalar 脚本（不依赖公网 CDN）');
  } finally {
    server.close();
    store.close();
  }
});
