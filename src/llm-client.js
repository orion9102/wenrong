'use strict';

/**
 * LLM 供应商适配层（node:https/http，零第三方依赖）
 *
 * 目标服务是 OpenAI 兼容的 Chat Completions 接口：
 *   POST {baseUrl}/v1/chat/completions
 *   Authorization: Bearer <apiKey>
 */

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

class LlmUpstreamError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.name = 'LlmUpstreamError';
    this.code = 'LLM_UPSTREAM_ERROR';
    this.status = status || 502;
    this.detail = detail;
  }
}

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return base + suffix;
}

function postJson(urlString, body, { headers = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(urlString);
    } catch (err) {
      reject(new LlmUpstreamError('供应商地址非法: ' + urlString));
      return;
    }
    const payload = JSON.stringify(body);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + (target.search || ''),
        method: 'POST',
        headers: Object.assign(
          {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          headers
        ),
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (err) {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', (err) => {
      reject(new LlmUpstreamError('网络请求失败: ' + err.message, { detail: { cause: err.message } }));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * 调用 LLM 做一次 chat completion。
 * @param {object} provider - { baseUrl, apiKey, model, timeoutMs, maxRetries }
 * @param {Array<{role,content}>} messages
 * @returns {Promise<{content: string, usage: object, raw: object}>}
 */
async function chatComplete(provider, messages) {
  const url = joinUrl(provider.baseUrl, '/v1/chat/completions');
  const maxRetries = Number.isFinite(provider.maxRetries) ? provider.maxRetries : 1;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { status, body, raw } = await postJson(
        url,
        {
          model: provider.model,
          messages,
          temperature: 0.3
        },
        {
          headers: { Authorization: 'Bearer ' + provider.apiKey },
          timeoutMs: provider.timeoutMs || 30000
        }
      );

      if (status >= 200 && status < 300 && body && body.choices && body.choices[0]) {
        const content = body.choices[0].message && body.choices[0].message.content;
        return {
          content: typeof content === 'string' ? content : String(content || ''),
          usage: body.usage || {},
          model: body.model || provider.model
        };
      }

      const message =
        (body && body.error && body.error.message) ||
        (body && body.message) ||
        raw ||
        '上游返回了非预期的响应';
      lastErr = new LlmUpstreamError('上游 LLM 服务返回错误：' + message, {
        status: status === 401 || status === 403 ? 401 : 502,
        detail: { httpStatus: status, body }
      });
      // 鉴权错误不重试
      if (status === 401 || status === 403) break;
    } catch (err) {
      lastErr = err instanceof LlmUpstreamError ? err : new LlmUpstreamError(err.message);
    }
  }
  throw lastErr || new LlmUpstreamError('未知的上游错误');
}

/** 连通性测试：发一个极小的请求，用于后台「测试连接」按钮 */
async function testConnection(provider) {
  const start = Date.now();
  try {
    const result = await chatComplete(
      Object.assign({}, provider, { maxRetries: 0, timeoutMs: Math.min(provider.timeoutMs || 15000, 15000) }),
      [{ role: 'user', content: 'ping' }]
    );
    return { ok: true, latencyMs: Date.now() - start, model: result.model, sample: result.content.slice(0, 200) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err.message,
      status: err.status || 502
    };
  }
}

module.exports = { chatComplete, testConnection, LlmUpstreamError };
