'use strict';
// 会话日志修复工具：多实例并发写入同一会话会产生 seq 重复行
// （dsh 单写者模型），导致 "corrupt session log: seq gap in committed region"。
// 存储格式：多个独立 zstd 帧物理拼接，每帧若干 JSONL 行。
// 修复 = 逐帧解压 → 全部行按 seq 单调校验 → 删除重复 seq 行（保留首次出现）→ 重新成帧写回。
//
// 用法：
//   node scripts/repair-session.js <sessionDir>          # dry-run 预览
//   node scripts/repair-session.js <sessionDir> --apply  # 执行（先自动备份原文件）
//
// 注意：仅当该会话没有其他实例活跃写入时才能执行（否则修复会被覆盖）。

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const dir = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node scripts/repair-session.js <会话目录> [--apply]');
  process.exit(1);
}

const src = path.join(dir, 'session.jsonl.zstd');
if (!fs.existsSync(src)) {
  console.error(`未找到会话文件: ${src}`);
  process.exit(1);
}

// zstd 帧 magic: 0x28 B5 2F FD
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
const buf = fs.readFileSync(src);

// 按 magic 切帧
function splitFrames(data) {
  const frames = [];
  let start = -1;
  for (let i = 0; i + 4 <= data.length; i++) {
    if (data[i] === MAGIC[0] && data[i + 1] === MAGIC[1] && data[i + 2] === MAGIC[2] && data[i + 3] === MAGIC[3]) {
      if (start !== -1) frames.push(data.subarray(start, i));
      start = i;
    }
  }
  if (start !== -1) frames.push(data.subarray(start));
  return frames;
}

const frames = splitFrames(buf);
console.log(`帧数: ${frames.length}`);

// 行解析：逐帧解压，每帧内容按行拆分
const lines = [];
let parseErrors = 0;
for (let i = 0; i < frames.length; i++) {
  try {
    const text = zlib.zstdDecompressSync(frames[i]).toString('utf8');
    for (const l of text.split('\n')) {
      if (l.trim() !== '') lines.push(l);
    }
  } catch (e) {
    parseErrors++;
    console.warn(`帧 ${i + 1} 解压失败: ${e.message}`);
  }
}
console.log(`全部行数: ${lines.length} | 解压失败帧: ${parseErrors}`);

// seq 校验与去重
const seen = new Set();
const dupLines = [];
let maxSeq = -1;
for (let i = 0; i < lines.length; i++) {
  let seq = null;
  try {
    const obj = JSON.parse(lines[i]);
    if (typeof obj?.seq === 'number') seq = obj.seq;
  } catch { /* 非 JSON 行保留原样 */ }
  if (seq === null) continue;
  if (seen.has(seq)) dupLines.push({ line: i + 1, seq });
  else seen.add(seq);
  if (seq > maxSeq) maxSeq = seq;
}
console.log(`seq 范围: 最大 ${maxSeq} | 重复行: ${dupLines.length}`);
if (dupLines.length > 0) {
  for (const d of dupLines.slice(0, 20)) console.log(`  重复: 第 ${d.line} 行, seq=${d.seq}`);
  if (dupLines.length > 20) console.log(`  … 共 ${dupLines.length} 处`);
}

if (dupLines.length === 0) {
  console.log('未发现重复 seq 行——此类损坏可能有其他形态（缺失帧/乱序），需人工核对。');
  process.exit(0);
}
if (!apply) {
  console.log('\n(dry-run) 未做修改。确认后加 --apply 执行；执行前自动备份原文件。');
  process.exit(0);
}

const bak = `${src}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(src, bak);
console.log(`已备份原文件: ${bak}`);

// 删除重复行，重新打包：每 64 行一帧（与 dsh 追加式格式兼容）
const keepSeq = new Set();
const kept = [];
for (const line of lines) {
  let seq = null;
  try {
    const obj = JSON.parse(line);
    if (typeof obj?.seq === 'number') seq = obj.seq;
  } catch { /* 逐字保留 */ }
  if (seq !== null && keepSeq.has(seq)) continue;
  if (seq !== null) keepSeq.add(seq);
  kept.push(line);
}
console.log(`修复后行数: ${kept.length}（删除 ${lines.length - kept.length} 行）`);

const outChunks = [];
const CHUNK = 64;
for (let i = 0; i < kept.length; i += CHUNK) {
  const chunkText = kept.slice(i, i + CHUNK).join('\n') + '\n';
  outChunks.push(zlib.zstdCompressSync(Buffer.from(chunkText, 'utf8')));
}
fs.writeFileSync(src, Buffer.concat(outChunks));
console.log(`已写回 session.jsonl.zstd（${outChunks.length} 帧）`);
console.log('提示：会话搜索索引为可弃用派生模型，重启 dsh 会自动重建。');
