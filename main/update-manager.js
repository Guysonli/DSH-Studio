'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const npmRegistryUrl = 'https://registry.npmjs.org';

function parseVersion(v) {
  const [core, pre] = v.split('-');
  const [major, minor, patch] = core.split('.').map(Number);
  const prerelease = pre ? pre.split('.').map(x => isNaN(x) ? x : Number(x)) : [];
  return { major, minor, patch, prerelease };
}

function cmpCore(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function isNewer(remote, current) {
  const r = parseVersion(remote);
  const c = parseVersion(current);
  const core = cmpCore(r, c);
  if (core !== 0) return core > 0;
  if (r.prerelease.length === 0) return c.prerelease.length > 0;
  if (c.prerelease.length === 0) return false;
  const n = Math.max(r.prerelease.length, c.prerelease.length);
  for (let i = 0; i < n; i++) {
    const a = r.prerelease[i], b = c.prerelease[i];
    if (a === undefined) return false;
    if (b === undefined) return true;
    const an = Number(a), bn = Number(b);
    const anum = Number.isFinite(an), bnum = Number.isFinite(bn);
    if (anum && bnum) { if (an !== bn) return an > bn; }
    else if (anum !== bnum) return bnum;
    else if (a !== b) return a > b;
  }
  return false;
}

async function getLatestVersion() {
  const res = await fetch(`${npmRegistryUrl}/@deepseek-ai%2Fdsh/latest`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!res.ok) throw new Error(`registry 请求失败: ${res.status}`);
  const data = await res.json();
  if (!data.version) throw new Error('registry 响应缺少 version');
  return data.version;
}

function resolveDshEntry({ vendorEntry, baselineEntry }) {
  return vendorEntry || baselineEntry;
}

async function downloadTarball(version, destFile) {
  const url = `${npmRegistryUrl}/@deepseek-ai/dsh/-/dsh-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tarball 下载失败: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, buf);
}

function extractTarball(tgzFile, targetDir) {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const stream = fs.createReadStream(tgzFile).pipe(gunzip);
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => {
      try {
        const data = Buffer.concat(chunks);
        let offset = 0;
        fs.mkdirSync(targetDir, { recursive: true });
        while (offset + 512 <= data.length) {
          const header = data.subarray(offset, offset + 512);
          offset += 512;
          const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
          if (!name) break;
          const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
          const type = String.fromCharCode(header[156] || 0);
          const content = data.subarray(offset, offset + size);
          offset += Math.ceil(size / 512) * 512;
          if (name.endsWith('/')) continue;
          if (!name.startsWith('package/')) continue;
          const rel = name.slice('package/'.length);
          const dest = path.join(targetDir, rel);
          if (type === '0' || type === '\0' || type === '') {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, content);
          }
        }
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

module.exports = {
  npmRegistryUrl, parseVersion, isNewer, getLatestVersion,
  resolveDshEntry, downloadTarball, extractTarball,
};
