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
