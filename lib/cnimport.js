'use strict';
/**
 * 中文数据库题录导入解析。
 *
 * 背景（这是一个必须如实说明的限制）：
 *   CNKI、万方、维普都没有公开 API；而且**真正被 CSSCI 收录的中文期刊极少在 Crossref 注册 DOI**
 *   （我实测过：中国语文、世界汉语教学、语言教学与研究、外语教学与研究等均为 0 条记录）。
 *   Crossref 上能搜到的中文「教育类期刊」绝大多数来自非正规出版商，不具备 CSSCI/北大核心资格。
 *   因此中文文献的合法路径是：你在有权访问的数据库里自行导出题录，再导入本工作台。
 *
 * 本模块负责把这些导出格式解析成统一结构。支持：
 *   1. CNKI「导出/参考文献」的 GB/T 7714 文本格式（著录格式）
 *   2. CNKI 的 RefWorks 标签格式（RT / A1 / T1 / JO / AB / K1 / YR / DO …）
 *   3. 万方、维普的常见标签格式（题名/作者/刊名/摘要/关键词/年/卷/期/页码）
 *   4. CSV（含「题名/刊名/作者」等中文列名，或 title/journalName 等英文列名）
 *   5. JSON 数组
 */
const journals = require('./journals');

/* ------------------------------- 字段映射 ------------------------------- */

const FIELD_ALIASES = {
  title: ['title', '题名', '篇名', '标题', '论文题目', 'ti', 't1', 'article title'],
  authors: ['author', 'authors', '作者', '责任者', 'au', 'a1', '全部作者'],
  journalName: ['journalname', 'journal', '刊名', '期刊', '来源', '来源期刊', '出处', 'jo', 'jf', 'j2', 'publication'],
  issn: ['issn', '国际标准刊号', '国际刊号'],
  doi: ['doi', 'digital object identifier', 'do'],
  abstract: ['abstract', '摘要', 'ab', '中文摘要'],
  keywords: ['keywords', 'keyword', '关键词', '主题词', 'k1', 'kw'],
  issuedDate: ['issueddate', 'date', '发表时间', '出版日期', '年', '年份', 'yr', 'py', 'publication year', 'date published'],
  volume: ['volume', '卷', 'vl'],
  issue: ['issue', '期', 'is'],
  pages: ['pages', '页码', '页', 'sp'],
  url: ['url', '链接', '网址', 'lk'],
  language: ['language', '语言', '语种', 'la'],
  fund: ['基金', '基金项目', 'fund'],
  type: ['文献类型', 'type', '文献类型标识'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s_\-（）()【】\[\]:：]/g, '');
}

function buildHeaderMap(headers) {
  const map = {};
  const norm = headers.map(normalizeHeader);
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const a of aliases) {
      const idx = norm.indexOf(normalizeHeader(a));
      if (idx >= 0) { map[field] = idx; break; }
    }
  }
  return map;
}

/* --------------------------- RefWorks 标签格式 --------------------------- */

const RW_TAGS = {
  T1: 'title', TI: 'title', BT: 'title',
  A1: 'author', AU: 'author',
  JF: 'journalName', JO: 'journalName', J2: 'journalName', T2: 'journalName',
  AB: 'abstract', N2: 'abstract',
  K1: 'keywords',
  YR: 'issuedDate', PY: 'issuedDate', DA: 'issuedDate',
  DO: 'doi',
  VO: 'volume', IS: 'issue', SP: 'pages',
  UR: 'url', LK: 'url',
  SN: 'issn',
  LA: 'language',
};

/**
 * 解析 RefWorks / CNKI 标签格式。
 * 记录之间用空行分隔；同一标签可重复（作者、关键词）。
 */
function parseTagged(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const records = [];
  let cur = null;
  let inContinuation = null;

  const push = () => {
    if (cur && (cur.title || cur.journalName)) records.push(cur);
    cur = null; inContinuation = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      // 空行可能只是段落间隔；只有已经攒够字段时才结束记录
      if (cur && cur.title && cur.journalName) push();
      continue;
    }
    // RefWorks 导出常用「A1 张三」这种空格分隔，也可能是「A1: 张三」或「A1- 张三」
    const m = line.match(/^([A-Z][A-Z0-9])\s*(?:[-–:：]\s*|\t+| {1,})(.*)$/);
    if (m && RW_TAGS[m[1]]) {
      if (!cur) cur = {};
      const field = RW_TAGS[m[1]];
      const val = m[2].trim();
      if (field === 'author') {
        if (!cur.authors) cur.authors = [];
        cur.authors.push(val);
      } else if (field === 'keywords') {
        if (!cur.keywords) cur.keywords = [];
        cur.keywords.push(...String(val).split(/[;；,，]/).map((x) => x.trim()).filter(Boolean));
      } else {
        cur[field] = cur[field] ? cur[field] + ' ' + val : val;
      }
      inContinuation = field;
      continue;
    }
    // 续行（摘要常跨行）
    if (cur && inContinuation) {
      const field = inContinuation === 'author' ? null : inContinuation;
      if (field && typeof cur[field] === 'string') cur[field] += ' ' + line.trim();
    }
  }
  push();
  return records;
}

/* ----------------------- GB/T 7714 著录格式 ----------------------- */

/**
 * 解析 CNKI「参考文献」导出，形如：
 *   张三. 汉语学习者语用能力发展研究[J]. 世界汉语教学, 2023, 37(2): 215-228.
 *   李四, 王五. 生成式人工智能与语言教学[J]. 外语教学与研究, 2024(3): 45-52.
 */
function parseGbt(text) {
  const blocks = String(text).replace(/\r\n?/g, '\n')
    .split(/\n(?=\S)/)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length > 20);

  const out = [];
  for (const b of blocks) {
    // 必须有 [J] （期刊论文）或至少含刊名结构
    const m = b.match(/^(.+?)\.\s*(.+?)\s*\[([A-Z])\]\s*\.\s*(.+)$/);
    if (!m) continue;
    const [, authorPart, title, typeCode, rest] = m;
    if (typeCode !== 'J') continue;   // 只收期刊论文

    // rest: 刊名, 年, 卷(期): 页码.  /  刊名, 年(期): 页码.
    const rem = rest.match(/^(.+?)[,，]\s*((?:19|20)\d{2})\s*(?:[,，]\s*([^()（）:：]+))?\s*(?:[（(]\s*([^)）]+)\s*[)）])?\s*[:：]?\s*([\d\-–—~,\s]*)?\.?$/);
    if (!rem) continue;
    const [, journalName, year, volMaybe, issue, pages] = rem;

    // 作者串里可能还有年份后缀；卷次可能落在 volMaybe 里
    const authors = authorPart.split(/[,，;；]/).map((x) => x.replace(/\[\d+\]/g, '').trim()).filter(Boolean);
    let volume = null, issueNo = issue || null;
    if (volMaybe) {
      const vm = String(volMaybe).match(/(\d+)\s*[（(]?\s*(\d*)/);
      if (vm) { volume = vm[1]; if (!issueNo && vm[2]) issueNo = vm[2]; }
    }

    out.push({
      title: title.replace(/^[《“"']|[》”"']$/g, '').trim(),
      authors,
      journalName: journalName.replace(/^[《]|[》]$/g, '').trim(),
      issuedDate: year,
      volume, issue: issueNo,
      pages: (pages || '').replace(/[,\s]+$/, '').trim() || null,
      language: 'zh',
      source: 'gbt7714',
    });
  }
  return out;
}

/* --------------------------- 表头分隔文本 --------------------------- */

/**
 * CNKI「自定义导出」常是 Tab 或逗号分隔，首行为中文表头。
 */
function parseDelimited(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(',') ? ',' : null);
  if (!delim) return [];
  const rows = delim === '\t'
    ? lines.map((l) => l.split('\t'))
    : journals.parseCsv(lines.join('\n'));
  if (rows.length < 2) return [];
  const map = buildHeaderMap(rows[0]);
  if (map.title === undefined && map.journalName === undefined) return [];

  return rows.slice(1).map((r) => {
    const g = (f) => (map[f] !== undefined && r[map[f]] != null ? String(r[map[f]]).trim() : '');
    return {
      title: g('title'),
      authors: g('authors').split(/[;；,，]/).map((x) => x.trim()).filter(Boolean),
      journalName: g('journalName'),
      issn: g('issn'),
      doi: g('doi'),
      abstract: g('abstract'),
      keywords: g('keywords').split(/[;；,，]/).map((x) => x.trim()).filter(Boolean),
      issuedDate: g('issuedDate'),
      volume: g('volume'), issue: g('issue'), pages: g('pages'),
      url: g('url'),
      language: g('language') || 'zh',
      source: 'delimited',
    };
  }).filter((r) => r.title);
}

/* ------------------------------ JSON ------------------------------ */

function parseJsonRecords(text) {
  const parsed = JSON.parse(text);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((r) => {
    const map = buildHeaderMap(Object.keys(r));
    const g = (f) => {
      if (map[f] !== undefined) return r[Object.keys(r)[map[f]]];
      return undefined;
    };
    const authors = g('authors');
    return {
      title: g('title') || '',
      authors: Array.isArray(authors) ? authors : String(authors || '').split(/[;；,，]/).map((x) => x.trim()).filter(Boolean),
      journalName: g('journalName') || '',
      issn: g('issn') || '', doi: g('doi') || '',
      abstract: g('abstract') || '',
      keywords: Array.isArray(g('keywords')) ? g('keywords')
        : String(g('keywords') || '').split(/[;；,，]/).map((x) => x.trim()).filter(Boolean),
      issuedDate: String(g('issuedDate') || ''),
      volume: String(g('volume') || ''), issue: String(g('issue') || ''), pages: String(g('pages') || ''),
      url: g('url') || '',
      language: g('language') || 'zh',
      source: 'json',
    };
  }).filter((r) => r.title);
}

/* ------------------------------ 主入口 ------------------------------ */

/**
 * 自动识别格式并解析。
 * @returns {{ok:boolean, format:string, records:Array, warning:string|null, counts:object}}
 */
function parseImport(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: '内容为空', records: [] };

  const attempts = [];
  const tryParse = (name, fn) => {
    try {
      const records = fn();
      if (records && records.length) attempts.push({ name, records });
    } catch (e) { /* 该格式不适用 */ }
  };

  if (raw.startsWith('[') || raw.startsWith('{')) tryParse('JSON', () => parseJsonRecords(raw));
  tryParse('CNKI/RefWorks 标签格式', () => parseTagged(raw));
  tryParse('GB/T 7714 著录格式', () => parseGbt(raw));
  tryParse('表头分隔文本', () => parseDelimited(raw));

  if (!attempts.length) {
    return {
      ok: false, format: 'unknown', records: [],
      error: '无法识别题录格式。',
      hint: '支持的格式：CNKI「导出/参考文献」文本、RefWorks 标签格式、GB/T 7714 著录（形如 作者. 篇名[J]. 刊名, 年, 卷(期): 页码.）、带表头的 CSV/TSV、JSON 数组。',
    };
  }

  /*
   * 合并所有能解析出记录的格式，而不是只取一种。
   * 原因：用户常常把 CNKI 的 GB/T 著录格式和 RefWorks 标签格式粘在同一段文本里，
   * 只取「记录最多的一种」会静默丢掉另一部分。
   * 合并后按「规范化题名」去重，保留字段更完整的那条。
   */
  attempts.sort((a, b) => b.records.length - a.records.length);
  const fmtOf = new Map();
  const byTitle = new Map();
  for (const a of attempts) {
    for (const r of a.records) {
      const key = String(r.title || '').replace(/\s+/g, '').toLowerCase();
      if (!key) continue;
      const prev = byTitle.get(key);
      const score = (r) => ['title', 'journalName', 'abstract', 'issuedDate', 'volume', 'issue', 'pages', 'doi']
        .reduce((n, f) => n + (r[f] ? 1 : 0), 0) + (Array.isArray(r.authors) ? r.authors.length : 0)
        + (Array.isArray(r.keywords) ? r.keywords.length : 0);
      if (!prev || score(r) > score(prev)) {
        byTitle.set(key, r);
        fmtOf.set(key, a.name);
      }
    }
  }
  const merged = [...byTitle.values()];
  const formatCounts = {};
  for (const name of fmtOf.values()) formatCounts[name] = (formatCounts[name] || 0) + 1;
  const dominant = Object.entries(formatCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || attempts[0].name;
  const best = {
    name: Object.keys(formatCounts).length > 1
      ? `${dominant}（合并 ${Object.keys(formatCounts).length} 种格式）`
      : dominant,
    records: merged,
  };
  const otherFormats = Object.entries(formatCounts)
    .filter(([n]) => n !== dominant)
    .map(([n, c]) => `${n} ${c} 条`);

  // 规范化
  const records = best.records.map((r) => {
    const issued = String(r.issuedDate || '').trim();
    const year = (issued.match(/(?:19|20)\d{2}/) || [''])[0];
    return {
      title: String(r.title || '').trim(),
      authors: (Array.isArray(r.authors) ? r.authors : []).map((x) => String(x).trim()).filter(Boolean),
      journalName: String(r.journalName || '').trim(),
      issn: r.issn ? String(r.issn).trim() : '',
      doi: r.doi ? String(r.doi).trim() : '',
      abstract: r.abstract ? String(r.abstract).trim() : '',
      keywords: (Array.isArray(r.keywords) ? r.keywords : []).map((x) => String(x).trim()).filter(Boolean),
      // 题录只给到年份时就存年份（如 "2026"），不补 1 月 1 日：
      // 精度不足的日期不能冒充真实出版日
      issuedDate: issued || (year || ''),
      volume: r.volume ? String(r.volume).trim() : '',
      issue: r.issue ? String(r.issue).trim() : '',
      pages: r.pages ? String(r.pages).trim() : '',
      url: r.url ? String(r.url).trim() : '',
      language: r.language || 'zh',
      keywordsSource: (Array.isArray(r.keywords) && r.keywords.length) ? 'imported:cnki' : null,
      sources: ['imported'],
      externalIds: { imported: true, format: best.name, originalSource: r.source || null },
    };
  }).filter((r) => r.title);

  const withAbstract = records.filter((r) => r.abstract).length;
  const withKeywords = records.filter((r) => r.keywords.length).length;
  const withDoi = records.filter((r) => r.doi).length;
  const withJournal = records.filter((r) => r.journalName).length;

  const warnings = [];
  if (!withJournal) warnings.push('所有记录都缺少刊名：没有刊名就无法做期刊资格核验，这些论文会停留在待核验候选。');
  else if (withJournal < records.length) warnings.push(`${records.length - withJournal} 条记录缺少刊名。`);
  if (!withAbstract) warnings.push('所有记录都缺少摘要：AI 解读与摘要翻译将只能依据题名与元数据。');
  if (!withDoi) warnings.push('记录中没有 DOI（中文数据库导出通常不含 DOI），这不影响入库，但会影响与 Crossref 的去重合并。');

  return {
    ok: true,
    format: best.name,
    otherFormatsDetected: otherFormats,
    records,
    counts: {
      total: records.length, withAbstract, withKeywords, withDoi, withJournal,
      withoutJournal: records.length - withJournal,
    },
    warning: warnings.length ? warnings.join(' ') : null,
    note: `已识别为「${best.name}」，解析出 ${records.length} 条题录。`,
  };
}

/** 导入后给出期刊匹配预览，让你先看命中率再决定是否入库 */
function previewJournalMatch(records) {
  const jm = require('./journals');
  const cfg = require('./config');
  const settings = cfg.getSettings();
  const out = { total: records.length, matched: 0, unmatched: 0, byStatus: {}, samples: [] };
  for (const r of records) {
    const jrow = jm.findJournal({ issn: r.issn, name: r.journalName });
    const info = jrow ? jm.eligibilityOf(jrow, settings) : { status: 'pending', note: '期刊未匹配' };
    out.byStatus[info.status] = (out.byStatus[info.status] || 0) + 1;
    if (jrow) out.matched++; else out.unmatched++;
    if (out.samples.length < 12) {
      out.samples.push({ title: r.title.slice(0, 60), journalName: r.journalName, status: info.status, note: info.note.slice(0, 90) });
    }
  }
  return out;
}

module.exports = { parseImport, parseTagged, parseGbt, parseDelimited, parseJsonRecords, previewJournalMatch };
