'use strict';

/**
 * 管理后台 API（挂载在 /api/admin/*）
 *
 * 鉴权：除 /api/admin/login、/api/admin/bootstrap-status 外，其余接口都需要有效的
 * session cookie（wenrong_admin_session）。
 */

const {
  hashPassword,
  verifyPassword,
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  COOKIE_NAME,
  SESSION_TTL_MS
} = require('./admin-auth.js');
const { testConnection } = require('./llm-client.js');
const { generateApiKey, hashApiKey, maskSecret } = require('./crypto.js');

function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('请求体过大'), { code: 'bad_request' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'bad_request' }));
      }
    });
    req.on('error', reject);
  });
}

function sendErr(sendJson, res, status, error, message) {
  sendJson(res, status, { success: false, error, message });
}

function requireAuth(req, store) {
  const cookies = parseCookies(req.headers['cookie']);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const session = store.getSession(token);
  if (!session) return null;
  return session;
}

async function handleAdminRoute({ req, res, url, store, logger, now, encryptionKey, sendJson }) {
  const pathname = url.pathname;
  const method = req.method;

  // ---------- 无需登录 ----------

  if (pathname === '/api/admin/bootstrap-status' && method === 'GET') {
    sendJson(res, 200, { needsSetup: store.countAdmins() === 0 });
    return;
  }

  if (pathname === '/api/admin/bootstrap' && method === 'POST') {
    if (store.countAdmins() > 0) {
      sendErr(sendJson, res, 400, 'ALREADY_SETUP', '已存在管理员账号，请直接登录');
      return;
    }
    const body = await readJsonBody(req);
    const username = (body.username || '').trim();
    const password = body.password || '';
    if (!username || password.length < 8) {
      sendErr(sendJson, res, 400, 'INVALID_REQUEST', '用户名不能为空，密码至少 8 位');
      return;
    }
    store.createAdmin(username, hashPassword(password));
    sendJson(res, 200, { success: true });
    return;
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    const body = await readJsonBody(req);
    const username = (body.username || '').trim();
    const password = body.password || '';
    const admin = store.getAdminByUsername(username);
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      sendErr(sendJson, res, 401, 'INVALID_CREDENTIALS', '用户名或密码错误');
      return;
    }
    const token = store.createSession(admin.id, SESSION_TTL_MS);
    res.setHeader('Set-Cookie', sessionCookieHeader(token));
    sendJson(res, 200, { success: true, username: admin.username });
    return;
  }

  // ---------- 需要登录 ----------

  const session = requireAuth(req, store);
  if (!session) {
    sendErr(sendJson, res, 401, 'UNAUTHORIZED', '请先登录管理后台');
    return;
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    const cookies = parseCookies(req.headers['cookie']);
    store.deleteSession(cookies[COOKIE_NAME]);
    res.setHeader('Set-Cookie', clearCookieHeader());
    sendJson(res, 200, { success: true });
    return;
  }

  if (pathname === '/api/admin/me' && method === 'GET') {
    sendJson(res, 200, { success: true, adminId: session.admin_id });
    return;
  }

  // ---- Prompts ----

  if (pathname === '/api/admin/prompts' && method === 'GET') {
    const c = store.getConfig();
    sendJson(res, 200, {
      success: true,
      data: {
        systemPrompt: c.system_prompt,
        defaultUserPrompt: c.default_user_prompt,
        maxTextLength: c.max_text_length,
        updatedAt: c.updated_at
      }
    });
    return;
  }

  if (pathname === '/api/admin/prompts' && method === 'PUT') {
    const body = await readJsonBody(req);
    const updated = store.updateConfig(
      {
        systemPrompt: body.systemPrompt,
        defaultUserPrompt: body.defaultUserPrompt,
        maxTextLength: body.maxTextLength
      },
      'admin:' + session.admin_id
    );
    sendJson(res, 200, {
      success: true,
      data: {
        systemPrompt: updated.system_prompt,
        defaultUserPrompt: updated.default_user_prompt,
        maxTextLength: updated.max_text_length,
        updatedAt: updated.updated_at
      }
    });
    return;
  }

  if (pathname === '/api/admin/prompts/history' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    sendJson(res, 200, { success: true, data: store.listPromptHistory(limit) });
    return;
  }

  // ---- Providers ----

  if (pathname === '/api/admin/providers' && method === 'GET') {
    sendJson(res, 200, { success: true, data: store.listProviders() });
    return;
  }

  if (pathname === '/api/admin/providers' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.name || !body.baseUrl || !body.model) {
      sendErr(sendJson, res, 400, 'INVALID_REQUEST', '缺少必填字段 name/baseUrl/model');
      return;
    }
    const created = store.createProvider({
      name: body.name,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey || '',
      model: body.model,
      timeoutMs: body.timeoutMs,
      maxRetries: body.maxRetries,
      isDefault: !!body.isDefault,
      enabled: body.enabled !== false
    });
    sendJson(res, 200, { success: true, data: created });
    return;
  }

  const providerMatch = /^\/api\/admin\/providers\/([^/]+)(?:\/(test|set-default))?$/.exec(pathname);
  if (providerMatch) {
    const providerId = decodeURIComponent(providerMatch[1]);
    const action = providerMatch[2];

    if (action === 'test' && method === 'POST') {
      const provider = store.getProvider(providerId, { includeSecret: true });
      if (!provider) {
        sendErr(sendJson, res, 404, 'NOT_FOUND', '供应商不存在');
        return;
      }
      const result = await testConnection(provider);
      sendJson(res, 200, { success: true, data: result });
      return;
    }

    if (action === 'set-default' && method === 'POST') {
      try {
        store.setDefaultProvider(providerId);
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendErr(sendJson, res, 404, 'NOT_FOUND', err.message);
      }
      return;
    }

    if (!action && method === 'PUT') {
      const body = await readJsonBody(req);
      const updated = store.updateProvider(providerId, body);
      if (!updated) {
        sendErr(sendJson, res, 404, 'NOT_FOUND', '供应商不存在');
        return;
      }
      sendJson(res, 200, { success: true, data: updated });
      return;
    }

    if (!action && method === 'DELETE') {
      store.deleteProvider(providerId);
      sendJson(res, 200, { success: true });
      return;
    }
  }

  // ---- API Keys ----

  if (pathname === '/api/admin/api-keys' && method === 'GET') {
    sendJson(res, 200, { success: true, data: store.listApiKeys() });
    return;
  }

  if (pathname === '/api/admin/api-keys' && method === 'POST') {
    const body = await readJsonBody(req);
    const label = (body.label || '').trim();
    if (!label) {
      sendErr(sendJson, res, 400, 'INVALID_REQUEST', '缺少必填字段 label');
      return;
    }
    const rawKey = generateApiKey();
    const created = store.createApiKey(label, rawKey, hashApiKey(rawKey));
    // 完整 key 仅在创建时返回一次
    sendJson(res, 200, { success: true, data: Object.assign({}, created, { apiKey: rawKey }) });
    return;
  }

  const apiKeyMatch = /^\/api\/admin\/api-keys\/([^/]+)$/.exec(pathname);
  if (apiKeyMatch) {
    const id = decodeURIComponent(apiKeyMatch[1]);
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      if (body.enabled !== undefined) store.setApiKeyEnabled(id, !!body.enabled);
      sendJson(res, 200, { success: true });
      return;
    }
    if (method === 'DELETE') {
      store.deleteApiKey(id);
      sendJson(res, 200, { success: true });
      return;
    }
  }

  // ---- Logs & Metrics ----

  if (pathname === '/api/admin/logs' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
    const status = url.searchParams.get('status') || undefined;
    const providerId = url.searchParams.get('providerId') || undefined;
    const since = url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined;
    const rows = store.queryLogs({ limit, offset, status, providerId, since });
    const total = store.countLogs({ status, providerId, since });
    sendJson(res, 200, { success: true, data: rows, pagination: { limit, offset, total } });
    return;
  }

  if (pathname === '/api/admin/metrics' && method === 'GET') {
    const rangeHours = Math.min(Number(url.searchParams.get('hours') || 24), 24 * 30);
    const since = now() - rangeHours * 60 * 60 * 1000;
    sendJson(res, 200, { success: true, data: store.metricsSummary(since) });
    return;
  }

  sendErr(sendJson, res, 404, 'NOT_FOUND', '管理接口不存在：' + pathname);
}

module.exports = { handleAdminRoute };
