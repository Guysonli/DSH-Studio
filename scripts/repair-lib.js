'use strict';
// 会话日志修复核心库（纯函数，无副作用）。
//
// 存储格式：多个独立 zstd 帧（每帧均带帧头、可带校验和）物理拼接的 JSONL。
//   第 1 行：会话头 {type:'session', version:0, id, ...}
//   后续行：事件或 packed chunk 行（text-chunks / reasoning-chunks / tool-call-chunks，
//           存储 {type, seq0, time0, data:{turn, step, index, dt, texts|args}}，展开为
//           连续的 assistant/chunk 事件）。
//
// 常见损坏：两个 dsh 宿主进程同时写同一会话 → 同一 seq 出现两次（"seq gap in committed
//   region"）。本库的分析只认完整帧；torn 尾帧由 dsh 启动自愈处理，不在修复范围。

const zlib = require('node:zlib');

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 (LE)

// ---- 结构化帧扫描（与 dsh-session-persistence-jsonl 的 scanZstdFrames 一致）----
function scanFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`损坏的 Zstandard 会话日志：字节 ${offset} 处帧 magic 无效`);
    }
    offset += 4;
    if (offset === buf.length) return { frames, tornStart: start };
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`损坏的 Zstandard 会话日志：字节 ${offset - 1} 处保留帧头位被置位`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`损坏的 Zstandard 会话日志：字节 ${offset - 3} 处保留块类型`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, tornStart: undefined };
}

// ---- packed chunk 行展开（格式 v0，与 dsh-session 的 decodeStorageRecord 一致）----
const CHUNK_ROW_TAGS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

function malformed(tag, why) {
  throw new Error(`格式损坏（${tag} 存储行）：${why}`);
}

function hasExactKeys(value, keys) {
  const own = Object.keys(value);
  if (own.length !== keys.length) return false;
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(value, k)) return false;
  return true;
}

/** 展开一个 parsed JSONL 值为事件数组；非 packed 行原样返回。 */
function decodeRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [value];
  const tag = value.type;
  if (!CHUNK_ROW_TAGS.has(tag)) return [value];
  if (!hasExactKeys(value, ['type', 'seq0', 'time0', 'data'])) malformed(tag, '信封必须是 {type, seq0, time0, data}');
  if (!Number.isSafeInteger(value.seq0) || value.seq0 < 0) malformed(tag, 'seq0 必须是非负安全整数');
  if (!Number.isSafeInteger(value.time0)) malformed(tag, 'time0 必须是安全整数');
  const data = value.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) malformed(tag, 'data 必须是对象');
  const payloadKey = tag === 'tool-call-chunks' ? 'args' : 'texts';
  const rowKeys = tag === 'tool-call-chunks'
    ? [['turn', 'step', 'index', 'id', 'dt', 'args'], ['turn', 'step', 'index', 'id', 'name', 'dt', 'args']]
    : [['turn', 'step', 'index', 'dt', 'texts']];
  if (!rowKeys.some((keys) => hasExactKeys(data, keys))) {
    malformed(tag, `data 必须是 ${rowKeys.map((k) => `{${k.join(', ')}}`).join(' 或 ')}`);
  }
  const payload = data[payloadKey];
  if (!Array.isArray(payload) || payload.length === 0 || payload.some((e) => typeof e !== 'string')) {
    malformed(tag, `${payloadKey} 必须是非空字符串数组`);
  }
  if (!Array.isArray(data.dt) || data.dt.some((g) => !Number.isSafeInteger(g)) || data.dt.length !== payload.length - 1) {
    malformed(tag, 'dt 必须与成员数匹配的安全整数数组');
  }
  const events = [];
  let time = value.time0;
  for (let k = 0; k < payload.length; k++) {
    if (k > 0) time += data.dt[k - 1];
    events.push({ type: 'assistant/chunk', seq: value.seq0 + k, time });
  }
  return events;
}

// ---- 解码：帧 → 行记录 ----
/** 解码完整帧并切分为行记录。每行记录含出处（帧号/帧内行号），行尾内容保持字节一致。 */
function decodeArtifact(buf) {
  const { frames, tornStart } = scanFrames(buf);
  if (tornStart !== undefined) {
    throw new Error(`文件尾存在不完整帧（字节 ${tornStart} 起）：这是崩溃残留，交给 dsh 启动自愈处理，本工具不修改`);
  }
  const records = [];
  let lineNo = 0; // 全部行号（0 = 会话头行）
  for (let fi = 0; fi < frames.length; fi++) {
    const plain = zlib.zstdDecompressSync(buf.subarray(frames[fi].start, frames[fi].end));
    const text = plain.toString('utf8');
    const rowLines = text.split('\n');
    if (rowLines[rowLines.length - 1] !== '') {
      throw new Error(`帧 ${fi} 未以换行结尾：行可能跨帧，无法进行行级修复`);
    }
    for (let li = 0; li < rowLines.length - 1; li++) {
      const line = rowLines[li];
      let parsed;
      let parseError = null;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        parseError = e.message;
      }
      let events;
      if (parseError === null) {
        try {
          events = decodeRecord(parsed);
        } catch (e) {
          parseError = e.message;
        }
      }
      records.push({
        lineNo,
        frame: fi,
        frameLine: li,
        text: line,
        parsed,
        parseError,
        events: events ?? null,
      });
      lineNo += 1;
    }
  }
  return { frames, records, tornStart: undefined };
}

// ---- 完整性分析（等价 dsh 加载器的 seq 连续性校验）----
/**
 * @param records decodeArtifact 的行记录
 * @param skip 可选的"已判删除"行下标集合（修复迭代用）
 * @returns { healthy, kind, expected, got, recordIdx, indexInRecord }
 * recordIdx 始终是 records 的原始下标，kind ∈ 'duplicate'|'gap'|'unparsable'。
 */
function analyze(records, skip = null) {
  let expected = 0;
  for (let i = 0; i < records.length; i++) {
    if (skip !== null && skip.has(i)) continue;
    const r = records[i];
    if (r.lineNo === 0) continue; // 会话头行
    if (r.parseError) {
      return { healthy: false, kind: 'unparsable', recordIdx: i, expected, got: undefined };
    }
    if (r.events === null) return { healthy: false, kind: 'unparsable', recordIdx: i, expected, got: undefined };
    for (let j = 0; j < r.events.length; j++) {
      const e = r.events[j];
      if (e.seq !== expected) {
        return {
          healthy: false,
          kind: e.seq < expected ? 'duplicate' : 'gap',
          recordIdx: i,
          indexInRecord: j,
          expected,
          got: e.seq,
        };
      }
      expected += 1;
    }
  }
  return { healthy: true, expected };
}

/**
 * 分析第一个损坏点并给出修复决策：
 *  - duplicate（seq 重复）：可自动修复——删除造成重复的行。
 *    特例：重复行紧跟一个同 seq 的 session/end-seed（恢复实例写入的合成标记）时，
 *    改删 end-seed 行、保留真实事件行（本次事故的正解）。
 *  - gap（seq 缺失）：不可自动修复（缺失事件无法凭空恢复），交由人工。
 *  - unparsable：不可自动修复（删行可能丢弃关键数据）。
 * @returns {fixable, dropRecordIdx:number[], reasons:string[], reason?}
 */
function plan(records) {
  const drop = new Set();
  const reasons = [];
  for (let guard = 0; guard < 64; guard++) {
    const analysis = analyze(records, drop);
    if (analysis.healthy) return { fixable: true, dropRecordIdx: [...drop], reasons };
    if (analysis.kind === 'gap') {
      return {
        fixable: false,
        reason: `seq 缺失：第 ${records[analysis.recordIdx].lineNo + 1} 行期望 seq=${analysis.expected} 实际=${analysis.got}（缺失事件无法凭空恢复，请人工核对/回滚）`,
      };
    }
    if (analysis.kind === 'unparsable') {
      return {
        fixable: false,
        reason: `无法解析的行：第 ${records[analysis.recordIdx].lineNo + 1} 行（${records[analysis.recordIdx].parseError}）。为避免误删数据，需要人工处理`,
      };
    }
    // duplicate：判定删除哪个行。
    const idx = analysis.recordIdx;
    const rec = records[idx];
    const prev = idx > 0 ? records[idx - 1] : null;
    const prevEv = prev !== null && prev.events !== null ? prev.events[prev.events.length - 1] : null;
    const isEndSeedDup =
      prev !== null &&
      !drop.has(idx - 1) &&
      prevEv !== null &&
      prev.events.length === 1 &&
      prevEv.type === 'session/end-seed' &&
      prevEv.seq === rec.events[0].seq &&
      rec.events[0].seq === analysis.expected - 1;
    if (isEndSeedDup) {
      drop.add(idx - 1);
      reasons.push(`第 ${prev.lineNo + 1} 行（session/end-seed#${prevEv.seq}，恢复实例写入的合成结束标记）：与后一行 seq 冲突，保留真实事件行`);
    } else {
      drop.add(idx);
      reasons.push(`第 ${rec.lineNo + 1} 行：seq 重复（期望 ${analysis.expected}，实际 ${rec.events[0].seq}），保留首次出现`);
    }
  }
  return { fixable: false, reason: '损坏点过多（>64 处），请人工处理' };
}

/**
 * 执行修复：只改动含待删行的帧（其余帧字节不变）；行删空后该帧整体移除。
 * @param buf 原始字节
 * @param frames decodeArtifact 的结果
 * @param records decodeArtifact 的结果
 * @param dropRecordIdx plan 输出的行序号（records 下标）
 * @returns 新字节
 */
function encodeRepair(buf, frames, records, dropRecordIdx) {
  const drop = new Set(dropRecordIdx);
  // 待删行按帧分组，删帧内行号
  const perFrame = new Map(); // frame -> Set(frameLine)
  for (const idx of drop) {
    const r = records[idx];
    if (!perFrame.has(r.frame)) perFrame.set(r.frame, new Set());
    perFrame.get(r.frame).add(r.frameLine);
  }
  const newFrameBytes = new Map(); // frame -> Buffer|null
  for (const [fi, lineSet] of perFrame) {
    const plain = zlib.zstdDecompressSync(buf.subarray(frames[fi].start, frames[fi].end));
    const lines = plain.toString('utf8').split('\n');
    if (lines[lines.length - 1] !== '') throw new Error(`帧 ${fi} 未以换行结尾：行可能跨帧，无法进行行级修复`);
    lines.pop(); // 末尾空串是帧结束符（换行产物），不是行记录
    const kept = lines.filter((_, li) => !lineSet.has(li));
    if (kept.length === 0) {
      newFrameBytes.set(fi, null);
    } else {
      newFrameBytes.set(fi, zlib.zstdCompressSync(Buffer.from(kept.join('\n') + '\n', 'utf8'), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      }));
    }
  }
  const parts = [];
  for (let i = 0; i < frames.length; i++) {
    if (newFrameBytes.has(i)) {
      const nb = newFrameBytes.get(i);
      if (nb) parts.push(nb);
    } else {
      parts.push(buf.subarray(frames[i].start, frames[i].end));
    }
  }
  return Buffer.concat(parts);
}

/**
 * 修复后自检：重新解码 + 分析必须健康，且除计划删除的事件外没有任何事件丢失。
 * @returns {ok, totalEvents, reason?}
 */
function verifyRepair(bytes, originalRecords, dropRecordIdx) {
  const drop = new Set(dropRecordIdx);
  let expectedDropEvents = 0;
  for (const idx of drop) expectedDropEvents += originalRecords[idx].events ? originalRecords[idx].events.length : 0;
  let decoded;
  try {
    decoded = decodeArtifact(bytes);
  } catch (e) {
    return { ok: false, reason: `修复产物解码失败：${e.message}` };
  }
  const analysis = analyze(decoded.records);
  if (!analysis.healthy) {
    const row = decoded.records[analysis.recordIdx];
    return {
      ok: false,
      reason: `修复后仍异常：第 ${row.lineNo + 1} 行 ${analysis.kind === 'unparsable' ? `无法解析（${row.parseError}）` : `期望 ${analysis.expected}，实际 ${analysis.got}`}`,
    };
  }
  // 非删除行必须逐字节保留
  const originalTexts = [];
  for (let i = 0; i < originalRecords.length; i++) if (!drop.has(i) && originalRecords[i].lineNo !== 0) originalTexts.push(originalRecords[i].text);
  const newTexts = [];
  for (const r of decoded.records) if (r.lineNo !== 0) newTexts.push(r.text);
  if (newTexts.length !== originalTexts.length) {
    return { ok: false, reason: `修复后行数 ${newTexts.length} 与预期 ${originalTexts.length} 不符` };
  }
  for (let i = 0; i < originalTexts.length; i++) {
    if (newTexts[i] !== originalTexts[i]) return { ok: false, reason: `修复后第 ${i + 1} 行内容被意外改动` };
  }
  return { ok: true, totalEvents: analysis.expected, droppedEvents: expectedDropEvents };
}

module.exports = {
  scanFrames,
  decodeRecord,
  decodeArtifact,
  analyze,
  plan,
  encodeRepair,
  verifyRepair,
};
