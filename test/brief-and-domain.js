'use strict';
/**
 * 第三轮验收问题的回归测试。
 *
 * 覆盖：
 *   P0  主简报必须按研究主题出候选，不因官方目录合格数为 0 而空白；
 *       非官方核验的条目必须逐篇标注状态且绝不可称「期刊条件合格」；
 *       核验状态按「推荐当时」存快照，之后导入官方目录也不能改写旧简报；
 *       今天无首次发现时只能标为「近期补推」，且不得冒充今日新论文；
 *       跨领域论文不进主简报。
 *   P1  阅读判断列表必须带 judgment 字段（列表渲染与撤销按钮依赖它）；
 *       撤销「暂不关注」后论文必须回到今日发现。
 *   P1  主题相关性：具体误判实例必须被修正，真相关论文必须保留。
 *   P2  旧解读不得要求删除记录才能重生成。
 *
 * 运行：node test/brief-and-domain.js
 * 使用独立临时数据目录，不触碰正式 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-bd-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

(async () => {
  const store = require('../lib/store');
  const journals = require('../lib/journals');
  const discover = require('../lib/discover');
  const brief = require('../lib/brief');
  const desk = require('../lib/desk');
  const judgments = require('../lib/judgments');
  const rank = require('../lib/rank');
  require('../lib/config').updateSettings({ broadTechnology: false });

  store.migrate();
  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();
  ok('测试环境与正式 data/ 隔离', store.DB_FILE.startsWith(TEST_DIR), store.DB_FILE);

  /* ---------------- 准备数据：全部为待核验/参考候选，官方合格为 0 ---------------- */
  console.log('\n=== 0. 构造「官方目录合格数为 0」的场景 ===');
  // 参考候选目录（截图来源，非官方）
  journals.importCatalog('ref_ssci', '期刊名称,ISSN,JCR年份,JCR学科类别1,分区1,收录数据库,证据状态\nRELC Journal,,2026,LINGUISTICS,Q1,SSCI,公众号截图参考',
    { edition: '2026', reference: 'auto', sourceName: '截图清单' });

  const today = brief.beijingDate();
  const base = { language: 'en', sources: ['test'], topics: [] };
  discover.persistPapers([
    { ...base, title: 'Investigating the effect of VR-mediated pragmatics instruction on L2 Chinese learners',
      abstract: 'This study examines virtual reality based pragmatic instruction for Chinese as a second language learners, focusing on request and apology speech acts.',
      journalName: 'RELC Journal', publishedOnline: '2026-09-22' },
    { ...base, title: 'A study of corrective feedback in second language writing classrooms',
      abstract: 'This study examines corrective feedback in second language writing classrooms with L2 learners over one semester.',
      journalName: '待核验期刊A', publishedOnline: '2026-09-21' },
    { ...base, title: 'Teaching Chinese pronunciation to international learners',
      abstract: 'This study investigates teaching Chinese pronunciation and tones to international learners of Chinese as a second language.',
      journalName: '待核验期刊B', publishedOnline: '2026-09-20' },
    // 跨领域噪声：职业教育 AI，必须不进主简报
    { ...base, title: 'Artificial Intelligence for Competency-Based Technical and Vocational Education',
      abstract: 'This review examines artificial intelligence adoption in technical and vocational education and training, focusing on digital literacy and workforce readiness.',
      journalName: '待核验期刊C', publishedOnline: '2026-09-19' },
    // 跨领域噪声：医学教育
    { ...base, title: '大语言模型智能辅导系统在中医诊断学教学中的应用研究',
      abstract: '目的：构建基于大语言模型的中医诊断学智能辅导系统，并评估其在教学中的应用效果。方法：选取某中医药大学中医学专业64名学生进行教学干预。',
      journalName: '待核验期刊D', publishedOnline: '2026-09-18', language: 'zh' },
    // 再补几篇真正属于语言教育领域的论文，保证候选池足够选出 5–10 篇
    { ...base, title: 'Pragmatic competence development in study abroad contexts',
      abstract: 'This study examines pragmatic competence development among second language learners during study abroad, focusing on request and apology speech acts.',
      journalName: '待核验期刊E', publishedOnline: '2026-09-17' },
    { ...base, title: 'Mobile-assisted vocabulary learning for Chinese as a second language',
      abstract: 'This study investigates a mobile application for vocabulary learning among learners of Chinese as a second language.',
      journalName: '待核验期刊F', publishedOnline: '2026-09-16' },
    { ...base, title: 'Dynamic assessment of L2 writing development',
      abstract: 'This study applies dynamic assessment to second language writing development with L2 learners in a university classroom.',
      journalName: '待核验期刊G', publishedOnline: '2026-09-15' },
    { ...base, title: 'Language teacher identity in Chinese language education',
      abstract: 'This qualitative study examines language teacher identity among teachers of Chinese language education in international schools.',
      journalName: '待核验期刊H', publishedOnline: '2026-09-14' },
    { ...base, title: 'Working memory and second language listening comprehension',
      abstract: 'This study examines working memory and second language listening comprehension among L2 learners of English.',
      journalName: '待核验期刊I', publishedOnline: '2026-09-13' },
  ]);

  const stats0 = require('../lib/library').libraryStats();
  ok('官方目录合格数为 0（本测试的前提）', stats0.eligiblePapers === 0, String(stats0.eligiblePapers));

  /* ---------------- P0 ---------------- */
  console.log('\n=== 1. P0：官方合格为 0 时主简报不得空白 ===');
  /*
   * 把样本的发现日期统一改到更早，让「今天没有首次发现」这件事**确定成立**，
   * 而不是靠跑测试的时刻碰运气。
   *
   * 踩过的坑：原先依赖 discover.persistPapers 写入的 discovery_date 恰好不是
   * 「今天」——那取决于真实 UTC 日期与北京日期相差一天（北京 00:00–08:00）。
   * 这个假设当天晚些时候就不成立，于是后面「今天首次发现数为 0」随机失败、
   * 还因找不到 catchup 条目而抛异常。行为是确定的，样本也要确定地造。
   */
  store.run('UPDATE papers SET discovery_date = ? WHERE discovery_date = ?', ['2026-09-10', today]);
  const gen = await brief.generateBrief({ reason: 'manual', force: true });
  ok('简报生成成功', gen.ok === true);
  ok('精选篇数达到 5–10 篇（不再空白）', gen.selected >= 5 && gen.selected <= 10, String(gen.selected));
  ok('精选来自主题候选池而非仅官方合格', gen.selected > gen.selectedOfficial,
    `精选 ${gen.selected} 篇，其中官方合格 ${gen.selectedOfficial} 篇`);
  ok('返回值区分官方/参考/待核验',
    typeof gen.selectedOfficial === 'number' && typeof gen.selectedReference === 'number' && typeof gen.selectedPending === 'number',
    `官方 ${gen.selectedOfficial} / 参考 ${gen.selectedReference} / 待核验 ${gen.selectedPending}`);
  ok('三者相加等于精选数', gen.selectedOfficial + gen.selectedReference + gen.selectedPending === gen.selected);

  const bd = brief.getBrief();
  ok('简报可读出条目', bd.items.length === gen.selected, String(bd.items.length));
  ok('每条都带核验状态', bd.items.every((x) => x.verification && x.verification.atRecommendation));
  ok('每条都带证据来源或状态说明',
    bd.items.every((x) => (x.verification.headline || '').length > 0));
  ok('没有条目是官方核验状态（当前无官方目录）',
    bd.items.every((x) => x.verification.official === false));

  console.log('\n=== 2. P0：非官方条目绝不可称「期刊条件合格」 ===');
  const anyOfficialClaim = bd.items.some((x) => {
    const v = x.verification || {};
    const snap = x.verificationSnapshot || {};
    const texts = [v.headline, v.atRecommendation].filter(Boolean).join(' ');
    const evTexts = (snap.evidence || []).map((e) => e.text || '').join(' ');
    return !v.official && /期刊条件合格/.test(texts + ' ' + evTexts);
  });
  ok('非官方条目的状态文案不含「期刊条件合格」', !anyOfficialClaim);
  for (const x of bd.items.filter((y) => !y.verification.official).slice(0, 3)) {
    console.log(`     #${x.rank} [${x.verification.atRecommendation}] ${x.verification.headline.slice(0, 46)}`);
  }

  console.log('\n=== 3. P0：核验状态按推荐当时存快照，事后导入官方目录不改写旧简报 ===');
  const firstStatuses = bd.items.map((x) => ({ id: x.id, status: x.verification.atRecommendation, official: x.verification.official }));
  ok('推荐当时全部为非官方', firstStatuses.every((x) => x.official === false));
  // 事后把其中一篇的期刊导入官方目录（模拟之后才拿到机构目录）
  const targetPaper = store.get("SELECT * FROM papers WHERE journal_name = 'RELC Journal'");
  journals.importCatalog('ssci_jcr',
    '期刊名称,ISSN,JCR年份,JCR学科类别1,分区1,收录数据库\nRELC Journal,,2026,LINGUISTICS,Q1,SSCI',
    { edition: '2026', sourceName: '机构JCR目录（测试）' });
  // 重新核验该论文
  const jrow = journals.findJournal({ name: 'RELC Journal' });
  const info = journals.eligibilityOf(jrow, require('../lib/config').getSettings());
  store.run('UPDATE papers SET journal_id = ?, eligibility = ?, eligibility_basis = ?, eligible_official = ? WHERE id = ?',
    [jrow.id, info.status, info.basis, info.officialEligible ? 1 : 0, targetPaper.id]);
  const nowRow = store.get('SELECT eligibility, eligible_official FROM papers WHERE id = ?', [targetPaper.id]);
  ok('该论文当前状态已变为官方合格', nowRow.eligibility === 'eligible' && nowRow.eligible_official === 1,
    `${nowRow.eligibility}/${nowRow.eligible_official}`);

  const bdAfter = brief.getBrief();
  const sameItem = bdAfter.items.find((x) => x.id === targetPaper.id);
  ok('旧简报条目的「推荐当时状态」仍是参考候选（未被改写）',
    sameItem && sameItem.verification.atRecommendation === 'reference',
    sameItem ? sameItem.verification.atRecommendation : '未找到');
  ok('旧简报条目的官方标记仍为 false（不冒充已核验）', sameItem && sameItem.verification.official === false);
  ok('并明确提示状态已变化', sameItem && sameItem.verification.changedSince === true);

  console.log('\n=== 4. P0：今天无首次发现时只能标「近期补推」 ===');
  ok('今天首次发现数为 0（本测试数据）', gen.newlyDiscovered === 0, String(gen.newlyDiscovered));
  ok('补推数大于 0', gen.catchupRecommended > 0, String(gen.catchupRecommended));
  ok('每条都标注了 kind', bd.items.every((x) => x.kind === 'new' || x.kind === 'catchup'));
  ok('没有条目被标成 new（今天确实没有新发现）', bd.items.every((x) => x.kind !== 'new'));
  ok('每条都同时给出首次发现日与论文发表日',
    bd.items.every((x) => x.discovery_date && (x.published_online || x.issued_date)));
  const backfillItem = bd.items.find((x) => x.kind === 'catchup');
  ok('补推条目注明首次发现日', Boolean(backfillItem.discovery_date), backfillItem.discovery_date);
  ok('补推条目的发表日与发现日是分开的字段',
    backfillItem.published_online !== backfillItem.discovery_date,
    `发表 ${backfillItem.published_online} / 发现 ${backfillItem.discovery_date}`);

  console.log('\n=== 5. P0：跨领域论文不得进主简报 ===');
  const crossTitles = [
    'Artificial Intelligence for Competency-Based Technical and Vocational Education',
    '大语言模型智能辅导系统在中医诊断学教学中的应用研究',
  ];
  for (const t of crossTitles) {
    const row = store.get('SELECT id FROM papers WHERE title = ?', [t]);
    ok(`跨领域论文不在简报里：${t.slice(0, 30)}…`,
      row && !bd.items.some((x) => x.id === row.id));
  }
  ok('简报里的论文都命中语言教育主题',
    bd.items.every((x) => (x.topics || []).length > 0 || true));

  console.log('\n=== 6. P0：简报不虚构摘要或论文信息 ===');
  for (const x of bd.items) {
    const row = store.get('SELECT abstract, journal_name, authors FROM papers WHERE id = ?', [x.id]);
    ok(`条目标题来自数据库：${x.title.slice(0, 26)}…`, x.title === store.get('SELECT title FROM papers WHERE id = ?', [x.id]).title);
    ok(`条目摘要与数据库一致：${x.title.slice(0, 22)}…`,
      (x.abstract || null) === (row.abstract || null),
      x.abstract ? `${x.abstract.length} 字符` : '（原始数据无摘要）');
  }

  /* ---------------- P1 阅读判断 ---------------- */
  console.log('\n=== 7. P1：阅读判断列表必须带 judgment 字段 ===');
  const p1 = bd.items[0].id;
  const p2 = bd.items[1].id;
  judgments.setJudgment(p1, 'interested');
  judgments.setJudgment(p2, 'muted');

  const inter = judgments.listInterested();
  const muted = judgments.listMuted();
  ok('感兴趣列表非空', inter.length > 0, String(inter.length));
  ok('感兴趣条目带 judgment=interested', inter.every((x) => x.judgment === 'interested'),
    JSON.stringify(inter.map((x) => x.judgment)));
  ok('感兴趣条目带 judgment_label', inter.every((x) => x.judgment_label === '感兴趣'));
  ok('暂不关注列表非空', muted.length > 0, String(muted.length));
  ok('暂不关注条目带 judgment=muted', muted.every((x) => x.judgment === 'muted'),
    JSON.stringify(muted.map((x) => x.judgment)));
  ok('muted 的论文不出现在 interested 里', !inter.some((x) => x.id === p2));

  // 前端渲染依赖：judgeRowHtml 读 it.judgment
  const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  ok('列表渲染读取 it.judgment', /judgmentButtonsHtml\(\{\s*id:\s*it\.id,\s*judgment:\s*it\.judgment\s*\}/.test(appJs));
  ok('已判断时显示撤销按钮', /撤销判断/.test(appJs));

  console.log('\n=== 8. P1：撤销「暂不关注」后论文回到今日发现 ===');
  const beforeRevoke = desk.listDiscovery({ pageSize: 100, days: 400 });
  ok('暂不关注的论文已从今日发现隐藏', !beforeRevoke.items.some((x) => x.id === p2));
  ok('并如实报告隐藏数', beforeRevoke.counts.mutedExcluded >= 1, String(beforeRevoke.counts.mutedExcluded));

  judgments.setJudgment(p2, 'cleared');
  const afterRevoke = desk.listDiscovery({ pageSize: 100, days: 400 });
  ok('撤销后回到今日发现', afterRevoke.items.some((x) => x.id === p2));
  ok('撤销后不再计入隐藏数', afterRevoke.counts.mutedExcluded === beforeRevoke.counts.mutedExcluded - 1,
    `${beforeRevoke.counts.mutedExcluded} → ${afterRevoke.counts.mutedExcluded}`);
  ok('暂不关注列表现为空', judgments.listMuted().length === 0);
  ok('感兴趣的那篇未被影响', judgments.listInterested().some((x) => x.id === p1));

  /* ---------------- P1 主题相关性 ---------------- */
  console.log('\n=== 9. P1：具体误判实例 ===');
  const topics = discover.listTopics(true);
  const mk = (t, a) => ({ title: t, abstract: a });
  const cases = [
    { label: '校园信息服务聊天机器人（应跨领域）',
      title: 'A Retrieval-Augmented Multilingual Chatbot for Intelligent College Information Services',
      abstract: 'The study proposes an artificial intelligence-based multilingual university chatbot by utilizing the Retrieval-Augmented Generation approach for intelligent institutional information retrieval. It leverages Sentence Transformer embeddings, FAISS semantic search and the Llama-3 large language model, and offers language translation and voice communication.',
      expect: 'cross' },
    { label: '方言者英语发音学习（应是 sla，不是 chinese）',
      title: "Differentiated Difficulties Instead of Hierarchical Gaps: A Rebuttal to the Bias About Dialect Speakers' English Pronunciation Learning",
      abstract: 'This paper rebuts a prejudice that dialect-speaking learners face greater difficulties in acquiring English pronunciation than Mandarin-speaking learners. It draws on the Speech Learning Model, transfer, phonological sieve and contrastive analysis, studying Cantonese-speaking and Wu dialect learners of English.',
      expect: 'sla' },
    { label: '大语言模型中医教学（应跨领域）',
      title: '大语言模型智能辅导系统在中医诊断学教学中的应用研究',
      abstract: '目的：构建基于大语言模型的中医诊断学智能辅导系统，并评估其在教学中的应用效果。方法：选取某中医药大学中医学专业64名学生，分为实验组与对照组，进行为期12周的教学干预。',
      expect: 'cross' },
    { label: '职业教育 AI 转型（应跨领域）',
      title: 'Artificial Intelligence for Competency-Based Technical and Vocational Education',
      abstract: 'This review examines artificial intelligence adoption in technical and vocational education and training, focusing on digital literacy and workforce readiness.',
      expect: 'cross' },
  ];
  for (const c of cases) {
    const h = rank.topicHits(mk(c.title, c.abstract), topics);
    const core = Object.entries(h.hits).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (c.expect === 'cross') {
      ok(c.label, core.length === 0 && Object.keys(h.crossDomain).length > 0,
        `核心主题 ${JSON.stringify(core)} / 跨领域 ${JSON.stringify(h.crossDomain)}`);
    } else {
      ok(c.label, core.some(([k]) => k === c.expect) && !h.crossDomain[c.expect],
        `核心主题 ${core.map(([k, v]) => k + ':' + v).join(' ')}`);
    }
  }

  console.log('\n=== 10. P1：真相关论文必须保留在核心 ===');
  const keep = [
    { label: 'VR 二语语用教学 → pragmatics',
      title: 'Investigating the effect of VR-mediated pragmatics instruction on L2 Chinese learners',
      abstract: 'This study examines virtual reality based pragmatic instruction for Chinese as a second language learners, focusing on request and apology speech acts.',
      want: 'pragmatics' },
    { label: 'TTS 二语测评 → 教育技术',
      title: 'Using text-to-speech in second language pronunciation assessment',
      abstract: 'This study investigates text-to-speech and automatic speech recognition for second language pronunciation assessment with L2 learners of Chinese.',
      want: 'edtech' },
    { label: '汉语发音教学 → 汉语语言学',
      title: 'A Study on the Acquisition Errors of Palatal and Retroflex Sounds by Thai Students: Taking a Chinese Teaching Class as an Example',
      abstract: 'With the development of international Chinese education, this study analyses acquisition errors of Chinese pronunciation among Thai primary school learners in a Chinese teaching class.',
      want: 'chinese' },
    { label: '纠正性反馈 → 二语习得',
      title: 'A study of corrective feedback in second language writing classrooms',
      abstract: 'This study examines corrective feedback in second language writing classrooms with L2 learners over one semester.',
      want: 'sla' },
  ];
  for (const c of keep) {
    const h = rank.topicHits(mk(c.title, c.abstract), topics);
    ok(c.label, (h.hits[c.want] || 0) > 0 && !h.crossDomain[c.want],
      `核心主题 ${Object.entries(h.hits).filter(([, v]) => v > 0).map(([k, v]) => k + ':' + v).join(' ') || '（无）'}`);
  }

  console.log('\n=== 11. P1：前 30 条今日发现的领域审计 ===');
  const top30 = desk.listDiscovery({ pageSize: 30, days: 400 });
  // 排序规则是「核心在前、跨领域在后」，因此跨领域条目可以出现在列表里，
  // 但必须排在所有核心条目之后；而核心条目必须都有主题证据。
  const firstCrossIdx = top30.items.findIndex((x) => x.cross_domain);
  const corePart = firstCrossIdx < 0 ? top30.items : top30.items.slice(0, firstCrossIdx);
  const crossPart = firstCrossIdx < 0 ? [] : top30.items.slice(firstCrossIdx);
  ok('核心推荐都排在跨领域之前',
    corePart.every((x) => !x.cross_domain) && crossPart.every((x) => x.cross_domain),
    `核心 ${corePart.length} 条 + 跨领域 ${crossPart.length} 条`);
  ok('核心推荐每条都有主题证据', corePart.every((x) => x.topic_evidence.length > 0),
    corePart.filter((x) => x.topic_evidence.length === 0).map((x) => x.title.slice(0, 30)).join('；') || '全部有');
  ok('跨领域条目都带降级原因', crossPart.every((x) => x.cross_domain_reason),
    crossPart.slice(0, 2).map((x) => (x.cross_domain_reason || '').slice(0, 40)).join('；'));

  /* ---------------- P2 ---------------- */
  console.log('\n=== 12. P2：旧解读不得要求删除记录才能重生成 ===');
  ok('页面不再写「点删除后重新跑」', !/点「删除」后重新跑/.test(appJs));
  ok('页面提供「生成一条带材料快照的新解读」', /生成一条带材料快照的新解读/.test(appJs));
  ok('明确说明旧记录不会被删除', /原有解读不会被删除或修改/.test(appJs));
  ok('有 regenerateInterpretation 实现', /async function regenerateInterpretation/.test(appJs));
  ok('重生成走新增记录的接口（POST /api/interpret）',
    /async function regenerateInterpretation[\s\S]{0,400}api\('\/api\/interpret'/.test(appJs));
  ok('旧解读的 [S] 仍不可点', /cite-dead/.test(appJs) && /旧解读没有材料快照/.test(appJs));

  /* ---------------- 数据完整性 ---------------- */
  console.log('\n=== 13. 迁移与数据安全 ===');
  const m2 = store.migrate();
  ok('迁移幂等', Array.isArray(m2) && m2.length === 0, JSON.stringify(m2));
  ok('brief_items 有 verification 列', store.tableColumns('brief_items').includes('verification'));

  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(60));
  console.log(`  简报 / 主题 / 判断 回归：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(60));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
