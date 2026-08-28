'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const lib = require('../scripts/repair-lib');

// ---- 夹具构造 ----
function ev(type, seq, extra = {}) {
  return { type, seq, time: 1700000000000 + seq, data: extra, ...(type === 'user/message' ? { surfaceOp: 'append' } : {}) };
}

function packedRow(seq0, texts, turn = 1, step = 1, index = 0) {
  return {
    type: 'text-chunks',
    seq0,
    time0: 1700000000000 + seq0,
    data: { turn, step, index, dt: texts.slice(1).map(() => 1), texts },
  };
}

function headerLine(id) {
  return JSON.stringify({ type: 'session', version: 0, id, createdAt: Date.now(), cwd: process.cwd(), delegationDepth: 0, agentPreset: 'standard' });
}

/** 构造一个损坏夹具：按 linesPerFrame 把全部行切成独立 zstd 帧（带校验和）。 */
function buildLog(id, rows, linesPerFrame = 3) {
  const all = [headerLine(id), ...rows.map((r) => JSON.stringify(r))];
  const chunks = [];
  for (let i = 0; i < all.length; i += linesPerFrame) {
    chunks.push(Buffer.from(all.slice(i, i + linesPerFrame).join('\n') + '\n', 'utf8'));
  }
  return Buffer.concat(chunks.map((c) => zlib.zstdCompressSync(c, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })));
}

/** 读取修复产物的行文本（跳过头部行）。 */
function rowTexts(bytes) {
  const decoded = lib.decodeArtifact(bytes);
  return decoded.records.filter((r) => r.lineNo !== 0).map((r) => r.text);
}

test('事故形态：end-seed 与后一行 seq 冲突 → 删 end-seed，保留真实事件行', () => {
  const rows = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1),
    ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ev('session/end-seed', 3),
    ev('agent/inbox/spliced', 3, { target: 'next-turn', start: 0, inserted: [] }),
    ev('turn/start', 4, { turn: 2 }),
    ev('user/message', 5),
    ev('turn/end', 6, { turn: 2, reason: { kind: 'completed' } }),
    ev('session/end-seed', 7),
  ];
  const buf = buildLog('session-a', rows);
  const decoded = lib.decodeArtifact(buf);
  const analysis = lib.analyze(decoded.records);
  assert.strictEqual(analysis.healthy, false);
  assert.strictEqual(analysis.kind, 'duplicate');

  const plan = lib.plan(decoded.records);
  assert.strictEqual(plan.fixable, true);
  assert.deepStrictEqual(plan.dropRecordIdx, [4]); // end-seed 行（下标含头部行）
  const reason = plan.reasons.join('\n');
  assert.match(reason, /session\/end-seed/);

  const repaired = lib.encodeRepair(buf, decoded.frames, decoded.records, plan.dropRecordIdx);
  const check = lib.verifyRepair(repaired, decoded.records, plan.dropRecordIdx);
  assert.strictEqual(check.ok, true, check.reason);
  assert.strictEqual(check.totalEvents, 8); // 0..7 连续，end-seed 之后的 inbox#3 补位
  const kept = rowTexts(repaired);
  assert.strictEqual(kept.length, 8);
  assert.ok(kept.some((t) => t.includes('agent/inbox/spliced')), '真实 inbox 事件必须保留');
  const endSeeds = kept.filter((t) => t.includes('session/end-seed'));
  assert.strictEqual(endSeeds.length, 1, '仅保留日志末尾合法的 end-seed');
  assert.ok(endSeeds[0].includes('"seq":7'), '保留的应是末尾 end-seed#7');
});

test('普通重复行（无 end-seed 上下文）→ 保留首次出现，删除重复', () => {
  const rows = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1),
    ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 2, { turn: 1 }), // 重复
    ev('user/message', 3),
    ev('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ];
  const buf = buildLog('session-b', rows);
  const decoded = lib.decodeArtifact(buf);
  const plan = lib.plan(decoded.records);
  assert.strictEqual(plan.fixable, true);
  assert.deepStrictEqual(plan.dropRecordIdx, [4]); // 第二个 turn/start#2
  const repaired = lib.encodeRepair(buf, decoded.frames, decoded.records, plan.dropRecordIdx);
  const check = lib.verifyRepair(repaired, decoded.records, plan.dropRecordIdx);
  assert.strictEqual(check.ok, true, check.reason);
  assert.strictEqual(check.totalEvents, 5);
});

test('整段批量重复（双写一个批次）→ 删除全部重复行，其余不动', () => {
  const rows = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1),
    ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    // 重复批量：某实例把 0..2 又写了一遍
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1),
    ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 3, { turn: 2 }),
    ev('turn/end', 4, { turn: 2, reason: { kind: 'completed' } }),
  ];
  const buf = buildLog('session-c', rows, 2);
  const decoded = lib.decodeArtifact(buf);
  const plan = lib.plan(decoded.records);
  assert.strictEqual(plan.fixable, true);
  assert.deepStrictEqual(plan.dropRecordIdx, [4, 5, 6]);
  const repaired = lib.encodeRepair(buf, decoded.frames, decoded.records, plan.dropRecordIdx);
  const check = lib.verifyRepair(repaired, decoded.records, plan.dropRecordIdx);
  assert.strictEqual(check.ok, true, check.reason);
  assert.strictEqual(check.totalEvents, 5);
});

test('packed chunk 行按成员展开并计入 seq 连续性', () => {
  const rows = [
    packedRow(0, ['a', 'b', 'c']), // 3 个 assistant/chunk → seq 0..2
    ev('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 3, { turn: 1 }), // 重复 seq 3
    ev('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ];
  const buf = buildLog('session-d', rows);
  const decoded = lib.decodeArtifact(buf);
  const analysis = lib.analyze(decoded.records);
  assert.strictEqual(analysis.healthy, false);
  assert.strictEqual(analysis.kind, 'duplicate');
  const plan = lib.plan(decoded.records);
  assert.strictEqual(plan.fixable, true);
  const repaired = lib.encodeRepair(buf, decoded.frames, decoded.records, plan.dropRecordIdx);
  const check = lib.verifyRepair(repaired, decoded.records, plan.dropRecordIdx);
  assert.strictEqual(check.ok, true, check.reason);
  assert.strictEqual(check.totalEvents, 5);
});

test('seq 缺失（gap）→ 拒绝自动修复', () => {
  const rows = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1),
    ev('turn/start', 3, { turn: 1 }), // seq 2 缺失
    ev('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ];
  const buf = buildLog('session-e', rows);
  const decoded = lib.decodeArtifact(buf);
  const plan = lib.plan(decoded.records);
  assert.strictEqual(plan.fixable, false);
  assert.match(plan.reason, /seq 缺失/);
});

test('健康日志：分析通过，plan 无删除', () => {
  const rows = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1),
    ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ];
  const buf = buildLog('session-f', rows);
  const decoded = lib.decodeArtifact(buf);
  const analysis = lib.analyze(decoded.records);
  assert.strictEqual(analysis.healthy, true);
  assert.strictEqual(analysis.expected, 3);
  const plan = lib.plan(decoded.records);
  assert.strictEqual(plan.fixable, true);
  assert.deepStrictEqual(plan.dropRecordIdx, []);
});

test('torn 尾帧：拒绝修改，交由 dsh 启动自愈', () => {
  const rows = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1),
  ];
  const buf = buildLog('session-g', rows, 2);
  const torn = buf.subarray(0, buf.length - 5); // 截掉尾帧一部分
  assert.throws(() => lib.decodeArtifact(torn), /不完整帧/);
});

test('全流程 CLI 语义：修复产物可被再次 decode 且帧为合法拼接', () => {
  const rows = [
    ev('turn/start', 0, { turn: 1 }),
    ev('session/end-seed', 1),
    ev('agent/inbox/spliced', 1, { target: 'next-turn', start: 0, inserted: [] }),
    ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ];
  const buf = buildLog('session-h', rows, 1);
  const decoded = lib.decodeArtifact(buf);
  const plan = lib.plan(decoded.records);
  const repaired = lib.encodeRepair(buf, decoded.frames, decoded.records, plan.dropRecordIdx);
  // 帧结构可重新解析（结构化扫描，不依赖 magic 搜索）
  const frames = lib.scanFrames(repaired).frames;
  assert.ok(frames.length >= 1);
  const reparsed = lib.decodeArtifact(repaired);
  assert.strictEqual(lib.analyze(reparsed.records).healthy, true);
});
