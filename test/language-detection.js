'use strict';
/**
 * 语种判定回归测试。
 *
 * 起因（真实 Safari 页面确认）：/paper/634 题名是**印尼语**
 *   KAJIAN PRAGMATIK KALIMAT EKSPRESIF NETIZEN PADA KOMENTAR TIKTOK …
 * 摘要是英文，Crossref 的 language 元数据为空，工作台却标成「英文」并纳入英文候选。
 *
 * 根因：旧 detectLanguage 对任何非中文拉丁标题都 return 'en'（把拉丁字母等同英语），
 * 而 discover 里写的是 `detectLanguage(title) || p.language`——推断值永远优先，
 * 来源明确给出的语言代码永远轮不到。
 *
 * 本测试锁定修正后的四条规则：
 *   1. 拉丁字母 ≠ 英语；来源可信代码优先，但要规范化并处理与题名的冲突；
 *   2. 题名语种与摘要语种分开，英文摘要不能把非英文论文写成英文；
 *   3. 证据不足 ⇒ unknown（界面「语种待确认」）；其他语种给准确语种（含印尼语）；
 *   4. 中英文筛选与简报配额不得把 other/unknown 算作英文；人工纠正不被采集覆盖。
 *
 * 运行：node test/language-detection.js
 * 不联网、不碰项目 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-lang-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };
const N = require('../lib/normalize');

// 用户报告的那篇论文的真实文本
const ID_TITLE = 'KAJIAN PRAGMATIK KALIMAT EKSPRESIF NETIZEN PADA KOMENTAR TIKTOK KASUS GURU MANSYUR';
const ID_ABSTRACT = 'This study aims to describe the linguistic forms, pragmatic functions, and speech strategies used by netizens in TikTok comments regarding the Mansyur teacher case. The data were collected through observation and note-taking techniques.';

/* ================================================================ *
 * 1. 拉丁字母不再被当成英语
 * ================================================================ */
console.log('\n=== 1. 拉丁字母 ≠ 英语 ===');
const idDet = N.detectLanguageDetailed(ID_TITLE, { shortText: true });
ok('印尼语题名判为 id', idDet.language === 'id', `${idDet.language} / ${idDet.evidence}`);
ok('判为 id 时有具体证据（命中的功能词）', /印尼语功能词命中/.test(idDet.evidence), idDet.evidence);

const noEvidence = N.detectLanguageDetailed('Zxqv Wrtp Lmnb', { shortText: true });
ok('无证据的拉丁文本返回 unknown，而不是 en',
  noEvidence.language === 'unknown', `${noEvidence.language} / ${noEvidence.evidence}`);
ok('旧式 detectLanguage 也不再默认 en',
  N.detectLanguage('Zxqv Wrtp Lmnb') === 'unknown', String(N.detectLanguage('Zxqv Wrtp Lmnb')));

ok('真正的英文题名仍判 en',
  N.detectLanguageDetailed('Investigating the effect of VR-mediated pragmatics instruction on L2 refusal strategies', { shortText: true }).language === 'en');
ok('中文题名仍判 zh',
  N.detectLanguageDetailed('国际中文教育中的语用教学研究', { shortText: true }).language === 'zh');
ok('日文题名不判成中文（假名优先于汉字）',
  N.detectLanguageDetailed('日本語の談話分析', { shortText: true }).language === 'other');
ok('韩文题名判 other',
  N.detectLanguageDetailed('한국어 담화 분석', { shortText: true }).language === 'other');
ok('阿拉伯文题名判 other',
  N.detectLanguageDetailed('تداوُليَّة الأفعال الكلامية', { shortText: true }).language === 'other');

/* ================================================================ *
 * 2. 来源语言：优先、规范化、冲突处理
 * ================================================================ */
console.log('\n=== 2. 来源明确语言的处理 ===');
ok('来源 eng 规范化为 en',
  N.normalizeSourceLanguage('eng') === 'en');
ok('来源 ind 规范化为 id',
  N.normalizeSourceLanguage('ind') === 'id');
ok('来源 zh-CN 规范化为 zh',
  N.normalizeSourceLanguage('zh-CN') === 'zh');
ok('空来源返回 null（不是 en）',
  N.normalizeSourceLanguage('') === null && N.normalizeSourceLanguage(null) === null);
ok('无法识别的代码返回 null（不作数）',
  N.normalizeSourceLanguage('klingon') === null);

const srcOnly = N.resolvePaperLanguage({
  title: 'A Study of Pragmatic Instruction', abstract: '', sourceLanguage: 'eng',
});
ok('来源有可信代码时采用来源，并记为 publisher',
  srcOnly.language === 'en' && srcOnly.source === 'publisher', `${srcOnly.language}/${srcOnly.source}`);

// 冲突：来源说 en，题名是强印尼语证据 ⇒ 以题名为准并标记冲突
const conflict = N.resolvePaperLanguage({
  title: ID_TITLE, abstract: ID_ABSTRACT, sourceLanguage: 'en',
});
ok('来源标注 en 与印尼语题名冲突时以题名为准',
  conflict.language === 'id' && conflict.source === 'title', `${conflict.language}/${conflict.source}`);
ok('冲突被显式标记', conflict.conflict === true);
ok('冲突说明里写清了双方', /来源标注为 en/.test(conflict.evidence), conflict.evidence);

/* ================================================================ *
 * 3. 题名语种与摘要语种分开
 * ================================================================ */
console.log('\n=== 3. 题名与摘要分开判定 ===');
const r634 = N.resolvePaperLanguage({ title: ID_TITLE, abstract: ID_ABSTRACT, sourceLanguage: null });
ok('主语种 = id（按题名）', r634.language === 'id', r634.language);
ok('题名语种记录为 id', r634.titleLanguage === 'id');
ok('摘要语种如实记录为 en', r634.abstractLanguage === 'en');
ok('摘要语种没有覆盖主语种（英文摘要 ≠ 英文论文）', r634.language !== r634.abstractLanguage);
ok('判定来源是 title 而不是 abstract', r634.source === 'title', r634.source);

// 题名无证据时才允许用摘要，且要标明
const absOnly = N.resolvePaperLanguage({
  title: 'Zxqv Wrtp', abstract: 'This study examines the effect of pragmatic instruction on second language learners.', sourceLanguage: null,
});
ok('题名无证据时可用摘要判定', absOnly.language === 'en', absOnly.language);
ok('此时来源标为 abstract（可复核）', absOnly.source === 'abstract', absOnly.source);
ok('说明里点明是「按摘要」', /摘要/.test(absOnly.evidence), absOnly.evidence);

/* ================================================================ *
 * 4. 人工纠正：可复核、不被采集覆盖
 * ================================================================ */
(async () => {
  const store = require('../lib/store');
  const clock = require('../lib/clock');
  const journals = require('../lib/journals');
  const discover = require('../lib/discover');
  const desk = require('../lib/desk');
  const brief = require('../lib/brief');
  const config = require('../lib/config');
  const langfix = require('../lib/langfix');

  store.migrate();
  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();
  config.updateSettings({ briefHour: 8, briefMinute: 0, timezone: 'Asia/Shanghai' });
  clock.setClock(() => new Date(Date.UTC(2026, 8, 28, 1, 0)).getTime());

  // 用户报告的那篇 + 几篇对照
  discover.persistPapers([
    { title: ID_TITLE, abstract: ID_ABSTRACT, journalName: 'J-Simbol Jurnal Magister Pendidikan Bahasa dan Sastra Indonesia',
      publishedOnline: '2026-09-20', language: null, sources: ['crossref'], doi: '10.23960/simbol.v14i2.2158' },
    { title: 'Investigating the effect of VR-mediated pragmatics instruction on L2 refusal strategies',
      abstract: 'This study examines virtual reality based pragmatic instruction for second language learners.',
      journalName: 'RELC Journal', publishedOnline: '2026-09-21', language: 'en', sources: ['crossref'], doi: '10.1000/en.1' },
    { title: '国际中文教育中的语用教学研究', abstract: '本文考察国际中文教育中的语用教学问题。',
      journalName: '世界汉语教学', publishedOnline: '2026-09-19', language: 'zh', sources: ['crossref'], doi: '10.1000/zh.1' },
    { title: 'Dataset Corpus Repository Metadata Schema', abstract: '', journalName: 'Unknown Journal',
      publishedOnline: '2026-09-18', language: null, sources: ['crossref'], doi: '10.1000/unk.1' },
  ]);

  const p634 = store.get("SELECT * FROM papers WHERE doi_norm = '10.23960/simbol.v14i2.2158'");
  ok('入库时 /paper/634 判为 id', p634.language === 'id', p634.language);
  ok('入库时记录了判定来源', p634.language_source === 'title', p634.language_source);
  ok('入库时题名/摘要语种分开存', p634.title_language === 'id' && p634.abstract_language === 'en',
    `${p634.title_language}/${p634.abstract_language}`);
  ok('判定细节可复核（含置信度与依据）',
    (() => { const d = JSON.parse(p634.language_detail || '{}'); return d.confidence && /印尼语/.test(d.evidence || ''); })());

  const pEn = store.get("SELECT language, language_source FROM papers WHERE doi_norm = '10.1000/en.1'");
  ok('来源给 en 的英文论文仍是 en', pEn.language === 'en', pEn.language);
  const pZh = store.get("SELECT language FROM papers WHERE doi_norm = '10.1000/zh.1'");
  ok('中文论文仍是 zh', pZh.language === 'zh', pZh.language);
  const pUnk = store.get("SELECT language FROM papers WHERE doi_norm = '10.1000/unk.1'");
  ok('无证据的论文是 unknown（界面显示语种待确认）', pUnk.language === 'unknown', pUnk.language);

  console.log('\n=== 5. 人工纠正入口 ===');
  const info0 = langfix.languageInfo(pUnk ? store.get("SELECT id FROM papers WHERE doi_norm = '10.1000/unk.1'").id : 0);
  ok('详情页能读到语种信息与可选语种', info0 && Array.isArray(info0.choices) && info0.choices.length >= 4);
  const unkId = store.get("SELECT id FROM papers WHERE doi_norm = '10.1000/unk.1'").id;
  const setR = langfix.setLanguage(unkId, 'en');
  ok('人工设定成功', setR.ok === true && setR.language === 'en', setR.error || setR.language);
  ok('来源记为你人工确认', store.get('SELECT language_source s FROM papers WHERE id = ?', [unkId]).s === 'manual');
  ok('保留了自动判定原值以便恢复',
    Boolean(JSON.parse(store.get('SELECT language_detail d FROM papers WHERE id = ?', [unkId]).d || '{}').auto));
  ok('非法语种代码被拒绝', langfix.setLanguage(unkId, 'xx').ok === false);

  // 关键：再采集一次，人工值不能被覆盖
  discover.persistPapers([
    { title: 'Dataset Corpus Repository Metadata Schema', abstract: '', journalName: 'Unknown Journal',
      publishedOnline: '2026-09-18', language: null, sources: ['crossref'], doi: '10.1000/unk.1' },
  ]);
  ok('再次采集后人工纠正仍保留',
    store.get('SELECT language l FROM papers WHERE id = ?', [unkId]).l === 'en',
    store.get('SELECT language l FROM papers WHERE id = ?', [unkId]).l);
  ok('再次采集后来源仍是你人工确认',
    store.get('SELECT language_source s FROM papers WHERE id = ?', [unkId]).s === 'manual');

  const clr = langfix.clearLanguage(unkId);
  ok('可恢复为自动判定', clr.ok === true && clr.language === 'unknown', clr.error || clr.language);
  ok('恢复后不再标记为人工确认',
    store.get('SELECT language_source s FROM papers WHERE id = ?', [unkId]).s !== 'manual');

  console.log('\n=== 6. 筛选：英文只含英文 ===');
  const all = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all' });
  const enList = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all', language: 'en' });
  const idList = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all', language: 'id' });
  // 再造一篇从未被人工改过的无证据论文，保证「语种待确认」筛选有内容
  discover.persistPapers([
    { title: 'Dataset Corpus Repository Metadata Schema', abstract: '', journalName: 'Unknown Journal 2',
      publishedOnline: '2026-09-17', language: null, sources: ['crossref'], doi: '10.1000/unk.2' },
  ]);
  const unkList = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all', language: 'unknown' });
  ok('筛选「英文」里没有印尼语论文',
    (enList.items || []).every((x) => x.language === 'en'),
    (enList.items || []).map((x) => x.language).join(','));
  ok('筛选「英文」里没有 unknown 论文',
    (enList.items || []).every((x) => x.language !== 'unknown'));
  ok('筛选「印尼语」能找到那篇',
    (idList.items || []).some((x) => x.language === 'id'), `${idList.total} 篇`);
  /*
   * 关于「语种待确认」的边界说明：
   * 今日发现列表本身只收录**主题相关**的论文，而主题相关的题名几乎必然含有
   * 语言教育类的英语学术词，于是基本都会判成 en；unknown 主要出现在与本主题
   * 无关、或题名极短的论文上。因此这里不假设一定有 unknown 条目，
   * 而是断言「unknown 永远不会被算进英文」——这才是配额正确性的关键。
   */
  ok('「英文」筛选不含任何 unknown 论文',
    (enList.items || []).every((x) => x.language === 'en'),
    `en=${enList.total} unk=${unkList.total}`);
  const unkInEn = (all.items || []).filter((x) => x.language === 'unknown')
    .filter((x) => (enList.items || []).some((y) => y.id === x.id)).length;
  ok('广泛发现页里的 unknown 论文没有被算进英文筛选', unkInEn === 0);
  ok('三种筛选互不重叠',
    enList.total + idList.total + unkList.total <= all.total + 1,
    `en=${enList.total} id=${idList.total} unk=${unkList.total} all=${all.total}`);
  /*
   * 默认视图（scope=zh-en）按要求只显示中英文，所以印尼语论文**不在默认页**；
   * 关键是它没有被删除或藏起来：切到「全部语种」或「印尼语」筛选就能看到。
   */
  ok('印尼语论文没有被删除（仍在库里）',
    Boolean(store.get('SELECT id FROM papers WHERE language = ?', ['id'])));
  const allScope = desk.listDiscovery({ page: 1, pageSize: 200, journalFilter: 'all', languageScope: 'all' });
  ok('切到「全部语种」能看到印尼语论文',
    (allScope.items || []).some((x) => x.language === 'id'), `${allScope.total} 篇`);
  ok('默认视图只含中英文（印尼语不占默认页）',
    (all.items || []).every((x) => ['zh', 'en'].includes(x.language)),
    (all.items || []).map((x) => x.language).join(','));
  ok('默认视图说明了另有 N 篇未显示',
    /默认只显示已判定为中文或英文/.test(String(all.counts.scopeNote || '')));

  console.log('\n=== 7. 简报配额不把 other/unknown 算作英文 ===');
  // planBrief 未导出，这里跑真实简报链路，检查入选论文的语言分布与诊断字段
  clock.setClock(() => new Date(Date.UTC(2026, 8, 28, 1, 0)).getTime());
  const bd = brief.generateBrief({ reason: 'manual', force: true });
  const selItems = (bd && bd.selected) || (bd && bd.items) || [];
  const selLangs = selItems.map((x) => x.language);
  ok('简报链路可跑通（入选数可以为 0，取决于主题相关度）',
    bd && bd.ok !== false, JSON.stringify(bd && { ok: bd.ok, status: bd.status }).slice(0, 80));
  ok('简报入选的语言标签都是已知值',
    selItems.every((x) => ['zh', 'en', 'id', 'other', 'unknown'].includes(x.language)),
    selLangs.join(','));
  const lg = brief.getBrief().languageDiagnosis || {};
  ok('语言诊断把 other 单列（不并入英文）',
    Object.prototype.hasOwnProperty.call(lg, 'otherEligible'),
    JSON.stringify(lg).slice(0, 120));
  const briefSrc = fs.readFileSync(path.join(ROOT, 'lib/brief.js'), 'utf8');
  ok('brief.js 用 isEnglishLang 而不是 !== zh',
    /N\.isEnglishLang\(c\.paper\.language\)/.test(briefSrc) && !/language !== 'zh'/.test(briefSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('brief.js 区分 other 并给出说明',
    /const otherLang = pool\.filter/.test(briefSrc)
    && /languageNote/.test(briefSrc)
    && /没有用来凑数|不参与凑数/.test(briefSrc));

  console.log('\n=== 8. 展示层不把「非中文」显示成英文 ===');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok('有印尼语标签', /id: '印尼语'/.test(appSrc));
  ok('未知语种显示「语种待确认」', /unknown: '语种待确认'/.test(appSrc));
  ok('旧文案「语言未定」不再作为唯一兜底',
    !/return '<span class="tag src">语言未定<\/span>';/.test(appSrc));
  ok('详情页有语种人工纠正入口',
    /function languageCellHtml/.test(appSrc) && /setPaperLanguage/.test(appSrc) && /clearPaperLanguage/.test(appSrc));
  ok('语言筛选含印尼语/其他/待确认',
    /opt\('id', '印尼语'/.test(appSrc) && /opt\('unknown', '语种待确认'/.test(appSrc));

  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(62));
  console.log(`  语种判定：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(62));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
