'use strict';
/**
 * pdftext.js —— 零依赖 PDF 纯文本提取（尽力而为版）
 *
 * 目标：只用 Node 内置模块，从「文本型（非扫描件）」PDF 中抽出一份足够好的纯文本，
 * 用于全文检索与引文摘录。不追求排版还原，只要求「不抛异常、能降级、大体可用」。
 *
 * 实现思路：
 *   1. 用 Buffer/字符串扫描定位所有 `stream ... endstream`，向前回溯最多 2KB 找到所属字典，
 *      读取 /Filter；支持 FlateDecode（zlib 三种解压方式兜底）、ASCII85Decode、ASCIIHexDecode。
 *   2. 解压结果按内容分类：含 beginbfchar / beginbfrange / begincmap 的当作 CMap（ToUnicode），
 *      含 BT/ET/Tj/TJ 的当作内容流。
 *   3. 解析 ToUnicode CMap：<SRC> <DST>、<lo> <hi> <dst>、<lo> <hi> [<d1> <d2> ...] 三种形态，
 *      建立 SRC 十六进制串 -> Unicode 字符串的映射。
 *   4. 扫描内容流，取出 Tj / TJ / ' / " 的字符串操作数，按 ToUnicode 解码；
 *      再根据 Td / TD / T* / TJ / ET 插入换行与段落分隔。
 *   5. 归一化空白、压缩空行、丢弃独占一行的纯数字行（页码）。
 *
 * 已知局限（有意保留，不打算修）：
 *   - 不支持 LZWDecode：遇到即跳过该流并记录 warning。
 *   - 不做 OCR：扫描件（无文本层）只会返回空文本 + warning。
 *   - 全文档只合并出一张 ToUnicode 映射表（不同字体共用一张表，是接受范围内的简化，
 *     理论上存在编码空间冲突；实际论文里通常仍可用）。
 *   - 不还原分栏、表格、页眉页脚：抽出的文本可能夹带 running header/footer 与页码。
 *   - 不做 XObject Form 递归、不解析对象流（ObjStm）中的内容流。
 *   - TJ 被当作行边界处理（连续 TJ 视为同行续写，用空格连接），可能多出/少掉若干换行。
 *   - 行定位靠启发式：Td / TD / T* / 单引号 / 双引号操作符直接换行，Tm 比较 y 坐标决定换行还是接续，
 *     因此个别排版引擎产出的换行位置可能不精确。
 *   - 同一 y 坐标上的连续文本片段之间不插入空格（这些片段通常是紧邻的，空格多含在字符串里），
 *     极少数靠 Tm 跳位排版且不写空格字符的 PDF 可能把两个词粘在一起。
 *   - 会把康熙部首 / CJK 兼容表意文字归一化回标准汉字（见 normalizeCompatChars），
 *     除此之外不改动原文任何字符（保留全角标点与连字原样）。
 *
 * @module lib/pdftext
 */

const zlib = require('node:zlib');
const fs = require('node:fs');

/** 向前回溯查找字典的最大字节数 */
const MAX_DICT_LOOKBACK = 2048;
/** TJ 数组中绝对值超过该阈值的间距视为一个空格 */
const TJ_SPACE_THRESHOLD = 120;
/** 句末标点，用于 ET 处判断是否分段 */
const SENTENCE_END_RE = /[.。!！?？:：;；)"'”’\]]$/;

// ============================================================================
// 一、通用小工具
// ============================================================================

/** 把入参统一成 Buffer；非法输入抛错（由最外层兜住） */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return Buffer.from(input, 'latin1');
  if (input && typeof input === 'object' && typeof input.length === 'number') return Buffer.from(input);
  throw new Error('不支持的输入类型（需要 Buffer 或 Uint8Array）');
}

function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\0';
}

function isDelim(ch) {
  return ch === '(' || ch === ')' || ch === '<' || ch === '>' || ch === '[' || ch === ']'
    || ch === '{' || ch === '}' || ch === '/' || ch === '%';
}

function isAlpha(ch) {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
}

/** 取 bytes[start..start+len) 的小写十六进制表示 */
function bytesToHex(bytes, start, len) {
  let s = '';
  for (let k = 0; k < len; k++) s += bytes[start + k].toString(16).padStart(2, '0');
  return s;
}

/** 字节序列是否「看起来就是单字节 Latin-1 文本」：控制字符占比很低即认为可读 */
function isPlainLatin1(bytes) {
  let suspicious = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 0x20 || b === 0x7f) suspicious++;
  }
  return suspicious === 0 || suspicious / bytes.length < 0.1;
}

/** 二进制流粗筛：出现较多 NUL 字节就当作非文本（避免把图片流当内容流扫） */
function looksBinary(data) {
  const n = Math.min(data.length, 4096);
  if (n === 0) return true;
  let zeros = 0;
  for (let i = 0; i < n; i++) if (data[i] === 0) zeros++;
  return zeros / n > 0.01;
}

/** 统一构造失败返回体 */
function failure(warning) {
  return {
    ok: false,
    text: '',
    pages: 0,
    charCount: 0,
    warning: warning || '解析失败',
    fontsWithToUnicode: 0,
    usedToUnicode: false,
  };
}

// ============================================================================
// 二、流定位与滤波解码
// ============================================================================

/**
 * 定位所有 `stream ... endstream` 的字节范围。
 * 关键字边界检查用于排除 `endstream` 内部的 "stream"。
 */
function findStreams(raw) {
  const streams = [];
  const needle = 'stream';
  let pos = 0;
  for (;;) {
    const idx = raw.indexOf(needle, pos);
    if (idx < 0) break;
    pos = idx + needle.length;

    const before = idx > 0 ? raw[idx - 1] : '\n';
    if (!(before === '\n' || before === '\r' || before === ' ' || before === '\t' || before === '>')) continue;

    let ds = idx + needle.length;
    if (raw[ds] === '\r') ds++;
    if (raw[ds] === '\n') ds++;

    const endIdx = raw.indexOf('endstream', ds);
    if (endIdx < 0) continue;

    let de = endIdx;
    // 流数据与 endstream 之间的那个换行不属于数据
    if (de > ds && raw[de - 1] === '\n') de--;
    if (de > ds && raw[de - 1] === '\r') de--;

    streams.push({ start: ds, end: de, keywordAt: idx });
    pos = endIdx + 'endstream'.length;
  }
  return streams;
}

/**
 * 从 stream 关键字向前回溯，用括号配平的方式取回所属字典文本。
 * 支持嵌套字典：遇到 `>>` 记一层，遇到 `<<` 减一层，depth 归零处即最外层起点。
 */
function dictBefore(raw, keywordAt) {
  const start = Math.max(0, keywordAt - MAX_DICT_LOOKBACK);
  let depth = 0; // 反向扫描时：`>>` 加一层，`<<` 减一层，减到 0 即为最外层字典起点
  for (let i = keywordAt - 1; i > start; i--) {
    const c = raw[i];
    const p = raw[i - 1];
    if (c === '>' && p === '>') { depth++; i--; continue; }
    if (c === '<' && p === '<') {
      depth--;
      if (depth <= 0) return raw.slice(i - 1, keywordAt);
      i--;
    }
  }
  return raw.slice(start, keywordAt);
}

/** 解析 /Filter，返回过滤器名字数组（支持单个名字或数组写法） */
function parseFilters(dictText) {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dictText);
  if (!m) return [];
  const names = m[1].match(/\/[A-Za-z0-9]+/g) || [];
  return names.map((x) => x.slice(1));
}

/** Flate 解压兜底：zlib -> raw -> gzip -> 截断容忍；返回 {data, partial} 或 null */
function inflateAny(data) {
  const strict = [
    () => zlib.inflateSync(data),
    () => zlib.inflateRawSync(data),
    () => zlib.gunzipSync(data),
  ];
  for (const fn of strict) {
    try {
      const out = fn();
      if (out && out.length) return { data: out, partial: false };
    } catch (e) { /* 换下一种 */ }
  }
  // 最后一招：容忍被截断的流，能解出多少算多少
  try {
    const out = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    if (out) return { data: out, partial: true };
  } catch (e) { /* 无解 */ }
  return null;
}

/** ASCII85 解码（PDF 里通常以 ~> 结尾，支持 z 缩写与 <~ 前缀） */
function ascii85Decode(buf) {
  const s = buf.toString('latin1');
  const out = [];
  let tuple = [];
  let i = 0;
  if (s.startsWith('<~')) i = 2;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '~') break;
    if (isWs(ch)) continue;
    if (ch === 'z' && tuple.length === 0) { out.push(0, 0, 0, 0); continue; }
    const code = s.charCodeAt(i);
    if (code < 33 || code > 117) continue; // 非有效字符，忽略
    tuple.push(code - 33);
    if (tuple.length === 5) {
      let v = 0;
      for (const t of tuple) v = v * 85 + t;
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const keep = tuple.length - 1;
    while (tuple.length < 5) tuple.push(84); // 用 'u' 补齐
    let v = 0;
    for (const t of tuple) v = v * 85 + t;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    for (let k = 0; k < keep; k++) out.push(bytes[k]);
  }
  return Buffer.from(out);
}

/** ASCIIHex 解码：十六进制字符 + 可选 '>' 结束符 */
function asciiHexDecode(buf) {
  const s = buf.toString('latin1');
  let hex = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '>') break;
    if (/[0-9A-Fa-f]/.test(c)) hex += c;
  }
  if (hex.length % 2 === 1) hex += '0';
  return Buffer.from(hex, 'hex');
}

/**
 * 按过滤器链解码一个流。任一步失败返回 null（调用方跳过该流，不抛错）。
 * LZWDecode 明确不支持，只记录 warning。
 */
function decodeStreamBytes(bytes, filters, warn) {
  let data = bytes;
  if (!filters.length) return data;
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') {
      const res = inflateAny(data);
      if (!res) { warn('FlateDecode 解压失败，已跳过该流'); return null; }
      if (res.partial) warn('FlateDecode 流疑似被截断，已按可解出的部分尽力解析');
      data = res.data;
    } else if (f === 'ASCII85Decode' || f === 'A85') {
      try { data = ascii85Decode(data); } catch (e) { warn('ASCII85Decode 失败，已跳过该流'); return null; }
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
      try { data = asciiHexDecode(data); } catch (e) { warn('ASCIIHexDecode 失败，已跳过该流'); return null; }
    } else if (f === 'LZWDecode' || f === 'LZW') {
      warn('遇到 LZWDecode 压缩流，本实现不支持，已跳过');
      return null;
    } else {
      // DCTDecode / JPXDecode / CCITTFaxDecode 等图像过滤器，以及未知过滤器
      return null;
    }
  }
  return data;
}

// ============================================================================
// 三、内容流分类与 ToUnicode CMap
// ============================================================================

function classifyStream(text) {
  if (/beginbfchar|beginbfrange|begincmap/.test(text)) return 'cmap';
  if (/\bBT\b|\bET\b|\bTj\b|\bTJ\b|\bTf\b/.test(text)) return 'content';
  return 'other';
}

/** 把 CMap 的目标十六进制串转成 Unicode 字符串 */
function hexToUnicode(hex) {
  if (hex == null) return null;
  const h = String(hex).replace(/[^0-9A-Fa-f]/g, '');
  if (!h) return '';
  if (h.length <= 2) return String.fromCharCode(parseInt(h, 16));
  let out = '';
  for (let i = 0; i + 4 <= h.length; i += 4) {
    const code = parseInt(h.slice(i, i + 4), 16);
    if (code === 0) continue;
    out += String.fromCharCode(code);
  }
  return out;
}

/** 在保持位宽的前提下给十六进制串加偏移（bfrange 的连续映射用） */
function hexInc(hex, k) {
  const h = hex || '0';
  const n = parseInt(h, 16) + k;
  if (!Number.isFinite(n)) return h;
  return n.toString(16).padStart(h.length, '0');
}

/**
 * 写入一条 CMap 记录。
 * 注意：这里会把所有字体的 CMap 合并进同一张表（有意简化），且键会去掉前导零，
 * 这样 <41> 与 <0041> 会归并到同一键；解码时再按「先 2 字节、先 1 字节」的统计顺序试。
 */
function putCmapEntry(map, stats, srcHex, dstHex) {
  if (!srcHex) return false;
  const key = srcHex.toLowerCase().replace(/^0+/, '') || '0';
  const val = hexToUnicode(dstHex);
  if (val === null) return false;
  if (srcHex.length > 2) stats.multiByte++; else stats.oneByte++;
  if (!map.has(key)) map.set(key, val); // 先到先得，避免后面的字体覆盖前面的
  return true;
}

/** 解析 beginbfrange ... endbfrange 的函数体，支持 <lo> <hi> <dst> 与 <lo> <hi> [ ... ] */
function parseBfRangeBody(body) {
  const entries = [];
  const toks = [];
  const tokRe = /<([0-9A-Fa-f]*)>|\[([^\]]*)\]/g;
  let m;
  while ((m = tokRe.exec(body))) {
    if (m[1] !== undefined) toks.push({ t: 'hex', v: m[1] });
    else toks.push({ t: 'arr', v: (m[2].match(/<[0-9A-Fa-f]*>/g) || []).map((s) => s.slice(1, -1)) });
  }
  let i = 0;
  while (i + 2 < toks.length) {
    const lo = toks[i];
    const hi = toks[i + 1];
    const dst = toks[i + 2];
    if (lo.t !== 'hex' || hi.t !== 'hex') { i++; continue; }
    const loN = parseInt(lo.v || '0', 16);
    const hiN = parseInt(hi.v || '0', 16);
    if (!Number.isFinite(loN) || !Number.isFinite(hiN) || hiN < loN || hiN - loN > 65535) { i += 3; continue; }
    const count = hiN - loN;
    for (let k = 0; k <= count; k++) {
      if (dst.t === 'arr') {
        if (k >= dst.v.length) break;
        entries.push({ src: hexInc(lo.v, k), dst: dst.v[k] });
      } else {
        entries.push({ src: hexInc(lo.v, k), dst: hexInc(dst.v, k) });
      }
    }
    i += 3;
  }
  return entries;
}

/** 把一个 CMap 文本并入总表，返回写入条数 */
function parseCMapInto(text, map, stats) {
  let n = 0;
  let m;
  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = charRe.exec(text))) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let p;
    while ((p = pairRe.exec(m[1]))) {
      if (putCmapEntry(map, stats, p[1], p[2])) n++;
    }
  }
  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = rangeRe.exec(text))) {
    for (const e of parseBfRangeBody(m[1])) {
      if (putCmapEntry(map, stats, e.src, e.dst)) n++;
    }
  }
  return n;
}

// ============================================================================
// 四、PDF 字符串解析与解码
// ============================================================================

/** 解析字面量字符串 (...)，处理转义、八进制与括号配平 */
function readLiteralString(s, start) {
  let depth = 0;
  const bytes = [];
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === undefined) break;
      if (n === 'n') { bytes.push(10); i++; }
      else if (n === 'r') { bytes.push(13); i++; }
      else if (n === 't') { bytes.push(9); i++; }
      else if (n === 'b') { bytes.push(8); i++; }
      else if (n === 'f') { bytes.push(12); i++; }
      else if (n === '\n') { i++; }                                   // 行继续
      else if (n === '\r') { i++; if (s[i + 1] === '\n') i++; }        // 行继续
      else if (n >= '0' && n <= '7') {
        let oct = '';
        let j = i + 1;
        while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') { oct += s[j]; j++; }
        bytes.push(parseInt(oct, 8) & 0xff);
        i = j - 1;
      } else { bytes.push(n.charCodeAt(0) & 0xff); i++; }
      continue;
    }
    if (c === '(') { depth++; if (depth === 1) continue; bytes.push(40); continue; }
    if (c === ')') {
      depth--;
      if (depth === 0) return { bytes: Buffer.from(bytes), end: i + 1 };
      bytes.push(41);
      continue;
    }
    bytes.push(c.charCodeAt(0) & 0xff);
  }
  return { bytes: Buffer.from(bytes), end: s.length };
}

/** 解析十六进制字符串 <...> */
function readHexString(s, start) {
  let hex = '';
  let i = start + 1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '>') break;
    if (/[0-9A-Fa-f]/.test(c)) hex += c;
  }
  if (hex.length % 2 === 1) hex += '0';
  return { bytes: Buffer.from(hex, 'hex'), end: i + 1 };
}

/** 解析数字操作数 */
function readNumber(s, start) {
  let i = start;
  let str = '';
  while (i < s.length && /[0-9+\-.]/.test(s[i])) { str += s[i]; i++; }
  const v = parseFloat(str);
  return { value: Number.isFinite(v) ? v : 0, end: i > start ? i : start + 1 };
}

/** 跳过 /Name 操作数 */
function skipName(s, start) {
  let i = start + 1;
  while (i < s.length && !isWs(s[i]) && !isDelim(s[i])) i++;
  return i;
}

/** 读一个关键字/操作符 */
function readKeyword(s, start) {
  let i = start;
  while (i < s.length && !isWs(s[i]) && !isDelim(s[i])) i++;
  return { op: s.slice(start, i), end: i };
}

/** 直接读完整个数组操作数（内容流里数组不嵌套；字符串内的方括号会被正确跳过） */
function readArrayItems(s, start) {
  const items = [];
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === ']') { i++; break; }
    if (isWs(c)) { i++; continue; }
    if (c === '(') {
      const r = readLiteralString(s, i);
      items.push({ type: 'str', bytes: r.bytes, hex: false });
      i = r.end; continue;
    }
    if (c === '<' && s[i + 1] !== '<') {
      const r = readHexString(s, i);
      items.push({ type: 'str', bytes: r.bytes, hex: true });
      i = r.end; continue;
    }
    if (c === '<') { i += 2; continue; }
    if (c === '/') { i = skipName(s, i); continue; }
    if (/[0-9+\-.]/.test(c)) {
      const r = readNumber(s, i);
      items.push({ type: 'num', value: r.value });
      i = r.end; continue;
    }
    i++;
  }
  return { items, end: i };
}

/**
 * 按 ToUnicode 表解码字节序列。
 * 优先按全表统计决定的位宽顺序尝试（2 字节还是 1 字节先试），查不到再退回单字节。
 */
function decodeWithCMap(bytes, cmap, stats) {
  const twoFirst = stats && stats.multiByte >= stats.oneByte;
  const widths = twoFirst ? [2, 1] : [1, 2];
  let out = '';
  let hits = 0;
  let i = 0;
  while (i < bytes.length) {
    let done = false;
    for (const w of widths) {
      if (i + w > bytes.length) continue;
      const key = bytesToHex(bytes, i, w).replace(/^0+/, '') || '0';
      const v = cmap.get(key);
      if (v !== undefined) { out += v; i += w; hits++; done = true; break; }
    }
    // 查不到映射：倒退成单字节 Latin-1；NUL 通常是未命中的高位字节，直接丢弃
    if (!done) { if (bytes[i] !== 0) out += String.fromCharCode(bytes[i]); i++; }
  }
  return { text: out, hits };
}

/**
 * 解码一个 PDF 字符串操作数：
 *   - 有 UTF-16BE BOM 的直接按 UTF-16BE 还原；
 *   - 十六进制串或明显不是单字节 Latin-1 文本，且 CMap 命中时走 ToUnicode；
 *   - 否则按 Latin-1 输出。
 */
function decodePdfString(tok, cmap, stats) {
  const bytes = tok.bytes;
  if (!bytes || bytes.length === 0) return { text: '', usedCMap: false };

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const evenLen = bytes.length - ((bytes.length - 2) % 2);
    const body = Buffer.from(bytes.subarray(2, evenLen));
    body.swap16();
    return { text: body.toString('utf16le'), usedCMap: false };
  }

  if (cmap && cmap.size > 0 && (tok.hex || !isPlainLatin1(bytes))) {
    const r = decodeWithCMap(bytes, cmap, stats);
    if (r.hits > 0) return { text: r.text, usedCMap: true };
  }

  return { text: bytes.toString('latin1'), usedCMap: false };
}

// ============================================================================
// 五、内容流文本提取
// ============================================================================

/**
 * 扫描一个内容流，组装纯文本。
 * 分隔符优先级：'' < ' ' < '\n' < '\n\n'，只会被更强的分隔符升级。
 */
function extractContentStreamText(content, cmap, stats) {
  const ranks = { '': 0, ' ': 1, '\n': 2, '\n\n': 3 };
  const chunks = [];
  let pendingSep = '';
  let lastText = '';
  let ops = 0;
  let usedCMap = false;
  let stack = [];       // 尚未被操作符消费的字符串操作数
  let arrayItems = [];  // 最近一个数组的项（TJ 用）
  let recentNums = [];  // 最近连续出现的数字操作数（Tm / Td / Tf / TL 用）
  // 文本位置模型：BT 把当前行矩阵复位，Tm 绝对定位，Td/TD/T* 相对移动。
  // 只有当 y 真的变了才换行，这样「同一行被拆成多个文本片段」的 PDF 不会被切碎。
  let curX = 0;
  let curY = 0;
  let prevY = null;     // 上一次真正输出文字时的 y
  let fontSize = 12;    // Tf 设置的字号，用作 T* 行距的兜底
  let leading = 0;      // TL 设置的行距

  function addSep(sep) {
    if (!chunks.length) return;
    if (ranks[sep] > ranks[pendingSep]) pendingSep = sep;
  }
  function addText(t) {
    if (!t) return;
    if (chunks.length && pendingSep) chunks.push(pendingSep);
    pendingSep = '';
    chunks.push(t);
    lastText = (lastText + t).slice(-64);
  }
  function decodeTok(tok) {
    const r = decodePdfString(tok, cmap, stats);
    if (r.usedCMap) usedCMap = true;
    return r.text;
  }
  /** 输出文字前根据 y 坐标决定分隔符：换行只在 y 真的变化时产生 */
  function positionSep() {
    if (prevY === null) return;
    if (Math.abs(curY - prevY) > 0.5) addSep('\n');
  }
  /** 记录这次输出文字的位置 */
  function notePos() { prevY = curY; }
  /** T* / ' / " 的行距推进量 */
  function nextLineStep() { return leading > 0 ? leading : (fontSize > 0 ? fontSize : 12); }

  const n = content.length;
  let i = 0;
  while (i < n) {
    const c = content[i];

    if (c === '%') { const e = content.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (isWs(c)) { i++; continue; }

    if (c === '(') {
      const r = readLiteralString(content, i);
      stack.push({ bytes: r.bytes, hex: false });
      i = r.end; continue;
    }
    if (c === '<' && content[i + 1] !== '<') {
      const r = readHexString(content, i);
      stack.push({ bytes: r.bytes, hex: true });
      i = r.end; continue;
    }
    if (c === '<' || c === '>' || c === '{' || c === '}') { i++; continue; }
    if (c === '[') {
      const r = readArrayItems(content, i);
      arrayItems = r.items;
      stack = [];
      i = r.end; continue;
    }
    if (c === ']') { i++; continue; }
    if (c === '/') { stack = []; recentNums = []; i = skipName(content, i); continue; }
    if (/[0-9+\-.]/.test(c)) {
      stack = [];
      const r = readNumber(content, i);
      recentNums.push(r.value);
      if (recentNums.length > 8) recentNums.shift();
      i = r.end;
      continue;
    }
    if (isAlpha(c) || c === "'" || c === '"') {
      const kw = readKeyword(content, i);
      i = kw.end;

      if (kw.op === 'Tj' || kw.op === "'" || kw.op === '"') {
        if (kw.op !== 'Tj') curY -= nextLineStep(); // ' 与 " 都先移动到下一行再显示
        const t = stack.map((tok) => decodeTok(tok)).join('');
        if (t) { positionSep(); addText(t); notePos(); ops++; }
        stack = [];
      } else if (kw.op === 'TJ') {
        let t = '';
        for (let k = 0; k < arrayItems.length; k++) {
          const it = arrayItems[k];
          if (it.type === 'str') t += decodeTok(it);
          // TJ 里的负位移往往代表一个显式空格（没有空格字符的那种排版）
          else if (Math.abs(it.value) >= TJ_SPACE_THRESHOLD && k > 0 && k + 1 < arrayItems.length) t += ' ';
        }
        if (t) { positionSep(); addText(t); notePos(); ops++; }
        arrayItems = [];
        stack = [];
      } else if (kw.op === 'Td' || kw.op === 'TD') {
        if (recentNums.length >= 2) {
          curX += recentNums[recentNums.length - 2];
          curY += recentNums[recentNums.length - 1];
          if (kw.op === 'TD') leading = -recentNums[recentNums.length - 1];
        }
        stack = []; arrayItems = [];
      } else if (kw.op === 'T*') {
        curY -= nextLineStep();
        stack = []; arrayItems = [];
      } else if (kw.op === 'Tm') {
        // Tm 是绝对定位（Word / reportlab / cupsfilter 常用）
        if (recentNums.length >= 6) {
          curX = recentNums[recentNums.length - 2];
          curY = recentNums[recentNums.length - 1];
        }
        stack = []; arrayItems = [];
      } else if (kw.op === 'TL') {
        if (recentNums.length >= 1) leading = recentNums[recentNums.length - 1];
        stack = []; arrayItems = [];
      } else if (kw.op === 'Tf') {
        if (recentNums.length >= 1) fontSize = recentNums[recentNums.length - 1];
        stack = []; arrayItems = [];
      } else if (kw.op === 'ET') {
        // 句末标点结尾才升级为空行分段；否则交给位置模型判断
        if (SENTENCE_END_RE.test(lastText)) addSep('\n\n');
        stack = []; arrayItems = [];
      } else if (kw.op === 'BT') {
        // BT 复位文本矩阵；注意不能清空 pendingSep，否则会吃掉上一个 ET 设好的分段符
        curX = 0; curY = 0;
        stack = []; arrayItems = [];
      } else {
        stack = []; arrayItems = [];
      }
      recentNums = [];
      continue;
    }
    i++;
  }

  return { text: chunks.join(''), ops, usedCMap };
}

/**
 * 归一化少数「兼容字形」：康熙部首（U+2E80–U+2FDF）与 CJK 兼容表意文字（U+F900–U+FAFF）。
 * 这两段在 Unicode 里只是同一汉字的兼容写法，但有些 PDF（例如 macOS cupsfilter 生成的）
 * 的 ToUnicode 表就映射到部首码位，于是搜「文献」会搜不到（拿到的是「⽂献」）。
 * 只映射这两段，不动全角标点、连字等其它字符。
 */
const COMPAT_CHAR_RE = /[\u2E80-\u2FDF\uF900-\uFAFF]/g;
function normalizeCompatChars(text) {
  if (!/[\u2E80-\u2FDF\uF900-\uFAFF]/.test(text)) return text;
  return text.replace(COMPAT_CHAR_RE, (ch) => {
    const n = ch.normalize('NFKC');
    return n.length === 1 ? n : ch;
  });
}

/** 空白归一化：折叠水平空白、压缩空行、丢掉独占一行的纯数字行（页码） */
function normalizeText(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  t = normalizeCompatChars(t);
  t = t.replace(/[^\S\n]+/g, ' ');          // 水平空白（含全角空格）压成一个空格
  t = t.replace(/[ \t]*\n[ \t]*/g, '\n');   // 去掉行首行尾空白
  t = t.replace(/\n{3,}/g, '\n\n');         // 3 个以上换行压成 1 个空行
  t = t.split('\n').filter((line) => !/^\d{1,4}$/.test(line.trim())).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/** 统计 /Type /Page 出现次数（排除 /Pages） */
function countPages(raw) {
  const m = raw.match(/\/Type\s*\/Page(?![A-Za-z0-9])/g);
  return m ? m.length : 0;
}

// ============================================================================
// 六、对外接口
// ============================================================================

function extractPdfTextUnsafe(input) {
  const buf = toBuffer(input);
  if (!buf.length) return failure('输入为空');

  const warnings = [];
  const warn = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };

  const raw = buf.toString('latin1');
  const pages = countPages(raw);

  // --- 第一步：解压所有流，先收集 CMap，再留住内容流 ---
  const cmap = new Map();
  const cmapStats = { oneByte: 0, multiByte: 0 };
  const contentTexts = [];
  let cmapStreams = 0;
  let streamCount = 0;

  for (const st of findStreams(raw)) {
    streamCount++;
    const dictText = dictBefore(raw, st.keywordAt);
    const filters = parseFilters(dictText);
    let data;
    try {
      data = decodeStreamBytes(buf.subarray(st.start, st.end), filters, warn);
    } catch (e) {
      warn('流解码异常，已跳过：' + (e && e.message ? e.message : String(e)));
      continue;
    }
    if (!data || !data.length) continue;
    if (!filters.length && looksBinary(data)) continue; // 无过滤器且像二进制，多半是图片

    const text = data.toString('latin1');
    const kind = classifyStream(text);
    if (kind === 'cmap') {
      if (parseCMapInto(text, cmap, cmapStats) > 0) cmapStreams++;
    } else if (kind === 'content') {
      contentTexts.push(text);
    }
  }

  // --- 第二步：抽取正文文本 ---
  let textOps = 0;
  let usedToUnicode = false;
  const pieces = [];
  for (const ct of contentTexts) {
    const r = extractContentStreamText(ct, cmap, cmapStats);
    textOps += r.ops;
    if (r.usedCMap) usedToUnicode = true;
    if (r.text) pieces.push(r.text);
  }

  const text = normalizeText(pieces.join('\n'));
  const charCount = text.length;

  const toUnicodeRefs = (raw.match(/\/ToUnicode\b/g) || []).length;
  const fontsWithToUnicode = toUnicodeRefs > 0 ? toUnicodeRefs : cmapStreams;

  // ok 的含义：成功解出至少一个流（而不是「一定抽到了文字」，扫描件也会 ok=true）
  const ok = streamCount > 0;

  let warning = warnings.length ? warnings.join('；') : null;
  if (!ok) {
    warning = warning ? warning + '；未找到可解析的 PDF 流对象' : '未找到可解析的 PDF 流对象';
  } else if (charCount === 0 || textOps === 0) {
    const tip = '未提取到可用文本层（可能是扫描版 PDF，需要 OCR）';
    warning = warning ? warning + '；' + tip : tip;
  }

  return { ok, text, pages, charCount, warning, fontsWithToUnicode, usedToUnicode };
}

/**
 * 从 Buffer / Uint8Array 提取 PDF 文本（永不抛异常）。
 * @param {Buffer|Uint8Array} buffer PDF 字节
 * @returns {{ok:boolean,text:string,pages:number,charCount:number,warning:string|null,fontsWithToUnicode:number,usedToUnicode:boolean}}
 */
function extractPdfText(buffer) {
  try {
    return extractPdfTextUnsafe(buffer);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const r = failure('解析失败：' + msg);
    return r;
  }
}

/**
 * 读取文件并提取 PDF 文本；读文件失败时返回中文 warning，而不是抛错。
 * @param {string} filePath 文件路径
 */
function extractPdfTextFile(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    const code = err && err.code;
    const r = failure(code === 'ENOENT' ? '文件不存在' : '文件读取失败：' + (err && err.message ? err.message : String(err)));
    return r;
  }
  return extractPdfText(buf);
}

/**
 * 判断结果是否像扫描件（没有可用文本层）。
 * 判据：文本量 < max(200, 页数 * 50)；零文本操作符的情况天然被该判据覆盖（此时 charCount 为 0）。
 * @param {object} result extractPdfText / extractPdfTextFile 的返回值
 * @returns {boolean}
 */
function looksScanned(result) {
  if (!result || typeof result !== 'object') return true;
  if (result.ok === false) return true;
  const pages = Number(result.pages) || 0;
  const chars = typeof result.charCount === 'number'
    ? result.charCount
    : (typeof result.text === 'string' ? result.text.length : 0);
  return chars < Math.max(200, pages * 50);
}

module.exports = { extractPdfText, extractPdfTextFile, looksScanned };
