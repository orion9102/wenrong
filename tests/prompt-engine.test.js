'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessages } = require('../src/prompt-engine.js');

test('未传 prompt 时使用默认用户提示词', () => {
  const { usedPrompt, messages } = buildMessages({
    systemPrompt: 'SYS',
    defaultUserPrompt: 'DEFAULT_PROMPT',
    requestPrompt: null,
    text: 'hello world'
  });
  assert.equal(usedPrompt, 'default_translate_polish');
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'SYS');
  assert.ok(messages[1].content.startsWith('DEFAULT_PROMPT'));
  assert.ok(messages[1].content.includes('hello world'));
});

test('传了非空 prompt 时覆盖默认提示词', () => {
  const { usedPrompt, messages } = buildMessages({
    systemPrompt: 'SYS',
    defaultUserPrompt: 'DEFAULT_PROMPT',
    requestPrompt: '帮我写一个吸睛标题',
    text: 'some text'
  });
  assert.equal(usedPrompt, 'custom');
  assert.ok(messages[1].content.startsWith('帮我写一个吸睛标题'));
  assert.ok(!messages[1].content.includes('DEFAULT_PROMPT'));
});

test('空字符串 prompt 视为未传，走默认逻辑', () => {
  const { usedPrompt } = buildMessages({
    systemPrompt: 'SYS',
    defaultUserPrompt: 'DEFAULT_PROMPT',
    requestPrompt: '   ',
    text: 'x'
  });
  assert.equal(usedPrompt, 'default_translate_polish');
});

const { validateOptions } = require('../src/prompt-engine.js');
test('追加层叠加在自定义 prompt 之后，不替换它', () => {
  const { usedPrompt, messages } = buildMessages({
    systemPrompt: 'SYS', defaultUserPrompt: 'DEFAULT', requestPrompt: 'CUSTOM', text: 't',
    instruction: '更口语', targetLang: 'en', glossary: [['token', 'token']]
  });
  assert.equal(usedPrompt, 'custom');
  const u = messages[1].content;
  assert.ok(u.startsWith('CUSTOM'));
  assert.ok(!u.includes('DEFAULT'));
  assert.match(u, /English（en）/);
  assert.match(u, /更口语/);
});
test('targetLang=zh 不额外追加目标语言段', () => {
  const { messages } = buildMessages({ systemPrompt: 'S', defaultUserPrompt: 'D', text: 't', targetLang: 'zh' });
  assert.equal(messages[1].content, 'D\n\n---\nt');
});
test('validateOptions 空值视为未传', () => {
  const r = validateOptions({ instruction: '  ', targetLang: '', glossary: {} });
  assert.deepEqual(r.value, { instruction: null, targetLang: null, glossary: null, temperature: null });
});
