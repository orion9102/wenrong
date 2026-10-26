'use strict';

/**
 * 管理台 API（挂载在 /api/admin/*）与登录路由（/api/auth/*）
 *
 * 登录：统一账号中心 acc.909939.xyz（OAuth 2.0 授权码 + PKCE，见 src/acc-auth.js），
 * 登录成功后签发本地会话 cookie（wenrong_session，7 天，HttpOnly）。
 * /api/admin/* 全部需要有效会话。
 */

const {
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  stateCookieHeader,
  clearStateCookieHeader,
  COOKIE_NAME,
  STATE_COOKIE,
  SESSION_TTL_MS
} = require('./admin-auth.js');
const { chatComplete, testConnection } = require('./llm-client.js');
const { buildMessages } = require('./prompt-engine.js');
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
  return store.getSession(cookies[COOKIE_NAME]);
}

function isSecureRequest(req) {
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function sendHtmlError(res, status, message) {
  const safe = String(message).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>登录失败 · 文镕</title></head>` +
    `<body style="font-family:system-ui;padding:48px;color:#1f2937"><h2>登录失败</h2><p>${safe}</p><p><a href="/">返回首页重新登录</a></p></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': clearStateCookieHeader() });
  res.end(html);
}

/** 登录相关路由：/api/auth/login、/api/auth/callback、/api/auth/logout、/api/auth/me */
async function handleAuthRoute({ req, res, url, store, accAuth, sendJson, logger }) {
  const pathname = url.pathname;
  const method = req.method;
  const secure = isSecureRequest(req);

  if (pathname === '/api/auth/login' && method === 'GET') {
    if (!accAuth.configured()) {
      sendHtmlError(res, 500, '服务未配置统一账号中心（ACC_CLIENT_ID / ACC_REDIRECT_URI）');
      return;
    }
    const { url: authorizeUrl, state } = accAuth.buildAuthorizeUrl();
    res.writeHead(302, { Location: authorizeUrl, 'Set-Cookie': stateCookieHeader(state, { secure }), 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if (pathname === '/api/auth/callback' && method === 'GET') {
    const err = url.searchParams.get('error');
    if (err) {
      sendHtmlError(res, 400, '账号中心返回：' + (url.searchParams.get('error_description') || err));
      return;
    }
    try {
      const cookies = parseCookies(req.headers['cookie']);
      const user = await accAuth.handleCallback({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        cookieState: cookies[STATE_COOKIE]
      });
      const token = store.createSession(user, SESSION_TTL_MS);
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': [sessionCookieHeader(token, { secure }), clearStateCookieHeader({ secure })],
        'Cache-Control': 'no-store'
      });
      res.end();
    } catch (e) {
      if (logger && logger.error) logger.error('[wenrong] acc 登录失败：', e.message);
      sendHtmlError(res, e.status || 502, e.message);
    }
    return;
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const cookies = parseCookies(req.headers['cookie']);
    store.deleteSession(cookies[COOKIE_NAME]);
    res.setHeader('Set-Cookie', clearCookieHeader({ secure }));
    sendJson(res, 200, { success: true });
    return;
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const session = requireAuth(req, store);
    if (!session) {
      sendJson(res, 401, { success: false, error: 'UNAUTHORIZED', message: '未登录', loginUrl: '/api/auth/login' });
      return;
    }
    sendJson(res, 200, { success: true, user: { sub: session.sub, email: session.email, name: session.name, role: session.role } });
    return;
  }

  sendErr(sendJson, res, 404, 'NOT_FOUND', '接口不存在：' + pathname);
}

async function handleAdminRoute({ req, res, url, store, logger, now, encryptionKey, sendJson }) {
  const pathname = url.pathname;
  const method = req.method;

  const session = requireAuth(req, store);
  if (!session) {
    sendErr(sendJson, res, 401, 'UNAUTHORIZED', '请先通过统一账号中心登录');
    return;
  }
  const operator = 'acc:' + (session.email || session.sub);

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
      operator
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
    const label = String(body.label || '').trim();
    if (!label || label.length > 64) {
      sendErr(sendJson, res, 400, 'INVALID_REQUEST', '名称不能为空，且不超过 64 个字符');
      return;
    }
    const rawKey = generateApiKey();
    const created = store.createApiKey(label, rawKey, hashApiKey(rawKey), operator);
    // 完整 key 仅在创建时返回一次
    sendJson(res, 200, { success: true, data: Object.assign({}, created, { apiKey: rawKey }) });
    return;
  }

  const apiKeyMatch = /^\/api\/admin\/api-keys\/([^/]+)$/.exec(pathname);
  if (apiKeyMatch) {
    const id = decodeURIComponent(apiKeyMatch[1]);
    if (method === 'PUT') {
      if (!store.getApiKey(id)) {
        sendErr(sendJson, res, 404, 'NOT_FOUND', 'API Key 不存在');
        return;
      }
      const body = await readJsonBody(req);
      if (body.enabled !== undefined) store.setApiKeyEnabled(id, !!body.enabled);
      if (body.label !== undefined) {
        const label = String(body.label || '').trim();
        if (!label || label.length > 64) {
          sendErr(sendJson, res, 400, 'INVALID_REQUEST', '名称不能为空，且不超过 64 个字符');
          return;
        }
        store.renameApiKey(id, label);
      }
      sendJson(res, 200, { success: true });
      return;
    }
    if (method === 'DELETE') {
      if (!store.getApiKey(id)) {
        sendErr(sendJson, res, 404, 'NOT_FOUND', 'API Key 不存在');
        return;
      }
      store.deleteApiKey(id);
      sendJson(res, 200, { success: true });
      return;
    }
  }

  // ---- Playground（管理员体验业务效果，走管理员会话而非业务 API Key）----

  if (pathname === '/api/admin/playground' && method === 'POST') {
    const body = await readJsonBody(req);
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      sendErr(sendJson, res, 400, 'INVALID_REQUEST', '缺少必填字段 text');
      return;
    }
    const config = store.getConfig();
    const maxLen = config.max_text_length || 20000;
    if (text.length > maxLen) {
      sendErr(sendJson, res, 413, 'TEXT_TOO_LONG', '文本长度超出限制（上限 ' + maxLen + ' 字符）');
      return;
    }
    let provider;
    if (body.providerId) {
      provider = store.getProvider(body.providerId, { includeSecret: true });
      if (!provider || !provider.enabled) {
        sendErr(sendJson, res, 400, 'PROVIDER_NOT_FOUND', '指定的供应商不存在或未启用');
        return;
      }
    } else {
      provider = store.getDefaultProvider({ includeSecret: true });
      if (!provider || !provider.enabled) {
        sendErr(sendJson, res, 500, 'INTERNAL_ERROR', '未配置可用的默认 LLM 供应商');
        return;
      }
    }
    const requestId = 'pg_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
    const startedAt = now();
    const { usedPrompt, messages } = buildMessages({
      systemPrompt: config.system_prompt,
      defaultUserPrompt: config.default_user_prompt,
      requestPrompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : null,
      text
    });
    try {
      const result = await chatComplete(provider, messages);
      const latencyMs = now() - startedAt;
      store.insertLog({
        id: requestId,
        apiKeyId: null,
        providerId: provider.id,
        usedPrompt,
        inputTextLen: text.length,
        outputTextLen: result.content.length,
        status: 'success',
        promptTokens: result.usage.prompt_tokens || null,
        completionTokens: result.usage.completion_tokens || null,
        totalTokens: result.usage.total_tokens || null,
        latencyMs,
        createdAt: now()
      });
      sendJson(res, 200, {
        success: true,
        data: {
          result: result.content.trim(),
          usedPrompt,
          model: result.model,
          usage: {
            promptTokens: result.usage.prompt_tokens || 0,
            completionTokens: result.usage.completion_tokens || 0,
            totalTokens: result.usage.total_tokens || 0
          },
          latencyMs
        },
        requestId
      });
    } catch (err) {
      const latencyMs = now() - startedAt;
      store.insertLog({
        id: requestId,
        apiKeyId: null,
        providerId: provider.id,
        usedPrompt,
        inputTextLen: text.length,
        status: 'error',
        errorCode: err.code || 'LLM_UPSTREAM_ERROR',
        errorMessage: err.message,
        latencyMs,
        createdAt: now()
      });
      const status = err.status || 502;
      sendErr(sendJson, res, status, 'LLM_UPSTREAM_ERROR', err.message);
    }
    return;
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

module.exports = { handleAdminRoute, handleAuthRoute };
