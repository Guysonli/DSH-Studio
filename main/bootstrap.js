'use strict';
const fs = require('node:fs');
const path = require('node:path');

const PROFILE_TEMPLATES = {
  'cordis.yml': `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`,
  'cordis.patch.yml': `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`,
  'package.json': `{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
`,
  'pnpm-workspace.yaml': `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`,
};

async function ensureProfile(dshHome) {
  const dir = path.join(dshHome, 'profiles', 'web');
  if (fs.existsSync(path.join(dir, 'package.json'))) return false;
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(PROFILE_TEMPLATES)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return true;
}

async function readApiKey(dshHome) {
  const file = path.join(dshHome, '.credentials.yaml');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

async function writeApiKey(dshHome, key) {
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), `DEEPSEEK_API_KEY: ${key}\n`, 'utf8');
}

async function ensureDshInstalled(dshHome) {
  const vendorDir = path.join(dshHome, 'vendor', 'dsh');
  const entry = path.join(vendorDir, 'lib', 'bin.js');
  if (fs.existsSync(entry)) return;

  console.log('[dsh-studio] dsh 未安装，正在自动下载…');
  try {
    const { performUpdate } = require('./update-manager');
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    // 60 秒超时，防止网络卡死
    await Promise.race([
      performUpdate('0.1.0-rc.6', {
        vendorDir,
        npmCliPath: npmCli,
        execPath: process.execPath,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('下载超时')), 60000)),
    ]);
    console.log('[dsh-studio] dsh 下载完成');
  } catch (e) {
    console.error('[dsh-studio] dsh 自动下载失败:', e.message);
    // 下载失败不阻塞启动，后续会用 baseline 或报错
  }
}

module.exports = { PROFILE_TEMPLATES, ensureProfile, readApiKey, writeApiKey, ensureDshInstalled };
