'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function vendorDir() {
  return path.join(dshHome(), 'vendor', 'dsh');
}

function vendorDshEntry() {
  return path.join(vendorDir(), 'lib', 'bin.js');
}

function baselineDshEntry(bundleRoot) {
  // bundleRoot：捆绑基线根目录（dev = vendor-src/dsh；打包 = resources/dsh）
  return path.join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/**
 * 判断一个 dsh 安装是否完整可用：bin.js 能否实际解析其核心依赖
 * （@deepseek-ai/dsh-app-boot 是 bin.js 的顶层 import）。用 Node 自身的
 * 解析器模拟真实启动，而不是只看 node_modules 目录是否存在——junction
 * 链接、缺失包等都会导致解析失败，从而被跳过。
 */
/** bin.js 启动必需的核心包：顶层 import + web profile 的两个 bundle。 */
const CORE_PACKAGES = ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/**
 * 判断一个 dsh 安装是否完整可用：bin.js 能否实际解析启动必需的核心包。
 * 用 Node 自身的解析器模拟真实启动，而不是只看 node_modules 目录是否存在——
 * junction 链接（含自引用环）、缺失包、半安装状态都会导致解析失败，从而被跳过。
 */
function isDshEntryUsable(entry) {
  try {
    if (!entry || !fs.existsSync(entry)) return false;
    const req = createRequire(entry);
    for (const pkg of CORE_PACKAGES) {
      let found = false;
      for (const p of req.resolve.paths(pkg) ?? []) {
        if (fs.existsSync(path.join(p, pkg, 'package.json'))) { found = true; break; }
      }
      if (!found) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 检测与该 CLI 共用的全局 dsh 安装（Volta / npm -g）。
 * 完整安装（依赖随包）优先，供"共享原生环境"使用。
 */
function globalDshEntry() {
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  const candidates = [];
  if (localAppData) {
    candidates.push(
      // Volta：packages/<scope>/<name>/node_modules/<scope>/<name>
      path.join(localAppData, 'Volta', 'tools', 'image', 'packages', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(localAppData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    );
  }
  if (appData) {
    candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  for (const c of candidates) {
    if (isDshEntryUsable(c)) return c;
  }
  return null;
}

/**
 * vendor 自更新副本是否完整可用：
 *   ① node_modules 必须是真实目录（旧版把 node_modules 建成指向 profiles 的
 *      junction 链接，依赖闭合经由公共目录"借壳"解析——启动时 dsh 自愈会把
 *      链接重指回 vendor 自身形成自引用环，必然启动失败，须判定为不可用）
 *   ② 核心依赖可解析
 */
function vendorDshUsable(home = dshHome()) {
  const nm = path.join(home, 'vendor', 'dsh', 'node_modules');
  try {
    if (fs.lstatSync(nm).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return isDshEntryUsable(path.join(home, 'vendor', 'dsh', 'lib', 'bin.js'));
}

/**
 * 启动条目候选（Studio 完全独立，按优先级）：
 *   ① 自更新副本（~/.dsh/vendor/dsh，Studio 托管的更新通道）
 *   ② 捆绑基线（安装包自带，离线兜底）
 * 全局 npx 等其他安装不作为启动候选；仅在 Studio 自带完全不可用时，
 * 由兜底页列出全部可用候选让用户选择（见 listAllDshEntries）。
 * 仅保留真正完整可用的安装。
 */
function resolveDshEntryPaths(bundleRoot) {
  const list = [];
  if (vendorDshUsable()) list.push(vendorDshEntry());
  if (isDshEntryUsable(baselineDshEntry(bundleRoot))) list.push(baselineDshEntry(bundleRoot));
  return list;
}

/** 读取某个 dsh 安装的版本号（读其 package.json）；失败返回 null。 */
function dshVersionOf(entry) {
  try {
    const pkg = path.join(path.dirname(path.dirname(entry)), 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** 扫描 npx 临时缓存中的完整 dsh 安装（不可靠来源，仅兜底候选）。 */
function npxDshEntries() {
  const cacheRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx')
    : path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(cacheRoot, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const entry = path.join(cacheRoot, d.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (isDshEntryUsable(entry)) out.push(entry);
  }
  return out;
}

/**
 * 列出电脑上所有完整可用的 dsh 安装（兜底选择页用）：
 *   Studio 自带（vendor → 基线）→ 全局（Volta / npm -g）→ npx 缓存。
 */
function listAllDshEntries(bundleRoot) {
  const all = [];
  for (const entry of resolveDshEntryPaths(bundleRoot)) all.push(entry);
  const g = globalDshEntry();
  if (g && !all.includes(g)) all.push(g);
  for (const entry of npxDshEntries()) {
    if (!all.includes(entry)) all.push(entry);
  }
  return all;
}

function logsDir() {
  return path.join(dshHome(), 'logs');
}

module.exports = {
  dshHome, vendorDir, vendorDshEntry, baselineDshEntry,
  globalDshEntry, isDshEntryUsable, vendorDshUsable, resolveDshEntryPaths,
  listAllDshEntries, dshVersionOf, npxDshEntries, logsDir,
};
