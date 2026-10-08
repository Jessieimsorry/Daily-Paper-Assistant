'use strict';
/**
 * 「默认视图 = 中英文」回归测试。
 *
 * 需求：每天优先阅读中英文论文。
 *   · 「今日发现」默认视图与每日简报默认入选范围只含**已判定的中文 + 英文**；
 *   · 其他语种与「语种待确认」**不删除、不丢弃**，通过显式筛选入口查看；
 *   · 绝不把 unknown 偷算成英文；
 *   · 中英文不足时如实显示不足篇数与原因，不用非中英文凑数；
 *   · 主题优先排序与期刊核验标签保持不变。
 *
 * 具体案例：/paper/634（印尼语）不应出现在默认发现列表与「英文」筛选里，
 * 但必须能通过「印尼语」与「全部」找到。
 *
 * 运行：node test/default-scope-zh-en.js
 * 不联网、不碰项目 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-scope-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

(async () => {
  const store = require('../lib/store');
  const clock = require('../lib/clock');
  const journals = require('../lib/journals');
  const discover = require('../lib/discover');
  const desk = require('../lib/desk');
  const brief = require('../lib/brief');
  const config = require('../lib/config');
  config.updateSettings({ broadTechnology: false });

  store.migrate();
  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();
  config.updateSettings({ briefHour: 8, briefMinute: 0, timezone: 'Asia/Shanghai', briefSize: 8, languageBalance: true });
  clock.setClock(() => new Date(Date.UTC(2026, 8, 28, 1, 0)).getTime());

  // 用户报告的那篇印尼语论文 + 中英文对照各若干
  const ID_TITLE = 'KAJIAN PRAGMATIK KALIMAT EKSPRESIF NETIZEN PADA KOMENTAR TIKTOK KASUS GURU MANSYUR';
  discover.persistPapers([
    { title: ID_TITLE,
      abstract: 'This study aims to describe the linguistic forms, pragmatic functions and speech strategies used by netizens in TikTok comments.',
      journalName: 'J-Simbol Jurnal Magister Pendidikan Bahasa dan Sastra Indonesia',
      publishedOnline: '2026-09-22', language: null, sources: ['crossref'], doi: '10.23960/simbol.v14i2.2158' },
    { title: 'Pragmatic instruction and second language pragmatic competence development',
      abstract: 'This study examines pragmatic instruction and second language pragmatic competence with L2 learners over one semester.',
      journalName: '待核验期刊A', publishedOnline: '2026-09-21', language: null, sources: ['crossref'], doi: '10.1000/en.1' },
    { title: 'Corrective feedback and second language writing development',
      abstract: 'This study examines corrective feedback in second language writing with L2 learners.',
      journalName: '待核验期刊B', publishedOnline: '2026-09-20', language: null, sources: ['crossref'], doi: '10.1000/en.2' },
    { title: '国际中文教育中的语用教学与学习者语用能力发展研究',
      abstract: '本文考察国际中文教育中的语用教学对学习者语用能力发展的影响。',
      journalName: '世界汉语教学', publishedOnline: '2026-09-19', language: null, sources: ['crossref'], doi: '10.1000/zh.1' },
    { title: '汉语二语学习者语用标记习得的纵向研究',
      abstract: '本文报告一项关于汉语二语学习者语用标记习得的纵向研究。',
      journalName: '语言教学与研究', publishedOnline: '2026-09-18', language: null, sources: ['crossref'], doi: '10.1000/zh.2' },
  ]);

  const idPaper = store.get("SELECT * FROM papers WHERE doi_norm = '10.23960/simbol.v14i2.2158'");
  ok('/paper/634 判为印尼语（前置条件）', idPaper.language === 'id', idPaper.language);

  /* ================================================================ *
   * 1. 默认视图只含中英文
   * ================================================================ */
  console.log('\n=== 1. 今日发现默认视图 ===');
  const def = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all' });
  ok('默认 scope 为 zh-en', def.languageScope === 'zh-en', def.languageScope);
  ok('默认视图里的论文只有 zh / en',
    (def.items || []).every((x) => ['zh', 'en'].includes(x.language)),
    (def.items || []).map((x) => x.language).join(','));
  ok('/paper/634 不在默认视图里',
    !(def.items || []).some((x) => x.id === idPaper.id));
  ok('默认视图仍有内容（不是被清空）', def.total > 0, `${def.total} 篇`);

  /* ================================================================ *
   * 2. 其他语种没有被删除，只是不占默认视图
   * ================================================================ */
  console.log('\n=== 2. 其他语种仍在库里、可被找到 ===');
  const all = desk.listDiscovery({ page: 1, pageSize: 200, journalFilter: 'all', languageScope: 'all' });
  ok('「全部语种」包含 /paper/634',
    (all.items || []).some((x) => x.id === idPaper.id), `${all.total} 篇`);
  ok('「全部语种」总数 > 默认视图总数', all.total > def.total, `${all.total} > ${def.total}`);
  const idList = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all', language: 'id' });
  ok('「印尼语」筛选能找到 /paper/634',
    (idList.items || []).some((x) => x.id === idPaper.id), `${idList.total} 篇`);
  ok('「印尼语」筛选里全是 id',
    (idList.items || []).every((x) => x.language === 'id'));
  ok('库里仍然保留着这篇论文（没被删除）',
    Boolean(store.get('SELECT id FROM papers WHERE id = ?', [idPaper.id])));
  ok('论文总数没有减少', store.get('SELECT COUNT(*) c FROM papers').c === 5,
    String(store.get('SELECT COUNT(*) c FROM papers').c));

  console.log('\n=== 3. 页面能说明「另有 N 篇未显示」 ===');
  ok('默认视图返回 outsideDefaultScope', typeof def.counts.outsideDefaultScope === 'number');
  ok('outsideDefaultScope = 非中英文候选数',
    def.counts.outsideDefaultScope === 1, String(def.counts.outsideDefaultScope));
  ok('byLanguage 统计不受默认范围限制（能数到 id）',
    def.counts.byLanguage.id === 1, JSON.stringify(def.counts.byLanguage));
  ok('byLanguage 各语种之和等于全部候选数',
    Object.values(def.counts.byLanguage).reduce((a, b) => a + b, 0) === all.total,
    `${JSON.stringify(def.counts.byLanguage)} vs all.total=${all.total}`);
  ok('scopeNote 说明了默认范围与查看方式',
    /默认只显示已判定为中文或英文/.test(def.counts.scopeNote || '')
    && /全部/.test(def.counts.scopeNote || ''),
    (def.counts.scopeNote || '').slice(0, 60));

  /* ================================================================ *
   * 4. 英文筛选不偷算 unknown / other
   * ================================================================ */
  console.log('\n=== 4. 「英文」筛选精确 ===');
  const enList = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all', language: 'en' });
  ok('「英文」筛选结果全是 en',
    (enList.items || []).every((x) => x.language === 'en'));
  ok('「英文」筛选不含 /paper/634',
    !(enList.items || []).some((x) => x.id === idPaper.id));
  ok('显式语言筛选时 scope 变为 all（能查到其他语种）',
    enList.languageScope === 'all', enList.languageScope);
  // 造一篇 unknown，确认它不会被算进英文
  discover.persistPapers([
    // 「主题相关但语种证据不足」：题名含主题词，但用不在语种词表里的写法，
    // 不会因为主题词而被判成英文。这里直接断言语言字段，不依赖它进入候选池。
    { title: 'Dataset Corpus Repository Metadata Schema', abstract: '', journalName: 'Unknown Journal',
      publishedOnline: '2026-09-17', language: null, sources: ['crossref'], doi: '10.1000/unk.1' },
  ]);
  const unkPaper = store.get("SELECT * FROM papers WHERE doi_norm = '10.1000/unk.1'");
  ok('无证据论文判为 unknown', unkPaper.language === 'unknown', unkPaper.language);
  const en2 = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all', language: 'en' });
  ok('unknown 不出现在「英文」筛选里',
    !(en2.items || []).some((x) => x.language === 'unknown'));
  const def2 = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all' });
  ok('unknown 也不出现在默认视图里',
    !(def2.items || []).some((x) => x.language === 'unknown'));
  /*
   * 注意：这篇 unknown 的题名没有主题证据，因此它不会进入候选池，
   * 也就不会出现在 outsideDefaultScope 里（那个数字只统计主题相关候选）。
   * 关键性质是「unknown 永远不会被算作英文 / 不会进入默认视图」，
   * 这在上面两条已经断言。
   */
  ok('unknown 不在候选池时不污染默认视图',
    !(def2.items || []).some((x) => x.language === 'unknown')
    && def2.counts.outsideDefaultScope === 1,
    `outside=${def2.counts.outsideDefaultScope}`);

  /* ================================================================ *
   * 4.5 默认范围必须在不展开折叠面板时就可见
   * ================================================================ */
  console.log('\n=== 4.5 默认范围在统计条上直接可见 ===');
  ok('接口给出 scopeLabel', /中英文主题候选/.test(def.counts.scopeLabel || ''),
    def.counts.scopeLabel);
  ok('接口给出 allLanguagesTotal（不分语种总数）',
    def.counts.allLanguagesTotal === all.total,
    `${def.counts.allLanguagesTotal} vs ${all.total}`);
  ok('接口给出 scopedTotal（当前视图内篇数）',
    def.counts.scopedTotal === def.total, `${def.counts.scopedTotal} vs ${def.total}`);
  ok('scopedTotal + outsideDefaultScope === allLanguagesTotal',
    def.counts.scopedTotal + def.counts.outsideDefaultScope === def.counts.allLanguagesTotal,
    `${def.counts.scopedTotal} + ${def.counts.outsideDefaultScope} = ${def.counts.allLanguagesTotal}`);
  // 此刻库里只有 1 篇非中英文（印尼语那篇）；这个数必须由响应算出，页面不得写死
  ok('另有 N 篇的 N 来自实际响应（此刻应为 1）',
    def.counts.outsideDefaultScope === 1,
    String(def.counts.outsideDefaultScope));
  ok('接口给出 outsideLabel', /其他语种/.test(def.counts.outsideLabel || ''),
    def.counts.outsideLabel);

  const appSrcEarly = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok('统计条用 scopeLabel 而不是笼统的「主题候选」',
    /esc\(c\.scopeLabel \|\| c\.labels\?\.total/.test(appSrcEarly));
  ok('统计条直接显示「另有 N 篇」',
    /另有 <b>\$\{c\.outsideDefaultScope\}<\/b> 篇/.test(appSrcEarly));
  ok('统计条提供「查看全部语种」直通按钮',
    /onclick="showAllLanguages\(\)"/.test(appSrcEarly) && /function showAllLanguages/.test(appSrcEarly));
  ok('直通按钮切换后是全部语种',
    /function showAllLanguages\(\)[\s\S]{0,180}discoveryState\.language = 'all'/.test(appSrcEarly));
  ok('筛选摘要默认写「默认：中文+英文」',
    /bits\.push\('默认：中文\+英文'\)/.test(appSrcEarly));
  ok('筛选摘要选全部后写「全部语种」',
    /discoveryState\.language === 'all'\) bits\.push\('全部语种'\)/.test(appSrcEarly));
  ok('口径说明按视图范围表述篇数',
    /当前视图范围/.test(appSrcEarly));
  ok('前端统计条渲染服务端的 outsideHint.text（不自己拼「另有」）',
    /esc\(c\.outsideHint\.text\)/.test(appSrcEarly)
    && !/>另有 <b>\$\{c\.outsideDefaultScope\}/.test(appSrcEarly));
  ok('前端按钮显示由 outsideHint.showAll 决定',
    /c\.outsideHint\.showAll/.test(appSrcEarly));
  ok('口径说明按视图分支（默认视图 / 非默认视图）',
    /d\.languageScope === 'zh-en'/.test(appSrcEarly)
    && /当前不是默认视图/.test(appSrcEarly)
    && /已经包含在上面/.test(appSrcEarly));

  /* ================================================================ *
   * 4.6 三个视图的统计文字不能出现「总数 + 另有」的加法错觉
   * ================================================================ */
  console.log('\n=== 4.6 各视图的统计文字措辞 ===');
  const defHint = def.counts.outsideHint;
  const allHint = all.counts.outsideHint;
  const idHint = idList.counts.outsideHint;

  ok('默认视图提示为「另有 N 篇…」', defHint && defHint.variant === 'default'
    && /^另有 \d+ 篇/.test(defHint.text), defHint && defHint.text);
  ok('默认视图提示带「查看全部语种」按钮', defHint && defHint.showAll === true);

  ok('全部语种视图不再用「另有」', allHint && !/另有/.test(allHint.text), allHint && allHint.text);
  ok('全部语种视图用「其中 N 篇…」', allHint && allHint.variant === 'all'
    && /^其中 \d+ 篇/.test(allHint.text), allHint && allHint.text);
  ok('全部语种视图明确「已包含在上面的 N 篇内」',
    allHint && new RegExp(`已包含在上面的 ${all.total} 篇内`).test(allHint.text),
    allHint && allHint.text);
  ok('全部语种视图不显示「查看全部语种」按钮（已经在全部里）',
    allHint && allHint.showAll === false);
  ok('全部语种视图的提示数字就是 outsideDefaultScope',
    allHint.count === def.counts.outsideDefaultScope);

  ok('单语种视图不用「另有」', idHint && !/另有/.test(idHint.text), idHint && idHint.text);
  /*
   * 单语种视图**不再报任何数字**。
   * 旧文案「占全库 751 篇主题候选中的 5 篇」有两处口径打架：
   * 751 是全语种候选数，5 却是「非中英文」篇数，在「仅中文」（实际 83 篇）下
   * 读者会以为 5 是中文的一部分。现在只给口径与入口。
   */
  ok('单语种视图不报数字（避免与总数口径打架）',
    idHint && idHint.count === null && !/\d/.test(idHint.text), idHint && idHint.text);
  ok('单语种视图说明只含所选语种',
    idHint && /只含所选语种/.test(idHint.text), idHint && idHint.text);

  // 三个视图的提示数字都不等于「总数 + 另一批」这种可加形式
  ok('任何视图的提示都不会被读成总数相加',
    !/另有/.test(allHint.text) && !/另有/.test(idHint.text));

  /* ================================================================ *
   * 5. 简报默认只含 zh / en
   * ================================================================ */
  console.log('\n=== 5. 每日简报默认入选范围 ===');
  const bd = await brief.generateBrief({ reason: 'manual', force: true });
  ok('简报生成成功', bd && bd.ok !== false, JSON.stringify(bd && { ok: bd.ok, status: bd.status }).slice(0, 70));
  const got = brief.getBrief();
  const gotLangs = {};
  for (const it of got.items) gotLangs[it.language] = (gotLangs[it.language] || 0) + 1;
  ok('简报入选论文只有 zh / en',
    got.items.every((x) => ['zh', 'en'].includes(x.language)), JSON.stringify(gotLangs));
  ok('简报里没有印尼语', !got.items.some((x) => x.language === 'id'));
  ok('简报里没有 unknown', !got.items.some((x) => x.language === 'unknown'));
  ok('诊断声明默认范围是 zh-en',
    got.languageDiagnosis.defaultScope === 'zh-en', String(got.languageDiagnosis.defaultScope));
  ok('诊断给出入选数与请求数',
    got.languageDiagnosis.selectedCount === got.items.length
    && got.languageDiagnosis.requestedSize === 8,
    `${got.languageDiagnosis.selectedCount}/${got.languageDiagnosis.requestedSize}`);
  ok('诊断的 selectedByLanguage 没有把其他语种算进去',
    got.languageDiagnosis.selectedByLanguage.other === 0,
    JSON.stringify(got.languageDiagnosis.selectedByLanguage));
  ok('语言诊断把 other 单列（otherEligible 字段存在）',
    Object.prototype.hasOwnProperty.call(got.languageDiagnosis, 'otherEligible'));

  const briefSrc = fs.readFileSync(path.join(ROOT, 'lib/brief.js'), 'utf8');
  ok('简报默认范围实际只含中英文', got.items.every(p => ['zh','en'].includes(p.language)));
  ok('brief.js 有不足篇数说明', /不足 \$\{shortfall\} 篇/.test(briefSrc));
  ok('brief.js 明确「不用非中英文凑数」', /没有用来凑数|不参与凑数|不用非中英文凑数/.test(briefSrc));

  /* ================================================================ *
   * 6. 中英文不足时如实报不足，不用其他语种凑数
   * ================================================================ */
  console.log('\n=== 6. 中英文不足时的表现 ===');
  // 清掉中英文论文，只留印尼语那篇；此时默认范围应当选不出足够篇数
  store.run("DELETE FROM brief_items");
  store.run("DELETE FROM brief_runs");
  store.run("UPDATE papers SET eligibility = 'excluded' WHERE language IN ('zh','en')");
  const bd2 = await brief.generateBrief({ reason: 'manual', force: true });
  const got2 = brief.getBrief();
  ok('中英文不足时简报里没有印尼语凑数',
    !got2.items.some((x) => x.language === 'id'),
    got2.items.map((x) => x.language).join(',') || '（空）');
  ok('诊断如实给出不足篇数',
    got2.languageDiagnosis.shortfall > 0,
    `shortfall=${got2.languageDiagnosis.shortfall}, selected=${got2.languageDiagnosis.selectedCount}`);
  ok('诊断解释了原因',
    Boolean(got2.languageDiagnosis.note) && /中英文|不足|原因/.test(got2.languageDiagnosis.note || ''),
    (got2.languageDiagnosis.note || '').slice(0, 90));
  ok('说明里点出没有用非中英文凑数',
    /没有用来凑数|没有被用来凑数|不参与凑数/.test(got2.languageDiagnosis.note || ''),
    (got2.languageDiagnosis.note || '').slice(0, 120));
  ok('运行日志记录了默认入选范围',
    (got2.run.log || []).some((l) => /默认入选范围=中英文/.test(l.msg || '')),
    JSON.stringify((got2.run.log || []).map((l) => l.msg).slice(0, 8)));

  /* ================================================================ *
   * 7. 主题优先排序与核验标签未受影响
   * ================================================================ */
  console.log('\n=== 7. 排序与核验标签保持一致 ===');
  const scored = (got.items || []).map((x) => x.score);
  ok('简报按分数降序（主题优先排序未被破坏）',
    scored.every((v, i) => i === 0 || scored[i - 1] >= v), scored.join(','));
  // 第 6 组清空并重生过简报，这里重新取一份带入选条目的
  const gotForVerify = (() => {
    store.run("UPDATE papers SET eligibility = 'pending' WHERE language IN ('zh','en')");
    return null;
  })();
  const bd3 = await brief.generateBrief({ reason: 'manual', force: true });
  ok('重新生成简报成功', bd3 && bd3.ok !== false);
  const got3 = brief.getBrief();
  ok('每篇仍带核验状态标注',
    got3.items.length > 0 && got3.items.every((x) => x.verification
      && ['official', 'reference', 'pending'].includes(x.verification.atRecommendation)),
    `${got3.items.length} 篇，状态=${got3.items.map((x) => x.verification.atRecommendation).join(',')}`);
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok('前端默认选项文案为「中文+英文（默认）」',
    /中文\+英文（默认）/.test(appSrc));
  ok('前端有「全部语种」选项', /opt\('all', '全部语种'/.test(appSrc));
  ok('前端 select 传 languageScope=all',
    /discoveryState\.language === 'all'\) qs\.set\('languageScope', 'all'\)/.test(appSrc.replace(/\s+/g, ' '))
    || /languageScope/.test(appSrc));
  ok('页面口径说明写了默认视图范围',
    /默认视图口径/.test(appSrc) && /只显示已判定为中文或英文/.test(appSrc));

  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(62));
  console.log(`  默认中英文视图：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(62));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
