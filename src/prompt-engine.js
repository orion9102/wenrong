'use strict';

/**
 * Prompt 合并逻辑（docs/PRODUCT_DESIGN.md 第 5.2 节）
 *
 * - System Prompt 始终生效，调用方不能覆盖。
 * - 调用方传了非空 prompt：用调用方的 prompt。
 * - 否则：用后台配置的 Default User Prompt。
 */

function buildMessages({ systemPrompt, defaultUserPrompt, requestPrompt, text }) {
  const hasCustomPrompt = typeof requestPrompt === 'string' && requestPrompt.trim().length > 0;
  const effectiveUserPrompt = hasCustomPrompt ? requestPrompt.trim() : defaultUserPrompt;
  const usedPrompt = hasCustomPrompt ? 'custom' : 'default_translate_polish';

  const userContent = effectiveUserPrompt + '\n\n---\n' + text;

  return {
    usedPrompt,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ]
  };
}

module.exports = { buildMessages };
