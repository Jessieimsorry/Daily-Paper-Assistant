'use strict';
/**
 * 规范化与去重：
 *  - DOI 规范化
 *  - 标题规范化（含中文标点、全角半角、Unicode 空白）
 *  - 期刊名称变体归一（用于中英文刊名变体合并）
 *  - 语言判定
 *  - 去重键生成
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

function stripDiacritics(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeDoi(doi) {
  if (!doi) return null;
  let d = String(doi).trim();
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  d = d.replace(/^doi:\s*/i, '');
  d = d.trim().toLowerCase();
  d = d.replace(/[.,;)\]]+$/, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(d)) return null;
  return d;
}

function normalizeIssn(issn) {
  if (!issn) return null;
  const s = String(issn).trim().toUpperCase().replace(/[^0-9X]/g, '');
  if (s.length !== 8) return null;
  return s.slice(0, 4) + '-' + s.slice(4);
}

/** 标题规范化：用于比较与去重，不用于展示 */
function normalizeTitle(title) {
  if (!title) return '';
  let t = String(title);
  t = t.replace(/<[^>]+>/g, ' ');              // 去掉 HTML/JATS 标签
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
  t = stripDiacritics(t).toLowerCase();
  // 全角转半角
  t = t.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 中文标点与常见分隔符统一
  t = t.replace(/[，。、；：？！“”‘’（）【】《》〈〉·—…,.;:?!"'()\[\]{}<>\-_/\\|~`@#$%^&*+=]/g, ' ');
  // 去掉中英常见副标题引导词
  t = t.replace(/\b(a|an|the)\b/g, ' ');
  t = t.replace(/[\s\u00a0\u2000-\u200b\u3000]+/g, ' ').trim();
  return t;
}

/** 期刊名归一：用于把 “Pragmatics & Cognition” / “Pragmatics and Cognition” 视为同一刊 */
const JOURNAL_ALIASES = new Map(Object.entries({
  'pragmatics & cognition': 'pragmatics and cognition',
  'pragmatics &amp; cognition': 'pragmatics and cognition',
  'the modern language journal': 'modern language journal',
  'applied linguistics': 'applied linguistics',
  'language teaching research': 'language teaching research',
  'journal of second language writing': 'journal of second language writing',
  'studies in second language acquisition': 'studies in second language acquisition',
  'computer assisted language learning': 'computer assisted language learning',
  'computers & education': 'computers and education',
  'computers &amp; education': 'computers and education',
  'british journal of educational technology': 'british journal of educational technology',
  'language learning & technology': 'language learning and technology',
  'language learning &amp; technology': 'language learning and technology',
  'journal of pragmatics': 'journal of pragmatics',
  'system': 'system',
  'reCALL': 'recall',
  'the language learning journal': 'language learning journal',
  'international journal of applied linguistics': 'international journal of applied linguistics',
  'irAL': 'iral',
  'zhongguo yuwen': '中国语文',
}));

function normalizeJournalName(name) {
  if (!name) return '';
  let n = String(name).trim();
  n = n.replace(/<[^>]+>/g, '');
  n = n.replace(/&amp;/g, '&');
  const lower = stripDiacritics(n).toLowerCase().replace(/\s+/g, ' ').trim();
  if (JOURNAL_ALIASES.has(lower)) return JOURNAL_ALIASES.get(lower);
  // 去掉末尾的 (Online) / (Print) / 版本后缀
  return lower.replace(/\s*\((online|print|electronic|internet)\)\s*$/i, '').trim();
}

function cjkRatio(s) {
  if (!s) return 0;
  const str = String(s).replace(/\s+/g, '');
  if (!str) return 0;
  const m = str.match(CJK_RE);
  return (m ? m.length : 0) / str.length;
}

/* ------------------------------------------------------------------ *
 * 语种判定
 *
 * 旧实现是「有中文标点/汉字 ⇒ zh，否则 ⇒ en」，等于把**拉丁字母直接等同英语**。
 * 真实误判：/paper/634 题名是印尼语
 *   KAJIAN PRAGMATIK KALIMAT EKSPRESIF NETIZEN PADA KOMENTAR TIKTOK …
 * 摘要是英文，Crossref 的 language 为空，于是被判成「英文」并进了英文候选。
 *
 * 现在改成三条原则：
 *   1. **不把拉丁字母等同英语**：拉丁文本要么找到具体语种证据，要么就是「待确认」；
 *   2. **题名语种与摘要语种分开判断**，绝不因为摘要是英文就把非英文论文写成英文；
 *   3. 没有足够证据时返回 unknown（界面显示「语种待确认」），不猜。
 * ------------------------------------------------------------------ */

/** 印尼语功能词与学科词（教育与语言学论文里高频出现，区分度高） */
const ID_MARKERS = [
  'kajian', 'kalimat', 'ekspresif', 'netizen', 'komentar', 'pada', 'dalam', 'yang', 'dan', 'untuk',
  'dengan', 'tidak', 'adalah', 'penelitian', 'ini', 'bahasa', 'siswa', 'guru', 'data', 'hasil',
  'dari', 'atau', 'juga', 'dapat', 'secara', 'antara', 'karena', 'tersebut', 'berbagai', 'oleh',
  'jurnal', 'pendidikan', 'sekolah', 'kelas', 'siswa', 'tindak', 'tutur', 'makna', 'penutur',
  'penulis', 'metode', 'analisis', 'kesimpulan', 'pembelajaran', 'mahasiswa', 'berdasarkan',
  'merupakan', 'sedangkan', 'namun', 'serta', 'salah', 'satu', 'dua', 'tiga', 'tahun', 'orang',
  'ke', 'di', 'apa', 'siapa', 'bagaimana', 'mengapa', 'kapan', 'dimana', 'sudah', 'belum',
];
const ID_MARKER_SET = new Set(ID_MARKERS);

/** 英语功能词 + 学术论文高频词 */
const EN_MARKERS = [
  'the', 'and', 'of', 'to', 'in', 'is', 'for', 'on', 'with', 'that', 'this', 'are', 'as', 'by',
  'study', 'students', 'teachers', 'language', 'english', 'research', 'data', 'analysis',
  'results', 'were', 'was', 'which', 'these', 'from', 'between', 'based', 'using', 'findings',
  'learners', 'education', 'teaching', 'learning', 'paper', 'article', 'however', 'therefore',
  'although', 'while', 'such', 'also', 'can', 'has', 'have', 'been', 'not', 'but', 'or', 'it',
  // 学术题名里高频、且极少出现在印尼语里的词：
  // 少了这批，「Emoji pragmatics」这类短英文题名会掉进「语种待确认」
  'pragmatics', 'pragmatic', 'syntax', 'phonology', 'semantics', 'morphology', 'discourse',
  'review', 'book', 'abstracts', 'abstract', 'development', 'capacity', 'organizational',
  'toward', 'towards', 'effect', 'effects', 'impact', 'case', 'perspective', 'perspectives',
  'approach', 'approaches', 'exploratory', 'instruction', 'intervention', 'acquisition',
  'competence', 'proficiency', 'assessment', 'identity', 'motivation', 'context', 'practice',
  'model', 'models', 'evidence', 'framework', 'challenges', 'opportunities', 'role',
  'a', 'an', 'at', 'into', 'through', 'during', 'after', 'before', 'under', 'over',
];
const EN_MARKER_SET = new Set(EN_MARKERS);

/** 拉丁字母文本切成小写词 */
function latinTokens(text) {
  const m = String(text || '').toLowerCase().match(/[a-zà-öø-ÿ]+/g);
  return m || [];
}

/** 统计某套标记命中的「不同词」数量与占比 */
function markerStats(tokens, markerSet) {
  const hits = new Set();
  for (const t of tokens) if (markerSet.has(t)) hits.add(t);
  const denom = Math.max(tokens.length, 4);   // 极短文本不放大占比
  return { hits: hits.size, ratio: hits.size / denom, sample: [...hits].slice(0, 6) };
}

/**
 * 判定一段文本（题名或摘要）的语种。
 * @returns {{language:string, confidence:'high'|'medium'|'low', evidence:string, hits?:object}}
 *          language: zh | en | id | other | unknown
 */
function detectLanguageDetailed(text, opts = {}) {
  const s = String(text || '').trim();
  if (!s) return { language: 'unknown', confidence: 'low', evidence: '没有可判断的文本' };

  // 1) 假名/谚文必须先判：日文标题里汉字占比可能很高（「日本語の談話分析」汉字占 88%），
  //    先看汉字就会把日文误判成中文。
  if (/[\u3040-\u30ff]/.test(s)) {
    return { language: 'other', confidence: 'high', evidence: '含日文假名' };
  }
  if (/[\uac00-\ud7af]/.test(s)) {
    return { language: 'other', confidence: 'high', evidence: '含韩文谚文' };
  }
  // 2) 文字系统：汉字占比高就是中文
  const cjk = cjkRatio(s);
  if (cjk >= 0.3) {
    return { language: 'zh', confidence: 'high', evidence: `汉字占比 ${(cjk * 100).toFixed(0)}%` };
  }
  if (cjk > 0.05) {
    return { language: 'zh', confidence: 'medium', evidence: `含汉字（占比 ${(cjk * 100).toFixed(0)}%）` };
  }
  // 3) 西里尔/阿拉伯/泰文等：标成 other
  if (/[\u0400-\u04ff]/.test(s)) {
    return { language: 'other', confidence: 'high', evidence: '含西里尔字母' };
  }
  if (/[\u0600-\u06ff]/.test(s)) {
    return { language: 'other', confidence: 'high', evidence: '含阿拉伯字母' };
  }

  // 4) 拉丁字母：必须找到具体语种证据，找不到就是「待确认」
  const tokens = latinTokens(s);
  if (!tokens.length) {
    return { language: 'unknown', confidence: 'low', evidence: '没有可判断的字母文本' };
  }
  const idSt = markerStats(tokens, ID_MARKER_SET);
  const enSt = markerStats(tokens, EN_MARKER_SET);

  const minHits = opts.shortText ? 1 : 2;
  const strong = (st) => st.hits >= minHits || st.ratio >= 0.34;

  if (idSt.hits > enSt.hits && strong(idSt)) {
    return {
      language: 'id', confidence: idSt.hits >= 3 ? 'high' : 'medium',
      evidence: `印尼语功能词命中 ${idSt.hits} 个（${idSt.sample.join('、')}）`, hits: { id: idSt.hits, en: enSt.hits },
    };
  }
  if (enSt.hits > idSt.hits && strong(enSt)) {
    return {
      language: 'en', confidence: enSt.hits >= 3 ? 'high' : 'medium',
      evidence: `英语功能词命中 ${enSt.hits} 个（${enSt.sample.join('、')}）`, hits: { id: idSt.hits, en: enSt.hits },
    };
  }
  // 拉丁字母但没有足够证据：不猜
  return {
    language: 'unknown', confidence: 'low',
    evidence: `拉丁字母文本，但未找到足够的语种证据（英语词 ${enSt.hits} / 印尼语词 ${idSt.hits}）`,
    hits: { id: idSt.hits, en: enSt.hits },
  };
}

/**
 * 兼容旧签名：只回语种字符串。
 * 注意：**不再默认返回 en**——没有证据就返回 unknown。
 */
function detectLanguage(title, journalName) {
  const r = detectLanguageDetailed(title, { shortText: true });
  if (r.language !== 'unknown') return r.language;
  if (!String(title || '').trim() && cjkRatio(journalName) >= 0.3) return 'zh';
  return 'unknown';
}

/** 来源给的语种代码规范化：Crossref/OpenAlex 常见取值 → 本工作台用的代码 */
const SOURCE_LANG_MAP = new Map(Object.entries({
  zh: 'zh', chi: 'zh', zho: 'zh', 'zh-cn': 'zh', 'zh-hans': 'zh', cmn: 'zh',
  en: 'en', eng: 'en', 'en-us': 'en', 'en-gb': 'en',
  id: 'id', ind: 'id', ina: 'id',
  ko: 'other', kor: 'other', ja: 'other', jpn: 'other', jv: 'other', jav: 'other',
  de: 'other', deu: 'other', ger: 'other', fr: 'other', fra: 'other', fre: 'other',
  es: 'other', spa: 'other', pt: 'other', por: 'other', ru: 'other', rus: 'other',
  ar: 'other', ara: 'other', th: 'other', tha: 'other', vi: 'other', vie: 'other',
  tr: 'other', tur: 'other', it: 'other', ita: 'other', nl: 'other', nld: 'other',
}));

/**
 * 规范化来源提供的语种代码。
 * 空值 / 未知代码一律返回 null（**不是** en），避免「空的当英语」。
 */
function normalizeSourceLanguage(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/_/g, '-');
  if (!s) return null;
  if (SOURCE_LANG_MAP.has(s)) return SOURCE_LANG_MAP.get(s);
  const base = s.split('-')[0];
  if (SOURCE_LANG_MAP.has(base)) return SOURCE_LANG_MAP.get(base);
  return null;   // 无法识别的代码不作数
}

/**
 * 决定论文的主语种，并把题名语种与摘要语种**分开记下来**。
 *
 * 优先级（越靠前越可信）：
 *   1. 用户人工纠正（manually_confirmed）——最高，且后续采集不得覆盖；
 *   2. 来源明确给出的可信语言代码（publisher），但若题名的文字系统/证据强冲突则让位；
 *   3. 题名语种（题名最能代表论文语言）；
 *   4. 摘要语种（**只在题名没有结论时才用**，避免英文摘要把非英文论文写成英文）；
 *   5. 都没有 ⇒ unknown（界面「语种待确认」）。
 *
 * @returns {{language:string, source:string, confidence:string, evidence:string,
 *            titleLanguage:string, abstractLanguage:string, conflict:boolean}}
 */
function resolvePaperLanguage({ title, abstract, sourceLanguage, manualLanguage } = {}) {
  const titleR = detectLanguageDetailed(title, { shortText: true });
  const absR = detectLanguageDetailed(abstract, { shortText: false });
  const srcLang = normalizeSourceLanguage(sourceLanguage);

  const out = {
    language: 'unknown', source: 'unknown', confidence: 'low', evidence: '',
    titleLanguage: titleR.language, abstractLanguage: absR.language,
    conflict: false,
  };

  // 1) 人工纠正最高优先
  const manual = manualLanguage ? normalizeSourceLanguage(manualLanguage) || (String(manualLanguage).toLowerCase() === 'unknown' ? 'unknown' : null) : null;
  if (manual) {
    out.language = manual;
    out.source = 'manual';
    out.confidence = 'high';
    out.evidence = '由你人工确认';
    out.conflict = Boolean(srcLang && srcLang !== manual);
    return out;
  }

  // 2) 来源明确给出的可信代码
  if (srcLang) {
    const titleContradicts = (titleR.language === 'zh' && srcLang !== 'zh')
      || (titleR.language === 'other' && srcLang !== 'other' && titleR.confidence === 'high');
    const titleBeats = (titleR.language === 'id' && srcLang === 'en' && titleR.confidence === 'high');
    if (titleContradicts || titleBeats) {
      out.language = titleR.language;
      out.source = 'title';
      out.confidence = titleR.confidence;
      out.evidence = `来源标注为 ${srcLang}，但题名证据指向 ${titleR.language}（${titleR.evidence}），以题名为准`;
      out.conflict = true;
      return out;
    }
    out.language = srcLang;
    out.source = 'publisher';
    out.confidence = 'high';
    out.evidence = `来源明确提供的语言代码（规范化为 ${srcLang}）`;
    out.conflict = false;
    return out;
  }

  // 3) 题名有结论就用题名
  if (titleR.language !== 'unknown') {
    out.language = titleR.language;
    out.source = 'title';
    out.confidence = titleR.confidence;
    out.evidence = `题名：${titleR.evidence}`;
    return out;
  }

  // 4) 只有题名无结论时才看摘要——且要说明这只是摘要语种
  if (absR.language !== 'unknown') {
    out.language = absR.language;
    out.source = 'abstract';
    out.confidence = absR.confidence === 'high' ? 'medium' : 'low';
    out.evidence = `题名证据不足，暂按摘要语种：${absR.evidence}`;
    return out;
  }

  out.evidence = `题名与摘要都没有足够证据（题名：${titleR.evidence}）`;
  return out;
}

/** 主体语种是否为中文 / 英文（配额与筛选用，绝不用 !== 'zh' 代替 === 'en'） */
function isChineseLang(lang) { return lang === 'zh'; }
function isEnglishLang(lang) { return lang === 'en'; }

/* ------------------------------------------------------------------ *
 * 出版日期精度
 *
 * 上游（Crossref / OpenAlex / 公开目录）给到的日期精度并不一致：
 * 有的只到年（2026），有的到年月（2026-09），有的到日（2026-09-14）。
 * 早期 `dateFromParts` 对缺失的月/日一律补 1（2026 → 2026-01-01），
 * 于是库里多出一批**并不存在的一天**：它会冒充真实出版日参与展示与排序。
 *
 * 这里的原则：知道多少就存多少、就显示多少。
 *   '2026'          → 精度 year
 *   '2026-09'       → 精度 month
 *   '2026-09-14'    → 精度 day
 *   '2026-01-01'    → 精度 year（历史占位值：这是旧版对「只有年」补出来的，
 *                     不是真实的一天；新写入的数据不会再产生这种值）
 * ------------------------------------------------------------------ */
const DATE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_YEAR_RE = /^\d{4}$/;
/** 旧版「只有年」补出来的占位日，仅当它是 1 月 1 日时才这样判定 */
const PLACEHOLDER_DAY_RE = /^\d{4}-01-01$/;

function datePrecision(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (PLACEHOLDER_DAY_RE.test(s)) return 'year';
  if (DATE_DAY_RE.test(s)) return 'day';
  if (DATE_MONTH_RE.test(s)) return 'month';
  if (DATE_YEAR_RE.test(s)) return 'year';
  return null;
}

/** 把不同精度的日期转成可比较的毫秒数；精度不足按「该区间中点」近似，只用于排序 */
function dateToMs(value, precision) {
  const s = String(value == null ? '' : value).trim();
  const p = precision || datePrecision(s);
  if (!p) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  if (p === 'day') {
    const t = Date.parse(s.slice(0, 10) + 'T00:00:00Z');
    return Number.isFinite(t) ? t : null;
  }
  if (p === 'month') {
    const t = Date.parse(s.slice(0, 7) + '-15T00:00:00Z');
    return Number.isFinite(t) ? t : null;
  }
  // 只有年：用年中，避免 1 月 1 日被当成「刚发表」
  const t = Date.parse(s.slice(0, 4) + '-07-01T00:00:00Z');
  return Number.isFinite(t) ? t : null;
}

/**
 * 卡片上要显示的**唯一**可信发表时间。
 *
 * 选择顺序（与用户要求一致）：
 *   1. 有完整在线发表日（精度 day）的 published_online —— 最可信、最具体；
 *   2. 否则有据可查的正式出版（published_print），按实际精度；
 *   3. 否则只有年月的在线发表日；
 *   4. 否则 issued_date（可能只到年）。
 * 绝不使用 discovery_date（工作台发现日）冒充发表日。
 */
function bestPubDate(p) {
  const src = p || {};
  const cand = [];
  if (src.published_online) cand.push({ kind: 'online', label: '在线发表', value: String(src.published_online) });
  if (src.published_print) cand.push({ kind: 'print', label: '正式出版', value: String(src.published_print) });
  if (src.issued_date) cand.push({ kind: 'issued', label: '出版', value: String(src.issued_date) });

  const withP = cand.map((c) => ({ ...c, precision: datePrecision(c.value) }));
  let chosen = withP.find((c) => c.kind === 'online' && c.precision === 'day')
    || withP.find((c) => c.kind === 'print' && c.precision === 'day')
    || withP.find((c) => c.kind === 'print')
    || withP.find((c) => c.kind === 'online')
    || withP[0]
    || null;
  if (!chosen) return null;

  // 只有年时，把「在线发表」这类标签改成更保守的措辞，避免读者以为知道具体某天
  const label = chosen.precision === 'year'
    ? (chosen.kind === 'issued' ? '出版年' : (chosen.kind === 'online' ? '在线发表日期（仅到年）' : '正式出版年'))
    : chosen.label;
  return {
    value: chosen.value,
    precision: chosen.precision,
    kind: chosen.kind,
    label,
    ms: dateToMs(chosen.value, chosen.precision),
  };
}

/** 去重键：优先 DOI，其次 ISSN+标题+年，再次标题+年 */
function dedupKey({ doi, issn, title, year }) {
  const d = normalizeDoi(doi);
  if (d) return 'doi:' + d;
  const t = normalizeTitle(title);
  const y = year ? String(year) : '';
  const i = normalizeIssn(issn);
  if (t && i) return `ti:${i}:${t.slice(0, 120)}:${y}`;
  if (t) return `tt:${t.slice(0, 160)}:${y}`;
  return 'raw:' + Math.random().toString(36).slice(2);
}

/** 清洗摘要：Crossref 常带 JATS 标签 */
function cleanAbstract(raw) {
  if (!raw) return null;
  let a = String(raw);
  a = a.replace(/<\/?jats:[^>]*>/g, ' ').replace(/<[^>]+>/g, ' ');
  a = a.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
  a = a.replace(/^\s*(abstract|摘要)\s*[:：]?\s*/i, '');
  a = a.replace(/\s+/g, ' ').trim();
  if (a.length < 30) return null;
  return a;
}

/**
 * 解码 HTML 实体。
 * 目录页里题名常写成 `&amp;` / `&#8220;` / `&ldquo;` 之类，
 * 不解码会把实体直接写进题名，导致去重与显示都不对。
 */
const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', middot: '·',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
};
function decodeHtmlEntities(input) {
  if (input == null) return '';
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&([a-z]+);/gi, (m, name) => {
      const k = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, k) ? HTML_ENTITIES[k] : m;
    });
}

/** 《中文核心期刊要目总览》等目录里的刊名可能带书名号/空格 */
function cleanJournalNameForMatch(name) {
  return normalizeJournalName(String(name || '').replace(/[《》〈〉]/g, ''));
}

/**
 * 上游数据里的**占位符**，不是真的元数据。
 *
 * 真实遇到：Crossref 对某些出版商的投稿会原样返回 `page: "None-None"` ——
 * 那是出版商用 Python 拼字符串时把 None 直接格式化进去了，
 * 于是在页面上显示成「卷 150 期 1 · None-None」。同一类还有 null / nil / nan /
 * undefined / n/a / "-" 等写法。
 *
 * 这里只识别「整段就是占位符」或「用 - / 连起来的每一段都是占位符」，
 * 绝不动真实数据：`134`、`1-21`、`e12345`、`S1-S10` 都原样保留；
 * `None-10` 这种半真半假的，保留真的那一半（10）。
 */
const PLACEHOLDER_RE = /^(none|null|nil|nan|undefined|n\/?a|na|unknown|-+|—+|–+|\?+|\.+)$/i;

/** 单个值是否为占位符（空串也算「没有值」） */
function isPlaceholderValue(v) {
  if (v == null) return true;
  const s = String(v).trim();
  if (!s) return true;
  return PLACEHOLDER_RE.test(s);
}

/**
 * 清洗卷/期/页这类字段：把占位符变成 null，而不是把 "None-None" 显示给用户。
 * 多段值（如 `1-21`、`None-None`、`None-10`）按段判断，只丢占位段。
 * @returns {string|null} 清洗后的值；完全无有效内容时返回 null
 */
function cleanPlaceholder(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // 整体就是占位符
  if (PLACEHOLDER_RE.test(s)) return null;
  // 多段：按 - / – — 切分，丢掉占位段，保留真实段
  if (/[-–—/]/.test(s)) {
    const parts = s.split(/\s*[-–—/]\s*/).map((x) => x.trim());
    const keep = parts.filter((x) => x && !PLACEHOLDER_RE.test(x));
    if (!keep.length) return null;
    if (keep.length === parts.length) return s;   // 全是真值，原样返回
    // 有段被丢掉：只在剩下部分仍有意义时重组，避免把「1-」变成「1」
    return keep.length >= 1 ? keep.join('-') : null;
  }
  return s;
}

/** 对论文对象里的卷/期/页做一次批量清洗（用于采集入库前） */
function cleanBiblioFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of ['volume', 'issue', 'pages']) {
    if (k in out) out[k] = cleanPlaceholder(out[k]);
  }
  return out;
}

function formatAuthors(authors) {
  if (!Array.isArray(authors)) return [];
  return authors
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a.name) return a.name;
      const given = a.given || a.first || '';
      const family = a.family || a.last || '';
      const full = [given, family].filter(Boolean).join(' ').trim();
      return full || a.literal || '';
    })
    .filter(Boolean);
}

module.exports = {
  normalizeDoi, normalizeIssn, normalizeTitle, normalizeJournalName,
  cleanJournalNameForMatch, detectLanguage, dedupKey, cleanAbstract, formatAuthors, cjkRatio,
  stripDiacritics,
  isPlaceholderValue, cleanPlaceholder, cleanBiblioFields, decodeHtmlEntities,
  detectLanguageDetailed, resolvePaperLanguage, normalizeSourceLanguage,
  isChineseLang, isEnglishLang,
  datePrecision, dateToMs, bestPubDate,
};
