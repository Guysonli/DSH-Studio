'use strict';
// 构建前准备：把 dsh 基线与其依赖装进 vendor-src/dsh（extraResources 源），
// 并把 npm 装进 vendor-src/tools（更新管理器安装 vendor 依赖用）
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dshDir = path.join(root, 'vendor-src', 'dsh');
const toolsDir = path.join(root, 'vendor-src', 'tools');

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

fs.mkdirSync(dshDir, { recursive: true });
fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({
  name: 'dsh-baseline-bundle',
  private: true,
  dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.6' },
}, null, 2));

run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], dshDir);

fs.mkdirSync(toolsDir, { recursive: true });
run('npm', ['install', 'npm@10', '--no-audit', '--no-fund', '--prefix', toolsDir], toolsDir);
console.log('bundle 准备完成');
