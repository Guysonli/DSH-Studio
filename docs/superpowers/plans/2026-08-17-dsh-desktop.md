# DSH Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 DeepSeek Harness 的 Electron 桌面版——内嵌 GUI、自动管理 dsh 服务进程、首次运行密钥向导、dsh 自动升级、NSIS 安装包分发，与现有 CLI 无缝共存。

**Architecture:** Electron 主进程编排状态机（端口探测 → 首次初始化 → 启动/连接 dsh 服务 → 就绪 → 加载 GUI），以 `ELECTRON_RUN_AS_NODE` 方式运行捆绑的 `@deepseek-ai/dsh` 包；dsh 版本采用「捆绑基线 + 用户目录 vendor 增量 + npm registry 自动检测」三层加载。

**Tech Stack:** Electron（最新稳定版）、electron-builder（NSIS）、Node 22 内置 `node:test`（零依赖测试）、CommonJS 主进程、ESM dsh 包（经 ELECTRON_RUN_AS_NODE 运行）。

## Global Constraints

- 项目根目录：`C:\Users\lgswr\Desktop\dsh-desktop`（git 仓库已存在，根提交 e091eb6）
- 目标平台：Windows x64；开发机 Node 22.22.2（Volta）、npm 10.9.7
- dsh 捆绑版本：`@deepseek-ai/dsh@0.1.0-rc.6`（npm install 默认 dependencies，勿装 devDependencies）
- DSH_HOME 默认：`%USERPROFILE%\.dsh`；应用显式传入 env.DSH_HOME，不依赖目标机环境变量
- 服务端口默认 3080；被占不可达时重试 5 秒后探测空闲端口
- 密钥写入 `DSH_HOME/.credentials.yaml`，格式 `DEEPSEEK_API_KEY: <value>`（与官方 CLI 兼容）
- profile 骨架：`profiles/web/` 下 4 个文件（cordis.yml、cordis.patch.yml、package.json、pnpm-workspace.yaml），内容见 Task 5
- 主进程模块一律 CommonJS（require）；测试用 `node --test`；纯逻辑模块不依赖 electron
- 每个任务结束必须 commit；提交信息遵循 conventional commits

---

### Task 1: 项目脚手架与 Electron 安装

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `main/.gitkeep`
- Create: `renderer/.gitkeep`
- Create: `test/.gitkeep`
- Create: `vendor-src/.gitkeep`

**Interfaces:**
- Produces: 可运行的 npm 项目；`npm run dev` 待 Task 8 提供

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "dsh-studio",
  "version": "0.1.0",
  "description": "DeepSeek Harness Desktop — 桌面版外壳",
  "main": "main/main.js",
  "private": true,
  "scripts": {
    "test": "node --test test/",
    "bundle:dsh": "node scripts/prepare-bundle.js",
    "start": "electron .",
    "dist": "npm run bundle:dsh && electron-builder --win"
  }
}
```

- [ ] **Step 2: 写 .gitignore**

```
node_modules/
dist/
vendor-src/dsh/node_modules/
vendor-src/tools/node_modules/
*.log
```

- [ ] **Step 3: 创建空目录占位文件**

```powershell
New-Item -ItemType Directory -Force main, renderer, test, vendor-src, scripts, "docs\superpowers\plans" | Out-Null
New-Item -ItemType File -Force main\.gitkeep, renderer\.gitkeep, test\.gitkeep, vendor-src\.gitkeep | Out-Null
```

- [ ] **Step 4: 安装依赖**

```powershell
npm install --save-dev electron@latest electron-builder@latest
```

预期：`node_modules/electron` 与 `node_modules/electron-builder` 出现，`npx electron --version` 输出版本号（如 v3x.x.x）。

- [ ] **Step 5: 验证 Electron 可启动**

```powershell
npx electron --version
```

预期：打印 Electron 版本号，无报错。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore main renderer test vendor-src
git commit -m "chore: 项目脚手架与 Electron 依赖"
```

---

### Task 2: 路径模块 paths.js

**Files:**
- Create: `main/paths.js`
- Test: `test/paths.test.js`

**Interfaces:**
- Produces:
  - `dshHome()` → `string`：`process.env.DSH_HOME || path.join(os.homedir(), '.dsh')`
  - `baselineDshEntry(projectRoot)` → `string`：捆绑基线 dsh 入口 `lib/bin.js` 绝对路径
  - `vendorDshEntry()` → `string`：vendor 区入口 `~/.dsh/vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`
  - `logsDir()` → `string`：`dshHome()/logs`
  - `vendorDir()` → `string`：`dshHome()/vendor/dsh`

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

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
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
node --test test/paths.test.js
```

预期：FAIL，`Cannot find module '../main/paths'`。

- [ ] **Step 3: 实现 paths.js**

```js
'use strict';
const os = require('node:os');
const path = require('node:path');

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function vendorDir() {
  return path.join(dshHome(), 'vendor', 'dsh');
}

function vendorDshEntry() {
  return path.join(vendorDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function baselineDshEntry(projectRoot) {
  return path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function logsDir() {
  return path.join(dshHome(), 'logs');
}

module.exports = { dshHome, vendorDir, vendorDshEntry, baselineDshEntry, logsDir };
```

> 注：`baselineDshEntry` 在开发模式指向项目 node_modules；打包后由 main.js 改为 `process.resourcesPath/dsh/node_modules/...`（Task 8）。

- [ ] **Step 4: 运行测试确认通过**

```powershell
node --test test/paths.test.js
```

预期：5 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add main/paths.js test/paths.test.js
git commit -m "feat: 路径解析模块 paths"
```

---

### Task 3: 端口探测模块 port-probe.js

**Files:**
- Create: `main/port-probe.js`
- Test: `test/port-probe.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `probePort(port, timeoutMs)` → `Promise<boolean>`：HTTP GET `http://127.0.0.1:port/`，任何 HTTP 响应（含 4xx/5xx）视为可达；连接拒绝/超时返回 false
  - `findFreePort(startPort)` → `Promise<number>`：从 startPort 起探测空闲端口（TCP listen 测试）
  - `decidePort(startPort)` → `Promise<{mode: 'connect'|'start', port: number}>`：
    - 可达 → `{mode:'connect', port}`
    - 不可达但被占用（TCP 连接成功、HTTP 无响应）→ 每 500ms 重试，共 5 秒；仍不可达 → `findFreePort` 取空闲端口 `{mode:'start', port}`
    - 完全空闲 → `{mode:'start', port}`

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');

const { probePort, findFreePort, decidePort } = require('../main/port-probe');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      try { await fn(srv.address().port, srv); resolve(); }
      catch (e) { reject(e); } finally { srv.close(); }
    });
  });
}

test('probePort: 可达返回 true', async () => {
  await withServer((req, res) => { res.writeHead(200); res.end('ok'); }, async (port) => {
    assert.strictEqual(await probePort(port, 2000), true);
  });
});

test('probePort: 4xx 也算可达', async () => {
  await withServer((req, res) => { res.writeHead(404); res.end('no'); }, async (port) => {
    assert.strictEqual(await probePort(port, 2000), true);
  });
});

test('probePort: 空闲端口返回 false', async () => {
  const free = await findFreePort(40000);
  assert.strictEqual(await probePort(free, 800), false);
});

test('findFreePort: 返回可 listen 的端口', async () => {
  const port = await findFreePort(40000);
  assert.ok(port > 0);
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(port, '127.0.0.1', () => { s.close(resolve); });
    s.on('error', reject);
  });
});

test('decidePort: 空闲端口进入 start 模式', async () => {
  const free = await findFreePort(41000);
  const d = await decidePort(free);
  assert.strictEqual(d.mode, 'start');
  assert.strictEqual(d.port, free);
});

test('decidePort: 已有服务进入 connect 模式', async () => {
  await withServer((req, res) => { res.writeHead(200); res.end('ok'); }, async (port) => {
    const d = await decidePort(port);
    assert.strictEqual(d.mode, 'connect');
    assert.strictEqual(d.port, port);
  });
});

test('decidePort: 被占但不可达 → 重试后换空闲端口', async () => {
  // 占住一个端口但不响应 HTTP（纯 TCP 监听）
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const d = await decidePort(port);
  assert.strictEqual(d.mode, 'start');
  assert.notStrictEqual(d.port, port);
  blocker.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
node --test test/port-probe.test.js
```

预期：FAIL，`Cannot find module '../main/port-probe'`。

- [ ] **Step 3: 实现 port-probe.js**

```js
'use strict';
const http = require('node:http');
const net = require('node:net');

function probePort(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function tcpReachable(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function decidePort(startPort) {
  if (await probePort(startPort, 2000)) return { mode: 'connect', port: startPort };
  // 端口被占（TCP 可达但 HTTP 无响应）→ 重试 5 秒
  if (await tcpReachable(startPort)) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (await probePort(startPort, 1000)) return { mode: 'connect', port: startPort };
    }
    const free = await findFreePort(startPort + 1);
    return { mode: 'start', port: free };
  }
  return { mode: 'start', port: startPort };
}

module.exports = { probePort, tcpReachable, findFreePort, decidePort };
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
node --test test/port-probe.test.js
```

预期：7 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add main/port-probe.js test/port-probe.test.js
git commit -m "feat: 端口探测与决策模块 port-probe"
```

---

### Task 4: 服务进程管理 server-manager.js

**Files:**
- Create: `main/server-manager.js`
- Test: `test/server-manager.test.js`

**Interfaces:**
- Consumes: `paths.js`（logsDir）
- Produces:
  - `spawnDsh({ entry, port, dshHome, projectRoot, execPath })` → `ChildProcess`：以 `ELECTRON_RUN_AS_NODE=1` 环境运行 `execPath entry --profile web --port <port>`，stdio pipe，日志写 `dshHome/logs/server.log`
  - `waitReady(port, timeoutMs = 30000)` → `Promise<boolean>`：每 500ms `probePort`，超时 false
  - `killTree(child)` → `Promise<void>`：先 `child.kill()`，2 秒未退 → Windows `taskkill /pid <pid> /T /F`
  - `stopServer(child)` → `Promise<void>`：`killTree` 的别名（语义清晰）

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { spawnDsh, waitReady, killTree } = require('../main/server-manager');
const { probePort } = require('../main/port-probe');

// 用 node 起一个最小 HTTP 服务脚本充当"dsh"
const FAKE_DSH = path.join(os.tmpdir(), 'dsh-studio-test-fake-server.js');
fs.writeFileSync(FAKE_DSH, `
const http = require('node:http');
http.createServer((req, res) => { res.writeHead(200); res.end('ok'); })
  .listen(Number(process.argv[2]), '127.0.0.1');
`);

test('spawnDsh 启动子进程并监听端口', async () => {
  const entry = FAKE_DSH;
  const port = 42000 + Math.floor(Math.random() * 1000);
  const child = spawnDsh({
    entry, port,
    dshHome: path.join(os.tmpdir(), 'dsh-test-home'),
    projectRoot: process.cwd(),
    execPath: process.execPath,
  });
  try {
    assert.ok(child.pid > 0);
    const ready = await waitReady(port, 10000);
    assert.strictEqual(ready, true);
  } finally {
    await killTree(child);
  }
});

test('waitReady 对空闲端口超时返回 false', async () => {
  const ready = await waitReady(49999, 1200);
  assert.strictEqual(ready, false);
});

test('killTree 终止子进程', async () => {
  const entry = FAKE_DSH;
  const port = 43000 + Math.floor(Math.random() * 1000);
  const child = spawnDsh({
    entry, port,
    dshHome: path.join(os.tmpdir(), 'dsh-test-home'),
    projectRoot: process.cwd(),
    execPath: process.execPath,
  });
  await waitReady(port, 10000);
  await killTree(child);
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(await probePort(port, 500), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
node --test test/server-manager.test.js
```

预期：FAIL，`Cannot find module '../main/server-manager'`。

- [ ] **Step 3: 实现 server-manager.js**

```js
'use strict';
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { probePort } = require('./port-probe');

function ensureLogFile(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
}

function spawnDsh({ entry, port, dshHome, projectRoot, execPath }) {
  const logFile = path.join(dshHome, 'logs', 'server.log');
  ensureLogFile(logFile);
  const out = fs.openSync(logFile, 'a');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: dshHome,
  };
  const child = spawn(execPath, [entry, '--profile', 'web', '--port', String(port)], {
    env,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.on('exit', () => { try { fs.closeSync(out); } catch {} });
  return child;
}

function waitReady(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      if (await probePort(port, 1000)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve());
      }
    }, 2000);
  });
}

const stopServer = killTree;

module.exports = { spawnDsh, waitReady, killTree, stopServer };
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
node --test test/server-manager.test.js
```

预期：3 个测试全 PASS（第一个与第三个会真实起/杀子进程）。

- [ ] **Step 5: Commit**

```bash
git add main/server-manager.js test/server-manager.test.js
git commit -m "feat: dsh 服务进程管理 server-manager"
```

---

### Task 5: 首次运行初始化 bootstrap.js

**Files:**
- Create: `main/bootstrap.js`
- Test: `test/bootstrap.test.js`

**Interfaces:**
- Consumes: `paths.js`（dshHome）
- Produces:
  - `PROFILE_TEMPLATES`：对象，键为文件名（`cordis.yml`、`cordis.patch.yml`、`package.json`、`pnpm-workspace.yaml`），值为文件内容字符串
  - `ensureProfile(dshHome)` → `Promise<boolean>`：`<dshHome>/profiles/web` 缺失时创建并写入 4 个模板文件，返回是否新建
  - `readApiKey(dshHome)` → `string|null`：读 `<dshHome>/.credentials.yaml` 中 `DEEPSEEK_API_KEY:` 的值（去掉首尾空白），文件不存在返回 null
  - `writeApiKey(dshHome, key)` → `Promise<void>`：写入 `DEEPSEEK_API_KEY: <key>`（覆盖写）

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureProfile, readApiKey, writeApiKey, PROFILE_TEMPLATES } = require('../main/bootstrap');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-'));
}

test('PROFILE_TEMPLATES 包含 4 个文件', () => {
  assert.deepStrictEqual(Object.keys(PROFILE_TEMPLATES).sort(), [
    'cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml',
  ]);
});

test('ensureProfile 首次创建 4 个文件', async () => {
  const home = tmpHome();
  const created = await ensureProfile(home);
  assert.strictEqual(created, true);
  for (const name of Object.keys(PROFILE_TEMPLATES)) {
    const f = path.join(home, 'profiles', 'web', name);
    assert.ok(fs.existsSync(f), name);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), PROFILE_TEMPLATES[name]);
  }
});

test('ensureProfile 已存在时不重复创建', async () => {
  const home = tmpHome();
  await ensureProfile(home);
  const created = await ensureProfile(home);
  assert.strictEqual(created, false);
});

test('writeApiKey 与 readApiKey 往返', async () => {
  const home = tmpHome();
  await writeApiKey(home, 'sk-abc123');
  assert.strictEqual(await readApiKey(home), 'sk-abc123');
});

test('readApiKey 文件缺失返回 null', async () => {
  const home = tmpHome();
  assert.strictEqual(await readApiKey(home), null);
});

test('readApiKey 忽略键名前后空白', async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.yaml'), '  DEEPSEEK_API_KEY:  sk-xyz  \n');
  assert.strictEqual(await readApiKey(home), 'sk-xyz');
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
node --test test/bootstrap.test.js
```

预期：FAIL，`Cannot find module '../main/bootstrap'`。

- [ ] **Step 3: 实现 bootstrap.js**

```js
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
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
node --test test/bootstrap.test.js
```

预期：6 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add main/bootstrap.js test/bootstrap.test.js
git commit -m "feat: 首次运行初始化 bootstrap"
```

---

### Task 6: 更新管理器 update-manager.js

**Files:**
- Create: `main/update-manager.js`
- Test: `test/update-manager.test.js`

**Interfaces:**
- Consumes: `paths.js`（vendorDir）
- Produces:
  - `npmRegistryUrl = 'https://registry.npmjs.org'`
  - `getLatestVersion()` → `Promise<string>`：GET `${npmRegistryUrl}/@deepseek-ai%2Fdsh/latest`，读 `version` 字段；失败抛错
  - `parseVersion(v)` → `{major, minor, patch, prerelease}`：解析 `0.1.0-rc.6` 这类版本
  - `isNewer(remote, current)` → `boolean`：语义化比较（先比 major/minor/patch，再比 prerelease；无 prerelease 视为更新）
  - `resolveDshEntry({ vendorEntry, baselineEntry })` → `string`：vendorEntry 存在返回它，否则 baselineEntry
  - `downloadTarball(version, destFile)` → `Promise<void>`：GET `${npmRegistryUrl}/@deepseek-ai/dsh/-/dsh-${version}.tgz`，流式写入 destFile
  - `extractTarball(tgzFile, targetDir)` → `Promise<void>`：用 `tar` 解压（`--strip-components=1`）到 `targetDir/package`；实现用 Node 内置 `zlib` + 逐条解析 tar 头（500 字节块），仅解出 `package/` 前缀条目

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseVersion, isNewer, resolveDshEntry, extractTarball,
} = require('../main/update-manager');

test('parseVersion 解析 rc 版本', () => {
  const v = parseVersion('0.1.0-rc.6');
  assert.deepStrictEqual(v, { major: 0, minor: 1, patch: 0, prerelease: ['rc', 6] });
});

test('isNewer: patch 提升为更新', () => {
  assert.strictEqual(isNewer('0.1.1', '0.1.0-rc.6'), true);
});

test('isNewer: 同版本非更新', () => {
  assert.strictEqual(isNewer('0.1.0-rc.6', '0.1.0-rc.6'), false);
});

test('isNewer: rc 到正式版为更新', () => {
  assert.strictEqual(isNewer('0.1.0', '0.1.0-rc.6'), true);
});

test('isNewer: 远程更旧非更新', () => {
  assert.strictEqual(isNewer('0.0.9', '0.1.0-rc.6'), false);
});

test('resolveDshEntry: vendor 优先', () => {
  assert.strictEqual(
    resolveDshEntry({ vendorEntry: 'Z:\\v\\bin.js', baselineEntry: 'C:\\b\\bin.js' }),
    'Z:\\v\\bin.js'
  );
});

test('resolveDshEntry: 无 vendor 用基线', () => {
  assert.strictEqual(
    resolveDshEntry({ vendorEntry: null, baselineEntry: 'C:\\b\\bin.js' }),
    'C:\\b\\bin.js'
  );
});

test('extractTarball 解出 package/ 下文件', async () => {
  const tgz = path.join(os.tmpdir(), `dsh-test-${Date.now()}.tgz`);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-extract-'));
  try {
    // 构造一个含 package/lib/bin.js 的 tar.gz
    const zlib = require('node:zlib');
    const { execFileSync } = require('node:child_process');
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tar-stage-'));
    fs.mkdirSync(path.join(staging, 'package', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'package', 'lib', 'bin.js'), '// hello');
    fs.writeFileSync(path.join(staging, 'package', 'package.json'), '{"name":"x"}');
    execFileSync('tar', ['-czf', tgz, '-C', staging, 'package']);
    await extractTarball(tgz, target);
    assert.strictEqual(fs.readFileSync(path.join(target, 'lib', 'bin.js'), 'utf8'), '// hello');
    assert.strictEqual(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), '{"name":"x"}');
  } finally {
    fs.rmSync(tgz, { force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
node --test test/update-manager.test.js
```

预期：FAIL，`Cannot find module '../main/update-manager'`。

- [ ] **Step 3: 实现 update-manager.js**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const npmRegistryUrl = 'https://registry.npmjs.org';

function parseVersion(v) {
  const [core, pre] = v.split('-');
  const [major, minor, patch] = core.split('.').map(Number);
  const prerelease = pre ? pre.split('.') : [];
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
    else if (anum !== bnum) return bnum; // 数字段大于字母段
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
  return vendorEntry && fs.existsSync(vendorEntry) ? vendorEntry : baselineEntry;
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
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
node --test test/update-manager.test.js
```

预期：8 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add main/update-manager.js test/update-manager.test.js
git commit -m "feat: dsh 更新管理器 update-manager"
```

---

### Task 7: 渲染层页面与 preload

**Files:**
- Create: `main/preload.js`
- Create: `renderer/loading.html`
- Create: `renderer/setup.html`
- Create: `renderer/error.html`
- Create: `renderer/theme.css`（三个页面共用样式）

**Interfaces:**
- Consumes: 无（页面由 main.js 在 Task 8 加载）
- Produces:
  - preload 通过 `contextBridge` 暴露 `window.dshDesktop`：
    - `submitApiKey(key)` → `ipcRenderer.invoke('setup:submit', key)`
    - `getVersionInfo()` → `ipcRenderer.invoke('version:info')`
    - `retry()` → `ipcRenderer.invoke('app:retry')`
    - `onStage(cb)` → 订阅 `app:stage` 事件（`{stage: string, detail?: string}`）
    - `onFatal(cb)` → 订阅 `app:fatal` 事件（`{message: string, detail?: string}`）

- [ ] **Step 1: 写 preload.js**

```js
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  submitApiKey: (key) => ipcRenderer.invoke('setup:submit', key),
  getVersionInfo: () => ipcRenderer.invoke('version:info'),
  retry: () => ipcRenderer.invoke('app:retry'),
  onStage: (cb) => ipcRenderer.on('app:stage', (_e, payload) => cb(payload)),
  onFatal: (cb) => ipcRenderer.on('app:fatal', (_e, payload) => cb(payload)),
});
```

- [ ] **Step 2: 写共用样式 renderer/theme.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
  background: #111318;
  color: #e6e6e6;
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh;
}
.card {
  width: 420px; max-width: 90vw;
  background: #1a1d24; border: 1px solid #2a2e38; border-radius: 10px;
  padding: 28px 32px; text-align: center;
}
h1 { font-size: 18px; margin-bottom: 12px; }
p.stage { color: #9aa3b2; font-size: 13px; margin-bottom: 16px; min-height: 18px; }
input[type="password"] {
  width: 100%; padding: 10px 12px; border-radius: 6px;
  border: 1px solid #333a47; background: #111318; color: #e6e6e6;
  margin-bottom: 14px; font-size: 14px;
}
button {
  padding: 10px 22px; border: none; border-radius: 6px;
  background: #3b82f6; color: #fff; font-size: 14px; cursor: pointer;
}
button:hover { background: #2f6fe0; }
.err { color: #f87171; font-size: 13px; margin-top: 12px; word-break: break-all; }
.spinner {
  width: 34px; height: 34px; margin: 14px auto;
  border: 3px solid #2a2e38; border-top-color: #3b82f6;
  border-radius: 50%; animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.mono { font-family: Consolas, monospace; font-size: 12px; color: #9aa3b2; margin-top: 8px; }
```

- [ ] **Step 3: 写 loading.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'">
  <title>正在启动 DeepSeek Harness</title>
  <link rel="stylesheet" href="theme.css">
</head>
<body>
  <div class="card">
    <h1>DeepSeek Harness Desktop</h1>
    <div class="spinner"></div>
    <p class="stage" id="stage">正在初始化…</p>
    <p class="mono" id="version"></p>
  </div>
  <script>
    window.dshDesktop.getVersionInfo().then((v) => {
      document.getElementById('version').textContent = 'dsh ' + v.dshVersion + ' · 应用 ' + v.appVersion;
    });
    window.dshDesktop.onStage(({ stage, detail }) => {
      document.getElementById('stage').textContent = detail || stage;
    });
    window.dshDesktop.onFatal(({ message, detail }) => {
      location.href = 'error.html?m=' + encodeURIComponent(message) + '&d=' + encodeURIComponent(detail || '');
    });
  </script>
</body>
</html>
```

- [ ] **Step 4: 写 setup.html（密钥向导）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'">
  <title>配置 DeepSeek API Key</title>
  <link rel="stylesheet" href="theme.css">
</head>
<body>
  <div class="card">
    <h1>首次使用配置</h1>
    <p class="stage">请输入你的 DeepSeek API Key（仅保存在本机 ~/.dsh/.credentials.yaml，与官方 CLI 共用）</p>
    <input type="password" id="key" placeholder="sk-..." autofocus>
    <button id="save">保存并启动</button>
    <p class="err" id="err"></p>
  </div>
  <script>
    const input = document.getElementById('key');
    const btn = document.getElementById('save');
    const err = document.getElementById('err');
    btn.onclick = async () => {
      const key = input.value.trim();
      if (!key) { err.textContent = '请输入 API Key'; return; }
      err.textContent = '';
      try {
        await window.dshDesktop.submitApiKey(key);
        location.href = 'loading.html';
      } catch (e) {
        err.textContent = '保存失败：' + e.message;
      }
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') btn.onclick(); };
  </script>
</body>
</html>
```

- [ ] **Step 5: 写 error.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'">
  <title>启动失败</title>
  <link rel="stylesheet" href="theme.css">
</head>
<body>
  <div class="card">
    <h1>启动失败</h1>
    <p class="stage" id="msg"></p>
    <p class="err" id="detail"></p>
    <button id="retry">重试</button>
  </div>
  <script>
    const q = new URLSearchParams(location.search);
    document.getElementById('msg').textContent = q.get('m') || '未知错误';
    document.getElementById('detail').textContent = q.get('d') || '';
    document.getElementById('retry').onclick = () => window.dshDesktop.retry();
  </script>
</body>
</html>
```

- [ ] **Step 6: 验证静态页面**

用浏览器直接打开 `renderer/loading.html` 会报 `dshDesktop is not defined`（无 preload），属预期；Task 8 集成后统一验收。

- [ ] **Step 7: Commit**

```bash
git add main/preload.js renderer/
git commit -m "feat: 渲染层页面与 preload 桥"
```

---

### Task 8: 主进程集成 main.js

**Files:**
- Create: `main/main.js`
- Modify: `package.json`（scripts.start 已有）

**Interfaces:**
- Consumes: 全部模块（paths、port-probe、server-manager、bootstrap、update-manager、preload）
- Produces: 可运行的桌面应用（`npm start`）

- [ ] **Step 1: 实现 main.js**

```js
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const paths = require('./paths');
const { decidePort } = require('./port-probe');
const { spawnDsh, waitReady, killTree } = require('./server-manager');
const { ensureProfile, readApiKey, writeApiKey } = require('./bootstrap');
const {
  getLatestVersion, isNewer, resolveDshEntry, downloadTarball, extractTarball,
} = require('./update-manager');

const DSH_VERSION = '0.1.0-rc.6'; // 捆绑基线版本，与 vendor-src 一致

let mainWindow = null;
let serverChild = null;
let currentPort = 3080;
let booting = false;
let lastDshEntry = null;

function entryFor(projectRoot) {
  // 打包后基线位于 resources/dsh；开发模式位于项目 node_modules
  const baseline = app.isPackaged
    ? path.join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : paths.baselineDshEntry(projectRoot);
  const vendor = paths.vendorDshEntry();
  return resolveDshEntry({ vendorEntry: vendor, baselineEntry: baseline });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function stage(stage, detail) {
  send('app:stage', { stage, detail });
}

function fatal(message, detail) {
  send('app:fatal', { message, detail });
}

async function startDsh(projectRoot, { forcePort } = {}) {
  stage('port', '检查端口…');
  const decision = await decidePort(forcePort || 3080);
  currentPort = decision.port;
  if (decision.mode === 'connect') {
    stage('connect', `发现已有服务 (端口 ${currentPort})，直接连接…`);
    await loadGui(currentPort);
    return;
  }

  const dshHome = paths.dshHome();
  stage('init', '检查首次运行配置…');
  const created = await ensureProfile(dshHome);
  if (created) stage('init', '已初始化 profile 骨架');

  const apiKey = await readApiKey(dshHome);
  if (!apiKey) {
    loadSetupPage();
    return;
  }

  stage('vendor', '解析 dsh 版本…');
  lastDshEntry = entryFor(projectRoot);
  stage('start', `启动 dsh 服务 (端口 ${currentPort})…`);
  serverChild = spawnDsh({
    entry: lastDshEntry, port: currentPort, dshHome,
    projectRoot, execPath: process.execPath,
  });
  serverChild.on('exit', (code) => {
    if (booting || !mainWindow || mainWindow.isDestroyed()) return;
    fatal('dsh 服务已退出', `退出码 ${code}，请点击重试`);
  });
  const ready = await waitReady(currentPort, 30000);
  if (!ready) {
    fatal('服务启动超时', '30 秒内未就绪，请点击重试');
    return;
  }
  await loadGui(currentPort);
}

async function loadGui(port) {
  stage('gui', '加载界面…');
  const win = mainWindow;
  await win.loadURL(`http://127.0.0.1:${port}/`);
  win.setTitle(`DeepSeek Harness Desktop — 端口 ${port}`);
}

function loadSetupPage() {
  const win = mainWindow;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
}

async function boot() {
  if (booting) return;
  booting = true;
  try {
    const projectRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
    await startDsh(projectRoot);
    // 异步更新检查：不阻塞启动
    checkForUpdates().catch(() => {});
  } catch (e) {
    fatal('启动失败', String(e && e.stack || e));
  } finally {
    booting = false;
  }
}

async function checkForUpdates() {
  try {
    const remote = await getLatestVersion();
    if (!isNewer(remote, DSH_VERSION)) return;
    stage('update', `发现新版本 dsh ${remote}，后台更新中…`);
    const vendorRoot = paths.vendorDir();
    const tgz = path.join(paths.dshHome(), 'vendor', `dsh-${remote}.tgz`);
    await downloadTarball(remote, tgz);
    await extractTarball(tgz, vendorRoot);
    stage('update', `dsh ${remote} 已就绪，下次启动生效`);
  } catch {
    // 静默失败，继续用现有版本
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'loading.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    fatal('页面加载失败', `${code}: ${desc}`);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    createWindow();
    ipcMain.handle('setup:submit', async (_e, key) => {
      await writeApiKey(paths.dshHome(), key);
      boot();
    });
    ipcMain.handle('version:info', () => ({
      dshVersion: DSH_VERSION,
      appVersion: app.getVersion(),
    }));
    ipcMain.handle('app:retry', () => boot());
    boot();
  });

  app.on('before-quit', async (e) => {
    if (serverChild) {
      e.preventDefault();
      await killTree(serverChild);
      serverChild = null;
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
```

- [ ] **Step 2: 准备开发期 dsh 捆绑（临时验证用）**

```powershell
npm install @deepseek-ai/dsh@0.1.0-rc.6 --no-save
```

预期：项目 node_modules 出现 `@deepseek-ai/dsh`（Task 9 将改为 vendor-src 独立目录；这里先让 `npm start` 可跑）。

- [ ] **Step 3: 开发模式冒烟验证**

```powershell
npm start
```

手动验收：
- 窗口先显示 loading 页（"检查端口…"）
- 无密钥 → 跳转 setup 页
- 填一个假密钥 `sk-test-000` → 保存 → 进入启动流程 → 若 dsh 真实启动成功则加载 GUI；若服务报错则 error 页显示日志
- 关闭窗口 → 进程退出（`Get-Process electron` 无残留）

> 注：假密钥会导致 dsh 启动后 API 调用失败，但服务本身应能起、GUI 能加载。若 dsh 服务启动报错，阅读 `%USERPROFILE%\.dsh\logs\server.log` 定位（常见原因：ABI 不匹配的原生模块——见 Task 9 Step 3 的 electron-rebuild 处理）。

- [ ] **Step 4: 清理验证遗留**

```powershell
Remove-Item "%USERPROFILE%\.dsh\.credentials.yaml" -ErrorAction SilentlyContinue
```

> 仅删除测试写入的密钥文件；真实使用中由用户通过向导配置。

- [ ] **Step 5: Commit**

```bash
git add main/main.js
git commit -m "feat: 主进程集成 main"
```

---

### Task 9: 捆绑脚本与安装包

**Files:**
- Create: `scripts/prepare-bundle.js`
- Create: `electron-builder.yml`
- Modify: `.gitignore`（追加 vendor-src/dsh、vendor-src/tools）

**Interfaces:**
- Consumes: 前序全部
- Produces: `dist/DeepSeek Harness Desktop Setup 0.1.0.exe`（NSIS 安装包）

- [ ] **Step 1: 写 scripts/prepare-bundle.js**

```js
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
```

- [ ] **Step 2: 写 electron-builder.yml**

```yaml
appId: com.dshdesktop.app
productName: DeepSeek Harness Desktop
directories:
  output: dist
files:
  - main/**
  - renderer/**
  - package.json
extraResources:
  - from: vendor-src/dsh
    to: dsh
  - from: vendor-src/tools
    to: tools
win:
  target:
    - nsis
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  shortcutName: DeepSeek Harness Desktop
  deleteAppDataOnUninstall: false
```

- [ ] **Step 3: 执行捆绑并处理原生模块 ABI**

```powershell
node scripts/prepare-bundle.js
npx @electron/rebuild -f -m vendor-src/dsh
```

> `@electron/rebuild` 把 vendor-src/dsh/node_modules 中原生模块（node-pty 等，若有）重编译为 Electron ABI——因为 ELECTRON_RUN_AS_NODE 用的正是 Electron 内置 Node。若 rebuild 报告无原生模块，跳过即可。

- [ ] **Step 4: 验证捆绑后的 dsh 可被 Electron 的 Node 运行**

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& node_modules\.bin\electron.cmd vendor-src\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --port 32099 --help
```

预期：打印 web app 帮助（与 Task 1 前验证一致），无 ABI 报错。

- [ ] **Step 5: 打包**

```powershell
npm run dist
```

预期：`dist/DeepSeek Harness Desktop Setup 0.1.0.exe` 生成。

- [ ] **Step 6: 安装并执行手动验收清单**

安装 `dist/*.exe`（选择"为当前用户安装"），运行「DeepSeek Harness Desktop」，逐项验收：

1. 全新环境模拟：`Rename-Item %USERPROFILE%\.dsh .dsh.bak`（备份后执行）→ 启动应用 → 出现 setup 向导 → 填入真实 API Key → 保存 → GUI 加载成功 → 关窗进程无残留 → 恢复 `Rename-Item %USERPROFILE%\.dsh.bak .dsh`
2. 密钥已配置：直接启动 → loading → GUI
3. CLI 实例共存：先 `dsh web` 起服务 → 启动桌面版 → 显示"发现已有服务，直接连接"，同一会话可见
4. 端口被占：起一个占 3080 的假 HTTP 服务 → 启动桌面版 → 自动换端口成功加载
5. 退出清理：启动后关闭窗口 → `Get-Process | Where-Object {$_.ProcessName -like '*dsh*'}` 无残留
6. 服务崩溃恢复：启动后手动结束 dsh 子进程 → error 页出现 → 点重试恢复
7. 卸载：控制面板卸载 → `%USERPROFILE%\.dsh` 仍保留
8. 双开：应用运行中再次双击 → 聚焦已有窗口

- [ ] **Step 7: Commit**

```bash
git add scripts/prepare-bundle.js electron-builder.yml .gitignore
git commit -m "feat: 捆绑脚本与 electron-builder 打包配置"
```

---

### Task 10: vendor 更新安装依赖（捆绑 npm 集成）

**Files:**
- Modify: `main/update-manager.js`
- Test: `test/update-manager.test.js`（追加）

**Interfaces:**
- Consumes: `paths.js`（vendorDir）
- Produces:
  - `installVendorDeps(vendorDir, npmCliPath, execPath)` → `Promise<void>`：以 `ELECTRON_RUN_AS_NODE` 运行 `execPath npmCliPath install --omit=dev --no-audit --no-fund --prefix <vendorDir>`；失败抛错
  - `performUpdate(version, { vendorDir, npmCliPath, execPath })` → `Promise<boolean>`：下载 tarball → 解压到 vendorDir → 安装依赖；成功 true

- [ ] **Step 1: 追加失败测试**

```js
test('installVendorDeps 调用 npm-cli 安装', async () => {
  const { installVendorDeps } = require('../main/update-manager');
  const vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vendor-'));
  // 用 node 直接跑 npm-cli 在临时目录初始化一个空安装
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) return; // 系统 node 无捆绑 npm 时跳过
  await installVendorDeps(vendor, npmCli, process.execPath);
  assert.ok(fs.existsSync(path.join(vendor, 'node_modules')));
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
node --test test/update-manager.test.js
```

预期：新测试 FAIL，`installVendorDeps is not a function`。

- [ ] **Step 3: 实现 installVendorDeps 与 performUpdate**

在 `main/update-manager.js` 末尾追加：

```js
const { spawn } = require('node:child_process');

function installVendorDeps(vendorDir, npmCliPath, execPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, [
      npmCliPath, 'install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', vendorDir,
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`依赖安装失败 (${code}): ${err.slice(-500)}`));
    });
    child.on('error', reject);
  });
}

async function performUpdate(version, { vendorDir, npmCliPath, execPath }) {
  const tgz = path.join(path.dirname(vendorDir), `dsh-${version}.tgz`);
  await downloadTarball(version, tgz);
  await extractTarball(tgz, vendorDir);
  await installVendorDeps(vendorDir, npmCliPath, execPath);
  return true;
}
```

并在 `module.exports` 追加 `installVendorDeps, performUpdate`。

- [ ] **Step 4: 运行测试确认通过**

```powershell
node --test test/update-manager.test.js
```

预期：全部 PASS（新测试在无捆绑 npm 时跳过）。

- [ ] **Step 5: 修改 main.js 接入 performUpdate**

替换 `checkForUpdates` 中的下载+解压两行为：

```js
    stage('update', `发现新版本 dsh ${remote}，后台更新中…`);
    const vendorRoot = paths.vendorDir();
    const npmCli = app.isPackaged
      ? path.join(process.resourcesPath, 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(__dirname, '..', 'vendor-src', 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await performUpdate(remote, { vendorDir: vendorRoot, npmCliPath: npmCli, execPath: process.execPath });
    stage('update', `dsh ${remote} 已就绪，下次启动生效`);
```

并更新 import 行加入 `performUpdate`。

- [ ] **Step 6: 回归测试 + 重新打包**

```powershell
node --test test/
npm run dist
```

预期：全部测试 PASS；安装包重新生成。

- [ ] **Step 7: Commit**

```bash
git add main/update-manager.js main/main.js test/update-manager.test.js
git commit -m "feat: vendor 更新安装依赖与 performUpdate 集成"
```

---

### Task 11: 坏版本回退与收尾

**Files:**
- Modify: `main/main.js`

**Interfaces:**
- Produces: vendor 版本启动失败时自动回退基线的逻辑

- [ ] **Step 1: 修改 startDsh 加入回退**

将 `startDsh` 中启动段替换为：

```js
  stage('vendor', '解析 dsh 版本…');
  const tryEntry = async (entry) => {
    serverChild = spawnDsh({
      entry, port: currentPort, dshHome,
      projectRoot, execPath: process.execPath,
    });
    const ready = await waitReady(currentPort, 20000);
    if (ready) return true;
    await killTree(serverChild);
    serverChild = null;
    return false;
  };

  const vendorEntry = paths.vendorDshEntry();
  const baselineEntry = entryFor(projectRoot);
  const useVendor = vendorEntry && fs.existsSync(vendorEntry) && fs.existsSync(path.join(paths.vendorDir(), 'node_modules'));
  let ok = false;
  if (useVendor) {
    stage('start', `启动 dsh (vendor, 端口 ${currentPort})…`);
    ok = await tryEntry(vendorEntry);
    if (!ok) {
      stage('start', 'vendor 版本启动失败，回退基线…');
      ok = await tryEntry(baselineEntry);
    }
  } else {
    stage('start', `启动 dsh (基线, 端口 ${currentPort})…`);
    ok = await tryEntry(baselineEntry);
  }
  if (!ok) {
    fatal('服务启动失败', '请查看日志后重试');
    return;
  }
  await loadGui(currentPort);
```

同时删除原 `lastDshEntry` 相关赋值（不再需要）。

- [ ] **Step 2: 回归验证**

```powershell
node --test test/
npm start
```

预期：测试全 PASS；应用正常启动。

- [ ] **Step 3: 重新打包最终安装包**

```powershell
npm run dist
```

- [ ] **Step 4: 执行 Task 9 Step 6 完整手动验收清单**

- [ ] **Step 5: 更新 README**

创建 `README.md`，内容：项目简介、开发运行（`npm start`）、测试（`npm test`）、打包（`npm run dist`）、验收清单引用、设计文档与计划链接。

- [ ] **Step 6: Commit**

```bash
git add main/main.js README.md
git commit -m "feat: vendor 坏版本回退与 README"
```
