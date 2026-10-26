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

/**
 * 粗略识别原文语言（按文字系统计数，不调模型、不加依赖）。
 * 只区分文字系统，拉丁字母一律记为 en；结果是启发式的，仅供调用方参考。
 */
function detectLang(text) {
  const s = String(text || '');
  const n = { han: 0, kana: 0, hangul: 0, cyrillic: 0, arabic: 0, thai: 0, latin: 0 };
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x3040 && c <= 0x30ff) n.kana += 1;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) n.han += 1;
    else if (c >= 0xac00 && c <= 0xd7af) n.hangul += 1;
    else if (c >= 0x0400 && c <= 0x04ff) n.cyrillic += 1;
    else if (c >= 0x0600 && c <= 0x06ff) n.arabic += 1;
    else if (c >= 0x0e00 && c <= 0x0e7f) n.thai += 1;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) n.latin += 1;
  }
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  if (!total) return null;
  // 日文里汉字很多，只要假名占比明显就判为日文
  if (n.kana / total > 0.1) return 'ja';
  // 中文正文常夹英文专名，汉字超过三成就算中文
  if (n.han / total > 0.3) return 'zh';
  const [top] = Object.entries(n).sort((a, b) => b[1] - a[1]);
  return { han: 'zh', kana: 'ja', hangul: 'ko', cyrillic: 'ru', arabic: 'ar', thai: 'th', latin: 'en' }[top[0]];
}

function promptFingerprint(systemPrompt, userPrompt) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(String(systemPrompt) + '\n' + String(userPrompt)).digest('hex').slice(0, 12);
}

module.exports = { stripDuplicateGloss, estimateTokens, promptFingerprint, detectLang };
