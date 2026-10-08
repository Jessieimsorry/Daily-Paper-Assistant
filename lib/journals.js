'use strict';
/**
 * 期刊资格核验引擎。
 *
 * 核心原则：
 *  1. 系统不猜测、不编造期刊收录信息与分区。所有分区/收录结论必须来自
 *     你导入的官方目录 CSV（或逐刊手动核验记录）。
 *  2. 每条结论都保存：目录名称、版次/年份、匹配依据、核验状态、来源。
 *  3. 无法核实的期刊 ⇒ 论文进入「待核验候选」，绝不冒充合格论文。
 *  4. JCR 分区与中科院分区分别保存、分别显示，不混合。
 *  5. 中科院期刊分区表自 2026 年起不再更新，只能使用最后可核实的历史数据，
 *     并强制标注年份。
 */
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const N = require('./normalize');
const { CATALOG_DIR } = require('./config');

/* ------------------------------------------------------------------ *
 * 目录类型定义与 CSV 模板
 * ------------------------------------------------------------------ */

const CATALOG_TYPES = {
  cssci: {
    label: 'CSSCI 来源期刊目录',
    lang: 'zh',
    fields: ['期刊名称', 'ISSN', '学科分类', '版次或年份', '是否扩展版', '备注'],
    required: ['期刊名称'],
    keyField: '期刊名称',
    hint: 'CSSCI 扩展版不会被自动视为来源期刊（可在设置里开关）。CSSCI 目录为中文期刊目录。',
  },
  cssci_ext: {
    label: 'CSSCI 扩展版目录',
    lang: 'zh',
    fields: ['期刊名称', 'ISSN', '学科分类', '版次或年份', '备注'],
    required: ['期刊名称'],
    keyField: '期刊名称',
    hint: '单独导入，只有在你开启“接受 CSSCI 扩展版”后才会让论文合格。',
  },
  cn_core: {
    label: '《中文核心期刊要目总览》目录',
    lang: 'zh',
    fields: ['期刊名称', 'ISSN', '学科分类', '版次', '出版社', '备注'],
    required: ['期刊名称'],
    keyField: '期刊名称',
    hint: '版次例如：2023年版（第10版）。',
  },
  ref_jcr: {
    label: '参考分区名录（随程序附带，非官方）',
    lang: 'en',
    fields: ['期刊名称', 'ISSN', '依据年份', 'JCR学科类别1', '分区1', 'JCR学科类别2', '分区2'],
    required: ['期刊名称', 'ISSN'],
    keyField: 'ISSN',
    hint: '这份名录随程序附带，不是官方 JCR 目录，一定不完整也可能过时。它只产生「参考候选」。'
      + '可以进入「主题优先」的今日简报（会醒目标注为参考候选），'
      + '但不计入「期刊条件合格」数量，也不会进入「期刊条件合格精选」页。'
      + '导入官方 ssci_list / ssci_jcr 后，官方结论会覆盖它。',
  },
  ref_ssci: {
    label: '参考候选：SSCI 收录名单（截图转录，未经官方核验）',
    lang: 'en',
    fields: ['期刊名称', 'ISSN', 'JCR年份', 'JCR学科类别1', '分区1', '收录数据库', '2025 JIF', '截图行号', '证据状态', '来源网址', '备注'],
    required: ['期刊名称'],
    keyField: '期刊名称',
    hint: '公众号截图转录的 SSCI / JCR 参考候选。'
      + '可以进入「主题优先」的今日简报（会醒目标注为参考候选），'
      + '但不计入「期刊条件合格」数量，也不会进入「期刊条件合格精选」页。'
      + '标为 ESCI 的行不会被当作 SSCI。拿到机构官方目录后按 ISSN 逐条更新为已核验。',
  },
  ref_esci: {
    label: '参考候选：ESCI 名单（截图转录，非 SSCI）',
    lang: 'en',
    fields: ['期刊名称', 'ISSN', 'JCR年份', 'JCR学科类别1', '分区1', '收录数据库', '2025 JIF', '截图行号', '证据状态', '来源网址', '备注'],
    required: ['期刊名称'],
    keyField: '期刊名称',
    hint: 'ESCI 不是 SSCI。这些刊即使有 JCR 分区也不能判为英文合格，单独存放以便与 SSCI 区分。',
  },
  ref_cssci: {
    label: '参考候选：CSSCI 来源期刊（截图转录，未经官方核验）',
    lang: 'zh',
    fields: ['期刊名称', 'ISSN', '学科分类', '版次或年份', '截图行号', '证据状态', '来源网址', '备注'],
    required: ['期刊名称'],
    keyField: '期刊名称',
    hint: '公众号截图转录的 CSSCI 来源期刊参考候选（截图未提供 ISSN，按刊名精确匹配）。'
      + '可以进入「主题优先」的今日简报（会醒目标注为参考候选），'
      + '但不计入「期刊条件合格」数量，也不会进入「期刊条件合格精选」页。',
  },
  ref_cssci_ext: {
    label: '参考候选：CSSCI 扩展版（截图转录，未经官方核验）',
    lang: 'zh',
    fields: ['期刊名称', 'ISSN', '学科分类', '版次或年份', '截图行号', '证据状态', '来源网址', '备注'],
    required: ['期刊名称'],
    keyField: '期刊名称',
    hint: 'CSSCI 扩展版参考候选，与来源期刊分开存放。'
      + '可以进入「主题优先」的今日简报（会醒目标注为参考候选），'
      + '但不计入「期刊条件合格」数量，也不会进入「期刊条件合格精选」页。'
      + '默认不算合格；只有导入官方 CSSCI 扩展版目录后才按官方结论判定。',
  },
  ssci_list: {
    label: 'SSCI 收录期刊目录（仅收录名单）',
    lang: 'en',
    fields: ['期刊名称', 'ISSN', '收录年份', '学科类别', '收录数据库', '出版商', '备注'],
    required: ['期刊名称', 'ISSN'],
    keyField: 'ISSN',
    hint: '只有收录名单、没有分区时用这个。「收录数据库」列填 SSCI / SCIE / A&HCI / ESCI（可多选，用分号分隔）；省略时默认按 SSCI 处理。',
  },
  ssci_jcr: {
    label: 'SSCI 收录 + JCR 分区目录',
    lang: 'en',
    fields: ['期刊名称', 'ISSN', 'JCR年份', 'JCR学科类别1', '分区1', 'JCR学科类别2', '分区2', 'JCR学科类别3', '分区3', '收录数据库', '出版商', '备注'],
    required: ['期刊名称', 'ISSN'],
    keyField: 'ISSN',
    hint: '一个期刊可有多个 JCR 学科类别，务必逐个类别填写对应分区（Q1–Q4），只有 Q1–Q3 满足条件。'
      + '「收录数据库」列填 SSCI / SCIE / A&HCI / ESCI（可多选，分号分隔）：JCR 同时收录 SCIE 期刊，'
      + '只填 SCIE 的刊不会被当作已确认的 SSCI；省略该列时默认按 SSCI 处理。',
  },
  aci: {
    label: 'A&HCI 收录目录（可选，作为补充参考）',
    lang: 'en',
    fields: ['期刊名称', 'ISSN', '年份', '学科类别', '备注'],
    required: ['期刊名称'],
    keyField: 'ISSN',
    hint: '本项目按你的规则只把 SSCI 作为英文合格条件；A&HCI 仅作参考显示，不使论文合格。',
  },
  cas: {
    label: '中科院期刊分区表（历史数据）',
    lang: 'both',
    fields: ['期刊名称', 'ISSN', '分区年份', '大类分区', '大类学科', '小类分区', '小类学科', '是否Top', '备注'],
    required: ['期刊名称', 'ISSN'],
    keyField: 'ISSN',
    hint: '中科院分区表自 2026 年起不再更新发布；只能录入最后可核实年份的历史数据，系统会强制标注该年份。',
  },
  whitelist: {
    label: '特别关注期刊名单（自定义）',
    lang: 'both',
    fields: ['期刊名称', 'ISSN', '备注'],
    required: ['期刊名称'],
    keyField: '期刊名称',
    hint: '列入后：该刊论文若期刊条件不足也会被标记为“特别关注”，但不会被标为合格。',
  },
  blacklist: {
    label: '排除期刊名单（自定义）',
    lang: 'both',
    fields: ['期刊名称', 'ISSN', '排除原因'],
    required: ['期刊名称'],
    keyField: '期刊名称',
    hint: '列入后：该刊论文一律不进入简报。',
  },
};

/* ------------------------------------------------------------------ *
 * CSV 解析（支持引号、逗号、BOM、CRLF）
 * ------------------------------------------------------------------ */

function parseCsv(text) {
  let s = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}

/* ------------------------------------------------------------------ *
 * 目录导入
 * ------------------------------------------------------------------ */

function findColumn(headers, candidates) {
  const norm = (x) => String(x).trim().toLowerCase().replace(/[\s_\-（）()]/g, '');
  const nh = headers.map(norm);
  for (const c of candidates) {
    const idx = nh.indexOf(norm(c));
    if (idx >= 0) return idx;
  }
  return -1;
}

const COLUMN_ALIASES = {
  name: ['期刊名称', '刊名', 'journal', 'journalname', 'journal title', 'title', 'source title', 'full journal title'],
  issn: ['issn', 'issn号', 'print issn', 'pissn', 'issn (print)', '国际刊号', 'eissn', 'issn online'],
  year: ['版次或年份', '版次', '年份', 'jcr年份', 'year', 'edition', '分区年份'],
  category1: ['jcr学科类别1', '学科类别1', '学科分类', 'category1', 'category', '学科', '大类学科', 'web of science category'],
  quartile1: ['分区1', '分区', 'quartile1', 'quartile', 'jif quartile', 'jcr分区'],
  category2: ['jcr学科类别2', '学科类别2', 'category2'],
  quartile2: ['分区2', 'quartile2'],
  category3: ['jcr学科类别3', '学科类别3', 'category3'],
  quartile3: ['分区3', 'quartile3'],
  indexDb: ['收录数据库', '数据库', '收录', 'index', 'indexed in', 'database', 'web of science category index', '收录类型'],
  evidenceStatus: ['证据状态', '核验状态', 'evidence', 'status'],
  sourceUrl: ['来源网址', '来源链接', 'source url', 'url', '来源'],
  screenshotRow: ['截图行号', '行号', 'row'],
  jif: ['2025 jif', 'jif', '影响因子', 'impact factor'],
  casZone: ['大类分区', '分区', 'caszone', '中科院分区'],
  casCategory: ['大类学科', '小类学科', '学科'],
  isTop: ['是否top', 'top', 'istop'],
  isExtended: ['是否扩展版', '扩展版'],
  publisher: ['出版商', '出版社', 'publisher'],
  subject: ['学科分类', '学科', 'subject', 'category'],
  note: ['备注', 'note', '说明', '排除原因'],
  eissn: ['eissn', 'issn online', '电子issn'],
};

/**
 * 导入一个目录 CSV。
 * @param {string} catalogKey 见 CATALOG_TYPES
 * @param {string} csvText
 * @param {{edition?:string, year?:string, sourceName?:string, verified?:boolean}} meta
 */
function importCatalog(catalogKey, csvText, meta = {}) {
  const def = CATALOG_TYPES[catalogKey];
  if (!def) return { ok: false, error: `未知目录类型：${catalogKey}` };
  const rows = parseCsv(csvText);
  if (!rows.length) return { ok: false, error: 'CSV 内容为空' };

  const headers = rows[0];
  const body = rows.slice(1);
  const col = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    col[key] = findColumn(headers, aliases);
  }
  if (col.name < 0 && col.issn < 0) {
    return {
      ok: false,
      error: '无法识别列名。CSV 至少需要“期刊名称”或“ISSN”列。下载模板可看到标准列名。',
      detectedHeaders: headers,
    };
  }

  const edition = meta.edition || meta.year || (col.year >= 0 ? '' : '') || '未标注';
  const year = meta.year || edition;
  /*
   * 核验状态判定（三档）：
   *   meta.reference === true         → 强制按参考候选处理（随程序附带的参考名录）
   *   meta.reference === 'auto'       → 逐行读取「证据状态」列：含「待核验/未获/截图/参考/请勿」等字样即降级为参考候选
   *   其它                            → 视为官方目录导入（默认，保持原有行为）
   *
   * 「auto」这一档是为了安全：
   * 截图转录来的清单虽然能通过工作台的 CSV 导入，但绝不能被当成已核验官方目录，
   * 否则会直接抬高「期刊条件合格」数量。
   */
  const refMode = meta.reference === true ? 'force'
    : (meta.reference === 'auto' ? 'auto' : 'off');
  const baseIsReference = refMode === 'force';
  const verified = !baseIsReference && meta.verified !== false;
  const sourceName = meta.sourceName || `用户导入:${catalogKey}:${new Date().toISOString().slice(0, 10)}`;

  const stats = { total: body.length, imported: 0, skipped: 0, updatedJournals: 0, createdJournals: 0, errors: [] };

  const getCell = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');

  for (let ri = 0; ri < body.length; ri++) {
    const r = body[ri];
    const rawName = getCell(r, col.name);
    const rawIssn = getCell(r, col.issn);
    const issn = N.normalizeIssn(rawIssn);
    if (!rawName && !issn) { stats.skipped++; continue; }

    // 逐条构造 catalog entry
    const evidenceText = getCell(r, col.evidenceStatus);
    const rowNote = getCell(r, col.note);
    // 证据状态列里出现这些字样，说明这一行还没有官方核验依据
    const looksUnverified = /待核验|未获|未完成|截图|参考|请勿|待查|pending|unverified|to be verified/i
      .test(evidenceText + ' ' + rowNote);
    const rowIsReference = refMode === 'force' || (refMode === 'auto' && looksUnverified);

    const entry = {
      catalog: def.label,
      catalogKey,
      edition: getCell(r, col.year) || edition,
      year: getCell(r, col.year) || year,
      basis: issn ? `ISSN 精确匹配 (${issn})` : `刊名精确匹配 (${rawName})`,
      basisType: issn ? 'issn' : 'name',
      verified: !rowIsReference,
      reference: rowIsReference,
      source: sourceName,
      note: rowNote,
      evidenceStatus: evidenceText || null,
      sourceUrl: getCell(r, col.sourceUrl) || null,
      screenshotRow: getCell(r, col.screenshotRow) || null,
      jif: getCell(r, col.jif) || null,
      importedAt: new Date().toISOString(),
    };

    // 收录数据库：显式标注 SCIE / ESCI / A&HCI 时不得当作已确认的 SSCI
    const rawIndex = getCell(r, col.indexDb);
    if (!rawIndex && catalogKey === 'ref_esci') {
      // ESCI 目录：明确不是 SSCI
      entry.indexDatabases = ['ESCI'];
      entry.ssciIndexed = false;
    } else if (rawIndex) {
      const idx = rawIndex.toUpperCase();
      entry.indexDatabases = idx.split(/[;；,，/|]+/).map((x) => x.trim()).filter(Boolean);
      entry.ssciIndexed = /\bSSCI\b/.test(idx);
    } else {
      entry.indexDatabases = null;
      // 未标注时按目录语义推断：SSCI 收录名单 / SSCI+JCR 目录默认视为 SSCI；
      // 参考候选目录（ref_*）一律不确认 SSCI。
      entry.ssciIndexed = (catalogKey === 'ssci_list' || catalogKey === 'ssci_jcr');
    }
    if (catalogKey.startsWith('ref_')) entry.ssciIndexed = entry.ssciIndexed === true && catalogKey === 'ref_ssci';

    if (catalogKey === 'ssci_jcr' || catalogKey === 'ref_jcr' || catalogKey === 'ref_ssci' || catalogKey === 'ref_esci') {
      const cats = [];
      if (getCell(r, col.category1) || getCell(r, col.quartile1)) {
        cats.push({ name: getCell(r, col.category1) || '未标注类别', quartile: normQuartile(getCell(r, col.quartile1)) });
      }
      if (getCell(r, col.category2) || getCell(r, col.quartile2)) {
        cats.push({ name: getCell(r, col.category2) || '未标注类别', quartile: normQuartile(getCell(r, col.quartile2)) });
      }
      if (getCell(r, col.category3) || getCell(r, col.quartile3)) {
        cats.push({ name: getCell(r, col.category3) || '未标注类别', quartile: normQuartile(getCell(r, col.quartile3)) });
      }
      entry.jcrCategories = cats;
      entry.jcrYear = getCell(r, col.year) || year;
      if (!cats.length) {
        stats.errors.push(`第 ${ri + 2} 行：SSCI/JCR 目录缺少学科类别与分区，已按“收录但分区未知”记录`);
      }
    }

    if (catalogKey === 'cas') {
      entry.casZone = getCell(r, col.casZone) || '';
      entry.casCategory = getCell(r, col.casCategory) || getCell(r, col.subject) || '';
      entry.casYear = getCell(r, col.year) || year;
      entry.isTop = /^(是|yes|true|1|y)$/i.test(getCell(r, col.isTop));
    }

    if (catalogKey === 'cssci' || catalogKey === 'cssci_ext') {
      entry.isExtended = catalogKey === 'cssci_ext' || /^(是|yes|true|1|y)$/i.test(getCell(r, col.isExtended));
      entry.subject = getCell(r, col.subject) || '';
    }

    applyEntry({ name: rawName, issn, language: def.lang === 'en' ? 'en' : undefined }, entry, stats);
    stats.imported++;
  }

  // 记录目录导入事件
  recordCatalogLoad(catalogKey, { edition, year, sourceName, rows: stats.imported, fields: headers });

  // SSCI 收录只对「明确为 SSCI」的条目确认：
  // JCR 同时收录 SCIE 期刊，标了 SCIE 的刊不能算已确认 SSCI。
  let ssciConfirmed = 0, ssciExcluded = 0;
  if (catalogKey === 'ssci_list' || catalogKey === 'ssci_jcr') {
    const yes = [], no = [];
    for (const r of body) {
      const issn = N.normalizeIssn(getCell(r, col.issn));
      if (!issn) continue;
      const rawIndex = getCell(r, col.indexDb);
      const isSsci = rawIndex ? /\bSSCI\b/i.test(rawIndex)
        : (catalogKey === 'ssci_list' || catalogKey === 'ssci_jcr');
      (isSsci ? yes : no).push(issn);
    }
    ssciConfirmed = markSsciConfirmed(yes, true);
    ssciExcluded = no.length;
    if (no.length) markSsciConfirmed(no, false);
  }

  return {
    ok: true, catalogKey, label: def.label, stats, ssciConfirmed, ssciExcluded, headers,
    note: ssciExcluded
      ? `其中 ${ssciExcluded} 条标注为非 SSCI（如 SCIE/ESCI/A&HCI），未确认为 SSCI 收录——按你的规则，这些刊即使有 JCR 分区也不会直接合格。`
      : undefined,
  };
}

/**
 * 把指定 ISSN 的期刊标记为「已确认 SSCI 收录」。
 * JCR 目录本身同时收录 SCIE 与 SSCI，因此只有在明确导入 SSCI 收录名单
 * （或你机构确认过的 SSCI+JCR 目录）时才置位。
 */
function markSsciConfirmed(issnList, value = true) {
  let n = 0;
  const seen = new Set();
  const want = value ? 1 : 0;
  store.tx(() => {
    for (const raw of issnList || []) {
      const issn = N.normalizeIssn(raw);
      if (!issn || seen.has(issn)) continue;
      seen.add(issn);
      const j = store.get('SELECT * FROM journals WHERE issn = ?', [issn]);
      if (!j) continue;
      if (j.ssci_confirmed === want) continue;
      store.run('UPDATE journals SET ssci_confirmed = ? WHERE id = ?', [want, j.id]);
      n++;
    }
  });
  return n;
}

function normQuartile(q) {
  const s = String(q || '').trim().toUpperCase();
  const m = s.match(/Q\s*([1-4])/) || s.match(/^([1-4])$/);
  if (m) return 'Q' + m[1];
  if (/一区|1区/.test(s)) return 'Q1';
  if (/二区|2区/.test(s)) return 'Q2';
  if (/三区|3区/.test(s)) return 'Q3';
  if (/四区|4区/.test(s)) return 'Q4';
  return s || '未标注';
}

/** 把一条目录记录写入 journals 表 */
/**
 * 找到一条期刊记录（用于合并，避免同一刊出现多行）。
 *
 * 必须按「规范化刊名」大小写不敏感地匹配：
 * JCR 截图里的刊名是全大写（APPLIED LINGUISTICS），而 Crossref 里是正常大小写
 * （Applied Linguistics）。早期版本先按 name = ? 精确匹配，于是同一刊被拆成两行，
 * 2026 年的分区数据写到了新建的全大写那一行上，真正的记录反而没有更新。
 *
 * 优先级：ISSN 精确 > 规范化刊名完全相同（优先已有 ISSN 的记录）> 刊名变体。
 */
function findJournalRow({ name, issn }) {
  const i = N.normalizeIssn(issn);
  if (i) {
    const byIssn = store.get('SELECT * FROM journals WHERE issn = ?', [i]);
    if (byIssn) return byIssn;
  }
  const target = name ? N.cleanJournalNameForMatch(name) : '';
  if (!target) return null;

  const all = store.all('SELECT * FROM journals');
  const candidates = all.filter((x) => {
    if (N.cleanJournalNameForMatch(x.name) === target) return true;
    return store.parseJson(x.name_variants, []).some((v) => N.cleanJournalNameForMatch(v) === target);
  });
  if (!candidates.length) return null;
  // 有 ISSN 的记录信息更完整，优先当作主记录
  candidates.sort((a, b) => (b.issn ? 1 : 0) - (a.issn ? 1 : 0));
  return candidates[0];
}

/**
 * 合并重复的期刊行（同名不同大小写/重复导入造成）。
 * 把 papers.journal_id 重新指向保留的那一行，并合并目录条目。
 */
function mergeDuplicateJournals() {
  const all = store.all('SELECT * FROM journals');
  const groups = new Map();
  for (const j of all) {
    const key = N.cleanJournalNameForMatch(j.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  let mergedGroups = 0, removedRows = 0, relinkedPapers = 0;
  store.tx(() => {
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      // 主记录：优先有 ISSN、其次有官方目录条目、再次 id 最小
      const score = (j) => {
        const cats = store.parseJson(j.catalogs, []);
        return (j.issn ? 1000 : 0) + (cats.some((c) => c.reference !== true) ? 500 : 0) + cats.length * 10 - j.id / 1000;
      };
      list.sort((a, b) => score(b) - score(a));
      const keep = list[0];
      const others = list.slice(1);
      mergedGroups++;

      let catalogs = store.parseJson(keep.catalogs, []);
      let jcr = store.parseJson(keep.jcr, null);
      let cas = store.parseJson(keep.cas, null);
      let whitelist = keep.in_whitelist, blacklist = keep.in_blacklist;
      const variants = new Set(store.parseJson(keep.name_variants, []));
      let verified = keep.verified, ssci = keep.ssci_confirmed;
      let language = keep.language;

      for (const o of others) {
        for (const c of store.parseJson(o.catalogs, [])) {
          if (!catalogs.some((x) => x.catalogKey === c.catalogKey && x.edition === c.edition)) catalogs.push(c);
        }
        const oj = store.parseJson(o.jcr, null);
        if (oj && (!jcr || (jcr.reference === true && oj.reference !== true) ||
            (jcr.reference === oj.reference && String(oj.year) > String(jcr.year || '')))) jcr = oj;
        const oc = store.parseJson(o.cas, null);
        if (oc && (!cas || (cas.reference === true && oc.reference !== true))) cas = oc;
        for (const v of store.parseJson(o.name_variants, [])) variants.add(v);
        variants.add(o.name);
        whitelist = Math.max(whitelist, o.in_whitelist);
        blacklist = Math.max(blacklist, o.in_blacklist);
        verified = Math.max(verified, o.verified);
        ssci = Math.max(ssci, o.ssci_confirmed);
        language = language || o.language;
        const mv = store.run('UPDATE papers SET journal_id = ? WHERE journal_id = ?', [keep.id, o.id]);
        relinkedPapers += mv.changes || 0;
        store.run('DELETE FROM journals WHERE id = ?', [o.id]);
        removedRows++;
      }

      // verified / ssci_confirmed 一律按合并后的目录条目重算，不沿用旧值
      const official = catalogs.filter((c) => c.reference !== true);
      verified = official.length ? 1 : 0;
      ssci = official.some((c) => (c.catalogKey === 'ssci_list' || c.catalogKey === 'ssci_jcr') && c.ssciIndexed !== false) ? 1 : 0;

      store.run(
        `UPDATE journals SET catalogs = ?, jcr = ?, cas = ?, name_variants = ?,
           in_whitelist = ?, in_blacklist = ?, verified = ?, ssci_confirmed = ?, language = ? WHERE id = ?`,
        [JSON.stringify(catalogs), jcr ? JSON.stringify(jcr) : null, cas ? JSON.stringify(cas) : null,
         JSON.stringify([...variants]), whitelist, blacklist, verified, ssci, language, keep.id]);
    }
  });
  return { mergedGroups, removedRows, relinkedPapers, remaining: store.get('SELECT COUNT(*) c FROM journals').c };
}

function applyEntry({ name, issn, language }, entry, stats) {
  const j = findJournalRow({ name, issn });

  let catalogs = j ? store.parseJson(j.catalogs, []) : [];

  /*
   * 同一目录只保留一条记录（按 catalogKey 去重，而不是 catalogKey+版次）。
   *
   * 原来按「目录+版次」去重，于是「参考分区名录 2023–2024」和
   * 「SSCI 截图 2026」会作为两条 ref 记录长期并存，
   * eligibilityOf 挑到旧的那条，界面上就永远显示过期年份。
   * 现在：同目录只留一条，版次更新时覆盖，版次更旧时忽略。
   */
  const yearOf = (v) => {
    const m = String(v == null ? '' : v).match(/(19|20)\d{2}/g);
    return m ? Math.max(...m.map(Number)) : 0;
  };
  const dup = catalogs.findIndex((c) => c.catalogKey === entry.catalogKey);
  if (dup >= 0) {
    const existing = catalogs[dup];
    const incomingYear = yearOf(entry.year || entry.edition);
    const existingYear = yearOf(existing.year || existing.edition);
    const existingIsOfficial = existing.reference !== true;
    // 官方条目不被参考条目取代；其余情况取年份更新者
    if (!(entry.reference && existingIsOfficial) && incomingYear >= existingYear) {
      catalogs[dup] = entry;
    }
    // 否则保留原有（更新的）条目
  } else {
    catalogs.push(entry);
  }

  /*
   * 随程序附带的「参考分区名录」(ref_jcr) 只是兜底数据，且年份较旧。
   * 一旦导入了你自己的更新参考目录（ref_ssci / ref_esci / ref_cssci …），
   * 就让它们取代 ref_jcr，否则旧的 2023–2024 分区会一直挡住 2026 的数据。
   * 官方条目（reference !== true）永远不会被删。
   */
  if (entry.reference === true && entry.catalogKey !== 'ref_jcr') {
    catalogs = catalogs.filter((c) => c.catalogKey !== 'ref_jcr');
  }

  // 导入的是「非 SSCI」条目时，清掉同一目录下其它版次遗留的 SSCI 标记，
  // 否则某个旧版次留下的 ssciIndexed=true 会让新导入的 SCIE 标注失效。
  if ((entry.catalogKey === 'ssci_list' || entry.catalogKey === 'ssci_jcr') && entry.ssciIndexed === false) {
    catalogs = catalogs.map((c) =>
      (c.catalogKey === 'ssci_list' || c.catalogKey === 'ssci_jcr') ? { ...c, ssciIndexed: false } : c);
  }

  const jcr = j ? store.parseJson(j.jcr, null) : null;
  const cas = j ? store.parseJson(j.cas, null) : null;

  /*
   * 分区数据的覆盖规则：
   *   官方 覆盖 参考
   *   官方 不被参考覆盖
   *   参考 可以覆盖参考，但只在「年份更新」时（否则随程序附带的旧参考值
   *   会一直挡住你后来导入的更新年份截图，导致界面显示过期分区）
   */
  const yearNum = (v) => {
    const m = String(v == null ? '' : v).match(/(19|20)\d{2}/g);
    return m ? Math.max(...m.map(Number)) : 0;
  };
  const shouldWrite = (existing, incoming) => {
    const incomingIsRef = Boolean(entry.reference);
    const existingIsOfficial = existing && existing.reference !== true;
    if (!existing) return true;
    if (!incomingIsRef) return true;                    // 官方总是可写
    if (existingIsOfficial) return false;               // 参考不得覆盖官方
    return yearNum(entry.jcrYear || entry.year) >= yearNum(existing.year); // 参考之间按年份取新
  };

  let newJcr = jcr;
  if (entry.jcrCategories && entry.jcrCategories.length) {
    if (shouldWrite(jcr, entry)) {
      newJcr = {
        year: entry.jcrYear || entry.year, categories: entry.jcrCategories,
        source: entry.source, verified: !entry.reference, reference: Boolean(entry.reference),
        basis: entry.basis, catalogKey: entry.catalogKey,
        evidenceStatus: entry.evidenceStatus || null, sourceUrl: entry.sourceUrl || null,
      };
    }
  }
  let newCas = cas;
  if (entry.casZone) {
    const casShould = !(entry.reference && cas && cas.reference !== true);
    if (casShould) {
      newCas = {
        year: entry.casYear || entry.year, zone: entry.casZone, category: entry.casCategory,
        isTop: entry.isTop, source: entry.source, verified: !entry.reference,
        reference: Boolean(entry.reference), basis: entry.basis, catalogKey: entry.catalogKey,
      };
    }
  }

  // 只要存在一条「官方目录」条目就算已核验；全部是参考名录 ⇒ 0。
  // 提到 if/else 之外，因为更新与新建两条路径都要用它。
  const officialCount = catalogs.filter((c) => c.reference !== true).length;
  const willConfirmSsci = officialCount > 0
    && (entry.catalogKey === 'ssci_list' || entry.catalogKey === 'ssci_jcr')
    && entry.ssciIndexed !== false;

  const inWhitelist = entry.catalogKey === 'whitelist' ? 1 : (j?.in_whitelist || 0);
  const inBlacklist = entry.catalogKey === 'blacklist' ? 1 : (j?.in_blacklist || 0);
  const nameVariants = j ? store.parseJson(j.name_variants, []) : [];
  if (name && !nameVariants.includes(name) && j && j.name !== name) nameVariants.push(name);

  if (j) {
    // verified 必须完全由目录数据推算，不能沿用旧值，
    // 否则早期版本留下的 verified=1 会一直粘着。
    store.run(
      `UPDATE journals SET name = COALESCE(NULLIF(?,''), name), issn = COALESCE(?, issn),
         language = COALESCE(?, language), publisher = COALESCE(?, publisher),
         catalogs = ?, jcr = ?, cas = ?, verified = ?,
         in_whitelist = ?, in_blacklist = ?, name_variants = ?, last_checked = ?
       WHERE id = ?`,
      [name || '', issn || null, language || null, entry.publisher || null,
       JSON.stringify(catalogs), newJcr ? JSON.stringify(newJcr) : null, newCas ? JSON.stringify(newCas) : null,
       officialCount > 0 ? 1 : 0,
       inWhitelist, inBlacklist, JSON.stringify(nameVariants), store.nowIso(), j.id]);
    stats.updatedJournals++;
  } else if (name || issn) {
    store.run(
      // 14 列 14 占位符：verified 与 ssci_confirmed 都必须显式写入，
      // 否则导入官方 SSCI 目录新建的期刊不会被确认为 SSCI，论文也就无法判为合格
      `INSERT INTO journals(name, name_variants, issn, language, publisher, catalogs, jcr, cas, verified, ssci_confirmed, in_whitelist, in_blacklist, source, last_checked)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name || (issn ? '(仅 ISSN ' + issn + ')' : ''), JSON.stringify(nameVariants), issn || null,
       language || (N.cjkRatio(name) >= 0.3 ? 'zh' : 'en'), entry.publisher || null,
       JSON.stringify(catalogs), newJcr ? JSON.stringify(newJcr) : null, newCas ? JSON.stringify(newCas) : null,
       officialCount > 0 ? 1 : 0,
       // SSCI 收录确认：官方 ssci_list / ssci_jcr 条目且标注为 SSCI
       willConfirmSsci ? 1 : 0,
       inWhitelist, inBlacklist, entry.source, store.nowIso()]);
    stats.createdJournals++;
  }
}

/* ------------------------------------------------------------------ *
 * 目录加载状态（数据源覆盖 / 最后更新时间 / 失败状态）
 * ------------------------------------------------------------------ */

// 目录加载状态属于「这台机器的运行数据」，必须放在 data/ 下。
// 之前写在 catalogs/（仓库目录）里，导致跑测试时会用 LITDESK_DATA_DIR 隔离数据库、
// 却把真实的目录加载状态覆盖掉——测试数据会污染正式状态。
const LOADS_FILE = path.join(require('./config').DATA_DIR, 'catalog-loads.json');
// 兼容旧位置：首次运行时把 catalogs/loads.json 的内容迁过来
const LEGACY_LOADS_FILE = path.join(CATALOG_DIR, 'loads.json');

function recordCatalogLoad(catalogKey, info) {
  const all = readLoads();
  all[catalogKey] = {
    ...(all[catalogKey] || {}),
    ...info,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(LOADS_FILE, JSON.stringify(all, null, 2), 'utf8');
}

function readLoads() {
  try { return JSON.parse(fs.readFileSync(LOADS_FILE, 'utf8')); }
  catch {
    // 迁移旧文件（只读一次，不删除原文件，便于对照）
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_LOADS_FILE, 'utf8'));
      // 旧文件里可能混有测试写入的条目，迁移时剔除明显是测试来源的
      const cleaned = {};
      for (const [k, v] of Object.entries(legacy)) {
        if (/测试/.test(String(v?.sourceName || ''))) continue;
        cleaned[k] = v;
      }
      fs.writeFileSync(LOADS_FILE, JSON.stringify(cleaned, null, 2), 'utf8');
      return cleaned;
    } catch { return {}; }
  }
}

/**
 * 按目录数据重算每本期刊的 verified 与 ssci_confirmed。
 * 用于修复历史数据（早期版本可能留下与目录不一致的 verified 标记）。
 */
function reconcileJournalFlags() {
  const rows = store.all('SELECT * FROM journals');
  let verifiedFixed = 0, ssciFixed = 0;
  store.tx(() => {
    for (const j of rows) {
      const catalogs = store.parseJson(j.catalogs, []);
      const official = catalogs.filter((c) => c.reference !== true);
      const wantVerified = official.length > 0 ? 1 : 0;

      // SSCI 收录确认只看官方目录条目，且条目标注为 SSCI
      // （标了 SCIE / ESCI / A&HCI 的刊不算已确认 SSCI；参考名录也不算）
      const ssciOfficial = official.some((c) =>
        (c.catalogKey === 'ssci_list' || c.catalogKey === 'ssci_jcr') && c.ssciIndexed !== false);
      const wantSsci = ssciOfficial ? 1 : 0;

      if (j.verified !== wantVerified || j.ssci_confirmed !== wantSsci) {
        if (j.verified !== wantVerified) verifiedFixed++;
        if (j.ssci_confirmed !== wantSsci) ssciFixed++;
        store.run('UPDATE journals SET verified = ?, ssci_confirmed = ? WHERE id = ?',
          [wantVerified, wantSsci, j.id]);
      }
    }
  });
  return { journals: rows.length, verifiedFixed, ssciFixed };
}

function catalogStatus() {
  const loads = readLoads();
  const counts = store.all(`SELECT COUNT(*) c FROM journals WHERE verified = 1`)[0]?.c || 0;
  const byType = {};
  for (const [k, def] of Object.entries(CATALOG_TYPES)) {
    const loaded = loads[k] || null;
    const rowsAll = store.all('SELECT catalogs FROM journals WHERE catalogs LIKE ?', [`%"catalogKey":"${k}"%`]);
    let n = 0, nReference = 0;
    for (const r of rowsAll) {
      for (const c of store.parseJson(r.catalogs, [])) {
        if (c.catalogKey !== k) continue;
        if (c.reference === true) nReference++; else n++;
      }
    }
    byType[k] = {
      key: k,
      label: def.label,
      hint: def.hint,
      fields: def.fields,
      required: def.required,
      loaded: Boolean(loaded),
      journals: n,
      referenceJournals: nReference,
      edition: loaded?.edition || null,
      at: loaded?.at || null,
      rows: loaded?.rows || 0,
      coverage: !loaded ? '未导入'
        : (k.startsWith('ref_')
            ? `参考候选 ${nReference} 刊 / 导入 ${loaded.rows || 0} 行（${loaded.edition || '未标版次'}）—— 不计入「期刊条件合格」`
            : `官方目录已核验 ${n} 刊 / 导入 ${loaded.rows || 0} 行（${loaded.edition || '未标版次'}）`),
      lastUpdate: loaded?.at || null,
      status: loaded ? 'ok' : 'missing',
    };
  }
  return {
    verifiedJournals: counts,
    totalJournals: store.all('SELECT COUNT(*) c FROM journals')[0]?.c || 0,
    catalogs: byType,
    note: 'CSSCI / 北大核心 / SSCI-JCR / 中科院分区均需机构权限，本工作台不代为猜测，请导入官方目录 CSV。',
  };
}

/**
 * 载入【参考分区名录】（可选，需用户在界面明确启用）。
 * 与 loadSeedReference 的区别：这里会写入 JCR 分区并把期刊标为 verified=1，
 * 因此必须在界面上显式触发，并在每条记录里写明它是参考数据而非官方目录。
 */
function loadJcrReference() {
  const file = path.join(CATALOG_DIR, 'jcr-reference-2026-09.json');
  if (!fs.existsSync(file)) return { ok: false, error: '参考分区名录缺失' };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const year = data.依据年份 || data.版本 || '未标年份';
  const sourceName = `参考分区名录(${data.版本})·非官方目录`;
  const headers = ['期刊名称', 'ISSN', 'JCR年份', 'JCR学科类别1', '分区1', 'JCR学科类别2', '分区2', 'JCR学科类别3', '分区3'];
  const rows = [headers];
  for (const j of data.journals || []) {
    const c = j.categories || [];
    rows.push([
      j.name, j.issn || '', year,
      c[0]?.name || '', c[0]?.quartile || '',
      c[1]?.name || '', c[1]?.quartile || '',
      c[2]?.name || '', c[2]?.quartile || '',
    ]);
  }
  const r = importCatalog('ref_jcr', toCsv(rows), {
    edition: `参考数据 ${year}`, year, sourceName, verified: true, reference: true,
  });
  /*
   * 把「参考分区名录」的分区写进 journals.jcr，供界面显示。
   *
   * 铁律：参考数据绝不能覆盖或降级官方数据。
   *   · 若已有官方 jcr（reference !== true），保持原样不动；
   *   · 只改写 ref_jcr 条目本身，绝不能碰 ssci_jcr 之类的官方条目
   *     （早期版本会把官方 ssci_jcr 条目改写成 reference:true，
   *      导致载入参考名录后官方合格的刊被降级成「参考候选」——已修正）。
   */
  if (r.ok) {
    const names = (data.journals || []).map((j) => N.normalizeIssn(j.issn)).filter(Boolean);
    const byIssn = new Map((data.journals || []).map((x) => [N.normalizeIssn(x.issn), x]));
    store.tx(() => {
      for (const issn of names) {
        const jr = store.get('SELECT * FROM journals WHERE issn = ?', [issn]);
        if (!jr) continue;
        const cats = store.parseJson(jr.jcr, null);
        const existingIsOfficial = cats && cats.reference !== true;

        if (!existingIsOfficial) {
          const src = byIssn.get(issn);
          const categories = (src?.categories || []).map((c) => ({ name: c.name, quartile: c.quartile }));
          if (categories.length) {
            store.run('UPDATE journals SET jcr = ? WHERE id = ?', [JSON.stringify({
              year, categories, source: sourceName, verified: false, reference: true,
              basis: `参考分区名录 ${year}（非官方目录）`, catalogKey: 'ref_jcr',
            }), jr.id]);
          }
        }

        // 只清理/标注 ref_jcr 条目自身，官方条目一律保持原样
        const cList = store.parseJson(jr.catalogs, []).map((c) =>
          c.catalogKey === 'ref_jcr' ? { ...c, reference: true, source: sourceName, year } : c);
        store.run('UPDATE journals SET catalogs = ? WHERE id = ?', [JSON.stringify(cList), jr.id]);
      }
    });
  }
  return {
    ok: r.ok, ...r, 版本: data.版本, 依据年份: year, 期刊数: (data.journals || []).length,
    重要提示: data._重要,
    note: '已按【参考分区名录】写入分区。这些结论来自公开的领域常识性判断，不是官方 JCR 目录；相关论文会标注「参考分区（非官方目录）」。请自行抽查或导入官方目录覆盖。',
  };
}

function loadSeedReference() {
  const file = path.join(CATALOG_DIR, 'seed-reference-journals.json');
  if (!fs.existsSync(file)) return { ok: false, error: '参考表缺失' };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let added = 0, updated = 0;
  for (const j of data.journals || []) {
    const issn = N.normalizeIssn(j.issn);
    const exists = issn ? store.get('SELECT * FROM journals WHERE issn = ?', [issn]) : null;
    if (exists) {
      store.run(`UPDATE journals SET name_variants = ?, language = COALESCE(language, ?), last_checked = ? WHERE id = ?`,
        [JSON.stringify([...new Set([...store.parseJson(exists.name_variants, []), j.name])]), j.language, store.nowIso(), exists.id]);
      updated++;
      continue;
    }
    store.run(
      `INSERT INTO journals(name, name_variants, issn, language, publisher, catalogs, verified, source, last_checked)
       VALUES(?,?,?,?,?,?,0,?,?)`,
      [j.name, JSON.stringify([]), issn, j.language || null, j.publisher || null, '[]',
       `参考识别表(${data.版本})${j.verified_metadata ? ' · ISSN/刊名已核验' : ' · 待核验'}`,
       data.核验日期 || store.nowIso()]);
    added++;
  }
  return { ok: true, added, updated, total: (data.journals || []).length, 版本: data.版本, 核验日期: data.核验日期 };
}

/**
 * 从磁盘上的文件批量导入目录（参考候选或官方目录）。
 * @param {{files:Array<{path:string, catalogKey:string, edition?:string, sourceName?:string, reference?:boolean|'auto'}>}} opts
 */
function importCatalogFile({ files }) {
  const results = [];
  for (const f of files || []) {
    try {
      if (!fs.existsSync(f.path)) { results.push({ ...f, ok: false, error: '文件不存在' }); continue; }
      const text = fs.readFileSync(f.path, 'utf8');
      const r = importCatalog(f.catalogKey, text, {
        edition: f.edition, year: f.year || f.edition,
        sourceName: f.sourceName || path.basename(f.path),
        reference: f.reference === undefined ? 'auto' : f.reference,
      });
      if (r.ok) {
        // 参考候选目录也登记加载状态，否则界面会显示成「未导入」
        recordCatalogLoad(f.catalogKey, {
          edition: f.edition || f.year || '未标版次',
          year: f.year || f.edition || '',
          sourceName: f.sourceName || path.basename(f.path),
          rows: r.stats?.imported || 0,
          reference: f.reference !== false,
          file: path.basename(f.path),
          at: new Date().toISOString(),
        });
      }
      results.push({ ...f, ok: r.ok, stats: r.stats, ssciConfirmed: r.ssciConfirmed, ssciExcluded: r.ssciExcluded, error: r.error });
    } catch (e) {
      results.push({ ...f, ok: false, error: e.message });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

/**
 * 数据一致性修复：让 journals.jcr / cas 与 catalogs 条目保持一致。
 *
 * 多次「参考数据 → 官方数据 → 更新的参考数据」交替导入之后，
 * jcr 字段和 catalogs 里的条目可能指向不同年份。
 * 这里统一按优先级重建：
 *   官方条目（reference !== true） 优先；同为官方或同为参考时取年份更新者。
 * 界面上的分区一律来自这个字段，因此必须与条目一致。
 */
function reconcileJcrFromCatalogs() {
  const yearNum = (v) => {
    const m = String(v == null ? '' : v).match(/(19|20)\d{2}/g);
    return m ? Math.max(...m.map(Number)) : 0;
  };
  const rows = store.all('SELECT * FROM journals');
  let fixedJcr = 0, fixedCas = 0;
  store.tx(() => {
    for (const j of rows) {
      const cats = store.parseJson(j.catalogs, []);
      const withJcr = cats.filter((c) => Array.isArray(c.jcrCategories) && c.jcrCategories.length);
      const withCas = cats.filter((c) => c.casZone);

      const best = (list, isCas) => {
        if (!list.length) return null;
        const scored = list.map((c) => ({
          c,
          official: c.reference !== true ? 1 : 0,
          year: yearNum(c.jcrYear || c.casYear || c.year),
        }));
        scored.sort((a, b) => (b.official - a.official) || (b.year - a.year));
        const c = scored[0].c;
        return isCas
          ? { year: c.casYear || c.year, zone: c.casZone, category: c.casCategory, isTop: c.isTop,
              source: c.source, verified: c.reference !== true, reference: c.reference === true,
              basis: c.basis, catalogKey: c.catalogKey }
          : { year: c.jcrYear || c.year, categories: c.jcrCategories, source: c.source,
              verified: c.reference !== true, reference: c.reference === true,
              basis: c.basis, catalogKey: c.catalogKey,
              evidenceStatus: c.evidenceStatus || null, sourceUrl: c.sourceUrl || null };
      };

      const wantJcr = best(withJcr, false);
      const wantCas = best(withCas, true);
      const curJcr = store.parseJson(j.jcr, null);
      const curCas = store.parseJson(j.cas, null);
      const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

      if (!same(curJcr, wantJcr)) {
        store.run('UPDATE journals SET jcr = ? WHERE id = ?', [wantJcr ? JSON.stringify(wantJcr) : null, j.id]);
        fixedJcr++;
      }
      if (!same(curCas, wantCas)) {
        store.run('UPDATE journals SET cas = ? WHERE id = ?', [wantCas ? JSON.stringify(wantCas) : null, j.id]);
        fixedCas++;
      }
    }
  });
  return { journals: rows.length, fixedJcr, fixedCas };
}

/* ------------------------------------------------------------------ *
 * 查询与判定
 * ------------------------------------------------------------------ */

function findJournal({ issn, name }) {
  const i = N.normalizeIssn(issn);
  if (i) {
    const byIssn = store.get('SELECT * FROM journals WHERE issn = ?', [i]);
    if (byIssn) return byIssn;
  }
  if (name) {
    const target = N.cleanJournalNameForMatch(name);
    if (target) {
      const candidates = store.all('SELECT * FROM journals');
      const hit = candidates.find((x) => {
        if (N.cleanJournalNameForMatch(x.name) === target) return true;
        const variants = store.parseJson(x.name_variants, []);
        return variants.some((v) => N.cleanJournalNameForMatch(v) === target);
      });
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 把 journals 行整理成结构化资格结论。
 *
 * 规则（按你的要求严格执行）：
 *   中文刊：CSSCI 来源期刊 或《中文核心期刊要目总览》收录 ⇒ 合格。
 *           CSSCI 扩展版默认不算（可在设置里开关）。
 *   英文刊：必须【已确认 SSCI 收录】，并且【JCR Q1–Q3 或 中科院 1–3 区】之一。
 *           仅仅有中科院分区、无法确认 SSCI 收录时 ⇒ 待核验。
 *
 * 官方目录与参考名录严格分开：
 *   · 只有来自你导入的官方目录（catalogKey 且 reference !== true）才算「已核验」；
 *   · 参考名录只能给出「参考候选」，绝不产生 eligible，也不计入首页合格数；
 *   · 两者都没有 ⇒ 待核验。
 */
function eligibilityOf(journalRow, settings) {
  const s = settings || require('./config').getSettings();

  if (!journalRow) {
    return {
      status: 'pending', basis: 'pending', officialEligible: false,
      note: '期刊未在本地目录中匹配到，无法核实 CSSCI／北大核心／SSCI 收录与分区，已列入「待核验候选」。',
      tags: [], required: false, reasons: [], missing: ['未匹配到任何目录记录'],
    };
  }

  const catalogs = store.parseJson(journalRow.catalogs, []);
  const jcr = store.parseJson(journalRow.jcr, null);
  const cas = store.parseJson(journalRow.cas, null);
  const language = journalRow.language || (N.cjkRatio(journalRow.name) > 0.3 ? 'zh' : 'en');
  const isChinese = language === 'zh';

  if (journalRow.in_blacklist) {
    return {
      status: 'excluded', basis: 'excluded', officialEligible: false,
      note: '该刊在你的排除名单中，不会进入简报。',
      tags: [{ type: 'blacklist', text: '已排除', verified: true, kind: 'blacklist' }],
      required: false, reasons: [], missing: [],
    };
  }

  // 目录条目分为「官方已核验」与「参考名录」两类
  const official = catalogs.filter((c) => c.reference !== true);
  const reference = catalogs.filter((c) => c.reference === true);
  const pick = (key) => official.filter((c) => c.catalogKey === key);
  const pickRef = (key) => reference.filter((c) => c.catalogKey === key);

  const jcrIsReference = Boolean(jcr?.reference) || (pickRef('ssci_jcr').length > 0 && pick('ssci_jcr').length === 0);
  const casIsReference = Boolean(cas?.reference);

  const tags = [];
  const reasons = [];
  const missing = [];
  let officialEligible = false;
  let referenceEligible = false;

  const catalogTag = (c, type, text) => ({
    type, text, verified: c.reference !== true,
    reference: c.reference === true, kind: c.reference === true ? 'reference' : 'official',
    catalog: c.catalog, edition: c.edition || null, year: c.year || null,
    basis: c.basis || null, source: c.source || null, importedAt: c.importedAt || null,
    evidenceStatus: c.evidenceStatus || null, sourceUrl: c.sourceUrl || null,
    screenshotRow: c.screenshotRow || null, jif: c.jif || null,
    status: c.reference === true ? '参考候选（未经官方核验）' : '官方目录已核验',
  });

  if (isChinese) {
    const cssci = pick('cssci');
    const cssciRef = [...pickRef('cssci'), ...pickRef('ref_cssci')];
    const cssciExt = pick('cssci_ext');
    const cssciExtRef = pickRef('ref_cssci_ext');
    const core = pick('cn_core');

    for (const c of cssci) {
      tags.push(catalogTag(c, 'cssci', `CSSCI 来源期刊${c.edition ? '（' + c.edition + '）' : ''}`));
      officialEligible = true;
      reasons.push(`CSSCI 来源期刊目录${c.edition ? '（' + c.edition + '）' : ''}收录`);
    }
    for (const c of cssciExt) {
      const accepted = Boolean(s.acceptCssoExtended);
      tags.push({ ...catalogTag(c, 'cssci_ext', `CSSCI 扩展版${c.edition ? '（' + c.edition + '）' : ''}`), accepted });
      if (accepted) { officialEligible = true; reasons.push('CSSCI 扩展版（你已开启接受扩展版）'); }
      else missing.push('CSSCI 扩展版按你的规则不算来源期刊');
    }
    for (const c of core) {
      tags.push(catalogTag(c, 'cn_core', `北大核心${c.edition ? '（' + c.edition + '）' : ''}`));
      officialEligible = true;
      reasons.push(`《中文核心期刊要目总览》${c.edition || ''}收录`);
    }
    for (const c of cssciRef) {
      tags.push({
        ...catalogTag(c, 'cssci', `CSSCI 来源期刊（参考候选）${c.edition ? '（' + c.edition + '）' : ''}`),
        evidenceStatus: c.evidenceStatus || null, sourceUrl: c.sourceUrl || null,
      });
      referenceEligible = true;
      reasons.push(`参考候选清单显示该刊可能是 CSSCI 来源期刊${c.edition ? '（' + c.edition + '）' : ''}，但未经官方核验`);
    }
    for (const c of cssciExtRef) {
      tags.push({
        ...catalogTag(c, 'cssci_ext', `CSSCI 扩展版（参考候选）${c.edition ? '（' + c.edition + '）' : ''}`),
        evidenceStatus: c.evidenceStatus || null, sourceUrl: c.sourceUrl || null,
      });
      const accepted = Boolean(s.acceptCssoExtended);
      if (accepted) { referenceEligible = true; reasons.push('参考候选显示为 CSSCI 扩展版（你已开启接受扩展版，但仍未经官方核验）'); }
      else missing.push('参考候选显示为 CSSCI 扩展版，按你的规则不算来源期刊，且未经官方核验');
    }
    if (!cssci.length && !core.length && !cssciExt.length && !cssciRef.length) {
      missing.push('未在 CSSCI／北大核心目录中匹配到该刊');
    }
  } else {
    // ---------- 英文刊 ----------
    // SSCI 收录确认只看当前官方目录条目（ssciIndexed !== false）。
    // 不使用 journals.ssci_confirmed，因为它可能是历史导入留下的陈旧标记；
    // 该列只作为「是否有过 SSCI 官方条目」的辅助展示。
    const ssciOfficial = pick('ssci_list').some((c) => c.ssciIndexed !== false) ||
      pick('ssci_jcr').some((c) => c.ssciIndexed !== false);
    const refSsci = pickRef('ref_ssci');
    const refEsci = pickRef('ref_esci');
    const ssciReference = pickRef('ssci_list').length > 0 || pickRef('ssci_jcr').length > 0
      || pickRef('ref_jcr').length > 0 || refSsci.length > 0 || jcrIsReference;

    // JCR 分区：官方条目的分区存放在 jcr 字段；参考名录存放在 ref_jcr 条目里。
    // 只有当 jcr 字段确实来自官方目录时才能当作合格依据。
    /*
     * 官方条目优先，且必须真正压过参考条目。
     * 早期写法用 `refSsci.length > 0` 就当参考，结果同一本刊
     * 既有官方 SSCI 目录、又有截图参考清单时，官方结论被参考结论顶掉，
     * 明明已核验却永远显示「参考候选」。
     */
    const officialJcrEntry = pick('ssci_jcr')[0] || null;
    // 参考分区：只在没有官方条目时才用，且取年份最新的一条
    const refEntriesWithYear = [...pickRef('ref_jcr'), ...pickRef('ref_ssci'), ...pickRef('ssci_jcr'), ...pickRef('ref_esci')]
      .map((c) => ({ c, y: Number((String(c.year || c.edition || '').match(/(19|20)\d{2}/g) || [0]).slice(-1)[0]) || 0 }))
      .sort((a, b) => b.y - a.y);
    const refJcrEntry = officialJcrEntry ? null : (refEntriesWithYear.length ? refEntriesWithYear[0].c : null);
    const jcrIsOfficial = Boolean(officialJcrEntry) && jcr?.reference !== true && jcr?.catalogKey !== 'ref_jcr';
    const cats = (jcrIsOfficial && jcr?.categories && jcr.categories.length) ? jcr.categories
      : (officialJcrEntry?.jcrCategories || refJcrEntry?.jcrCategories || jcr?.categories || []);
    // 只有在完全没有官方条目时，分区才算参考来源
    const catsAreReference = !officialJcrEntry && !jcrIsOfficial && Boolean(refJcrEntry);
    const jcrYear = (jcrIsOfficial ? jcr?.year : null) || officialJcrEntry?.jcrYear || officialJcrEntry?.year
      || refJcrEntry?.year || refJcrEntry?.edition || jcr?.year || null;
    if (cats.length) {
      const qs = cats.map((c) => c.quartile);
      const inRange = qs.some((q) => ['Q1', 'Q2', 'Q3'].includes(q));
      const fromEsciOnly = !officialJcrEntry && !pickRef('ref_ssci').length && !pickRef('ref_jcr').length
        && !pickRef('ssci_jcr').length && refEsci.length > 0;
      // 官方条目存在时一律按官方结论处理
      const useReference = !officialJcrEntry && (catsAreReference || jcrIsReference || refSsci.length > 0 || fromEsciOnly);
      const jcrText = fromEsciOnly
        ? `ESCI（非 SSCI）JCR ${jcrYear || '年份未标'} ${cats.map((c) => `${c.quartile}·${c.name || '类别未标'}`).join(' / ')}`
        : `JCR ${jcrYear || '年份未标'} ${cats.map((c) => `${c.quartile}·${c.name || '类别未标'}`).join(' / ')}`;
      tags.push({
        type: 'jcr',
        text: jcrText,
        // 溯源必须显式：参考数据一律 kind='reference'，不能靠 verified 反推，
        // 否则「参考来源的 JCR 分区」会被渲染成官方实心色块。
        verified: !useReference, reference: useReference,
        kind: useReference ? 'reference' : 'official',
        onlyEsci: fromEsciOnly,
        year: jcrYear, categories: cats, quartiles: qs, inRange,
        catalog: 'JCR 分区',
        basis: (jcrIsOfficial ? jcr?.basis : null) || officialJcrEntry?.basis || refJcrEntry?.basis || null,
        source: (jcrIsOfficial ? jcr?.source : null) || officialJcrEntry?.source || refJcrEntry?.source || null,
        edition: officialJcrEntry?.edition || refJcrEntry?.edition || null,
      });
      if (inRange && ssciOfficial && !useReference) {
        officialEligible = true;
        reasons.push(`已确认 SSCI 收录，且 JCR 分区为 ${qs.join('/')}（Q1–Q3）`);
      } else if (fromEsciOnly) {
        missing.push('清单标注该刊为 ESCI 而非 SSCI；ESCI 期刊即使有 JCR 分区也不能判为英文合格');
      } else if (inRange && (useReference || ssciReference)) {
        referenceEligible = true;
        reasons.push(`参考候选清单显示 JCR 分区为 ${qs.join('/')}${refSsci.length ? '、标注为 SSCI' : ''}，但未经官方核验`);
      } else if (inRange) {
        missing.push('JCR 分区在 Q1–Q3，但无法确认该刊属于 SSCI 收录（JCR 也收录 SCIE 期刊）');
      } else {
        missing.push(`JCR 分区为 ${qs.join('/')}，不在 Q1–Q3 范围`);
      }
    } else if (ssciOfficial || ssciReference) {
      const esciOnly = !ssciOfficial && !refSsci.length && refEsci.length > 0;
      tags.push({
        type: 'ssci',
        text: esciOnly ? 'ESCI（参考候选，非 SSCI）'
          : (ssciOfficial ? 'SSCI 收录（分区未录入）' : 'SSCI（参考候选，分区未录入）'),
        verified: ssciOfficial, reference: !ssciOfficial, kind: ssciOfficial ? 'official' : 'reference',
        catalog: 'SSCI 收录', source: pick('ssci_list')[0]?.source || pick('ssci_jcr')[0]?.source || pickRef('ssci_jcr')[0]?.source || null,
      });
      if (esciOnly) {
        missing.push('参考候选清单标注该刊为 ESCI，不是 SSCI，不能判为英文合格');
      } else {
        if (!ssciOfficial && refSsci.length) referenceEligible = true;
        missing.push(ssciOfficial ? '已确认 SSCI 收录，但未录入 JCR 分区，无法判定 Q1–Q3' : '参考候选显示可能为 SSCI，分区未录入，无法判定');
      }
    } else {
      missing.push('未在 SSCI／JCR 目录中匹配到该刊，无法确认 SSCI 收录');
    }

    // 中科院分区（独立判定，不产生「综合等级」）
    if (cas) {
      const zoneNum = parseInt(String(cas.zone).replace(/[^\d]/g, ''), 10);
      const zoneLabel = Number.isFinite(zoneNum) ? zoneNum : null;
      const casOfficial = !casIsReference && cas.verified !== false;
      tags.push({
        type: 'cas',
        text: `中科院${cas.year || '年份未标'} ${cas.zone}${cas.category ? '·' + cas.category : ''}${cas.isTop ? ' Top' : ''}`,
        verified: casOfficial, reference: casIsReference,
        kind: casOfficial ? 'official' : 'reference',
        year: cas.year || null, zone: cas.zone, category: cas.category || null,
        historical: true, catalog: '中科院期刊分区表（历史数据）',
        basis: cas.basis || null, source: cas.source || null,
      });
      const inRange = zoneLabel && zoneLabel >= 1 && zoneLabel <= 3;
      if (inRange && ssciOfficial) {
        officialEligible = true;
        reasons.push(`已确认 SSCI 收录，且中科院分区为 ${cas.zone}（${cas.year || '年份未标'}，该表 2026 年起不再更新）`);
      } else if (inRange && ssciReference) {
        referenceEligible = true;
        reasons.push(`参考名录显示中科院分区为 ${cas.zone}`);
      } else if (inRange) {
        // 关键规则：只有中科院分区、无法确认 SSCI 收录 ⇒ 待核验
        missing.push(`中科院分区为 ${cas.zone}（在 1–3 区），但无法确认该刊被 SSCI 收录；按你的规则必须先确认 SSCI 收录，因此暂列待核验`);
      } else if (zoneLabel) {
        missing.push(`中科院分区为 ${cas.zone}，不在 1–3 区范围`);
      }
    } else if (ssciOfficial || ssciReference) {
      missing.push('未录入中科院分区（该表 2026 年起不再更新，只能用可核实的历史数据）');
    }
  }

  if (journalRow.in_whitelist) {
    tags.push({ type: 'whitelist', text: '特别关注期刊', verified: true, kind: 'custom', catalog: '你的特别关注名单' });
  }

  let status, basis;
  if (officialEligible) { status = 'eligible'; basis = 'official'; }
  else if (referenceEligible) { status = 'reference'; basis = 'reference'; }
  else { status = 'pending'; basis = 'pending'; }

  const noteParts = [];
  if (status === 'eligible') {
    noteParts.push('期刊条件满足（官方目录已核验）：' + reasons.join('；'));
  } else if (status === 'reference') {
    noteParts.push('参考候选（非官方目录）：' + reasons.join('；'));
    // 注意：note 会经 esc() 原样显示，不能写 Markdown 的 ** 标记
    noteParts.push('这些结论来自非官方参考线索（随程序附带的参考名录，或你导入的截图清单），不是官方目录。'
      + '因此该刊的论文：可以进入主题优先的今日简报，但会醒目标注为「参考候选」；'
      + '不计入「期刊条件合格」数量，也不会进入「期刊条件合格精选」页。');
  } else {
    noteParts.push('期刊条件暂不能确认：' + (missing.length ? missing.join('；') : '目录信息不足'));
  }
  if (status === 'eligible' && tags.some((t) => t.reference)) {
    noteParts.push('注意：该刊同时存在参考名录记录，但合格结论来自官方目录');
  }

  return {
    status, basis, officialEligible,
    referenceOnly: status === 'reference',
    note: noteParts.join('。'),
    tags,
    required: status === 'eligible',
    language: isChinese ? 'zh' : 'en',
    reasons, missing,
    verifiedCatalog: official.length > 0,
    hasOfficial: official.length > 0,
    hasReference: reference.length > 0,
    journalId: journalRow.id,
    journalName: journalRow.name,
    jcr, cas,
  };
}

/** 是否计入「期刊条件合格」统计（参考候选不算） */
function countsAsEligible(info) {
  return Boolean(info && info.status === 'eligible' && info.basis === 'official');
}

/* ------------------------------------------------------------------ *
 * 模板
 * ------------------------------------------------------------------ */

/**
 * 修复 papers.eligibility_note 的口径漂移。
 *
 * eligibility_note 是**发现时**写进 papers 表的冗余副本。资格判定的措辞一旦修改，
 * 老论文里留着的仍是旧说法——「今日简报进不进」这类表述尤其容易被读反。
 * 这里按当前逻辑重算，只在文本确实不同时写回，因此可以安全地反复执行。
 *
 * @returns {{scanned:number, repaired:number}}
 */
function refreshStoredEligibilityNotes(settings) {
  const s = settings || {};
  const rows = store.all(
    "SELECT id, eligibility, eligibility_note FROM papers WHERE eligibility_note IS NOT NULL AND eligibility_note != ''"
  );
  // 期刊行按论文 id 缓存，避免每篇论文各查一次
  const paperRows = store.all(
    'SELECT p.id AS pid, j.id AS jid, j.name AS name, j.issn AS issn, j.* FROM papers p LEFT JOIN journals j ON j.id = p.journal_id'
  );
  const byPid = new Map(paperRows.map((r) => [r.pid, r]));

  let repaired = 0;
  store.tx(() => {
    for (const row of rows) {
      const jrow = byPid.get(row.id);
      // LEFT JOIN 未命中时 j.id 为 null；此时 eligibilityOf(null) 会给出「未匹配」的口径
      const hasJournal = Boolean(jrow && jrow.jid != null);
      const info = eligibilityOf(hasJournal ? jrow : null, s);
      const fresh = info.note || '';
      if (fresh && fresh !== row.eligibility_note) {
        store.run('UPDATE papers SET eligibility_note = ? WHERE id = ?', [fresh, row.id]);
        repaired++;
      }
    }
  });
  return { scanned: rows.length, repaired };
}

function templateCsv(catalogKey) {
  const def = CATALOG_TYPES[catalogKey];
  if (!def) return null;
  const rows = [def.fields];
  if (catalogKey === 'cssci') rows.push(['中国语文', '', '语言学', '2023-2024年版', '否', '示例行，导入前请删除']);
  if (catalogKey === 'cn_core') rows.push(['中国语文', '', '语言学', '2023年版（第10版）', '中国社会科学院语言研究所', '示例行，导入前请删除']);
  if (catalogKey === 'ssci_jcr') rows.push(['Applied Linguistics', '0142-6001', '2024', 'LINGUISTICS', 'Q1', 'EDUCATION & EDUCATIONAL RESEARCH', 'Q1', '', '', 'SSCI', 'Oxford University Press', '示例行，导入前请删除']);
  if (catalogKey === 'ssci_list') rows.push(['Applied Linguistics', '0142-6001', '2024', 'LINGUISTICS', 'SSCI', 'Oxford University Press', '示例行，导入前请删除']);
  if (catalogKey === 'cas') rows.push(['Applied Linguistics', '0142-6001', '2023', '1区', '教育学', '1区', '语言学', '否', '中科院2023年历史数据，示例行']);
  if (catalogKey === 'cssci_ext') rows.push(['当代修辞学', '', '语言学', '2023-2024年版', '示例行，导入前请删除']);
  if (catalogKey === 'whitelist') rows.push(['国际中文教育（中英文）', '', '重点关注']);
  if (catalogKey === 'blacklist') rows.push(['示例刊名', '', '非学术或掠夺性出版']);
  return toCsv(rows);
}

module.exports = {
  CATALOG_TYPES, parseCsv, toCsv, importCatalog, catalogStatus,
  loadSeedReference, loadJcrReference, findJournal, eligibilityOf, countsAsEligible,
  reconcileJournalFlags, mergeDuplicateJournals, reconcileJcrFromCatalogs, templateCsv, readLoads, LOADS_FILE, importCatalogFile,
  refreshStoredEligibilityNotes,
};
