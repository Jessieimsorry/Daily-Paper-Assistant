'use strict';
/**
 * 文献阅读工作台 —— 零依赖本地服务。
 * 只监听 127.0.0.1，数据全部保存在本机 data/ 目录。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const config = require('./lib/config');
const time = require('./lib/time');
const store = require('./lib/store');
const discover = require('./lib/discover');
const journals = require('./lib/journals');
const brief = require('./lib/brief');
const scheduler = require('./lib/scheduler');
const interpret = require('./lib/interpret');
const library = require('./lib/library');
const langfix = require('./lib/langfix');
const cnsource = require('./lib/cnsource');
const fulltext = require('./lib/fulltext');
const sources = require('./lib/sources');
const rank = require('./lib/rank');
const N = require('./lib/normalize');

const PORT = Number(process.env.LITDESK_PORT || 8787);
const HOST = '127.0.0.1';

/* ----------------------------- 初始化 ----------------------------- */

function initialize() {
  // 安全迁移：只加列/加表，不动现有数据
  const migrations = store.migrate();
  // 修复历史数据：早期版本可能把参考名录当成官方目录使用，
  // 这里按目录数据重算 verified / ssci_confirmed，再重新核验论文。
  const flags = journals.reconcileJournalFlags();
  // 修复历史数据：papers.eligibility_note 是发现时写入的冗余副本，
  // 资格判定措辞变更后老论文会留着旧说法（例如把「参考候选」读成连简报都进不去）。
  // 这里按当前逻辑重算，只在文本确实不同时写回，可反复执行。
  const noteRepair = journals.refreshStoredEligibilityNotes(config.getSettings());
  const t = discover.seedTopicsIfEmpty();
  require('./lib/categories').seed();
  require('./lib/customize').initialize();
  require('./lib/tasks').recover();
  const reader = require('./lib/reader');
  if (!reader.getState('recommendations-v1', false)) {
    if (config.getSettings().briefSize <= 10) config.updateSettings({ briefSize: 50 });
    reader.setState('recommendations-v1', true);
  }
  let seed = null;
  const jcount = store.get('SELECT COUNT(*) c FROM journals').c;
  if (jcount === 0) seed = journals.loadSeedReference();
  return {
    topics: t, seedReference: seed, journals: jcount, migrations,
    flagReconcile: flags, noteRepair,
  };
}

/* ----------------------------- 工具 ----------------------------- */

/**
 * 需要按「瞬间」处理的字段名（大小写不敏感）。
 * 这些字段一定带时刻，必须以 ISO UTC（结尾 Z）发给前端，
 * 否则前端 new Date() 会把不带时区的串当本地时间，出现 8 小时偏差。
 *
 * 注意：papers 的 online / print / issued / discovery 日期是**出版日**，
 * 本身没有时刻，不在这个名单里，不能被加上时间。
 */
const INSTANT_FIELDS = [
  'createdAt', 'created_at', 'updatedAt', 'updated_at',
  'finishedAt', 'finished_at', 'startedAt', 'started_at',
  'judged_at', 'at', 'checkedAt', 'lastAt', 'lastUpdate',
  'translatedAt', 'fetchedAt', 'importedAt', 'publishedAt',
];
const INSTANT_SET = new Set(INSTANT_FIELDS.map((k) => k.toLowerCase()));
const INSTANT_MAX_DEPTH = 12;

/** 递归把「瞬间」字段归一化为 ISO UTC；只改表示形式，不改时刻 */
function normalizeInstants(value, depth = 0) {
  if (depth > INSTANT_MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => normalizeInstants(v, depth + 1));
  if (value instanceof Date) return time.toIsoUtc(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v && typeof v === 'object') {
      out[k] = normalizeInstants(v, depth + 1);
    } else if (typeof v === 'string' && INSTANT_SET.has(k.toLowerCase()) && time.isNaive(v)) {
      out[k] = time.toIsoUtc(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(normalizeInstants(obj), null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * 请求体已经在 http.createServer 的 end 回调里一次性读完（rawBody），
 * 因此这里直接使用缓冲内容；只有在缓冲缺失时才回退到流式读取。
 * 直接对 req 事件取值会挂住 —— 流此时已经 end，永远不会再触发 data。
 */
function readBody(req, limitBytes = 60 * 1024 * 1024, buffered) {
  if (buffered != null) {
    if (buffered.length > limitBytes) return Promise.reject(new Error('请求体过大'));
    return Promise.resolve(buffered);
  }
  if (req.readableEnded || req.complete) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, buffered) {
  const buf = await readBody(req, 60 * 1024 * 1024, buffered);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error('请求体不是合法 JSON'); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const filePath = path.join(config.PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(config.PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 未找到'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ----------------------------- 路由 ----------------------------- */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

/* --- 系统 / 设置 --- */
route('GET', '/api/stats', async () => {
  const st = library.libraryStats();
  const bySource = store.all(`SELECT sources, COUNT(*) c FROM papers GROUP BY sources ORDER BY c DESC`);
  const byLang = store.all(`SELECT language, COUNT(*) c FROM papers GROUP BY language`);
  const byElig = store.all(`SELECT eligibility, COUNT(*) c FROM papers GROUP BY eligibility`);
  const tr = store.all(`SELECT status, COUNT(*) c FROM translations GROUP BY status`);
  return {
    ok: true, stats: st,
    papersBySource: bySource, papersByLanguage: byLang, papersByEligibility: byElig,
    translations: tr,
    note: '「期刊条件合格」只统计官方目录已核验的论文；参考候选单列，不计入合格。',
  };
});

route('GET', '/api/health', async () => {
  /*
   * frontier：最近一次前沿技术精选的运行状态与**本次真实来源状态**。
   * 加上它是为了让「今天到底哪个源成功、哪个失败、为什么」可以直接从
   * /api/health.frontier 查到，而不用再去翻 frontier_runs 表。
   * 只读最近一次运行，不触发任何采集。
   */
  let frontierHealth = null;
  try {
    const f = frontier.get();
    frontierHealth = {
      run: f.run ? {
        id: f.run.id, runDate: f.run.runDate, reason: f.run.reason, status: f.run.status,
        pickedCount: f.run.pickedCount, candidates: f.run.candidates,
        startedAt: f.run.startedAt, finishedAt: f.run.finishedAt,
      } : null,
      picked: (f.items || []).length,
      newTodayCount: f.newTodayCount != null ? f.newTodayCount : null,
      carriedOverCount: f.carriedOverCount != null ? f.carriedOverCount : null,
      itemsInLibrary: store.get('SELECT COUNT(*) c FROM frontier_items').c,
      // 每个源的真实状态：ok / 失败原因 / 是否需要密钥 / 未同步
      sources: (f.sources || []).map((s) => ({
        source: s.source, label: s.label, ok: !!s.ok,
        status: s.status == null ? null : s.status,
        found: s.found == null ? null : s.found,
        okQueries: s.okQueries == null ? null : s.okQueries,
        queries: s.queries == null ? null : s.queries,
        causes: s.causes || null,
        primaryCause: s.primaryCause || null,
        primaryCauseLabel: s.primaryCauseLabel || null,
        causeDerived: s.causeDerived === true,
        retriedQueries: s.retriedQueries == null ? null : s.retriedQueries,
        needsKey: !!s.needsKey, configured: s.configured,
        batch: !!s.batch, items: s.items == null ? null : s.items,
        lastSyncAt: s.lastSyncAt || null,
        error: s.error || null,
      })),
      ieee: frontier.ieeeStatus(),
    };
  } catch (e) {
    frontierHealth = { error: '前沿状态读取失败：' + e.message };
  }
  return {
    ok: true, app: '文献阅读工作台', version: require('./package.json').version,
    time: new Date().toISOString(),
    node: process.version,
    dbFile: store.DB_FILE,
    stats: library.libraryStats(),
    scheduler: scheduler.status(),
    dataSources: sourcesHealthCache(),
    frontier: frontierHealth,
  };
});

route('GET', '/api/settings', async () => ({ ok: true, config: config.publicConfig(), scheduler: scheduler.status() }));

route('POST', '/api/settings', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  // 密钥字段单独处理，返回时只给掩码
  const secretUpdates = {};
  if (Object.prototype.hasOwnProperty.call(body, 'deepseekApiKey')) secretUpdates.deepseekApiKey = body.deepseekApiKey;
  if (Object.prototype.hasOwnProperty.call(body, 'openAlexApiKey')) secretUpdates.openAlexApiKey = body.openAlexApiKey;
  delete body.deepseekApiKey; delete body.openAlexApiKey;

  const cfg = config.updateSettings(body);
  for (const [k, v] of Object.entries(secretUpdates)) config.setSecret(k, v);
  const after = config.publicConfig();
  if (body.briefHour !== undefined || body.briefMinute !== undefined) scheduler.schedule();
  store.logEvent('info', 'settings', '设置已更新', { keys: Object.keys(body).concat(Object.keys(secretUpdates)) });
  return { ok: true, config: after, scheduler: scheduler.status(), note: '密钥只保存在本机 data/secrets.json（权限 600），不会写入代码或日志。' };
});

route('POST', '/api/settings/test-ai', async () => {
  // 不给很小的 maxTokens：推理模型会先把预算花在思维链上，
  // 那样测试会假失败。这里用设置里的预算并允许自动重试。
  const r = await interpret.callModelWithRetry([
    { role: 'system', content: '你是测试助手，只回复四个字。' },
    { role: 'user', content: '请只回复这四个字：连接正常' },
  ], { temperature: 0 });
  return r.ok
    ? { ok: true, model: r.model, reply: r.content.trim(), ms: r.ms, tokens: r.tokens,
        note: r.retriedWithBudget ? `推理模型首次预算不足，已自动用 ${r.retriedWithBudget} tokens 重试成功` : null }
    : { ok: false, error: r.error, model: r.model, truncatedByReasoning: r.truncatedByReasoning };
});

let _srcHealth = null;
let _srcHealthAt = 0;
function sourcesHealthCache() { return { checkedAt: _srcHealthAt ? new Date(_srcHealthAt).toISOString() : null, sources: _srcHealth || [], stale: !_srcHealth || (Date.now() - _srcHealthAt > 3600000) }; }

route('GET', '/api/sources/health', async (req, url) => {
  const refresh = url.searchParams.get('refresh') === '1';
  if (refresh || !_srcHealth || Date.now() - _srcHealthAt > 30 * 60000) {
    const h = await sources.healthCheck();
    _srcHealth = h.sources; _srcHealthAt = Date.now();
  }
  const catalog = journals.catalogStatus();
  return { ok: true, ...sourcesHealthCache(), catalog, note: '以上为各数据源的真实连通状态；失败项会在采集日志中逐条显示。' };
});

/* --- 主题 --- */
route('GET', '/api/topics', async () => ({ ok: true, topics: discover.listTopics(false) }));
route('POST', '/api/topics', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (!body.name_zh) return { ok: false, error: '主题名称不能为空' };
  const row = discover.upsertTopic(body);
  if(Array.isArray(body.exclude_terms))store.run('UPDATE topics SET exclude_terms=? WHERE id=?',[JSON.stringify(body.exclude_terms),row.id]);
  return { ok: true, topic: row };
});
route('PUT', '/api/topics/:id', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  body.id = Number(m.id);
  const row = discover.upsertTopic(body);
  if(Array.isArray(body.exclude_terms))store.run('UPDATE topics SET exclude_terms=? WHERE id=?',[JSON.stringify(body.exclude_terms),row.id]);
  return { ok: true, topic: row };
});
route('DELETE', '/api/topics/:id', async (req, url, m) => {
  discover.deleteTopic(Number(m.id));
  return { ok: true };
});

/* --- 期刊目录 --- */
route('GET', '/api/journals/catalogs', async () => ({ ok: true, ...journals.catalogStatus() }));
route('GET', '/api/journals/template/:key', async (req, url, m) => {
  const csv = journals.templateCsv(m.key);
  if (!csv) return { ok: false, error: '未知目录类型' };
  return { ok: true, csv, filename: `模板-${m.key}.csv` };
});
route('POST', '/api/journals/import', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (!body.catalogKey) return { ok: false, error: '缺少 catalogKey' };
  if (!body.csv) return { ok: false, error: '缺少 csv 内容' };
  const r = journals.importCatalog(body.catalogKey, body.csv, {
    edition: body.edition, year: body.year, sourceName: body.sourceName, verified: body.verified !== false,
  });
  if (!r.ok) return r;
  // 导入目录后重新核验全部论文的期刊资格
  const revalidate = revalidateAllPapers();
  return { ...r, revalidate };
});
route('POST', '/api/journals/seed', async () => ({ ok: true, ...journals.loadSeedReference() }));
// 载入参考分区名录：需用户在界面明确确认；非官方目录，会逐条标注
route('POST', '/api/journals/load-jcr-reference', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (body.confirm !== true) {
    return {
      ok: false,
      needConfirm: true,
      error: '这是随程序附带的【参考分区名录】，不是官方 JCR 目录，且一定不完整。确认知悉后请勾选确认复选框再执行。',
      重要提示: [
        '分区来源是公开的领域常识性判断，可能因 JCR 年度更新而过时。',
        '据此判定的论文会标注「参考分区（非官方目录）」，便于你区分。',
        '要得到权威结论，请导入你机构提供的 JCR / SSCI 目录 CSV。',
      ],
    };
  }
  const r = journals.loadJcrReference();
  if (!r.ok) return r;
  const flags = journals.reconcileJournalFlags();
  const reval = revalidateAllPapers();
  store.logEvent('warn', 'journals', '已载入参考分区名录（非官方目录）', { 期刊数: r.期刊数, 版本: r.版本 });
  return { ...r, revalidate: reval };
});
route('GET', '/api/journals', async (req, url) => {
  const q = url.searchParams.get('q');
  const list = q
    ? store.all(`SELECT * FROM journals WHERE name LIKE ? OR issn LIKE ? OR name_variants LIKE ? ORDER BY verified DESC, name LIMIT 300`, ['%' + q + '%', '%' + q + '%', '%' + q + '%'])
    : store.all('SELECT * FROM journals ORDER BY verified DESC, in_whitelist DESC, name LIMIT 300');
  return { ok: true, journals: list.map((j) => ({
    id: j.id, name: j.name, issn: j.issn, language: j.language, publisher: j.publisher,
    verified: Boolean(j.verified), in_whitelist: Boolean(j.in_whitelist), in_blacklist: Boolean(j.in_blacklist),
    catalogs: store.parseJson(j.catalogs, []), jcr: store.parseJson(j.jcr, null), cas: store.parseJson(j.cas, null),
    source: j.source, last_checked: j.last_checked,
    eligibility: journals.eligibilityOf(j, config.getSettings()),
  })) };
});
route('POST', '/api/journals/verify/:id', async (req, url, m) => {
  const j = store.get('SELECT * FROM journals WHERE id = ?', [Number(m.id)]);
  if (!j) return { ok: false, error: '期刊不存在' };
  const checks = [];
  if (j.issn) {
    const cr = await sources.crossrefJournalByIssn(j.issn);
    checks.push({ source: 'Crossref', ok: cr.ok, title: cr.journal?.title || null, publisher: cr.journal?.publisher || null, error: cr.error || null });
    const dj = await sources.doajByIssn(j.issn);
    checks.push({ source: 'DOAJ', ok: dj.ok, inDoaj: Boolean(dj.journal), title: dj.journal?.title || null, error: dj.error || null });
  } else {
    checks.push({ source: 'Crossref', ok: false, error: '该刊无 ISSN，无法自动核验，请在导入目录时使用刊名精确匹配' });
  }
  const nameMatch = checks.find((c) => c.title);
  const match = nameMatch ? N.cleanJournalNameForMatch(nameMatch.title) === N.cleanJournalNameForMatch(j.name) : null;
  store.run('UPDATE journals SET last_checked = ? WHERE id = ?', [store.nowIso(), j.id]);
  return { ok: true, journal: j.name, checks, nameMatches: match,
    note: 'Crossref/DOAJ 只能核实刊名、出版商与开放获取状态，不能核实 CSSCI/北大核心/SSCI 收录或分区。这些必须由官方目录导入。' };
});
route('POST', '/api/journals/whitelist/:id', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  const j = store.get('SELECT * FROM journals WHERE id = ?', [Number(m.id)]);
  if (!j) return { ok: false, error: '期刊不存在' };
  store.run('UPDATE journals SET in_whitelist = ?, in_blacklist = ? WHERE id = ?',
    [body.whitelist ? 1 : 0, body.blacklist ? 1 : 0, j.id]);
  revalidateAllPapers();
  return { ok: true };
});
route('POST', '/api/journals/add', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (!body.name && !body.issn) return { ok: false, error: '至少需要刊名或 ISSN' };
  const entry = {
    catalog: body.catalog || '手动核验记录', catalogKey: body.catalogKey || 'manual',
    edition: body.edition || '手动记录', year: body.year || '',
    basis: body.basis || (body.issn ? '用户手动核验（ISSN）' : '用户手动核验（刊名）'),
    verified: true, source: body.source || '用户手动核验', note: body.note || '',
  };
  if (body.jcrCategories) { entry.jcrCategories = body.jcrCategories; entry.jcrYear = body.jcrYear; }
  if (body.casZone) { entry.casZone = body.casZone; entry.casCategory = body.casCategory; entry.casYear = body.casYear; entry.isTop = body.isTop; }
  const stats = { imported: 0, createdJournals: 0, updatedJournals: 0, errors: [], skipped: 0 };
  // 构造一行标准 CSV，走统一导入逻辑（保证匹配依据、版次、核验状态都被记录）
  const csvHeaders = ['期刊名称', 'ISSN', '版次或年份', 'JCR年份', 'JCR学科类别1', '分区1', 'JCR学科类别2', '分区2', 'JCR学科类别3', '分区3', '大类分区', '大类学科', '是否Top', '备注'];
  const row = [body.name || '', body.issn || '', body.edition || '手动记录', body.jcrYear || '',
    body.jcrCategories?.[0]?.name || '', body.jcrCategories?.[0]?.quartile || '',
    body.jcrCategories?.[1]?.name || '', body.jcrCategories?.[1]?.quartile || '',
    body.casZone || '', body.casCategory || '', body.isTop ? '是' : ''];
  const csv = journals.toCsv([csvHeaders, row]);
  const r = journals.importCatalog(body.casZone ? 'cas' : 'ssci_jcr', csv, { sourceName: '用户手动核验' });
  const r2 = body.casZone ? journals.importCatalog('ssci_jcr', csv, { sourceName: '用户手动核验' }) : r;
  const reval = revalidateAllPapers();
  return { ok: true, import: r, import2: body.casZone ? r2 : null, revalidate: reval };
});

/* --- 采集 --- */
// 采集可能持续数分钟（受外部 API 限流影响），因此后台执行 + 轮询进度，
// 而不是把 HTTP 请求挂住，避免浏览器与代理超时。
route('POST', '/api/ingest/run', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (BRIEF_JOB.running) return { ok: true, started: false, already: true, ...BRIEF_JOB };
  if(!Array.isArray(body.topics)||!body.topics.length||!Array.isArray(body.sources)||!body.sources.length)return {ok:false,error:'请先选择本次检索方向与数据源'};
  startBackgroundUpdate({ reason: body.reason || 'manual', force: body.force !== false, selection:{topics:body.topics,sources:body.sources,days:body.days,manual:true} });
  return { ok: true, started: true, ...BRIEF_JOB };
});
route('GET', '/api/ingest/progress', async () => ({
  ok: true,
  job: { ...BRIEF_JOB },
  collect: discover.progress(),
  circuits: require('./lib/http').circuitReport(),
}));
/* ---------------------- 公开中文期刊目录源 ---------------------- */
route('GET', '/api/cn-sources', async () => ({
  ok: true,
  sources: cnsource.listSourceStates(),
  note: '只接入公开可解析的目录页；逐篇取题名/作者/刊名/年期/页码/原页链接，'
    + '缺失字段留空（不猜 DOI、不编摘要）。这些目录页不作为 CSSCI/北大核心核验依据。',
}));

route('POST', '/api/cn-sources/check', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  const key = body.sourceKey;
  const dryRun = body.dryRun === true;
  const results = key
    ? [await cnsource.checkSource(String(key), { dryRun })]
    : await cnsource.checkAllSources({ dryRun });
  return { ok: true, dryRun, results };
});

route('POST', '/api/ingest/collect', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (BRIEF_JOB.running) return { ok: false, error: '已有采集任务在进行中', job: BRIEF_JOB };
  if(!Array.isArray(body.topics)||!body.topics.length)return {ok:false,error:'请先选择检索方向'};
  startBackgroundUpdate({ reason: 'collect-only', force: true, skipBrief: Boolean(body.skipBrief), selection:{topics:body.topics,sources:body.sources,days:body.days,manual:true} });
  return { ok: true, started: true, job: BRIEF_JOB };
});
// 按 DOI 从 OpenAlex 回填作者关键词与数据库主题词（合法、仅元数据）
route('POST', '/api/ingest/backfill-keywords', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (BRIEF_JOB.running) return { ok: false, error: '已有采集任务在进行中，请稍后再试' };
  BRIEF_JOB.running = true;
  BRIEF_JOB.stage = 'backfill';
  BRIEF_JOB.message = '正在按 DOI 回填作者关键词…';
  BRIEF_JOB.startedAt = new Date().toISOString();
  BRIEF_JOB.finishedAt = null;
  BRIEF_JOB.error = null;
  try {
    const r = await discover.backfillKeywords({
      limit: body.limit || 300, onlyMissing: body.onlyMissing !== false, language: body.language,
    });
    BRIEF_JOB.result = { backfill: r };
    BRIEF_JOB.stage = 'done';
    BRIEF_JOB.message = '关键词回填完成';
    store.logEvent('info', 'ingest', '关键词回填完成', r);
    return { ok: true, ...r };
  } catch (e) {
    BRIEF_JOB.stage = 'failed';
    BRIEF_JOB.error = e.message;
    return { ok: false, error: e.message };
  } finally {
    BRIEF_JOB.running = false;
    BRIEF_JOB.finishedAt = new Date().toISOString();
  }
});

// 按来源统计采集情况（成功/失败/取回/新增），并列出仍在熔断中的数据源
route('GET', '/api/ingest/stats', async (req, url) => {
  const days = Math.min(Number(url.searchParams.get('days') || 7), 90);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const bySource = store.all(
    `SELECT source,
            COUNT(*) AS requests,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS okCount,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failCount,
            SUM(found) AS found,
            SUM(added) AS added,
            MAX(at) AS lastAt
       FROM ingest_log WHERE at >= ?
      GROUP BY source ORDER BY requests DESC`, [since]);
  const failures = store.all(
    `SELECT source, http_status, message, at, topic FROM ingest_log
      WHERE ok = 0 AND at >= ? ORDER BY id DESC LIMIT 20`, [since]);
  const byTopic = store.all(
    `SELECT topic, COUNT(*) AS requests, SUM(found) AS found, SUM(added) AS added,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failCount
       FROM ingest_log WHERE at >= ? AND topic <> '' GROUP BY topic ORDER BY added DESC`, [since]);
  const languages = store.all(`SELECT language, COUNT(*) c FROM papers GROUP BY language`);
  const imported = store.get("SELECT COUNT(*) c FROM papers WHERE sources LIKE '%imported%'").c;
  return {
    ok: true, days, since,
    bySource: bySource.map((r) => ({
      ...r,
      successRate: r.requests ? Number((r.okCount / r.requests).toFixed(3)) : 0,
    })),
    byTopic, failures, languages, importedPapers: imported,
    circuits: require('./lib/http').circuitReport(),
    note: cnSourceNote(),
  };
});

/*
 * 「中文来源现状」这段说明由服务端生成，页面直接显示。
 *
 * 踩过的坑：这段话早先写死了「因此中文文献主要靠你导入题录」，
 * 中文目录源接通之后没有同步，于是设置页底部**第一段**与后面
 * 「中文来源现状」那段口径不一致。现在按库内真实情况生成，数字也不写死。
 */
function cnSourceNote() {
  const base = '失败数包含限流（HTTP 429）与网络错误。被限流的数据源会自动熔断并在上面列出恢复时间。';
  let auto = '自动中文目录源：尚未接入。';
  try {
    const rows = store.all(
      'SELECT journal_name, COUNT(*) c FROM cn_article_imports GROUP BY journal_name ORDER BY c DESC');
    if (rows.length) {
      const total = rows.reduce((a, r) => a + r.c, 0);
      const names = rows.map((r) => `《${r.journal_name}》`).join('、');
      auto = `自动中文目录源：目前仅覆盖 ${names} ${rows.length} 刊的公开目录，`
        + `已采 ${total} 条题录（只有题名/作者/年/期/页码，缺摘要与关键词）；`
        + '其余期刊目前主要需你导入题录。';
    }
  } catch { /* 表不存在（极老库）时退回默认 */ }
  return base + auto
    + '这些公开目录页只提供题录，不作为 CSSCI / 北大核心的核验依据；'
    + 'Semantic Scholar 默认不参与采集。';
}


route('GET', '/api/ingest/log', async (req, url) => {
  const limit = Math.min(Number(url.searchParams.get('limit') || 80), 500);
  return { ok: true, log: store.all('SELECT * FROM ingest_log ORDER BY id DESC LIMIT ?', [limit]) };
});
route('GET', '/api/events', async (req, url) => {
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
  return { ok: true, events: store.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', [limit]).map((e) => ({ ...e, meta: store.parseJson(e.meta, null) })) };
});

/* --- 简报 --- */
route('GET', '/api/brief', async (req, url) => {
  const date = url.searchParams.get('date');
  const b = brief.getBrief(date || undefined);
  if (!b) return { ok: true, empty: true, message: '还没有生成过简报。点击「立即更新」或等待每日自动更新。', scheduler: scheduler.status() };
  return { ok: true, ...b, stats: library.libraryStats(), scheduler: scheduler.status() };
});
route('POST', '/api/brief/generate', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  const r = await brief.generateBrief({ reason: body.reason || 'manual', force: body.force !== false, aiReasons: Boolean(body.aiReasons) });
  return { ok: r.ok !== false, ...r };
});
route('GET', '/api/brief/runs', async () => ({ ok: true, runs: brief.listRuns(60) }));

/* --- 前沿技术每日精选（独立于主简报，单独建表，不计入期刊合格数） --- */
const frontier = require('./lib/frontier');

route('GET', '/api/frontier', async (req, url) =>
  frontier.get(url.searchParams.get('date') || undefined));

route('GET', '/api/frontier/status', async () => {
  const st = await frontier.status();
  return { ok: true, ...st };
});

route('POST', '/api/frontier/generate', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  const r = await frontier.generate({
    reason: body.reason || 'manual',
    size: Number(body.size) > 0 ? Number(body.size) : undefined,
    skipCollect: Boolean(body.skipCollect),
  });
  return { ok: true, ...r, ...frontier.get() };
});

/* ACL Anthology 批量元数据同步（不必联网的解析逻辑在 lib/aclbib.js） */
route('POST', '/api/frontier/sync-acl', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  try {
    const acl = require('./lib/aclbib');
    const r = await acl.sync({ force: Boolean(body.force), light: Boolean(body.light) });
    return { ok: r.ok !== false, ...r };
  } catch (e) {
    return { ok: false, error: 'ACL 同步模块不可用：' + e.message };
  }
});

/* 前沿条目的中文译文（题名 / 摘要；已有缓存直接复用） */
route('POST', '/api/frontier/translate', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  return frontier.translatePicks({
    runId: body.runId ? Number(body.runId) : null,
    force: Boolean(body.force),
    limit: Number(body.limit) > 0 ? Math.min(Number(body.limit), 12) : 6,
  });
});
route('POST', '/api/scheduler/run', async (req) => {
  const r = await scheduler.catchUpIfNeeded();
  return { ok: true, ...r };
});
route('POST', '/api/scheduler/update', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (BRIEF_JOB.running) return { ok: true, started: false, already: true, ...BRIEF_JOB };
  if(!Array.isArray(body.topics)||!body.topics.length)return {ok:false,error:'请先选择检索方向'};
  startBackgroundUpdate({ reason: body.reason || 'manual', force: true, selection:{topics:body.topics,sources:body.sources,days:body.days,manual:true} });
  return { ok: true, started: true, ...BRIEF_JOB };
});

/* --- 论文详情 --- */
route('GET', '/api/papers/:id', async (req, url, m) => {
  const id = Number(m.id);
  const d = library.getPaperDetail(id);
  if (!d) return { ok: false, error: '论文不存在' };
  return {
    ok: true,
    paper: d,
    // 语种判定信息（含来源与依据）：详情页据此显示「语种待确认」与人工纠正入口
    languageInfo: langfix.languageInfo(id),
    // 解读必须带上「有没有材料快照」，否则前端无法区分
    // 「可回溯的新解读」与「生成于快照功能之前的旧解读」，
    // 就会把旧解读的 [S1] 也渲染成可点按钮。
    interpretations: interpret.listInterpretations(id).map((it) => {
      const mats = store.all('SELECT sid FROM interpretation_materials WHERE interp_id = ?', [it.id]);
      return { ...it, materialCount: mats.length, hasSnapshot: mats.length > 0 };
    }),
    // 每条解读实际拥有哪些材料编号：前端据此逐个核验正文里的 [Sn]，
    // 有快照才可点，没有快照（旧解读）或编号对不上就渲染成不可点样式
    snapshots: Object.fromEntries(
      store.all(`SELECT DISTINCT im.interp_id FROM interpretation_materials im
                  JOIN papers p ON p.id = im.paper_id WHERE im.paper_id = ?`, [id])
        .map((r) => [r.interp_id, store.all('SELECT sid FROM interpretation_materials WHERE interp_id = ? ORDER BY id', [r.interp_id]).map((x) => x.sid)])),
    // 作者关键词 / 数据库主题词 / 工作台主题标签三者分开返回
    vocabulary: translateMod.statusForPaper(id),
    translations: translateMod.getAll(id),
  };
});

route('POST', '/api/papers/doi', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (!body.doi) return { ok: false, error: '请提供 DOI' };
  const r = await discover.addByDoi(body.doi, body.topics);
  return r;
});

/* --- 中文数据库题录导入（CNKI / 万方 / 维普 导出文本） --- */
const cnimport = require('./lib/cnimport');

route('POST', '/api/import/parse', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (!body.text) return { ok: false, error: '缺少 text（要解析的题录内容）' };
  const r = cnimport.parseImport(body.text);
  if (!r.ok) return r;
  return { ...r, preview: cnimport.previewJournalMatch(r.records) };
});

route('POST', '/api/import/commit', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  if (!Array.isArray(body.records) || !body.records.length) return { ok: false, error: '缺少 records' };
  const r = discover.importRecords(body.records, body.topics);
  return r;
});

route('POST', '/api/papers/import', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  let records = body.records;
  if (!records && body.csv) {
    const rows = journals.parseCsv(body.csv);
    if (rows.length > 1) {
      const headers = rows[0].map((h) => String(h).trim());
      records = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
    }
  }
  if (!records || !records.length) return { ok: false, error: '没有可导入的题录。可粘贴 JSON 数组，或每行一条 {"title":...,"journalName":...}，或用 CSV（含 题名/刊名/作者 列）。' };
  const r = discover.importRecords(records, body.topics);
  return r;
});

/* --- 收藏与个人管理 --- */
route('POST', '/api/library/star/:id', async (req, url, m, raw) => {
  const body = await readJson(req, raw).catch(() => ({}));
  return library.toggleStar(Number(m.id), body.value);
});
route('POST', '/api/library/read/:id', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  return library.setReadState(Number(m.id), body.read_state);
});
route('POST', '/api/library/note/:id', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  return library.setNote(Number(m.id), body.note);
});
route('DELETE', '/api/library/:id', async (req, url, m) => library.removeFromLibrary(Number(m.id)));
route('GET', '/api/library', async (req, url) => ({
  ok: true,
  items: library.listLibrary({
    tag: url.searchParams.get('tag') || undefined,
    read_state: url.searchParams.get('read_state') || undefined,
    language: url.searchParams.get('language') || undefined,
    journal: url.searchParams.get('journal') || undefined,
    topic: url.searchParams.get('topic') || undefined,
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    q: url.searchParams.get('q') || undefined,
    starredOnly: url.searchParams.get('all') !== '1',
  }),
  stats: library.libraryStats(),
}));

/* --- 今日发现 / 首页 --- */
const desk = require('./lib/desk');
const judgments = require('./lib/judgments');

const reader = require('./lib/reader');
route('GET', '/api/reader', async () => reader.summary());
route('GET', '/api/reader/update-status', async () => ({ok:true,...reader.updateStatus()}));
route('POST', '/api/reader/visit', async () => reader.visit());
route('POST', '/api/reader/action', async (req,url,m,raw) => {
  const body = await readJson(req,raw); return reader.action(body.kind,body.ids,body.value);
});
route('POST', '/api/reader/undo/:id', async (req,url,m) => reader.undo(m.id));
route('POST', '/api/reader/resume', async (req,url,m,raw) => {
  const body = await readJson(req,raw);
  const p = store.get('SELECT id,title FROM papers WHERE id=?',[Number(body.id)]);
  if (!p) return {ok:false,error:'论文不存在'};
  reader.setState('lastReading',{id:p.id,title:p.title,at:store.nowIso()});
  return {ok:true};
});

route('GET', '/api/desk', async () => desk.deskOverview());

route('GET', '/api/desk/discovery', async (req, url) => desk.listDiscovery({
  page: url.searchParams.get('page'),
  pageSize: url.searchParams.get('pageSize'),
  journalFilter: url.searchParams.get('journalFilter'),
  language: url.searchParams.get('language'),
  // 默认视图是中英文；显式传 all 才展示全部语种
  languageScope: url.searchParams.get('languageScope'),
  topic: url.searchParams.get('topic'),
  category: url.searchParams.get('category'),
  browse: url.searchParams.get('browse'),
  since: url.searchParams.get('since'),
  q: url.searchParams.get('q'),
  days: url.searchParams.get('days'),
  includeMuted: url.searchParams.get('includeMuted') === '1',
}));

route('GET', '/api/desk/qualified', async (req, url) => desk.listQualified({
  page: url.searchParams.get('page'),
  pageSize: url.searchParams.get('pageSize'),
  includeMuted: url.searchParams.get('includeMuted') === '1',
}));

/* --- 阅读判断：感兴趣 / 暂不关注 / 撤销 --- */
route('POST', '/api/judgments/:id', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  return judgments.setJudgment(Number(m.id), body.decision, {
    note: body.note || null, source: body.source || null,
  });
});
route('GET', '/api/judgments/:id', async (req, url, m) => ({ ok: true, ...judgments.getJudgment(Number(m.id)) }));

/* ---------------------- 语种人工纠正 ---------------------- */
route('GET', '/api/language/:id', async (req, url, m) => {
  const info = langfix.languageInfo(Number(m.id));
  if (!info) return { ok: false, error: '论文不存在' };
  return { ok: true, ...info };
});
route('POST', '/api/language/:id', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  return langfix.setLanguage(Number(m.id), body.language);
});
route('DELETE', '/api/language/:id', async (req, url, m) => langfix.clearLanguage(Number(m.id)));
route('GET', '/api/judgments', async (req, url) => {
  const scope = url.searchParams.get('scope') || 'all';
  return {
    ok: true,
    stats: judgments.judgmentStats(),
    interested: scope === 'muted' ? [] : judgments.listInterested({ limit: Number(url.searchParams.get('limit')) || 200 }),
    muted: scope === 'interested' ? [] : judgments.listMuted({ limit: Number(url.searchParams.get('limit')) || 200 }),
    note: '判断只记录你的明确选择，不会自动改变推荐排序，也不会自动收藏。',
  };
});

/* --- 篇关摘翻译 --- */
const translateMod = require('./lib/translate');

/*
 * 列表页译文懒加载。
 *
 * 首页与简报卡片要「直接看到译文」，但绝不能一打开就把上千篇全部翻译。
 * 前端渲染完成后只对**当前可见**的少量卡片调用本接口：
 *   · 已有缓存 ⇒ 直接返回缓存，不消耗模型调用；
 *   · 缺译文   ⇒ 按 limit 上限分批生成，其余返回 remaining；
 *   · 未配置 AI ⇒ 明确返回 configured:false，前端显示「待配置」而不是假装翻译。
 *
 * 注意：本路由必须注册在 `/api/translate/:paperId` **之前**，
 * 否则 'batch' 会被当成 paperId 匹配掉。
 */
route('POST', '/api/translate/batch', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  return translateMod.translateBatch({
    paperIds: Array.isArray(body.paperIds) ? body.paperIds : [],
    fields: Array.isArray(body.fields) ? body.fields : undefined,
    force: Boolean(body.force),
    limit: Number(body.limit) > 0 ? Math.min(Number(body.limit), 60) : 24, targetLang:body.targetLang,
  });
});

route('GET', '/api/translate/:paperId', async (req, url, m) =>
  translateMod.getAll(Number(m.paperId)));

route('POST', '/api/translate/:paperId', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  const paperId = Number(m.paperId);
  if (body.all) {
    return translateMod.translateAll({
      paperId, force: Boolean(body.force),
      fields: Array.isArray(body.fields) ? body.fields : undefined,
    });
  }
  if (!body.field) return { ok: false, error: '缺少 field（title / keywords / abstract）' };
  return translateMod.translate({ paperId, field: body.field, force: Boolean(body.force) });
});

/* --- AI 解读 --- */
route('POST', '/api/interpret', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  const r = await require('./lib/models').withProfile(require('./lib/customize').get('bindings',{})[!body.mode||body.mode==='quick'?'quick':'deep'],()=>interpret.interpret({
    paperId: Number(body.paperId),
    mode: body.mode || 'quick',
    question: body.question || null,
    useFulltext: body.useFulltext !== false,
  }));
  return r;
});
route('GET', '/api/interpret/:paperId', async (req, url, m) => {
  const paperId = Number(m.paperId);
  const items = interpret.listInterpretations(paperId).map((it) => {
    const snap = store.get('SELECT COUNT(*) c FROM interpretation_materials WHERE interp_id = ?', [it.id]).c;
    return { ...it, materialCount: snap, hasSnapshot: snap > 0 };
  });
  return { ok: true, items };
});

// 材料快照：整条解读的全部材料，或单个编号
route('GET', '/api/evidence/:interpId', async (req, url, m) => {
  const sid = url.searchParams.get('sid');
  if (sid) return interpret.getMaterial(Number(m.interpId), sid);
  return interpret.getMaterialsForInterpretation(Number(m.interpId));
});
route('DELETE', '/api/interpret/:id', async (req, url, m) => { interpret.deleteInterpretation(Number(m.id)); return { ok: true }; });
route('GET', '/api/preview/:paperId', async (req, url, m) => {
  const ev = interpret.buildEvidence(Number(m.paperId), url.searchParams.get('fulltext') !== '0');
  if (!ev.ok) return ev;
  return {
    ok: true, evidenceScope: ev.scope, evidenceNote: ev.evidenceNote,
    metadata: ev.meta, materialCount: ev.sentences.length, truncated: ev.truncated,
    fulltextInfo: ev.fulltextInfo,
    materials: ev.sentences.map((s) => ({ id: s.id, scope: s.scope, section: s.section || null, preview: s.text.slice(0, 160) })),
    ruleSummary: interpret.ruleBasedSummary(Number(m.paperId)),
  };
});

/* --- 全文 --- */
route('POST', '/api/fulltext/upload/:paperId', async (req, url, m, raw) => {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/pdf')) {
    return { ok: false, error: '请上传 PDF 文件（Content-Type: application/pdf）' };
  }
  const buf = raw && raw.length ? raw : await readBody(req);
  if (!buf.length) return { ok: false, error: '文件内容为空' };
  const raw2 = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : 'uploaded.pdf';
  return fulltext.saveUploadedPdf(Number(m.paperId), raw2, buf);
});
route('GET', '/api/fulltext/:paperId', async (req, url, m) => {
  const ft = fulltext.getFulltext(Number(m.paperId));
  if (!ft) return { ok: false, error: '没有全文' };
  const limit = Number(url.searchParams.get('limit') || 0);
  return { ok: true, fulltext: { ...ft, content: limit ? ft.content.slice(0, limit) : ft.content } };
});
route('DELETE', '/api/fulltext/:paperId', async (req, url, m) => fulltext.deleteFulltext(Number(m.paperId)));
route('POST', '/api/fulltext/link/:paperId', async (req, url, m, raw) => {
  const body = await readJson(req, raw);
  return fulltext.recordOpenFulltextLink(Number(m.paperId), body.url, body.origin || 'open');
});
route('POST', '/api/fulltext/resolve/:paperId', async (req, url, m) => {
  const r = await discover.enrichPaper(Number(m.paperId));
  return r;
});

/* --- 检索库内论文 --- */
route('GET', '/api/papers', async (req, url) => {
  const q = url.searchParams.get('q');
  const elig = url.searchParams.get('eligibility');
  const lang = url.searchParams.get('language');
  const where = []; const params = [];
  if (q) { where.push('(title LIKE ? OR abstract LIKE ? OR authors LIKE ? OR journal_name LIKE ? OR doi_norm LIKE ?)'); const l = '%' + q + '%'; params.push(l, l, l, l, l); }
  if (elig) { where.push('eligibility = ?'); params.push(elig); }
  if (lang) { where.push('language = ?'); params.push(lang); }
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
  const rows = store.all(`SELECT * FROM papers ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(published_online, issued_date, discovery_date) DESC LIMIT ?`, [...params, limit]);
  const topicMap = rank.topicNameMap();
  const settings = config.getSettings();
  return { ok: true, count: rows.length, papers: rows.map((p) => {
    const jrow = p.journal_id ? store.get('SELECT * FROM journals WHERE id = ?', [p.journal_id]) : null;
    const jinfo = jrow ? journals.eligibilityOf(jrow, settings) : { tags: [] };
    return {
      id: p.id, title: p.title, journal_name: p.journal_name, language: p.language,
      published_online: p.published_online, issued_date: p.issued_date, discovery_date: p.discovery_date,
      doi: p.doi_norm, eligibility: p.eligibility,
      eligibility_basis: p.eligibility_basis || null,
      eligibility_note: p.eligibility_note,
      open_access: Boolean(p.open_access), url: p.url,
      journal_tags: jinfo.tags,
      topics: store.parseJson(p.topics, []).map((s) => ({ slug: s, name: topicMap[s] || s })),
    };
  }) };
});

/* --- 校验：重新核验全部论文的期刊资格 --- */
route('POST', '/api/revalidate', async () => ({ ok: true, ...revalidateAllPapers() }));

function revalidateAllPapers() {
  const s = config.getSettings();
  const rankMod = require('./lib/rank');
  const topics = discover.listTopics(true);
  const rows = store.all('SELECT * FROM papers');
  let eligible = 0, reference = 0, pending = 0, excluded = 0, relinked = 0, retagged = 0;
  store.tx(() => {
    for (const p of rows) {
      const jrow = journals.findJournal({ issn: p.issn, name: p.journal_name });
      const info = journals.eligibilityOf(jrow, s);
      // 参考候选不计入「期刊条件合格」；严格模式下只有官方目录结论才合格
      let st = info.status;
      if (s.strictJournalFilter === false && st === 'pending') st = 'reference';
      if (jrow && jrow.id !== p.journal_id) relinked++;

      // 回填主题标签：早期版本只记录数据源自带的主题，Crossref 来源会为空
      const current = store.parseJson(p.topics, []);
      // 回填时不用旧值兜底：没有区分度证据就不打标签
      const inferred = rankMod.inferTopics(p, topics, { keepExistingWhenEmpty: false });
      const changed = JSON.stringify(current) !== JSON.stringify(inferred);
      if (changed) retagged++;

      store.run(`UPDATE papers SET journal_id = ?, eligibility = ?, eligibility_note = ?, topics = ?,
                   eligible_official = ?, eligibility_basis = ?, updated_at = ? WHERE id = ?`,
        [jrow ? jrow.id : null, st, info.note,
         changed ? JSON.stringify(inferred) : p.topics,
         info.officialEligible ? 1 : 0, info.basis || 'pending', store.nowIso(), p.id]);
      if (st === 'eligible') eligible++;
      else if (st === 'reference') reference++;
      else if (st === 'excluded') excluded++;
      else pending++;
    }
  });
  return {
    total: rows.length, eligible, referenceOnly: reference, pending, excluded, relinked, retagged,
    catalogs: journals.catalogStatus().verifiedJournals,
  };
}

/* ----------------------------- 后台更新任务 ----------------------------- */

const BRIEF_JOB = {
  running: false, stage: 'idle', startedAt: null, finishedAt: null,
  reason: null, error: null, result: null, message: '',
};

function startBackgroundUpdate({ reason = 'manual', force = false, skipBrief = false, selection={} } = {}) {
  BRIEF_JOB.running = true;
  BRIEF_JOB.stage = 'collecting';
  BRIEF_JOB.startedAt = new Date().toISOString();
  BRIEF_JOB.finishedAt = null;
  BRIEF_JOB.reason = reason;
  BRIEF_JOB.error = null;
  BRIEF_JOB.result = null;
  BRIEF_JOB.message = '正在从数据源采集新论文…';
  (async () => {
    try {
      const collect = await discover.collect(selection);
      BRIEF_JOB.stage = skipBrief ? 'done' : 'briefing';
      BRIEF_JOB.message = skipBrief ? '采集完成' : '采集完成，正在生成简报…';
      let briefRes = null;
      if (!skipBrief) {
        briefRes = await brief.generateBrief({ reason, force });
      }
      BRIEF_JOB.result = {
        collect: {
          queries: collect.queries, rawCount: collect.rawCount,
          uniqueCandidates: collect.uniqueCandidates, inserted: collect.inserted,
          updatedExisting: collect.updatedExisting, eligible: collect.eligible,
          pending: collect.pending, excluded: collect.excluded,
          throttled: collect.throttled, circuits: collect.circuits,
          window: collect.window,
        },
        // 中文目录源的最近检查 / 新篇数 / 跳过原因，随任务结果一起回传
        cnSources: collect.cnSources || null,
        brief: briefRes,
      };
      BRIEF_JOB.stage = 'done';
      BRIEF_JOB.message = '更新完成';
      store.logEvent('info', 'ingest', '后台采集与简报生成完成', BRIEF_JOB.result);
    } catch (e) {
      BRIEF_JOB.stage = 'failed';
      BRIEF_JOB.error = e.message;
      BRIEF_JOB.message = '更新失败：' + e.message;
      store.logEvent('error', 'ingest', '后台采集失败: ' + e.message, { stack: e.stack?.split('\n').slice(0, 5) });
    } finally {
      BRIEF_JOB.running = false;
      BRIEF_JOB.finishedAt = new Date().toISOString();
    }
  })();
  return BRIEF_JOB;
}

require('./lib/api-v2')({route,readJson,revalidate:revalidateAllPapers});

/* ----------------------------- 请求分发 ----------------------------- */

async function handle(req, res, rawBody) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;
  const host=(req.headers.host||'').split(':')[0];
  if(!['127.0.0.1','localhost'].includes(host)){sendJson(res,403,{ok:false,error:'仅允许本机访问'});return;}
  if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{}if(!origin||!['127.0.0.1','localhost'].includes(origin.hostname)||origin.port!==String(PORT)){sendJson(res,403,{ok:false,error:'拒绝跨站请求'});return;}}

  if (!pathname.startsWith('/api/')) { serveStatic(req, res, pathname); return; }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      const out = await r.handler(req, url, params, rawBody);
      sendJson(res, out && out.ok === false ? 200 : 200, out);
    } catch (e) {
      store.logEvent('error', 'api', `${req.method} ${pathname} 失败: ${e.message}`, { stack: e.stack?.split('\n').slice(0, 5) });
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }
  sendJson(res, 404, { ok: false, error: '接口不存在: ' + pathname });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > 80 * 1024 * 1024) { aborted = true; res.writeHead(413); res.end('payload too large'); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (aborted) return;
    await handle(req, res, Buffer.concat(chunks));
  });
  req.on('error', () => {});
});

/* ----------------------------- 启动 ----------------------------- */

async function start() {
  const init = initialize();
  // 启动时准备主题判定缓存，分类切换只筛选现有结果。
  require('./lib/desk').listDiscovery({pageSize:1});
  server.listen(PORT, HOST, async () => {
    const url = `http://${HOST}:${PORT}`;
    console.log('══════════════════════════════════════════════════════');
    console.log('  文献阅读工作台 已启动');
    console.log('  地址: ' + url);
    console.log('  数据: ' + config.DATA_DIR);
    console.log('  期刊参考表: ' + (init.seedReference ? `已载入 ${init.seedReference.added} 条` : '已存在'));
    if (init.migrations && init.migrations.length) console.log('  数据库迁移: 新增 ' + init.migrations.join(', '));
    if (init.flagReconcile && (init.flagReconcile.verifiedFixed || init.flagReconcile.ssciFixed)) {
      console.log(`  期刊标记修正: verified ${init.flagReconcile.verifiedFixed} 条、ssci_confirmed ${init.flagReconcile.ssciFixed} 条`);
    }
    console.log('  AI 密钥: ' + config.detectAiProvider());
    console.log('══════════════════════════════════════════════════════');
    const sch = scheduler.schedule();
    console.log(`  每日更新: ${config.getSettings().briefHour}:${String(config.getSettings().briefMinute).padStart(2, '0')} (${config.getSettings().timezone})，下次 ${sch.nextAt}`);
    store.logEvent('info', 'server', '服务已启动', { url, node: process.version });
    if (process.env.LITDESK_NO_AUTORUN !== '1') {
      scheduler.catchUpIfNeeded().then((r) => {
        if (r.caught) console.log(`  [补做] 类型=${r.kind} 结果=${JSON.stringify(r.res?.briefResult || r.res?.error)}`);
        else console.log(`  [调度] ${r.reason}`);
      }).catch((e) => console.error('  补做失败: ' + e.message));
    }
  });
}

if (require.main === module) start();

module.exports = { start, server, initialize, revalidateAllPapers, handle };
