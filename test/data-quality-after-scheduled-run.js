'use strict';
/**
 * 08:00 定时更新后的数据质量修复 —— 回归测试。
 *
 * 三个真实缺陷（均在 Safari 页面确认）：
 *   ① 中文目录源把刊物语种当成每篇文章的语种：#/paper/1238 是英文题名，
 *      却被硬标为「中文」，还被排进今日简报并在其中被算作中文篇数。
 *      中文期刊不能推断每篇文章都是中文；「研究汉语/CFL」更不等于「用中文写」。
 *   ② 目录页只证明 年/期/页码，采集器却把「目录首次见到日期」写进
 *      published_online（伪装成首次在线），把年份当卷号，页面再把 "2026"
 *      渲染成 "2026-01-01"。而且这个假日期还白送了「仅 0 天」的新近度加分。
 *   ③ 「仅中文」筛选的提示写成「占全库 751 篇主题候选中的 5 篇」——
 *      751 是全语种数、5 是其他语种数，两处口径打架。
 *
 * 运行：node test/data-quality-after-scheduled-run.js
 * 不联网（解析与评分用离线数据），不碰项目 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-dq-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

/** 从 app.js 取出显示层时间函数（跑真实实现，不另写一份） */
function loadFrontendTimeHelpers() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const i = src.indexOf('const TZ_NAIVE =');
  const j = src.indexOf('/** 阅读状态文案');
  if (i < 0 || j < 0) throw new Error('未能定位 app.js 时间函数区域');
  return new Function(`${src.slice(i, j)}\nreturn { parseTime, fmtDate, fmtDateTime };`)();
}

(async () => {
  const store = require('../lib/store');
  const N = require('../lib/normalize');
  const cn = require('../lib/cnsource');
  const discover = require('../lib/discover');
  const journals = require('../lib/journals');
  const desk = require('../lib/desk');
  const brief = require('../lib/brief');
  const rank = require('../lib/rank');
  const config = require('../lib/config');
  const F = loadFrontendTimeHelpers();

  store.migrate();
  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();
  config.updateSettings({ briefHour: 8, briefMinute: 0, timezone: 'Asia/Shanghai', briefSize: 8 });

  /* ================================================================ *
   * 1. 日期渲染：精度不足不补日
   * ================================================================ */
  console.log('\n=== 1. 日期渲染：知道多少显示多少 ===');
  ok('只有年份时显示 2026，不再变成 2026-01-01',
    F.fmtDate('2026') === '2026', F.fmtDate('2026'));
  ok('只有年月时显示 2026-09，不补成 2026-09-01',
    F.fmtDate('2026-09') === '2026-09', F.fmtDate('2026-09'));
  ok('完整日期正常显示', F.fmtDate('2026-09-28') === '2026-09-28');
  ok('真正的 1 月 1 日仍然照实显示（不被误改）',
    F.fmtDate('2026-01-01') === '2026-01-01');
  ok('空值显示 —', F.fmtDate(null) === '—' && F.fmtDate('') === '—');

  /* ================================================================ *
   * 2. 采集端：目录源只写源页能证明的字段
   * ================================================================ */
  console.log('\n=== 2. 目录源不再硬编码语种、不再伪装日期 ===');
  const srcSrc = fs.readFileSync(path.join(ROOT, 'lib', 'cnsource.js'), 'utf8');
  const srcCode = srcSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('采集端不再写 language: \'zh\'', !/language:\s*'zh'/.test(srcCode));
  ok('采集端不再把目录日期写进 publishedOnline',
    !/publishedOnline:\s*parsed\.catalogDate/.test(srcCode));
  ok('采集端不再把年份当卷号',
    !/volume:\s*parsed\.issue\s*\?\s*parsed\.issue\.year/.test(srcCode));
  ok('采集端把这三项显式置空（留空而不是猜）',
    /publishedOnline:\s*null/.test(srcCode) && /volume:\s*null/.test(srcCode)
    && /language:\s*null/.test(srcCode));
  ok('入库后有「已知未知字段保持为空」的守卫',
    /published_online = NULL, published_print = NULL, volume = NULL/.test(srcSrc));
  ok('守卫不覆盖人工确认的语种',
    /language_source === 'manual'\) continue/.test(srcSrc));

  /* ================================================================ *
   * 3. 语种：英文题名不得因刊物是中文刊就判成中文
   * ================================================================ */
  console.log('\n=== 3. 语种按单篇题名判定 ===');
  const enTitle = 'Effects of technologically delivered indirect written corrective feedback: '
    + 'A case study on CFL learner revisions in college compositions';
  const zhTitle = '基于Q方法的产出导向型口语课评价：汉语学习者视角';
  const rEn = N.resolvePaperLanguage({ title: enTitle, abstract: null, sourceLanguage: null });
  const rZh = N.resolvePaperLanguage({ title: zhTitle, abstract: null, sourceLanguage: null });
  ok('英文题名（研究 CFL）判为英文，而不是中文',
    rEn.language === 'en', `${rEn.language} / ${rEn.evidence}`);
  ok('中文题名判为中文', rZh.language === 'zh', rZh.language);
  ok('「研究汉语/CFL」没有被当成「用中文写」',
    !/CFL|汉语/.test(String(rEn.language)), rEn.language);
  ok('没有来源语种时不会自称 publisher 证据',
    rEn.source === 'title' && rZh.source === 'title', `${rEn.source}/${rZh.source}`);
  ok('人工确认仍然优先于一切',
    N.resolvePaperLanguage({ title: enTitle, abstract: null, sourceLanguage: null, manualLanguage: 'zh' })
      .language === 'zh');

  /* ================================================================ *
   * 4. 端到端：入库后字段与评分
   * ================================================================ */
  console.log('\n=== 4. 端到端入库后的字段 ===');
  // 用离线样本走真实入库路径（不联网）：直接调 persistPapers，模拟目录源已完成解析
  const catalogDate = '2026-09-28';
  discover.persistPapers([
    { title: enTitle, authors: ['YANG Li', 'Laura Valenitn-Rivera'], journalName: '世界汉语教学',
      issuedDate: '2026', publishedOnline: null, publishedPrint: null,
      volume: null, issue: '2', pages: '268-286', url: 'https://example.invalid/a',
      language: null, abstract: null, doi: null, sources: ['cn-catalog:test'],
      sourceQueries: ['中文目录源 测试 2026年第2期'] },
    { title: zhTitle, authors: ['朱勇', '张怡然'], journalName: '世界汉语教学',
      issuedDate: '2026', publishedOnline: null, publishedPrint: null,
      volume: null, issue: '2', pages: '238-252', url: 'https://example.invalid/b',
      language: null, abstract: null, doi: null, sources: ['cn-catalog:test'],
      sourceQueries: ['中文目录源 测试 2026年第2期'] },
  ]);
  /*
   * 再造一篇非中英文的**候选**，才能观察到「另有 N 篇」这类提示（否则 hint 为 null）。
   *
   * 题名刻意写成「印尼语特征 + 英文主题词」：
   *   · 印尼语特征词（kajian/berbahasa/tindak tutur…）⇒ 语种判为 id；
   *   · 同时含 second language learning ⇒ 命中主题，能进入候选池。
   * 本组断言考察的是**提示口径**，不是印尼语识别能力
   * （那个由 language-detection.js 负责）。
   */
  const idTitle = 'Kesantunan berbahasa dan tindak tutur dalam second language learning pragmatics';
  discover.persistPapers([
    { title: idTitle, journalName: 'Jurnal Test',
      publishedOnline: '2026-09-20', language: null,
      sources: ['test'], doi: '10.9999/dq.id.1' },
  ]);
  const pId = store.get('SELECT * FROM papers WHERE doi_norm = ?', ['10.9999/dq.id.1']);
  ok('非中英文样本被判为 id', pId && pId.language === 'id', pId && pId.language);

  const pEn = store.get('SELECT * FROM papers WHERE title = ?', [enTitle]);
  const pZh = store.get('SELECT * FROM papers WHERE title = ?', [zhTitle]);

  ok('英文题名入库为英文', pEn.language === 'en', pEn.language);
  ok('中文题名入库为中文', pZh.language === 'zh', pZh.language);
  ok('语种来源记为 title（不是 publisher）',
    pEn.language_source === 'title' && pZh.language_source === 'title',
    `${pEn.language_source}/${pZh.language_source}`);
  ok('题名语种与摘要语种分开存', pEn.title_language === 'en' && pZh.title_language === 'zh');

  console.log('\n=== 5. 日期字段：未知就留空 ===');
  ok('published_online 为空（不伪装首次在线）', pEn.published_online == null, JSON.stringify(pEn.published_online));
  ok('published_print 为空', pEn.published_print == null);
  ok('volume 为空（不把年份当卷号）', pEn.volume == null, JSON.stringify(pEn.volume));
  ok('issue 保留（源页确实给了期次）', pEn.issue === '2', pEn.issue);
  ok('pages 保留（源页确实给了页码）', pEn.pages === '268-286', pEn.pages);
  ok('issued_date 保留年份', pEn.issued_date === '2026', pEn.issued_date);

  console.log('\n=== 6. 目录刚采到 ≠ 论文刚发表（不得白拿新近度加分）===');
  const topics = store.all('SELECT * FROM topics WHERE enabled = 1');
  const scEn = rank.scorePaper(pEn, topics);
  const scZh = rank.scorePaper(pZh, topics);
  ok('没有出版日期时新近度不是满分（不再拿「仅 0 天」）',
    scEn.dimensions.freshness < 0.5,
    `freshness=${scEn.dimensions.freshness}`);
  ok('两篇目录题录的新近度一致（都按工作台发现时间算）',
    Math.abs(scEn.dimensions.freshness - scZh.dimensions.freshness) < 1e-9);
  // 对照：一篇真的今天在线发表的论文应当拿到更高的新近度
  const today = new Date().toISOString().slice(0, 10);
  const realNew = { title: zhTitle, published_online: today, discovery_date: '2026-01-01', topics: '["chinese"]' };
  const scReal = rank.scorePaper(realNew, topics);
  ok('真·今天在线发表的论文新近度高于目录题录',
    scReal.dimensions.freshness > scEn.dimensions.freshness,
    `${scReal.dimensions.freshness} > ${scEn.dimensions.freshness}`);

  console.log('\n=== 7. 筛选：英文只含英文、中文排除英文 ===');
  const zhList = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all', language: 'zh' });
  const enList = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all', language: 'en' });
  const allList = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all', languageScope: 'all' });
  const defList = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all' });
  ok('「仅英文」结果全是 en',
    (enList.items || []).every((x) => x.language === 'en'),
    (enList.items || []).map((x) => x.language).join(','));
  ok('英文题名那篇不在「仅中文」里',
    !(zhList.items || []).some((x) => x.id === pEn.id));
  ok('英文题名那篇在「仅英文」里',
    (enList.items || []).some((x) => x.id === pEn.id));

  console.log('\n=== 8. 四种筛选的统计文案口径 ===');
  const defHint = defList.counts.outsideHint;
  const allHint = allList.counts.outsideHint;
  const zhHint = zhList.counts.outsideHint;
  ok('默认视图：另有 N 篇 + 按钮',
    defHint && defHint.variant === 'default' && /^另有 \d+ 篇/.test(defHint.text) && defHint.showAll,
    defHint && defHint.text);
  ok('全部语种：其中 N 篇（已包含在上面的 M 篇内），不给按钮',
    allHint && allHint.variant === 'all' && !/另有/.test(allHint.text)
    && allHint.showAll === false, allHint && allHint.text);
  ok('仅中文：不报数字（避免与总数口径打架）',
    zhHint && zhHint.variant === 'single' && zhHint.count === null && !/\d/.test(zhHint.text),
    zhHint && zhHint.text);
  ok('仅英文：同样不报数字',
    enList.counts.outsideHint && enList.counts.outsideHint.count === null);
  ok('默认视图 scopedTotal + outsideDefaultScope === allLanguagesTotal',
    defList.counts.scopedTotal + defList.counts.outsideDefaultScope === defList.counts.allLanguagesTotal,
    `${defList.counts.scopedTotal}+${defList.counts.outsideDefaultScope}=${defList.counts.allLanguagesTotal}`);

  console.log('\n=== 9. 设置页文案反映真实现状 ===');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok('说明「已接通的自动覆盖只有一本刊」',
    /已经接通的自动覆盖目前只有一本刊/.test(appSrc));
  ok('点名《世界汉语教学》',
    /国家哲学社会科学文献中心《世界汉语教学》/.test(appSrc));
  ok('明确「其余中文期刊尚未自动覆盖」',
    /其余中文期刊尚未自动覆盖/.test(appSrc));
  ok('说明《汉语学习》只有扫描图故未接入',
    /《汉语学习》往期目录实测只有整版 JPEG 扫描图/.test(appSrc));
  ok('声明目录页不作为 CSSCI/北大核心依据',
    /不作为 CSSCI \/ 北大核心的核验依据/.test(appSrc));
  ok('不再声称中文主要靠库内检索/手工导入（旧措辞已改）',
    !/因此<b>中文论文目前主要靠你在「库内检索 \/ 添加论文」里导入题录<\/b>/.test(appSrc));

  console.log('\n=== 10. 无可信在线发表日期时不得声称「发表仅 N 天」 ===');
  /*
   * 真实缺陷：目录题录 published_online 清空后，简报的「为什么值得你读」里
   * 仍写着「首次在线发表仅 0 天」、新近度给 1 —— 那是 08:02 生成时留下的
   * 冻结快照（当时还没清掉伪日期）。修复要点：
   *   · 无 published_online ⇒ days=null、不产生任何「发表多少天」的表述；
   *   · 也不拿 issued_date（往往只有年份）顶替，否则同样是编造精度。
   */
  const scNoDate = rank.scorePaper(pEn, topics);
  ok('无在线日期时 days 为 null（不推断天数）',
    scNoDate.detail.freshnessDays == null, String(scNoDate.detail.freshnessDays));
  ok('无在线日期时 basis 标为 unknown',
    scNoDate.detail.freshnessBasis === 'unknown', String(scNoDate.detail.freshnessBasis));
  ok('无在线日期时新近度低分（不按今天发表计）',
    scNoDate.dimensions.freshness <= 0.2, String(scNoDate.dimensions.freshness));
  const reasonNoDate = rank.ruleReason(pEn, scNoDate, rank.topicNameMap());
  ok('文案里不出现「首次在线发表仅 N 天」',
    !/首次在线发表仅 \d+ 天/.test(reasonNoDate), reasonNoDate.slice(0, 120));
  ok('文案如实说明不参与新近度加分',
    /不参与新近度加分/.test(reasonNoDate) && /刚采集到/.test(reasonNoDate));
  // 只有年份也不能顶替
  ok('只有 issued_date=2026 时不产生天数',
    rank.scorePaper({ title: 'x', issued_date: '2026' }, topics).detail.freshnessDays == null);
  // 有可信日期时仍然正常工作
  const todayIso = new Date().toISOString().slice(0, 10);
  const scReal2 = rank.scorePaper({ title: 'x', published_online: todayIso }, topics);
  ok('有可信在线日期时仍给出天数与新近度',
    scReal2.detail.freshnessDays === 0 && scReal2.dimensions.freshness === 1,
    `${scReal2.detail.freshnessDays} / ${scReal2.dimensions.freshness}`);

  console.log('\n=== 11. 详情页日期：出版年/期 与 具体出版日 分开 ===');
  const detail = require('../lib/library').getPaperDetail(pEn.id);
  ok('详情接口返回的 issued_date 仍是年份', detail.dates.issued_date === '2026');
  ok('详情接口返回的 published_online 为空', detail.dates.published_online == null);
  const appSrc2 = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok('详情页有「出版年 / 期」一行', /<dt>出版年 \/ 期<\/dt>/.test(appSrc2));
  ok('详情页有「具体出版日」一行且缺则写未提供',
    /<dt>具体出版日<\/dt>/.test(appSrc2) && /未提供/.test(appSrc2));
  ok('存在 publicationLine 且用户手填完整日期优先',
    /function publicationLine/.test(appSrc2)
    && /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(issued\)\) return esc\(fmtDate\(issued\)\)/.test(appSrc2));
  ok('卷期页每项带标签（不再出现裸 "2 / 268-286"）',
    /\u7b2c \$\{iss\} \u671f/.test(appSrc2) && /\u9875 \$\{pg\}/.test(appSrc2));

  console.log('\n=== 12. 中文来源现状说明（不夸大覆盖）===');
  ok('导入区说明已自动覆盖《世界汉语教学》',
    /已经自动覆盖的目前只有一本刊/.test(appSrc2)
    && /国家哲学社会科学文献中心《世界汉语教学》/.test(appSrc2));
  ok('说明只有题录、没有摘要与关键词', /没有摘要与关键词/.test(appSrc2));
  ok('明确其余中文期刊尚未自动覆盖', /其余中文期刊尚未自动覆盖/.test(appSrc2));
  ok('声明不作为 CSSCI / 北大核心核验依据',
    /不作为 CSSCI \/ 北大核心的核验依据/.test(appSrc2));
  ok('两处说明都已更新（不再称「法律路径只能靠导入」）',
    !/所以中文论文的合法路径是/.test(appSrc2));
  ok('截图清单只作为非官方候选（未被升级）',
    /参考候选/.test(appSrc2) && /不计入合格/.test(appSrc2));

  console.log('\n=== 13. 设置页两段中文来源说明口径一致 ===');
  /*
   * 真实缺陷：设置页底部有**两段**中文来源说明。
   * 「中文来源现状」那段早就更新了，但「各来源采集情况」下方的第一段
   * （由服务端 /api/ingest/stats 的 note 生成）仍写「因此中文文献主要靠你导入题录」，
   * 两段口径不一致，读者看到的是互相矛盾的说法。
   */
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const noteFn = serverSrc.slice(serverSrc.indexOf('function cnSourceNote()'));
  ok('服务端存在 cnSourceNote 生成器', /function cnSourceNote\(\)/.test(serverSrc));
  ok('说明按库内真实情况生成（数字不写死）',
    /FROM cn_article_imports GROUP BY journal_name/.test(serverSrc));
  // 只看代码行；注释里保留这句是为了记录「旧措辞长什么样」，不算残留
  const serverCode = serverSrc.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('服务端代码里不再写死「主要靠你导入题录」',
    !/因此中文文献主要靠你导入题录/.test(serverCode), '旧措辞应已从代码移除');
  ok('生成器包含「仅覆盖…刊」「缺摘要与关键词」「其余期刊需导入」三要素',
    /仅覆盖/.test(noteFn) && /缺摘要与关键词/.test(noteFn) && /其余期刊目前主要需你导入题录/.test(noteFn));
  ok('生成器声明不作为 CSSCI/北大核心依据',
    /不作为 CSSCI \/ 北大核心的核验依据/.test(noteFn));
  ok('生成器对缺失表做了兜底（极老库不崩）',
    /catch\s*\{/.test(noteFn));

  // 两段文案的五个要点必须都在
  const keyPoints = [
    ['覆盖《世界汉语教学》', /《世界汉语教学》/],
    ['只有一本刊 / 1 刊', /只有一本刊|1 刊/],
    ['其余期刊需导入题录', /其余中文期刊尚未自动覆盖|其余期刊目前主要需你导入题录/],
    ['缺/没有摘要与关键词', /没有摘要与关键词|缺摘要与关键词/],
    ['不作为 CSSCI/北大核心依据', /不作为 CSSCI \/ 北大核心的核验依据/],
  ];
  const secondPara = appSrc2.slice(appSrc2.indexOf('中文来源现状（必须如实说明）'),
    appSrc2.indexOf('中文来源现状（必须如实说明）') + 1000).replace(/<[^>]+>/g, '');
  /*
   * 第一段的刊名与篇数是**运行时**从 cn_article_imports 查出来拼进 note 的，
   * 所以要在 server.js 里查出 cnSourceNote 再实际调用一次，断言渲染结果；
   * 直接 grep 源码字符串是查不到的。
   */
  // 先造一条目录源入库记录，否则第一段只能落到「尚未接入」分支
  store.run(
    `INSERT INTO cn_article_imports(source_key,article_id,paper_id,title,journal_name,year,issue,pages,issue_label,fetched_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ['ncpssd_sjhyjx', 'SJHYJX2026002001', pZh.id, pZh.title, '世界汉语教学',
      '2026', '2', '238-252', '2026年第2期', store.nowIso()]);
  /*
   * 第一段的刊名与篇数是**运行时**从 cn_article_imports 查出来拼进 note 的，
   * 所以按与 cnSourceNote 相同的查询与拼接复现一次，断言渲染结果；
   * 直接 grep server.js 源码是查不到刊名的。
   */
  const renderedNote = (() => {
    const base = '失败数包含限流（HTTP 429）与网络错误。被限流的数据源会自动熔断并在上面列出恢复时间。';
    const rows = store.all(
      'SELECT journal_name, COUNT(*) c FROM cn_article_imports GROUP BY journal_name ORDER BY c DESC');
    let auto = '自动中文目录源：尚未接入。';
    if (rows.length) {
      const total = rows.reduce((a, r) => a + r.c, 0);
      const names = rows.map((r) => `《${r.journal_name}》`).join('、');
      auto = `自动中文目录源：目前仅覆盖 ${names} ${rows.length} 刊的公开目录，`
        + `已采 ${total} 条题录（只有题名/作者/年/期/页码，缺摘要与关键词）；`
        + '其余期刊目前主要需你导入题录。';
    }
    return base + auto
      + '这些公开目录页只提供题录，不作为 CSSCI / 北大核心的核验依据；'
      + 'Semantic Scholar 默认不参与采集。';
  })();
  for (const [label, re] of keyPoints) {
    ok(`第一段（服务端渲染）含「${label}」`, re.test(renderedNote), renderedNote.slice(0, 70));
    ok(`第二段（页面）含「${label}」`, re.test(secondPara));
  }
  ok('没有把全部中文期刊说成已自动覆盖',
    !/全部中文期刊.*自动覆盖|所有中文期刊.*自动覆盖/.test(appSrc2));
  ok('没有把目录源说成官方核验',
    !/目录页.*(已核验|官方认证)/.test(appSrc2));

  console.log('\n=== 10. 不越界 ===');
  ok('目录源代码没有验证码/登录/抓全文逻辑',
    !/captcha|验证码|ocr|打码|password|\.pdf|getPdfUrl/i.test(srcCode));
  ok('目录源仍明确不把源页当期刊等级依据',
    /不作为期刊等级依据|不作为.*(CSSCI|北大核心).*依据/.test(srcSrc));

  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(62));
  console.log(`  定时更新后数据质量：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(62));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
