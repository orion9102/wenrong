'use strict';

/**
 * 统一账号中心（acc.909939.xyz）接入：OAuth 2.0 授权码 + PKCE（公共客户端，无 secret）
 *
 * 流程：
 *   GET /api/auth/login    → 生成 state + code_verifier，302 到 acc 授权页
 *   GET /api/auth/callback → 校验 state，携 code_verifier 换令牌，
 *                            用 acc JWKS 验签 id_token（RS256、iss、aud、exp），
 *                            校验角色后由调用方签发本地会话 cookie
 *
 * 零第三方依赖：node:crypto 直接导入 JWK 公钥验签。
 */

const crypto = require('node:crypto');

const DEFAULT_ACC_BASE = 'https://acc.909939.xyz';
const PENDING_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;

class AccAuthError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'AccAuthError';
    this.status = status;
  }
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function createAccAuth(options = {}) {
  const accBase = String(options.accBase || process.env.ACC_BASE || DEFAULT_ACC_BASE).replace(/\/+$/, '');
  const clientId = options.clientId || process.env.ACC_CLIENT_ID || '';
  const redirectUri = options.redirectUri || process.env.ACC_REDIRECT_URI || '';
  // 放行角色：默认仅 admin；设为空字符串或 * 表示任意已登录账号
  const roleEnv = options.requiredRole !== undefined ? options.requiredRole : process.env.ACC_REQUIRED_ROLE;
  const requiredRole = roleEnv === undefined ? 'admin' : String(roleEnv).trim();
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || (() => Date.now());

  const pending = new Map(); // state -> { verifier, exp }
  let jwksCache = null; // { keys, at }

  function configured() {
    return !!(clientId && redirectUri);
  }

  function sweep() {
    const t = now();
    for (const [k, v] of pending) if (v.exp <= t) pending.delete(k);
  }

  /** 生成授权跳转地址（state/verifier 存内存，10 分钟有效、一次性）。返回 { url, state } */
  function buildAuthorizeUrl() {
    if (!configured()) throw new AccAuthError('未配置 ACC_CLIENT_ID / ACC_REDIRECT_URI', 500);
    sweep();
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    pending.set(state, { verifier, nonce, exp: now() + PENDING_TTL_MS });
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    });
    return { url: accBase + '/v1/oauth/authorize?' + q.toString(), state };
  }

  async function timedFetch(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      return await fetchImpl(url, Object.assign({}, init, { signal: ctrl.signal }));
    } catch (err) {
      throw new AccAuthError('账号中心不可达：' + err.message, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJwks(force = false) {
    if (!force && jwksCache && now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
    const r = await timedFetch(accBase + '/.well-known/jwks.json');
    const body = r.ok ? await r.json().catch(() => null) : null;
    if (!body || !Array.isArray(body.keys)) throw new AccAuthError('获取账号中心公钥失败', 502);
    jwksCache = { keys: body.keys, at: now() };
    return body.keys;
  }

  /** 验证 RS256 JWT：签名（JWKS）、exp，返回 payload */
  async function verifyJwt(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new AccAuthError('令牌格式错误', 401);
    let header;
    let payload;
    try {
      header = b64urlJson(parts[0]);
      payload = b64urlJson(parts[1]);
    } catch (err) {
      throw new AccAuthError('令牌无法解析', 401);
    }
    if (header.alg !== 'RS256') throw new AccAuthError('不支持的令牌算法', 401);

    let keys = await getJwks();
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      // 可能是密钥轮换，强制刷新一次
      keys = await getJwks(true);
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) throw new AccAuthError('找不到令牌对应的公钥', 401);

    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1]),
      publicKey,
      Buffer.from(parts[2], 'base64url')
    );
    if (!ok) throw new AccAuthError('令牌签名无效', 401);
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= now()) throw new AccAuthError('令牌已过期', 401);
    return payload;
  }

  /** 回调处理：state → verifier → 换令牌 → 验签 id_token → 角色门。返回用户身份 */
  async function handleCallback({ code, state, cookieState }) {
    if (!code || !state) throw new AccAuthError('回调参数缺失', 400);
    // state 必须与发起登录的同一浏览器 cookie 一致，防登录 CSRF
    if (!cookieState || cookieState !== state) throw new AccAuthError('登录状态校验失败，请重新登录', 400);
    const pend = pending.get(state);
    pending.delete(state);
    if (!pend || pend.exp <= now()) throw new AccAuthError('登录请求无效或已过期，请重新登录', 400);

    const r = await timedFetch(accBase + '/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: pend.verifier
      })
    });
    const tok = await r.json().catch(() => null);
    if (!r.ok || !tok || !tok.id_token) {
      const msg = (tok && (tok.message || (tok.error && (tok.error.message || tok.error)))) || 'HTTP ' + r.status;
      throw new AccAuthError('令牌换取失败：' + msg, 502);
    }

    const claims = await verifyJwt(tok.id_token);
    if (claims.iss !== accBase) throw new AccAuthError('令牌签发方不匹配', 401);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) throw new AccAuthError('令牌受众不匹配', 401);
    if (claims.nonce && claims.nonce !== pend.nonce) throw new AccAuthError('nonce 校验失败', 401);

    const role = String(claims.role || '');
    if (requiredRole && requiredRole !== '*' && role !== requiredRole) {
      throw new AccAuthError(`仅 ${requiredRole} 角色可登录文镕管理台（当前账号角色：${role || '未知'}）`, 403);
    }

    return {
      sub: String(claims.sub),
      email: claims.email || null,
      name: claims.name || claims.email || String(claims.sub),
      picture: claims.picture || null,
      role
    };
  }

  return { configured, buildAuthorizeUrl, handleCallback, verifyJwt, accBase, clientId, redirectUri, requiredRole };
}

module.exports = { createAccAuth, AccAuthError };
