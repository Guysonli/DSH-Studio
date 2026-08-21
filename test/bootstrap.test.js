'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureProfile, readApiKey, writeApiKey, PROFILE_TEMPLATES } = require('../main/bootstrap');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-'));
}

test('PROFILE_TEMPLATES 包含 4 个文件', () => {
  assert.deepStrictEqual(Object.keys(PROFILE_TEMPLATES).sort(), [
    'cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml',
  ]);
});

test('ensureProfile 首次创建 4 个文件', async () => {
  const home = tmpHome();
  const created = await ensureProfile(home);
  assert.strictEqual(created, true);
  for (const name of Object.keys(PROFILE_TEMPLATES)) {
    const f = path.join(home, 'profiles', 'web', name);
    assert.ok(fs.existsSync(f), name);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), PROFILE_TEMPLATES[name]);
  }
});

test('ensureProfile 已存在时不重复创建', async () => {
  const home = tmpHome();
  await ensureProfile(home);
  const created = await ensureProfile(home);
  assert.strictEqual(created, false);
});

test('writeApiKey 与 readApiKey 往返', async () => {
  const home = tmpHome();
  await writeApiKey(home, 'sk-abc123');
  assert.strictEqual(await readApiKey(home), 'sk-abc123');
});

test('readApiKey 文件缺失返回 null', async () => {
  const home = tmpHome();
  assert.strictEqual(await readApiKey(home), null);
});

test('readApiKey 忽略键名前后空白', async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.yaml'), '  DEEPSEEK_API_KEY:  sk-xyz  \n');
  assert.strictEqual(await readApiKey(home), 'sk-xyz');
});

test('ensureDshInstalled 在 dsh 已安装时跳过', async () => {
  const { ensureDshInstalled } = require('../main/bootstrap');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ensure-'));
  const vendorDir = path.join(tmp, 'vendor', 'dsh');
  fs.mkdirSync(path.join(vendorDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'lib', 'bin.js'), '');
  await ensureDshInstalled(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});
