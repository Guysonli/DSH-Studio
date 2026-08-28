'use strict';
// 构建前准备：把 dsh 基线与其依赖装进 vendor-src/dsh（extraResources 源），
// 并把 npm 装进 vendor-src/tools（更新管理器安装自更新副本依赖用）。
//
// 基线安装方式（按序尝试）：
//  ① 从 npx 临时缓存复制完整 dsh 安装（最可靠：缓存里是官方 npm 解析好的
//     完整依赖树，避免 npm@10 严格模式对预发布依赖范围的 ERESOLVE 解析失败）
//  ② 回退 npm install（首次无缓存时可能需要）
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dshDir = path.join(root, 'vendor-src', 'dsh');
const toolsDir = path.join(root, 'vendor-src', 'tools');
const DSH_VERSION = '0.1.1-rc.2';

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/** 从 npx 缓存寻找完整可用的 dsh 安装（返回 node_modules 目录，无则 null）。 */
function findNpxDshInstall() {
  const cacheRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx')
    : path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'npm-cache', '_npx');
  if (!fs.existsSync(cacheRoot)) return null;
  const core = ['dsh-app-boot', 'dsh-base', 'dsh-web-app'];
  for (const dir of fs.readdirSync(cacheRoot)) {
    const nm = path.join(cacheRoot, dir, 'node_modules');
    const dsh = path.join(nm, '@deepseek-ai', 'dsh');
    if (!fs.existsSync(path.join(dsh, 'package.json'))) continue;
    const complete = core.every((p) => fs.existsSync(path.join(nm, '@deepseek-ai', p, 'package.json')));
    if (complete) return nm;
  }
  return null;
}

fs.mkdirSync(dshDir, { recursive: true });
fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({
  name: 'dsh-baseline-bundle',
  private: true,
  dependencies: { '@deepseek-ai/dsh': DSH_VERSION },
}, null, 2));

const npxNm = findNpxDshInstall();
if (npxNm) {
  console.log(`> 从 npx 缓存复制完整 dsh 安装：${npxNm}`);
  fs.rmSync(path.join(dshDir, 'node_modules'), { recursive: true, force: true });
  fs.cpSync(npxNm, path.join(dshDir, 'node_modules'), { recursive: true });
  const installed = JSON.parse(fs.readFileSync(
    path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'
  )).version;
  if (installed !== DSH_VERSION) {
    console.warn(`> 注意：npx 缓存为 ${installed}，与基线版本 ${DSH_VERSION} 不一致`);
  }
  console.log('> 基线复制完成');
} else {
  console.log('> 未找到 npx 缓存，回退 npm install（可能因 ERESOLVE 失败，建议改用复制流程）');
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], dshDir);
}

if (!fs.existsSync(path.join(toolsDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))) {
  fs.mkdirSync(toolsDir, { recursive: true });
  run('npm', ['install', 'npm@10', '--no-audit', '--no-fund', '--prefix', toolsDir], toolsDir);
} else {
  console.log('> vendor-src/tools 已就绪，跳过 npm 安装');
}
console.log('bundle 准备完成');
