'use strict';
// dsh 单写者主机锁：~/.dsh/dsh-host.lock
//
// 背景：dsh 的单写者模型只在进程内生效（协调器按 id 串行化、cursor 校验、live 检查），
// 跨进程没有任何锁。两个 dsh 宿主进程同时写同一会话根会产生 seq 重复，造成
// "corrupt session log: seq gap in committed region"（历史加载失败）。
//
// 本锁由 Studio 在"own 模式"拉起 dsh 子进程时使用，锁主体记录 dsh 子进程 pid：
//  - 获取：排他创建；已存在时检查 pid 存活——活着说明确有另一宿主，拒绝；
//    已死则接管（先改名保存旧锁再创建）。
//  - 释放：仅当锁仍记录我们的 pid 时删除（不误删他人刚写入的锁）。
//  - Studio 崩溃后：锁里留下 dsh 孤儿进程 pid（仍存活）→ 下次启动会被正确识别为
//    "已有活跃宿主"，从而走连接而非另起实例（这正是修复双写问题的关键路径）。
//
// 注意：这不是 dsh 官方的锁（CLI/非 Studio 启动的 dsh 不遵守），它保证的是
// "Studio 不再制造第二个写入者"，对第三方宿主只做探测与提示。

const fs = require('node:fs');
const path = require('node:path');

const LOCK_NAME = 'dsh-host.lock';

function lockPath(dshHome) {
  return path.join(dshHome, LOCK_NAME);
}

/** pid 是否存活（EPERM 表示存在但无权限 → 也视为存活）。 */
function isAlivePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readLock(dshHome) {
  try {
    const raw = fs.readFileSync(lockPath(dshHome), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 尝试获取主机锁。
 * @param dshHome ~/.dsh
 * @param info { pid, port?, entry?, startedAt? }——pid 应为负责写入的 dsh 进程
 * @returns {ok:true} | {ok:false, holder}
 */
function acquire(dshHome, info) {
  fs.mkdirSync(dshHome, { recursive: true });
  const payload = JSON.stringify({
    ...info,
    pid: info.pid ?? process.pid,
    startedAt: info.startedAt ?? Date.now(),
  });
  const tryCreate = () => {
    const fd = fs.openSync(lockPath(dshHome), 'wx');
    try {
      fs.writeFileSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    tryCreate();
    return { ok: true };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const holder = readLock(dshHome);
  if (holder !== null && holder.pid !== undefined && isAlivePid(holder.pid)) {
    return { ok: false, holder };
  }
  // 陈旧锁（pid 已死或不可读）：接管——改名保存旧锁，再排他创建；
  // 若其间被他人抢建，重走一次完整判定。
  try {
    fs.renameSync(lockPath(dshHome), `${lockPath(dshHome)}.stale-${Date.now()}`);
  } catch {
    // 旧锁刚被他人清理：落空则继续尝试创建
  }
  try {
    tryCreate();
    return { ok: true };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return acquire(dshHome, info);
  }
}

/** 仅当锁仍由 `pid` 持有才删除（避免误删他人锁）。 */
function release(dshHome, pid = process.pid) {
  const holder = readLock(dshHome);
  if (holder !== null && holder.pid === pid) {
    try {
      fs.unlinkSync(lockPath(dshHome));
    } catch {
      // 已被清理/不存在：忽略
    }
  }
}

module.exports = { LOCK_NAME, lockPath, acquire, release, readLock, isAlivePid };
