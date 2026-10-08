'use strict';
/**
 * 时间语义的唯一来源（UTC 存储 / 北京时间显示）。
 *
 * 背景（真实页面发现）：SQLite 的 `datetime('now')` 返回的是**没有时区标记**的
 * UTC 字符串，例如 `2026-09-27 19:10:03`。而 JavaScript 的 `new Date('2026-09-27 19:10:03')`
 * 按 ECMAScript 规范会把它当**本地时间**解析，于是同一时刻出现两种显示：
 *
 *   · 刚生成（前端传 new Date().toISOString()，带 Z）⇒ 2026/09/28 03:10  ✅
 *   · 刷新后（读库里的 naive UTC）            ⇒ 2026/09/27 19:10  ❌ 差 8 小时
 *
 * 本模块把这件事收口成一条规则：
 *   · **数据库里存明确时区的 ISO UTC**（`...Z`），且不加 Z 的旧值一律按 UTC 解释；
 *   · **对外的所有时间都用 ISO UTC 字符串**（归一化过，一定带 Z）；
 *   · **只有显示层**才换算成 Asia/Shanghai 并标明「北京时间」。
 *
 * 归一化只改**表示形式**，不改实际时刻：`2026-09-27 19:10:03` 与
 * `2026-09-27T19:10:03Z` 是同一瞬间（北京时间 2026-09-28 03:10:03）。
 */

const DISPLAY_TZ = 'Asia/Shanghai';

/** 纯日期（YYYY-MM-DD），没有时刻，不做时区换算 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** SQLite datetime() 的形状：YYYY-MM-DD HH:MM[:SS[.sss]]，无时区标记 */
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
/** 结尾已经带 Z 或 ±HH:MM 偏移 */
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * 解析任意时间输入为 Date；无法解析返回 null。
 * 关键约定：**不带时区标记的「日期+时刻」字符串按 UTC 解释**（与 SQLite 一致）。
 * 纯日期串按 UTC 当天 00:00 解释（只用于排序/比较，不用于显示）。
 */
function parse(input) {
  if (input == null || input === '') return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(input).trim();
  if (!s) return null;

  // 纯日期或「无时区的日期+时刻」⇒ 显式补 Z，避免被当成本地时间
  if (DATE_ONLY.test(s) || (NAIVE.test(s) && !ZONED.test(s))) {
    const iso = s.replace(' ', 'T');
    const d = new Date(iso + (/:\d{2}/.test(iso) ? 'Z' : 'T00:00:00Z'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 归一化为明确时区的 ISO UTC 字符串（数据库与 API 的统一格式）。
 * 无法解析时原样返回，避免悄悄丢掉数据。
 */
function toIsoUtc(input) {
  const d = parse(input);
  return d ? d.toISOString() : (input == null ? null : String(input));
}

/** 是否为「需要归一化」的不带时区 datetime 串 */
function isNaive(input) {
  if (typeof input !== 'string') return false;
  const s = input.trim();
  return NAIVE.test(s) && !ZONED.test(s);
}

/**
 * 是否为纯日期（YYYY-MM-DD）。
 * 论文的 online / print / discovery 日期本身没有时刻，是**出版日**而非瞬间，
 * 不做时区换算，也不该被加上时间——否则会凭空多出一个「几点几分」。
 */
function isDateOnly(input) {
  return typeof input === 'string' && DATE_ONLY.test(input.trim());
}

/** 换算到北京时间（Asia/Shanghai）的各字段，供显示层使用 */
function inShanghai(input) {
  const d = parse(input);
  if (!d) return null;
  const f = new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => (f.find((x) => x.type === t) || {}).value || '';
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour'), minute: get('minute'), second: get('second'),
  };
}

/** `2026/09/28 03:10`（北京时间），用于需要给人看的时刻 */
function fmtShanghai(input) {
  const p = inShanghai(input);
  return p ? `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}` : '—';
}

/** `2026-09-28 03:10:03`（北京时间），用于日志/表格 */
function fmtShanghaiLong(input) {
  const p = inShanghai(input);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` : '—';
}

/** `2026-09-28`（北京时间的日期），用于日期列 */
function fmtShanghaiDate(input) {
  const p = inShanghai(input);
  return p ? `${p.year}-${p.month}-${p.day}` : '—';
}

/** 北京时间当天的 YYYY-MM-DD（用于「今天」这类判定） */
function todayShanghai(input) {
  return fmtShanghaiDate(input == null ? new Date() : input);
}

module.exports = {
  DISPLAY_TZ,
  parse, toIsoUtc, isNaive, isDateOnly,
  inShanghai, fmtShanghai, fmtShanghaiLong, fmtShanghaiDate, todayShanghai,
};
