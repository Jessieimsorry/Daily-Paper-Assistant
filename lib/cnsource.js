'use strict';
/**
 * 公开中文期刊目录 → 每日增量发现。
 *
 * 背景：中文 CSSCI 期刊极少在 Crossref 注册 DOI，所以「每日自动发现新的中文论文」
 * 一直只能靠手工导入题录。本模块接入**公开可解析**的中文期刊目录页，
 * 把逐篇题录（题名/作者/刊名/年期/页码/原页链接）纳入既有的主题匹配、去重、
 * 发现页与简报链路。
 *
 * 三条硬约束：
 *   1. **只取公开元数据**：题名、作者、刊名、年期、页码、文章原页链接。
 *      缺失字段留空——特别是**不猜 DOI、不编摘要**。
 *   2. **不绕过任何限制**：不处理验证码、不登录、不付费、不批量抓全文。
 *      目录页本身公开可读才接入；逐篇详情页若需登录则不用。
 *   3. **不作为期刊等级依据**：本模块只提供题录，绝不把源页当作
 *      CSSCI / 北大核心目录核验依据（那是 journals.js 的职责，且必须由用户导入官方目录）。
 *
 * 已实测的来源：
 *   · 国家哲学社会科学文献中心《世界汉语教学》
 *     https://www.ncpssd.cn/journal/details?gch=97257X&langType=1&nav=1
 *     静态 HTML，逐篇给出 题名 / 作者 / 页码 / 稳定文章 ID / 中图分类号，且可重复抓取。
 *   · 延边大学《汉语学习》往期目录 https://hyxx.ybu.edu.cn/index/wqml.htm
 *     实测**逐期页面只有整版 JPEG 扫描图**（vsb_pdf_image_data 指向 .jpg），
 *     没有任何可解析的逐篇文字，因此**不接入**，只登记为「不可解析」并在状态里说明。
 */
const path = require('node:path');
const store = require('./store');
const N = require('./normalize');
const http = require('./http');
const clock = require('./clock');

/* ------------------------------------------------------------------ *
 * 来源登记
 * ------------------------------------------------------------------ */

const SOURCES = [
  {
    key: 'ncpssd_sjhyjx',
    name: '国家哲学社会科学文献中心《世界汉语教学》目录',
    journalName: '世界汉语教学',
    gch: '97257X',                       // 源站刊物代码
    homepage: 'https://www.ncpssd.cn/journal/details?gch=97257X&langType=1&nav=1',
    kind: 'ncpssd_toc',
    parser: 'ncpssd',
    // 目录页公告的是「本期」，没有逐期公布日期；用检查日作为「目录可见日期」，
    // 并在证据里标明这是目录可见日期而不是出版日期。
    dateBasis: 'catalog_seen',
  },
  {
    key: 'ybu_hyxx_toc',
    name: '延边大学《汉语学习》往期目录',
    journalName: '汉语学习',
    homepage: 'https://hyxx.ybu.edu.cn/index/wqml.htm',
    kind: 'image_scan_only',
    parser: null,                        // 只有扫描图，不解析
    disabled: true,
    disabledReason: '往期页面只有整版 JPEG 扫描图（vsb_pdf_image_data 指向 .jpg），'
      + '没有可解析的逐篇文字；按「不假装成功」的原则不接入。',
  },
];

function listSources() {
  return SOURCES.map((s) => ({ ...s }));
}
function getSource(key) {
  return SOURCES.find((s) => s.key === key) || null;
}

/* ------------------------------------------------------------------ *
 * 来源状态
 * ------------------------------------------------------------------ */

function sourceState(key) {
  const row = store.get('SELECT * FROM cn_sources WHERE source_key = ?', [key]);
  if (row) return { ...row };
  return {
    source_key: key, name: getSource(key)?.name || key,
    homepage: getSource(key)?.homepage || null, kind: getSource(key)?.kind || null,
    last_check_at: null, last_ok_at: null, last_status: null, last_issue: null,
    last_found: 0, last_added: 0, last_message: null, total_added: 0,
    first_seen_at: null, updated_at: null,
  };
}

function listSourceStates() {
  return SOURCES.map((s) => ({ ...sourceState(s.key), disabled: Boolean(s.disabled), disabledReason: s.disabledReason || null }));
}

function recordCheck(key, patch = {}) {
  const src = getSource(key);
  const cur = sourceState(key);
  const now = store.nowIso();
  const next = {
    source_key: key,
    name: patch.name || src?.name || key,
    homepage: patch.homepage || src?.homepage || null,
    kind: patch.kind || src?.kind || null,
    last_check_at: now,
    last_ok_at: patch.status === 'ok' ? now : cur.last_ok_at,
    last_status: patch.status || null,
    last_issue: patch.issue !== undefined ? patch.issue : cur.last_issue,
    last_found: patch.found != null ? patch.found : 0,
    last_added: patch.added != null ? patch.added : 0,
    last_message: patch.message || null,
    total_added: (cur.total_added || 0) + (patch.added || 0),
    first_seen_at: cur.first_seen_at || now,
    updated_at: now,
  };
  store.run(
    `INSERT INTO cn_sources(source_key,name,homepage,kind,last_check_at,last_ok_at,last_status,last_issue,
       last_found,last_added,last_message,total_added,first_seen_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source_key) DO UPDATE SET
       name=excluded.name, homepage=excluded.homepage, kind=excluded.kind,
       last_check_at=excluded.last_check_at, last_ok_at=excluded.last_ok_at,
       last_status=excluded.last_status, last_issue=excluded.last_issue,
       last_found=excluded.last_found, last_added=excluded.last_added,
       last_message=excluded.last_message, total_added=excluded.total_added,
       updated_at=excluded.updated_at`,
    [next.source_key, next.name, next.homepage, next.kind, next.last_check_at, next.last_ok_at,
      next.last_status, next.last_issue, next.last_found, next.last_added, next.last_message,
      next.total_added, next.first_seen_at, next.updated_at]);
  return sourceState(key);
}

/* ------------------------------------------------------------------ *
 * 解析：国家哲学社会科学文献中心目录页
 * ------------------------------------------------------------------ */

/**
 * 目录页里的日期（如 2026年09月28日）——这是**目录可见日期**，不是出版日期。
 * 找不到就返回 null，不猜。
 */
function parseCatalogDate(html) {
  const m = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(html || '');
  if (!m) return null;
  const pad = (x) => String(x).padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
}

/** 期次：2026年 第2期 → { year:'2026', issue:'2', label:'2026年第2期' } */
function parseIssue(html) {
  const m = /(\d{4})\s*年\s*第\s*(\d{1,2})\s*期/.exec(html || '');
  if (!m) return null;
  return { year: m[1], issue: m[2], label: `${m[1]}年第${m[2]}期` };
}

/**
 * 解析 ncpssd 目录页的逐篇题录。
 * 结构（实测）：每篇为一个 <p>，含
 *   openDetail('/Literature/articleinfo?id=<ID>&type=journalArticle...')
 *   title='<题名>'
 *   <span class='writer' title='作者[1];作者[2]'>
 *   <span class='pages'>(起-止)
 */
function parseNcpssdToc(html, source) {
  const s = String(html || '');
  const articles = [];
  /*
   * 解析策略：**先切条目块，再在块内取字段**。
   *
   * 试过两种写法，都不行，记录在此以免重蹈：
   *   ① 按 <p> 切块 + 块内「先找 id 再找最近 title=」
   *      → 跨块误配，把刊物 meta 简介当成一篇论文；
   *   ② 一条连续正则 `id ... title='...' (tail)`
   *      → 条目里嵌套着 `<a onclick="AddHandleCount(this, '…', '世界汉语教学', '')">`，
   *        tail 碰到那个单引号就停，作者与页码取不到，实测 10 篇只认出 2 篇。
   *
   * 现在按「一个 <p> 一条」切分：每条目录项都是一个独立 <p>，
   * 块内再各取各的字段，既不跨块误配，也不受嵌套单引号影响。
   */
  const blocks = s.split(/<p[\s>]/i).slice(1);
  for (const blk of blocks) {
    /*
     * 一个 <p> 里最多一条目录项。
     * 注意必须精确匹配 `?id=`：同一个块里前面还有一个
     * `/Literature/secure/articleinfo?params=<加密串>`（需登录的详情入口），
     * 若只匹配 `articleinfo\?` 会先命中它，导致整篇解析不出来。
     */
    const idm = /\/Literature\/articleinfo\?id=([A-Za-z0-9]+)/.exec(blk);
    if (!idm) continue;
    /*
     * 题名取同一 <a> 标签内的 title='…'。
     * 不能写成 `id=…[^>]*>[\s\S]{0,200}?title='…'`：
     * `[^>]*` 是**贪婪**的，会一路吞到该标签的 `>`（在 title= 之后），
     * 于是后面的 title 再也匹配不到 —— 这是本轮踩到的第三个解析坑。
     * 直接匹配 `title='…'` 即可，属性顺序与换行都不影响。
     */
    const tm = new RegExp(
      "/Literature/articleinfo\\?id=" + idm[1] + "[^>]*?title='([^']{2,400})'",
    ).exec(blk);
    if (!tm) continue;
    const title = N.decodeHtmlEntities(tm[1]).trim();
    if (!title) continue;

    const wm = /class=['"]writer['"][^>]*title=['"]([^'"]*)['"]/.exec(blk);
    const writers = wm ? N.decodeHtmlEntities(wm[1]).trim() : '';
    const pm = /class=['"]pages['"][^>]*>\s*\(?\s*([0-9]{1,6}\s*[-–—]\s*[0-9]{1,6}|[0-9]{1,6})\s*\)?/.exec(blk);
    const pages = pm ? N.cleanPlaceholder(pm[1].replace(/\s+/g, '')) : null;
    const cm = /AddHandleCount\([^)]*?'(\[[^\]]*\])'/.exec(blk);

    articles.push({
      articleId: idm[1],
      title,
      authorsRaw: writers,
      pages,
      clc: cm ? cm[1] : null,
      articleUrl: `https://www.ncpssd.cn/Literature/articleinfo?id=${idm[1]}&type=journalArticle&nav=1&langType=1`,
    });
  }

  // 同一篇可能在不同标签区块里重复出现，按 articleId 去重并保留首个
  const seen = new Set();
  const unique = [];
  for (const a of articles) {
    if (seen.has(a.articleId)) continue;
    seen.add(a.articleId);
    unique.push(a);
  }
  return { issue: parseIssue(s), catalogDate: parseCatalogDate(s), articles: unique, journalName: source?.journalName || null };
}

/* ------------------------------------------------------------------ *
 * 作者清洗与非研究论文过滤
 * ------------------------------------------------------------------ */

/**
 * 源里作者写成 `史维国[1];张炳丁[1]` / `郑航[1];李慧[2];杨端端[3,1]`。
 * 去掉机构角标，保留姓名；分号统一。**不编造缺失作者**。
 */
function cleanAuthors(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[;；]/)
    .map((x) => x.replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, '').trim())
    .filter(Boolean);
}

/**
 * 非研究论文过滤：征稿、简讯、书评书目、会议通知、稿约、更正、索引等。
 * 只认明确的非研究类型，宁可漏过也不错杀真实论文。
 */
const NON_RESEARCH_PATTERNS = [
  /^新书目$/, /^书目$/, /^书讯$/, /^书评$/,
  /^(征稿|稿约|投稿须知|征稿启事|征文启事)/,
  /^(简讯|消息|动态|会议|会议通知|启事|通知|公告)/,
  /^(更正|勘误|索引|目录|编后记|编者按|卷首语|发刊词|致读者|稿约)/,
  /^(致谢|作者索引|总目录|年度总目录)/,
  /(稿约|征稿启事|投稿指南)$/,
];

function isNonResearch(title, article) {
  const t = String(title || '').trim();
  if (!t) return { skip: true, reason: '题名为空' };
  for (const re of NON_RESEARCH_PATTERNS) {
    if (re.test(t)) return { skip: true, reason: `非研究论文（命中「${t}」）` };
  }
  // 页码起止相同且无作者，通常是补白/著录条目
  if (article && article.pages && /^(\d+)-\1$/.test(article.pages) && !(article.authorsRaw || '').trim()) {
    return { skip: true, reason: `占位条目（页码 ${article.pages} 且无作者）` };
  }
  return { skip: false, reason: null };
}

/* ------------------------------------------------------------------ *
 * 去重
 * ------------------------------------------------------------------ */

/**
 * 题录指纹。
 *
 * 必须与 discover.persistPapers 内部用的键**完全一致**：
 * 那边是 N.dedupKey({ doi, issn, title, year })，中文目录源没有 DOI/ISSN，
 * 因此只可能落到 `tt:<归一化题名>:<年>` 这条分支。
 *
 * 踩过的坑：最初这里自己拼了 `cn:刊名:题名:作者:年期`，
 * 与 persistPapers 的键不一致 —— 结果是每跑一次都判定为「新」，
 * 反复插入同名论文。去重必须与入库链路同源，不能各算一套。
 */
function cnDedupKey({ title, year }) {
  return N.dedupKey({ doi: null, issn: null, title, year: year ? String(year) : '' });
}

/* ------------------------------------------------------------------ *
 * 抓取 + 入库
 * ------------------------------------------------------------------ */

async function fetchSourcePage(source) {
  // 注意：源站对查询串里的中文很敏感（原样中文会返回 HTTP 400）。
  // 这里统一走 encodeURI，避免再次踩到「非 ASCII 进 URL」这个坑。
  const url = encodeURI(source.homepage);
  const r = await http.fetchText(url, { timeoutMs: 30000 });
  return { url, ...r };
}

/**
 * 检查一个来源并把新题录入库。
 * @returns {{ok:boolean, sourceKey:string, status:string, issue?:string, found:number,
 *            added:number, skipped:Array, message:string, ms:number}}
 */
async function checkSource(key, opts = {}) {
  const t0 = Date.now();
  const source = getSource(key);
  if (!source) return { ok: false, status: 'unknown_source', message: `未登记的来源 ${key}`, found: 0, added: 0, skipped: [] };

  if (source.disabled) {
    recordCheck(key, { status: 'not_parsable', found: 0, added: 0, message: source.disabledReason });
    return {
      ok: false, sourceKey: key, status: 'not_parsable', found: 0, added: 0, skipped: [],
      message: source.disabledReason, ms: Date.now() - t0,
    };
  }

  let page;
  try {
    page = await fetchSourcePage(source);
  } catch (e) {
    const msg = `抓取失败：${e.message || e}`;
    recordCheck(key, { status: 'http_error', found: 0, added: 0, message: msg });
    store.logEvent('warn', 'cn-source', `[${source.name}] ${msg}`, { sourceKey: key, url: source.homepage });
    return { ok: false, sourceKey: key, status: 'http_error', found: 0, added: 0, skipped: [], message: msg, ms: Date.now() - t0 };
  }
  if (!page.ok) {
    const msg = `HTTP ${page.status}`;
    recordCheck(key, { status: 'http_error', found: 0, added: 0, message: msg });
    store.logEvent('warn', 'cn-source', `[${source.name}] 目录页返回 ${msg}`, { sourceKey: key, url: page.url });
    return { ok: false, sourceKey: key, status: 'http_error', found: 0, added: 0, skipped: [], message: msg, ms: Date.now() - t0 };
  }

  // http.fetchText 把正文放在 data 里（曾经误写成 page.text，导致解析恒为空）
  const html = typeof page.data === 'string' ? page.data : '';
  const parsed = source.parser === 'ncpssd' ? parseNcpssdToc(html, source) : { issue: null, catalogDate: null, articles: [] };
  if (!parsed.articles.length) {
    const msg = '目录页可读，但没有解析到任何逐篇题录（可能改为图片/动态加载）';
    recordCheck(key, { status: 'parse_failed', found: 0, added: 0, message: msg, issue: parsed.issue?.label || null });
    store.logEvent('warn', 'cn-source', `[${source.name}] ${msg}`, { sourceKey: key, url: page.url });
    return { ok: false, sourceKey: key, status: 'parse_failed', found: 0, added: 0, skipped: [], message: msg, ms: Date.now() - t0 };
  }

  // 用「源 + 文章 ID」判断是不是已经见过
  const known = new Set(
    store.all('SELECT article_id FROM cn_article_imports WHERE source_key = ?', [key]).map((r) => r.article_id));

  const issueLabel = parsed.issue ? parsed.issue.label : null;
  const skipped = [];
  const fresh = [];
  for (const a of parsed.articles) {
    if (known.has(a.articleId)) { skipped.push({ title: a.title, reason: '已入库（源内已见）' }); continue; }
    const nr = isNonResearch(a.title, a);
    if (nr.skip) { skipped.push({ title: a.title, reason: nr.reason }); continue; }
    fresh.push(a);
  }

  // 题录指纹再挡一层：同一篇可能在别处已通过其他来源进库
  const added = [];
  const dupKeys = new Set(
    store.all('SELECT dedup_key FROM papers WHERE dedup_key IS NOT NULL').map((r) => r.dedup_key));
  for (const a of fresh) {
    const authors = cleanAuthors(a.authorsRaw);
    const dk = cnDedupKey({ title: a.title, year: parsed.issue?.year });
    if (dupKeys.has(dk)) { skipped.push({ title: a.title, reason: '已入库（题名+作者+刊名+年期重复）' }); continue; }
    added.push({ ...a, authors, dedupKey: dk });
    dupKeys.add(dk);
  }

  if (opts.dryRun) {
    return {
      ok: true, sourceKey: key, status: 'ok', issue: issueLabel,
      found: parsed.articles.length, added: 0, wouldAdd: added.length, skipped,
      articles: added, message: '演练模式，未写库', ms: Date.now() - t0,
    };
  }

  let inserted = 0;
  if (added.length) {
    // 复用既有采集入库链路（主题匹配、去重、资格判定都在里面）
    const discover = require('./discover');
    const payload = added.map((a) => ({
      title: a.title,
      authors: a.authors,
      journalName: source.journalName,
      /*
       * 只填**源页真的能证明**的字段：
       *   · 年 / 期 / 起止页 —— 目录页明确列出；
       *   · 出版日期 —— 源页没有逐篇出版日期，**留空**。
       *     这里曾经把「目录可见日期」写进 published_online，等于把
       *     「目录今天看到它」伪装成「论文今天首次在线」，还会白白拿到
       *     「仅 0 天」的新近度加分。目录首次见到的时间另有 discovery_date
       *     与证据里的 catalogDate 记录，不需要也不应该占用出版日期字段。
       *   · 卷号 —— 源页只给「年」，没有卷号，**留空**，不能把年份当卷号；
       *   · 语种 —— 目录源只说明刊物的出版语种，**不能据此断定每一篇都是中文**：
       *     该刊 2026 年第 2 期就有一篇英文题名的文章（#1238）。
       *     所以这里不预设 language，交给 resolvePaperLanguage 按题名等证据判定。
       */
      issuedDate: parsed.issue ? `${parsed.issue.year}` : null,
      publishedOnline: null,
      publishedPrint: null,
      volume: null,
      issue: parsed.issue ? parsed.issue.issue : null,
      pages: a.pages || null,
      url: a.articleUrl || null,
      language: null,
      abstract: null,
      doi: null,
      sources: [`cn-catalog:${key}`],
      sourceQueries: [`中文目录源 ${source.name} ${issueLabel || ''}`.trim()],
    }));
    /*
     * 主题匹配：目录源只有题名可依据，因此按题名做主题推断。
     * 不做这一步的话，题录虽然入库，却因为没有主题证据而**不会出现在
     * 「今日发现」列表里**（该列表只收录有主题证据的论文），
     * 等于白采集。推断依据是题名，证据不足就不贴标签（宁可无标签也不硬塞）。
     */
    const rank = require('./rank');
    const topics = store.all('SELECT * FROM topics WHERE enabled = 1');
    for (const pl of payload) {
      const guess = rank.inferTopics({ title: pl.title, topics: [] }, topics, { keepExistingWhenEmpty: false });
      if (guess.length) pl.topics = guess;
    }

    const res = discover.persistPapers(payload);
    inserted = res.inserted || 0;

    /*
     * 目录源的「已知未知」字段必须保持为空。
     *
     * 为什么需要这一步：persistPapers 的 UPDATE 分支用的是
     * COALESCE(?, 列)，新值传 null 时**保留旧值**——这对「别把已有信息抹掉」
     * 是对的，但对目录源意味着：一旦早期版本写进过伪日期/伪卷号，
     * 以后每次采集都刷不掉它。所以在入库之后按源明确清一次。
     *
     * 同时把语种判定结果同步成「按单篇题名」：刊物是中文刊，
     * 但不能据此断定每一篇都是中文（该刊 2026 年第 2 期就有一篇英文文章）。
     */
    for (const a of added) {
      const row = store.get('SELECT id, language_source FROM papers WHERE dedup_key = ?', [a.dedupKey]);
      if (!row) continue;
      if (row.language_source === 'manual') continue;   // 人工确认优先，不动
      const info = N.resolvePaperLanguage({ title: a.title, abstract: null, sourceLanguage: null });
      store.run(
        `UPDATE papers SET published_online = NULL, published_print = NULL, volume = NULL,
           language = ?, language_source = ?, title_language = ?, abstract_language = ?
         WHERE id = ?`,
        [info.language, 'title', info.titleLanguage, info.abstractLanguage, row.id]);
    }

    // 记录来源证据与采集时间（按源 + 文章 ID 去重）
    const fetchedAt = store.nowIso();
    for (const a of added) {
      const paper = store.get('SELECT id FROM papers WHERE dedup_key = ?', [a.dedupKey]);
      store.run(
        `INSERT INTO cn_article_imports(source_key,article_id,paper_id,title,authors,journal_name,
           year,issue,pages,issue_label,source_url,article_url,evidence,fetched_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source_key, article_id) DO NOTHING`,
        [key, a.articleId, paper ? paper.id : null, a.title, JSON.stringify(a.authors),
          source.journalName, parsed.issue?.year || null, parsed.issue?.issue || null,
          a.pages || null, issueLabel, page.url, a.articleUrl || null,
          JSON.stringify({
            parser: source.parser, gch: source.gch || null,
            catalogDate: parsed.catalogDate || null,
            dateBasis: source.dateBasis || null,
            clc: a.clc || null,
            note: '题录来自公开目录页；未提供 DOI 与摘要，故留空',
          }),
          fetchedAt]);
    }
  }

  const status = added.length ? 'ok' : 'no_new';
  const message = added.length
    ? `发现 ${parsed.articles.length} 篇题录，新增 ${inserted} 篇`
    : `发现 ${parsed.articles.length} 篇题录，新增 0 篇（其余为已入库或非研究论文）`;
  recordCheck(key, {
    status, issue: issueLabel, found: parsed.articles.length, added: inserted, message,
  });
  store.run(
    `INSERT INTO ingest_log(at,source,topic,ok,http_status,found,added,message,ms) VALUES(?,?,?,?,?,?,?,?,?)`,
    [store.nowIso(), `cn-catalog:${key}`, source.journalName, 1, page.status,
      parsed.articles.length, inserted, message, Date.now() - t0]);
  store.logEvent('info', 'cn-source', `[${source.name}] ${message}`, {
    sourceKey: key, issue: issueLabel, found: parsed.articles.length, added: inserted,
    skipped: skipped.length,
  });

  return {
    ok: true, sourceKey: key, status, issue: issueLabel,
    found: parsed.articles.length, added: inserted, skipped,
    articles: added.map((a) => ({ articleId: a.articleId, title: a.title, authors: a.authors, pages: a.pages })),
    message, ms: Date.now() - t0,
  };
}

/** 检查全部已启用的来源 */
async function checkAllSources(opts = {}) {
  const results = [];
  for (const src of SOURCES) {
    // 串行，避免给公开站点造成压力
    results.push(await checkSource(src.key, opts));   // eslint-disable-line no-await-in-loop
  }
  return results;
}

/** 参与每日更新的来源（排除明确不可解析的） */
function enabledSources() {
  return SOURCES.filter((s) => !s.disabled);
}

module.exports = {
  SOURCES, listSources, getSource, sourceState, listSourceStates, recordCheck,
  parseNcpssdToc, parseIssue, parseCatalogDate, cleanAuthors, isNonResearch, cnDedupKey,
  checkSource, checkAllSources, enabledSources,
};
