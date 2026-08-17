'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

const paths = require('../main/paths');

test('dshHome 默认用户目录 .dsh', () => {
  delete process.env.DSH_HOME;
  assert.strictEqual(paths.dshHome(), path.join(os.homedir(), '.dsh'));
});

test('dshHome 优先环境变量', () => {
  process.env.DSH_HOME = 'Z:\\custom\\dsh';
  assert.strictEqual(paths.dshHome(), 'Z:\\custom\\dsh');
  delete process.env.DSH_HOME;
});

test('baselineDshEntry 指向 lib/bin.js', () => {
  const root = 'C:\\proj';
  const entry = paths.baselineDshEntry(root);
  assert.ok(entry.endsWith(path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), entry);
});

test('vendorDshEntry 指向用户目录 vendor 区', () => {
  process.env.DSH_HOME = 'Z:\\dsh';
  const entry = paths.vendorDshEntry();
  assert.ok(entry.startsWith('Z:\\dsh\\vendor\\dsh'), entry);
  delete process.env.DSH_HOME;
});

test('logsDir 位于 DSH_HOME 下', () => {
  process.env.DSH_HOME = 'Z:\\dsh';
  assert.strictEqual(paths.logsDir(), 'Z:\\dsh\\logs');
  delete process.env.DSH_HOME;
});
