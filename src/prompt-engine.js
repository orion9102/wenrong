'use strict';

/**
 * Prompt 合并逻辑（docs/PRODUCT_DESIGN.md 第 5.2 节）
 *
 * - System Prompt 始终生效，调用方不能覆盖。
 * - 调用方传了非空 prompt：整体替换 Default User Prompt（原契约不变）。
 * - 否则：用后台配置的 Default User Prompt。
 * - 追加层（都可选，叠加在上面选出的提示词之后，不替换它）：
 *     instruction  本次附加要求，例如「语气更口语」
 *     targetLang   目标语言代码，默认中文
 *     glossary     术语表 { 原文: 译法 }
 */

const TARGET_LANGS = {
  zh: '简体中文',
  'zh-Hant': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  it: 'Italiano',
  ru: 'Русский',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  ar: 'العربية'
};

const MAX_INSTRUCTION_LEN = 1000;
const MAX_GLOSSARY_ENTRIES = 100;
const MAX_GLOSSARY_TERM_LEN = 100;

/**
 * 校验调用方的可选字段，返回 { ok, value } 或 { ok:false, field, message }。
 */
function validateOptions(body) {
  const out = { instruction: null, targetLang: null, glossary: null, temperature: null };

  if (body.instruction !== undefined && body.instruction !== null) {
    if (typeof body.instruction !== 'string') return { ok: false, field: 'instruction', message: 'instruction 必须是字符串' };
    const s = body.instruction.trim();
    if (s.length > MAX_INSTRUCTION_LEN) {
      return { ok: false, field: 'instruction', message: `instruction 不能超过 ${MAX_INSTRUCTION_LEN} 字符` };
    }
    out.instruction = s || null;
  }

  if (body.targetLang !== undefined && body.targetLang !== null && body.targetLang !== '') {
    if (typeof body.targetLang !== 'string' || !Object.prototype.hasOwnProperty.call(TARGET_LANGS, body.targetLang)) {
      return {
        ok: false,
        field: 'targetLang',
        message: 'targetLang 不支持，可选：' + Object.keys(TARGET_LANGS).join(', ')
      };
    }
    out.targetLang = body.targetLang;
  }

  if (body.glossary !== undefined && body.glossary !== null) {
    const g = body.glossary;
    if (typeof g !== 'object' || Array.isArray(g)) {
      return { ok: false, field: 'glossary', message: 'glossary 必须是对象，形如 {"原文":"译法"}' };
    }
    const entries = Object.entries(g);
    if (entries.length > MAX_GLOSSARY_ENTRIES) {
      return { ok: false, field: 'glossary', message: `glossary 最多 ${MAX_GLOSSARY_ENTRIES} 条` };
    }
    for (const [k, v] of entries) {
      if (typeof v !== 'string' || !k.trim() || !v.trim() || k.length > MAX_GLOSSARY_TERM_LEN || v.length > MAX_GLOSSARY_TERM_LEN) {
        return { ok: false, field: 'glossary', message: `glossary 的键和值都必须是 1～${MAX_GLOSSARY_TERM_LEN} 字符的非空字符串` };
      }
    }
    out.glossary = entries.length ? entries.map(([k, v]) => [k.trim(), v.trim()]) : null;
  }

  if (body.temperature !== undefined && body.temperature !== null) {
    const t = body.temperature;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) {
      return { ok: false, field: 'temperature', message: 'temperature 必须是 0～1 之间的数字' };
    }
    out.temperature = t;
  }

  return { ok: true, value: out };
}

function buildAddendum({ instruction, targetLang, glossary }) {
  const parts = [];
  if (targetLang && targetLang !== 'zh') {
    const name = TARGET_LANGS[targetLang];
    parts.push(
      `# 目标语言\n本次目标语言是 ${name}（${targetLang}）。上文规则中的「中文」一律理解为 ${name}：原文不是 ${name} 时译成 ${name}，已经是 ${name} 时只润色。\n额外要求：\n- 不要为普通名词、描述性词语加原文括注；只有确有必要的专名首次出现时才可括注一次。\n- 人称与立场词必须与原文一致：原文提到第三方公司/机构时，禁用第一人称表述（如日语「当社」「弊社」），应使用「同社」「この会社」「同企業」等第三方称呼。`
    );
  }
  if (glossary && glossary.length) {
    parts.push('# 术语表（必须遵守）\n' + glossary.map(([k, v]) => `- ${k} → ${v}`).join('\n'));
  }
  if (instruction) {
    parts.push('# 本次附加要求\n' + instruction);
  }
  return parts.join('\n\n');
}

function buildMessages({ systemPrompt, defaultUserPrompt, requestPrompt, text, instruction, targetLang, glossary }) {
  const hasCustomPrompt = typeof requestPrompt === 'string' && requestPrompt.trim().length > 0;
  const basePrompt = hasCustomPrompt ? requestPrompt.trim() : defaultUserPrompt;
  const usedPrompt = hasCustomPrompt ? 'custom' : 'default_translate_polish';

  const addendum = buildAddendum({ instruction, targetLang, glossary });
  const effectiveUserPrompt = addendum ? basePrompt + '\n\n' + addendum : basePrompt;

  const userContent = effectiveUserPrompt + '\n\n---\n' + text;

  return {
    usedPrompt,
    effectiveUserPrompt,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ]
  };
}

module.exports = { buildMessages, validateOptions, TARGET_LANGS };
