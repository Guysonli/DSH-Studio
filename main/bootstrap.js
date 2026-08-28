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

// ---- 凭据文档解析/修补（与 @deepseek-ai/dsh-credentials-local 的 v1 布局互认）----

// 识别为 v1 文档且不含 records 的 flow 风格单行：{ version: 1, refs: { KEY: v, ... } }
const FLOW_REFS_RE = /\brefs\s*:\s*\{([\s\S]*?)\}\s*\}\s*$/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquoteScalar(v) {
  const s = v.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  }
  return s;
}

function renderScalar(value) {
  // API key 为安全字符串时保持裸值；否则双引号包裹（YAML 双引号标量）
  if (/^[A-Za-z0-9_\-./+=]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * 从凭据文档解析 refs 键值对（flow / block 风格均支持）。
 * @param {string} text - 凭据文档全文
 * @returns {{refs: Map, hasRecords: boolean}|null} 文档无法识别时返回 null
 */
function parseRefsDocument(text) {
  const flow = text.match(FLOW_REFS_RE);
  if (flow) {
    // 只处理可辨识的 flow refs；含 records 或版本不符的 flow 文档视为不可识别
    const versionAt = text.match(/\bversion\s*:\s*([^\s,}]+)/);
    if (/\brecords\s*:/.test(flow[1]) || (versionAt && versionAt[1] !== '1')) return null;
    const refs = new Map();
    const pairRe = /(^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}]+?)(?=\s*(?:[,}]|$))/g;
    let m;
    while ((m = pairRe.exec(flow[1])) !== null) refs.set(m[2], unquoteScalar(m[3]));
    return { refs, hasRecords: false };
  }
  // block 风格：可带 `version: 1`，refs: 节内为缩进键值；无 refs 节但有 version → 空 refs
  const versionMatch = text.match(/^\s*version\s*:\s*(\S+)\s*$/m);
  if (versionMatch) {
    const version = Number(versionMatch[1]);
    if (!Number.isFinite(version) || version !== 1) return null;
    const refs = new Map();
    const sectionRe = /^refs\s*:\s*\n((?:[ \t]+[^\n]*\n?)*)/m;
    const section = text.match(sectionRe);
    if (section) {
      for (const line of section[1].split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
        if (m) refs.set(m[1], unquoteScalar(m[2]));
      }
    }
    return { refs, hasRecords: /\brecords\s*:/.test(text) };
  }
  return null;
}

/**
 * 把文档改写为包含 ref 新值的 v1 文档，并尽量保留其他条目。
 * 无法安全识别的文档直接抛错，绝不静默覆盖（与 dsh 的 fail-loud 原则一致）。
 * @returns 新文档文本
 */
function patchCredentialsDocument(text, ref, value) {
  const scalar = renderScalar(value);
  const trimmed = (text || '').trim();
  // 空文档或 dsh 的"空存储"（{}）都按全新文档处理
  if (text == null || trimmed === '' || trimmed === '{}') {
    return `version: 1\nrefs:\n  ${ref}: ${scalar}\n`;
  }

  // 旧 flat 布局（无 version 的纯键值对）→ 迁移为 v1（与 dsh-credentials-local 迁移语义一致）
  const flatLines = trimmed.split('\n').filter((l) => l.trim() !== '');
  if (!/^version\s*:/m.test(trimmed) && flatLines.length > 0 &&
      flatLines.every((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*.+$/.test(l))) {
    const refs = new Map();
    for (const l of flatLines) {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
      refs.set(m[1], unquoteScalar(m[2]));
    }
    refs.set(ref, value);
    return renderRefsDocument(refs);
  }

  const parsed = parseRefsDocument(trimmed);
  if (parsed === null) {
    throw new Error(`无法识别的凭据文档（不会被自动改写）：${JSON.stringify(trimmed.slice(0, 80))}`);
  }
  parsed.refs.set(ref, value);
  // 可识别的布局统一重建为规范 block v1（refs 全保留）
  if (!parsed.hasRecords) return renderRefsDocument(parsed.refs);

  // 含 records 的 block 文档：仅做最小文本修补，records 与注释原样保留
  const lineRe = new RegExp(`^(\\s*)${escapeRegExp(ref)}(\\s*:\\s*).*$`, 'm');
  if (lineRe.test(trimmed)) {
    return text.replace(lineRe, `$1${ref}$2${scalar}`);
  }
  return text.replace(/^records\s*:/m, `refs:\n  ${ref}: ${scalar}\nrecords:`);
}

function renderRefsDocument(refs) {
  const lines = ['version: 1', 'refs:'];
  for (const [k, v] of refs) lines.push(`  ${k}: ${renderScalar(String(v))}`);
  return lines.join('\n') + '\n';
}

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
  // 优先级与 dsh 原生一致：启动环境 > 受管凭据文件
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;

  const file = path.join(dshHome, '.credentials.yaml');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  // dsh 可能将文件覆盖为 {}，这种情况视为无效
  if (text.trim() === '{}' || text.trim() === '') return null;

  // dsh 原生 v1：flow 或 block 的 refs 节
  const parsed = parseRefsDocument(text);
  if (parsed !== null && parsed.refs.has('DEEPSEEK_API_KEY')) {
    return parsed.refs.get('DEEPSEEK_API_KEY');
  }
  // 旧 flat / 任何层级无括号的 DEEPSEEK_API_KEY: sk-… 行
  const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(.+?)\s*$/m);
  return m ? unquoteScalar(m[1]) : null;
}

async function writeApiKey(dshHome, key) {
  fs.mkdirSync(dshHome, { recursive: true });
  const file = path.join(dshHome, '.credentials.yaml');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const next = patchCredentialsDocument(existing, 'DEEPSEEK_API_KEY', key);
  fs.writeFileSync(file, next, 'utf8');
}

/** 判断 vendor 副本是否完整可用（必须是真实安装：目录级依赖，非链接借壳）。 */
function vendorComplete(home) {
  const { vendorDshUsable } = require('./paths');
  return vendorDshUsable(home);
}

/** 与捆绑基线一致的版本号，全新安装时下载该版本。 */
const DSH_BUNDLE_VERSION = '0.1.1-rc.2';

async function ensureDshInstalled(dshHome, { npmCliPath = null, execPath = process.execPath } = {}) {
  const vendorDir = path.join(dshHome, 'vendor', 'dsh');
  const entry = path.join(vendorDir, 'lib', 'bin.js');
  const failMarker = path.join(vendorDir, 'install-failed');

  // 情况 1：完整安装（核心依赖可解析），直接用
  if (vendorComplete(dshHome)) {
    fs.rmSync(failMarker, { force: true }); // 已修复则清除失败标记
    return;
  }

  // 上次修复失败：标记存在时跳过，避免每次启动都重试（由基线/全局兜底）
  if (fs.existsSync(failMarker)) {
    console.warn('[dsh-studio] dsh vendor 上次修复失败，本次跳过（删除 ~/.dsh/vendor/dsh/install-failed 可重试）');
    return;
  }

  const npmCliOk = npmCliPath && fs.existsSync(npmCliPath);
  if (!npmCliOk) {
    // 没有 npm-cli 时跳过：由全局/基线 dsh 兜底，不强行下载
    console.warn('[dsh-studio] dsh vendor 不完整且缺少 npm-cli，跳过自动安装（将由其他安装兜底）');
    return;
  }

  const { removeNodeModulesDir, installVendorDeps, performUpdate } = require('./update-manager');

  // 情况 2：有入口但依赖缺失/损坏 → 重建为真实安装（移除旧 node_modules，含旧版 junction 链接）
  if (entry) {
    console.log('[dsh-studio] dsh 已就位但依赖缺失，正在补装依赖…');
    try {
      removeNodeModulesDir(vendorDir);
      await installVendorDeps(vendorDir, npmCliPath, execPath);
      if (vendorComplete(dshHome)) {
        console.log('[dsh-studio] dsh 依赖安装完成');
        return;
      }
      console.error('[dsh-studio] dsh 依赖补装后仍不完整，将尝试完全重装');
    } catch (e) {
      console.error('[dsh-studio] dsh 依赖安装失败:', e.message);
      fs.writeFileSync(failMarker, String(Date.now()), 'utf8');
      return;
    }
  }

  // 情况 3：完全没有（或补装失败）→ 完整下载安装
  console.log('[dsh-studio] dsh 未安装，正在自动下载…');
  try {
    await Promise.race([
      performUpdate(DSH_BUNDLE_VERSION, { vendorDir, npmCliPath, execPath }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('下载超时')), 60000)),
    ]);
    console.log('[dsh-studio] dsh 下载完成');
  } catch (e) {
    console.error('[dsh-studio] dsh 自动下载失败:', e.message);
    fs.writeFileSync(failMarker, String(Date.now()), 'utf8');
  }
}

module.exports = {
  PROFILE_TEMPLATES, ensureProfile, readApiKey, writeApiKey, ensureDshInstalled,
  patchCredentialsDocument, parseRefsDocument, vendorComplete,
};
