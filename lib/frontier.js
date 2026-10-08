'use strict';
/**
 * 前沿技术每日精选（独立于当日主简报，篇数取本次实际入选数，不写死）。
 *
 * 用户要求：
 *   · 每天独立挑 2–3 篇，围绕 AI 语言教学、自动评估、语音技术、学习分析及相关 NLP；
 *   · 优先接入官方可用的 ERIC、arXiv API/RSS、ACL Anthology 元数据；
 *   · IEEE Xplore Metadata API 需要密钥时，做好可配置适配器与明确的「待配置」状态，
 *     **不要假装已采到**；
 *   · 预印本 / 会议论文 / 期刊论文分别标识；
 *   · **不得混入 SSCI 期刊合格数**（因此单独建表，绝不写进 papers）；
 *   · 与当日主简报分开（篇数随当天实际入选数变化）；数量不足就如实显示；
 *   · 记录来源、检索/发表日期、失败原因；遵守官方接口限额与条款。
 *
 * 已实测的事实（2026-09-28，见 README）：
 *   · ERIC：https://api.ies.ed.gov/eric/ 无需密钥，JSON，摘要覆盖率 100%，
 *     但**日期只到年**、**没有 DOI 字段**、只有 ERIC 叙词表（不是作者关键词）；
 *     语法错误会返回 HTTP 200 + body 里的 error，必须显式检查。
 *   · arXiv：https://export.arxiv.org/api/query 无需密钥，Atom XML，
 *     官方要求**每 3 秒最多 1 次请求、单连接**；journal_ref/doi 覆盖率仅 2%–8%，
 *     只能当「可能已正式发表」的弱信号展示，**绝不自动合并**。
 *   · ACL Anthology：没有查询 API，只能批量同步（见 lib/aclbib.js）。
 *   · IEEE：实测无密钥一律 HTTP 403（Developer Inactive），因此**没有配置密钥时
 *     根本不发请求**，只如实报告「待配置」。
 */
const store = require('./store');
const N = require('./normalize');
const http = require('./http');
const clock = require('./clock');
const { getSettings, getSecret } = require('./config');

const ERIC_API = 'https://api.ies.ed.gov/eric/';
const ARXIV_API = 'https://export.arxiv.org/api/query';
const IEEE_API = 'https://ieeexploreapi.ieee.org/api/v1/search/articles';

/**
 * 前沿技术的检索面：比主简报的五个研究主题更偏「技术」。
 *
 * `en` / `arxiv` 用于向 ERIC / arXiv 发检索式；
 * `terms` / `anchors` 用于**本地相关性判定**，两者职责不同：
 *   · terms   该方向的相关词（多词短语优先，避免「education」这类泛词单独命中）
 *   · anchors 该方向的**技术锚点**——必须命中至少一个，否则不算这个方向
 *
 * 为什么需要 anchors（真实缺陷）：
 *   早期实现把检索式按空格拆词后做子串匹配，于是一篇讲「前瞻记忆遗忘」的
 *   教育学论文仅因 ERIC 叙词表里有「Distance Education」、摘要里有「naturalistic」
 *   就被判成「教育 NLP」并进入前沿精选。这是典型的跨领域噪声。
 *   现在要求：命中词必须按**词边界**匹配，且至少命中一个技术锚点。
 */
const FRONTIER_QUERIES = [
  {
    slug: 'ai-language-teaching', name: 'AI 语言教学',
    en: 'artificial intelligence language teaching',
    // ERIC 的默认检索很宽（不带字段会返回一堆博士论文与州级考试报告），
    // 因此这里显式限定 title/description 字段。实测 title:"..." 的命中质量最高。
    eric: '(title:"artificial intelligence" OR title:"large language model" OR title:"ChatGPT" OR title:"intelligent tutoring") AND (description:language OR description:writing OR description:education)',
    arxiv: 'all:"language learning" AND (all:"large language model" OR all:"LLM")',
    terms: ['artificial intelligence', 'large language model', 'llm', 'chatgpt', 'generative ai',
      'ai-assisted', 'ai-powered', 'intelligent tutoring', 'machine translation', 'chatbot',
      'language teaching', 'language learning', 'second language'],
    anchors: ['artificial intelligence', 'large language model', 'llm', 'chatgpt', 'generative ai',
      'ai-assisted', 'ai-powered', 'intelligent tutoring', 'machine translation', 'chatbot'],
  },
  {
    slug: 'automated-assessment', name: '自动评估',
    en: 'automated writing evaluation',
    eric: '(title:"automated writing evaluation" OR title:"automated essay scoring" OR title:"automatic assessment" OR title:"automated scoring")',
    arxiv: 'all:"automated writing evaluation" OR all:"automated essay scoring"',
    terms: ['automated writing evaluation', 'automated essay scoring', 'automatic assessment',
      'automated scoring', 'writing evaluation', 'feedback generation', 'grammatical error correction',
      'automatic evaluation', 'essay scoring'],
    anchors: ['automated writing evaluation', 'automated essay scoring', 'automated scoring',
      'automatic assessment', 'automatic evaluation', 'grammatical error correction', 'writing evaluation'],
  },
  {
    slug: 'speech-technology', name: '语音技术',
    en: 'speech recognition pronunciation',
    eric: '(title:"speech recognition" OR title:pronunciation OR title:"text-to-speech" OR title:"speech synthesis")',
    arxiv: 'all:"speech recognition" AND all:"pronunciation"',
    terms: ['speech recognition', 'pronunciation', 'speech synthesis', 'text-to-speech', 'tts',
      'automatic speech recognition', 'asr', 'spoken language', 'acoustic model', 'voice assistant',
      'speech interaction'],
    anchors: ['speech recognition', 'pronunciation', 'speech synthesis', 'text-to-speech', 'tts',
      'automatic speech recognition', 'asr', 'acoustic model', 'voice assistant', 'speech interaction'],
  },
  {
    slug: 'learning-analytics', name: '学习分析',
    en: 'learning analytics',
    eric: '(title:"learning analytics" OR title:"educational data mining" OR title:"knowledge tracing")',
    arxiv: 'all:"learning analytics"',
    terms: ['learning analytics', 'educational data mining', 'student modeling', 'knowledge tracing',
      'learning behavior', 'log data', 'learner modeling'],
    anchors: ['learning analytics', 'educational data mining', 'student modeling', 'knowledge tracing', 'learner modeling'],
  },
  {
    slug: 'nlp-education', name: '教育 NLP',
    en: 'natural language processing education',
    eric: '(title:"natural language processing" OR title:"language model" OR title:"text mining") AND (description:education OR description:learning OR description:language)',
    arxiv: 'all:"NLP" AND all:"education"',
    terms: ['natural language processing', 'computational linguistics', 'language model', 'text mining',
      'semantic analysis', 'dialogue system', 'corpus linguistics', 'text classification'],
    anchors: ['natural language processing', 'computational linguistics', 'language model', 'text mining',
      'semantic analysis', 'dialogue system'],
  },
];

/** 按词边界判断短语是否出现，避免 'natural' 命中 'naturalistic'、'asr' 命中 'laser' */
function containsTerm(text, term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return re.test(text);
}

/** arXiv 上与本工作台最相关的分类（计算语言学 + 计算机与社会 + 音频语音） */
const ARXIV_CATS = ['cs.CL', 'cs.CY', 'eess.AS'];

/* ------------------------------------------------------------------ *
 * 来源状态：哪些真实接通、哪些待配置、哪些不可自动化
 * ------------------------------------------------------------------ */

const SOURCE_META = {
  eric: {
    key: 'eric', label: 'ERIC（美国教育部）', kind: 'live',
    home: 'https://eric.ed.gov/', api: ERIC_API, needsKey: false,
    coverage: '教育学与语言教学专库；摘要覆盖率高，但出版日期只到「年」，且不提供 DOI 与作者关键词（只有 ERIC 叙词表）。',
  },
  arxiv: {
    key: 'arxiv', label: 'arXiv（预印本）', kind: 'live',
    home: 'https://arxiv.org/', api: ARXIV_API, needsKey: false,
    coverage: '预印本；提交日期到日、摘要齐全。官方要求每 3 秒最多 1 次请求、单连接。几乎不提供正式发表信息（journal_ref/doi 覆盖率仅约 2%–8%）。',
  },
  acl: {
    key: 'acl', label: 'ACL Anthology（会议论文）', kind: 'batch',
    home: 'https://aclanthology.org/', api: 'https://aclanthology.org/anthology+abstracts.bib.gz', needsKey: false,
    coverage: '计算语言学会议与期刊论文全量元数据；没有在线查询接口，只能整包同步后本地检索（在「设置与数据源」页手动触发或定时同步）。',
  },
  ieee: {
    key: 'ieee', label: 'IEEE Xplore', kind: 'needs-key',
    home: 'https://developer.ieee.org/', api: IEEE_API, needsKey: true,
    coverage: '官方 Metadata API 必须提供机构 API Key。实测无密钥一律 HTTP 403（Developer Inactive），因此本工作台在未配置密钥时不会发起任何请求。',
  },
};

/** IEEE 的真实状态：没有密钥就明确「待配置」，且不发请求 */
function ieeeStatus() {
  const key = getSecret('ieeeApiKey') || process.env.LITDESK_IEEE_API_KEY || '';
  if (!key) {
    return {
      ok: false, needsApiKey: true, configured: false,
      status: null, checkedAt: clock.nowIso(),
      error: 'IEEE Xplore Metadata API 需要机构 API Key（实测无密钥返回 HTTP 403 “Developer Inactive”），当前为待配置状态，工作台不会发起请求。',
      fix: '在「设置与数据源」填入 IEEE Xplore API Key 后启用；注意 “Developer Inactive” 表示密钥未激活或机构订阅未生效，与密钥填错不同。',
    };
  }
  return {
    ok:true,configured:true,needsApiKey:false,status:null,checkedAt:clock.nowIso(),error:null,fix:'实际采集状态以最近一次请求为准。',
  };
}

/* ------------------------------------------------------------------ *
 * ERIC
 * ------------------------------------------------------------------ */

/** ERIC 的 publicationtype → 统一文档类型 */
function ericDocType(types) {
  const t = (types || []).join(' ').toLowerCase();
  if (/journal article/.test(t)) return 'journal-article';
  if (/speeches\/meeting|meeting paper|conference/.test(t)) return 'conference-paper';
  if (/report|information analyses|guides|opinion paper|book/.test(t)) return 'report';
  return 'other';
}

/** 从 ERIC 的 url 里尽力提取 DOI；提取不到就返回 null，绝不编造 */
function doiFromUrl(url) {
  const m = /(?:dx\.)?doi\.org\/(10\.[^\s?#]+)/i.exec(String(url || ''));
  return m ? N.normalizeDoi(decodeURIComponent(m[1])) : null;
}

/** 把 ERIC 的一条 doc 映射为统一记录 */
function ericToItem(doc, querySlug) {
  if (!doc || !doc.title) return null;
  const ericId = String(doc.id || '').trim();
  if (!ericId) return null;
  const year = Number(doc.publicationdateyear) || null;
  const types = Array.isArray(doc.publicationtype) ? doc.publicationtype : (doc.publicationtype ? [doc.publicationtype] : []);
  const url = doc.url || `https://eric.ed.gov/?id=${ericId}`;
  return {
    source: 'eric',
    sourceId: ericId,
    docType: ericDocType(types),
    title: String(doc.title).replace(/\s+/g, ' ').trim(),
    authors: Array.isArray(doc.author) ? doc.author.map((a) => String(a).trim()).filter(Boolean) : [],
    venue: doc.source ? String(doc.source).trim() : null,
    year,
    // ERIC 只有「年」，严格按年精度写，不补月日
    publishedDate: year ? String(year) : null,
    abstract: doc.description ? String(doc.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null,
    doi: doiFromUrl(url),
    url,
    pdfUrl: doc.e_fulltextauth && /^ED/.test(ericId) ? `https://files.eric.ed.gov/fulltext/${ericId}.pdf` : null,
    // ERIC 的 subject 是官方叙词表，**不是作者关键词**，单独存 subjects
    subjects: Array.isArray(doc.subject) ? doc.subject.slice(0, 20) : [],
    peerReviewed: doc.peerreviewed === 'T' ? 1 : 0,
    publishedNote: null,
    querySlug,
    raw: { id: ericId, publicationtype: types, sourceid: doc.sourceid || null, issn: doc.issn || null },
  };
}

/**
 * ERIC 检索。
 * 注意：语法错误时 ERIC 返回 **HTTP 200 + body 里的 error**，
 * 如果只看 HTTP 状态会把它当成「0 条结果」，所以必须显式检查。
 *
 * 关于时间过滤（实测结论）：
 *   ERIC 的 `e_datemodified` 对「自动写作评估 / 学习分析」这类窄主题**极其稀疏**
 *   （实测 title:"learning analytics" 在最近 30/90/365 天内分别只有 0/1/2 条），
 *   因为 ERIC 是批量入库而非每日更新。因此这里按 **publicationdateyear（出版年）**
 *   取最近若干年（ERIC 只支持年粒度），再交给本地相关性判定与新近度打分排序——
 *   这比假装「每天都在增量入库」更诚实。
 */
async function ericSearch({ query, rows = 200, start = 0, since = null, yearFrom = null, yearTo = null, fields = null } = {}) {
  const parts = [query];
  if (yearFrom && yearTo) parts.push(`publicationdateyear:[${yearFrom} TO ${yearTo}]`);
  else if (since) parts.push(`e_datemodified:[${since}T00:00:00Z TO NOW]`);
  const params = new URLSearchParams({
    search: parts.join(' AND '),
    format: 'json',
    start: String(start),
    rows: String(Math.min(rows, 2000)),
    fields: fields || 'id,title,author,source,sourceid,publicationdateyear,publicationtype,description,subject,issn,peerreviewed,url,e_datemodified,e_yearadded,e_fulltextauth',
  });
  const res = await http.fetchJson(`${ERIC_API}?${params.toString()}`, { minGapMs: 1200, retries: 1, cacheTtlMs: 6 * 3600 * 1000 });
  if (!res.ok) return { ok: false, status: res.status, data: null, error: res.error, items: [], total: 0, ms: res.ms };
  const body = res.data;
  if (body && body.error) {
    return { ok: false, status: res.status, data: null, total: 0, ms: res.ms, items: [],
      error: `ERIC 查询语法被拒绝：${body.error.msg || JSON.stringify(body.error)}` };
  }
  const docs = (body && body.response && body.response.docs) || [];
  return {
    ok: true, status: res.status, error: null, ms: res.ms,
    total: (body && body.response && body.response.numFound) || 0,
    items: docs.map((d) => ericToItem(d)).filter(Boolean),
  };
}

/* ------------------------------------------------------------------ *
 * arXiv（Atom XML；Node 无内置 XML 解析器，这里按其平坦结构做保守解析）
 * ------------------------------------------------------------------ */

function xmlUnescape(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlTag(entry, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(entry);
  return m ? xmlUnescape(m[1].replace(/\s+/g, ' ').trim()) : null;
}

/** arXiv ID 必须剥掉版本号，否则同一篇的 v1/v2 会被当成两篇 */
function baseArxivId(raw) {
  const m = /arxiv\.org\/abs\/([^v\s]+)(?:v(\d+))?/i.exec(String(raw || ''));
  if (m) return m[1];
  const m2 = /^([\w.\-/]+?)(?:v\d+)?$/.exec(String(raw || '').trim());
  return m2 ? m2[1] : String(raw || '').trim();
}

/** 解析 arXiv Atom 响应（导出出来便于离线测试） */
function parseArxivAtom(xml, querySlug) {
  const out = [];
  const entries = String(xml || '').split(/<entry>/i).slice(1);
  for (const raw of entries) {
    const entry = raw.split(/<\/entry>/i)[0];
    const idRaw = xmlTag(entry, 'id');
    if (!idRaw) continue;
    const id = baseArxivId(idRaw);
    const title = (xmlTag(entry, 'title') || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)]
      .map((m) => xmlUnescape(m[1].replace(/\s+/g, ' ').trim())).filter(Boolean);
    const published = xmlTag(entry, 'published');
    const doiRaw = xmlTag(entry, 'arxiv:doi');
    const journalRef = xmlTag(entry, 'arxiv:journal_ref');
    const comment = xmlTag(entry, 'arxiv:comment');
    const primary = (new RegExp('<arxiv:primary_category[^>]*term="([^"]+)"', 'i').exec(entry) || [])[1] || null;
    const pdf = (new RegExp('<link[^>]*href="([^"]+)"[^>]*title="pdf"', 'i').exec(entry) || [])[1]
      || (new RegExp('<link[^>]*title="pdf"[^>]*href="([^"]+)"', 'i').exec(entry) || [])[1] || null;
    // 正式发表信息：覆盖率只有 2%–8%，只当弱信号展示，绝不自动合并
    const publishedNote = [journalRef, doiRaw ? `DOI ${doiRaw}` : null, comment ? `备注：${comment}` : null]
      .filter(Boolean).join('；') || null;
    out.push({
      source: 'arxiv',
      sourceId: id,
      // arXiv 上的一律是预印本（哪怕作者说已被接收，那也是「可能已发表」的弱信号）
      docType: 'preprint',
      title,
      authors,
      venue: primary,
      year: published ? Number(String(published).slice(0, 4)) || null : null,
      publishedDate: published ? String(published).slice(0, 10) : null,   // 日粒度
      abstract: xmlTag(entry, 'summary'),
      doi: doiRaw ? N.normalizeDoi(doiRaw) : null,
      url: `https://arxiv.org/abs/${id}`,
      pdfUrl: pdf || `https://arxiv.org/pdf/${id}`,
      subjects: primary ? [primary] : [],
      peerReviewed: 0,     // 预印本未经同行评议（即使后来被接收，本记录仍是预印本）
      publishedNote,
      querySlug,
      raw: { arxivId: id, primary, journalRef: journalRef || null, comment: comment || null },
    });
  }
  return out;
}

/**
 * arXiv 检索。
 *
 * 官方 TOU：**每 3 秒最多 1 次请求，且同时只保持一个连接**。
 * 间隔由 http.js 的 HOST_GAP_MS['export.arxiv.org']=3100 强制保证（同主机串行队列），
 * 这里只做**有界**的失败重试与退避，绝不并发、也绝不缩短间隔。
 *
 * 为什么要重试（真实观测 2026-09-29）：
 *   arXiv 的查询接口偶尔会明显变慢（实测单次超过 25 秒），
 *   5 个检索式可能会部超时；此时把整轮判为失败并只报「超时」是不够的，
 *   还要能区分「超时 / 被限流 429 / HTTP 错误」，并且**有上限地**再试一次。
 *
 * 参数（有界，避免把一轮更新拖死）：
 *   timeoutMs 单次请求上限（默认 45s，比全局 25s 宽松，因为 arXiv 本身慢）
 *   attempts  最多尝试次数（默认 2：首次 + 1 次重试）
 *   退避     重试前等待 3s / 6s（递增、有上限），叠加在 3100ms 主机间隔之上
 */
async function arxivSearch({ searchQuery, maxResults = 100, start = 0, timeoutMs = 45000, attempts = 2 } = {}) {
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: String(start),
    max_results: String(Math.min(maxResults, 200)),
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  });
  // 必须 HTTPS：http://export.arxiv.org 会 301
  const url = `${ARXIV_API}?${params.toString()}`;
  let last = null;
  const tried = [];
  const max = Math.max(1, Math.min(attempts, 3));   // 硬上限 3 次，防止无限重试

  for (let i = 0; i < max; i++) {
    if (i > 0) {
      // 递增退避，且不短于官方 3 秒最小间隔
      const waitMs = Math.min(3000 * i, 9000);
      await http.sleep(waitMs);
    }
    const res = await http.fetchText(url, { minGapMs: 3100, retries: 0, timeoutMs });
    if (res.ok) {
      const items = parseArxivAtom(res.data, null);
      const total = Number((/<opensearch:totalResults[^>]*>(\d+)</i.exec(res.data || '') || [])[1]) || items.length;
      if (!items.length && /<entry>/i.test(res.data || '')) {
        // 有 entry 却解析不出记录：如实标记为解析问题，不假装 0 条结果
        return { ok: false, status: res.status, error: '返回了条目但解析失败', cause: 'parse',
          items: [], total: 0, ms: res.ms, attempts: i + 1, tried };
      }
      return { ok: true, status: res.status, error: null, cause: null, ms: res.ms, total, items, attempts: i + 1, tried };
    }
    const cause = classifyArxivFailure(res);
    tried.push({ attempt: i + 1, cause, status: res.status, error: res.error });
    last = { status: res.status, error: res.error, cause, ms: res.ms };
    // 被限流时不继续加重负担：直接停止本轮，交给调用方如实报告
    if (cause === 'throttled') break;
  }
  return { ok: false, status: last ? last.status : null, error: last ? last.error : '未知失败',
    cause: last ? last.cause : 'unknown', items: [], total: 0, ms: last ? last.ms : 0,
    attempts: tried.length, tried };
}

/**
 * 把 arXiv 的失败归类，便于页面给出可读原因（不编造成功）。
 *
 * 顺序很重要：**先看已记录的错误文本，再看 HTTP 状态**。
 * 原因：超时后 http.js 可能已把该主机熔断，返回的记录里会同时出现
 * status=429 与 error='超时(25000ms)'；此时以文本为准才是当时真实发生的事。
 */
function classifyArxivFailure(res) {
  const err = String((res && res.error) || '');
  if (/超时|timeout/i.test(err)) return 'timeout';
  if (/限流|429|throttl/i.test(err)) return 'throttled';
  if (/解析/.test(err)) return 'parse';
  if (res && res.status === 429) return 'throttled';
  if (res && res.status) return 'http';
  return err ? 'network' : 'unknown';
}

const ARXIV_CAUSE_LABEL = {
  timeout: '超时',
  throttled: '被限流(429)',
  http: 'HTTP 错误',
  parse: '解析失败',
  network: '网络错误',
  unknown: '未知原因',
};

/* ------------------------------------------------------------------ *
 * 落库与去重
 * ------------------------------------------------------------------ */

/** 跨源去重键：DOI 优先；否则规范化题名 + 年（允许 ±1 年由调用方处理） */
function dedupKeyFor(it) {
  if (it.doi) return 'doi:' + it.doi;
  const t = N.normalizeTitle(it.title);
  if (t) return `ft:${t.slice(0, 140)}:${it.year || ''}`;
  return `fs:${it.source}:${it.sourceId}`;
}

function upsertItem(it) {
  const key = dedupKeyFor(it);
  const existing = store.get('SELECT id FROM frontier_items WHERE dedup_key = ?', [key]);
  store.run(
    `INSERT INTO frontier_items(source, source_id, doc_type, title, authors, venue, year, published_date,
        abstract, doi_norm, url, pdf_url, language, subjects, peer_reviewed, published_note, raw, dedup_key, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(dedup_key) DO UPDATE SET
       title=excluded.title, authors=excluded.authors, venue=excluded.venue, year=excluded.year,
       published_date=excluded.published_date, abstract=excluded.abstract, doi_norm=excluded.doi_norm,
       url=excluded.url, pdf_url=excluded.pdf_url, subjects=excluded.subjects,
       peer_reviewed=excluded.peer_reviewed, published_note=excluded.published_note,
       raw=excluded.raw, updated_at=excluded.updated_at`,
    [it.source, it.sourceId, it.docType, it.title, JSON.stringify(it.authors || []), it.venue || null,
     it.year || null, it.publishedDate || null, it.abstract || null, it.doi || null, it.url || null,
     it.pdfUrl || null, it.language || 'en', JSON.stringify(it.subjects || []),
     it.peerReviewed == null ? null : it.peerReviewed, it.publishedNote || null,
     JSON.stringify(it.raw || {}), key, clock.nowIso()]);
  const row = store.get('SELECT id FROM frontier_items WHERE dedup_key = ?', [key]);
  return { id: row ? row.id : null, isNew: !existing };
}

/**
 * 把前沿记录与库内「正式发表版」关联。
 *
 * 已实测：arXiv 的 journal_ref/doi 覆盖率只有 2%–8%，所以关联必须保守——
 * 只在 DOI 完全相同、或规范化题名完全相同且年份相差 ≤1 时才算命中；
 * 命中后仅在界面上提示「库内已有正式发表版」，**不合并、不改写**任何一方。
 */
function linkToPublished(items) {
  let linked = 0;
  for (const it of items) {
    if (!it.id) continue;
    let hit = null;
    if (it.doi) {
      hit = store.get('SELECT id FROM papers WHERE doi_norm = ?', [it.doi]);
    }
    if (!hit && it.title) {
      const norm = N.normalizeTitle(it.title);
      if (norm) {
        hit = store.get(
          `SELECT id FROM papers
            WHERE lower(replace(replace(title,'-',' '),'.','')) = ?
            LIMIT 1`, [norm]) || null;
      }
    }
    if (hit) {
      store.run('UPDATE frontier_items SET matched_paper_id = ? WHERE id = ?', [hit.id, it.id]);
      linked++;
    }
  }
  return linked;
}

/* ------------------------------------------------------------------ *
 * 选题（2–3 篇）
 * ------------------------------------------------------------------ */

/**
 * 与前沿检索面做匹配，得出命中的方向。
 *
 * 判定规则（防止跨领域噪声）：
 *   1. 词必须按**词边界**命中，且必须是方向词表里的短语；
 *   2. 至少命中 **2 个**方向词；
 *   3. 其中至少 1 个必须是该方向的**技术锚点**。
 * 只满足「education」「learning」这类泛词不算命中——那正是噪声的来源。
 */
function hitDirections(it) {
  const text = `${it.title || ''} ${it.abstract || ''} ${(it.subjects || []).join(' ')}`.toLowerCase();
  const hits = [];
  for (const q of FRONTIER_QUERIES) {
    const matched = (q.terms || []).filter((t) => containsTerm(text, t));
    if (matched.length < 2) continue;
    const anchorHit = (q.anchors || []).some((t) => containsTerm(text, t));
    if (!anchorHit) continue;
    hits.push({ slug: q.slug, name: q.name, matched });
  }
  return hits;
}

/**
 * 选出 2–3 篇。
 * 排序依据：方向命中数 → 摘要是否完整 → 发表时间新旧（精度不足不冒充新）。
 *
 * 来源多样性是**软约束**：第一轮每个来源最多 2 篇；
 * 如果这样还不够 size 篇，才放开限制补满——宁可来源单一，
 * 也不要因为一条人为配额而少推荐一篇真正相关的前沿论文
 * （但仍然不会用不相关的论文凑数）。
 */
function planPicks(items, { size = 3, excludeIds = null } = {}) {
  const scored = [];
  for (const it of items) {
    if (excludeIds && excludeIds.has(it.id)) continue;   // 已经推荐过的不再重复
    const hits = hitDirections(it);
    if (!hits.length) continue;
    const t = it.published_date
      ? Date.parse(String(it.published_date).length === 4 ? it.published_date + '-07-01' : it.published_date)
      : NaN;
    const days = Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 86400000) : null;
    let recency = 0.3;
    if (days != null) {
      recency = days <= 30 ? 1 : days <= 90 ? 0.8 : days <= 365 ? 0.5 : 0.25;
      // 只有年：知道大概而已，不冒充「刚发表」
      if (N.datePrecision(it.published_date) !== 'day') recency *= 0.6;
    }
    const score = hits.length * 1.0 + (it.abstract ? 0.5 : 0) + recency * 0.6 + (it.peer_reviewed ? 0.15 : 0);
    scored.push({ it, hits, score: Number(score.toFixed(4)) });
  }
  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  const chosen = new Set();
  const perSource = {};
  // 第一轮：每个来源最多 2 篇，尽量保证来源多样
  for (const s of scored) {
    if (picked.length >= size) break;
    const src = s.it.source;
    if ((perSource[src] || 0) >= 2) continue;
    perSource[src] = (perSource[src] || 0) + 1;
    chosen.add(s.it.id);
    picked.push(s);
  }
  // 第二轮：名额没满就放开来源限制，按分数补满（仍然只用真有方向命中的论文）
  for (const s of scored) {
    if (picked.length >= size) break;
    if (chosen.has(s.it.id)) continue;
    chosen.add(s.it.id);
    picked.push(s);
  }
  picked.sort((a, b) => b.score - a.score);
  return picked;
}

/* ------------------------------------------------------------------ *
 * 采集 + 生成
 * ------------------------------------------------------------------ */

let _progress = null;

/** 采集前沿来源。只跑真实可用的源；IEEE 没有密钥时**不发请求**。 */
async function collect({ days = 14, perQuery = 40, sources: wantSources = null, queries = null, ericYears = 3, signal } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const currentYear = Number(new Date().toLocaleString('en-CA', { timeZone: getSettings().timezone || 'Asia/Shanghai', year: 'numeric' }).slice(0, 4)) || new Date().getFullYear();
  const useEric = !wantSources || wantSources.includes('eric');
  const useArxiv = !wantSources || wantSources.includes('arxiv');
  const list = queries || FRONTIER_QUERIES;

  const sourceStatus = [];
  const all = [];
  const log = [];
  const push = (msg) => { log.push({ at: clock.nowIso(), msg }); };

  _progress = { running: true, phase: 'frontier', startedAt: clock.nowIso(), log: [] };

  if (useEric) {
    let okCount = 0, failCount = 0, found = 0, firstError = null, httpStatus = null;
    for (const q of list) {
      if(signal?.aborted)break;
      try {
        const r = await ericSearch({
          query: q.eric || q.en, rows: perQuery,
          yearFrom: currentYear - Math.max(1, ericYears - 1), yearTo: currentYear,
        });
        if (!r.ok) { failCount++; firstError = firstError || r.error; httpStatus = r.status; continue; }
        okCount++;
        found += r.items.length;
        all.push(...r.items.map((x) => ({ ...x, querySlug: q.slug })));
      } catch (e) { failCount++; firstError = firstError || e.message; }
    }
    sourceStatus.push({
      source: 'eric', label: SOURCE_META.eric.label, ok: okCount > 0,
      status: httpStatus, checkedAt: clock.nowIso(),
      queries: list.length, okQueries: okCount, failedQueries: failCount, found,
      error: okCount > 0 ? null : (firstError || '未取回任何结果'),
      needsKey: false,
      note: SOURCE_META.eric.coverage,
    });
    push(`ERIC：${okCount}/${list.length} 个检索式成功，取回 ${found} 条${firstError ? `；失败原因：${firstError}` : ''}`);
  }

  if (useArxiv) {
    /*
     * 失败必须按**原因**归类，而不是只留最后一个 HTTP 状态。
     * 真实缺陷（2026-09-29）：5 个检索式全部失败时，页面显示的是
     * 「首个失败的超时」+「最后一次失败的 429」拼在一起，无法据此判断到底发生了什么。
     * 现在按 cause 计数（超时 / 被限流 / HTTP / 解析 / 网络），并如实说明重试情况。
     */
    let okCount = 0, failCount = 0, found = 0;
    const causes = {};
    let firstError = null, firstCause = null, retriedQueries = 0, lastStatus = null;
    for (const q of list) {
      if(signal?.aborted)break;
      const searchQuery = `(${ARXIV_CATS.map((c) => `cat:${c}`).join(' OR ')}) AND (${q.arxiv || `all:"${q.en}"`})`;
      try {
        const r = await arxivSearch({ searchQuery, maxResults: perQuery });
        if (r.attempts > 1) retriedQueries++;
        if (!r.ok) {
          failCount++;
          const cause = r.cause || 'unknown';
          causes[cause] = (causes[cause] || 0) + 1;
          if (!firstError) { firstError = r.error; firstCause = cause; }
          if (r.status) lastStatus = r.status;
          continue;
        }
        okCount++;
        found += r.items.length;
        all.push(...r.items.map((x) => ({ ...x, querySlug: q.slug })));
      } catch (e) {
        failCount++;
        causes.network = (causes.network || 0) + 1;
        if (!firstError) { firstError = e.message; firstCause = 'network'; }
      }
    }
    const causeText = Object.entries(causes)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${n} 次${ARXIV_CAUSE_LABEL[c] || c}`).join('、');
    const diagnosis = okCount > 0
      ? null
      : `arXiv 本次 ${list.length} 个检索式全部失败${causeText ? `（${causeText}）` : ''}：`
        + `${firstError || '未取回任何结果'}。已按官方要求保持每 3 秒最多 1 次、单连接，`
        + `并对失败查询做了有界重试与递增退避（最多 ${2} 次、单次上限 45 秒）后仍未成功，`
        + '因此本轮**没有**取回任何 arXiv 记录（工作台不会为凑数编造数据）。';
    sourceStatus.push({
      source: 'arxiv', label: SOURCE_META.arxiv.label, ok: okCount > 0,
      status: okCount > 0 ? null : lastStatus, checkedAt: clock.nowIso(),
      queries: list.length, okQueries: okCount, failedQueries: failCount, found,
      firstError: okCount > 0 ? null : firstError,
      causes, retriedQueries,
      error: diagnosis,
      needsKey: false,
      note: SOURCE_META.arxiv.coverage,
    });
    push(`arXiv：${okCount}/${list.length} 个检索式成功，取回 ${found} 条`
      + (causeText ? `；失败原因分布：${causeText}` : '')
      + (retriedQueries ? `；其中 ${retriedQueries} 个检索式做过重试` : '')
      + (firstError ? `；首个错误：${firstError}` : ''));
  }

  // ACL 是批量同步来源：这里只报告它当前的同步状态，不做 42MB 下载
  if(!wantSources||wantSources.includes('acl')) {
  try {
    const acl = require('./aclbib');
    const st = await acl.status();
    // 注意：aclbib.status() 返回的字段是 total，不是 items。
    // 早期写成 st.items 会得到 undefined，页面与日志都显示「库内 undefined 条元数据」。
    const aclTotal = st ? Number(st.items != null ? st.items : st.total) || 0 : 0;
    sourceStatus.push({
      source: 'acl', label: SOURCE_META.acl.label, ok: aclTotal > 0,
      status: null, checkedAt: clock.nowIso(),
      items: aclTotal,
      lastSyncAt: st ? (st.lastSyncAt || st.lastModified || null) : null,
      error: aclTotal > 0 ? null : '尚未同步 ACL Anthology 元数据（在「设置与数据源」手动同步，或等待定时同步）。',
      needsKey: false, batch: true,
      note: SOURCE_META.acl.coverage,
    });
    push(`ACL Anthology：库内 ${aclTotal} 条元数据`
      + (st && (st.lastSyncAt || st.lastModified) ? `，上次同步 ${st.lastSyncAt || st.lastModified}` : '，尚未同步'));
  } catch (e) {
    sourceStatus.push({
      source: 'acl', label: SOURCE_META.acl.label, ok: false, status: null,
      error: 'ACL 同步模块不可用：' + e.message, needsKey: false, batch: true,
      note: SOURCE_META.acl.coverage,
    });
  }

  }
  if(!wantSources||wantSources.includes('ieee')) {
    const key=getSecret('ieeeApiKey')||process.env.LITDESK_IEEE_API_KEY;
    if(!key)sourceStatus.push({source:'ieee',label:'IEEE Xplore',ok:false,error:'未配置密钥，未发起请求',needsKey:true});
    else {let found=0,error=null;for(const q of list){if(signal?.aborted)break;try{const u=new URL(IEEE_API);u.searchParams.set('apikey',key);u.searchParams.set('querytext',q.en);u.searchParams.set('format','json');u.searchParams.set('start_date',since.replace(/-/g,''));u.searchParams.set('max_records',String(Math.min(40,perQuery)));const res=await require('./http').fetchJson(u.toString(),{retries:0,timeoutMs:25000,minGapMs:1200});if(!res.ok)throw Error('IEEE HTTP '+(res.status||'请求失败'));const data=res.data;for(const x of data.articles||[]){all.push({source:'ieee',sourceId:String(x.article_number),docType:/conference/i.test(x.content_type||'')?'conference-paper':/journal|magazine|early access/i.test(x.content_type||'')?'journal-article':'other',title:x.title,authors:(x.authors?.authors||[]).map(a=>a.full_name),venue:x.publication_title,year:x.publication_year,publishedDate:/^\d{4}-\d{2}-\d{2}$/.test(x.publication_date||'')?x.publication_date:String(x.publication_year||''),abstract:x.abstract,doi:x.doi,url:x.html_url||x.abstract_url,language:'en',raw:x});found++;}}catch(e){error=e.message;}}sourceStatus.push({source:'ieee',label:'IEEE Xplore',ok:found>0,found,error,configured:true});}
  }
  let inserted = 0, updated = 0;
  const saved = [];
  store.tx(() => {
    for (const it of all) {
      const r = upsertItem(it);
      if (r.id) saved.push({ ...it, id: r.id });
      if (r.isNew) inserted++; else updated++;
    }
  });
  const linked = linkToPublished(saved);
  push(`去重后入库：新增 ${inserted} 条、更新 ${updated} 条；其中 ${linked} 条在库内找到对应正式发表版`);

  _progress = { running: false, phase: 'frontier', startedAt: _progress.startedAt, finishedAt: clock.nowIso(), log };

  return {
    ok: sourceStatus.some((s) => s.ok),
    since, inserted, updated, linked, collected: all.length,
    sources: sourceStatus, log,
  };
}

/**
 * 生成某天（默认今天）的前沿精选。
 * 与主简报完全分开：写 frontier_runs / frontier_picks，不碰 brief_runs。
 */
async function generate({ size = null, days = 30, reason = 'manual', skipCollect = false, sources=null, signal } = {}) {
  // 目标篇数默认取当前设置，不写死 3
  const targetSize = Math.max(1, Math.min(50, Number(size) || Number(getSettings().frontierSize) || 3));
  const runDate = require('./brief').beijingDate();
  const startedAt = clock.nowMs();
  let collectResult = null;
  if (!skipCollect) {
    collectResult = await collect({days,sources:sources||require('./customize').get('streams',{}).frontierSources,signal});
  }

  if(collectResult&&collectResult.ok===false){if(require('./customize').get('profiles'))require('./customize').put('frontierFailure',{sources:collectResult.sources,at:clock.nowIso()});return {...get(),ok:false,sources:collectResult.sources,collectResult,error:'所选前沿来源均未成功，保留上次缓存'};}
  if(require('./customize').get('profiles'))require('./customize').put('frontierFailure',null);
  /*
   * 时间窗口必须**按精度**比较，不能拿字符串直接比。
   *
   * 缺陷背景（真实踩到）：ERIC 只提供到「年」（'2026'），而窗口下界是
   * '2026-08-29'（完整日期）。字符串比较下 '2026' < '2026-08-29'，
   * 于是**所有 ERIC 条目都会被静默排除**——看起来像「ERIC 没数据」，
   * 实际是日期精度比较写错了。
   * 这里把不足精度的日期补到该周期的**末尾**：既然只知道是 2026 年，
   * 就不该把它排除在「最近 30 天」之外（是否近期由选题打分另算，
   * 只有年的条目已经在新近度上打了折）。
   */
  const pubKeySql = `(CASE
      WHEN published_date IS NULL THEN first_seen
      WHEN length(published_date) >= 10 THEN published_date
      WHEN length(published_date) = 7 THEN published_date || '-28'
      ELSE published_date || '-12-31'
    END)`;
  const rows = store.all(
    `SELECT * FROM frontier_items
      WHERE ${pubKeySql} >= ?
      ORDER BY ${pubKeySql} DESC LIMIT 2000`,
    [new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)]);

  const bjDay = (iso) => {
    if (!iso) return null;
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: getSettings().timezone || 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const t = Date.parse(iso);
    return Number.isFinite(t) ? fmt.format(new Date(t)) : null;
  };

  const items = rows.filter(r=>!sources||sources.includes(r.source)).map((r) => ({
    id: r.id, source: r.source, sourceId: r.source_id, docType: r.doc_type,
    title: r.title, authors: store.parseJson(r.authors, []), venue: r.venue,
    year: r.year, publishedDate: r.published_date, abstract: r.abstract,
    doi: r.doi_norm, url: r.url, pdfUrl: r.pdf_url, subjects: store.parseJson(r.subjects, []),
    peerReviewed: r.peer_reviewed, publishedNote: r.published_note,
    matchedPaperId: r.matched_paper_id, firstSeen: r.first_seen,
    // 采集日期（北京时间自然日）：用于区分「今天新采到」与「沿用早前采集」
    firstSeenDay: bjDay(r.first_seen),
  }));

  /*
   * 已经在前几次前沿精选里出现过的条目不再重复推荐——
   * 否则源没更新时，每天的「前沿精选」会是同样 3 篇。
   * 与主简报的 shownIds 是同一套思路，但两边互不影响。
   */
  const shownIds = new Set(store.all(
    `SELECT fp.item_id FROM frontier_picks fp
       JOIN frontier_runs fr ON fr.id = fp.run_id
      WHERE fr.run_date < ?`, [runDate]).map((r) => r.item_id));

  const picked = planPicks(items, { size: targetSize, excludeIds: shownIds });

  /*
   * 运行日志里如实记下「今天新采到几篇、沿用早前采集几篇」，
   * 这样事后核对时不必再猜今天的前沿精选是不是今天采的。
   */
  const pickedNewToday = picked.filter((p) => (p.it.firstSeenDay || null) === runDate).length;
  const pickedCarried = picked.length - pickedNewToday;
  const runLog = (collectResult ? collectResult.log : []).concat([
    { at: clock.nowIso(), msg: `本次入选 ${picked.length} 篇（目标 ${targetSize} 篇）：`
      + `今天新采集 ${pickedNewToday} 篇、沿用早前采集 ${pickedCarried} 篇` },
  ]);

  /*
   * 每天只有一份精选：同日重复生成就更新那一份（与 brief_runs 一致），
   * 避免手动点两次或定时与手动撞上时堆出一堆同日记录。
   * 注意：store.run() 返回的是 SQLite 的 {changes,lastInsertRowid}，不是行 id，
   * 所以必须回查一次拿 id（直接拿它当 runId 会报 “Unknown named parameter 'changes'”）。
   */
  const existingRun = store.get('SELECT id FROM frontier_runs WHERE run_date = ?', [runDate]);
  if (existingRun) {
    store.run(`UPDATE frontier_runs SET reason=?, started_at=?, finished_at=?, status=?, picked_count=?, candidates=?, log=?, sources=? WHERE id=?`,
      [reason, clock.nowIso(), clock.nowIso(), picked.length ? 'ok' : 'partial', picked.length, items.length,
       JSON.stringify(runLog), JSON.stringify(collectResult ? collectResult.sources : []), existingRun.id]);
  } else {
    store.run(
      `INSERT INTO frontier_runs(run_date, reason, started_at, finished_at, status, picked_count, candidates, log, sources)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [runDate, reason, clock.nowIso(), clock.nowIso(), picked.length ? 'ok' : 'partial', picked.length, items.length,
       JSON.stringify(runLog), JSON.stringify(collectResult ? collectResult.sources : [])]);
  }
  const runId = store.get('SELECT id FROM frontier_runs WHERE run_date = ?', [runDate]).id;

  store.tx(() => {
    store.run('DELETE FROM frontier_picks WHERE run_id = ?', [runId]);
    picked.forEach((p, i) => {
      const names = p.hits.map((h) => h.name).join('、');
      store.run('INSERT INTO frontier_picks(run_id, item_id, rank, reason) VALUES(?,?,?,?)',
        [runId, p.it.id, i + 1, `命中前沿方向：${names}；来源：${SOURCE_META[p.it.source] ? SOURCE_META[p.it.source].label : p.it.source}`]);
    });
  });

  return {
    ok: true, runId, runDate, reason,
    candidates: items.length,
    picked: picked.length,
    size: targetSize,
    sources: collectResult ? collectResult.sources : [],
    elapsedMs: clock.nowMs() - startedAt,
    insufficient: picked.length < targetSize,
  };
}

/** 读取最近一次（或指定日期）的前沿精选 */
function get(runDate) {
  const run = runDate
    ? store.get('SELECT * FROM frontier_runs WHERE run_date = ? ORDER BY id DESC LIMIT 1', [runDate])
    : store.get('SELECT * FROM frontier_runs ORDER BY id DESC LIMIT 1');
  if (!run) return { ok: true, empty: true, run: null, items: [], sources: [], note: '还没有生成过前沿技术精选。' };

  const rows = store.all(
    `SELECT fp.rank, fp.reason, fi.*
       FROM frontier_picks fp JOIN frontier_items fi ON fi.id = fp.item_id
      WHERE fp.run_id = ? ORDER BY fp.rank`, [run.id]);

  /*
   * 每条记录要如实说明它是**今天新采集的**还是**沿用早前采集的**。
   *
   * 真实场景（2026-09-29）：arXiv 当天全部超时、只从 ERIC 取到 200 条，
   * 而这 200 条里没有新的相关记录，于是今天入选的 3 篇全部是 09-28 就采到的旧记录。
   * 页面必须把这件事说清楚——不能让人以为「前沿技术每日精选」里的每篇都是今天新发现的。
   * 判定以 first_seen 的**北京时间自然日**与本次 run 的 run_date 比较，
   * 由服务端算好（前端不再自己猜）。
   */
  const runDay = run.run_date;
  const bjDayOf = (iso) => {
    if (!iso) return null;
    // first_seen 是带 Z 的 ISO；用与全站一致的 Asia/Shanghai 换算成自然日
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: getSettings().timezone || 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const t = Date.parse(iso);
    return Number.isFinite(t) ? fmt.format(new Date(t)) : null;
  };

  const items = rows.map((r) => {
    const seenDay = bjDayOf(r.first_seen);
    return {
      rank: r.rank,
      reason: r.reason,
      id: r.id,
      source: r.source,
      // 卡片上要显示来源编号（ERIC 号 / arXiv ID / anthology ID），之前漏了
      sourceId: r.source_id,
      sourceLabel: SOURCE_META[r.source] ? SOURCE_META[r.source].label : r.source,
      docType: r.doc_type,
      docTypeLabel: DOC_TYPE_LABELS[r.doc_type] || r.doc_type,
      title: r.title,
      authors: store.parseJson(r.authors, []),
      venue: r.venue,
      year: r.year,
      publishedDate: r.published_date,
      // 精度：只有年就不要显示成某一天
      publishedPrecision: N.datePrecision(r.published_date),
      abstract: r.abstract,
      doi: r.doi_norm,
      url: r.url,
      pdfUrl: r.pdf_url,
      // ERIC 叙词表 / arXiv 分类：**不是作者关键词**
      subjects: store.parseJson(r.subjects, []),
      peerReviewed: r.peer_reviewed === 1,
      publishedNote: r.published_note,
      matchedPaperId: r.matched_paper_id,
      firstSeen: r.first_seen,
      firstSeenDay: seenDay,
      // 只有「本次 run 当天首次采集到」才算今天新发现；其余如实标为沿用早前采集
      newlyCollectedToday: seenDay === runDay,
      carriedOver: seenDay !== runDay,
      // 中文译文缓存（原文永远保留；没有就明确显示「未生成」）
      titleZh: r.title_zh || null,
      abstractZh: r.abstract_zh || null,
      translatedAt: r.translated_at || null,
      translateModel: r.translate_model || null,
      translateError: r.translate_error || null,
      // ERIC 只有年：前端按精度显示，不补日
      titleLanguage: 'en',
    };
  });

  const newTodayCount = items.filter((x) => x.newlyCollectedToday).length;
  const carriedOverCount = items.length - newTodayCount;

  let sources = store.parseJson(run.sources, []);
  // 旧记录没有 sources 时，至少把「待配置」如实补上
  if (!sources.length) sources = [{ source: 'ieee', label: SOURCE_META.ieee.label, ok: false, needsKey: true, error: ieeeStatus().error }];
  // 早于本版写入的 run 记录缺少诊断字段：补一个「当时未记录失败原因」的如实说明，
  // 绝不把「没有诊断信息」写成「成功」。
  sources = sources.map((s) => {
    if (s.ok) return s;
    const out = { ...s };
    if (!out.error && out.source === 'arxiv') {
      out.error = '本次未取回任何 arXiv 记录（该次运行早于原因诊断功能，未记录具体原因）。';
    }
    /*
     * 老记录只有 status + 一句 error，没有按原因分类的计数。
     * 这里**只从已记录的错误文本重新推导一个主要原因标签**（不编造次数），
     * 这样页面不会出现「HTTP 429」与「超时」两个互相矛盾的说法。
     * 只对真正会发网络请求的来源（live）这样做：
     * ACL 是「未同步」、IEEE 是「待配置」，它们根本不是网络失败，
     * 给它们贴「网络错误」是错的。
     */
    const meta = SOURCE_META[out.source];
    if (!out.causes && (out.error || out.status) && meta && meta.kind === 'live') {
      const cause = classifyArxivFailure({ status: out.status, error: out.error });
      out.primaryCause = cause;
      out.primaryCauseLabel = ARXIV_CAUSE_LABEL[cause] || cause;
      out.causeDerived = true;   // 标明这是从旧记录推导的，不是当时分类的
    }
    return out;
  });

  return {
    ok: true, empty: false,
    run: {
      id: run.id, runDate: run.run_date, reason: run.reason, status: run.status,
      pickedCount: run.picked_count, candidates: run.candidates,
      startedAt: run.started_at, finishedAt: run.finished_at,
      log: store.parseJson(run.log, []),
    },
    items, sources,
    // 目标篇数取当前设置，不写死 3（设置改了页面口径也要跟着变）
    size: Math.max(1, Math.min(50, Number(getSettings().frontierSize) || 3)),
    insufficient: items.length < (Number(getSettings().frontierSize) || 3),
    newTodayCount,
    carriedOverCount,
    aiConfigured: (() => { try { return require('./interpret').isConfigured(); } catch { return false; } })(),
    note: [
      items.length < (Number(getSettings().frontierSize) || 3)
        ? `本次只选出 ${items.length} 篇（目标 ${Math.max(1, Math.min(50, Number(getSettings().frontierSize) || 3))} 篇）。`
          + '工作台不会用不相关的论文凑数；可查看下方各来源的真实状态与失败原因。'
        : null,
      // 如实说明「今天新采到几篇、沿用早前采集几篇」，避免把旧记录说成今日新发现
      items.length && carriedOverCount > 0
        ? `本次入选 ${items.length} 篇中，${newTodayCount} 篇为今天新采集，`
          + `${carriedOverCount} 篇沿用早前采集（原采集日见每篇卡片）。`
        : null,
    ].filter(Boolean).join(' ') || null,
  };
}

const DOC_TYPE_LABELS = {
  'journal-article': '期刊论文',
  'conference-paper': '会议论文',
  preprint: '预印本',
  report: '报告 / 其他文献',
  other: '其他',
};

/* ------------------------------------------------------------------ *
 * 前沿条目的篇关摘译文（原文永远保留；没有原文就明确说没有）
 *
 * 为什么放在 frontier_items 上而不是复用 translations 表：
 * translations 的外键绑定 papers(id)，而前沿条目**刻意不进 papers**
 * （避免污染期刊合格统计）。所以这里单独缓存译文。
 * ------------------------------------------------------------------ */

const FRONTIER_SYS_PROMPT = `你是学术文献翻译助手，把英文学术论文的题名或摘要翻译成中文。

铁规则：
1. 只翻译我给的内容，不得增加、删减、解释、评论或补写任何信息。
2. 学术术语用规范译法（automated writing evaluation → 自动写作评估，
   corrective feedback → 纠正性反馈，speech recognition → 语音识别，
   learning analytics → 学习分析，preprint → 预印本）。
3. 专名（模型名、系统名、会议名、量表名）保留原文。
4. 数字、百分比、p 值、样本量、年份必须逐字保留。
5. 保持原文结构；摘要通常一段，不要拆成多段或加小标题。
6. 只输出译文本身，不要任何前言、说明或 Markdown 标记。`;

/**
 * 为最近一次精选条目生成/复用中文译文。
 * 已有译文直接复用（不重复调用模型）；失败时记录错误但保留原文。
 */
async function translatePicks({ runId = null, fields = ['title', 'abstract'], force = false, limit = 6 } = {}) {
  const run = runId
    ? store.get('SELECT * FROM frontier_runs WHERE id = ?', [runId])
    : store.get('SELECT * FROM frontier_runs ORDER BY id DESC LIMIT 1');
  if (!run) return { ok: false, error: '还没有前沿技术精选' };

  const rows = store.all(
    `SELECT fi.* FROM frontier_picks fp JOIN frontier_items fi ON fi.id = fp.item_id
      WHERE fp.run_id = ? ORDER BY fp.rank`, [run.id]);

  const interpret = require('./interpret');
  const aiConfigured = interpret.isConfigured();
  const out = {};
  let calls = 0;
  let skipped = 0;

  for (const r of rows) {
    out[r.id] = {};
    for (const f of fields) {
      const src = f === 'title' ? r.title : r.abstract;
      const cacheCol = f === 'title' ? 'title_zh' : 'abstract_zh';
      if (!src || !String(src).trim()) {
        out[r.id][f] = { ok: false, available: false, error: f === 'title' ? '原始数据未提供题名' : '原始数据未提供摘要' };
        continue;
      }
      if (r[cacheCol] && !force) {
        out[r.id][f] = { ok: true, cached: true, text: r[cacheCol], createdAt: r.translated_at || null, model: r.translate_model || null };
        skipped++;
        continue;
      }
      if (!aiConfigured) {
        out[r.id][f] = { ok: false, configured: false, error: '未配置 AI 密钥，暂不能生成译文（原文照常显示）' };
        continue;
      }
      if (calls >= limit) { out[r.id][f] = { ok: false, error: '本轮已达生成上限，可稍后重试' }; continue; }
      calls++;
      try {
        const instr = f === 'title'
          ? '请翻译以下论文题名，只输出译文，不要加书名号或引号。'
          : '请翻译以下论文摘要，保持一段，不要加「摘要」二字。';
        const text = String(src).length > (f === 'title' ? 1200 : 6000) ? String(src).slice(0, f === 'title' ? 1200 : 6000) : String(src);
        const res = await interpret.callModel([
          { role: 'system', content: FRONTIER_SYS_PROMPT },
          { role: 'user', content: `${instr}\n\n---\n${text}\n---` },
        ], { temperature: 0.15, maxTokens: f === 'title' ? 900 : 2600 });
        if (!res.ok) {
          store.run(`UPDATE frontier_items SET translate_error=? WHERE id=?`, [String(res.error).slice(0, 500), r.id]);
          out[r.id][f] = { ok: false, error: res.error, retryable: true };
          continue;
        }
        const translated = String(res.content || '').trim();
        if (!translated) {
          store.run(`UPDATE frontier_items SET translate_error=? WHERE id=?`, ['模型返回空内容', r.id]);
          out[r.id][f] = { ok: false, error: '模型返回空内容', retryable: true };
          continue;
        }
        store.run(
          `UPDATE frontier_items SET ${cacheCol}=?, translated_at=?, translate_model=?, translate_error=NULL WHERE id=?`,
          [translated, clock.nowIso(), res.model || getSettings().aiModel || null, r.id]);
        out[r.id][f] = { ok: true, cached: false, text: translated, createdAt: clock.nowIso() };
      } catch (e) {
        store.run(`UPDATE frontier_items SET translate_error=? WHERE id=?`, [String(e.message).slice(0, 500), r.id]);
        out[r.id][f] = { ok: false, error: e.message, retryable: true };
      }
    }
  }

  return {
    ok: calls > 0 || skipped > 0,
    configured: aiConfigured, calls, fromCache: skipped, results: out,
    attribution: '译文由 AI 生成，仅供参考；引用请以原文为准。',
  };
}

module.exports = {
  FRONTIER_QUERIES, SOURCE_META, DOC_TYPE_LABELS, ARXIV_CATS,
  ericSearch, ericToItem, ericDocType, doiFromUrl,
  arxivSearch, parseArxivAtom, baseArxivId, classifyArxivFailure, ARXIV_CAUSE_LABEL,
  ieeeStatus, hitDirections, planPicks, dedupKeyFor, linkToPublished,
  collect, generate, get, translatePicks,
  status: async () => {
    /*
     * 除了「来源是否可用」，还要给出**最近一次运行**的真实结果，
     * 否则设置页会在 arXiv 今天全部失败的情况下仍然显示「已接通」。
     * 这里复用 get()，它已经算好了每源的本次状态与失败原因。
     */
    const latest = get();
    return {
      sources: [SOURCE_META.eric, SOURCE_META.arxiv, SOURCE_META.acl, SOURCE_META.ieee].map((m) => ({ ...m })),
      ieee: ieeeStatus(),
      items: store.get('SELECT COUNT(*) c FROM frontier_items').c,
      lastRun: latest.run || null,
      lastRunSources: latest.sources || [],
      lastRunPicked: (latest.items || []).length,
      lastRunNewToday: latest.newTodayCount == null ? null : latest.newTodayCount,
      lastRunCarriedOver: latest.carriedOverCount == null ? null : latest.carriedOverCount,
    };
  },
};

const legacyTranslatePicks=module.exports.translatePicks;
module.exports.translatePicks=async function(o={}){if(!require('./customize').get('profiles'))return legacyTranslatePicks(o);const items=get().items||[],results={};let calls=0;for(const s of items){results[s.id]={};for(const field of o.fields||['title','abstract']){if(calls>=(o.limit||6))continue;results[s.id][field]=await require('./multilingual').translate({subjectKey:'frontier:'+s.id,field,force:o.force});calls++;}}return {ok:true,results,calls};};

const legacyFrontierGet=module.exports.get;
module.exports.get=function(...args){const r=legacyFrontierGet(...args),failure=require('./customize').get('frontierFailure');return failure?{...r,sources:failure.sources,lastAttempt:failure.at,error:'最新采集失败，当前显示上次缓存'}:r;};
