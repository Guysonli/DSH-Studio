'use strict';
// 会话日志体检与修复工具。
//
// 背景：多实例并发写入同一会话会产生 seq 重复行（dsh 只有进程内单写者保护），
// 导致 "corrupt session log: seq gap in committed region"（历史加载失败）。
//
// 与旧版相比的改进：
//  - 结构化帧扫描（不再按 magic 字节切帧，避免误切）；
//  - packed chunk 行（text-chunks / reasoning-chunks / tool-call-chunks）正确展开为事件；
//  - 修复策略：seq 冲突时优先删除恢复实例写入的 session/end-seed 合成行（保留真实事件行），
//    其余重复行保留首次出现；
//  - 只重写受影响的帧，其余帧字节不变；行删空后移除该帧；
//  - 原子写（临时文件 + rename），写之前自动备份；
//  - 修复后自动自检（重新解码 + 连续性断言 + 非删除行逐字节校验）。
//
// 用法：
//   node scripts/repair-session.js <会话目录>            # dry-run：体检 + 预览修复方案
//   node scripts/repair-session.js <会话目录> --apply    # 执行修复（先自动备份）
//   node scripts/repair-session.js --scan <sessions根>   # 只体检：扫描全部会话并报告健康状态
//
// 注意：仅当该会话没有其他实例活跃写入时才能执行修复，否则修复结果会被覆盖。
// 修复后需重启 dsh（或让其重建派生索引）。

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./repair-lib');

const isScan = process.argv.includes('--scan');
const argDir = isScan ? process.argv[3] : process.argv[2];
const apply = process.argv.includes('--apply');
const scanRoot = isScan ? argDir : null;

function bail(msg) {
  console.error(msg);
  process.exit(1);
}

function usage() {
  console.log('用法: node scripts/repair-session.js <会话目录> [--apply]  |  node scripts/repair-session.js --scan <sessions根>');
  process.exit(1);
}

/** 递归收集所有 session.jsonl.zstd。 */
function collectLogs(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === 'session.jsonl.zstd') out.push(p);
    }
  };
  walk(root);
  return out;
}

function inspectFile(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { file, error: `读取失败: ${e.message}` };
  }
  let decoded;
  try {
    decoded = lib.decodeArtifact(buf);
  } catch (e) {
    return { file, error: `解码失败: ${e.message}` };
  }
  const analysis = lib.analyze(decoded.records);
  return { file, buf, decoded, analysis, error: null };
}

function reportOne(result) {
  if (result.error) {
    console.log(`BAD   ${result.file}`);
    console.log(`      ${result.error}`);
    return false;
  }
  const { analysis, decoded } = result;
  if (analysis.healthy) {
    console.log(`OK    ${result.file}  帧=${decoded.frames.length} 事件=${analysis.expected}`);
    return true;
  }
  console.log(`BAD   ${result.file}`);
  const r = decoded.records[analysis.recordIdx];
  console.log(`      第 ${r.lineNo + 1} 行 ${analysis.kind === 'duplicate' ? 'seq 重复' : analysis.kind === 'gap' ? 'seq 缺失' : '无法解析'}：期望 ${analysis.expected}，实际 ${analysis.got}（行内容 ${JSON.stringify(r.text.slice(0, 120))}）`);
  return false;
}

if (scanRoot) {
  if (!fs.existsSync(scanRoot)) bail(`sessions 根目录不存在: ${scanRoot}`);
  const logs = collectLogs(scanRoot);
  if (logs.length === 0) {
    console.log('未找到任何会话日志。');
    process.exit(0);
  }
  console.log(`体检 ${logs.length} 个会话日志 …`);
  let bad = 0;
  for (const file of logs) if (!reportOne(inspectFile(file))) bad++;
  console.log(bad === 0 ? '\n全部健康 ✔' : `\n发现 ${bad} 个异常会话。`);
  process.exit(bad === 0 ? 0 : 1);
}

// ---- 单会话模式 ----
if (!argDir || !fs.existsSync(argDir)) usage();
const src = path.join(argDir, 'session.jsonl.zstd');
if (!fs.existsSync(src)) bail(`未找到会话文件: ${src}`);

const result = inspectFile(src);
if (result.error) bail(result.error);
if (result.analysis.healthy) {
  console.log(`会话健康 ✔  帧=${result.decoded.frames.length} 事件=${result.analysis.expected}`);
  console.log('无需修复。');
  process.exit(0);
}

const plan = lib.plan(result.decoded.records);
if (!plan.fixable) bail(`无法自动修复：${plan.reason}`);

console.log(`会话损坏：帧=${result.decoded.frames.length}，共 ${result.decoded.records.length} 行。`);
for (const reason of plan.reasons) console.log(`  修复方案：${reason}`);
console.log(`  将删除 ${plan.dropRecordIdx.length} 行。`);

if (!apply) {
  console.log('\n(dry-run) 未做修改。确认后加 --apply 执行；执行前自动备份原文件。');
  console.log('提醒：请先确保该会话没有其他实例在活跃写入，修复后重启 dsh。');
  process.exit(0);
}

// ---- 备份 + 原子修复 + 自检 ----
const bak = `${src}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(src, bak);
console.log(`已备份原文件: ${bak}`);

const repaired = lib.encodeRepair(result.buf, result.decoded.frames, result.decoded.records, plan.dropRecordIdx);
const check = lib.verifyRepair(repaired, result.decoded.records, plan.dropRecordIdx);
if (!check.ok) bail(`自检未通过，未写回：${check.reason}（备份在 ${bak}）`);

const tmp = `${src}.repair.tmp`;
fs.writeFileSync(tmp, repaired);
fs.renameSync(tmp, src);
console.log(`修复完成并已自检通过 ✔  事件 ${check.totalEvents}（删除 ${check.droppedEvents} 个）`);
console.log(`文件 ${src}（${repaired.length} 字节，原 ${result.buf.length} 字节）`);
console.log('提示：会话搜索索引为可弃用派生模型，重启 dsh 会自动重建。');
