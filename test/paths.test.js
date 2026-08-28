'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

// ---- 构造一个迷你 dsh 安装树（lib/bin.js + 包内依赖 @deepseek-ai/{dsh-app-boot,dsh-base,dsh-web-app}）----
// pkgDir 即 @deepseek-ai/dsh 包根目录（如 .../node_modules/@deepseek-ai/dsh）
const CORE_DEPS = ['dsh-app-boot', 'dsh-base', 'dsh-web-app'];

function makePkgTree(pkgDir) {
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), '');
  for (const dep of CORE_DEPS) {
    const d = path.join(pkgDir, 'node_modules', '@deepseek-ai', dep);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${dep}`, version: '0.1.0-rc.6' }));
  }
  return path.join(pkgDir, 'lib', 'bin.js');
}

test('isDshEntryUsable: 依赖完整的 dsh 安装可用', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usable-'));
  try {
    const entry = makePkgTree(path.join(tmp, 'install', '@deepseek-ai', 'dsh'));
    assert.strictEqual(paths.isDshEntryUsable(entry), true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('isDshEntryUsable: 缺依赖的 dsh 安装不可用', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unusable-'));
  try {
    const pkg = path.join(tmp, 'install', '@deepseek-ai', 'dsh');
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
    const entry = path.join(pkg, 'lib', 'bin.js');
    fs.writeFileSync(entry, '');
    assert.strictEqual(paths.isDshEntryUsable(entry), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('globalDshEntry: 识别 Volta 全局安装', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-volta-'));
  try {
    // Volta 布局：packages/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh（完整嵌套安装）
    const entry = makePkgTree(path.join(
      tmp, 'Volta', 'tools', 'image', 'packages', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'
    ));
    process.env.LOCALAPPDATA = tmp;
    delete process.env.APPDATA;
    assert.strictEqual(paths.globalDshEntry(), entry);
  } finally {
    if (process.env.LOCALAPPDATA) delete process.env.LOCALAPPDATA;
    if (process.env.APPDATA) delete process.env.APPDATA;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('globalDshEntry: 识别 npm -g 全局安装', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npmg-'));
  try {
    // npm -g 布局：npm/node_modules/@deepseek-ai/dsh（兄弟目录放核心依赖）
    const entry = makePkgTree(path.join(tmp, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
    for (const dep of CORE_DEPS) {
      const d = path.join(tmp, 'npm', 'node_modules', '@deepseek-ai', dep);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${dep}`, version: '0.1.0-rc.6' }));
    }
    delete process.env.LOCALAPPDATA;
    process.env.APPDATA = tmp;
    assert.strictEqual(paths.globalDshEntry(), entry);
  } finally {
    if (process.env.LOCALAPPDATA) delete process.env.LOCALAPPDATA;
    if (process.env.APPDATA) delete process.env.APPDATA;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('globalDshEntry: 无全局安装返回 null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-noglobal-'));
  try {
    process.env.LOCALAPPDATA = tmp;
    process.env.APPDATA = tmp;
    assert.strictEqual(paths.globalDshEntry(), null);
  } finally {
    delete process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('vendorDshUsable: node_modules 为链接借壳时判定不可用', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vendorlink-'));
  try {
    const vendorPkg = path.join(tmp, 'vendor', 'dsh');
    makePkgTree(vendorPkg);
    // 把真实 node_modules 换成 junction（旧版"链接 profiles"的状态）
    fs.rmSync(path.join(vendorPkg, 'node_modules'), { recursive: true, force: true });
    const target = path.join(tmp, 'profiles', 'node_modules');
    fs.mkdirSync(target, { recursive: true });
    for (const dep of ['dsh-app-boot', 'dsh-base', 'dsh-web-app']) {
      const d = path.join(target, '@deepseek-ai', dep);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${dep}` }));
    }
    // Windows junction 创建无需管理员；失败时跳过该场景
    try {
      fs.symlinkSync(target, path.join(vendorPkg, 'node_modules'), 'junction');
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'ENOTSUP') return;
      throw e;
    }
    assert.strictEqual(paths.vendorDshUsable(tmp), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('vendorDshUsable: 真实目录依赖可用', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vendorreal-'));
  try {
    const vendorPkg = path.join(tmp, 'vendor', 'dsh');
    makePkgTree(vendorPkg);
    assert.strictEqual(paths.vendorDshUsable(tmp), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveDshEntryPaths: 完全独立——仅包含 Studio 自带（vendor → 基线），忽略全局', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-entries-'));
  try {
    process.env.DSH_HOME = path.join(tmp, 'dsh-home');
    const vendor = makePkgTree(path.join(tmp, 'dsh-home', 'vendor', 'dsh'));
    // 全局：也完整，但不得进入启动候选
    makePkgTree(path.join(
      tmp, 'Volta', 'tools', 'image', 'packages', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'
    ));
    process.env.LOCALAPPDATA = tmp;
    const bundleRoot = path.join(tmp, 'bundle');
    const baseline = makePkgTree(path.join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh'));

    const entries = paths.resolveDshEntryPaths(bundleRoot);
    assert.deepStrictEqual(entries, [vendor, baseline]);
  } finally {
    delete process.env.DSH_HOME;
    delete process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveDshEntryPaths: 无全局时回退 vendor 与基线', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-entries2-'));
  try {
    process.env.DSH_HOME = path.join(tmp, 'dsh-home');
    const vendor = makePkgTree(path.join(tmp, 'dsh-home', 'vendor', 'dsh'));
    // 无全局安装（LOCALAPPDATA/APPDATA 指向空目录）
    process.env.LOCALAPPDATA = path.join(tmp, 'empty-local');
    process.env.APPDATA = path.join(tmp, 'empty-app');
    const bundleRoot = path.join(tmp, 'bundle');
    const baseline = makePkgTree(path.join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh'));

    const entries = paths.resolveDshEntryPaths(bundleRoot);
    assert.deepStrictEqual(entries, [vendor, baseline]);
  } finally {
    delete process.env.DSH_HOME;
    delete process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listAllDshEntries: 兜底列出 自带 + 全局 + npx 缓存', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-listall-'));
  try {
    process.env.DSH_HOME = path.join(tmp, 'dsh-home');
    const vendor = makePkgTree(path.join(tmp, 'dsh-home', 'vendor', 'dsh'));
    const global = makePkgTree(path.join(
      tmp, 'Volta', 'tools', 'image', 'packages', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'
    ));
    const npx = makePkgTree(path.join(
      tmp, 'npm-cache', '_npx', 'abcd1234', 'node_modules', '@deepseek-ai', 'dsh'
    ));
    process.env.LOCALAPPDATA = tmp;
    const bundleRoot = path.join(tmp, 'bundle');

    const all = paths.listAllDshEntries(bundleRoot);
    assert.deepStrictEqual(all, [vendor, global, npx]);
  } finally {
    delete process.env.DSH_HOME;
    delete process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('dshVersionOf: 读取安装版本，失败返回 null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ver-'));
  try {
    const entry = makePkgTree(path.join(tmp, 'install', '@deepseek-ai', 'dsh'));
    const pkg = path.join(tmp, 'install', '@deepseek-ai', 'dsh', 'package.json');
    fs.writeFileSync(pkg, JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-test' }));
    assert.strictEqual(paths.dshVersionOf(entry), '9.9.9-test');
    assert.strictEqual(paths.dshVersionOf(path.join(tmp, 'nope', 'bin.js')), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

