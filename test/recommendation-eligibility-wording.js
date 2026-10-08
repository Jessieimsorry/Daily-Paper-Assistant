'use strict';
/**
 * 推荐资格口径一致性回归测试。
 *
 * 起因（真实页面发现）：2026-09-28 简报第 3 篇《Investigating the effect of VR-mediated
 * pragmatics instruction on L2 refusal strategies》（RELC Journal）标为「参考候选」，
 * 却已进入「今日精选」；而详情页与 README 仍写「不会进入简报精选」。
 *
 * 现在统一后的口径：
 *   · 今日简报 / 今日发现：覆盖全部主题相关论文（含参考候选与待核验），
 *     期刊核验状态只作**标注**，是否入选由主题相关性与新近度决定；
 *   · 期刊条件合格精选：只含官方目录核验合格的论文，核验状态是**门槛**；
 *   · 参考候选与待核验**绝不计入**「期刊条件合格」，也**不进**「合格精选」。
 *
 * 本测试锁定：真实含参考候选的简报、各页面文案一致、README 不再自相矛盾。
 *
 * 运行：node test/recommendation-eligibility-wording.js
 * 采集用注入的模拟实现，不联网、不写正式 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-rw-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

(async () => {
  const store = require('../lib/store');
  const clock = require('../lib/clock');
  const journals = require('../lib/journals');
  const discover = require('../lib/discover');
  const brief = require('../lib/brief');
  const desk = require('../lib/desk');
  const scheduler = require('../lib/scheduler');
  const config = require('../lib/config');

  store.migrate();
  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();
  config.updateSettings({ briefHour: 8, briefMinute: 0, timezone: 'Asia/Shanghai' });

  ok('测试环境与正式 data/ 隔离', store.DB_FILE.startsWith(TEST_DIR), store.DB_FILE);

  const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const journalsSrc = fs.readFileSync(path.join(ROOT, 'lib/journals.js'), 'utf8');

  /* ================================================================ *
   * 1. 构造真实情形：一本参考候选刊 + 一本待核验刊，官方合格为 0
   * ================================================================ */
  console.log('\n=== 1. 构造含参考候选的简报（官方合格为 0） ===');
  journals.importCatalog('ref_ssci',
    '期刊名称,ISSN,JCR年份,JCR学科类别1,分区1,收录数据库,证据状态\n'
    + 'RELC Journal,,2026,LINGUISTICS,Q1,SSCI,公众号截图参考',
    { edition: '2026', reference: 'auto', sourceName: '截图清单.csv' });

  const base = { language: 'en', sources: ['test'] };
  const papers = [
    { ...base, title: 'Investigating the effect of VR-mediated pragmatics instruction on L2 refusal strategies',
      abstract: 'This study examines virtual reality based pragmatic instruction for L2 learners, focusing on refusal strategies and speech acts.',
      journalName: 'RELC Journal', publishedOnline: '2026-09-22' },
    { ...base, title: 'Pragmatic instruction and second language pragmatic competence development',
      abstract: 'This study examines pragmatic instruction and second language pragmatic competence with L2 learners.',
      journalName: 'RELC Journal', publishedOnline: '2026-09-21' },
    { ...base, title: 'Corrective feedback in second language writing classrooms',
      abstract: 'This study examines corrective feedback in second language writing with L2 learners over one semester.',
      journalName: '待核验期刊A', publishedOnline: '2026-09-20' },
    { ...base, title: 'Working memory and second language listening comprehension',
      abstract: 'This study examines working memory and second language listening comprehension among L2 learners of English.',
      journalName: '待核验期刊B', publishedOnline: '2026-09-19' },
  ];
  scheduler.setCollector(async () => {
    discover.persistPapers(papers);
    return { ok: true, queries: 0, rawCount: papers.length, uniqueCandidates: papers.length,
      inserted: papers.length, updatedExisting: 0, eligible: 0, pending: papers.length, excluded: 0, window: {} };
  });

  clock.setClock(() => new Date(Date.UTC(2026, 8, 28, 1, 0)).getTime());  // 北京时间 09:00
  await scheduler.runUpdate({ reason: 'first-run', force: true });
  scheduler.setCollector(null);

  const refPaper = store.get("SELECT * FROM papers WHERE title LIKE 'Investigating the effect of VR%'");
  const pendRow = store.get("SELECT * FROM papers WHERE journal_name = '待核验期刊A'");
  ok('参考候选刊的论文为 reference', refPaper.eligibility === 'reference', refPaper.eligibility);
  ok('待核验刊的论文为 pending', pendRow.eligibility === 'pending', pendRow.eligibility);
  ok('官方合格数为 0', require('../lib/library').libraryStats().eligiblePapers === 0);

  /* ================================================================ *
   * 2. 参考候选可以进今日精选，但必须标注且不计入合格
   * ================================================================ */
  console.log('\n=== 2. 参考候选可以进「今日精选」，但标注与统计口径正确 ===');
  const bd = brief.getBrief();
  ok('简报精选里有条目', bd.items.length > 0, `${bd.items.length} 篇`);
  const refItem = bd.items.find((x) => x.eligibility === 'reference');
  const pendItem = bd.items.find((x) => x.eligibility === 'pending');
  ok('参考候选确实进入了今日精选（这正是本次要统一的口径）', Boolean(refItem),
    refItem ? refItem.title.slice(0, 40) : '（无参考候选入选）');
  ok('待核验论文同样可以进精选', Boolean(pendItem),
    pendItem ? pendItem.title.slice(0, 40) : '（无待核验入选）');

  for (const it of bd.items) {
    const v = it.verification || {};
    ok(`条目标注了核验状态：${it.title.slice(0, 24)}…`,
      ['official', 'reference', 'pending'].includes(v.atRecommendation), v.atRecommendation);
  }
  if (refItem) {
    ok('参考候选条目的 official 标记为 false', refItem.verification.official === false);
    ok('参考候选条目的状态文案含「参考候选」',
      /参考候选/.test(refItem.verification.headline || ''), refItem.verification.headline);
    ok('参考候选条目**不含**「期刊条件合格」字样',
      !/期刊条件合格/.test(JSON.stringify(refItem.verification) + JSON.stringify(refItem.verificationSnapshot || {})),
      refItem.verification.headline);
  }
  if (pendItem) {
    ok('待核验条目的 official 标记为 false', pendItem.verification.official === false);
    ok('待核验条目文案含「待核验」', /待核验/.test(pendItem.verification.headline || ''),
      pendItem.verification.headline);
  }

  /* ================================================================ *
   * 3. 参考候选绝不计入「期刊条件合格」或「合格精选」
   * ================================================================ */
  console.log('\n=== 3. 参考候选不计入合格，也不进合格精选 ===');
  const stats = require('../lib/library').libraryStats();
  ok('统计里官方合格仍为 0', stats.eligiblePapers === 0, String(stats.eligiblePapers));
  ok('参考候选单独计数', stats.referencePapers > 0, String(stats.referencePapers));
  const qual = desk.listQualified({ pageSize: 100 });
  ok('「期刊条件合格精选」为空', qual.total === 0, String(qual.total));
  ok('合格精选不含参考候选', !qual.items.some((x) => x.eligibility === 'reference'));
  ok('合格精选为空时给出原因', Boolean(qual.emptyReason), (qual.emptyReason || '').slice(0, 40));

  /* ================================================================ *
   * 4. 页面文案不再出现「参考候选不进简报精选」这类矛盾
   * ================================================================ */
  console.log('\n=== 4. 页面与源码文案一致性 ===');
  const contradictionPatterns = [
    /也不会进入简报精选/,
    /也不进简报精选/,
    /不会作为今日简报的合格论文/,
    /不会进入简报精选/,
  ];
  for (const re of contradictionPatterns) {
    ok(`app.js 不含矛盾文案 ${re}`, !re.test(appJs));
    ok(`journals.js 不含矛盾文案 ${re}`, !re.test(journalsSrc));
    ok(`README 不含矛盾文案 ${re}`, !re.test(readme));
  }

  ok('详情页明确「参考候选可以进入今日简报」',
    /可以进入<\/b>主题优先的今日简报|可以进入主题优先的今日简报/.test(appJs));
  ok('详情页明确「不计入期刊条件合格」', /不计入<\/b>「期刊条件合格」数量/.test(appJs));
  ok('详情页明确「不会进入期刊条件合格精选」',
    /不会进入<\/b>「期刊条件合格精选」页/.test(appJs));
  ok('待核验也按同一逻辑说明', /待核验<\/b>同理|待核验同理/.test(appJs));

  console.log('\n=== 5. 「今日精选」不会被误读为已核验 ===');
  ok('精选区标题注明「按研究主题选出」', /今日精选（按研究主题选出）/.test(appJs));
  ok('精选区说明「不代表已通过期刊等级核验」',
    /不代表已通过期刊等级核验/.test(appJs));
  ok('有核验状态汇总函数', /function briefVerificationSummary/.test(appJs));
  ok('汇总函数据实说明多少篇未核验',
    /尚未通过官方目录核验/.test(appJs) && /不计入「期刊条件合格」数量/.test(appJs));
  ok('参考候选卡片徽标含「未经官方核验（不计入合格）」',
    /参考候选 · 未经官方核验（不计入合格）/.test(appJs));
  ok('待核验卡片徽标含「不计入合格」',
    /待核验 · 未匹配到官方目录（不计入合格）/.test(appJs));

  console.log('\n=== 6. 目录核验说明不再自相矛盾 ===');
  ok('ref_ssci 的说明承认可进简报',
    /可以进入「主题优先」的今日简报/.test(journalsSrc));
  ok('ref_ssci 的说明同时强调不计入合格',
    /不计入「期刊条件合格」数量，也不会进入「期刊条件合格精选」页/.test(journalsSrc));
  ok('reference 结论的 note 同步更新',
    /可以进入主题优先的今日简报，但会醒目标注为「参考候选」/.test(journalsSrc));

  // 所有会产生「参考候选」的目录类型，hint 必须用同一套完整措辞，
  // 不允许出现「也不进合格精选」这类省略说法（容易被读成「连简报都不进」）。
  // ref_esci 有意排除：它的 hint 作用是声明「ESCI 不是 SSCI」，属于另一种区分义务。
  const refCatalogKeys = ['ref_ssci', 'ref_cssci', 'ref_cssci_ext', 'ref_jcr'];
  for (const key of refCatalogKeys) {
    const hint = (journals.CATALOG_TYPES[key] || {}).hint || '';
    ok(`${key} 的 hint 承认可进简报`, /可以进入「主题优先」的今日简报/.test(hint), hint.slice(0, 70));
    ok(`${key} 的 hint 强调不计入合格`,
      /不计入「期刊条件合格」数量/.test(hint) && /不会进入「期刊条件合格精选」页/.test(hint));
    ok(`${key} 的 hint 不含省略式旧措辞`,
      !/也不进「?合格精选/.test(hint) && !/不进简报/.test(hint));
  }
  const refInfo = journals.eligibilityOf(journals.findJournal({ name: 'RELC Journal' }), config.getSettings());
  ok('运行时 note 不再说「不会作为今日简报的合格论文」',
    !/不会作为今日简报的合格论文/.test(refInfo.note), refInfo.note.slice(0, 80));
  ok('运行时 note 说明可以进简报但不计入合格',
    /可以进入主题优先的今日简报/.test(refInfo.note) && /不计入「期刊条件合格」数量/.test(refInfo.note),
    refInfo.note.slice(0, 100));
  // note / hint 经 esc() 原样显示，不能带 Markdown 的 ** 标记
  ok('note 不含未渲染的 Markdown 标记', !/\*\*/.test(refInfo.note),
    (refInfo.note.match(/\*\*/g) || []).join(''));
  let noteWithMd = 0;
  for (const r of store.all('SELECT * FROM journals LIMIT 400')) {
    const info = journals.eligibilityOf(r, config.getSettings());
    if (/\*\*/.test(info.note || '')) noteWithMd++;
  }
  ok('全库期刊 note 都不含 Markdown 标记', noteWithMd === 0, `含 ** 的 ${noteWithMd} 条`);

  console.log('\n=== 7. README 口径统一 ===');
  ok('README 开头给出「两个口径」对照表', /两个口径必须分清（全文以此为准）/.test(readme));
  ok('README 说明参考候选可进简报',
    /参考候选可以进入主题优先的今日简报/.test(readme));
  ok('README 说明不计入合格且不进合格精选',
    /不计入「期刊条件合格」数量，也不会进入「期刊条件合格精选」页/.test(readme));
  ok('README 说明「是否进简报由主题相关性与新近度决定」',
    /是否进简报由主题相关性与新近度决定/.test(readme));
  ok('README 说明「今日精选」不代表已通过期刊等级核验',
    /「今日精选」不代表已通过期刊等级核验/.test(readme));
  // 旧口径「合格论文立刻进入下一次简报」已修正
  ok('README 不再写「合格论文立刻进入下一次简报」',
    !/合格论文立刻进入下一次简报/.test(readme));

  // 合格精选仍然只含官方合格（口径不能因为这次修改而放松）
  console.log('\n=== 8. 合格精选的口径没有被放松 ===');
  journals.importCatalog('ssci_jcr',
    '期刊名称,ISSN,JCR年份,JCR学科类别1,分区1,收录数据库\nRELC Journal,,2026,LINGUISTICS,Q1,SSCI',
    { edition: '2026', sourceName: '机构JCR（测试）' });
  journals.reconcileJournalFlags();
  const { revalidateAllPapers } = { revalidateAllPapers: null };
  void revalidateAllPapers;
  // 用与 server 相同的重新核验逻辑
  const topics = discover.listTopics(true);
  void topics;
  for (const p of store.all('SELECT * FROM papers')) {
    const jr = journals.findJournal({ issn: p.issn, name: p.journal_name });
    const info = jr ? journals.eligibilityOf(jr, config.getSettings())
      : { status: 'pending', basis: 'pending', note: '' };
    store.run('UPDATE papers SET journal_id=?, eligibility=?, eligibility_basis=?, eligible_official=? WHERE id=?',
      [jr ? jr.id : null, info.status, info.basis, info.officialEligible ? 1 : 0, p.id]);
  }
  const qualAfter = desk.listQualified({ pageSize: 100 });
  const statsAfter = require('../lib/library').libraryStats();
  ok('导入官方目录后，RELC 论文变为官方合格',
    store.get("SELECT eligibility FROM papers WHERE title LIKE 'Investigating the effect of VR%'").eligibility === 'eligible');
  ok('合格精选此时才出现条目', qualAfter.total > 0, String(qualAfter.total));
  ok('合格精选只含官方核验合格的论文',
    qualAfter.items.every((x) => x.eligibility === 'eligible' && x.eligible_official === true));
  ok('合格精选不含待核验论文（未被官方目录覆盖的刊）',
    !qualAfter.items.some((x) => x.eligibility === 'pending'));
  ok('统计口径与合格精选一致', statsAfter.eligiblePapers === qualAfter.total,
    `${statsAfter.eligiblePapers} vs ${qualAfter.total}`);

  /* ================================================================ *
   * 9. 简报卡片的前端渲染包含醒目标注
   * ================================================================ */
  console.log('\n=== 9. 简报卡片的核验标注渲染 ===');
  const escFn = (x) => String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /*
   * 核验渲染已拆成两半：
   *   verificationFaceHtml   —— 卡面上只留「色块 + 一句短说明」
   *   verificationDetailHtml —— 完整说明与证据，进默认收起的「为何推荐 / 来源详情」
   * 本组同时验证两者，确保长说明确实不在卡面、但也没有丢失。
   */
  const vStart = appJs.indexOf('function verificationFaceHtml(it)');
  const vEnd = appJs.indexOf('function shortReasonText(it)');
  const vSrc = appJs.slice(vStart, vEnd);
  const vFns = new Function('esc', 'attr', 'state', vSrc + '; return { verificationFaceHtml, verificationDetailHtml };')(
    escFn, escFn, { currentPaper: null });
  const vRefItem = {
    verification: { atRecommendation: 'reference', official: false, headline: '参考候选：期刊信息来自非官方参考线索，尚未核验' },
    verificationSnapshot: { evidence: [{ catalog: '参考候选：SSCI 收录名单', edition: '2026', basis: '刊名精确匹配' }] },
    eligibility_note: '参考候选（非官方目录）',
  };
  const refHtml = vFns.verificationFaceHtml(vRefItem);
  ok('参考候选卡片渲染出「参考候选」徽标', /参考候选/.test(refHtml));
  ok('参考候选卡片渲染出「不计入合格」', /不计入合格/.test(refHtml));
  ok('参考候选卡片不含「期刊条件合格」', !/期刊条件合格/.test(refHtml));
  ok('卡面核验块只有一句短说明（长度受控）', /证据来自非官方参考名录/.test(refHtml) && refHtml.length < 400,
    `${refHtml.length} 字符`);
  const refDetail = vFns.verificationDetailHtml(vRefItem);
  ok('完整核验说明已移入详情（未丢失）', /参考候选（非官方目录）/.test(refDetail));
  ok('证据来源也移入详情（未丢失）', /参考候选：SSCI 收录名单／2026／刊名精确匹配/.test(refDetail));
  ok('卡面核验块本身不含那段完整说明', !/参考候选（非官方目录）/.test(refHtml));
  const offHtml = vFns.verificationFaceHtml({
    verification: { atRecommendation: 'official', official: true, headline: '期刊条件合格（官方目录已核验）' },
    verificationSnapshot: { evidence: [] }, eligibility_note: '官方目录',
  });
  ok('官方合格卡片渲染出「期刊条件合格（官方目录已核验）」',
    /期刊条件合格（官方目录已核验）/.test(offHtml));
  ok('官方合格卡片用 is-official 修饰类（绿底另有文字说明）', /is-official/.test(offHtml));
  ok('非官方卡片用 is-unofficial 修饰类', /is-unofficial/.test(refHtml));

  /* ================================================================ *
   * 10. 库里的 papers.eligibility_note 不能停留旧口径
   *    （它是发现时写入的冗余副本，判定措辞变更后会漂移）
   * ================================================================ */
  console.log('\n=== 10. 已存论文的资格说明不会停留在旧口径 ===');
  // 本组只验证「修复函数」本身。刻意新建一本**只存在于参考名录**的刊
  // （后续阶段的官方目录不会覆盖它），这样它的判定始终是 reference。
  const refOnlyName = 'Reference Only Journal For Repair';
  const refOnlyIssn = '9999-0001';
  journals.importCatalog('ref_ssci',
    '期刊名称,ISSN,JCR年份,JCR学科类别1,分区1,收录数据库,证据状态\n'
    + `${refOnlyName},${refOnlyIssn},2026,LINGUISTICS,Q2,SSCI,公众号截图参考`,
    { edition: '2026', reference: 'auto', sourceName: '修复用例截图.csv' });
  journals.reconcileJournalFlags();
  const refOnlyRow = store.get('SELECT * FROM journals WHERE name = ?', [refOnlyName]);
  store.run(
    `INSERT INTO papers (title, journal_name, journal_id, language, eligibility, eligibility_basis, eligible_official, eligibility_note, discovery_date)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Repair fixture paper on pragmatic instruction', refOnlyName, refOnlyRow.id, 'en',
      'reference', 'reference', 0, '（待修复）', '2026-09-20']
  );
  const fixturePaper = store.get("SELECT id, journal_id FROM papers WHERE title = 'Repair fixture paper on pragmatic instruction'");
  const refJinfo = journals.eligibilityOf(
    store.get('SELECT * FROM journals WHERE id = ?', [fixturePaper.journal_id]), config.getSettings());
  const isReferenceNow = refJinfo.status === 'reference';

  if (isReferenceNow) {
    // 人为写回旧口径，模拟「历史遗留在库里的说法」
    const staleText = '参考候选（非官方目录）：不计入「期刊条件合格」数量，也不会作为今日简报的合格论文';
    store.run('UPDATE papers SET eligibility_note = ? WHERE id = ?', [staleText, fixturePaper.id]);
    ok('旧口径已写入，作为修复前状态',
      /也不会作为今日简报的合格论文/.test(
        store.get('SELECT eligibility_note FROM papers WHERE id = ?', [fixturePaper.id]).eligibility_note));

    const rep = journals.refreshStoredEligibilityNotes(config.getSettings());
    ok('修复函数报告已修复该行', rep.repaired >= 1, `repaired=${rep.repaired}`);

    const fixed = store.get('SELECT eligibility_note FROM papers WHERE id = ?', [fixturePaper.id]).eligibility_note;
    ok('修复后不再含「也不会作为今日简报的合格论文」',
      !/也不会作为今日简报的合格论文/.test(fixed), fixed.slice(-60));
    ok('修复后说明「可以进入主题优先的今日简报」',
      /可以进入主题优先的今日简报/.test(fixed), fixed.slice(-60));
    ok('修复后说明「不计入期刊条件合格数量」',
      /不计入「期刊条件合格」数量/.test(fixed));

    // 幂等：再次执行不应产生新的写入
    const again = journals.refreshStoredEligibilityNotes(config.getSettings());
    ok('修复函数幂等（二次执行 repaired=0）', again.repaired === 0, `repaired=${again.repaired}`);

    // 全库扫描：凡当前判定为参考候选的刊，其论文都不得残留旧口径
    const allJ = store.all('SELECT * FROM journals');
    let staleCount = 0;
    for (const jr of allJ) {
      if (journals.eligibilityOf(jr, config.getSettings()).status !== 'reference') continue;
      staleCount += store.get(
        "SELECT COUNT(*) c FROM papers WHERE journal_id = ? AND eligibility_note NOT LIKE '%可以进入主题优先的今日简报%'",
        [jr.id]
      ).c;
    }
    ok('参考候选刊的论文都不含旧口径', staleCount === 0, `残留 ${staleCount} 条`);

    // 库里的值应与现算值一致（不再有第三套说法）
    const live = journals.eligibilityOf(
      store.get('SELECT * FROM journals WHERE id = ?', [fixturePaper.journal_id]), config.getSettings()).note;
    const stored = store.get('SELECT eligibility_note FROM papers WHERE id = ?', [fixturePaper.id]).eligibility_note;
    ok('库中说明与现算说明一致（不存在两套说法）', live === stored);
  } else {
    ok('新建的参考候选刊判定为 reference', false, `实际 ${refJinfo.status}`);
  }

  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(62));
  console.log(`  推荐资格口径一致性：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(62));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
