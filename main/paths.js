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
  return path.join(vendorDir(), 'lib', 'bin.js');
}

function baselineDshEntry(projectRoot) {
  return path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function logsDir() {
  return path.join(dshHome(), 'logs');
}

module.exports = { dshHome, vendorDir, vendorDshEntry, baselineDshEntry, logsDir };
