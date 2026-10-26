'use strict';

/**
 * 轻量加密/哈希工具（node:crypto，零第三方依赖）
 *
 * - encrypt/decrypt：AES-256-GCM，用于加密存储供应商 API Key。
 * - hashApiKey：sha256+salt，用于业务调用方 API Key 的存储比对（不存明文）。
 */

const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';

/** 从任意长度的字符串派生 32 字节密钥（sha256） */
function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * 加密字符串，返回 base64("iv:authTag:ciphertext") 形式的单行文本，便于入库。
 */
function encrypt(plainText, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(encoded, secret) {
  const key = deriveKey(secret);
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

/** 掩码展示：保留前缀，其余打星号。用于列表页展示，不暴露完整密钥。 */
function maskSecret(value, keepPrefix = 6) {
  const s = String(value || '');
  if (s.length <= keepPrefix) return '***';
  return s.slice(0, keepPrefix) + '***' + '(' + s.length + ' chars)';
}

/** 生成一个业务调用方 API Key，形如 wr_live_<32位hex> */
function generateApiKey() {
  return 'wr_live_' + crypto.randomBytes(16).toString('hex');
}

/** sha256 哈希（加固定盐），用于入库比对，不可逆 */
function hashApiKey(key, salt) {
  return crypto
    .createHash('sha256')
    .update(String(salt || 'wenrong-static-salt') + ':' + String(key))
    .digest('hex');
}

function randomId(prefix) {
  const id = crypto.randomBytes(8).toString('hex');
  return prefix ? prefix + '_' + id : id;
}

module.exports = { encrypt, decrypt, maskSecret, generateApiKey, hashApiKey, randomId };
