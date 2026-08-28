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

// ---- dsh 原生 v1 布局：与官方 CLI / Web Models 页写出的文件互认 ----

test('readApiKey 解析 dsh 原生 flow 风格 (单行 refs)', async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.credentials.yaml'),
    '{ version: 1, refs: { DEEPSEEK_API_KEY: sk-test-00000000000000000000000000 } }\n'
  );
  assert.strictEqual(await readApiKey(home), 'sk-test-00000000000000000000000000');
});

test('readApiKey 解析 dsh 原生 block 风格 (refs 节)', async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.credentials.yaml'),
    'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-abc\n  ANTHROPIC_AUTH_TOKEN: token-xyz\n'
  );
  assert.strictEqual(await readApiKey(home), 'sk-abc');
});

test('readApiKey 优先环境变量（与 dsh 优先级一致）', async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-file\n');
  process.env.DEEPSEEK_API_KEY = 'sk-env';
  try {
    assert.strictEqual(await readApiKey(home), 'sk-env');
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test('writeApiKey 写出 dsh 原生 v1 布局', async () => {
  const home = tmpHome();
  await writeApiKey(home, 'sk-abc123');
  const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  assert.match(text, /version:\s*1/);
  assert.match(text, /DEEPSEEK_API_KEY\s*:\s*sk-abc123/);
});

test('writeApiKey 保留文档中其他凭据引用', async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.credentials.yaml'),
    'version: 1\nrefs:\n  ANTHROPIC_AUTH_TOKEN: token-xyz\n'
  );
  await writeApiKey(home, 'sk-new');
  const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  assert.match(text, /ANTHROPIC_AUTH_TOKEN\s*:\s*token-xyz/);
  assert.match(text, /DEEPSEEK_API_KEY\s*:\s*sk-new/);
});

test('writeApiKey 在 flow 风格文档中更新而不破坏其他条目', async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.credentials.yaml'),
    '{ version: 1, refs: { ANTHROPIC_AUTH_TOKEN: token-xyz, DEEPSEEK_API_KEY: sk-old } }\n'
  );
  await writeApiKey(home, 'sk-new');
  const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  assert.match(text, /ANTHROPIC_AUTH_TOKEN\s*:\s*token-xyz/);
  assert.match(text, /DEEPSEEK_API_KEY\s*:\s*sk-new/);
  // 重建为规范布局后仍可回读
  assert.strictEqual(await readApiKey(home), 'sk-new');
});

test('writeApiKey 以空存储 {} 为起点写入', async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.yaml'), '{}\n');
  await writeApiKey(home, 'sk-empty');
  assert.strictEqual(await readApiKey(home), 'sk-empty');
});

test('writeApiKey 无法识别的内容拒绝改动（fail-loud，不破坏文件）', async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  const weird = 'wholly `unexpected: [content\n';
  fs.writeFileSync(path.join(home, '.credentials.yaml'), weird);
  await assert.rejects(() => writeApiKey(home, 'sk-fix'));
  // 原文件未被破坏
  assert.strictEqual(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8'), weird);
});

test('ensureDshInstalled 在 dsh 完整安装时跳过', async () => {
  const { ensureDshInstalled } = require('../main/bootstrap');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ensure-'));
  const vendorDir = path.join(tmp, 'vendor', 'dsh');
  fs.mkdirSync(path.join(vendorDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'lib', 'bin.js'), '');
  // 核心依赖齐备 → 视为完整安装
  for (const dep of ['dsh-app-boot', 'dsh-base', 'dsh-web-app']) {
    const d = path.join(vendorDir, 'node_modules', '@deepseek-ai', dep);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${dep}` }));
  }
  await ensureDshInstalled(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ensureDshInstalled 不完整 vendor 不再创建 junction，且无 npm-cli 时优雅失败', async () => {
  const { ensureDshInstalled } = require('../main/bootstrap');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-link-'));
  const vendorDir = path.join(tmp, 'vendor', 'dsh');
  fs.mkdirSync(path.join(vendorDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'lib', 'bin.js'), '');
  // 不提供 npm-cli → 不应下载、不应创建 node_modules junction
  await ensureDshInstalled(tmp, { npmCliPath: null, execPath: process.execPath });
  assert.ok(!fs.existsSync(path.join(vendorDir, 'node_modules')), '不应为不完整 vendor 创建 node_modules');
  fs.rmSync(tmp, { recursive: true, force: true });
});
