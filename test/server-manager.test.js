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
const FAKE_DSH = path.join(os.tmpdir(), 'dsh-desktop-test-fake-server.js');
// spawnDsh 以 `entry --profile web --port <port>` 方式调用，端口在 argv 的 --port 之后
fs.writeFileSync(FAKE_DSH, `
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => { res.writeHead(200); res.end('ok'); })
  .listen(port, '127.0.0.1');
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
