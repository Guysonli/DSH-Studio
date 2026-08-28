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
    const tryListen = (port) => {
      const srv = net.createServer();
      srv.once('error', (err) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          tryListen(port + 1);
        } else {
          reject(err);
        }
      });
      srv.listen(port, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    };
    tryListen(startPort);
  });
}

/**
 * 决策启动端口。
 * @param {number} startPort - 首选端口（通常 3080）
 * @param {{allowConnect?: boolean}} [options] - allowConnect=true 时（默认）
 *   已有可响应 HTTP 的服务 → 直接连接；false 时（新启独立实例）被占即换空闲端口。
 */
async function decidePort(startPort, { allowConnect = true } = {}) {
  if (allowConnect && await probePort(startPort, 2000)) return { mode: 'connect', port: startPort };
  // 端口被占（TCP 可达但 HTTP 无响应）→ 重试 5 秒（连接模式下期待服务恢复）
  if (await tcpReachable(startPort)) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (allowConnect && await probePort(startPort, 1000)) return { mode: 'connect', port: startPort };
    }
    const free = await findFreePort(startPort + 1);
    return { mode: 'start', port: free };
  }
  return { mode: 'start', port: startPort };
}

module.exports = { probePort, tcpReachable, findFreePort, decidePort };
