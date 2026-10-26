'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripDuplicateGloss, estimateTokens } = require('../src/text-policy.js');

test('去掉原文与括注完全相同的专名，保留真正的中文括注', () => {
  const input = 'Acme Robotics（Acme Robotics）获 Northstar Ventures (Northstar Ventures) 投资，OpenAI（开放人工智能研究中心）未改。';
  const out = stripDuplicateGloss(input);
  assert.equal(out.includes('Acme Robotics（'), false);
  assert.equal(out.includes('Northstar Ventures ('), false);
  assert.match(out, /OpenAI（开放人工智能研究中心）/);
});

test('estimateTokens 中文按字计、英文按四字符计', () => {
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens(''), 0);
});
