'use strict';

/**
 * 语法自检：等价于逐个执行 node --check。
 * 用法：node scripts/syntax-check.js（npm run check）
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const targets = [];

for (const dir of ['src', 'scripts', 'tests']) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (name.endsWith('.js')) targets.push(path.join(dir, name));
  }
}
for (const name of ['app.js']) {
  const full = path.join(root, 'web', 'admin', name);
  if (fs.existsSync(full)) targets.push(path.join('web', 'admin', name));
}

let failed = 0;
for (const rel of targets) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'pipe' });
    console.log('ok   ' + rel);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + rel);
    if (err.stderr) console.error(err.stderr.toString());
  }
}

if (failed > 0) {
  console.error('\n语法检查失败：' + failed + ' 个文件');
  process.exit(1);
}
console.log('\n语法检查通过：' + targets.length + ' 个文件');
