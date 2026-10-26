'use strict';

/**
 * 后台管理员账号密码校验与 session cookie 工具（node:crypto scrypt，零第三方依赖）
 */

const crypto = require('node:crypto');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const COOKIE_NAME = 'wenrong_admin_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + derived;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function sessionCookieHeader(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader({ secure = false } = {}) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  hashPassword,
  verifyPassword,
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  COOKIE_NAME,
  SESSION_TTL_MS
};
