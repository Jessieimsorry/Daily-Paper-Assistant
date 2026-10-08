'use strict';
/**
 * 采集模块：主题 × 检索词 × 数据源 → 规范化 → 合并去重 → 期刊核验 → 入库。
 */
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const N = require('./normalize');
const sources = require('./sources');
const journals = require('./journals');
const { getSettings, CATALOG_DIR, getContactEmail } = require('./config');

/* ---------------------------- 主题管理 ---------------------------- */

function seedTopicsIfEmpty() {
  const count = store.get('SELECT COUNT(*) c FROM topics').c || 0;
  if (count > 0) return { seeded: false };
  const file = path.join(CATALOG_DIR, 'seed-topics.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let order = 10;
  for (const t of data.topics) {
    store.run(
      `INSERT OR IGNORE INTO topics(slug, name_zh, name_en, keywords_zh, keywords_en, enabled, sort_order, builtin)
       VALUES(?,?,?,?,?,1,?,1)`,
      [t.slug, t.name_zh, t.name_en, JSON.stringify(t.keywords_zh), JSON.stringify(t.keywords_en), order]);
    order += 10;
  }
  return { seeded: true, count: data.topics.length };
}

function listTopics(onlyEnabled) {
  const rows = store.all(`SELECT * FROM topics ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY sort_order, id`);
  return rows.map((r) => ({
    id: r.id, slug: r.slug, name_zh: r.name_zh, name_en: r.name_en,
    keywords_zh: store.parseJson(r.keywords_zh, []),
    keywords_en: store.parseJson(r.keywords_en, []),
    exclude_terms:store.parseJson(r.exclude_terms,[]), enabled: Boolean(r.enabled), sort_order: r.sort_order, builtin: Boolean(r.builtin),
  }));
}

function upsertTopic(t) {
  if (t.id) {
    store.run(`UPDATE topics SET name_zh=?, name_en=?, keywords_zh=?, keywords_en=?, enabled=?, sort_order=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`,
      [t.name_zh, t.name_en || null, JSON.stringify(t.keywords_zh || []), JSON.stringify(t.keywords_en || []),
       t.enabled === false ? 0 : 1, t.sort_order ?? 100, t.id]);
    return store.get('SELECT * FROM topics WHERE id=?', [t.id]);
  }
  store.run(`INSERT INTO topics(slug, name_zh, name_en, keywords_zh, keywords_en, enabled, sort_order) VALUES(?,?,?,?,?,?,?)`,
    [t.slug || 'topic-' + Date.now(), t.name_zh, t.name_en || null,
     JSON.stringify(t.keywords_zh || []), JSON.stringify(t.keywords_en || []),
     t.enabled === false ? 0 : 1, t.sort_order ?? 100]);
  return store.get('SELECT * FROM topics ORDER BY id DESC LIMIT 1');
}

function deleteTopic(id) {
  store.run('DELETE FROM topics WHERE id = ?', [id]);
}

/* ---------------------------- 合并去重 ---------------------------- */

function mergePapers(a, b) {
  // 选「有值」的那个：占位符（None / null / N/A / 空串）不算有值。
  // 这样 OpenAlex 给了真页码时，不会被另一路来源的 "None-None" 顶掉。
  const pick = (x, y) => {
    if (x != null && String(x).trim() && !N.isPlaceholderValue(x)) return x;
    if (y != null && String(y).trim() && !N.isPlaceholderValue(y)) return y;
    return null;
  };
  const longer = (x, y) => (String(x || '').length >= String(y || '').length ? x : y);
  const merged = { ...a };
  merged.doi = a.doi || b.doi;
  merged.title = longer(a.title, b.title);
  merged.authors = (a.authors && a.authors.length) ? a.authors : b.authors;
  merged.journalName = longer(a.journalName, b.journalName) || a.journalName || b.journalName;
  merged.issn = a.issn || b.issn;
  merged.issnList = [...new Set([...(a.issnList || []), ...(b.issnList || [])])];
  /*
   * 摘要择优：取更长的那一份（更完整的）。
   * 注意 abstractSource 必须跟着**被选中的那一份**，不能写死 a.
   * 否则会出现「正文来自 OpenAlex、来源却标成 Crossref」这种自相矛盾的溯源。
   */
  const aAbs = String(a.abstract || '');
  const bAbs = String(b.abstract || '');
  if (aAbs.length >= bAbs.length && aAbs) {
    merged.abstract = a.abstract; merged.abstractSource = a.abstractSource || a.source || null;
  } else if (bAbs) {
    merged.abstract = b.abstract; merged.abstractSource = b.abstractSource || b.source || null;
  } else {
    merged.abstract = null; merged.abstractSource = null;
  }
  merged.publishedOnline = a.publishedOnline || b.publishedOnline;
  merged.publishedPrint = a.publishedPrint || b.publishedPrint;
  merged.issuedDate = a.issuedDate || b.issuedDate;
  merged.volume = pick(a.volume, b.volume); merged.issue = pick(a.issue, b.issue);
  merged.pages = pick(a.pages, b.pages);
  merged.url = pick(a.url, b.url);
  merged.pdfUrl = pick(a.pdfUrl, b.pdfUrl);
  merged.publisher = pick(a.publisher, b.publisher);
  merged.openAccess = Boolean(a.openAccess || b.openAccess);
  merged.oaStatus = pick(a.oaStatus, b.oaStatus);
  merged.license = pick(a.license, b.license);
  merged.language = a.language || b.language;
  merged.citationCount = Math.max(a.citationCount || 0, b.citationCount || 0) || null;
  merged.sources = [...new Set([...(a.sources || [a.source]), ...(b.sources || [b.source])])].filter(Boolean);
  // 作者关键词：优先保留真正提供关键词的那个源
  if ((a.keywords || []).length) {
    merged.keywords = a.keywords; merged.keywordsSource = a.keywordsSource;
  } else if ((b.keywords || []).length) {
    merged.keywords = b.keywords; merged.keywordsSource = b.keywordsSource;
  } else {
    merged.keywords = []; merged.keywordsSource = null;
  }
  // 数据库主题词：两个源合并去重
  const dbT = [...(a.dbTopics || []), ...(b.dbTopics || [])];
  const seenT = new Set();
  merged.dbTopics = dbT.filter((t) => t && t.name && !seenT.has(t.name) && seenT.add(t.name));
  merged.dbSubjects = [...new Set([...(a.dbSubjects || []), ...(b.dbSubjects || [])])];
  // 发现它的检索词（可追溯）
  merged.sourceQueries = [...new Set([...(a.sourceQueries || []), ...(b.sourceQueries || [])])].slice(0, 12);
  merged.externalIds = { ...(b.externalIds || {}), ...(a.externalIds || {}) };
  merged.topics = [...new Set([...(a.topics || []), ...(b.topics || [])])];
  merged.concepts = [...new Set([...(a.concepts || []), ...(b.concepts || [])])].slice(0, 8);
  return merged;
}

function processBatch(rawPapers, { topicSlug, seen, query }) {
  let added = 0, merged = 0;
  for (const p of rawPapers) {
    if (!p || !p.title) continue;
    if (query) p.sourceQueries = [...new Set([...(p.sourceQueries || []), query])];
    // 关键：把「发现它的主题」记为它的主题。
    // Crossref 不提供主题词，若只依赖数据源自带的主题，
    // 大量论文的 topics 会是空的，按主题筛选就会失效。
    if (topicSlug) {
      p.topics = [...new Set([...(p.topics || []), topicSlug])];
    }
    const year = (p.issuedDate || p.publishedOnline || '').slice(0, 4);
    const key = N.dedupKey({ doi: p.doi, issn: p.issn, title: p.title, year });
    if (seen.has(key)) {
      const prev = seen.get(key);
      const m = mergePapers(prev, p);
      m.topics = [...new Set([...(m.topics || []), ...(p.topics || [])])];
      seen.set(key, m);
      merged++;
      continue;
    }
    seen.set(key, p);
  }
  return { added, merged };
}

/* ---------------------------- 采集主流程 ---------------------------- */

function dateWindow(days) {
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(from), until: fmt(now) };
}

/* 采集进度（前端可轮询） */
let _progress = {
  running: false, phase: 'idle', startedAt: null, finishedAt: null,
  totalQueries: 0, doneQueries: 0, rawCount: 0, unique: 0,
  bySource: {}, recent: [], result: null, error: null,
};
function progress() { return { ..._progress, recent: _progress.recent.slice(-40) }; }

/** 限流并发执行 */
async function pmap(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await worker(items[idx], idx); }
      catch (e) { out[idx] = { error: e.message }; }
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * 采集：主题 × 检索词 × 数据源。
 * 并发执行（默认 4 路），并对被限流的数据源自动熔断，保证一轮采集总能结束。
 * @param {{days?:number, perQuery?:number, topics?:string[], onProgress?:Function, maxQueries?:number, concurrency?:number}} opts
 */
async function collect(opts = {}) {
  if(require('./customize').get('streams',{}).research===false && !opts.manual)return {ok:true,queries:0,inserted:0,updatedExisting:0,log:[]};
  if(!opts.topics)opts.topics=require('./customize').autoTopics();
  if(!opts.sources)opts.sources=require('./customize').get('streams',{}).sources;
  const s = getSettings();
  const days = opts.days || s.briefLookbackDays || 30;
  const perQuery = Math.min(opts.perQuery || Math.max(20, s.briefSize || 50), s.maxPerTopicQuery || 60);
  const { from, until } = dateWindow(days);
  const log = [];
  const seen = new Map();
  let rawCount = 0;
  let queries = 0;
  const maxQueries = opts.maxQueries || 400;
  const concurrency = Math.max(1, Math.min(opts.concurrency || 4, 8));
  const http = require('./http');

  if(opts.signal?.aborted)return {ok:false,error:'任务已取消'};
  const topics = listTopics(false).filter((t) => opts.topics.includes(t.slug));
  if (!topics.length) return { ok: false, error: '没有启用的主题' };

  // 展开任务列表：中文检索式只走 Crossref；英文检索式同时走 Crossref 与 OpenAlex
  const tasks = [];
  for (const topic of topics) {
    for (const q of topic.keywords_zh) {
      tasks.push({ source: 'crossref', topic: topic.slug, query: q, kind: '中文检索式' });
    }
    for (const q of topic.keywords_en) {
      tasks.push({ source: 'crossref', topic: topic.slug, query: q, kind: '英文检索式' });
      tasks.push({ source: 'openalex', topic: topic.slug, query: q, kind: '英文检索式' });
    }
  }
  const capped = tasks.filter(t=>!opts.sources||opts.sources.includes(t.source)).slice(0, maxQueries);

  _progress = {
    running: true, phase: 'collecting', startedAt: new Date().toISOString(), finishedAt: null,
    totalQueries: capped.length, doneQueries: 0, rawCount: 0, unique: 0,
    bySource: {}, recent: [], result: null, error: null,
  };

  const pushLog = (entry) => {
    log.push(entry);
    _progress.recent.push(entry);
    if (_progress.recent.length > 200) _progress.recent.shift();
    _progress.doneQueries++;
    _progress.rawCount = rawCount;
    _progress.unique = seen.size;
    const bs = _progress.bySource[entry.source] || { ok: 0, fail: 0, found: 0 };
    bs[entry.ok ? 'ok' : 'fail']++;
    bs.found += entry.found || 0;
    _progress.bySource[entry.source] = bs;
    store.run('INSERT INTO ingest_log(source, topic, ok, http_status, found, added, message, ms) VALUES(?,?,?,?,?,?,?,?)',
      [entry.source, entry.topic || '', entry.ok ? 1 : 0, entry.status || null, entry.found || 0, entry.added || 0,
       (entry.message || '').slice(0, 500), entry.ms || null]);
    if (opts.onProgress) { try { opts.onProgress(entry); } catch {} }
  };

  await pmap(capped, concurrency, async (task) => {
    const before = seen.size;
    let r;
    if (task.source === 'crossref') {
      if(opts.signal?.aborted)return {ok:false,error:'任务已取消'};
      r = await sources.crossrefSearch({ query: task.query, rows: perQuery, fromDate: from, untilDate: until });
    } else {
      if(opts.signal?.aborted)return {ok:false,error:'任务已取消'};
      r = await sources.openalexSearch({ query: task.query, rows: perQuery, fromDate: from, untilDate: until });
    }
    processBatch(r.papers || [], { topicSlug: task.topic, seen, query: task.query });
    rawCount += (r.papers || []).length;
    const label = task.source === 'crossref' ? 'Crossref' : 'OpenAlex';
    pushLog({
      source: task.source, topic: task.topic, ok: r.ok, status: r.status,
      found: (r.papers || []).length, added: seen.size - before, ms: r.ms,
      throttled: Boolean(r.throttled),
      message: `[${task.kind}] ${task.query}｜${label} 命中 ${r.total ?? 0}，取回 ${(r.papers || []).length}` +
        (r.ok ? '' : '｜失败: ' + r.error),
    });
  });

  /*
   * 公开中文期刊目录源（逐篇题录）。
   *
   * 为什么放在这里：中文 CSSCI 期刊极少在 Crossref 注册 DOI，
   * 只跑 Crossref/OpenAlex 的话，每天**不会**自动发现新的中文论文。
   * 目录源与检索式采集并列执行，结果并入同一份日志与统计。
   * 惰性 require 避免与 cnsource 形成加载期循环依赖
   * （cnsource 需要在本模块里调用 persistPapers 入库）。
   */
  let cnSources = null;
  if (opts.cnSources !== false && (!opts.sources||opts.sources.includes('cn-catalog'))) {
    try {
      const cnsource = require('./cnsource');
      const cnResults = await cnsource.checkAllSources({ dryRun: Boolean(opts.cnDryRun) });
      cnSources = cnResults.map((r) => ({
        sourceKey: r.sourceKey, status: r.status, issue: r.issue || null,
        found: r.found, added: r.added, message: r.message,
        skipped: (r.skipped || []).length,
      }));
      for (const r of cnResults) {
        pushLog({
          source: 'cn-catalog', topic: r.sourceKey, ok: r.ok,
          status: null, found: r.found, added: r.added, ms: r.ms,
          message: `[中文目录源 ${r.sourceKey}] ${r.message}`,
        });
      }
    } catch (e) {
      cnSources = [{ sourceKey: '-', status: 'error', message: e.message, found: 0, added: 0 }];
      pushLog({
        source: 'cn-catalog', topic: '-', ok: false, status: null,
        found: 0, added: 0, ms: 0,
        message: `[中文目录源] 执行异常：${e.message}`,
      });
    }
  }

  const persist = persistPapers([...seen.values()].filter(p=>{const matching=topics.filter(t=>(p.topics||[]).includes(t.slug));const text=(p.title+' '+(p.abstract||'')).toLowerCase();return !matching.length||matching.some(t=>!(t.exclude_terms||[]).some(w=>text.includes(w.toLowerCase())));}));
  const circuits = http.circuitReport();
  const result = {
    ok: true, window: { from, until, days }, queries: capped.length, rawCount,
    uniqueCandidates: seen.size, ...persist, log,
    cnSources,
    throttled: circuits.length > 0, circuits,
  };
  _progress.running = false;
  _progress.phase = 'done';
  _progress.finishedAt = new Date().toISOString();
  _progress.result = { ...result, log: undefined, recent: undefined };
  return result;
}

/** 写入 papers 表并做期刊核验 */
function persistPapers(list) {
  const s = getSettings();
  let inserted = 0, updatedExisting = 0, eligible = 0, pending = 0, excluded = 0;
  /*
   * 发现日期必须用**北京时间自然日**，不能用 UTC 日期。
   *
   * 踩过的问题：这里原先写 new Date().toISOString().slice(0,10)（UTC 日期），
   * 而「今日发现」的三态分类用的是 brief.beijingDate()（北京日期）。
   * 在北京时间 00:00–08:00 这段窗口里两者相差一天：
   * 定时任务刚采到的论文会被写上前一天的 discovery_date，
   * 于是在发现页里直接落进「已进过简报/近期发现」而不是「今天首次发现」——
   * 正是 08:00 定时更新这个场景。统一成北京日期，两处口径才一致。
   */
  const today = require('./brief').beijingDate();

  store.tx(() => {
    for (const p of list) {
      /*
       * 语种判定。
       * 旧写法是 N.detectLanguage(title) || p.language —— 而旧 detectLanguage 对任何
       * 非中文拉丁标题都返回 'en'，于是「来源语言」永远轮不到，印尼语标题被判成英文。
       * 现在交给 resolvePaperLanguage：来源可信代码优先、题名与摘要分开、
       * 证据不足返回 unknown，并且**人工确认过的语种不会被覆盖**。
       */
      const existingRow = store.get('SELECT * FROM papers WHERE dedup_key = ?', [
        N.dedupKey({ doi: p.doi, issn: p.issn, title: p.title,
          year: (p.issuedDate || p.publishedOnline || '').slice(0, 4) }),
      ]) || (p.doi ? store.get('SELECT * FROM papers WHERE doi_norm = ?', [p.doi]) : null);

      const langInfo = N.resolvePaperLanguage({
        title: p.title,
        abstract: p.abstract,
        sourceLanguage: p.language,
        // 人工纠正过就沿用它，采集不得覆盖
        manualLanguage: existingRow && existingRow.language_source === 'manual'
          ? existingRow.language : null,
      });
      const lang = langInfo.language;
      const jrow = journals.findJournal({ issn: p.issn, name: p.journalName });
      const elig = journals.eligibilityOf(jrow, s);

      let finalElig = elig.status;
      if (s.strictJournalFilter === false && finalElig === 'pending') finalElig = 'eligible';

      const year = (p.issuedDate || p.publishedOnline || '').slice(0, 4);
      const key = N.dedupKey({ doi: p.doi, issn: p.issn, title: p.title, year });

      // 复用上面为语种判定已经查过的那一行，避免同一事务里查两次
      const existing = existingRow;

      const kw = Array.isArray(p.keywords) ? p.keywords.filter(Boolean).slice(0, 25) : [];
      // 入库前统一清洗卷/期/页：不假设上游一定干净
      const cleanVol = N.cleanPlaceholder(p.volume);
      const cleanIssue = N.cleanPlaceholder(p.issue);
      const cleanPages = N.cleanPlaceholder(p.pages);
      const fields = [
        p.doi || null, p.title, p.title_zh || null, JSON.stringify(p.authors || []),
        p.journalName || null, jrow ? jrow.id : null, N.normalizeIssn(p.issn) || null, lang,
        p.abstract || null, p.abstractSource || null,
        p.publishedOnline || null, p.publishedPrint || null, p.issuedDate || null,
        cleanVol, cleanIssue, cleanPages, p.url || null, p.pdfUrl || null,
        p.openAccess ? 1 : 0, p.oaStatus || null, p.license || null,
        (p.sources || [p.source]).filter(Boolean).join(','),
        JSON.stringify(Object.fromEntries(Object.entries(p.externalIds || {}).filter(([, v]) => v))),
        p.citationCount ?? null,
        JSON.stringify(p.topics || []),
        JSON.stringify(p.topicScores || {}),
        finalElig, elig.note,
      ];
      const extras = [
        JSON.stringify(kw), p.keywordsSource || (kw.length ? 'unknown' : null),
        JSON.stringify(p.dbTopics || []), JSON.stringify(p.sourceQueries || []),
        (elig.officialEligible ? 1 : 0), elig.basis || 'pending',
        JSON.stringify(p.dbSubjects || []),
      ];

      if (existing) {
        const sourcesMerged = [...new Set([...(existing.sources || '').split(','), ...(p.sources || [p.source])])].filter(Boolean).join(',');
        const topicsMerged = [...new Set([...store.parseJson(existing.topics, []), ...(p.topics || [])])];
        store.run(
          `UPDATE papers SET doi_norm = COALESCE(?, doi_norm), title = ?, authors = ?, journal_name = COALESCE(?, journal_name),
             journal_id = COALESCE(?, journal_id), issn = COALESCE(?, issn), language = COALESCE(?, language),
             abstract = COALESCE(?, abstract), abstract_source = COALESCE(?, abstract_source),
             published_online = COALESCE(?, published_online), published_print = COALESCE(?, published_print),
             issued_date = COALESCE(?, issued_date), volume = COALESCE(?, volume), issue = COALESCE(?, issue), pages = COALESCE(?, pages),
             url = COALESCE(?, url), pdf_url = COALESCE(?, pdf_url), open_access = ?, oa_status = COALESCE(?, oa_status),
             license = COALESCE(?, license), sources = ?, external_ids = ?, citation_count = COALESCE(?, citation_count),
             topics = ?, topic_scores = ?, eligibility = ?, eligibility_note = ?,
             keywords = COALESCE(NULLIF(?, '[]'), keywords),
             keywords_source = COALESCE(?, keywords_source),
             openalex_topics = COALESCE(NULLIF(?, '[]'), openalex_topics),
             source_queries = ?, eligible_official = ?, eligibility_basis = ?,
             db_subjects = COALESCE(NULLIF(?, '[]'), db_subjects),
             updated_at = ?
           WHERE id = ?`,
          [fields[0], fields[1], fields[3], fields[4], fields[5], fields[6], fields[7], fields[8], fields[9],
           fields[10], fields[11], fields[12], fields[13], fields[14], fields[15], fields[16], fields[17],
           fields[18], fields[19], fields[20], sourcesMerged, fields[22], fields[23], JSON.stringify(topicsMerged),
           fields[25], fields[26], fields[27],
           extras[0], extras[1], extras[2], extras[3], extras[4], extras[5], extras[6],
           store.nowIso(), existing.id]);
        updatedExisting++;
      } else {
        store.run(
          `INSERT INTO papers(doi_norm, title, title_zh, authors, journal_name, journal_id, issn, language,
             abstract, abstract_source, published_online, published_print, issued_date, volume, issue, pages,
             url, pdf_url, open_access, oa_status, license, sources, external_ids, citation_count,
             topics, topic_scores, eligibility, eligibility_note,
             keywords, keywords_source, openalex_topics, source_queries, eligible_official, eligibility_basis,
             db_subjects, discovery_date, dedup_key)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [...fields, ...extras, today, key]);
        inserted++;
      }

      /*
       * 语种来源与依据单独落库。
       * 为什么不用上面那两个大数组：它们是按位置传参的，插一个字段就要重排
       * 所有下标，容易出错；这里按 dedup_key 定向更新，语义清楚也不会误伤。
       * manual（用户人工确认）时保留用户的值与来源标记，采集不覆盖。
       */
      const keepManual = existingRow && existingRow.language_source === 'manual';
      store.run(
        `UPDATE papers SET language = ?, language_source = ?, title_language = ?,
           abstract_language = ?, language_detail = ? WHERE dedup_key = ?`,
        [
          keepManual ? existingRow.language : langInfo.language,
          keepManual ? 'manual' : langInfo.source,
          langInfo.titleLanguage, langInfo.abstractLanguage,
          JSON.stringify({
            // 保留已有的 auto / manual（人工纠正前保存的自动判定原值），
            // 否则每次采集都会把它冲掉，「恢复自动判定」就失效了。
            ...(store.parseJson(existingRow && existingRow.language_detail, {}) || {}),
            confidence: langInfo.confidence, evidence: langInfo.evidence,
            conflict: langInfo.conflict,
            sourceLanguageRaw: p.language || null,
            detectedAt: store.nowIso(),
          }),
          key,
        ]);

      if (finalElig === 'eligible') eligible++;
      else if (finalElig === 'excluded') excluded++;
      else pending++;
    }
  });

  return { inserted, updatedExisting, eligible, pending, excluded };
}

/** 富化：对指定论文补齐 OpenAlex/Unpaywall 信息与开放全文位置 */
async function enrichPaper(paperId) {
  const p = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (!p) return { ok: false, error: '论文不存在' };
  const notes = [];
  let oaUrl = p.pdf_url;

  if (p.doi_norm) {
    const up = await sources.unpaywallByDoi(p.doi_norm);
    if (up.ok && up.oa) {
      notes.push(`Unpaywall: ${up.oa.isOa ? '存在开放版本(' + (up.oa.status || '') + ')' : '无开放版本'}`);
      if (up.oa.best?.url) {
        oaUrl = up.oa.best.url;
        store.run(`UPDATE papers SET open_access = 1, oa_status = ?, pdf_url = ?, license = COALESCE(?, license), fulltext_source = COALESCE(fulltext_source, ?) WHERE id = ?`,
          [up.oa.status, oaUrl, up.oa.best.license, 'unpaywall', paperId]);
      }
    } else if (!up.ok) notes.push('Unpaywall 查询失败：' + up.error);

    const tdm = await sources.crossrefFulltextLink(p.doi_norm);
    if (tdm) notes.push('Crossref TDM 链接可用（出版商开放）');
  }

  if (!p.abstract && p.doi_norm) {
    const oa = await sources.openalexByDoi(p.doi_norm);
    if (oa.ok && oa.paper?.abstract) {
      store.run('UPDATE papers SET abstract = ?, abstract_source = ?, updated_at = ? WHERE id = ?',
        [oa.paper.abstract, 'openalex', store.nowIso(), paperId]);
      notes.push('已从 OpenAlex 补齐摘要');
    }
  }
  return { ok: true, notes, oaUrl };
}

/* ---------------------------- 关键词回填 ---------------------------- */

/**
 * 为已入库的论文回填作者关键词与数据库主题词。
 *
 * 背景：Crossref 不提供作者关键词，因此早期只经过 Crossref 采集的论文
 * keywords 为空。这里按 DOI 到 OpenAlex 合法索取关键词与主题词，
 * 不抓取任何网页、不绕过任何限制。没有关键词的论文保持为空——
 * 界面会显示「原始数据未提供关键词」，绝不用主题标签冒充。
 *
 * @param {{limit?:number, onlyMissing?:boolean, language?:string}} opts
 */
async function backfillKeywords(opts = {}) {
  const limit = Math.min(opts.limit || 200, 3000);
  const onlyMissing = opts.onlyMissing !== false;
  const http = require('./http');

  const base = ["doi_norm IS NOT NULL AND doi_norm <> ''"];
  if (onlyMissing) base.push("(keywords IS NULL OR keywords = '[]')");
  if (opts.language) base.push(`language = '${String(opts.language).replace(/'/g, '')}'`);

  // 连续失败达到阈值就停止，避免在数据源限流时把剩下几百篇全部试一遍
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 15;

  let checked = 0, apiOk = 0, apiFailed = 0, gotKeywords = 0, gotTopics = 0, withoutKeywords = 0;
  let consecutiveFailures = 0;
  let stoppedReason = null;
  const notes = [];
  let offset = 0;

  while (checked < limit) {
    const batchSize = Math.min(40, limit - checked);
    const rows = store.all(
      `SELECT id, doi_norm FROM papers WHERE ${base.join(' AND ')} ORDER BY id LIMIT ? OFFSET ?`,
      [batchSize, offset]);
    if (!rows.length) break;

    const results = await pmap(rows, 3, async (row) => {
      const r = await sources.openalexByDoi(row.doi_norm);
      return { row, r };
    });

    for (const { row, r } of results) {
      checked++;
      if (!r.ok || !r.paper) {
        // 关键修正：接口失败与「论文本身没有关键词」是两件事，必须分开计数。
        // 早期版本把两者都算成 failed，导致失败率虚高、误判为限流而提前停止。
        apiFailed++;
        consecutiveFailures++;
        if (notes.length < 8 && r.error) notes.push(`${row.doi_norm}: ${String(r.error).slice(0, 110)}`);
        continue;
      }
      consecutiveFailures = 0;
      apiOk++;

      const kw = Array.isArray(r.paper.keywords) ? r.paper.keywords : [];
      const dbT = Array.isArray(r.paper.dbTopics) ? r.paper.dbTopics : [];
      const dbS = Array.isArray(r.paper.dbSubjects) ? r.paper.dbSubjects : [];
      if (kw.length) gotKeywords++; else withoutKeywords++;
      if (dbT.length) gotTopics++;

      store.run(
        `UPDATE papers SET
           keywords = CASE WHEN ? <> '[]' THEN ? ELSE keywords END,
           keywords_source = CASE WHEN ? <> '[]' THEN ? ELSE keywords_source END,
           openalex_topics = CASE WHEN ? <> '[]' THEN ? ELSE openalex_topics END,
           db_subjects = CASE WHEN ? <> '[]' THEN ? ELSE db_subjects END,
           abstract = COALESCE(abstract, ?),
           abstract_source = CASE WHEN abstract IS NULL THEN ? ELSE abstract_source END,
           updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(kw), JSON.stringify(kw),
         JSON.stringify(kw), kw.length ? 'openalex' : null,
         JSON.stringify(dbT), JSON.stringify(dbT),
         JSON.stringify(dbS), JSON.stringify(dbS),
         r.paper.abstract || null, r.paper.abstract ? 'openalex' : null,
         store.nowIso(), row.id]);
    }

    if (consecutiveFailures >= maxConsecutiveFailures) {
      stoppedReason = `连续 ${consecutiveFailures} 次接口失败，已停止，避免在数据源限流时做无谓请求`;
      break;
    }
    if (http.circuitReport().some((c) => c.host === 'api.openalex.org')) {
      stoppedReason = 'OpenAlex 已被限流（HTTP 429）并进入熔断，本轮停止。配置 OpenAlex API Key 后可继续。';
      break;
    }
    offset += rows.length;
  }

  const remaining = store.get(
    `SELECT COUNT(*) c FROM papers WHERE ${base.join(' AND ')}`).c;
  const hasKey = Boolean(require('./config').getSecret('openAlexApiKey'));

  return {
    ok: true, checked, apiOk, apiFailed, gotKeywords, gotTopics, withoutKeywords,
    withKeywords: store.get("SELECT COUNT(*) c FROM papers WHERE keywords IS NOT NULL AND keywords <> '[]'").c,
    withTopics: store.get("SELECT COUNT(*) c FROM papers WHERE openAlex_topics IS NOT NULL AND openAlex_topics <> '[]'").c,
    remaining, stoppedReason, notes, openAlexKeyConfigured: hasKey,
    note: 'Crossref 不提供作者关键词；这里通过 DOI 向 OpenAlex 合法索取。'
      + 'OpenAlex 匿名调用限流严格，遇到 429 会自动熔断停止；'
      + '到「设置 → OpenAlex API Key」填入免费 Key（https://openalex.org/rest-api）后可重跑本接口继续。'
      + '仍未取得关键词的论文会在界面上显示「原始数据未提供关键词」，不会被主题标签顶替。',
    hint: stoppedReason && !hasKey
      ? '本次因限流中断。填写 OpenAlex API Key 后重新调用 /api/ingest/backfill-keywords 即可从断点继续（只会处理仍缺关键词的论文）。'
      : null,
  };
}

/* ---------------------------- 手动添加 ---------------------------- */

async function addByDoi(doi, topicSlugs) {
  const cr = await sources.crossrefByDoi(doi);
  let paper = cr.ok ? cr.paper : null;
  const oa = await sources.openalexByDoi(doi);
  if (paper && oa.ok && oa.paper) {
    paper = mergePapers(paper, oa.paper);
  } else if (!paper && oa.ok && oa.paper) {
    paper = oa.paper;
  }
  if (!paper) {
    return { ok: false, error: `未能在 Crossref 或 OpenAlex 找到 DOI ${doi}。${cr.error || ''}` };
  }
  paper.topics = topicSlugs && topicSlugs.length ? topicSlugs : paper.topics;
  const res = persistPapers([paper]);
  const row = store.get('SELECT * FROM papers WHERE dedup_key = ?',
    [N.dedupKey({ doi: paper.doi, issn: paper.issn, title: paper.title, year: (paper.issuedDate || '').slice(0, 4) })]);
  return { ok: true, result: res, paperId: row?.id, paper };
}

/** 从 CNKI/万方等导出的题录（用户自行导出，合法持有）批量导入 */
function importRecords(records, topicSlugs) {
  const list = records.map((r) => ({
    keywords: Array.isArray(r.keywords) ? r.keywords
      : String(r.keywords || r['关键词'] || r['主题词'] || '').split(/[;；,，]/).map((x) => x.trim()).filter(Boolean),
    keywordsSource: r.keywordsSource || ((r.keywords || r['关键词']) ? 'imported' : null),
    title: r.title || r['题名'] || r['篇名'] || '',
    authors: Array.isArray(r.authors) ? r.authors
      : String(r.authors || r['作者'] || '').split(/[;；,，]/).map((x) => x.trim()).filter(Boolean),
    journalName: r.journalName || r['刊名'] || r['来源'] || r['期刊'] || '',
    issn: r.issn || r['ISSN'] || '',
    doi: r.doi || r['DOI'] || '',
    abstract: r.abstract || r['摘要'] || '',
    issuedDate: r.issuedDate || r['发表时间'] || r['年'] || '',
    publishedOnline: r.publishedOnline || '',
    volume: r.volume || r['卷'] || '', issue: r.issue || r['期'] || '', pages: r.pages || r['页码'] || '',
    url: r.url || r['链接'] || r['URL'] || '',
    language: r.language || 'zh',
    topics: topicSlugs && topicSlugs.length ? topicSlugs : (r.topics || []),
    sources: ['imported'],
    externalIds: { imported: true },
  })).filter((r) => r.title);

  if (!list.length) return { ok: false, error: '没有可识别的题录（至少需要“题名”）' };
  const res = persistPapers(list);
  return { ok: true, result: res, count: list.length };
}

module.exports = {
  seedTopicsIfEmpty, listTopics, upsertTopic, deleteTopic,
  collect, persistPapers, enrichPaper, addByDoi, importRecords, mergePapers, dateWindow,
  progress, pmap, backfillKeywords,
};
