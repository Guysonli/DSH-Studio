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
