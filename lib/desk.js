'use strict';
/**
 * 今日发现（Reading Desk 首页）。
 *
 * 设计目标（对应「重做每日首页的阅读流程」）：
 *  1. 打开工作台第一眼看到的就是「值得读的论文列表」，而不是统计数字；
 *  2. 先按研究主题发现并排序，再让期刊等级成为筛选条件（而不是排序的全部依据）；
 *  3. 即使当天没有任何「官方核验合格」论文，也照常展示主题相关的参考候选与待核验论文，
 *     并明确标注状态——它们绝不会被算进「期刊条件合格精选」；
 *  4. 区分「今天首次发现」与「近期发现但尚未推荐」，显示真实数量；
 *  5. 默认只返回一页，避免一次渲染上千条。
 *
 * 排序思路参考 arxiv-sanity-lite 的「先按用户研究方向发现、再由用户自己判断」：
 * 这里只用可解释的主题相关度 + 新近度，不因为几次点击偷偷改变排序。
 */
const store = require('./store');
const N = require('./normalize');
const rank = require('./rank');
const judgments = require('./judgments');
const { getSettings } = require('./config');
const reader = require('./reader');
const categories = require('./categories');

/* ----------------------------- 主题相关度 ----------------------------- */

function topicList() {
  return require('./discover').listTopics(true);
}

function annotate(paper, topics, topicMap) {
  const scored = rank.scorePaper(paper, topics);
  const hits = scored.detail.topicHits || {};
  // 只保留有实际证据的主题，作为「为什么它出现在这里」的可核查理由
  const evidence = Object.entries(hits)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([slug, v]) => ({ slug, name: topicMap[slug] || slug, score: v }));

  /*
   * 跨领域命中：主题的标志词命中了，但缺少语言教育领域证据。
   * 这类论文的教育技术分数会被压到 0（否则它会冒充核心推荐），
   * 所以必须单独记下来，否则它就「消失」了 —— 而它应该被保留、
   * 明确标记为跨领域方法参考，并排在核心推荐之后。
   */
  const cdMap = scored.detail.crossDomain || {};
  const cdReason = scored.detail.crossDomainReason || {};
  const crossEvidence = Object.keys(cdMap).map((slug) => ({
    slug, name: topicMap[slug] || slug, reason: cdReason[slug] || null,
  }));
  const jcr = paper.journal_id ? store.get('SELECT * FROM journals WHERE id = ?', [paper.journal_id]) : null;
  const jinfo = jcr ? require('./journals').eligibilityOf(jcr, getSettings()) : { tags: [], status: 'pending', basis: 'pending' };

  /*
   * 跨领域方法参考：命中了主题、但缺少本领域（语言教育）证据的论文。
   * 实测例子：「职业教育的 AI 转型」「医学生的技术增强学习」
   * 会命中教育技术的标志词，却与语言教育无关。
   * 它们不被丢弃（方法层面可能仍有参考价值），而是单独成组、明确标记、排在核心推荐之后。
   */
  // 全篇跨领域 = 没有任何有效核心主题证据、但有跨领域方法命中
  // （见 rank.isPaperCrossDomain）。逐主题的 crossEvidence 只用于展示
  // 「哪个主题不成立」，不能拿它给整篇论文降级——否则一篇真正的二语习得研究
  // 仅因元数据提到 Mandarin 在「汉语语言学」上被判跨领域，就会被整篇踢出核心。
  const crossDomain = scored.detail.isCrossDomain === true;

  return {
    scored,
    topicsEvidence: evidence,
    crossEvidence,
    crossDomain,
    crossDomainTopics: crossEvidence.map((x) => x.name),
    crossDomainReason: crossEvidence[0]?.reason || null,
    journalTags: jinfo.tags,
    journalStatus: jinfo.status,
    journalBasis: jinfo.basis,
  };
}

function rowToCard(paper, ann, judgment) {
  return {
    id: paper.id,
    title: paper.title,
    title_zh: paper.title_zh,
    authors: store.parseJson(paper.authors, []),
    journal_name: paper.journal_name,
    journal_issn: paper.issn,
    language: paper.language,
    abstract: paper.abstract,
    abstract_length: (paper.abstract || '').length,
    doi: paper.doi_norm,
    url: paper.url,
    pdf_url: paper.pdf_url,
    open_access: Boolean(paper.open_access),
    oa_status: paper.oa_status,
    citation_count: paper.citation_count,
    // 三个日期分开：论文自己的在线/出版日期，与工作台发现它的日期
    published_online: paper.published_online,
    published_print: paper.published_print,
    issued_date: paper.issued_date,
    discovery_date: paper.discovery_date,
    /*
     * 卡片上**唯一**要显示的发表时间。
     * 由 normalize.bestPubDate 选出：完整在线发表日 > 正式出版 > 只有年月的在线日 > issued。
     * 精度随值一起返回（year / month / day），前端按实际精度显示，绝不补出「1 月 1 日」。
     * discovery_date（工作台发现日）永远不出现在这里。
     */
    pub: N.bestPubDate(paper),
    // 卷/期/页在出口再清洗一次：库里可能留着历史占位符（如 "None-None"）
    volume: N.cleanPlaceholder(paper.volume), issue: N.cleanPlaceholder(paper.issue),
    pages: N.cleanPlaceholder(paper.pages),
    keywords: store.parseJson(paper.keywords, []),
    keywords_source: paper.keywords_source || null,
    evidence_scope_available: paper.abstract ? 'abstract' : 'metadata',
    sources: (paper.sources || '').split(',').filter(Boolean),
    source_queries: store.parseJson(paper.source_queries, []),
    // 主题证据（可解释，不是黑箱）
    topic_evidence: ann.topicsEvidence,
    // 跨领域方法参考标记
    cross_domain: ann.crossDomain,
    cross_domain_topics: ann.crossDomainTopics,
    cross_domain_reason: ann.crossDomainReason,
    cross_domain_evidence: ann.crossEvidence,
    topic_score: ann.scored.dimensions.topic,
    method_signals: ann.scored.detail.designs,
    score: ann.scored.total,
    dimensions: ann.scored.dimensions,
    // 期刊等级 / 资格
    eligibility: paper.eligibility,
    eligibility_basis: paper.eligibility_basis || null,
    eligible_official: paper.eligible_official === 1,
    eligibility_note: paper.eligibility_note,
    journal_tags: ann.journalTags,
    // 阅读判断
    judgment: judgment ? judgment.decision : null,
    judgment_label: judgment ? judgment.label : null,
    judgment_note: judgment ? judgment.note : null,
    starred: Boolean(store.get('SELECT starred FROM library WHERE paper_id = ?', [paper.id])?.starred),
    read_state: store.get('SELECT read_state FROM library WHERE paper_id = ?', [paper.id])?.read_state || 'none',
    has_interpretation: store.get('SELECT COUNT(*) c FROM interpretations WHERE paper_id = ?', [paper.id]).c > 0,
  };
}

/**
 * 给一批卡片挂上**已缓存**的篇关摘译文（不调用模型）。
 *
 * 卡片要「首页直接看到译文」，但绝不能因此打开首页就翻译上千篇。
 * 所以：先把库里已有的译文（缓存命中）一次性带上，
 * 缺译文的部分由前端按可见范围分批懒加载（/api/translate/batch）。
 */
function attachTranslations(cards) {
  if (!cards.length) return cards;
  let bundles;
  try {
    bundles = require('./translate').bundlesFor(cards.map((c) => c.id));
  } catch (e) {
    return cards;   // 翻译模块异常不应影响阅读列表本身
  }
  for (const c of cards) {
    const b = bundles.get(c.id);
    c.translations = b ? b.fields : null;
    c.translationTargetLang = b ? b.targetLang : null;
    c.aiConfigured = b ? Boolean(b.aiConfigured) : false;
  }
  return cards;
}

/* ----------------------------- 期刊等级筛选 ----------------------------- */

const JOURNAL_FILTERS = {
  all: { label: '全部（含待核验）', test: () => true },
  official: { label: '仅官方目录合格', test: (p) => p.eligibility === 'eligible' && p.eligible_official === 1 },
  reference: { label: '仅参考候选', test: (p) => p.eligibility === 'reference' },
  pending: { label: '仅待核验', test: (p) => p.eligibility === 'pending' },
  unverified: { label: '参考候选 + 待核验', test: (p) => p.eligibility !== 'eligible' },
  open_access: { label: '有开放获取', test: (p) => Boolean(p.open_access) },
};

/* ----------------------------- 今日发现 ----------------------------- */

function discoveryWindowDays() {
  const s = getSettings();
  return Math.max(s.briefLookbackDays || 30, 30);
}

/**
 * 今日发现列表。
 * @param {{page?:number, pageSize?:number, journalFilter?:string, language?:string,
 *          topic?:string, q?:string, includeMuted?:boolean, days?:number}} opts
 */
// 只缓存昂贵的主题判定；收藏、浏览、译文仍每次读取当前状态。
const discoveryAnnotations = { context:null, papers:new Map() };
function cachedDiscoveryAnnotation(p,topics,topicMap) {
  const key=JSON.stringify(p);const old=discoveryAnnotations.papers.get(p.id);
  if(old?.key===key)return old.value;
  const value=annotate(p,topics,topicMap);
  if(discoveryAnnotations.papers.size>=12000)discoveryAnnotations.papers.delete(discoveryAnnotations.papers.keys().next().value);
  discoveryAnnotations.papers.set(p.id,{key,value});return value;
}
function listDiscovery(opts = {}) {
  const s = getSettings();
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(Math.max(1, Number(opts.pageSize) || 50), 100);
  const filterKey = JOURNAL_FILTERS[opts.journalFilter] ? opts.journalFilter : 'all';
  const days = Number(opts.days) || discoveryWindowDays();

  /*
   * 语言范围。
   *
   * 需求：**每天优先阅读中英文论文**，所以默认视图只含已判定为中文/英文的论文；
   * 其他语种与「语种待确认」不删除、不丢弃，只是不占默认视图，
   * 通过显式的语言筛选（印尼语 / 其他语种 / 语种待确认）或「全部语种」查看。
   *
   * 约定：
   *   · 显式选了某个 language ⇒ 就按它筛（此时 languageScope 自动视为 all）；
   *   · 否则 languageScope 默认 'zh-en'；显式传 'all' 才展示全部语种；
   *   · 绝不用「不是中文就算英文」这类写法——只认 language === 'en'。
   */
  const explicitLang = opts.language ? String(opts.language) : '';
  const scope = opts.languageScope === 'all' || explicitLang ? 'all' : 'zh-en';

  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const today = require('./brief').beijingDate();

  /*
   * 已推荐过的论文（出现在任何一次简报里）。
   *
   * 关键：这个集合必须参与「今天首次发现 / 近期发现且未推荐 / 已进过简报」的分类，
   * 而不只是给卡片打一个 fresh 标记。早期版本只用它算 fresh，
   * 于是 8 篇已经进过简报的论文也被算成「近期发现但尚未推荐」，
   * 页面数字与卡片标签互相矛盾。
   *
   * 同时必须用 discovery_date（工作台发现它的日期）而不是 published_online（论文发表日期）——
   * 两者含义不同，窗口内的论文可能是几个月前发表的。
   */
  const shownIds = new Set(
    store.all(`SELECT bi.paper_id FROM brief_items bi JOIN brief_runs br ON br.id = bi.run_id`)
      .map((r) => r.paper_id));
  // 已有判断的论文（默认排除「暂不关注」）
  const judged = new Map(
    store.all('SELECT paper_id, decision FROM judgments').map((r) => [r.paper_id, r.decision]));
  const mutedIds = new Set([...judged.entries()].filter(([, d]) => d === 'muted').map(([id]) => id));

  // 候选池：窗口内被发现、且不是「明确排除」的论文
  const rows = store.all(
    `SELECT * FROM papers
      WHERE COALESCE(discovery_date, published_online, issued_date) >= ?
        AND eligibility <> 'excluded'
      ORDER BY COALESCE(published_online, issued_date, discovery_date) DESC`, [from]);

  const topics = topicList();
  const topicMap = rank.topicNameMap();
  const context=JSON.stringify([topics,s,store.all('SELECT * FROM journals'),today]);
  if(context!==discoveryAnnotations.context){discoveryAnnotations.context=context;discoveryAnnotations.papers.clear();}
  const filter = JOURNAL_FILTERS[filterKey].test;

  const search = (opts.q || '').trim().toLowerCase();
  const cards = [];
  const readingStates = reader.states();
  let newCount = 0, catchupCount = 0, mutedExcluded = 0, alreadyShownCount = 0;
  /*
   * 语言分布：统计**全部主题相关论文**（不受默认视图范围限制）。
   * 目的是让页面能如实告诉用户「另有 N 篇非中英文，可通过筛选查看」，
   * 而不是让它们悄悄消失。
   */
  const langAll = { zh: 0, en: 0, id: 0, other: 0, unknown: 0 };
  // 不分语种的主题相关候选总数，以及其中非中英文的篇数。
  // 页面要直接显示「中英文主题候选 N · 另有 M 篇其他语种/待确认」，
  // 这两个数都必须来自本次实际统计，不能写死。
  let allTopicRelevant = 0;
  let outsideDefaultScope = 0;

  for (const p of rows) {
    if (!opts.includeMuted && mutedIds.has(p.id)) { mutedExcluded++; continue; }
    if (!filter(p)) continue;
    if (search) {
      const hay = [p.title, p.abstract, p.journal_name, store.parseJson(p.keywords, []).join(' ')].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) continue;
    }
    const ann = cachedDiscoveryAnnotation(p, topics, topicMap);
    const categoryIds = categories.ids(p, ann.scored.detail.topicHits);
    if (opts.category && !categoryIds.includes(opts.category)) continue;
    const reading = readingStates[p.id] || {};
    if (opts.browse === 'unseen' && reading.browsedAt) continue;
    if (opts.browse === 'seen' && !reading.browsedAt) continue;
    if (opts.since && require('./time').toIsoUtc(p.created_at) <= opts.since) continue;
    // 主题筛选：只保留有该主题证据的论文
    if (opts.topic
      && !ann.topicsEvidence.some((e) => e.slug === opts.topic)
      && !ann.crossEvidence.some((e) => e.slug === opts.topic)) continue;
    /*
     * 纳入规则：
     *   有至少一个有效主题证据 ⇒ 核心推荐（即使某个主题被判跨领域也没关系）；
     *   完全没有任何有效主题、但有跨领域方法命中 ⇒ 作为跨领域方法参考保留在列表末尾。
     */
    if (!ann.topicsEvidence.length && !ann.crossEvidence.length) continue;

    /*
     * 先统计语种分布，再决定是否纳入本页。
     *
     * 顺序很重要：统计必须在语言范围过滤**之前**做，否则默认视图下
     * 其他语种既不出现在页面上、也不出现在计数里，页面就无法告诉用户
     * 「另有 N 篇可通过筛选查看」——它们会变成真正意义上的消失。
     */
    {
      const L = p.language || 'unknown';
      langAll[L] = (langAll[L] || 0) + 1;
      allTopicRelevant++;   // 全部主题相关候选（不分语种），用于页面直接显示对比
      // 这个数只描述「默认中英文视图」排除了多少，不随当前筛选变化——
      // 否则切到「印尼语」时它会变成 5，页面上的说明就自相矛盾了。
      if (!N.isChineseLang(L) && !N.isEnglishLang(L)) outsideDefaultScope++;
    }

    // 语言范围过滤
    if (explicitLang) {
      // 显式语言筛选：精确匹配（选「英文」时 unknown / other 一律不进来）
      if ((p.language || 'unknown') !== explicitLang) continue;
    } else if (scope === 'zh-en') {
      // 默认视图：只含已判定的中文与英文
      if (!N.isChineseLang(p.language) && !N.isEnglishLang(p.language)) continue;
    }

    /*
     * 三态分类，语义与页面文字严格对应：
     *   new        今天首次发现              discovery_date === 今天
     *   catchup    近期发现且尚未推荐        非今天发现，且从未出现在任何简报里
     *   shown      已进过简报                非今天发现，但已经在某次简报里推荐过
     * 三者互斥且完备，计数之和 == 主题候选总数（total）。
     */
    const kind = p.discovery_date === today
      ? 'new'
      : (shownIds.has(p.id) ? 'shown' : 'catchup');
    if (kind === 'new') newCount++;
    else if (kind === 'catchup') catchupCount++;
    else alreadyShownCount++;
    cards.push({ ...rowToCard(p, ann, judged.has(p.id) ? { decision: judged.get(p.id), label: judgments.DECISIONS[judged.get(p.id)]?.label } : null), kind,
      category_ids: categoryIds, browsed_at: reading.browsedAt || null, project_tags: reading.tags || [] });
  }

  /*
   * 排序 = 主题相关度为主 + 新近度为辅，并让「今天新发现」优先。
   * 刻意不把期刊等级放进排序权重：等级是筛选条件，不该决定你先看到什么。
   * 也不用任何点击行为做个性化——排序依据在这里完全可解释。
   *
   * 新近度只能用**可信的发表时间**，并且要按精度打折：
   *   · 完整在线发表日（day）   → 按真实天数；
   *   · 只有年月（month）        → 打折，因为我们不知道具体哪一天；
   *   · 只有年（year）           → 明显打折，绝不冒充「刚上线」；
   *   · 完全没有发表时间          → 最低档。
   * 早期写法用 published_online || issued_date || **discovery_date** 兜底，
   * 于是「工作台今天刚采到的一篇 2026 年只有年份的中文题录」会被算成刚发表，
   * 在排序里压过真正的新论文。discovery_date 不是发表日期，不能参与新近度。
   */
  const freshnessOf = (c) => {
    const ms = c.pub && Number.isFinite(c.pub.ms) ? c.pub.ms : null;
    if (ms == null) return 0.15;
    const days = Math.max(0, (Date.now() - ms) / 86400000);
    let base;
    if (days <= 3) base = 1;            // 刚上线
    else if (days <= 10) base = 0.85;
    else if (days <= 30) base = 0.65;
    else if (days <= 60) base = 0.4;
    else if (days <= 120) base = 0.2;
    else base = 0.05;
    const precision = c.pub?.precision;
    const penalty = precision === 'day' ? 1 : (precision === 'month' ? 0.85 : 0.6);
    return base * penalty;
  };
  for (const c of cards) {
    // 有摘要的论文先能被读懂（也能先做有依据的解读），给一点优先
    c.sort_score = Number((
      c.topic_score * 0.55
      + freshnessOf(c) * 0.33
      + (c.abstract ? 0.07 : 0)
      + (c.kind === 'new' ? 0.05 : 0)
    ).toFixed(4));
  }
  /*
   * 排序分两段：核心推荐优先，跨领域方法参考整体排在后面。
   * 这样「职业技术教育的 AI 转型」不会挤在「VR 支持二语语用教学」前面，
   * 但它仍然可以被找到（不是删除）。
   * 注意：期刊等级不参与排序——等级是筛选条件。
   */
  cards.sort((a, b) => {
    if (a.cross_domain !== b.cross_domain) return a.cross_domain ? 1 : -1;
    if (Boolean(a.browsed_at) !== Boolean(b.browsed_at)) return a.browsed_at ? 1 : -1;
    if ((a.kind === 'new') !== (b.kind === 'new')) return a.kind === 'new' ? -1 : 1;
    if ((a.kind === 'shown') !== (b.kind === 'shown')) return a.kind === 'shown' ? 1 : -1;
    // 并列时按可信发表时间排序（不是 discovery_date），精度不足的排在后面
    return (b.sort_score - a.sort_score)
      || ((b.pub?.ms || 0) - (a.pub?.ms || 0));
  });

  const coreCount = cards.filter((c) => !c.cross_domain).length;
  const crossCount = cards.length - coreCount;

  const total = cards.length;
  const categoryCounts = categories.CATEGORIES.filter(c=>c.visible!==false).map(c => ({...c,
    total: cards.filter(p => p.category_ids.includes(c.id)).length,
    new: cards.filter(p => p.category_ids.includes(c.id) && p.kind==='new').length }));
  const start = (page - 1) * pageSize;
  // fresh 与 kind='shown' 是同一件事的两种表达，保持完全一致，避免两处口径打架
  const pageItems = attachTranslations(cards.slice(start, start + pageSize)).map((c) => ({
    ...c,
    fresh: c.kind !== 'shown',
  }));

  // 按主题统计，便于首页展示「发现分布」
  const byTopic = {};
  for (const c of cards) {
    for (const e of c.topic_evidence) byTopic[e.slug] = (byTopic[e.slug] || 0) + 1;
  }
  // 跨领域命中单列，避免与核心主题证据混淆
  const byTopicCrossDomain = {};
  for (const c of cards) {
    for (const e of c.cross_domain_evidence || []) byTopicCrossDomain[e.slug] = (byTopicCrossDomain[e.slug] || 0) + 1;
  }

  return {
    ok: true,
    page, pageSize, total,
    categories: categoryCounts,
    hasMore: start + pageSize < total,
    windowDays: days,
    windowFrom: from,
    languageScope: scope,
    journalFilter: filterKey,
    journalFilters: Object.entries(JOURNAL_FILTERS).map(([k, v]) => ({ key: k, label: v.label })),
    counts: {
      // 三态计数：new + catchup + shown === total
      new: newCount,
      catchup: catchupCount,
      shown: alreadyShownCount,
      mutedExcluded,
      core: coreCount,
      crossDomain: crossCount,
      byTopic,
      byTopicCrossDomain,
      // 语义说明随接口一起返回，前端文案直接引用，避免两边各写一套导致不一致
      labels: {
        new: '今天首次发现',
        catchup: '近期发现且尚未推荐',
        shown: '已进过简报',
        // 「total」是**主题候选**，不是「可读」：
        // 其中很多只有题录或摘要，并不等于能读到全文。
        total: '主题候选',
        core: '主题核心',
        crossDomain: '跨领域参考',
      },
      // 「主题核心」是主题匹配概念，与「北大核心」这种期刊等级**无关**，
      // 必须在界面上写清楚，否则会被误读成 509 篇期刊等级合格。
      // 这些文案会经 esc() 原样显示在页面上，不能带 Markdown 的 ** 标记
      coreNote: '「主题核心」指命中了本工作台研究主题、且带有本领域（语言教育/应用语言学等）证据的论文，'
        + '是主题匹配结果，与「北大核心」期刊等级无关。',
      basis: `窗口 ${days} 天、按 discovery_date（工作台首次采集到它的日期，不是 published_online 论文发表日期）统计。`
        + '这些是主题相关候选，不等于已确认可读全文：多数只有题录与摘要，'
        + '是否存在全文需要进入详情页查看或自行获取。',
      // 默认视图口径：每天优先读中英文，其他语种不删除、可显式查看
      scope,
      scopeNote: scope === 'zh-en'
        ? '默认只显示已判定为中文或英文的论文（你的每日优先阅读范围）。'
          + '其他语种与「语种待确认」不会被删除或丢弃，把上面的「语言」筛选切到'
          + '「印尼语」「其他语种」「语种待确认」，或切到「全部」即可查看。'
        : (explicitLang
          ? `当前按语言筛选：${explicitLang}。要回到默认的中英文视图，把「语言」切回「中文+英文（默认）」。`
          : '当前显示**全部语种**（含其他语种与语种待确认）。'),
      // 各语种候选数（不受当前视图范围限制），供页面说明「另有 N 篇」
      byLanguage: langAll,
      /*
       * 下面两个数是页面统计条直接要显示的，语义必须写死清楚：
       *   scopedTotal       本次视图范围内的主题候选数（默认范围时 = 中英文篇数）
       *   allLanguagesTotal 不分语种的主题相关候选总数
       *   outsideDefaultScope = allLanguagesTotal - scopedTotal
       * 它们都来自本次实际统计，页面不得写死任何篇数。
       */
      // 默认范围/全部语种下的范围内篇数；显式单语种筛选时它就是该语种篇数
      scopedTotal: total,
      allLanguagesTotal: allTopicRelevant,
      outsideDefaultScope,
      scopeLabel: scope === 'zh-en' ? '中英文主题候选' : (explicitLang ? '所选语种主题候选' : '全部语种主题候选'),
      outsideLabel: '其他语种/待确认',
      /*
       * 统计条右侧那条提示的措辞。
       *
       * 三个状态不能用同一句话，否则会读成「总数 + 另有的」：
       *   default 默认中英文视图：其他语种**不在** 740 里 ⇒ 「另有 5 篇…」+ 查看全部语种
       *   all     全部语种视图：其他语种**已包含在** 745 里 ⇒ 「其中 5 篇…（已包含在 745 篇内）」
       *   single  单语种视图：更不能用「另有」⇒ 「全库 745 篇主题候选中的 5 篇」
       * 这样任何视图下都不会出现「总数 + 另有」的加法错觉。
       */
      outsideHint: (() => {
        const n = outsideDefaultScope;
        if (!n) return null;
        const label = '其他语种/待确认';
        if (scope === 'zh-en') {
          return { variant: 'default', count: n, label, text: `另有 ${n} 篇${label}`, showAll: true };
        }
        if (explicitLang) {
          /*
           * 单语种视图：**不要在这里报任何数字**。
           *
           * 旧文案是「占全库 751 篇主题候选中的 5 篇」，两处口径打架：
           * 751 是全语种候选数，而 5 是「非中英文」篇数，在「仅中文」下
           * （实际 83 篇）读者会以为 5 是中文的一部分。
           * 而这个 5 说的是「其他语种/待确认」，与当前所选语种无关，
           * 放在这里只会继续制造混乱——只给出口径与入口，不给数字。
           */
          return { variant: 'single', count: null, label,
            text: '本视图只含所选语种；其他语种与「语种待确认」不在其中', showAll: true };
        }
        return { variant: 'all', count: n, label,
          text: `其中 ${n} 篇${label}（已包含在上面的 ${total} 篇内）`, showAll: false };
      })(),
    },
    items: pageItems,
    topics: topics.map((t) => ({ slug: t.slug, name: t.name_zh })),
    judgments: judgments.judgmentStats(),
    // 前端据此决定是「懒加载译文」还是显示「未配置 AI 密钥」的可重试状态
    aiConfigured: (() => { try { return require('./interpret').isConfigured(); } catch { return false; } })(),
    translationAttribution: '译文由 AI 生成，仅供参考；引用请以原文为准。',
    note: total === 0
      ? '当前筛选条件下没有主题相关的论文。可以放宽「期刊等级」筛选、扩大时间窗口，或在「主题与检索词」里补充检索词后重新采集。'
      : null,
  };
}

/* ----------------------------- 期刊条件合格精选 ----------------------------- */

/**
 * 「期刊条件合格精选」：只包含官方目录核验合格的论文。
 * 与今日发现完全分开统计，参考候选绝不进入这里。
 */
function listQualified({ page = 1, pageSize = 30, includeMuted = false } = {}) {
  const page0 = Math.max(1, Number(page) || 1);
  const size = Math.min(Math.max(1, Number(pageSize) || 30), 100);
  const rows = store.all(
    `SELECT * FROM papers
      WHERE eligibility = 'eligible' AND eligible_official = 1
      ORDER BY COALESCE(published_online, issued_date, discovery_date) DESC
      LIMIT 2000`);

  const mutedIds = new Set(store.all("SELECT paper_id FROM judgments WHERE decision = 'muted'").map((r) => r.paper_id));
  const judged = new Map(store.all('SELECT paper_id, decision FROM judgments').map((r) => [r.paper_id, r.decision]));
  const topics = topicList();
  const topicMap = rank.topicNameMap();

  const cards = [];
  for (const p of rows) {
    if (!includeMuted && mutedIds.has(p.id)) continue;
    const ann = annotate(p, topics, topicMap);
    const d = judged.get(p.id);
    cards.push(rowToCard(p, ann, d ? { decision: d, label: judgments.DECISIONS[d]?.label } : null));
  }
  cards.sort((a, b) => b.score - a.score);

  const total = cards.length;
  const start = (page0 - 1) * size;
  return {
    ok: true,
    page: page0, pageSize: size, total,
    hasMore: start + size < total,
    items: attachTranslations(cards.slice(start, start + size)),
    emptyReason: total === 0
      ? '目前没有任何期刊被官方目录核验为合格。这是因为还没有导入机构版 JCR/SSCI 或 CSSCI/北大核心目录；'
        + '「今日发现」里仍会正常展示主题相关的参考候选与待核验论文，供你先读。'
      : null,
  };
}

/* ----------------------------- 首页总览 ----------------------------- */

function deskOverview() {
  const st = require('./library').libraryStats();
  const js = judgments.judgmentStats();
  const latestRun = store.get('SELECT * FROM brief_runs ORDER BY run_date DESC LIMIT 1');
  const today = require('./brief').beijingDate();
  const settings = getSettings();

  return {
    ok: true,
    today,
    stats: {
      papers: st.papers,
      eligibleOfficial: st.eligiblePapers,
      reference: st.referencePapers,
      pending: st.pendingPapers,
      starred: st.starred,
      read: st.read,
      reading: st.reading,
      interpretations: st.interpretations,
    },
    judgments: js,
    brief: latestRun ? {
      runDate: latestRun.run_date, status: latestRun.status,
      selectedCount: latestRun.selected_count, eligibleCount: latestRun.eligible_count,
      candidateCount: latestRun.candidate_count,
      isToday: latestRun.run_date === today,
    } : null,
    // 个性化排序的说明与开关状态（当前默认关闭，不使用任何点击行为改排序）
    personalization: {
      enabled: Boolean(settings.personalizedRanking),
      basis: '基于你标注「感兴趣」的论文，用主题相关度向量做相似度加权',
      note: '默认关闭。关闭时排序只用可解释的主题相关度与日期，不会因为几次点击改变顺序。',
    },
  };
}

module.exports = { listDiscovery, listQualified, deskOverview, JOURNAL_FILTERS, attachTranslations };
