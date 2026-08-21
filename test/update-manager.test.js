'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseVersion, isNewer, resolveDshEntry, extractTarball, installVendorDeps,
} = require('../main/update-manager');

test('parseVersion 解析 rc 版本', () => {
  const v = parseVersion('0.1.0-rc.6');
  assert.deepStrictEqual(v, { major: 0, minor: 1, patch: 0, prerelease: ['rc', 6] });
});

test('isNewer: patch 提升为更新', () => {
  assert.strictEqual(isNewer('0.1.1', '0.1.0-rc.6'), true);
});

test('isNewer: 同版本非更新', () => {
  assert.strictEqual(isNewer('0.1.0-rc.6', '0.1.0-rc.6'), false);
});

test('isNewer: rc 到正式版为更新', () => {
  assert.strictEqual(isNewer('0.1.0', '0.1.0-rc.6'), true);
});

test('isNewer: 远程更旧非更新', () => {
  assert.strictEqual(isNewer('0.0.9', '0.1.0-rc.6'), false);
});

test('resolveDshEntry: vendor 优先', () => {
  assert.strictEqual(
    resolveDshEntry({ vendorEntry: 'Z:\\v\\bin.js', baselineEntry: 'C:\\b\\bin.js' }),
    'Z:\\v\\bin.js'
  );
});

test('resolveDshEntry: 无 vendor 用基线', () => {
  assert.strictEqual(
    resolveDshEntry({ vendorEntry: null, baselineEntry: 'C:\\b\\bin.js' }),
    'C:\\b\\bin.js'
  );
});

test('extractTarball 解出 package/ 下文件', async () => {
  const tgz = path.join(os.tmpdir(), `dsh-test-${Date.now()}.tgz`);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-extract-'));
  try {
    // 构造一个含 package/lib/bin.js 的 tar.gz
    const zlib = require('node:zlib');
    const { execFileSync } = require('node:child_process');
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tar-stage-'));
    fs.mkdirSync(path.join(staging, 'package', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'package', 'lib', 'bin.js'), '// hello');
    fs.writeFileSync(path.join(staging, 'package', 'package.json'), '{"name":"x"}');
    execFileSync('tar', ['-czf', tgz, '-C', staging, 'package']);
    await extractTarball(tgz, target);
    assert.strictEqual(fs.readFileSync(path.join(target, 'lib', 'bin.js'), 'utf8'), '// hello');
    assert.strictEqual(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), '{"name":"x"}');
  } finally {
    fs.rmSync(tgz, { force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('installVendorDeps 调用 npm-cli 安装', async () => {
  const vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vendor-'));
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) return; // 系统 node 无捆绑 npm 时跳过
  await installVendorDeps(vendor, npmCli, process.execPath);
  assert.ok(fs.existsSync(path.join(vendor, 'node_modules')));
});
