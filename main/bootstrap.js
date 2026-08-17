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

module.exports = { PROFILE_TEMPLATES, ensureProfile, readApiKey, writeApiKey };
