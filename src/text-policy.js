'use strict';

/**
 * 输出后处理与长度估算（零依赖）。
 *
 * stripDuplicateGloss：去掉「专名（专名）」这种原文与括注完全相同的重复。
 * 模型对不认识的实体会不稳定地写出 Acme（Acme），提示词约束之外再兜一层。
 */

function normalizeName(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripDuplicateGloss(text) {
  if (typeof text !== 'string' || !text) return text;
  // 英文/数字专名 + 全角或半角括号里的同一串
  return text.replace(
    /([A-Za-z0-9][A-Za-z0-9 .&'’\-]{0,80}?)[（(]\s*([A-Za-z0-9][A-Za-z0-9 .&'’\-]{0,80}?)\s*[）)]/g,
    (whole, left, right) => (normalizeName(left) === normalizeName(right) ? left.trimEnd() : whole)
  );
}

/**
 * 粗估 token：CJK 约 1 字 1 token，其余约 4 字符 1 token。
 * 不用分词器，只用来挡「2 万汉字一次打满上游」这种请求。
 */
function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x2e80 && c <= 0x9fff) cjk += 1;
    else if (c >= 0xac00 && c <= 0xd7af) cjk += 1;
    else if (c >= 0xff00 && c <= 0xffef) cjk += 1;
  }
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

function promptFingerprint(systemPrompt, userPrompt) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(String(systemPrompt) + '\n' + String(userPrompt)).digest('hex').slice(0, 12);
}

module.exports = { stripDuplicateGloss, estimateTokens, promptFingerprint };
