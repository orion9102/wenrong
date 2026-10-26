'use strict';

/**
 * 管理台会话 cookie 工具（登录由统一账号中心完成，见 src/acc-auth.js）
 */

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const COOKIE_NAME = 'wenrong_session';
const STATE_COOKIE = 'wenrong_oauth_state';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch (err) {
      out[k] = v;
    }
  }
  return out;
}

// SameSite=Lax：OAuth 回调是从 acc 跨站跳回的顶层导航，Strict 会导致首跳不带 cookie
function cookieHeader(name, value, { secure = false, maxAgeMs } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function sessionCookieHeader(token, opts = {}) {
  return cookieHeader(COOKIE_NAME, token, Object.assign({ maxAgeMs: SESSION_TTL_MS }, opts));
}

function clearCookieHeader(opts = {}) {
  return cookieHeader(COOKIE_NAME, '', Object.assign({}, opts, { maxAgeMs: 0 }));
}

function stateCookieHeader(state, opts = {}) {
  return cookieHeader(STATE_COOKIE, state, Object.assign({ maxAgeMs: 10 * 60 * 1000 }, opts));
}

function clearStateCookieHeader(opts = {}) {
  return cookieHeader(STATE_COOKIE, '', Object.assign({}, opts, { maxAgeMs: 0 }));
}

module.exports = {
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  stateCookieHeader,
  clearStateCookieHeader,
  COOKIE_NAME,
  STATE_COOKIE,
  SESSION_TTL_MS
};
