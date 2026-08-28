'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hostLock = require('../main/host-lock');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-lock-'));
}

/** 一个已经退出的进程 pid（确定死亡）。 */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid;
}

test('acquire 成功写入锁文件（含 pid/port）', () => {
  const home = tmpHome();
  const got = hostLock.acquire(home, { pid: process.pid, port: 3123 });
  assert.strictEqual(got.ok, true);
  const holder = hostLock.readLock(home);
  assert.strictEqual(holder.pid, process.pid);
  assert.strictEqual(holder.port, 3123);
});

test('pid 存活时二次 acquire 拒绝（不覆盖）', () => {
  const home = tmpHome();
  assert.strictEqual(hostLock.acquire(home, { pid: process.pid }).ok, true);
  const second = hostLock.acquire(home, { pid: process.pid + 1 });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.holder.pid, process.pid);
  // 原锁未被覆盖
  assert.strictEqual(hostLock.readLock(home).pid, process.pid);
});

test('release 仅由锁持有者执行', () => {
  const home = tmpHome();
  hostLock.acquire(home, { pid: process.pid });
  hostLock.release(home, process.pid + 1); // 非持有者：无效
  assert.notStrictEqual(hostLock.readLock(home), null);
  hostLock.release(home, process.pid);
  assert.strictEqual(hostLock.readLock(home), null);
});

test('陈旧锁（pid 已死）自动接管', () => {
  const home = tmpHome();
  const old = deadPid();
  fs.writeFileSync(hostLock.lockPath(home), JSON.stringify({ pid: old, port: 3333 }));
  assert.strictEqual(hostLock.isAlivePid(old), false, '死 pid 不应被判定存活');
  const got = hostLock.acquire(home, { pid: process.pid, port: 3081 });
  assert.strictEqual(got.ok, true);
  assert.strictEqual(hostLock.readLock(home).pid, process.pid);
  assert.strictEqual(hostLock.readLock(home).port, 3081);
});

test('锁文件不存在时 release 是 no-op', () => {
  const home = tmpHome();
  assert.doesNotThrow(() => hostLock.release(home, process.pid));
  assert.strictEqual(hostLock.readLock(home), null);
});

test('isAlivePid 判定', () => {
  assert.strictEqual(hostLock.isAlivePid(process.pid), true);
  assert.strictEqual(hostLock.isAlivePid(deadPid()), false);
  assert.strictEqual(hostLock.isAlivePid(NaN), false);
  assert.strictEqual(hostLock.isAlivePid(-1), false);
  assert.strictEqual(hostLock.isAlivePid(0), false);
});
