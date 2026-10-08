'use strict';
/**
 * 文献元数据源（不抓取网页、不绕过付费墙，只使用公开 API）。
 *
 *  - crossref   : 元数据权威来源，覆盖开放获取与商业期刊的题录、摘要(若有)、在线发表日期
 *  - openalex   : 补充主题归属、被引、开放获取状态、语言
 *  - doaj       : 开放获取期刊目录核验
 *  - unpaywall  : 合法开放全文位置（需要邮箱）
 *  - europepmc  : 部分学科的开放全文
 */
const { fetchJson } = require('./http');
const { getContactEmail, getSecret, getSettings } = require('./config');
const N = require('./normalize');

const CROSSREF = 'https://api.crossref.org';
const OPENALEX = 'https://api.openalex.org';

/* ------------------------------------------------------------------ *
 * Crossref
 * ------------------------------------------------------------------ */

function crossrefToPaper(item, topicSlug) {
  const doi = N.normalizeDoi(item.DOI);
  const title = cleanTitle((item.title || [])[0] || item['short-container-title']?.[0] || '');
  if (!title) return null;

  const authors = N.formatAuthors(item.author || []);
  const journalName = cleanTitle((item['container-title'] || [])[0] || '');
  const issnList = (item.ISSN || []).map(N.normalizeIssn).filter(Boolean);
  const issued = dateFromParts(item.issued);
  const online = dateFromParts(item['published-online']);
  const print = dateFromParts(item['published-print']);

  return {
    source: 'crossref',
    doi,
    title,
    authors,
    journalName,
    issn: issnList[0] || null,
    issnList,
    abstract: N.cleanAbstract(item.abstract),
    abstractSource: item.abstract ? 'crossref' : null,
    publishedOnline: online,
    publishedPrint: print,
    issuedDate: issued || online || print,
    // 卷/期/页统一过一遍占位符清洗：Crossref 对某些出版商原样返回
    // page: "None-None"（出版商把 Python 的 None 格式化进了元数据），
    // 不清掉就会在页面上显示成「卷 150 期 1 · None-None」。
    volume: N.cleanPlaceholder(item.volume),
    issue: N.cleanPlaceholder(item.issue),
    pages: N.cleanPlaceholder(item.page),
    url: item.URL || (doi ? `https://doi.org/${doi}` : null),
    publisher: item.publisher || null,
    type: item.type || null,
    // Crossref 的 subject 是出版商/数据库给出的主题分类，不是作者关键词。
    // 因此这里既不作 keywords，也不冒充作者关键词，单独存为 dbSubjects。
    dbSubjects: Array.isArray(item.subject) ? item.subject : [],
    keywords: [],                 // Crossref 不提供作者关键词
    keywordsSource: null,
    language: item.language || null,
    openAccess: false,
    oaStatus: null,
    citationCount: item['is-referenced-by-count'] != null ? Number(item['is-referenced-by-count']) : null,
    externalIds: { crossref: doi },
    topics: topicSlug ? [topicSlug] : [],
  };
}

function cleanTitle(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
/**
 * Crossref `date-parts` → 日期字符串。
 *
 * 关键：**不补月、不补日**。Crossref 对很多记录只返回 [2026]（只有年），
 * 旧版补成 "2026-01-01" 会在库里造出一个并不存在的「1 月 1 日」，
 * 随后在卡片、排序和「发表仅 N 天」里被当成真实出版日。
 * 现在按实际精度返回：'2026' / '2026-09' / '2026-09-14'，
 * 精度由 normalize.datePrecision 统一判定（只有年 → year）。
 */
function dateFromParts(dp) {
  const p = dp && dp['date-parts'] && dp['date-parts'][0];
  if (!p || !p[0]) return null;
  const y = String(p[0]);
  if (!/^\d{4}$/.test(y)) return null;
  const m = p[1];
  if (m == null || m === '') return y;
  const mm = String(m).padStart(2, '0');
  if (!/^\d{2}$/.test(mm) || Number(mm) < 1 || Number(mm) > 12) return y;
  const d = p[2];
  if (d == null || d === '') return `${y}-${mm}`;
  const dd = String(d).padStart(2, '0');
  if (!/^\d{2}$/.test(dd) || Number(dd) < 1 || Number(dd) > 31) return `${y}-${mm}`;
  return `${y}-${mm}-${dd}`;
}

async function crossrefSearch({ query, rows = 40, fromDate, untilDate, issn, relevanceOnly = true }) {
  const params = new URLSearchParams();
  // 用 Crossref 的相关度排序（不加 sort 参数即为相关度）。
  // 若按日期排序，先把极新的低相关论文排到前面，会污染主题相关性，因此默认不用日期排序；
  // 时间窗口只通过 filter 生效。
  params.set('query.bibliographic', query);
  params.set('query.title', query);
  params.set('rows', String(Math.min(rows, 100)));
  if (!relevanceOnly) { params.set('sort', 'published'); params.set('order', 'desc'); }
  const filters = ['type:journal-article'];
  if (fromDate) filters.push(`from-online-pub-date:${fromDate}`);
  if (untilDate) filters.push(`until-online-pub-date:${untilDate}`);
  if (issn) filters.push(`issn:${issn}`);
  params.set('filter', filters.join(','));
  params.set('select', 'DOI,title,author,container-title,issued,published-online,published-print,abstract,ISSN,volume,issue,page,URL,publisher,type,subject,is-referenced-by-count');
  params.set('mailto', getContactEmail());

  const res = await fetchJson(`${CROSSREF}/works?${params}`, {
    minGapMs: 400, cacheTtlMs: 6 * 3600 * 1000,
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error, papers: [], total: 0, ms: res.ms, url: res.url };
  }
  const items = res.data?.message?.items || [];
  return {
    ok: true, status: res.status, error: null, ms: res.ms, url: res.url,
    total: res.data?.message?.['total-results'] || 0,
    papers: items.map((i) => crossrefToPaper(i)).filter(Boolean),
  };
}

/** 按 DOI 精确取一条元数据（用户手动添加 / 核验用） */
async function crossrefByDoi(doi) {
  const d = N.normalizeDoi(doi);
  if (!d) return { ok: false, error: 'DOI 格式无法识别', paper: null };
  const res = await fetchJson(`${CROSSREF}/works/${encodeURIComponent(d)}`, {
    minGapMs: 400, cacheTtlMs: 12 * 3600 * 1000,
  });
  if (!res.ok || !res.data?.message) {
    return { ok: false, error: res.error || 'Crossref 未收录该 DOI', paper: null };
  }
  return { ok: true, error: null, paper: crossrefToPaper(res.data.message) };
}

/* ------------------------------------------------------------------ *
 * OpenAlex
 * ------------------------------------------------------------------ */

function invertAbstract(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const pairs = [];
  for (const [word, positions] of Object.entries(inv)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) pairs.push([p, word]);
  }
  if (!pairs.length) return null;
  pairs.sort((a, b) => a[0] - b[0]);
  return N.cleanAbstract(pairs.map((p) => p[1]).join(' '));
}

function openalexToPaper(w, topicSlug) {
  const title = cleanTitle(w.title || w.display_name || '');
  if (!title) return null;
  const loc = w.primary_location || {};
  const src = loc.source || {};
  const best = w.best_oa_location || {};
  const doi = N.normalizeDoi(w.doi);
  return {
    source: 'openalex',
    doi,
    title,
    authors: N.formatAuthors((w.authorships || []).map((a) => ({
      name: a.author?.display_name, given: a.author?.givenName, family: a.author?.familyName,
    }))),
    journalName: cleanTitle(src.display_name || ''),
    issn: N.normalizeIssn(src.issn_l) || N.normalizeIssn((src.issn || [])[0]) || null,
    issnList: (src.issn || []).map(N.normalizeIssn).filter(Boolean),
    abstract: invertAbstract(w.abstract_inverted_index),
    abstractSource: w.abstract_inverted_index ? 'openalex' : null,
    publishedOnline: w.publication_date || null,
    publishedPrint: null,
    issuedDate: w.publication_date || null,
    volume: N.cleanPlaceholder(w.biblio?.volume),
    issue: N.cleanPlaceholder(w.biblio?.issue),
    pages: N.cleanPlaceholder(w.biblio?.first_page ? `${w.biblio.first_page}${w.biblio.last_page ? '-' + w.biblio.last_page : ''}` : null),
    url: loc.landing_page_url || (doi ? `https://doi.org/${doi}` : w.id),
    pdfUrl: best.pdf_url || null,
    publisher: src.host_organization_name || null,
    type: w.type || null,
    language: w.language || null,
    openAccess: Boolean(w.open_access?.is_oa),
    oaStatus: w.open_access?.oa_status || null,
    license: best.license || null,
    citationCount: w.cited_by_count != null ? Number(w.cited_by_count) : null,
    externalIds: { openalex: w.id, pmid: w.ids?.pmid || null },
    topics: topicSlug ? [topicSlug] : [],
    // OpenAlex keywords：由 OpenAlex 从论文中提取的关键词。
    // 它不是出版商原始的作者关键词，必须在界面上与「作者关键词」区分标注。
    // 按 OpenAlex 给出的相关度降序排列，最相关的关键词排前面
    keywords: Array.isArray(w.keywords)
      ? w.keywords
          .map((k) => (typeof k === 'string' ? { name: k, score: null } : { name: k?.display_name, score: k?.score ?? null }))
          .filter((k) => k.name)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .map((k) => k.name)
          .slice(0, 20)
      : [],
    keywordsSource: (Array.isArray(w.keywords) && w.keywords.length) ? 'openalex' : null,
    // 数据库主题词（OpenAlex topics / subfields），与作者关键词、工作台主题标签都分开
    dbTopics: Array.isArray(w.topics)
      ? w.topics.map((t) => ({
          name: t.display_name,
          field: t.field?.display_name || null,
          domain: t.domain?.display_name || null,
          score: t.score ?? null,
        })).filter((t) => t.name).slice(0, 8)
      : [],
    concepts: (w.topics || []).map((t) => t.display_name).filter(Boolean).slice(0, 6),
  };
}

/** 真实请求（密钥只用于请求，不进入 url 字段/日志） */
async function openalexSearch(opts) {
  const params = new URLSearchParams();
  const filters = ['type:article', 'primary_location.source.type:journal'];
  if (opts.fromDate) filters.push(`from_publication_date:${opts.fromDate}`);
  if (opts.untilDate) filters.push(`to_publication_date:${opts.untilDate}`);
  if (opts.language) filters.push(`language:${opts.language}`);
  params.set('filter', filters.join(','));
  params.set('search', opts.query);
  params.set('per-page', String(Math.min(opts.rows || 40, 100)));
  params.set('sort', 'publication_date:desc');
  /*
   * select 必须列全下游真正会用到的字段。
   *
   * 缺陷修复：`openalexToPaper` 会读 `w.keywords` 与 `w.topics` 来填充
   * keywords / dbTopics，但旧版的 select 里**没有 keywords**——
   * 于是每日检索拿到的记录永远没有关键词（keywordSource 恒为 null），
   * 而只有 backfill-keywords（走 openalexByDoi，不传 select）才拿得到。
   * 这里把 keywords 显式请求回来，让每日采集的结果与补全结果一致。
   */
  params.set('select', 'id,doi,title,display_name,publication_date,primary_location,best_oa_location,authorships,abstract_inverted_index,cited_by_count,open_access,type,language,biblio,topics,keywords,ids');
  params.set('mailto', getContactEmail());
  const key = getSecret('openAlexApiKey');
  if (key) params.set('api_key', key);
  const realUrl = `${OPENALEX}/works?${params.toString()}`;
  const res = await fetchJson(realUrl, { minGapMs: 250, cacheTtlMs: 6 * 3600 * 1000 });
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error, papers: [], total: 0, ms: res.ms,
      url: realUrl.replace(key || '___none___', '***') };
  }
  const items = res.data?.results || [];
  return {
    ok: true, status: res.status, error: null, ms: res.ms,
    url: realUrl.replace(key || '___none___', '***'),
    total: res.data?.meta?.count || 0,
    papers: items.map((i) => openalexToPaper(i)).filter(Boolean),
  };
}

async function openalexByDoi(doi) {
  const d = N.normalizeDoi(doi);
  if (!d) return { ok: false, error: 'DOI 格式无法识别', paper: null };
  const key = getSecret('openAlexApiKey');
  const params = new URLSearchParams();
  params.set('mailto', getContactEmail());
  if (key) params.set('api_key', key);
  const res = await fetchJson(`${OPENALEX}/works/https://doi.org/${encodeURIComponent(d)}?${params}`,
    { minGapMs: 250, cacheTtlMs: 12 * 3600 * 1000 });
  if (!res.ok || !res.data?.id) return { ok: false, error: res.error || 'OpenAlex 未收录该 DOI', paper: null };
  return { ok: true, error: null, paper: openalexToPaper(res.data) };
}

/* ------------------------------------------------------------------ *
 * Semantic Scholar（补充来源）
 * 优点：对「汉语作为第二语言 / 国际中文教育」类英文期刊覆盖较好，
 *       且直接提供摘要，可补 Crossref 缺摘要的问题。
 * 限制：匿名调用有速率限制；不提供期刊分区信息。
 * ------------------------------------------------------------------ */

function s2ToPaper(w, topicSlug) {
  const title = cleanTitle(w.title || '');
  if (!title) return null;
  const doi = N.normalizeDoi(w.externalIds?.DOI);
  // 只有年时就用「年」，不要补成 1 月 1 日（那会造出一个不存在的出版日）
  const date = w.publicationDate || (w.year ? String(w.year) : null);
  return {
    source: 'semanticscholar',
    doi,
    title,
    authors: N.formatAuthors((w.authors || []).map((a) => ({ name: a.name }))),
    journalName: cleanTitle(w.venue || ''),
    issn: null,
    issnList: [],
    abstract: N.cleanAbstract(w.abstract),
    abstractSource: w.abstract ? 'semanticscholar' : null,
    publishedOnline: date,
    publishedPrint: null,
    issuedDate: date,
    volume: N.cleanPlaceholder(w.journal?.volume),
    issue: null,
    pages: N.cleanPlaceholder(w.journal?.pages),
    url: w.url || (doi ? `https://doi.org/${doi}` : null),
    pdfUrl: w.openAccessPdf?.url || null,
    publisher: null,
    type: w.publicationTypes?.[0] || null,
    language: null,
    openAccess: Boolean(w.openAccessPdf?.url),
    oaStatus: w.openAccessPdf?.url ? 'open' : null,
    citationCount: w.citationCount ?? null,
    externalIds: { semanticscholar: w.paperId, pmid: w.externalIds?.PubMed || null },
    keywords: Array.isArray(w.fieldsOfStudy) ? w.fieldsOfStudy.slice(0, 20) : [],
    keywordsSource: (Array.isArray(w.fieldsOfStudy) && w.fieldsOfStudy.length) ? 'semanticscholar:fieldsOfStudy' : null,
    dbTopics: [],
    topics: topicSlug ? [topicSlug] : [],
  };
}

/**
 * Semantic Scholar 的搜索按相关度返回，且没有「按发布日期过滤」的参数，
 * 直接按窗口过滤会把结果清空（相关度最高的往往不是最新论文）。
 * 因此这里加大抓取量、按日期排序后取窗口内的最新若干篇，
 * 并在返回值里说明过滤方式，避免让使用者误以为该源没有新论文。
 */
async function semanticScholarSearch({ query, rows = 20, fromDate, untilDate, fetchMultiplier = 5 }) {
  const params = new URLSearchParams();
  params.set('query', query);
  params.set('limit', String(Math.min(rows * fetchMultiplier, 100)));
  params.set('fields', 'title,abstract,year,publicationDate,externalIds,venue,authors,citationCount,openAccessPdf,publicationTypes,fieldsOfStudy,journal,url');
  // 匿名调用限流非常严格：不重试，失败即熔断，避免拖慢整轮采集
  const res = await fetchJson(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, {
    minGapMs: 2500, retries: 0, cacheTtlMs: 6 * 3600 * 1000,
  });
  if (!res.ok) {
    return {
      ok: false, status: res.status, error: res.error, papers: [], total: 0, ms: res.ms, url: res.url,
      throttled: res.throttled,
      hint: res.status === 429 ? 'Semantic Scholar 匿名调用限流，稍后重试即可；其他来源继续采集。' : null,
    };
  }
  const items = res.data?.data || [];
  let papers = items.map((i) => s2ToPaper(i)).filter(Boolean);
  const beforeFilter = papers.length;
  // 先按日期降序，再按窗口筛选：优先保留窗口内最新的论文
  papers.sort((a, b) => String(b.issuedDate || '').localeCompare(String(a.issuedDate || '')));
  if (fromDate) papers = papers.filter((p) => !p.issuedDate || p.issuedDate >= fromDate);
  if (untilDate) papers = papers.filter((p) => !p.issuedDate || p.issuedDate <= untilDate);
  papers = papers.slice(0, rows);
  return {
    ok: true, status: res.status, error: null, ms: res.ms, url: res.url,
    total: res.data?.total || beforeFilter,
    papers,
    fetched: beforeFilter,
    filterNote: `按相关度抓取 ${beforeFilter} 篇后，按发布日期筛出窗口内最新 ${papers.length} 篇（该接口不支持日期参数）`,
  };
}

/* ------------------------------------------------------------------ *
 * 期刊目录核验
 * ------------------------------------------------------------------ */

/** DOAJ：开放获取期刊目录（核实该刊是否被 DOAJ 收录） */
async function doajByIssn(issn) {
  const i = N.normalizeIssn(issn);
  if (!i) return { ok: false, error: 'ISSN 无效', journal: null };
  const res = await fetchJson(`https://doaj.org/api/v2/search/journals/issn%3A${i}`, {
    minGapMs: 500, cacheTtlMs: 24 * 3600 * 1000,
  });
  if (!res.ok) return { ok: false, error: res.error, journal: null };
  const first = res.data?.results?.[0]?.bibjson;
  if (!first) return { ok: true, journal: null, error: null };
  return {
    ok: true, error: null,
    journal: {
      title: first.title,
      pissn: first.pissn, eissn: first.eissn,
      publisher: first.publisher?.name,
      inDoaj: true,
      source: 'DOAJ',
    },
  };
}

/** Unpaywall：合法开放全文位置（需要邮箱，免费） */
async function unpaywallByDoi(doi) {
  const d = N.normalizeDoi(doi);
  if (!d) return { ok: false, error: 'DOI 无法识别', oa: null };
  const res = await fetchJson(
    `https://api.unpaywall.org/v2/${encodeURIComponent(d)}?email=${encodeURIComponent(getContactEmail())}`,
    { minGapMs: 400, cacheTtlMs: 12 * 3600 * 1000 });
  if (!res.ok) return { ok: false, error: res.error, oa: null };
  const m = res.data || {};
  return {
    ok: true, error: null,
    oa: {
      isOa: Boolean(m.is_oa),
      status: m.oa_status || null,
      best: m.best_oa_location ? {
        url: m.best_oa_location.url_for_pdf || m.best_oa_location.url,
        hostType: m.best_oa_location.host_type,
        license: m.best_oa_location.license,
        version: m.best_oa_location.version,
      } : null,
      journal: m.journal_name || null,
      issn: m.journal_issns || null,
      publisher: m.publisher || null,
    },
  };
}

/** Crossref 开放获取 TDM 链接（合法全文，需出版商开放） */
async function crossrefFulltextLink(doi) {
  const d = N.normalizeDoi(doi);
  if (!d) return null;
  const res = await fetchJson(`${CROSSREF}/works/${encodeURIComponent(d)}`, {
    minGapMs: 400, cacheTtlMs: 24 * 3600 * 1000,
  });
  if (!res.ok) return null;
  const links = res.data?.message?.link || [];
  const pdf = links.find((l) => /pdf/i.test(l['content-type'] || '')) || null;
  return pdf ? { url: pdf.URL, contentType: pdf['content-type'], intended: pdf['intended-application'] } : null;
}

/** 期刊元数据（用于期刊名/ISSN 交叉核验） */
async function crossrefJournalByIssn(issn) {
  const i = N.normalizeIssn(issn);
  if (!i) return { ok: false, error: 'ISSN 无效', journal: null };
  const res = await fetchJson(`${CROSSREF}/journals/${encodeURIComponent(i)}`,
    { minGapMs: 400, cacheTtlMs: 24 * 3600 * 1000 });
  if (!res.ok) return { ok: false, error: res.error, journal: null };
  const m = res.data?.message || {};
  return {
    ok: true, error: null,
    journal: {
      title: (m.title || ''),
      issn: (m.ISSN || []).map(N.normalizeIssn).filter(Boolean),
      publisher: m.publisher || '',
      totalDois: m.counts?.['total-dois'] || 0,
      source: 'Crossref',
    },
  };
}

/** 数据源健康检查 */
async function healthCheck() {
  const out = [];
  const t0 = Date.now();
  const cr = await fetchJson(`${CROSSREF}/works?rows=1&select=DOI`, { minGapMs: 0, retries: 1, cacheTtlMs: 60 * 1000 });
  out.push({ id: 'crossref', name: 'Crossref', ok: cr.ok, status: cr.status, ms: cr.ms, error: cr.error,
    coverage: '期刊题录/DOI/摘要/在线发表日期；对中文 CSSCI 期刊收录有限' });
  const oa = await openalexSearch({ query: 'language education', rows: 1 });
  const oaInsufficient = /Insufficient budget|no API key/i.test(String(oa.error || ''));
  out.push({
    id: 'openalex', name: 'OpenAlex', ok: oa.ok, status: oa.status, ms: oa.ms, error: oa.error,
    needsApiKey: oaInsufficient,
    coverage: '主题/被引/开放获取/语言；摘要覆盖不全；不提供期刊分区',
    fix: oaInsufficient
      ? '匿名调用共享同一个每日免费额度，用尽后当天不再可用（UTC 午夜重置）。到「设置 → OpenAlex API Key」填入免费 Key 即可恢复。'
      : (oa.ok ? null : '可稍后重试，或填入 OpenAlex API Key。'),
  });
  const dj = await doajByIssn('2151-0380');
  out.push({ id: 'doaj', name: 'DOAJ', ok: dj.ok, status: dj.ok ? 200 : null, ms: null, error: dj.error,
    coverage: '开放获取期刊核验；与 SSCI/CSSCI 无关' });
  const up = await unpaywallByDoi('10.1017/S0272263121000010');
  out.push({
    id: 'unpaywall', name: 'Unpaywall', ok: up.ok, status: up.ok ? 200 : null, ms: null, error: up.error,
    coverage: '合法开放全文位置；需要有效邮箱（设置里的联系邮箱会被发送给该服务）',
    fix: !up.ok && String(up.error).includes('404')
      ? '该测试 DOI 在 Unpaywall 无记录（404 表示「这篇没有开放版本」，与接口是否可用无关）。'
      : (!up.ok ? '请检查「设置 → 联系邮箱」是否填写了真实邮箱。' : null),
  });
  const s2 = await semanticScholarSearch({ query: 'Chinese as a second language', rows: 1 });
  out.push({ id: 'semanticscholar', name: 'Semantic Scholar（可选）', ok: s2.ok, status: s2.status, ms: s2.ms,
    error: s2.error,
    coverage: '补充摘要与「汉语作为第二语言」类英文期刊。匿名调用限流严格（HTTP 429 很常见），默认不参与采集；'
      + '需要时可在设置里开启，或申请免费 API Key。不提供期刊分区信息。' });
  out.push({ id: 'jcr_csv', name: 'JCR/SSCI 目录（本地 CSV 导入）', ok: true, status: null, ms: null, error: null,
    coverage: '需机构权限的目录，由用户导入；系统不代猜分区' });
  out.push({ id: 'cssci_csv', name: 'CSSCI / 北大核心目录（本地 CSV 导入）', ok: true, status: null, ms: null, error: null,
    coverage: '需机构权限的目录，由用户导入' });
  return { checkedAt: new Date().toISOString(), elapsedMs: Date.now() - t0, sources: out };
}

module.exports = {
  crossrefSearch, crossrefByDoi, crossrefJournalByIssn, crossrefFulltextLink,
  openalexSearch, openalexByDoi, semanticScholarSearch,
  doajByIssn, unpaywallByDoi, healthCheck,
  crossrefToPaper, openalexToPaper,
};
