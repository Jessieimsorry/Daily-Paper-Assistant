'use strict';
/**
 * 语种人工纠正。
 *
 * 为什么需要：自动判定再谨慎也会有边界情况（例如只有「Analisis wacana」这种
 * 短标题、或用英文写标题但正文是印尼语的期刊）。这时用户应当能一句话改掉它，
 * 而且要**可复核、不被下一次采集覆盖**。
 *
 * 设计取舍：
 *  · 只改 language 相关字段，不碰标题/摘要/DOI/收藏/解读；
 *  · 纠正后 language_source = 'manual'，采集时 resolvePaperLanguage 会沿用人工值，
 *    因此下次采集不会把用户的判断冲掉；
 *  · 同时把「自动判定原本是什么」记在 language_detail.detected 里，
 *    以便一键恢复自动判定，而不是逼用户记住原值。
 */
const store = require('./store');
const N = require('./normalize');

/** 允许人工选择的语种 */
const LANGUAGE_CHOICES = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: '英文' },
  { code: 'id', label: '印尼语' },
  { code: 'other', label: '其他语种' },
  { code: 'unknown', label: '语种待确认' },
];
const ALLOWED = new Set(LANGUAGE_CHOICES.map((x) => x.code));

function languageLabel(code) {
  return (LANGUAGE_CHOICES.find((x) => x.code === code) || {}).label || null;
}

/** 读出该论文的语种判定信息（含可复核依据），供详情页显示 */
function languageInfo(paperId) {
  const p = store.get(
    'SELECT id, language, language_source, title_language, abstract_language, language_detail FROM papers WHERE id = ?',
    [paperId]);
  if (!p) return null;
  const detail = store.parseJson(p.language_detail, {}) || {};
  return {
    language: p.language || 'unknown',
    label: languageLabel(p.language) || (p.language === 'unknown' ? '语种待确认' : p.language),
    source: p.language_source || 'unknown',
    // 判定来源：manual 表示你人工确认过；publisher 是来源代码；title/abstract 是文本证据
    sourceLabel: {
      manual: '你人工确认', publisher: '来源元数据', title: '题名证据',
      abstract: '摘要证据（题名证据不足时）', unknown: '暂无足够证据',
    }[p.language_source || 'unknown'] || p.language_source,
    titleLanguage: p.title_language || null,
    abstractLanguage: p.abstract_language || null,
    confidence: detail.confidence || null,
    evidence: detail.evidence || null,
    conflict: detail.conflict === true,
    sourceLanguageRaw: detail.sourceLanguageRaw || null,
    detectedAt: detail.detectedAt || null,
    // 自动判定原本是什么（用于「恢复自动判定」）
    auto: detail.auto || null,
    choices: LANGUAGE_CHOICES,
  };
}

/**
 * 人工设定语种。
 * @param {number} paperId
 * @param {string} code zh | en | id | other | unknown
 */
function setLanguage(paperId, code) {
  const c = String(code || '').trim().toLowerCase();
  if (!ALLOWED.has(c)) {
    return { ok: false, error: `不支持的语种代码「${code}」，可选：${[...ALLOWED].join(' / ')}` };
  }
  const p = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (!p) return { ok: false, error: '论文不存在' };

  const detail = store.parseJson(p.language_detail, {}) || {};
  // 第一次人工纠正时，把自动判定的结果留下来（只在还没有 auto 时写）
  if (!detail.auto) {
    detail.auto = {
      language: p.language || 'unknown',
      source: p.language_source || 'unknown',
      titleLanguage: p.title_language || null,
      abstractLanguage: p.abstract_language || null,
      at: store.nowIso(),
    };
  }
  detail.manual = { language: c, at: store.nowIso() };
  detail.confidence = 'high';
  detail.evidence = `由你人工确认为${languageLabel(c)}`;

  store.run(
    `UPDATE papers SET language = ?, language_source = 'manual', language_detail = ?, updated_at = ? WHERE id = ?`,
    [c, JSON.stringify(detail), store.nowIso(), paperId]);

  return {
    ok: true, paperId, language: c, label: languageLabel(c), source: 'manual',
    note: '已记录为人工确认。下次采集不会覆盖这个判断。',
    info: languageInfo(paperId),
  };
}

/** 恢复为自动判定结果（撤销人工纠正） */
function clearLanguage(paperId) {
  const p = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (!p) return { ok: false, error: '论文不存在' };
  const detail = store.parseJson(p.language_detail, {}) || {};
  if (p.language_source !== 'manual' || !detail.auto) {
    return { ok: false, error: '这篇论文没有人工纠正记录' };
  }
  delete detail.auto;
  delete detail.manual;
  /*
   * 老数据里可能根本没有记录过判定来源（这几列是后加的，历史行是空值）。
   * 那种情况下按当前逻辑重新算一次，得到真实的来源与题名/摘要语种，
   * 而不是把来源含糊地写成 unknown。
   */
  const fresh = N.resolvePaperLanguage({
    title: p.title, abstract: p.abstract,
    sourceLanguage: detail.sourceLanguageRaw || null,
  });
  const language = fresh.language || 'unknown';
  const source = fresh.source || 'unknown';
  detail.confidence = fresh.confidence;
  detail.evidence = '已恢复为自动判定：' + fresh.evidence;
  detail.conflict = fresh.conflict;
  store.run(
    `UPDATE papers SET language = ?, language_source = ?, title_language = ?, abstract_language = ?, language_detail = ?, updated_at = ? WHERE id = ?`,
    [language, source, fresh.titleLanguage, fresh.abstractLanguage,
      JSON.stringify(detail), store.nowIso(), paperId]);
  return { ok: true, paperId, language, source, restored: true, info: languageInfo(paperId) };
}

module.exports = { LANGUAGE_CHOICES, languageLabel, languageInfo, setLanguage, clearLanguage };
