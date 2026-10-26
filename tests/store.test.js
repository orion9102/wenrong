'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.js');
const { hashApiKey } = require('../src/crypto.js');

function makeStore() {
  return new Store({ file: ':memory:', encryptionKey: 'test-key', now: () => Date.now() });
}

test('初始化时自动写入默认 Prompt 配置', () => {
  const store = makeStore();
  const config = store.getConfig();
  assert.ok(config.system_prompt.length > 0);
  assert.ok(config.default_user_prompt.length > 0);
  assert.equal(config.max_text_length, 20000);
  store.close();
});

test('更新 Prompt 配置会写入历史记录', () => {
  const store = makeStore();
  store.updateConfig({ systemPrompt: '新的系统提示词' }, 'admin:1');
  const history = store.listPromptHistory(10);
  assert.equal(history.length, 1);
  assert.equal(history[0].field, 'system_prompt');
  assert.equal(history[0].new_value, '新的系统提示词');
  store.close();
});

test('供应商创建后 API Key 加密存储，列表接口默认只返回掩码', () => {
  const store = makeStore();
  store.createProvider({
    id: 'p1',
    name: '测试供应商',
    baseUrl: 'http://example.com/',
    apiKey: 'super-secret-key-123',
    model: 'test-model',
    isDefault: true
  });
  const list = store.listProviders();
  assert.equal(list.length, 1);
  assert.ok(!list[0].apiKey, '默认不应包含明文 apiKey');
  assert.ok(list[0].apiKeyMasked.includes('***'));

  const withSecret = store.getProvider('p1', { includeSecret: true });
  assert.equal(withSecret.apiKey, 'super-secret-key-123');
  store.close();
});

test('setDefaultProvider 切换默认供应商时原默认会被清除', () => {
  const store = makeStore();
  store.createProvider({ id: 'a', name: 'A', baseUrl: 'http://a/', apiKey: 'k', model: 'm', isDefault: true });
  store.createProvider({ id: 'b', name: 'B', baseUrl: 'http://b/', apiKey: 'k', model: 'm' });
  store.setDefaultProvider('b');
  const a = store.getProvider('a');
  const b = store.getProvider('b');
  assert.equal(a.isDefault, false);
  assert.equal(b.isDefault, true);
  store.close();
});

test('API Key 的哈希校验：正确哈希命中，错误哈希拒绝', () => {
  const store = makeStore();
  const raw = 'wr_live_abcdef1234567890';
  const hash = hashApiKey(raw);
  store.createApiKey('测试调用方', raw, hash);

  const ok = store.verifyApiKeyHash(hash);
  assert.ok(ok);
  assert.equal(ok.label, '测试调用方');

  const bad = store.verifyApiKeyHash(hashApiKey('wrong-key'));
  assert.equal(bad, null);
  store.close();
});

test('吊销 API Key 后校验应失败', () => {
  const store = makeStore();
  const raw = 'wr_live_toberevoked';
  const hash = hashApiKey(raw);
  const created = store.createApiKey('待吊销', raw, hash);
  store.setApiKeyEnabled(created.id, false);
  const result = store.verifyApiKeyHash(hash);
  assert.equal(result, null);
  store.close();
});

test('调用日志写入与统计', () => {
  const store = makeStore();
  store.insertLog({
    id: 'req1',
    providerId: 'p1',
    usedPrompt: 'default_translate_polish',
    inputTextLen: 10,
    outputTextLen: 12,
    status: 'success',
    totalTokens: 50,
    latencyMs: 100,
    createdAt: Date.now()
  });
  store.insertLog({
    id: 'req2',
    providerId: 'p1',
    usedPrompt: 'custom',
    inputTextLen: 5,
    status: 'error',
    errorCode: 'LLM_UPSTREAM_ERROR',
    errorMessage: '上游错误',
    createdAt: Date.now()
  });
  const summary = store.metricsSummary(Date.now() - 60000);
  assert.equal(summary.total, 2);
  assert.equal(summary.success, 1);
  assert.equal(summary.error, 1);
  store.close();
});
