'use strict';
/**
 * 阅读判断：感兴趣 / 暂不关注 / 撤销。
 *
 * 设计取舍（对应「先记录我的明确选择，不要仅凭几次点击悄悄改变推荐排序」）：
 *  · 这里只记录与回放你的明确选择，绝不因为判断本身去改推荐分数；
 *  · "感兴趣" 不会自动收藏（收藏是你的另一个明确动作），但会提供一键入口；
 *  · "暂不关注" 只是隐藏，随时可以在「阅读判断」里找回并撤销；
 *  · 未来的个性化排序若启用，必须显式开关并说明依据（见 rank 的 personalization）。
 */
const store = require('./store');

const DECISIONS = {
  interested: { label: '感兴趣', icon: '★' },
  muted: { label: '暂不关注', icon: '✕' },
  cleared: { label: '已撤销', icon: '—' },
};

function setJudgment(paperId, decision, { note = null, source = null } = {}) {
  if (!DECISIONS[decision]) {
    return { ok: false, error: '未知判断，应为 interested / muted / cleared' };
  }
  const paper = store.get('SELECT id, title FROM papers WHERE id = ?', [paperId]);
  if (!paper) return { ok: false, error: '论文不存在' };

  if (decision === 'cleared') {
    const r = store.run('DELETE FROM judgments WHERE paper_id = ?', [paperId]);
    return { ok: true, decision: 'cleared', removed: (r.changes || 0) > 0, label: DECISIONS.cleared.label };
  }

  store.run(
    `INSERT INTO judgments(paper_id, decision, note, source)
     VALUES(?,?,?,?)
     ON CONFLICT(paper_id) DO UPDATE SET
       decision = excluded.decision, note = excluded.note, source = excluded.source,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    [paperId, decision, note, source]);
  return {
    ok: true, decision, label: DECISIONS[decision].label,
    paperId, title: paper.title,
    // 明确告诉前端：判断不会自动改收藏
    note: decision === 'interested' ? '已记为感兴趣。收藏是单独的动作，需要你点「收藏」。' : null,
  };
}

function getJudgment(paperId) {
  const row = store.get('SELECT * FROM judgments WHERE paper_id = ?', [paperId]);
  if (!row) return { decision: null, label: null, note: null, updatedAt: null };
  return {
    decision: row.decision, label: DECISIONS[row.decision]?.label || row.decision,
    note: row.note, source: row.source, updatedAt: row.updated_at,
  };
}

/** 批量取判断（列表渲染用，避免 N+1 查询） */
function getJudgmentsFor(paperIds) {
  if (!paperIds || !paperIds.length) return {};
  const placeholders = paperIds.map(() => '?').join(',');
  const rows = store.all(
    `SELECT paper_id, decision, note, updated_at FROM judgments WHERE paper_id IN (${placeholders})`,
    paperIds);
  const map = {};
  for (const r of rows) map[r.paper_id] = { decision: r.decision, label: DECISIONS[r.decision]?.label, note: r.note, updatedAt: r.updated_at };
  return map;
}

/** 「感兴趣」列表：方便直接进入收藏或待读 */
function listInterested({ limit = 200 } = {}) {
  const rows = store.all(
    `SELECT j.decision, j.note AS judgment_note, j.updated_at AS judged_at, p.*
       FROM judgments j JOIN papers p ON p.id = j.paper_id
      WHERE j.decision = 'interested'
      ORDER BY j.updated_at DESC LIMIT ?`, [Math.min(limit, 1000)]);
  const topicMap = require('./rank').topicNameMap();
  return rows.map((r) => ({
    id: r.id, title: r.title, journal_name: r.journal_name, language: r.language,
    published_online: r.published_online, issued_date: r.issued_date, discovery_date: r.discovery_date,
    doi: r.doi_norm, eligibility: r.eligibility, eligibility_basis: r.eligibility_basis,
    journal_tags: tagsFor(r.journal_id),
    judgment_note: r.judgment_note, judged_at: r.judged_at,
    // 必须回传当前判断状态：前端靠它把按钮渲染成「★ 已感兴趣」并显示「撤销判断」。
    // 原来这里缺 judgment 字段，导致列表里显示成「☆ 感兴趣」且没有撤销按钮。
    judgment: r.decision,
    judgment_label: DECISIONS[r.decision]?.label || r.decision,
    judgment_source: r.judgment_source || null,
    starred: Boolean(store.get('SELECT starred FROM library WHERE paper_id = ?', [r.id])?.starred),
    read_state: store.get('SELECT read_state FROM library WHERE paper_id = ?', [r.id])?.read_state || 'none',
    topics: store.parseJson(r.topics, []).map((s) => ({ slug: s, name: topicMap[s] || s })),
  }));
}

/** 「暂不关注」列表：必须能找回并撤销 */
function listMuted({ limit = 200 } = {}) {
  const rows = store.all(
    `SELECT j.decision, j.note AS judgment_note, j.updated_at AS judged_at, j.source AS judgment_source,
            p.id, p.title, p.journal_name,
            p.language, p.published_online, p.issued_date, p.discovery_date, p.doi_norm,
            p.eligibility, p.eligibility_basis, p.journal_id, p.topics
       FROM judgments j JOIN papers p ON p.id = j.paper_id
      WHERE j.decision = 'muted'
      ORDER BY j.updated_at DESC LIMIT ?`, [Math.min(limit, 1000)]);
  const topicMap = require('./rank').topicNameMap();
  return rows.map((r) => ({
    id: r.id, title: r.title, journal_name: r.journal_name, language: r.language,
    published_online: r.published_online, issued_date: r.issued_date, discovery_date: r.discovery_date,
    doi: r.doi_norm, eligibility: r.eligibility, eligibility_basis: r.eligibility_basis,
    journal_tags: tagsFor(r.journal_id),
    judgment_note: r.judgment_note, judged_at: r.judged_at,
    judgment: r.decision,
    judgment_label: DECISIONS[r.decision]?.label || r.decision,
    judgment_source: r.judgment_source || null,
    topics: store.parseJson(r.topics, []).map((s) => ({ slug: s, name: topicMap[s] || s })),
  }));
}

function tagsFor(journalId) {
  if (!journalId) return [];
  const jrow = store.get('SELECT * FROM journals WHERE id = ?', [journalId]);
  if (!jrow) return [];
  return require('./journals').eligibilityOf(jrow, require('./config').getSettings()).tags;
}

function judgmentStats() {
  const c = (d) => store.get('SELECT COUNT(*) c FROM judgments WHERE decision = ?', [d]).c;
  return {
    interested: c('interested'),
    muted: c('muted'),
    total: store.get('SELECT COUNT(*) c FROM judgments').c,
  };
}

module.exports = { DECISIONS, setJudgment, getJudgment, getJudgmentsFor, listInterested, listMuted, judgmentStats, tagsFor };
