'use strict';
/**
 * 收藏与个人管理：收藏状态、已读/待读、个人备注，持久化在本地 SQLite。
 */
const store = require('./store');
require('./reader');
const N = require('./normalize');
const { getSettings } = require('./config');

function ensureRow(paperId) {
  let row = store.get('SELECT * FROM library WHERE paper_id = ?', [paperId]);
  if (!row) {
    store.run("INSERT INTO library(paper_id, starred, read_state, note) VALUES(?,0,'unread','')", [paperId]);
    row = store.get('SELECT * FROM library WHERE paper_id = ?', [paperId]);
  }
  return row;
}

function toggleStar(paperId, value) {
  const p = store.get('SELECT id FROM papers WHERE id = ?', [paperId]);
  if (!p) return { ok: false, error: '论文不存在' };
  ensureRow(paperId);
  const cur = store.get('SELECT starred FROM library WHERE paper_id = ?', [paperId]).starred;
  const next = value === undefined ? (cur ? 0 : 1) : (value ? 1 : 0);
  store.run('UPDATE library SET starred = ?, updated_at = ? WHERE paper_id = ?', [next, store.nowIso(), paperId]);
  return { ok: true, starred: Boolean(next) };
}

function setReadState(paperId, state) {
  const allowed = ['unread', 'reading', 'read'];
  if (!allowed.includes(state)) return { ok: false, error: '无效的阅读状态，应为 unread/reading/read' };
  const p = store.get('SELECT id FROM papers WHERE id = ?', [paperId]);
  if (!p) return { ok: false, error: '论文不存在' };
  ensureRow(paperId);
  store.run('UPDATE library SET read_state = ?, updated_at = ? WHERE paper_id = ?', [state, store.nowIso(), paperId]);
  return { ok: true, read_state: state };
}

function setNote(paperId, note) {
  const p = store.get('SELECT id FROM papers WHERE id = ?', [paperId]);
  if (!p) return { ok: false, error: '论文不存在' };
  ensureRow(paperId);
  store.run('UPDATE library SET note = ?, updated_at = ? WHERE paper_id = ?', [String(note || '').slice(0, 8000), store.nowIso(), paperId]);
  return { ok: true, note: String(note || '') };
}

function removeFromLibrary(paperId) {
  const r = store.run('DELETE FROM library WHERE paper_id = ?', [paperId]);
  return { ok: true, removed: r.changes > 0 };
}

/** 收藏列表，支持按主题、语言、日期、期刊筛选 */
function listLibrary(filters = {}) {
  const where = [];
  const params = [];
  if (filters.tag) {
    where.push('p.id IN (SELECT rp.paper_id FROM reader_papers rp, json_each(rp.tags) jt WHERE jt.value = ?)');
    params.push(filters.tag);
  }
  if (filters.starredOnly !== false) where.push('l.starred = 1');
  if (filters.read_state) { where.push('l.read_state = ?'); params.push(filters.read_state); }
  if (filters.language) { where.push('p.language = ?'); params.push(filters.language); }
  if (filters.journal) { where.push('p.journal_name LIKE ?'); params.push('%' + filters.journal + '%'); }
  // 主题以 JSON 数组存储，用 "slug" 精确匹配避免子串误命中
  if (filters.topic) { where.push('p.topics LIKE ?'); params.push('%"' + filters.topic + '"%'); }
  if (filters.from) { where.push('COALESCE(p.published_online, p.issued_date, p.discovery_date) >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('COALESCE(p.published_online, p.issued_date, p.discovery_date) <= ?'); params.push(filters.to); }
  if (filters.q) {
    where.push('(p.title LIKE ? OR p.abstract LIKE ? OR p.authors LIKE ? OR l.note LIKE ?)');
    const like = '%' + filters.q + '%';
    params.push(like, like, like, like);
  }
  const sql = `SELECT l.starred, l.read_state, l.note, l.added_at, l.updated_at, p.*
               FROM library l JOIN papers p ON p.id = l.paper_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY l.updated_at DESC, p.id DESC LIMIT ?`;
  params.push(Math.min(filters.limit || 200, 1000));
  const rows = store.all(sql, params);

  const interpCounts = {};
  for (const r of store.all('SELECT paper_id, COUNT(*) c FROM interpretations GROUP BY paper_id')) interpCounts[r.paper_id] = r.c;
  const topicMap = require('./rank').topicNameMap();
  const jmod = require('./journals');
  const settings = getSettings();

  return rows.map((r) => {
    const jrow = r.journal_id ? store.get('SELECT * FROM journals WHERE id = ?', [r.journal_id]) : null;
    // 资格说明以「现在」的判定为准：papers.eligibility_note 只是发现时的副本，
    // 判定措辞更新后可能过时，所以这里用 journals.eligibilityOf 现算（库里的值作兜底）。
    const jinfo = jmod.eligibilityOf(jrow, settings);
    const eligNote = jinfo.note || r.eligibility_note;
    return ({
    id: r.id, title: r.title, title_zh: r.title_zh,
    authors: store.parseJson(r.authors, []),
    journal_name: r.journal_name, language: r.language,
    published_online: r.published_online, published_print: r.published_print,
    issued_date: r.issued_date, discovery_date: r.discovery_date,
    doi: r.doi_norm, url: r.url, open_access: Boolean(r.open_access),
    citation_count: r.citation_count,
    topics: store.parseJson(r.topics, []).map((s) => ({ slug: s, name: topicMap[s] || s })),
    eligibility: r.eligibility,
    eligibility_basis: r.eligibility_basis || null,
    eligibility_note: eligNote,
    journal_tags: jinfo.tags,
    keywords: store.parseJson(r.keywords, []),
    starred: Boolean(r.starred), read_state: r.read_state, note: r.note,
    project_tags: store.parseJson(store.get('SELECT tags FROM reader_papers WHERE paper_id=?',[r.id])?.tags,[]),
    added_at: r.added_at, updated_at: r.updated_at,
    interpretations: interpCounts[r.id] || 0,
  });
  });
}

function libraryStats() {
  const c = (sql, params = []) => store.get(sql, params).c;
  const total = c('SELECT COUNT(*) c FROM library');
  const starred = c('SELECT COUNT(*) c FROM library WHERE starred = 1');
  const read = c("SELECT COUNT(*) c FROM library WHERE read_state = 'read'");
  const reading = c("SELECT COUNT(*) c FROM library WHERE read_state = 'reading'");
  const unread = c("SELECT COUNT(*) c FROM library WHERE starred = 1 AND read_state = 'unread'");
  const papers = c('SELECT COUNT(*) c FROM papers');
  // 只有官方目录核验过的才算「期刊条件合格」；参考名录只算「参考候选」
  const eligible = c("SELECT COUNT(*) c FROM papers WHERE eligibility = 'eligible' AND eligible_official = 1");
  const reference = c("SELECT COUNT(*) c FROM papers WHERE eligibility = 'reference'");
  const pending = c("SELECT COUNT(*) c FROM papers WHERE eligibility = 'pending'");
  const interps = c('SELECT COUNT(*) c FROM interpretations');
  return {
    total, starred, read, reading, unread, papers,
    eligiblePapers: eligible, referencePapers: reference, pendingPapers: pending,
    interpretations: interps,
  };
}

function getPaperDetail(paperId) {
  const p = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (!p) return null;
  const jrow = p.journal_id ? store.get('SELECT * FROM journals WHERE id = ?', [p.journal_id]) : null;
  const journals = require('./journals');
  const jinfo = jrow ? journals.eligibilityOf(jrow, getSettings()) : { status: 'pending', tags: [], note: '该刊未在本地目录中匹配，无法核验收录与分区。' };
  const lib = store.get('SELECT * FROM library WHERE paper_id = ?', [paperId]);
  /*
   * 公开中文目录源的证据。catalogDate 是「目录页上看到的日期」，
   * 也就是**工作台从目录里首次见到这条题录的时间**，
   * 不是论文的出版日期——界面上必须分开表述。
   */
  const catalogEvidence = (() => {
    const row = store.get(
      'SELECT source_key, article_id, issue_label, source_url, article_url, evidence, fetched_at FROM cn_article_imports WHERE paper_id = ? LIMIT 1',
      [paperId]);
    if (!row) return null;
    const ev = store.parseJson(row.evidence, {}) || {};
    return {
      sourceKey: row.source_key,
      articleId: row.article_id,
      issueLabel: row.issue_label,
      sourceUrl: row.source_url,
      articleUrl: row.article_url,
      catalogDate: ev.catalogDate || null,
      dateBasis: ev.dateBasis || null,
      fetchedAt: row.fetched_at,
      note: ev.note || null,
    };
  })();
  const ft = store.get('SELECT * FROM fulltexts WHERE paper_id = ?', [paperId]);
  const topicMap = require('./rank').topicNameMap();
  const settings = getSettings();

  return {
    id: p.id, title: p.title, title_zh: p.title_zh,
    authors: store.parseJson(p.authors, []),
    journal: {
      name: p.journal_name, issn: p.issn, id: p.journal_id,
      verified: jrow ? jrow.verified === 1 : false,
      ssci_confirmed: jrow ? jrow.ssci_confirmed === 1 : false,
      tags: jinfo.tags, note: jinfo.note, status: jinfo.status, basis: jinfo.basis,
      hasOfficial: Boolean(jinfo.hasOfficial), hasReference: Boolean(jinfo.hasReference),
      jcr: jrow ? store.parseJson(jrow.jcr, null) : null,
      cas: jrow ? store.parseJson(jrow.cas, null) : null,
      catalogs: jrow ? store.parseJson(jrow.catalogs, []) : [],
      in_whitelist: jrow ? Boolean(jrow.in_whitelist) : false,
      in_blacklist: jrow ? Boolean(jrow.in_blacklist) : false,
    },
    language: p.language,
    abstract: p.abstract, abstract_source: p.abstract_source,
    dates: {
      published_online: p.published_online, published_print: p.published_print,
      issued_date: p.issued_date, discovery_date: p.discovery_date,
    },
    volume: N.cleanPlaceholder(p.volume), issue: N.cleanPlaceholder(p.issue),
    pages: N.cleanPlaceholder(p.pages),
    // 公开目录源的来源证据：目录页 / 原页 / 期次 / **目录首次见到日期**
    // 单独给出，避免和「出版日期」混淆（源页并没有逐篇出版日期）
    catalogSource: catalogEvidence,
    doi: p.doi_norm, url: p.url, pdf_url: p.pdf_url,
    open_access: Boolean(p.open_access), oa_status: p.oa_status, license: p.license,
    citation_count: p.citation_count,
    sources: (p.sources || '').split(',').filter(Boolean),
    topics: store.parseJson(p.topics, []).map((s) => ({ slug: s, name: topicMap[s] || s })),
    eligibility: p.eligibility,
    eligibility_basis: p.eligibility_basis || null,
    eligible_official: p.eligible_official === 1,
    eligibility_note: jinfo.note || p.eligibility_note,
    library: {
      starred: Boolean(lib?.starred), read_state: lib?.read_state || 'none',
      note: lib?.note || '', added_at: lib?.added_at || null,
    },
    // 阅读判断（感兴趣 / 暂不关注）
    judgment: require('./judgments').getJudgment(paperId),
    fulltext: ft ? {
      origin: ft.origin, filename: ft.filename, charCount: ft.char_count,
      fetchedAt: ft.fetched_at, note: ft.note,
      preview: (ft.content || '').slice(0, 1200),
      sections: store.parseJson(ft.sections, []).map((s) => s.heading || s.label),
    } : null,
    keywords: store.parseJson(p.keywords, []),
    keywords_source: p.keywords_source || null,
    source_queries: store.parseJson(p.source_queries, []),
    evidenceOptions: {
      hasMetadata: true,
      hasAbstract: Boolean(p.abstract),
      hasFulltext: Boolean(ft),
      fulltextOrigin: ft?.origin || null,
      note: !p.abstract
        ? '该论文缺少摘要：AI 解读只能依据题名与元数据，结论性判断会非常有限。'
        : (!ft ? '当前只有摘要可依据：AI 解读不会声称读过全文。上传或获取合法全文后可升级为依据全文的解读。' : null),
    },
    missing: {
      abstract: !p.abstract, doi: !p.doi_norm, url: !p.url,
    },
  };
}

module.exports = {
  toggleStar, setReadState, setNote, removeFromLibrary, listLibrary, libraryStats, getPaperDetail, ensureRow,
};
