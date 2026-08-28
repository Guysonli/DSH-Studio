'use strict';
// 打包前置检查：vendor-src 必须已准备好（npm run bundle:dsh），
// 否则 electron-builder 会打出一个没有可用 dsh 基线的安装包。
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const baselineEntry = path.join(root, 'vendor-src', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const baselineAppBoot = path.join(root, 'vendor-src', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-app-boot');
const npmCli = path.join(root, 'vendor-src', 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js');

const missing = [];
if (!fs.existsSync(baselineEntry)) missing.push('vendor-src/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js（捆绑基线）');
if (!fs.existsSync(baselineAppBoot)) missing.push('vendor-src/dsh/node_modules/@deepseek-ai/dsh-app-boot（基线依赖）');
if (!fs.existsSync(npmCli)) missing.push('vendor-src/tools/node_modules/npm/bin/npm-cli.js（更新工具）');

if (missing.length > 0) {
  console.error('错误：打包资源未准备完整，缺少：');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('');
  console.error('请先执行 npm run bundle:dsh（下载 dsh 及其依赖到 vendor-src），再打包：');
  console.error('  npm run dist:full');
  process.exit(1);
}

console.log('打包资源检查通过（基线依赖与更新工具均已就绪）');
