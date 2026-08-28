'use strict';
// electron-builder afterPack 钩子：把完整 dsh 基线与更新工具复制进 resources/。
// 为什么不用 extraResources：electron-builder 的复制管线会无条件排除
// node_modules 目录树，导致基线依赖缺失（安装包无法启动）。
const fs = require('node:fs');
const path = require('node:path');

const PAIRS = [
  ['vendor-src/dsh', 'dsh'],
  ['vendor-src/tools', 'tools'],
];

module.exports = async (context) => {
  const root = path.join(__dirname, '..');
  const destRoot = path.join(context.appOutDir, 'resources');
  for (const [from, to] of PAIRS) {
    const src = path.join(root, from);
    if (!fs.existsSync(src)) {
      console.warn(`[after-pack] 跳过（源不存在）：${from}`);
      continue;
    }
    const dest = path.join(destRoot, to);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
    console.log(`[after-pack] 已复制 ${from} → resources/${to}`);
  }
};
