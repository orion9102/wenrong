'use strict';

/**
 * 文镕（WenRong）服务入口（node:http，零 npm 运行时依赖）
 *
 * 业务 API（需 Authorization: Bearer <API_KEY>）：
 *   POST /api/v1/process
 * 公开：
 *   GET  /healthz、GET /api/v1/health
 * 登录（统一账号中心 acc.909939.xyz，见 src/acc-auth.js）：
 *   GET  /api/auth/login、GET /api/auth/callback、POST /api/auth/logout、GET /api/auth/me
 * 管理台 API（需登录会话，见 src/admin-routes.js）：/api/admin/*
 *
 * 静态文件：/ 托管管理台前端（web/admin 目录）；旧的 /admin 路由已移除
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Store } = require('./store.js');
const { chatComplete, LlmUpstreamError } = require('./llm-client.js');
const { buildMessages } = require('./prompt-engine.js');
const { RateLimiter } = require('./rate-limiter.js');
const { hashApiKey, randomId } = require('./crypto.js');
const { handleAdminRoute, handleAuthRoute } = require('./admin-routes.js');
const { createAccAuth } = require('./acc-auth.js');
const { stripDuplicateGloss, estimateTokens, promptFingerprint } = require('./text-policy.js');

const WEB_DIR = path.join(__dirname, '..', 'web');
const DEFAULT_PORT = 4090;
const DEFAULT_MAX_TEXT_LENGTH = 20000;
const DEFAULT_MAX_TEXT_TOKENS = 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function requestIdOf(req) {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && /^[A-Za-z0-9._:-]{8,80}$/.test(incoming)) return incoming.slice(0, 80);
  return randomId('req');
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(
    status,
    Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store'
      },
      headers
    )
  );
  res.end(payload);
}

function sendApiError(res, status, code, message, requestId, headers = {}) {
  sendJson(res, status, { success: false, error: { code, message }, requestId: requestId || null }, headers);
}

function readJsonBody(req, { maxBytes = 2 * 1024 * 1024 } = {}) {
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

function serveStatic(req, res, pathname, staticDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendApiError(res, 405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
    return;
  }
  // 旧管理台路径 /admin 已移除
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    sendApiError(res, 404, 'NOT_FOUND', '页面不存在');
    return;
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = path.resolve(staticDir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    sendApiError(res, 403, 'FORBIDDEN', '非法路径');
    return;
  }
  fs.stat(full, (err, stat) => {
    let target = full;
    if (err || !stat || !stat.isFile()) {
      // SPA 回退到 index.html（便于前端路由）
      target = path.join(root, 'index.html');
    }
    fs.stat(target, (err2, stat2) => {
      if (err2 || !stat2.isFile()) {
        sendApiError(res, 404, 'NOT_FOUND', '页面不存在');
        return;
      }
      const ext = path.extname(target).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat2.size, 'Cache-Control': cache });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(target).pipe(res);
    });
  });
}

function getBearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

function createServer(options = {}) {
  const store = options.store;
  if (!store) throw new Error('createServer 需要注入 store');
  const logger = options.logger || console;
  const staticDir = options.staticDir || path.join(WEB_DIR, 'admin');
  const now = options.now || (() => Date.now());
  const rateLimiter = options.rateLimiter || new RateLimiter({ windowMs: 60000, maxRequests: 60 });
  const encryptionKey = options.encryptionKey || process.env.ENCRYPTION_KEY || 'wenrong-dev-key-change-me';
  const accAuth = options.accAuth || createAccAuth();

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (err) {
      sendApiError(res, 400, 'INVALID_REQUEST', 'URL 无法解析');
      return;
    }
    const pathname = url.pathname;

    try {
      if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/v1/health' && req.method === 'GET') {
        const provider = store.getDefaultProvider();
        sendJson(res, 200, {
          status: 'ok',
          uptime: process.uptime(),
          defaultProvider: provider ? { id: provider.id, name: provider.name, enabled: provider.enabled } : null
        });
        return;
      }

      if (pathname === '/api/v1/process' && req.method === 'POST') {
        await handleProcess(req, res);
        return;
      }

      if (pathname.startsWith('/api/auth/')) {
        await handleAuthRoute({ req, res, url, store, accAuth, sendJson, logger });
        return;
      }

      if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
        await handleAdminRoute({ req, res, url, store, logger, now, encryptionKey, sendJson });
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在：' + pathname);
        return;
      }

      serveStatic(req, res, pathname, staticDir);
    } catch (err) {
      logger.error('[wenrong] 未处理异常：', err);
      sendApiError(res, 500, 'INTERNAL_ERROR', err.message || '服务内部异常');
    }
  });

  async function handleProcess(req, res) {
    const requestId = requestIdOf(req);
    const startedAt = now();

    const apiKeyRaw = getBearerToken(req);
    if (!apiKeyRaw) {
      sendApiError(res, 401, 'UNAUTHORIZED', '缺少 Authorization: Bearer <API_KEY>', requestId);
      return;
    }
    const apiKeyRecord = store.verifyApiKeyHash(hashApiKey(apiKeyRaw));
    if (!apiKeyRecord) {
      sendApiError(res, 401, 'UNAUTHORIZED', 'API Key 无效或已被吊销', requestId);
      return;
    }

    const idemKeyRaw = req.headers['idempotency-key'];
    const idemKey = typeof idemKeyRaw === 'string' ? idemKeyRaw.trim().slice(0, 128) : '';
    if (idemKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(idemKey)) {
      sendApiError(res, 400, 'INVALID_REQUEST', 'Idempotency-Key 只能含字母数字、点、下划线、冒号和短横线，长度 8～128', requestId);
      return;
    }

    const rl = rateLimiter.check(apiKeyRecord.id);
    if (!rl.allowed) {
      const retryAfter = Math.max(1, Math.ceil((rl.resetMs || 1000) / 1000));
      sendApiError(res, 429, 'RATE_LIMITED', '请求过于频繁，请稍后重试', requestId, { 'Retry-After': String(retryAfter) });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendApiError(res, 400, 'INVALID_REQUEST', err.message, requestId);
      return;
    }

    const text = typeof body.text === 'string' ? body.text : null;
    if (!text || !text.trim()) {
      sendApiError(res, 400, 'INVALID_REQUEST', '缺少必填字段 text', requestId);
      return;
    }

    const config = store.getConfig();
    const maxLen = config.max_text_length || DEFAULT_MAX_TEXT_LENGTH;
    const maxTokens = config.max_text_tokens || DEFAULT_MAX_TEXT_TOKENS;
    if (text.length > maxLen) {
      sendApiError(res, 413, 'TEXT_TOO_LONG', `文本长度超出限制（上限 ${maxLen} 字符）`, requestId);
      return;
    }
    const textTokens = estimateTokens(text);
    if (textTokens > maxTokens) {
      sendApiError(res, 413, 'TEXT_TOO_LONG', `文本估算超过 ${maxTokens} token（约 ${textTokens}），请拆分后重试`, requestId);
      return;
    }

    const requestPrompt = typeof body.prompt === 'string' ? body.prompt : null;
    const fingerprint = promptFingerprint(config.system_prompt, (requestPrompt && requestPrompt.trim()) || config.default_user_prompt) +
      ':' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

    if (idemKey) {
      const cached = store.getIdempotent(idemKey, apiKeyRecord.id);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          sendApiError(res, 409, 'IDEMPOTENCY_CONFLICT', '同一个 Idempotency-Key 不能用于不同的请求内容', requestId);
          return;
        }
        sendJson(res, cached.status, Object.assign({}, cached.body, { requestId, idempotentReplay: true }));
        return;
      }
    }

    let provider;
    if (body.providerId) {
      provider = store.getProvider(body.providerId, { includeSecret: true });
      if (!provider || !provider.enabled) {
        sendApiError(res, 400, 'PROVIDER_NOT_FOUND', '指定的供应商不存在或未启用', requestId);
        return;
      }
    } else {
      provider = store.getDefaultProvider({ includeSecret: true });
      if (!provider || !provider.enabled) {
        sendApiError(res, 500, 'INTERNAL_ERROR', '未配置可用的默认 LLM 供应商', requestId);
        return;
      }
    }

    const { usedPrompt, messages } = buildMessages({
      systemPrompt: config.system_prompt,
      defaultUserPrompt: config.default_user_prompt,
      requestPrompt: typeof body.prompt === 'string' ? body.prompt : null,
      text
    });

    try {
      const result = await chatComplete(provider, messages);
      const content = stripDuplicateGloss(result.content.trim());
      const latencyMs = now() - startedAt;
      store.insertLog({
        id: requestId,
        apiKeyId: apiKeyRecord.id,
        providerId: provider.id,
        usedPrompt,
        inputTextLen: text.length,
        outputTextLen: content.length,
        status: 'success',
        promptTokens: result.usage.prompt_tokens || null,
        completionTokens: result.usage.completion_tokens || null,
        totalTokens: result.usage.total_tokens || null,
        latencyMs,
        createdAt: now()
      });
      const payload = {
        success: true,
        data: {
          result: content,
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
      };
      if (idemKey) store.saveIdempotent(idemKey, apiKeyRecord.id, fingerprint, 200, payload);
      sendJson(res, 200, payload);
    } catch (err) {
      const latencyMs = now() - startedAt;
      const isUpstream = err instanceof LlmUpstreamError;
      const status = isUpstream ? err.status || 502 : 500;
      const code = status === 429 ? 'UPSTREAM_RATE_LIMITED' : isUpstream ? 'LLM_UPSTREAM_ERROR' : 'INTERNAL_ERROR';
      store.insertLog({
        id: requestId,
        apiKeyId: apiKeyRecord.id,
        providerId: provider.id,
        usedPrompt,
        inputTextLen: text.length,
        status: 'error',
        errorCode: code,
        errorMessage: err.message,
        latencyMs,
        createdAt: now()
      });
      const headers = {};
      if (status === 429 || status === 503) headers['Retry-After'] = String(err.retryAfterSec || 30);
      sendApiError(res, status, code, err.message, requestId, headers);
    }
  }

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  // 定期清理限流器空桶
  const sweepInterval = setInterval(() => rateLimiter.sweep(), 5 * 60 * 1000);
  sweepInterval.unref();

  return server;
}

function main() {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const store = new Store();

  // 首次启动：若没有任何供应商配置，用环境变量尝试创建默认供应商（API Key 留空，待后台填入）
  if (store.listProviders().length === 0) {
    const baseUrl = process.env.DEFAULT_PROVIDER_BASE_URL || 'http://192.168.88.62:3001/';
    const model = process.env.DEFAULT_PROVIDER_MODEL || 'claude-sonnet-4-5';
    store.createProvider({
      id: 'default',
      name: '默认 LLM 供应商',
      baseUrl,
      apiKey: process.env.DEFAULT_PROVIDER_API_KEY || '',
      model,
      timeoutMs: 60000,
      isDefault: true,
      enabled: true
    });
    console.log('[wenrong] 已创建默认供应商配置（' + baseUrl + '），请在后台填入 API Key');
  }

  const server = createServer({ store });
  server.listen(port, '0.0.0.0', () => {
    console.log('[wenrong] 已启动 http://0.0.0.0:' + port);
    console.log('[wenrong] 业务 API: POST /api/v1/process');
    console.log('[wenrong] 管理台: http://0.0.0.0:' + port + '/（统一账号中心登录）');
  });

  const shutdown = (signal) => {
    console.log('[wenrong] 收到 ' + signal + '，正在关闭…');
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main();

module.exports = { createServer, sendJson, sendApiError, DEFAULT_PORT };
