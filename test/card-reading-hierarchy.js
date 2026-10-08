'use strict';
/**
 * 卡片阅读层级 / 日期精度 / 译文懒加载 回归测试。
 *
 * 覆盖本轮修改里最容易悄悄退化的约束（对应真实缺陷，不是凑数用例）：
 *   1. 日期精度：只有年的上游日期不得补成「1 月 1 日」；卡片只显示一个可信发表时间；
 *      工作台发现日不是发表日，不参与新近度、不出现在卡面。
 *   2. 卡片载荷：列表接口必须带上 pub（含精度）与已缓存的篇关摘译文；
 *      没有摘要/关键词时明确标注，绝不生成内容。
 *   3. 阅读层级：原文题名/关键词/摘要都在对应译文之前；
 *      综合分、维度小数、被引数、方法线索等内部指标只在可展开的「为何推荐」里。
 *   4. 译文懒加载：未配置 AI 时如实返回「未配置」，不假装翻译。
 *
 * 运行：node test/card-reading-hierarchy.js
 * 使用独立临时数据目录，不会触碰正式的 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-card-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

/**
 * 从 public/app.js 抽取**真实的**卡片渲染实现来测，
 * 而不是在测试里重写一份（否则测的是测试自己）。
 */
function extractCardFns() {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const start = app.indexOf('function judgmentButtonsHtml(p, opts = {}) {');
  // 结尾落在「视图：论文详情」之前的注释块开头，这样 briefCardHtml 也在范围内
  // （注意：不能用「视图：阅读判断」做标记，它出现在 briefCardHtml 之前）
  const marker = app.indexOf('视图：论文详情');
  const end = app.lastIndexOf('/*', marker);
  if (start < 0 || marker < 0 || end <= start) throw new Error('无法在 app.js 中定位卡片渲染函数');
  const src = app.slice(start, end);
  const esc = (x) => String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtDate = (d) => {
    if (!d) return '—';
    const s = String(d).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{4}(-\d{2})?$/.test(s)) return s;   // 精度不足按原精度显示
    return s.slice(0, 10);
  };
  const langLabelOf = (l) => ({ zh: '中文', en: '英文', id: '印尼语' }[l] || '语种待确认');
  const state = { trItems: new Map() };
  // 卡片渲染依赖的几个上游小函数：按真实语义提供等价实现（它们另有专门测试覆盖）
  const bibLine = (it) => (it && it.issue ? ` 第 ${it.issue} 期` : '');
  const langTag = (l) => `<span class="tag">${l === 'zh' ? '中文' : '英文'}</span>`;
  const eligTag = (s) => `<span class="tag elig">${s === 'eligible' ? '期刊条件合格' : (s === 'reference' ? '参考候选' : '待核验')}</span>`;
  const journalTagHtml = (t) => `<span class="tag">${esc(t && t.text)}</span>`;
  const fmtDateTime = (d) => String(d == null ? '—' : d);
  const $ = () => null;
  const $$ = () => [];
  const api = async () => ({});
  const toast = () => {};
  const factory = new Function('esc', 'attr', 'fmtDate', 'langLabelOf', 'state', 'api', '$$', '$',
    'bibLine', 'langTag', 'eligTag', 'journalTagHtml', 'fmtDateTime', 'toast',
    src + '\n; return { discoveryCardHtml, briefCardHtml,'
    + ' pubTimeHtml, keywordBlockHtml, abstractBlockHtml, diagnosticsHtml, coreTopicsHtml, trText, trField,'
    + ' verificationFaceHtml, verificationDetailHtml, shortReasonText, briefVerificationSummary };');
  return factory(esc, esc, fmtDate, langLabelOf, state, api, $$, $,
    bibLine, langTag, eligTag, journalTagHtml, fmtDateTime, toast);
}

/** 卡面 = 去掉「为何推荐 / 来源详情」折叠区之后的部分 */
function cardFace(html) {
  return html.replace(/<div class="diag-block">[\s\S]*?<\/article>/, '</article>');
}

/** 折叠区里的内容 */
function cardCollapsed(html) {
  const m = /<div class="diag-block">[\s\S]*?<\/article>/.exec(html);
  return m ? m[0] : '';
}

/** 构造一张「像今日发现返回的」卡片数据 */
function makeItem(extra = {}) {
  return Object.assign({
    id: 900,
    title: 'Pragmatic instruction and L2 refusal strategies',
    title_zh: null,
    authors: ['A. Author', 'B. Author'],
    journal_name: 'RELC Journal',
    language: 'en',
    abstract: 'This study investigates the effect of pragmatic instruction on second language refusal strategies among 60 learners.',
    abstract_length: 110,
    keywords: ['pragmatic instruction', 'refusal strategies'],
    keywords_source: 'imported',
    eligibility: 'reference',
    eligibility_basis: 'reference',
    journal_tags: [],
    topic_evidence: [{ slug: 'pragmatics', name: '语用研究', score: 0.8123 }],
    dimensions: { topic: 0.8123, freshness: 0.65, method: 0.5, value: 0.4, completeness: 0.9 },
    score: 0.7312,
    citation_count: 12,
    method_signals: ['experiment', 'questionnaire'],
    sources: ['crossref'],
    pub: { value: '2026-09-25', precision: 'day', kind: 'online', label: '在线发表', ms: Date.parse('2026-09-25T00:00:00Z') },
    translations: {
      title: { available: true, text: '语用教学与二语拒绝策略', status: 'ok' },
      keywords: { available: true, text: '语用教学；拒绝策略', status: 'ok' },
      abstract: { available: true, text: '本研究考察语用教学对 60 名学习者二语拒绝策略的影响。', status: 'ok' },
    },
    aiConfigured: true,
    starred: false,
    read_state: 'none',
    judgment: null,
    fresh: true,
    kind: 'new',
    discovery_date: '2026-09-28',
    doi: '10.1000/xyz',
    rank: 1,
  }, extra);
}

(async () => {
  const store = require('../lib/store');
  const journals = require('../lib/journals');
  const discover = require('../lib/discover');
  const desk = require('../lib/desk');
  const translate = require('../lib/translate');
  const N = require('../lib/normalize');
  const sources = require('../lib/sources');
  const config = require('../lib/config');

  store.migrate();
  discover.seedTopicsIfEmpty();

  /* ============================ 一、日期精度 ============================ */
  console.log('\n【一】日期精度：知道多少存多少，不造出「1 月 1 日」');

  const paperFromParts = (parts) => sources.crossrefToPaper({
    DOI: '10.1000/date-test', title: ['日期精度测试'], type: 'journal-article',
    issued: { 'date-parts': [parts] },
  });

  const y = paperFromParts([2026]);
  ok('Crossref 只有年 → issuedDate = "2026"（不补 -01-01）', y.issuedDate === '2026', `实际 ${y.issuedDate}`);
  const ym = paperFromParts([2026, 9]);
  ok('Crossref 只有年月 → issuedDate = "2026-09"', ym.issuedDate === '2026-09', `实际 ${ym.issuedDate}`);
  const ymd = paperFromParts([2026, 9, 14]);
  ok('Crossref 完整日期 → issuedDate = "2026-09-14"', ymd.issuedDate === '2026-09-14', `实际 ${ymd.issuedDate}`);

  ok('datePrecision 把历史占位日 2026-01-01 视为「只有年」', N.datePrecision('2026-01-01') === 'year');
  ok('datePrecision 识别 day / month / year',
    N.datePrecision('2026-09-14') === 'day' && N.datePrecision('2026-09') === 'month' && N.datePrecision('2026') === 'year');

  const fullOnline = N.bestPubDate({ published_online: '2026-09-25', published_print: '2026-01-01', issued_date: '2026', discovery_date: '2026-09-28' });
  ok('有完整在线发表日时优先用它', fullOnline.kind === 'online' && fullOnline.precision === 'day' && fullOnline.value === '2026-09-25',
    `${fullOnline.kind}/${fullOnline.precision}/${fullOnline.value}`);
  ok('bestPubDate 绝不返回 discovery_date',
    N.bestPubDate({ discovery_date: '2026-09-28' }) === null);
  const yearOnly = N.bestPubDate({ issued_date: '2026', discovery_date: '2026-09-28' });
  ok('只有年时时长精度如实标明', yearOnly.precision === 'year' && /年/.test(yearOnly.label), yearOnly.label);
  ok('旧库里的 2026-01-01 不会显示成某一天', N.bestPubDate({ issued_date: '2026-01-01' }).precision === 'year');

  const printFallback = N.bestPubDate({ published_print: '2026-09', issued_date: '2026' });
  ok('没有在线日时回退到正式出版（按实际精度）', printFallback.kind === 'print' && printFallback.precision === 'month',
    `${printFallback.kind}/${printFallback.precision}`);

  /* ==================== 二、新近度不用「发现日」冒充 ==================== */
  console.log('\n【二】新近度只认可信发表时间：中文题录不会因「今天刚采到」被当成刚发表');

  const topics = discover.listTopics(true);
  const slug = topics[0].slug;
  // A：真正的新论文（完整在线发表日 = 今天）
  const todayIso = new Date().toISOString().slice(0, 10);
  const oldYear = String(new Date().getUTCFullYear() - 2);
  store.run(`INSERT INTO papers(title, language, abstract, published_online, issued_date, discovery_date, dedup_key, eligibility, sources, topics)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ['Fresh English paper on pragmatic instruction', 'en', 'a'.repeat(200), todayIso, todayIso, todayIso, 'date-test:fresh', 'pending', 'crossref', JSON.stringify([slug])]);
  const freshId = store.get('SELECT id FROM papers WHERE dedup_key = ?', ['date-test:fresh']).id;
  // B：只到年份的旧中文题录，但工作台「今天」才采到
  store.run(`INSERT INTO papers(title, language, abstract, published_online, issued_date, discovery_date, dedup_key, eligibility, sources, topics)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ['中文题录：二语语用教学研究', 'zh', 'b'.repeat(200), null, oldYear, todayIso, 'date-test:coarse', 'pending', 'cn-catalog', JSON.stringify([slug])]);
  const coarseId = store.get('SELECT id FROM papers WHERE dedup_key = ?', ['date-test:coarse']).id;

  const disc = desk.listDiscovery({ pageSize: 100 });
  const items = disc.items || [];
  const iFresh = items.findIndex((x) => x.id === freshId);
  const iCoarse = items.findIndex((x) => x.id === coarseId);
  ok('完整发表日的新论文排在只有年份的旧题录之前',
    iFresh >= 0 && iCoarse >= 0 && iFresh < iCoarse, `fresh@${iFresh} coarse@${iCoarse}`);
  const coarseCard = items.find((x) => x.id === coarseId);
  ok('只有年份的中文题录仍然进入候选（不被丢弃）', Boolean(coarseCard));
  ok('该题录的 pub 精度为 year，且值就是年份',
    coarseCard && coarseCard.pub && coarseCard.pub.precision === 'year' && coarseCard.pub.value === oldYear,
    coarseCard && JSON.stringify(coarseCard.pub));

  /* ======================= 三、卡片载荷：pub + 译文 ======================= */
  console.log('\n【三】列表接口必须带可信发表时间与已缓存译文');

  const card = items.find((x) => x.id === freshId);
  ok('今日发现卡片带 pub 对象（含精度）', card && card.pub && card.pub.precision === 'day');
  ok('今日发现卡片带 translations 三字段',
    card && card.translations && card.translations.title && card.translations.keywords && card.translations.abstract);

  // 缺摘要 / 缺关键词的论文：必须明确标注，且绝不生成内容
  store.run(`INSERT INTO papers(title, language, published_online, discovery_date, dedup_key, eligibility, sources, topics)
             VALUES(?,?,?,?,?,?,?,?)`,
    ['Metadata-only paper without abstract', 'en', todayIso, todayIso, 'date-test:noabs', 'pending', 'crossref', JSON.stringify([slug])]);
  const noAbsId = store.get('SELECT id FROM papers WHERE dedup_key = ?', ['date-test:noabs']).id;
  const bundle = translate.bundlesFor([noAbsId]).get(noAbsId);
  ok('没有摘要 ⇒ available=false，并写明「原始数据未提供摘要」',
    bundle && bundle.fields.abstract.available === false && /未提供摘要/.test(bundle.fields.abstract.note || ''),
    bundle && bundle.fields.abstract.note);
  ok('没有关键词 ⇒ available=false，并写明「原始数据未提供关键词」',
    bundle && bundle.fields.keywords.available === false && /未提供关键词/.test(bundle.fields.keywords.note || ''));
  ok('缺摘要/关键词时 text 为 null（不编造内容）',
    bundle && bundle.fields.abstract.text === null && bundle.fields.keywords.text === null);

  // 缓存命中：写一条 ok 的译文，bundlesFor 必须直接返回
  const freshPaper = store.get('SELECT * FROM papers WHERE id = ?', [freshId]);
  const titleSrc = translate.sourceFor(freshPaper, 'title');
  store.run(`INSERT INTO translations(paper_id, field, target_lang, source_lang, source_hash, source_text, translated, status, model, provider)
             VALUES(?,?,?,?,?,?,?, 'ok', 'test-model', 'test')`,
    [freshId, 'title', 'zh', 'en', translate.hash(titleSrc.text), titleSrc.text, '缓存命中的中文题名']);
  const b2 = translate.bundlesFor([freshId]).get(freshId);
  ok('已缓存译文直接返回，不调用模型',
    b2 && b2.fields.title.text === '缓存命中的中文题名' && b2.fields.title.status === 'ok');

  /* ==================== 四、未配置 AI 时不假装翻译 ==================== */
  console.log('\n【四】未配置 AI 密钥时如实返回「未配置」');
  const noKey = await translate.translateBatch({ paperIds: [freshId], fields: ['abstract'] });
  ok('未配置密钥 ⇒ configured=false，不产生假译文',
    noKey.configured === false && /未配置 AI 密钥/.test(noKey.error || ''), noKey.error);

  /* ======================== 五、前端阅读层级 ======================== */
  console.log('\n【五】卡片阅读层级：原文在前、译文紧随其后');

  const F = extractCardFns();
  const item = makeItem();
  const html = F.discoveryCardHtml(item);

  const iTitleSrc = html.indexOf('Pragmatic instruction and L2 refusal strategies');
  const iTitleTr = html.indexOf('语用教学与二语拒绝策略');
  ok('题名：英文原题在中文译文之前', iTitleSrc >= 0 && iTitleTr > iTitleSrc, `src@${iTitleSrc} tr@${iTitleTr}`);

  const iKwSrc = html.indexOf('pragmatic instruction、refusal strategies');
  const iKwTr = html.indexOf('语用教学；拒绝策略');
  ok('关键词：原文在译文之前', iKwSrc >= 0 && iKwTr > iKwSrc, `src@${iKwSrc} tr@${iKwTr}`);

  const iAbsSrc = html.indexOf('This study investigates the effect');
  const iAbsTr = html.indexOf('本研究考察语用教学对');
  ok('摘要：原文在译文之前', iAbsSrc >= 0 && iAbsTr > iAbsSrc, `src@${iAbsSrc} tr@${iAbsTr}`);
  ok('摘要原文与译文同卡对应（都在同一张卡里）', iAbsSrc >= 0 && iAbsTr >= 0);
  ok('摘要译文在卡面直接可见（不要求进详情或点翻译）', iAbsTr >= 0);

  ok('关键词注明了来源（作者关键词，不是工作台标签）', /作者关键词（题录导入）/.test(html));
  ok('带 AI 译文角标', /AI 译文/.test(html));

  /*
   * 纵向层级：原文在上、译文在下。桌面宽度也不得左右并排。
   * 这里既查 DOM 顺序，也查 CSS 是否是单列（防止有人又把摘要改回双栏）。
   */
  const iKwLabel = html.indexOf('原文关键词');
  const iKwTrNode = html.indexOf('data-tr-field="keywords"');
  ok('关键词：原文块在译文节点之前（纵向结构）', iKwLabel >= 0 && iKwTrNode > iKwLabel);
  const absIdx = html.indexOf('abs-full');
  const iAbsOrigLabel = html.indexOf('原文摘要', absIdx);
  const iAbsTrLabel = html.indexOf('AI 译文', absIdx);
  ok('摘要：同一块内「原文摘要」在「AI 译文」之前',
    iAbsOrigLabel >= 0 && iAbsTrLabel > iAbsOrigLabel, `原文@${iAbsOrigLabel} 译文@${iAbsTrLabel}`);

  /*
   * 用户口径：「原文摘要和 ai 译文直接全部显示就可以，不用展开原文」。
   * 卡面摘要必须没有折叠按钮、没有截断，两份正文都直接可见。
   */
  ok('摘要不再有「展开全文（原文 + 译文）」折叠按钮', !/展开全文/.test(html));
  ok('摘要不再有摘要专用的折叠内容区', !/d-abs-900-body/.test(html));
  ok('摘要正文没有截断类（不做 clamped 预览）', !/abs-text clamped/.test(html));
  ok('原文摘要与 AI 译文都在卡面直接完整输出（无需展开）',
    html.includes('This study investigates the effect of pragmatic instruction on second language refusal strategies among 60 learners.')
    && html.includes('本研究考察语用教学对 60 名学习者二语拒绝策略的影响。'));

  /* ---------- 简报卡片：核验块与长理由真正收进折叠区 ---------- */
  console.log('\n【五之二】简报卡片：卡面只留色块 + 一短句 + 一句短理由，长说明进折叠区');

  const LONG_NOTE = '参考候选（非官方目录）：参考候选清单显示 JCR 分区为 Q1、标注为 SSCI，但未经官方核验。'
    + '这些结论来自非官方参考线索（随程序附带的参考名录，或你导入的截图清单），不是官方目录。'
    + '因此该刊的论文：可以进入主题优先的今日简报，但会醒目标注为「参考候选」；'
    + '不计入「期刊条件合格」数量，也不会进入「期刊条件合格精选」页。';
  const LONG_REASON = '主题相关度最高：第二语言习得(1)、教育技术研究(0.622)、语言学与应用语言学（语言教育方向）(0.369)；'
    + '方法线索（按题名与摘要识别）：眼动/神经、测验/测量；落脚点在教学、教师或学习者，偏教学研究取向；'
    + '首次在线发表仅 3 天；有开放获取版本，可直接读全文；有摘要（1329 字符），可先做依据摘要的快速解读。';

  const briefItem = makeItem({
    rank: 1, kind: 'new',
    topics: [{ slug: 'sla', name: '第二语言习得' }, { slug: 'edtech', name: '教育技术研究' }],
    verification: { atRecommendation: 'reference', official: false, headline: '参考候选：期刊信息来自非官方参考线索，尚未核验', changedSince: false },
    verificationSnapshot: { status: 'reference', official: false, evidence: [{ catalog: 'JCR 分区', edition: '2026', basis: '刊名精确匹配' }] },
    eligibility_note: LONG_NOTE,
    reason: LONG_REASON,
    journal_tags: [],
  });

  const bHtml = F.briefCardHtml(briefItem);
  const bFace = cardFace(bHtml);
  const bFold = cardCollapsed(bHtml);

  ok('卡面保留醒目的核验状态色块（徽标文字含「不计入合格」）',
    /◇ 参考候选 · 未经官方核验（不计入合格）/.test(bFace));
  ok('卡面色块带官方/非官方修饰类，颜色不靠猜',
    /class="verify-face is-unofficial"/.test(bFace));
  ok('卡面只有一句非常短的状态说明', /证据来自非官方参考名录，只作阅读线索。/.test(bFace));
  ok('卡面不再出现那段很长的 eligibility_note', !bFace.includes(LONG_NOTE.slice(0, 40)));
  ok('卡面不再出现完整推荐理由（长段落）', !bFace.includes(LONG_REASON.slice(0, 30)));
  ok('卡面保留一句阅读理由（reason.short）',
    /<div class="reason short">[\s\S]*?为什么值得你读/.test(bFace));
  const faceShort = F.shortReasonText(briefItem);
  ok('这句理由不带小数分数（0.622 之类不得出现）', !/\d\.\d{2,}/.test(faceShort), faceShort);
  ok('这句理由点明了主题与材料依据', /第二语言习得/.test(faceShort) && /有摘要/.test(faceShort));

  ok('完整推荐理由已移入默认收起的「为何推荐 / 来源详情」',
    /完整推荐理由/.test(bFold) && bFold.includes(LONG_REASON.slice(0, 30)));
  ok('核验详情与证据也已移入折叠区',
    /期刊核验详情与证据/.test(bFold) && bFold.includes(LONG_NOTE.slice(0, 40)) && /JCR 分区／2026／刊名精确匹配/.test(bFold));
  ok('折叠区默认是收起的（collapse-body hidden）',
    /<div class="collapse-body hidden" id="diag-900-body"/.test(bHtml));
  ok('折叠头带 aria-expanded=false 与 aria-controls（展开后仍可读全部内容）',
    /aria-expanded="false" aria-controls="diag-900-body"/.test(bHtml));

  // 待核验与官方合格两种状态同样适用
  const pendingItem = makeItem({
    verification: { atRecommendation: 'pending', official: false, headline: '待核验：该刊未在已导入的官方目录中匹配到' },
    verificationSnapshot: null, eligibility_note: '该刊未匹配到任何目录记录，因此无法核实收录与分区。', reason: LONG_REASON,
  });
  const pFace = cardFace(F.briefCardHtml(pendingItem));
  ok('待核验卡片卡面也带「（不计入合格）」徽标',
    /\? 待核验 · 未匹配到官方目录（不计入合格）/.test(pFace));
  ok('待核验卡片的卡面也不出现长说明', !pFace.includes('无法核实收录与分区'));

  const officialItem = makeItem({
    verification: { atRecommendation: 'official', official: true, headline: '期刊条件合格（官方目录已核验）' },
    verificationSnapshot: { status: 'official', official: true, evidence: [{ catalog: 'CSSCI', edition: '2025-2026', basis: '刊名匹配' }] },
    eligibility_note: '', reason: LONG_REASON,
  });
  const oHtml = F.briefCardHtml(officialItem);
  const oFace = cardFace(oHtml);
  ok('官方合格卡片卡面写「证据来自你导入的官方目录。」', /证据来自你导入的官方目录。/.test(oFace));
  ok('官方合格卡片的核验详情（含证据）在折叠区里',
    /期刊核验详情与证据/.test(cardCollapsed(oHtml)) && /CSSCI／2025-2026／刊名匹配/.test(cardCollapsed(oHtml)));

  /* ---------- 卡面不得出现内部指标与双重日期 ---------- */
  const cardFnStart = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const dStart = cardFnStart.indexOf('function discoveryCardHtml(it) {');
  const dMarker = cardFnStart.indexOf('视图：期刊条件合格精选');
  const dSrc = cardFnStart.slice(dStart, cardFnStart.lastIndexOf('/*', dMarker));
  ok('卡面不再显示「工作台发现」日期', !/工作台发现/.test(dSrc));
  ok('卡面不再显示综合分', !/综合分/.test(dSrc));
  ok('卡面不再显示被引数', !/被引/.test(dSrc));
  ok('卡面不再显示方法线索', !/方法线索/.test(dSrc));
  ok('卡面不再显示维度小数', !/dims\.(topic|freshness|method|value|completeness)/.test(dSrc));
  ok('卡面主题最多 2 个且不带分数', /ev\.slice\(0, 2\)/.test(F.coreTopicsHtml.toString()));

  /* ---------- 内部指标被收进可展开区 ---------- */
  const diag = F.diagnosticsHtml(item);
  ok('「为何推荐 / 来源详情」存在且是可展开折叠区',
    /为何推荐 \/ 来源详情/.test(diag) && /class="collapse-head"/.test(diag) && /class="collapse-body hidden"/.test(diag)
    && /aria-expanded="false"/.test(diag) && /aria-controls="diag-900-body"/.test(diag));
  ok('诊断区里能看到被引数与维度得分', /被引：12/.test(diag) && /主题相关 0\.8123/.test(diag));
  ok('诊断区明确说明内部指标不是质量结论', /不是论文质量结论/.test(diag));
  ok('采集日期在诊断区里如实说明「不是论文发表日期」', /不是论文发表日期/.test(diag));

  /* ---------- 发表时间只显示一个 ---------- */
  const pub = F.pubTimeHtml(item);
  ok('卡片只显示一个发表时间（在线发表 2026-09-25）',
    /在线发表 2026-09-25/.test(pub) && !/工作台发现/.test(pub) && !/首次在线/.test(pub) && !/正式出版/.test(pub));
  const coarsePub = F.pubTimeHtml(makeItem({ pub: { value: '2026', precision: 'year', kind: 'issued', label: '出版年', ms: null } }));
  ok('精度不足时如实标注「只提供到年，未补具体日期」', /只提供到年/.test(coarsePub) && /2026/.test(coarsePub));
  const noPub = F.pubTimeHtml(makeItem({ pub: null }));
  ok('没有可信发表时间时写「发表时间未提供」，不用发现日顶替',
    /发表时间未提供/.test(noPub) && !/工作台发现/.test(noPub));

  /* ---------- 缺摘要 / 缺关键词的卡片文案 ---------- */
  const noAbsHtml = F.discoveryCardHtml(makeItem({
    abstract: null, abstract_length: 0, keywords: [], keywords_source: null,
    translations: {
      title: { available: true, text: null, status: 'missing' },
      keywords: { available: false, note: '原始数据未提供关键词' },
      abstract: { available: false, note: '原始数据未提供摘要' },
    },
  }));
  ok('缺摘要 ⇒ 明确写「原始数据未提供摘要」且不出现摘要译文占位',
    /原始数据未提供摘要/.test(noAbsHtml) && !/AI 译文/.test(noAbsHtml));
  /*
   * 用户口径：卡面「作者关键词缺失」只保留一行「原文未提供关键词」，
   * 关于「主题标签不是作者关键词」的长解释移到「为何推荐 / 来源详情」。
   */
  const noKwFaceFull = F.discoveryCardHtml(makeItem({
    keywords: [], keywords_source: null,
    translations: {
      title: { available: true, text: '译文', status: 'ok' },
      keywords: { available: false, note: '原始数据未提供关键词' },
      abstract: { available: true, text: '摘要译文', status: 'ok' },
    },
  }));
  // 卡面 = 去掉「为何推荐 / 来源详情」折叠区之后的部分
  const noKwFace = noKwFaceFull.replace(/<div class="diag-block">[\s\S]*?<\/article>/, '</article>');
  ok('卡面缺关键词只写一行「原文未提供关键词」', /原文未提供关键词/.test(noKwFace));
  ok('卡面不再出现「工作台的主题标签与数据库主题词都不是作者关键词」这类长解释',
    !/都不是作者关键词/.test(noKwFace));
  ok('该长解释确实还在整张卡里（只是收进了折叠区）',
    /都不是作者关键词/.test(noKwFaceFull));
  const noKwDiag = F.diagnosticsHtml(makeItem({ keywords: [], keywords_source: null }));
  ok('长解释已移到「为何推荐 / 来源详情」',
    /都不是作者关键词/.test(noKwDiag) && /为何推荐 \/ 来源详情/.test(noKwDiag));
  const oaKwDiag = F.diagnosticsHtml(makeItem({ keywords: ['x'], keywords_source: 'openalex' }));
  ok('OpenAlex 提取词的口径说明也进了来源详情',
    /OpenAlex 自动提取词/.test(oaKwDiag) && /请以原文为准/.test(oaKwDiag));

  // 未配置 AI 的真实形态：字段来源存在、但没有缓存译文
  const offHtml = F.discoveryCardHtml(makeItem({
    aiConfigured: false,
    translations: {
      title: { available: true, text: null, status: 'missing' },
      keywords: { available: true, text: null, status: 'missing' },
      abstract: { available: true, text: null, status: 'missing' },
    },
  }));
  ok('未配置 AI 时卡片显示「未配置 AI，暂不能生成译文」，而不是假装有译文',
    /未配置 AI，暂不能生成译文/.test(offHtml) && !/译文生成中/.test(offHtml));

  // 翻译失败的形态：必须能看到「可重试」
  const failHtml = F.discoveryCardHtml(makeItem({
    translations: {
      title: { available: true, text: null, status: 'failed', error: '模型超时' },
      keywords: { available: true, text: null, status: 'missing' },
      abstract: { available: true, text: null, status: 'failed', error: '模型超时' },
    },
  }));
  ok('翻译失败时原文照常显示，并给出可点击的重试入口',
    /Pragmatic instruction and L2 refusal strategies/.test(failHtml)
    && /翻译失败 · 点击重试/.test(failHtml) && /data-tr-retry="900"/.test(failHtml));

  /* ---------------------------- 六、样式 ---------------------------- */
  console.log('\n【六】样式：单一时间、译文角标、摘要并排、窄屏可用');
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  ok('有 .pub-time 样式', /\.pub-time\b/.test(css));
  ok('译文角标四态都有样式（ai/wait/err/off）',
    /\.tr-badge\.ai/.test(css) && /\.tr-badge\.wait/.test(css) && /\.tr-badge\.err/.test(css) && /\.tr-badge\.off/.test(css));
  /*
   * 摘要必须**始终单列纵向**（原文在上、译文在下），桌面宽度也不并排。
   * 早期实现是 grid-template-columns: 1fr 1fr（宽屏左右双栏）。
   */
  const absRule = /\.abs-preview,\s*\.abs-full\s*\{([^}]*)\}/.exec(css);
  ok('找到摘要容器样式规则', Boolean(absRule));
  ok('摘要容器是单列纵向（display:block，不是两列 grid）',
    Boolean(absRule) && /display:\s*block/.test(absRule[1]) && !/grid-template-columns/.test(absRule[1]),
    absRule ? absRule[1].replace(/\s+/g, ' ').trim().slice(0, 90) : '');
  ok('全文件里没有任何摘要相关的 1fr 1fr 双栏规则',
    !/\.abs-(preview|full)[^{]*\{[^}]*1fr\s+1fr/.test(css));
  ok('摘要没有截断样式（.abs-text.clamped 已移除）', !/\.abs-text\.clamped/.test(css));
  ok('译文层与原文层之间用上边框分隔（而不是左右分栏）',
    /\.abs-preview \.abs-col \+ \.abs-col,\s*\.abs-full \.abs-col \+ \.abs-col\s*\{[^}]*border-top/.test(css));
  ok('关键词来源标签有样式', /\.kw-label\b/.test(css));
  ok('次级操作菜单有样式与键盘焦点样式', /\.more-actions\b/.test(css) && /\.more-actions > summary:focus-visible/.test(css));

  /* -------------------------- 七、接口形态 -------------------------- */
  console.log('\n【七】/api/translate/batch 注册在 :paperId 之前，避免被当成论文 id');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const iBatch = serverSrc.indexOf("'/api/translate/batch'");
  const iParamPost = serverSrc.indexOf("route('POST', '/api/translate/:paperId'");
  ok('batch 路由先于 :paperId 注册', iBatch > 0 && iParamPost > 0 && iBatch < iParamPost, `batch@${iBatch} param@${iParamPost}`);

  /* ================= 八、检索溯源：摘要择优与来源一致 ================= */
  console.log('\n【八】检索审计：摘要择优必须与来源标注一致，OpenAlex 关键词真的被请求');

  // Crossref 摘要短、OpenAlex 摘要长 ⇒ 取 OpenAlex 的那份，来源也必须写 OpenAlex
  const merged = discover.mergePapers(
    { source: 'crossref', title: 'T', abstract: 'short abstract', abstractSource: 'crossref', sources: ['crossref'] },
    { source: 'openalex', title: 'T', abstract: 'a much longer abstract from openalex with details', abstractSource: 'openalex', sources: ['openalex'] });
  ok('摘要择优取更长的一份', /much longer abstract/.test(merged.abstract), merged.abstract);
  ok('摘要来源跟着被选中的那一份（不再是写死的 a）',
    merged.abstractSource === 'openalex', `实际 ${merged.abstractSource}`);

  const merged2 = discover.mergePapers(
    { source: 'crossref', title: 'T', abstract: 'a much longer abstract from crossref with details', abstractSource: 'crossref', sources: ['crossref'] },
    { source: 'openalex', title: 'T', abstract: 'short', abstractSource: 'openalex', sources: ['openalex'] });
  ok('反过来也一样：取 Crossref 的长摘要并标注 crossref',
    merged2.abstractSource === 'crossref' && /much longer abstract from crossref/.test(merged2.abstract));

  // 关键词：只有真有作者关键词的那一源才写 keywordsSource
  const m3 = discover.mergePapers(
    { source: 'crossref', title: 'T', keywords: [], keywordsSource: null, sources: ['crossref'] },
    { source: 'openalex', title: 'T', keywords: ['dynamic assessment'], keywordsSource: 'openalex', sources: ['openalex'] });
  ok('只有提供关键词的来源才写上 keywords_source',
    m3.keywords.length === 1 && m3.keywordsSource === 'openalex');

  // OpenAlex 适配器：keywords 字段必须真的被映射（而不是永远为空）
  const oaPaper = sources.openalexToPaper({
    id: 'https://openalex.org/W1', title: 'Test', publication_date: '2026-09-20',
    keywords: [{ display_name: 'Dynamic assessment', score: 0.9 }, { display_name: 'Corrective feedback', score: 0.8 }],
    topics: [{ display_name: 'Language education', score: 0.7 }],
  });
  ok('OpenAlex keywords 被映射为关键词并标注来源=openalex',
    oaPaper.keywords.length === 2 && oaPaper.keywordsSource === 'openalex', JSON.stringify(oaPaper.keywords));
  ok('OpenAlex topics 单独存为数据库主题词，不混进作者关键词',
    oaPaper.dbTopics.length === 1 && !oaPaper.keywords.includes('Language education'));

  // 检索式里必须显式请求 keywords，否则上面这个映射永远是空的
  const srcSrc = fs.readFileSync(path.join(ROOT, 'lib/sources.js'), 'utf8');
  ok('OpenAlex 每日检索的 select 里包含 keywords（否则每日采集永远没有关键词）',
    /params\.set\('select',[^)]*keywords/.test(srcSrc));

  // 每日采集按五个主题增量检索，并把成功/失败写进日志
  const collectSrc = fs.readFileSync(path.join(ROOT, 'lib/discover.js'), 'utf8');
  ok('采集按主题展开检索式（中文走 Crossref、英文走 Crossref+OpenAlex）',
    /for \(const topic of topics\)/.test(collectSrc)
    && /tasks\.push\(\{ source: 'openalex'/.test(collectSrc));
  ok('检索带时间窗口参数（增量而非全量）', /fromDate: from, untilDate: until/.test(collectSrc));
  ok('每次检索的成功/失败都写入 ingest_log', /INSERT INTO ingest_log/.test(collectSrc));

  /* -------------------------------- 汇总 -------------------------------- */
  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(60));
  console.log(`  卡片阅读层级 / 日期精度 / 译文懒加载：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(60));

  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
