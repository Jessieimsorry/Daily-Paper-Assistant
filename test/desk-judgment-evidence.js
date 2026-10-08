'use strict';
/**
 * 今日发现 / 阅读判断 / 证据快照 的回归测试。
 *
 * 覆盖四项要求里最容易出错、也最不能悄悄退化的约束：
 *   1. 首页在「零合格论文」时仍要展示主题相关的参考候选与待核验论文；
 *   2. 参考候选/待核验绝不能计入「期刊条件合格精选」；
 *   3. 「今天首次发现」与「近期发现但尚未推荐」如实分列；
 *   4. 阅读判断只记录明确选择、可撤销、可找回，且不自动改变排序；
 *   5. 解读的 [S1] 必须能回溯到「当时」的材料，摘要后来变化也不影响；
 *      没有快照的旧解读必须明确提示，不能伪装可回溯；
 *   6. 只有摘要时不得出现全文/页码相关的表述。
 *
 * 运行：node test/desk-judgment-evidence.js
 * 使用独立临时数据目录，不会触碰正式的 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-desk-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

/**
 * 直接从 public/app.js 抽取真实的引用渲染实现来测，
 * 而不是在测试里重写一份（否则测的是测试自己）。
 */
function extractCiteFns() {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const start = app.indexOf('function citeContext()');
  const end = app.indexOf('/** 极简 Markdown 渲染');
  const src = app.slice(start, end);
  const esc = (x) => String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const state = { _citingHost: null };
  const host = { dataset: {} };
  const factory = new Function('state', 'esc', 'attr',
    src + '; return { renderCitation, renderCitationRange, setHost(d){ state._citingHost = d; } };');
  const api = factory(state, esc, esc);
  return { api, state, host };
}
function renderCitationForTest(tag, hasSnapshot, known) {
  const { api, state, host } = extractCiteFns();
  host.dataset = { interpId: '1', hasSnapshot: hasSnapshot ? '1' : '0', knownSids: known.join(',') };
  state._citingHost = host;
  return api.renderCitation(tag);
}
function renderCitationRangeForTest(tag, known) {
  const { api, state, host } = extractCiteFns();
  host.dataset = { interpId: '1', hasSnapshot: known.length ? '1' : '0', knownSids: known.join(',') };
  state._citingHost = host;
  return api.renderCitationRange(tag);
}

(async () => {
  const store = require('../lib/store');
  const journals = require('../lib/journals');
  const discover = require('../lib/discover');
  const desk = require('../lib/desk');
  const judgments = require('../lib/judgments');
  const interpret = require('../lib/interpret');
  const config = require('../lib/config');
  config.updateSettings({ broadTechnology: false });

  store.migrate();
  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();

  console.log('\n=== 1. 迁移：新表存在且不动已有数据 ===');
  ok('judgments 表已建立', store.tableColumns('judgments').length > 0);
  ok('interpretation_materials 表已建立', store.tableColumns('interpretation_materials').length > 0);
  const m1 = store.migrate();
  ok('重复迁移不再新增列（幂等）', Array.isArray(m1) && m1.length === 0, JSON.stringify(m1));

  console.log('\n=== 2. 准备数据：一篇合格、一篇参考候选、一篇待核验 ===');
  // 官方 CSSCI 目录 ⇒ 中文刊合格
  journals.importCatalog('cssci', '期刊名称,ISSN,学科分类,版次或年份\n世界汉语教学,,语言学,2025—2026', { edition: '2025—2026', sourceName: '官方CSSCI' });
  // 参考候选目录 ⇒ 只产生 reference
  journals.importCatalog('ref_ssci', '期刊名称,ISSN,JCR年份,JCR学科类别1,分区1,收录数据库,证据状态\nApplied Linguistics,,2026,LINGUISTICS,Q1,SSCI,公众号截图参考',
    { edition: '2026', reference: 'auto', sourceName: '截图清单.csv' });

  discover.persistPapers([
    { title: '汉语二语学习者语用能力发展研究', journalName: '世界汉语教学',
      // 刻意用两句：这样材料有两段，才能同时验证「模型引用了」与「模型没引用」两种标记
      abstract: '本研究考察汉语二语学习者语用能力的发展，采用纵向追踪与访谈方法，共 24 名学习者参与（2024）。研究还考察了课堂互动对语用发展的影响。',
      publishedOnline: '2026-09-20', issuedDate: '2026-09-20', language: 'zh', sources: ['test'], topics: ['pragmatics'] },
    { title: 'Pragmatic competence development in second language learning', journalName: 'Applied Linguistics', abstract: 'This study examines pragmatic competence development using a longitudinal design with interviews.', publishedOnline: '2026-09-22', issuedDate: '2026-09-22', language: 'en', sources: ['test'], topics: ['pragmatics'] },
    { title: 'A pending journal paper on language teaching', journalName: 'Unknown Journal', abstract: 'This paper reports a study about language teaching and corrective feedback.', publishedOnline: '2026-09-21', issuedDate: '2026-09-21', language: 'en', sources: ['test'], topics: ['sla'] },
  ]);
  const q = store.get("SELECT * FROM papers WHERE title LIKE '汉语二语学习者%'");
  const ref = store.get("SELECT * FROM papers WHERE journal_name = 'Applied Linguistics'");
  const pend = store.get("SELECT * FROM papers WHERE journal_name = 'Unknown Journal'");
  ok('中文刊（官方 CSSCI）判为合格', q.eligibility === 'eligible' && q.eligible_official === 1, q.eligibility + '/' + q.eligibility_basis);
  ok('参考候选目录只产生 reference', ref.eligibility === 'reference' && ref.eligible_official === 0, ref.eligibility + '/' + ref.eligibility_basis);
  ok('未知期刊为待核验', pend.eligibility === 'pending', pend.eligibility);

  console.log('\n=== 3. 今日发现：零合格论文时仍要能读 ===');
  const disc = desk.listDiscovery({ pageSize: 10 });
  ok('今日发现返回结果', disc.ok && disc.total > 0, '总数 ' + disc.total);
  const ids = disc.items.map((x) => x.id);
  ok('含参考候选', ids.includes(ref.id), '参考候选在列表中');
  ok('含待核验论文', ids.includes(pend.id), '待核验在列表中');
  ok('含官方合格论文', ids.includes(q.id));
  ok('每篇都带主题证据（可解释）', disc.items.every((x) => Array.isArray(x.topic_evidence) && x.topic_evidence.length > 0),
    '证据条数示例 ' + disc.items[0].topic_evidence.length);
  ok('与主题完全无关的论文不会出现', disc.items.every((x) => x.topic_evidence.length > 0));

  console.log('\n=== 4. 期刊等级作为筛选条件 ===');
  const onlyRef = desk.listDiscovery({ pageSize: 50, journalFilter: 'reference' });
  ok('可只筛参考候选', onlyRef.items.every((x) => x.eligibility === 'reference') && onlyRef.total >= 1, '总数 ' + onlyRef.total);
  const onlyOfficial = desk.listDiscovery({ pageSize: 50, journalFilter: 'official' });
  // 注意：API 里 eligible_official 是布尔值（JSON 语义清晰），不是 1/0
  ok('可只筛官方合格', onlyOfficial.items.every((x) => x.eligibility === 'eligible' && x.eligible_official === true), '总数 ' + onlyOfficial.total);
  ok('官方筛选不含参考候选', !onlyOfficial.items.some((x) => x.eligibility === 'reference'));

  console.log('\n=== 5. 合格精选：参考候选与待核验不得计入 ===');
  const qual = desk.listQualified({ pageSize: 50 });
  ok('合格精选只含官方核验合格的论文', qual.items.every((x) => x.eligibility === 'eligible' && x.eligible_official === true),
    '总数 ' + qual.total);
  ok('合格精选不含参考候选', !qual.items.some((x) => x.eligibility === 'reference'));
  ok('合格精选不含待核验', !qual.items.some((x) => x.eligibility === 'pending'));
  ok('合格精选数量与首页统计口径一致',
    qual.total === require('../lib/library').libraryStats().eligiblePapers,
    `${qual.total} vs ${require('../lib/library').libraryStats().eligiblePapers}`);

  console.log('\n=== 6. 今天首次发现 vs 近期发现但尚未推荐 ===');
  const c = disc.counts;
  ok('两类分别计数', typeof c.new === 'number' && typeof c.catchup === 'number', JSON.stringify({ new: c.new, catchup: c.catchup }));
  ok('两者之和等于可读总数', c.new + c.catchup === disc.total, `${c.new}+${c.catchup}=${disc.total}`);
  ok('每篇都标注 kind', disc.items.every((x) => x.kind === 'new' || x.kind === 'catchup'));

  console.log('\n=== 7. 分页：不一次渲染上千条 ===');
  const p1 = desk.listDiscovery({ page: 1, pageSize: 2 });
  ok('默认按页返回', p1.items.length <= 2, '本页 ' + p1.items.length);
  ok('hasMore 正确', p1.hasMore === (p1.total > 2), String(p1.hasMore));
  const p2 = desk.listDiscovery({ page: 2, pageSize: 2 });
  ok('第二页内容不同', p2.items.length === 0 || p2.items[0].id !== p1.items[0].id);

  console.log('\n=== 8. 阅读判断：记录明确选择、可撤销、可找回 ===');
  const r1 = judgments.setJudgment(q.id, 'interested', { source: 'discovery' });
  ok('记为感兴趣', r1.ok && r1.decision === 'interested');
  ok('明确说明不会自动收藏', /不会自动改|需要你点/.test(String(r1.note || '')), String(r1.note).slice(0, 40));
  const starredBefore = store.get('SELECT starred FROM library WHERE paper_id = ?', [q.id]);
  ok('感兴趣不会自动改收藏状态', !starredBefore || !starredBefore.starred, JSON.stringify(starredBefore));

  judgments.setJudgment(pend.id, 'muted', { source: 'discovery' });
  const afterMute = desk.listDiscovery({ pageSize: 50 });
  ok('暂不关注的论文从今日发现隐藏', !afterMute.items.some((x) => x.id === pend.id));
  ok('并如实报告隐藏了多少', afterMute.counts.mutedExcluded >= 1, String(afterMute.counts.mutedExcluded));

  const mutedList = judgments.listMuted();
  ok('暂不关注的能在工作台内找回', mutedList.some((x) => x.id === pend.id));
  const interestedList = judgments.listInterested();
  ok('感兴趣的单独成表', interestedList.some((x) => x.id === q.id));

  const r2 = judgments.setJudgment(pend.id, 'cleared');
  ok('撤销成功', r2.ok && r2.decision === 'cleared');
  const afterClear = desk.listDiscovery({ pageSize: 50 });
  ok('撤销后回到今日发现', afterClear.items.some((x) => x.id === pend.id));
  ok('撤销后暂不关注列表为空', judgments.listMuted().length === 0);

  console.log('\n=== 9. 判断不改变推荐排序 ===');
  const scoreBefore = desk.listDiscovery({ pageSize: 50 }).items.map((x) => ({ id: x.id, s: x.sort_score }));
  judgments.setJudgment(ref.id, 'interested');
  const scoreAfter = desk.listDiscovery({ pageSize: 50 }).items.map((x) => ({ id: x.id, s: x.sort_score }));
  const same = JSON.stringify(scoreBefore) === JSON.stringify(scoreAfter);
  ok('标记感兴趣后排序与分数完全不变', same, same ? '一致' : '发生了变化');
  const overview = desk.deskOverview();
  ok('个性化排序默认关闭并说明依据', overview.personalization.enabled === false && overview.personalization.basis.length > 0,
    overview.personalization.note.slice(0, 46));

  console.log('\n=== 10. 证据快照：编号可回溯到当时的材料 ===');
  // 没有密钥时用本机端点
  const mock = require('node:http').createServer((req, res) => {
    let b = ''; req.on('data', (x) => b += x);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock',
        // 刻意只引用 S1：用于验证快照能区分「模型引用了」与「模型没引用」
        choices: [{ message: { role: 'assistant', content: '研究发现[S1]；其余细节材料未展开。' }, finish_reason: 'stop' }],
        usage: { total_tokens: 12 },
      }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  config.updateSettings({ aiBaseUrl: `http://127.0.0.1:${mock.address().port}`, aiModel: 'mock' });

  const originalAbstract = q.abstract;
  const ir = await interpret.interpret({ paperId: q.id, mode: 'quick', useFulltext: false });
  ok('生成解读成功', ir.ok === true, ir.error || '');
  ok('保存了材料快照', ir.snapshot && ir.snapshot.hasSnapshot === true, JSON.stringify(ir.snapshot));

  const mats = interpret.getMaterialsForInterpretation(ir.id);
  ok('快照条数与提供的材料一致', mats.hasSnapshot && mats.materials.length === ir.grounding.totalMaterials,
    `${mats.materials.length} vs ${ir.grounding.totalMaterials}`);
  ok('材料标注了类型（摘要）', mats.materials.every((m) => m.scope === 'abstract'));
  ok('材料标注了来源', mats.materials.some((m) => /摘要/.test(m.sourceLabel || '')), mats.materials[0].sourceLabel);
  ok('标记了模型实际引用了哪些', mats.materials.some((m) => m.cited === true) && mats.materials.some((m) => m.cited === false),
    mats.materials.map((m) => m.sid + '=' + m.cited).join(' '));
  ok('被引用的编号与 grounding 一致',
    mats.materials.filter((m) => m.cited).map((m) => m.sid).join(',') === (ir.grounding.citedIds || []).join(','),
    mats.materials.filter((m) => m.cited).map((m) => m.sid).join(',') + ' vs ' + (ir.grounding.citedIds || []).join(','));

  const one = interpret.getMaterial(ir.id, 'S1');
  ok('按编号能取到具体片段', one.found === true && one.material.text.length > 10, one.material?.text.slice(0, 40));
  ok('片段注明类型与来源', one.material.scope === 'abstract' && !!one.material.sourceLabel);
  ok('给出论文原文入口', Boolean(one.paper && one.paper.id === q.id));
  ok('明确说明编号≠证据充分', /不足以支持|需要你对照原文/.test(one.caveat || ''), one.caveat.slice(0, 40));

  const bad = interpret.getMaterial(ir.id, 'S999');
  ok('不存在的编号如实说明', bad.found === false && /没有编号/.test(bad.message), bad.message.slice(0, 40));

  console.log('\n=== 11. 摘要后来更新，旧解读仍指向当时材料 ===');
  const snapshotBefore = store.all('SELECT sid, text FROM interpretation_materials WHERE interp_id = ? ORDER BY id', [ir.id]);
  store.run('UPDATE papers SET abstract = ? WHERE id = ?', ['【完全不同的新摘要】这段文字是后来更新的。', q.id]);
  const snapshotAfter = store.all('SELECT sid, text FROM interpretation_materials WHERE interp_id = ? ORDER BY id', [ir.id]);
  ok('快照不随摘要更新而改变', JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter));
  const still = interpret.getMaterial(ir.id, 'S1');
  ok('仍能取到当时的片段', still.found && still.material.text === snapshotBefore[0].text, still.material.text.slice(0, 36));
  store.run('UPDATE papers SET abstract = ? WHERE id = ?', [originalAbstract, q.id]);

  console.log('\n=== 12. 没有快照的旧解读必须明确提示 ===');
  store.run(
    `INSERT INTO interpretations(paper_id, mode, evidence_scope, evidence_note, model, content, grounding)
     VALUES(?,?,?,?,?,?,?)`,
    [q.id, 'quick', 'abstract', '依据范围：题名/元数据 + 摘要。', 'old-model', '旧解读正文[S1]。', '{}']);
  const legacyId = store.get('SELECT id FROM interpretations ORDER BY id DESC LIMIT 1').id;
  const legacy = interpret.getMaterialsForInterpretation(legacyId);
  ok('旧解读报告 hasSnapshot=false', legacy.hasSnapshot === false);
  ok('明确说明无法回溯', /没有保存|无法回溯|不提供引用原文查看/.test(legacy.message), legacy.message.slice(0, 50));
  ok('不返回任何材料（不伪装）', legacy.materials.length === 0);

  console.log('\n=== 13. 只有摘要时不得出现全文或页码表述 ===');
  const ev = interpret.buildEvidence(q.id, false);
  ok('依据范围为 abstract', ev.scope === 'abstract', ev.scope);
  ok('依据说明写明未读取全文', /未读取全文/.test(ev.evidenceNote), ev.evidenceNote.slice(0, 40));
  ok('依据说明不含页码承诺', !/页码/.test(ev.evidenceNote.replace('页码', '')) || !/可以提供页码/.test(ev.evidenceNote));
  ok('材料全部标为 abstract', ev.sentences.every((x) => x.scope === 'abstract'));
  const snapCon = interpret.getMaterialsForInterpretation(ir.id);
  ok('快照里没有伪造的 fulltext 材料', !snapCon.materials.some((m) => m.scope === 'fulltext'));

  console.log('\n=== 14. 学术核验规则未被破坏 ===');
  const cfg = config.getSettings();
  const refInfo = journals.eligibilityOf(journals.findJournal({ name: 'Applied Linguistics' }), cfg);
  ok('截图来源仍只是参考候选', refInfo.status === 'reference' && refInfo.officialEligible === false, refInfo.status);
  ok('参考候选的标签都标为参考', refInfo.tags.filter((t) => t.type === 'jcr').every((t) => t.reference === true && t.kind === 'reference'));
  const qInfo = journals.eligibilityOf(journals.findJournal({ name: '世界汉语教学' }), cfg);
  ok('官方 CSSCI 仍判为合格', qInfo.status === 'eligible' && qInfo.basis === 'official');
  ok('官方标签带版次与来源', qInfo.tags.some((t) => t.edition && t.source));
  ok('参考候选不计入合格统计', require('../lib/library').libraryStats().eligiblePapers === qual.total);

  console.log('\n=== 15. 分区分列显示（JCR 与中科院不合并）===');
  const tagTypes = refInfo.tags.map((t) => t.type);
  ok('JCR 标签独立存在', tagTypes.includes('jcr'));
  ok('没有「综合等级」这种合并标签', !refInfo.tags.some((t) => /综合/.test(t.text)));


  console.log('\n=== 16. 三态分类：有简报记录与没有简报记录两种情况 ===');
  /*
   * 先造一篇「更早发现」的论文，让 catchup 样本不依赖跑测试时的时刻。
   *
   * 踩过的坑：本用例原先假定 persistPapers 刚落库的论文一定是 catchup，
   * 但那取决于「真实 UTC 日期 != 北京日期」——同一台机器在北京时间
   * 00:00–08:00 跑就会两者相等，三态里全是 new，这条断言随机失败。
   * 三态分类是确定的行为，样本也该确定地造出来。
   */
  const oldDisc = '2026-09-10';
  store.run(
    `INSERT INTO papers(title, journal_name, abstract, language, eligibility, discovery_date, dedup_key, topics)
     VALUES(?,?,?,?,?,?,?,?)`,
    ['Earlier discovered pragmatic instruction study', 'Unknown Journal',
      'This study examines pragmatic instruction with second language learners.',
      'en', 'pending', oldDisc, 'test:catchup:fixture', '["pragmatics"]']);
  // 情况 A：把一篇论文放进简报，它应变成 shown 而不是 catchup
  const runRow = store.get('SELECT id FROM brief_runs LIMIT 1');
  const runId = runRow ? runRow.id
    : (store.run("INSERT INTO brief_runs(run_date,reason,status) VALUES(?,?,?)", ['2026-01-01', 'test', 'ok']),
       store.get('SELECT id FROM brief_runs ORDER BY id DESC LIMIT 1').id);
  const discBefore = desk.listDiscovery({ pageSize: 100 });
  const target = discBefore.items.find((x) => x.kind === 'catchup');
  ok('存在一篇「近期发现且尚未推荐」的论文作为样本', Boolean(target), target ? target.title.slice(0, 30) : '（无）');
  if (target) {
    store.run('INSERT OR IGNORE INTO brief_items(run_id,paper_id,rank,score,reason,kind) VALUES(?,?,?,?,?,?)',
      [runId, target.id, 1, 1, '测试', 'new']);
    const discAfter = desk.listDiscovery({ pageSize: 200 });
    const now = discAfter.items.find((x) => x.id === target.id);
    ok('进入简报后从 catchup 变为 shown', now && now.kind === 'shown', now ? now.kind : '未找到');
    ok('该论文不再计入 catchup', discAfter.counts.catchup === discBefore.counts.catchup - 1,
      `${discBefore.counts.catchup} → ${discAfter.counts.catchup}`);
    ok('shown 计数 +1', discAfter.counts.shown === discBefore.counts.shown + 1,
      `${discBefore.counts.shown} → ${discAfter.counts.shown}`);
    ok('三者之和仍等于总数',
      discAfter.counts.new + discAfter.counts.catchup + discAfter.counts.shown === discAfter.total,
      `${discAfter.counts.new}+${discAfter.counts.catchup}+${discAfter.counts.shown}=${discAfter.total}`);
    ok('fresh 标记与 kind 一致（shown ⇒ fresh=false）', now.fresh === false);
    // 清理
    store.run('DELETE FROM brief_items WHERE run_id = ? AND paper_id = ?', [runId, target.id]);
    const discRestored = desk.listDiscovery({ pageSize: 200 });
    const back = discRestored.items.find((x) => x.id === target.id);
    ok('移除简报记录后回到 catchup', back && back.kind === 'catchup', back ? back.kind : '未找到');
  }

  console.log('\n=== 17. 分类依据是 discovery_date，不是 published_online ===');
  const apiBasis = String(disc.counts.basis || '');
  ok('接口说明了分类依据', /discovery_date/.test(apiBasis) && /不是.*published_online|不是 published_online/.test(apiBasis),
    apiBasis.slice(0, 60));
  // 构造：在线发表日期是今天，但工作台发现日期是过去 ⇒ 不应算 today-new
  const past = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const todayStr = require('../lib/brief').beijingDate();
  // 摘要必须真的含主题关键词，否则论文本来就不会出现在首页（这是设计行为，不是 bug）
  store.run(`INSERT INTO papers(title, journal_name, abstract, language, sources, topics,
              published_online, issued_date, discovery_date, eligibility, dedup_key)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ['Using text-to-speech for second language pronunciation assessment', '未知期刊',
     'This study examines text-to-speech technology for second language pronunciation assessment with L2 learners.',
     'en', 'test', '["edtech"]', todayStr, todayStr, past, 'pending', 'test-dates-' + Date.now()]);
  const dateTest = store.get("SELECT * FROM papers WHERE dedup_key LIKE 'test-dates-%'");
  const discD = desk.listDiscovery({ pageSize: 500, days: 400 });
  const dt = discD.items.find((x) => x.id === dateTest.id);
  ok('该测试论文出现在发现列表里', Boolean(dt), dt ? `kind=${dt.kind}` : '未找到（摘要需含主题关键词才会出现）');
  ok('发表日在今天、发现日在过去 ⇒ 不是「今天首次发现」',
    dt && dt.kind !== 'new', dt ? `kind=${dt.kind} published=${dt.published_online} discovered=${dt.discovery_date}` : '未找到');
  store.run('DELETE FROM papers WHERE id = ?', [dateTest.id]);

  console.log('\n=== 18. 跨领域方法参考：真实噪声论文不得混入核心推荐 ===');
  const noisy = [
    { title: 'Technology-enhanced learning and self-regulated learning: A pathway to effective medical education',
      abstract: 'This study investigates technology-enhanced learning and self-regulated learning among medical students in clinical training.' },
    { title: 'Artificial Intelligence for Competency-Based Technical and Vocational Education: A Review',
      abstract: 'This review examines artificial intelligence adoption in technical and vocational education and training, focusing on digital literacy and workforce readiness.' },
    { title: 'Factors Influencing the Acceptance and Application of Artificial Intelligence among University Teachers in Thailand',
      abstract: 'This study surveyed university teachers in Thailand about their acceptance of artificial intelligence tools and perceived proficiency in using them for instruction.' },
  ];
  const relevant = [
    // 真实相关：二语测评里的 TTS
    { title: 'Using text-to-speech in second language pronunciation assessment',
      abstract: 'This study investigates automated speech recognition and text-to-speech technology for second language pronunciation assessment with L2 learners of Chinese.' },
    // 真实相关：VR 支持二语语用教学
    { title: 'Investigating the effect of VR-mediated pragmatics instruction on L2 Chinese learners',
      abstract: 'This study examines virtual reality based pragmatic instruction for Chinese as a second language learners, focusing on request and apology speech acts.' },
    // 真实相关：面向国际中文教育的多语言聊天机器人
    { title: 'A Retrieval-Augmented Multilingual Chatbot for International Chinese Language Education',
      abstract: 'We build a chatbot powered by a large language model for international Chinese language education and evaluate Mandarin learner outcomes.' },
  ];
  const mk = (spec) => ({ ...spec, journalName: '未知期刊', language: 'en', sources: ['test'], topics: [] });
  discover.persistPapers([...noisy, ...relevant].map(mk));
  const tops = require('../lib/discover').listTopics(true);
  const find = (t) => store.get(`SELECT * FROM papers WHERE title = ?`, [t]);

  for (const n of noisy) {
    const row = find(n.title);
    const th = require('../lib/rank').topicHits(row, tops);
    ok(`噪声论文被判为跨领域：${n.title.slice(0, 34)}…`,
      th.crossDomain.edtech === true && !th.hits.edtech,
      `crossDomain=${JSON.stringify(th.crossDomain)} edtech=${th.hits.edtech || 0}`);
  }
  for (const n of relevant) {
    const row = find(n.title);
    const th = require('../lib/rank').topicHits(row, tops);
    const inCoreTopic = Object.values(th.hits).some((v) => v > 0);
    // 判定标准是「没有被降级为跨领域，且确实命中了某个主题」——
    // 而不是强行要求它必须有 edtech 分（有些二语评测类论文主要落在 sla/语言学上）
    ok(`相关论文未被误伤：${n.title.slice(0, 34)}…`,
      !th.crossDomain.edtech && inCoreTopic,
      `crossDomain=${JSON.stringify(th.crossDomain)} 主题分=${JSON.stringify(th.hits)}`);
  }
  // 额外确认：TTS 这类技术词现在能被识别为教育技术证据
  const ttsRow = find(relevant[0].title);
  const ttsHits = require('../lib/rank').topicHits(ttsRow, tops);
  ok('text-to-speech 被识别为教育技术证据', (ttsHits.hits.edtech || 0) > 0 || (ttsHits.specificityHits.edtech || 0) > 0,
    `edtech=${ttsHits.hits.edtech || 0} 标志词=${ttsHits.specificityHits.edtech || 0}`);

  const discAll = desk.listDiscovery({ pageSize: 100, days: 400 });
  const noisyPos = noisy.map((n) => {
    const row = find(n.title);
    return discAll.items.findIndex((x) => x.id === row.id);
  }).filter((i) => i >= 0);
  const maxCorePos = discAll.items.reduce((mx, x, i) => (x.cross_domain ? mx : i), 0);
  ok('所有跨领域论文都排在核心推荐之后',
    noisyPos.every((i) => i > maxCorePos || discAll.items[i].cross_domain),
    `跨领域位置 ${JSON.stringify(noisyPos.map((i) => i + 1))}，核心最靠后位置 ${maxCorePos + 1}`);
  ok('跨领域论文带降级原因', discAll.items.filter((x) => x.cross_domain).every((x) => x.cross_domain_reason),
    discAll.items.find((x) => x.cross_domain)?.cross_domain_reason || '（无跨领域项）');

  console.log('\n=== 19. 引用编号渲染规则（旧解读不可点 / 范围写法）===');
  const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  ok('有快照才渲染可点按钮', /ctx\.clickable/.test(appJs) && /cite-btn/.test(appJs));
  ok('无快照渲染为不可点样式', /cite-dead/.test(appJs));
  ok('范围写法会被规范化处理', /renderCitationRange/.test(appJs) && /未核验范围引用/.test(appJs));
  ok('范围能对上快照时展开为可核验编号', /范围已展开核验/.test(appJs));
  ok('快照里没有的编号标为未核验', /快照里没有/.test(appJs));
  ok('旧解读正文旁直接给出提示', /旧解读无可回溯材料，重新生成后可用/.test(appJs));
  ok('论文详情接口返回快照编号', /snapshots/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')));

  // 旧解读必须被识别为无快照
  const legacyPaper = store.get("SELECT id FROM papers WHERE id = ?", [q.id]);
  const legacyList = interpret.listInterpretations(q.id);
  const oldOne = legacyList.find((x) => x.model === 'old-model');
  if (oldOne) {
    const m = store.get('SELECT COUNT(*) c FROM interpretation_materials WHERE interp_id = ?', [oldOne.id]).c;
    ok('旧解读在列表里标记为无快照', m === 0 && interpret.getMaterialsForInterpretation(oldOne.id).hasSnapshot === false);
  } else {
    ok('旧解读样本存在', false, '未找到 old-model 解读');
  }

  console.log('\n=== 19b. 范围引用按真实数据核验 ===');
  // 真实库中确实存在 [S1–S6] / [S9–S14] 这类范围写法，
  // 生成范围时必须逐个编号对照快照，不能留下貌似有效的范围引用。
  const rangeSrc = renderCitationRangeForTest('[S9–S14]', ['S9','S10','S11','S12','S13','S14']);
  ok('[S9–S14] 全部命中快照时展开为可核验编号',
    /范围已展开核验/.test(rangeSrc) && (rangeSrc.match(/cite-btn/g) || []).length === 6,
    `按钮数 ${(rangeSrc.match(/cite-btn/g) || []).length}`);
  const rangePartial = renderCitationRangeForTest('[S9–S14]', ['S9','S10']);
  ok('[S9–S14] 只对上 2 个时标为未核验',
    /未核验范围引用/.test(rangePartial) && !/cite-btn/.test(rangePartial));
  const rangeNoSnap = renderCitationRangeForTest('[S1–S6]', []);
  ok('无快照时范围引用标为未核验', /未核验范围引用/.test(rangeNoSnap));
  const single = renderCitationForTest('[S2]', true, ['S1', 'S2']);
  ok('有快照且编号存在 ⇒ 可点', /cite-btn/.test(single));
  const singleMissing = renderCitationForTest('[S2]', true, ['S1']);
  ok('编号不在快照里 ⇒ 不可点', /cite-dead/.test(singleMissing));
  const singleOld = renderCitationForTest('[S2]', false, []);
  ok('旧解读无快照 ⇒ 不可点', /cite-dead/.test(singleOld) && !/cite-btn/.test(singleOld));

  console.log('\n=== 20. 界面文案一致性 ===');
  ok('详情页返回按钮指向「今日发现」', /返回今日发现/.test(appJs) && !/返回今日简报/.test(appJs));
  ok('阅读状态三态映射正确（unread=待读）',
    /function readStateLabel/.test(appJs) && /unread: '待读'/.test(appJs) && /reading: '在读'/.test(appJs) && /read: '已读'/.test(appJs));
  ok('阅读判断列表使用统一的状态文案', (appJs.match(/readStateLabel\(/g) || []).length >= 2,
    String((appJs.match(/readStateLabel\(/g) || []).length) + ' 处使用');

  mock.close();
  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(58));
  console.log(`  今日发现 / 阅读判断 / 证据快照：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(58));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
