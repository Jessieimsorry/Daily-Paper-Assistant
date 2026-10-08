'use strict';
/**
 * 每日简报生成。
 * 规则：
 *  - 只从「期刊条件合格」的论文中精选；未核验论文进入待核验候选列表。
 *  - 首次在线发表日期 / 正式出版日期 / 工作台发现日期分开保存与展示。
 *  - 同一篇论文不会在两次简报中重复推送（除非它被重新发现且有新信息）。
 *  - 新论文不足时如实显示实际篇数。
 *  - 中英文都要保持可见（languageBalance）。
 */
const store = require('./store');
const N = require('./normalize');
const rank = require('./rank');
const clock = require('./clock');
const { getSettings } = require('./config');

function beijingDate(d = clock.now()) {
  // 用 Intl 计算北京时间自然日，避免依赖服务器时区
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: getSettings().timezone || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d); // YYYY-MM-DD
}

function candidateWindow(days) {
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  return from;
}

/**
 * 取候选：在时间窗口内发现在我们库里的论文。
 * @param {{includePending?:boolean, maxAgeDays?:number}} opts
 */
function getCandidates(opts = {}) {
  const s = getSettings();
  const from = candidateWindow(opts.maxAgeDays || Math.max(s.briefLookbackDays, 45));
  /*
   * 候选窗口与排序都必须带上 discovery_date。
   *
   * 为什么：公开目录源没有逐篇出版日期（我们只填源页能证明的字段），
   * issued_date 往往只到「年」（如 2026，按年初算），published_online 为空。
   * 若只看 published_online/issued_date，一条 2026 年第 2 期的题录会因为
   * 「2026 年」早于 45 天窗口而被判在窗口外，**根本进不了简报候选**——
   * 修复日期字段反而把新采到的中文题录挡在门外。
   * 工作台发现它的日期才是它进入视野的时间，必须参与判定。
   */
  const rows = store.all(
    `SELECT * FROM papers
      WHERE COALESCE(published_online, discovery_date, issued_date) >= ?
      ORDER BY COALESCE(published_online, discovery_date, issued_date) DESC`,
    [from]);
  return rows;
}

function decorate(paper, topicMap, topics) {
  const scored = rank.scorePaper(paper, topics);
  const elig = {
    status: paper.eligibility,
    note: paper.eligibility_note,
  };
  const jrow = paper.journal_id ? store.get('SELECT * FROM journals WHERE id = ?', [paper.journal_id]) : null;
  const jinfo = jrow ? require('./journals').eligibilityOf(jrow, getSettings()) : null;
  return {
    paper,
    scored,
    elig,
    journalTags: jinfo ? jinfo.tags : [],
    reason: rank.ruleReason(paper, scored, topicMap),
  };
}

/**
 * 主简报的选题：先按研究主题广泛发现，再让期刊核验状态成为「标注」而不是「门槛」。
 *
 * 这是本版最重要的修正。原实现只从官方目录核验合格的论文里选，
 * 于是当用户还没导入机构版 JCR/SSCI 与 CSSCI/北大核心目录时，
 * 今日发现有 700+ 篇主题候选，简报却整页空白——与「先广泛发现、再逐步筛选」的要求相反。
 *
 * 现在的规则：
 *   · 候选来自全部主题相关论文（官方合格 / 参考候选 / 待核验都可以进）；
 *   · 官方目录核验合格的排在前面并单独标注；
 *   · 参考候选与待核验必须逐篇显示核验状态、参考等级与证据来源，
 *     且**任何地方都不得把它们称为「期刊条件合格」**；
 *   · 主题相关性优先于期刊等级（等级不参与打分，只做标注与筛选）。
 */
function planBrief(candidates, { size, languageBalance, topics } = {}) {
  const isOfficial = (c) => c.paper.eligibility === 'eligible' && c.paper.eligible_official === 1;
  const eligible = candidates.filter(isOfficial);
  const pending = candidates.filter((c) => c.paper.eligibility === 'pending');
  const reference = candidates.filter((c) => c.paper.eligibility === 'reference');

  /*
   * 只有「整篇跨领域」（没有任何有效核心主题证据）才不进主简报。
   * 早期写法是「只要任一主题被判跨领域就排除」，于是
   * 一篇真正的二语习得研究仅因元数据提到 Mandarin、在「汉语语言学」上被判跨领域，
   * 就被整篇踢出主简报——这是 P1 要修的过度否决。
   */
  const pool = candidates.filter((c) =>
    c.scored.detail.isCrossDomain !== true
    && c.scored.dimensions.topic > 0
    && c.paper.eligibility !== 'excluded');   // 明确排除的论文不进主简报

  /*
   * 排序：主题相关性优先，新近度与材料完整度辅助。
   *
   * 与「今日发现」保持同一原则——**期刊等级是筛选条件与标注，不是排序依据**。
   * 早期写法给官方合格 +1000 分，等级必然压过相关性：
   * 一篇官方合格但与本领域只有微弱关系的论文，会排在高度相关的待核验论文之前。
   * 现在官方与否只影响标签，不影响名次；官方合格的独立精选页继续严格筛选。
   *
   * 新近度只用**可信发表时间**（normalize.bestPubDate），并按精度打折：
   * 只有年份的中文题录不会因为「工作台今天才采到」而被算成刚发表。
   * discovery_date 不参与新近度——它不是发表日期。
   */
  const freshnessOf = (c) => {
    const pub = N.bestPubDate(c.paper);
    if (!pub || !Number.isFinite(pub.ms)) return 0.15;
    const days = Math.max(0, (Date.now() - pub.ms) / 86400000);
    let base;
    if (days <= 3) base = 1;
    else if (days <= 10) base = 0.85;
    else if (days <= 30) base = 0.65;
    else if (days <= 60) base = 0.4;
    else if (days <= 120) base = 0.2;
    else base = 0.05;
    const penalty = pub.precision === 'day' ? 1 : (pub.precision === 'month' ? 0.85 : 0.6);
    return base * penalty;
  };
  for (const c of pool) {
    c.sort_score = Number((
      c.scored.dimensions.topic * 0.62
      + freshnessOf(c) * 0.28
      + (c.paper.abstract ? 0.10 : 0)
    ).toFixed(4));
  }
  const rankOf = (c) => c.sort_score;
  pool.sort((a, b) => rankOf(b) - rankOf(a));

  const limit = Math.max(5, Math.min(100, Math.round(Number(size) || 50)));
  let selected = [];
  let languageNote = null;

  /*
   * 默认入选范围：**已判定为中文或英文**的论文（每日优先阅读范围）。
   *
   * 关键约束：
   *   · 其他语种与「语种待确认」**不参与入选**，也绝不被偷算成英文
   *     （旧写法 `language !== 'zh'` 就是把 other/unknown 当英文）；
   *   · 它们不会被删除或丢弃——仍在「今日发现」里通过筛选可以查看；
   *   · 中英文不足时**如实显示不足篇数与原因**，不用非中英文凑数。
   */
  const zh = pool.filter((c) => N.isChineseLang(c.paper.language));
  const en = pool.filter((c) => N.isEnglishLang(c.paper.language));
  const otherLang = pool.filter((c) => !N.isChineseLang(c.paper.language) && !N.isEnglishLang(c.paper.language));

  selected = require('./categories').diverseSelect(
    pool.filter(c => N.isChineseLang(c.paper.language) || N.isEnglishLang(c.paper.language)),
    limit, { languageBalance });

  // 中英文不足时如实说明，不用其他语种凑数
  const shortfall = Math.max(0, limit - selected.length);
  if (shortfall > 0) {
    const parts = [];
    if (!zh.length) parts.push('窗口内没有已判定为中文的主题相关候选');
    if (!en.length) parts.push('窗口内没有已判定为英文的主题相关候选');
    if (otherLang.length) {
      parts.push(`另有 ${otherLang.length} 篇为非中英文或语种待确认，未计入默认入选范围`
        + '（它们不参与凑数；可在「今日发现」把语言筛选切到对应语种或「全部」查看）');
    }
    languageNote = `本次默认只收中英文，实际入选 ${selected.length} / ${limit} 篇，`
      + `不足 ${shortfall} 篇：${parts.join('；') || '可用的中英文候选不足'}。`;
  } else if (otherLang.length) {
    languageNote = `另有 ${otherLang.length} 篇为非中英文或语种待确认，未占用中/英文配额，`
      + '也没有被算作英文；它们仍在「今日发现」里可以查看。';
  }

  return { selected, eligible, pending, reference, pool, limit, languageNote, shortfall, otherLanguageCount: otherLang.length };
}

/**
 * 简报的语言诊断说明。
 * 优先解释「中英文不足」，其次解释「某种语言完全没有合格论文」。
 */
function languageDiagnosisNote({ zhEligible, enEligible, zhPending, selectedCount, limit }) {
  if (selectedCount < limit) {
    const miss = [];
    if (zhEligible === 0) {
      miss.push(`窗口内有 ${zhPending} 篇中文候选，但没有一篇通过现行目录条件`
        + '（中文 CSSCI 期刊极少在 Crossref 注册 DOI，且 CSSCI/北大核心目录需要你导入）');
    }
    if (enEligible === 0) miss.push('窗口内的英文候选都未通过期刊目录条件（请检查 SSCI/JCR 目录是否已导入）');
    return `本次默认只收中英文，入选 ${selectedCount} / ${limit} 篇。`
      + (miss.length ? `原因：${miss.join('；')}。` : '原因是可用的中英文候选不足。')
      + '非中英文与语种待确认的论文没有被用来凑数，它们仍可在「今日发现」里通过语言筛选查看。';
  }
  if (zhEligible === 0 && enEligible > 0) {
    return `今日简报中没有中文论文：窗口内有 ${zhPending} 篇中文候选，但没有一篇的期刊能通过现行目录条件。主要原因是中文 CSSCI 期刊极少在 Crossref 注册 DOI，而 CSSCI 来源期刊目录需要由你导入（或把中文题录手动导入）。在此之前，中文论文会一直停留在「待核验候选」。`;
  }
  if (enEligible === 0 && zhEligible > 0) {
    return '今日简报中没有英文论文：窗口内的英文候选都未通过期刊目录条件。请检查 SSCI/JCR 目录是否已导入。';
  }
  return null;
}

/**
 * 逐篇标注这篇论文的期刊核验状态与证据来源。
 * 关键约束：非官方核验的论文绝不能出现「期刊条件合格」这类表述。
 */
function verificationLabel(paper) {
  const jrow = paper.journal_id ? store.get('SELECT * FROM journals WHERE id = ?', [paper.journal_id]) : null;
  const jinfo = jrow ? require('./journals').eligibilityOf(jrow, getSettings()) : null;
  const tags = jinfo ? jinfo.tags : [];
  const official = paper.eligibility === 'eligible' && paper.eligible_official === 1;

  if (official) {
    return {
      status: 'official', official: true,
      headline: '期刊条件合格（官方目录已核验）',
      detail: jinfo.note,
      tags,
      // 证据来源逐条列出，便于核对
      evidence: tags.filter((t) => t.kind === 'official').map((t) => ({
        catalog: t.catalog, edition: t.edition || null, year: t.year || null,
        basis: t.basis || null, source: t.source || null, text: t.text,
      })),
      caveat: null,
    };
  }

  const isRef = paper.eligibility === 'reference';
  return {
    status: isRef ? 'reference' : 'pending',
    official: false,
    headline: isRef
      ? '参考候选：期刊信息来自非官方参考线索，尚未核验'
      : '待核验：该刊未在已导入的官方目录中匹配到',
    detail: paper.eligibility_note,
    tags,
    evidence: tags.filter((t) => t.reference === true).map((t) => ({
      catalog: t.catalog, edition: t.edition || null, year: t.year || null,
      basis: t.basis || null, source: t.source || null, text: t.text,
      evidenceStatus: t.evidenceStatus || null, sourceUrl: t.sourceUrl || null,
    })),
    caveat: isRef
      ? '参考候选不计入「期刊条件合格」，也不等同于已核验。要成为合格论文，需要导入机构版 JCR/SSCI 或 CSSCI/北大核心目录后重新核验。'
      : '该刊未匹配到任何目录记录，因此无法核实收录与分区；这不表示论文质量有问题，只表示期刊资格待核验。',
  };
}

/**
 * 生成一天的简报。reason: scheduled | catchup | manual | first-run
 */
async function generateBrief({ reason = 'manual', force = false, aiReasons = false } = {}) {
  const s = getSettings();
  const runDate = beijingDate();
  const existing = store.get('SELECT * FROM brief_runs WHERE run_date = ?', [runDate]);
  /*
   * 跳过条件：今天已有**成功**的简报且未强制。
   * status='partial'（例如候选池为空）不算完成，允许重新生成。
   */
  if (existing && existing.status === 'ok' && !force) {
    return {
      ok: true, skipped: true, runId: existing.id, runDate,
      reason: '今天已生成过简报',
      status: existing.status,
    };
  }

  const runId = existing
    ? (store.run(`UPDATE brief_runs SET reason=?, started_at=?, status='running', error=NULL WHERE id=?`,
        [reason, clock.nowIso(), existing.id]), existing.id)
    : (store.run(`INSERT INTO brief_runs(run_date, reason, started_at, status) VALUES(?,?,?,'running')`,
        [runDate, reason, clock.nowIso()]),
       store.get('SELECT id FROM brief_runs WHERE run_date = ?', [runDate]).id);

  const startedAt = clock.nowMs();
  const topics = require('./discover').listTopics(true);
  const topicMap = rank.topicNameMap();

  const all = getCandidates({});
  const decorated = all.map((p) => decorate(p, topicMap, topics));

  // 已在前几次简报出现过的论文（避免重复推送），但允许它留在候选池
  const shownIds = new Set(
    store.all(`SELECT bi.paper_id FROM brief_items bi JOIN brief_runs br ON br.id = bi.run_id
               WHERE br.run_date < ?`, [runDate]).map((r) => r.paper_id));

  const mutedIds = new Set(store.all("SELECT paper_id FROM judgments WHERE decision='muted'").map(r=>r.paper_id));
  const fresh = decorated.filter((d) => !shownIds.has(d.paper.id) && !mutedIds.has(d.paper.id));

  // 区分「今天新发现」与「近期遗漏推荐」：
  // discovery_date 才是工作台发现它的日期；published_online 是论文自己的在线发表日期。
  // 不能把窗口内的旧论文统称为今天的新论文。
  for (const d of fresh) {
    d.kind = (d.paper.discovery_date === runDate) ? 'new' : 'catchup';
    d.catchupReason = d.kind === 'catchup'
      ? `工作台在 ${d.paper.discovery_date} 首次采集到它，此前未推送过；论文在线发表日期为 ${d.paper.published_online || '未标注'}`
      : null;
  }
  const newCount = fresh.filter((d) => d.kind === 'new').length;
  const catchupCount = fresh.length - newCount;
  const { selected, eligible, pending, reference, pool, limit, languageNote, shortfall } = planBrief(fresh, {
    size: s.briefSize, languageBalance: s.languageBalance, topics,
  });
  // 逐篇带上核验状态与证据来源（非官方的一律不得写成「期刊条件合格」）
  for (const item of selected) item.verification = verificationLabel(item.paper);

  // 可选：用 AI 重写推荐理由
  let aiReasonNote = null;
  if (aiReasons) {
    try {
      const interpret = require('./interpret');
      if (interpret.isConfigured()) {
        const r = await interpret.briefReasons(selected.slice(0, limit));
        aiReasonNote = r.ok ? `已用 ${r.model} 生成推荐理由` : `AI 推荐理由生成失败：${r.error}`;
        if (r.ok) for (const [pid, text] of Object.entries(r.reasons)) {
          const item = selected.find((x) => x.paper.id === Number(pid));
          if (item) item.reason = text;
        }
      } else {
        aiReasonNote = '未配置 AI 密钥，推荐理由为规则生成';
      }
    } catch (e) { aiReasonNote = 'AI 推荐理由生成异常：' + e.message; }
  }

  store.tx(() => {
    store.run('DELETE FROM brief_items WHERE run_id = ?', [runId]);
    selected.forEach((item, i) => {
      store.run(`INSERT INTO brief_items(run_id, paper_id, rank, score, reason, dimension_scores, kind, verification) VALUES(?,?,?,?,?,?,?,?)`,
        [runId, item.paper.id, i + 1, item.sort_score ?? item.scored.total, item.reason,
         JSON.stringify(item.scored.dimensions), item.kind || 'new',
         // 存下推荐当时的核验状态：这样以后导入了官方目录，
         // 旧简报也不会被改写成「当时已核验」
         JSON.stringify({
           status: item.verification.status,
           official: item.verification.official,
           headline: item.verification.headline,
           at: store.nowIso(),
           evidence: item.verification.evidence,
         })]);
    });
    const logEntries = [
      { at: clock.nowIso(), msg: `候选 ${all.length} 篇（窗口内）` },
      { at: clock.nowIso(), msg: `主题相关候选池 ${pool.length} 篇；其中官方目录合格 ${eligible.length} 篇、参考候选 ${reference.length} 篇、待核验 ${pending.length} 篇` },
      { at: clock.nowIso(), msg: `今天首次发现 ${newCount} 篇；近期发现且尚未推荐 ${catchupCount} 篇` },
      { at: clock.nowIso(), msg: `本日精选 ${selected.length} 篇；其中官方核验合格 ${selected.filter((x) => x.verification.official).length} 篇、参考候选 ${selected.filter((x) => x.verification.status === 'reference').length} 篇、待核验 ${selected.filter((x) => x.verification.status === 'pending').length} 篇` },
      { at: clock.nowIso(), msg: `排除已推送 ${decorated.length - fresh.length} 篇，可推送 ${fresh.length} 篇` },
      { at: clock.nowIso(), msg: `本日精选 ${selected.length} 篇（上限 ${limit}）` },
      // 默认只收中英文：把语言分布与不足如实写进运行日志，便于事后核对
      { at: clock.nowIso(), msg: `默认入选范围=中英文；入选 ${selected.length} 篇（中文 ${selected.filter((x) => N.isChineseLang(x.paper.language)).length}、英文 ${selected.filter((x) => N.isEnglishLang(x.paper.language)).length}）` },
      languageNote ? { at: clock.nowIso(), msg: languageNote } : null,
      aiReasonNote ? { at: new Date().toISOString(), msg: aiReasonNote } : null,
    ].filter(Boolean);
    /*
     * 运行状态只表达「采集与简报流程是否成功」。
     *
     * 早期写法是 eligible.length === 0 ? 'partial' : 'ok'，把「官方目录合格数为 0」
     * 当成了失败——于是今天明明生成了 8 篇有效的主题精选，却记成 partial。
     * 资格数量是单独的统计维度，不该决定运行状态。
     *   ok      生成了可用的简报（哪怕官方合格为 0、哪怕当天没有新论文）
     *   partial 简报生成了但存在问题（例如候选池为空）
     */
    const runStatus = selected.length > 0 ? 'ok' : (all.length > 0 ? 'partial' : 'partial');
    store.run(`UPDATE brief_runs SET finished_at=?, status=?, candidate_count=?, eligible_count=?, selected_count=?, log=? WHERE id=?`,
      [clock.nowIso(), runStatus, all.length, eligible.length, selected.length,
       JSON.stringify(logEntries), runId]);
  });

  const selOfficial = selected.filter((x) => x.verification.official).length;
  return {
    ok: true, runId, runDate, reason,
    candidates: all.length,
    topicPool: pool.length,
    eligible: eligible.length,
    referenceOnly: reference.length,
    pending: pending.length,
    selected: selected.length, limit,
    // 精选内部按核验状态拆分，避免把参考候选算成合格
    selectedOfficial: selOfficial,
    selectedReference: selected.filter((x) => x.verification.status === 'reference').length,
    selectedPending: selected.filter((x) => x.verification.status === 'pending').length,
    newlyDiscovered: newCount,
    catchupRecommended: catchupCount,
    // 不足 5 篇才算真的不足；官方合格为 0 不再是「不足」
    insufficient: selected.length < Math.max(5, Math.min(100, s.briefSize || 50)),
    elapsedMs: clock.nowMs() - startedAt,
    aiReasonNote,
  };
}

/** 读取某天（默认最近一次）简报的完整内容 */
function getBrief(runDate) {
  const run = runDate
    ? store.get('SELECT * FROM brief_runs WHERE run_date = ?', [runDate])
    : store.get('SELECT * FROM brief_runs ORDER BY run_date DESC LIMIT 1');
  if (!run) return null;

  const items = store.all(
    `SELECT bi.rank, bi.score, bi.reason, bi.dimension_scores, bi.kind, bi.verification, p.*
       FROM brief_items bi JOIN papers p ON p.id = bi.paper_id
      WHERE bi.run_id = ? ORDER BY bi.rank`, [run.id]);

  const topics = require('./discover').listTopics(false);
  const topicMap = rank.topicNameMap();
  const jmod = require('./journals');

  const detail = items.map((row) => {
    const paper = row;
    const jrow = paper.journal_id ? store.get('SELECT * FROM journals WHERE id = ?', [paper.journal_id]) : null;
    const jinfo = jrow ? jmod.eligibilityOf(jrow, getSettings()) : { tags: [], note: '期刊未匹配', status: 'pending' };
    const lib = store.get('SELECT * FROM library WHERE paper_id = ?', [paper.id]);
    return {
      id: paper.id,
      rank: row.rank,
      score: row.score,
      reason: row.reason,
      kind: row.kind || 'new',
      dimensions: store.parseJson(row.dimension_scores, {}),
      title: paper.title,
      title_zh: paper.title_zh,
      authors: store.parseJson(paper.authors, []),
      journal_name: paper.journal_name,
      language: paper.language,
      abstract: paper.abstract,
      doi: paper.doi_norm,
      url: paper.url,
      pdf_url: paper.pdf_url,
      open_access: Boolean(paper.open_access),
      oa_status: paper.oa_status,
      citation_count: paper.citation_count,
      published_online: paper.published_online,
      published_print: paper.published_print,
      issued_date: paper.issued_date,
      discovery_date: paper.discovery_date,
      // 卡片上唯一的可信发表时间（含精度），与今日发现口径一致
      pub: N.bestPubDate(paper),
      volume: N.cleanPlaceholder(paper.volume), issue: N.cleanPlaceholder(paper.issue),
      pages: N.cleanPlaceholder(paper.pages),
      keywords: store.parseJson(paper.keywords, []),
      keywords_source: paper.keywords_source || null,
      sources: (paper.sources || '').split(',').filter(Boolean),
      topics: store.parseJson(paper.topics, []).map((s) => ({ slug: s, name: topicMap[s] || s })),
      eligibility: paper.eligibility,
      eligibility_basis: paper.eligibility_basis || null,
      eligible_official: paper.eligible_official === 1,
      eligibility_note: paper.eligibility_note,
      journal_tags: jinfo.tags,
      // 推荐当时的核验状态快照（不是当前状态），避免旧简报被误读为已核验
      verificationSnapshot: store.parseJson(row.verification, null),
      verification: (() => {
        const snap = store.parseJson(row.verification, null);
        const nowOfficial = paper.eligibility === 'eligible' && paper.eligible_official === 1;
        return {
          atRecommendation: snap ? snap.status : (nowOfficial ? 'official' : (paper.eligibility === 'reference' ? 'reference' : 'pending')),
          official: snap ? Boolean(snap.official) : nowOfficial,
          headline: snap ? snap.headline : (nowOfficial ? '期刊条件合格（官方目录已核验）' : '尚未核验'),
          changedSince: snap ? Boolean(snap.official) !== nowOfficial : false,
        };
      })(),
      starred: Boolean(lib?.starred),
      read_state: lib?.read_state || 'none',
      judgment: (() => {
        const j = store.get('SELECT decision FROM judgments WHERE paper_id = ?', [paper.id]);
        return j ? j.decision : null;
      })(),
    };
  });

  // 全部合格候选（可展开查看），排除已在精选里的
  const selectedIds = new Set(items.map((i) => i.id));
  // 给精选条目挂上已缓存的篇关摘译文（不调用模型；缺的由前端分批懒加载）
  try {
    const bundles = require('./translate').bundlesFor(detail.map((d) => d.id));
    for (const d of detail) {
      const b = bundles.get(d.id);
      d.translations = b ? b.fields : null;
      d.translationTargetLang = b ? b.targetLang : null;
      d.aiConfigured = b ? Boolean(b.aiConfigured) : false;
    }
  } catch { /* 翻译模块异常不影响简报本身 */ }
  const candidates = getCandidates({})
    .filter((p) => p.eligibility === 'eligible' && p.eligible_official === 1 && !selectedIds.has(p.id))
    .map((p) => {
      const sc = rank.scorePaper(p, topics);
      const jr = p.journal_id ? store.get('SELECT * FROM journals WHERE id = ?', [p.journal_id]) : null;
      const ji = jr ? jmod.eligibilityOf(jr, getSettings()) : null;
      return {
        id: p.id, title: p.title, journal_name: p.journal_name, language: p.language,
        published_online: p.published_online, doi: p.doi_norm, score: sc.total,
        open_access: Boolean(p.open_access),
        journal_tags: ji ? ji.tags : [],
        eligibility_basis: p.eligibility_basis || null,
      };
    })
    .sort((a, b) => b.score - a.score);

  // 参考候选（来自非官方参考名录）：单独一组，明确不计入合格
  const referenceCandidates = getCandidates({})
    .filter((p) => p.eligibility === 'reference')
    .map((p) => {
      const jrow = p.journal_id ? store.get('SELECT * FROM journals WHERE id = ?', [p.journal_id]) : null;
      const info = jrow ? jmod.eligibilityOf(jrow, getSettings()) : null;
      return {
        id: p.id, title: p.title, journal_name: p.journal_name, issn: p.issn,
        language: p.language, published_online: p.published_online, doi: p.doi_norm,
        reason: p.eligibility_note,
        journal_tags: info ? info.tags.filter((t) => t.reference) : [],
      };
    });

  const pendingCandidates = getCandidates({})
    .filter((p) => p.eligibility === 'pending')
    .map((p) => {
      const jrow = p.journal_id ? store.get('SELECT * FROM journals WHERE id = ?', [p.journal_id]) : null;
      return {
        id: p.id, title: p.title, journal_name: p.journal_name, issn: p.issn,
        language: p.language, published_online: p.published_online, doi: p.doi_norm,
        reason: p.eligibility_note,
        journal_verified: jrow ? jrow.verified === 1 : false,
      };
    });

  // 语言覆盖诊断：只有一种语言出现合格论文时，明确告知原因，而不是假装平衡
  const eligibleLangCount = store.all(
    `SELECT language, COUNT(*) c FROM papers WHERE eligibility = 'eligible'
      AND COALESCE(published_online, issued_date, discovery_date) >= ?
      GROUP BY language`, [candidateWindow(45)]);
  const sumOf = (pred) => eligibleLangCount.filter(pred).reduce((a, r) => a + r.c, 0);
  const zhEligible = sumOf((r) => N.isChineseLang(r.language));
  // 英文只能是**明确判定为英文**的；other / unknown 单列，不算进英文
  const enEligible = sumOf((r) => N.isEnglishLang(r.language));
  const otherEligible = sumOf((r) => !N.isChineseLang(r.language) && !N.isEnglishLang(r.language));
  const zhPending = store.get(
    `SELECT COUNT(*) c FROM papers WHERE language = 'zh' AND eligibility = 'pending'
      AND COALESCE(published_online, issued_date, discovery_date) >= ?`, [candidateWindow(45)]).c;
  /*
   * 语言诊断。
   *
   * 注意：这里是 getBrief（读取已生成的简报），拿不到 planBrief 的 selected/pool，
   * 所以「默认只收中英文」的入选数与不足篇数从 brief_items 实际记录里算——
   * 这也更可信：它反映的是**真的存下来的**那次简报，而不是重新推演的结果。
   */
  const selectedRows = store.all(
    `SELECT p.language FROM brief_items bi JOIN papers p ON p.id = bi.paper_id WHERE bi.run_id = ?`,
    [run.id]);
  const selectedByLanguage = {
    zh: selectedRows.filter((r) => N.isChineseLang(r.language)).length,
    en: selectedRows.filter((r) => N.isEnglishLang(r.language)).length,
    other: selectedRows.filter((r) => !N.isChineseLang(r.language) && !N.isEnglishLang(r.language)).length,
  };
  const requestedSize = getSettings().briefSize || 8;
  const selectedCount = selectedRows.length;
  const shortfall = Math.max(0, requestedSize - selectedCount);
  const languageDiagnosis = {
    // 默认入选范围：已判定为中文或英文
    defaultScope: 'zh-en',
    selectedCount, requestedSize, shortfall,
    selectedByLanguage,
    note: languageDiagnosisNote({ zhEligible, enEligible, zhPending, selectedCount, limit: requestedSize }),
    zhEligible, enEligible, otherEligible, zhPending,
    balanced: zhEligible > 0 && enEligible > 0,
  };

  return {
    languageDiagnosis,
    referenceCandidates,
    run: {
      id: run.id, runDate: run.run_date, reason: run.reason,
      status: run.status, startedAt: run.started_at, finishedAt: run.finished_at,
      candidateCount: run.candidate_count, eligibleCount: run.eligible_count,
      selectedCount: run.selected_count,
      log: store.parseJson(run.log, []),
    },
    items: detail,
    allEligibleCandidates: candidates,
    pendingCandidates,
    topics,
    generatedAt: beijingDate(),
  };
}

function listRuns(limit = 30) {
  return store.all('SELECT * FROM brief_runs ORDER BY run_date DESC LIMIT ?', [limit]).map((r) => ({
    id: r.id, runDate: r.run_date, reason: r.reason, status: r.status,
    candidateCount: r.candidate_count, eligibleCount: r.eligible_count,
    selectedCount: r.selected_count, startedAt: r.started_at, finishedAt: r.finished_at,
  }));
}

module.exports = { generateBrief, getBrief, listRuns, beijingDate, getCandidates };
