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
  // 桌面壳内嵌 GUI，禁止 dsh 额外打开系统浏览器；
  // dsh 的 HMR 服务要求 node 以 --expose-internals 启动（flag 必须在 entry 之前）
  const args = ['--expose-internals', entry, '--profile', 'web', '--port', String(port), '--no-open'];
  const child = spawn(execPath, args, {
    env,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.on('exit', () => { try { fs.closeSync(out); } catch {} });
  child.on('error', (err) => {
    try { fs.closeSync(out); } catch {}
    child.emit('spawn-error', err); // 通知上层；无监听时静默
  });
  return child;
}

function waitReady(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        if (await probePort(port, 1000)) return resolve(true);
      } catch {
        // 探测异常按未就绪处理
      }
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
