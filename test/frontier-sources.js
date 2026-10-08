'use strict';
/**
 * 前沿技术来源（ERIC / arXiv / ACL / IEEE）回归测试。
 *
 * 全部离线：不调用任何外部接口。覆盖本轮修掉/建立的硬约束：
 *   1. IEEE 没有密钥时**不发请求**，如实报「待配置」；
 *   2. arXiv ID 必须剥掉版本号（v1/v2 是同一篇）；journal_ref/doi 覆盖率极低，
 *      只能当弱信号展示，绝不自动合并；
 *   3. ERIC 只有「年」的日期不得补成某一天；DOI 只能从 url 里挖，挖不到就是 null；
 *      ERIC 的 subject 是叙词表，**不是作者关键词**；
 *   4. 相关性判定必须有「技术锚点」，泛词（education / learning）不能单独命中——
 *      真实缺陷：一篇讲「前瞻记忆遗忘」的教育学论文曾被判成「教育 NLP」；
 *   5. 时间窗口必须按精度比较：只有年的条目不能被字符串比较静默排除；
 *   6. 已推荐过的前沿条目不再重复推荐；
 *   7. 前沿条目独立成表，绝不进入 papers / 期刊合格统计。
 *
 * 运行：node test/frontier-sources.js
 * 使用独立临时数据目录，不会触碰正式的 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-frontier-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

(async () => {
  const store = require('../lib/store');
  const frontier = require('../lib/frontier');
  const N = require('../lib/normalize');

  store.migrate();

  /* ==================== 一、IEEE：无密钥不发请求 ==================== */
  console.log('\n【一】IEEE Xplore：没有密钥就如实「待配置」，绝不假装采到');
  const ieee = frontier.ieeeStatus();
  ok('没有密钥时 needsApiKey=true、configured=false', ieee.needsApiKey === true && ieee.configured === false);
  ok('没有密钥时不报告任何 HTTP 状态（因为根本没发请求）', ieee.status === null);
  ok('错误文案写明实测结论：无密钥返回 HTTP 403', /403/.test(ieee.error));
  ok('给出了处理建议而非让用户猜', /Developer Inactive|未激活/.test(ieee.fix || ''));
  const statusAll = await frontier.status();
  const ieeeSrc = (statusAll.sources || []).find((s) => s.key === 'ieee');
  ok('来源清单把 IEEE 标为 needs-key（前端据此显示「待配置」）', ieeeSrc && ieeeSrc.kind === 'needs-key' && ieeeSrc.needsKey === true);

  /* ==================== 二、arXiv：ID 与弱信号 ==================== */
  console.log('\n【二】arXiv：剥版本号、预印本标注、正式发表线索只展示不合并');
  ok('arXiv ID 剥掉版本号', frontier.baseArxivId('http://arxiv.org/abs/2608.09289v2') === '2608.09289');
  ok('无版本号时原样返回', frontier.baseArxivId('http://arxiv.org/abs/2608.09289') === '2608.09289');

  const atom = `<feed><opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2608.09289v2</id>
    <title>Accurate but Natural? Diagnosing Grammatical and Idiomatic Gaps in {L2} Writing</title>
    <published>2026-08-10T08:42:06Z</published>
    <summary>Second language writing research distinguishes grammatical accuracy from idiomaticity.</summary>
    <author><name>Steve Woollaston</name></author>
    <author><name>Jane Doe</name></author>
    <arxiv:comment>APCLC submission</arxiv:comment>
    <arxiv:journal_ref>Published by TMLR 2025</arxiv:journal_ref>
    <arxiv:primary_category term="cs.CL"/>
    <link href="https://arxiv.org/pdf/2608.09289v2" rel="related" title="pdf"/>
  </entry></feed>`;
  const parsed = frontier.parseArxivAtom(atom);
  ok('解析出 1 条记录', parsed.length === 1);
  const a0 = parsed[0];
  ok('sourceId 已剥版本号', a0.sourceId === '2608.09289', a0.sourceId);
  ok('文档类型标为预印本', a0.docType === 'preprint');
  ok('预印本不标为同行评议（peerReviewed=0）', a0.peerReviewed === 0);
  ok('发表日期为日粒度', a0.publishedDate === '2026-08-10' && N.datePrecision(a0.publishedDate) === 'day');
  ok('多作者被正确切分', a0.authors.length === 2 && a0.authors[0] === 'Steve Woollaston');
  ok('标题里的 LaTeX 花括号原样保留（{L2} 不被吞掉）', /\{L2\}/.test(a0.title), a0.title);
  ok('journal_ref/comment 收进 publishedNote 作为弱信号', /TMLR/.test(a0.publishedNote || '') && /APCLC/.test(a0.publishedNote || ''));
  ok('稳定链接指向 abs 页面', a0.url === 'https://arxiv.org/abs/2608.09289');
  ok('手动构造的 arXiv 记录 source=arxiv', a0.source === 'arxiv');

  /* ==================== 三、ERIC：精度、DOI、叙词表 ==================== */
  console.log('\n【三】ERIC：只有年的日期、DOI 只能挖、subject 不是作者关键词');
  ok('期刊论文类型映射正确', frontier.ericDocType(['Journal Articles', 'Reports - Evaluative']) === 'journal-article');
  ok('会议论文类型映射正确', frontier.ericDocType(['Speeches/Meeting Papers']) === 'conference-paper');
  ok('报告类型映射正确', frontier.ericDocType(['Reports - Research']) === 'report');

  ok('从 dx.doi.org URL 提取 DOI', frontier.doiFromUrl('http://dx.doi.org/10.1007/s10639-022-11200-7') === '10.1007/s10639-022-11200-7');
  ok('从 https://doi.org URL 提取 DOI', frontier.doiFromUrl('https://doi.org/10.1234/ABC.Def') === '10.1234/abc.def');
  ok('url 里没有 DOI 时返回 null（不编造）', frontier.doiFromUrl('https://eric.ed.gov/?id=EJ923366') === null);
  ok('url 为空也返回 null', frontier.doiFromUrl('') === null);

  const ericItem = frontier.ericToItem({
    id: 'EJ923366',
    title: 'Potential of Automated Writing Evaluation Feedback',
    author: ['Cotos, Elena'],
    source: 'CALICO Journal',
    publicationtype: ['Journal Articles'],
    publicationdateyear: 2026,
    peerreviewed: 'T',
    description: 'This study examines automated writing evaluation feedback.',
    subject: ['Writing Evaluation', 'Feedback (Response)'],
    url: 'http://dx.doi.org/10.1000/abc',
  });
  ok('ERIC 只有年时 publishedDate 就是 "2026"（绝不补月日）',
    ericItem.publishedDate === '2026' && N.datePrecision(ericItem.publishedDate) === 'year', ericItem.publishedDate);
  ok('ERIC 的 subject 存入 subjects，而不是 keywords', Array.isArray(ericItem.subjects) && ericItem.subjects.length === 2 && !('keywords' in ericItem));
  ok('ERIC 记录不含 keywords 字段（它根本不提供作者关键词）', ericItem.keywords === undefined);
  ok('peerreviewed=T 映射为 1', ericItem.peerReviewed === 1);
  ok('没有 url 时回落到 eric.ed.gov 稳定链接',
    frontier.ericToItem({ id: 'ED1', title: 'T' }).url === 'https://eric.ed.gov/?id=ED1');
  ok('没有标题的 ERIC 记录被丢弃', frontier.ericToItem({ id: 'EJ1' }) === null);

  /* ============ 四、相关性：必须有技术锚点，泛词不算 ============ */
  console.log('\n【四】相关性判定：泛词不能单独命中（真实噪声案例）');
  const memoryPaper = {
    title: 'Why Do We Forget?--A Mixed-Method Investigation of Reasons for Everyday Prospective Memory Failures',
    abstract: 'Prospective memory research often assumes that unfulfilled intentions reflect memory failures. '
      + 'This naturalistic study investigated daily intention non-completion among adults.',
    subjects: ['Memory', 'Distance Education', 'Intention', 'Value Judgment', 'Self Efficacy', 'Adults'],
  };
  ok('「前瞻记忆」教育学论文不再被判成教育 NLP（锚点缺失）',
    frontier.hitDirections(memoryPaper).length === 0,
    JSON.stringify(frontier.hitDirections(memoryPaper)));

  const awPaper = {
    title: 'Evaluating Rater Effects of Large Language Models in Automated Essay Scoring',
    abstract: 'We study automated writing evaluation and large language model scoring of essays.',
    subjects: ['Writing Evaluation'],
  };
  const awHits = frontier.hitDirections(awPaper);
  ok('真正的前沿论文能命中方向', awHits.length >= 1, awHits.map((h) => h.name).join(','));
  ok('命中方向包含自动评估', awHits.some((h) => h.slug === 'automated-assessment'), JSON.stringify(awHits.map((h) => h.slug)));

  const speechPaper = {
    title: 'Multimodal Conversational Context for LLM-Based ASR',
    abstract: 'We improve automatic speech recognition and speech interaction for spoken language systems.',
    subjects: [],
  };
  ok('语音技术论文命中语音方向', frontier.hitDirections(speechPaper).some((h) => h.slug === 'speech-technology'));

  // 词边界：'natural' 不应命中 'naturalistic'
  ok('词边界匹配：natural 不命中 naturalistic',
    frontier.hitDirections({ title: 'A naturalistic study', abstract: '', subjects: [] }).length === 0);
  ok('词边界匹配：asr 不命中 laser',
    frontier.hitDirections({ title: 'Laser measurement for learning analytics', abstract: '', subjects: [] })
      .every((h) => !h.matched.includes('asr')));

  /* ============ 五、时间窗口必须按精度比较 ============ */
  console.log('\n【五】只有年的条目不能因字符串比较被静默排除（真实缺陷）');
  const today = new Date();
  const thisYear = today.getUTCFullYear();
  const mk = (src, sid, dt, title, abstract, pd, sub, pr, key) => store.run(
    `INSERT INTO frontier_items(source, source_id, doc_type, title, authors, venue, year, published_date,
        abstract, subjects, peer_reviewed, dedup_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [src, sid, dt, title, JSON.stringify(['X Y']), 'Venue', thisYear, pd, abstract, JSON.stringify(sub), pr, key]);

  mk('eric', 'EJ900', 'journal-article',
    'Automated writing evaluation feedback in language classrooms',
    'This study examines automated writing evaluation and large language model feedback for language learners.',
    String(thisYear), ['Writing Evaluation'], 1, 'ft-test-eric-year');
  mk('arxiv', '2609.99999', 'preprint',
    'Speech recognition for pronunciation training',
    'We evaluate automatic speech recognition and pronunciation feedback for second language learning.',
    `${thisYear}-09-20`, ['cs.CL'], 0, 'ft-test-arxiv-day');

  const gen = await frontier.generate({ skipCollect: true, size: 3 });
  ok('generate 在离线模式下也能跑通（skipCollect）', gen.ok === true, `picked=${gen.picked}`);
  const got = frontier.get();
  ok('只有年（ERIC）的条目进入了候选池，没有被字符串比较排除',
    got.items.some((i) => i.source === 'eric'), JSON.stringify(got.items.map((i) => i.source)));
  const ericPick = got.items.find((i) => i.source === 'eric');
  ok('该条目在界面上按年精度展示（precision=year）', ericPick && ericPick.publishedPrecision === 'year');
  ok('arXiv 条目按日精度展示', (got.items.find((i) => i.source === 'arxiv') || {}).publishedPrecision === 'day');

  /* ==================== 六、去重与不重复推荐 ==================== */
  console.log('\n【六】去重键与「不重复推荐」');
  ok('有 DOI 时用 DOI 作为去重键', frontier.dedupKeyFor({ doi: '10.1/abc', title: 'T', year: 2026 }) === 'doi:10.1/abc');
  ok('无 DOI 时用规范化题名 + 年', /^ft:/.test(frontier.dedupKeyFor({ title: 'A Study of X', year: 2026 })));
  ok('既无 DOI 也无题名时退回来源 ID', /^fs:eric:/.test(frontier.dedupKeyFor({ title: '', source: 'eric', sourceId: 'EJ1' })));

  const before = frontier.get().items.map((i) => i.id).sort();
  await frontier.generate({ skipCollect: true, size: 3 });
  const after = frontier.get().items.map((i) => i.id).sort();
  ok('同一天重复生成是「更新那一份」，不会堆出多条同日记录',
    store.get('SELECT COUNT(*) c FROM frontier_runs WHERE run_date = ?', [got.run.runDate]).c === 1);
  ok('同一天重复生成的入选结果稳定（同一天的精选应当是确定的）',
    JSON.stringify(before) === JSON.stringify(after), `before=${before.join(',')} after=${after.join(',')}`);

  /*
   * 跨天不重复：把上一次 run 的日期改成昨天，再生成一次，
   * 昨天已推荐过的条目应当被排除。
   */
  store.run('UPDATE frontier_runs SET run_date = ? WHERE id = ?',
    [new Date(Date.now() - 86400000).toISOString().slice(0, 10), got.run.id]);
  await frontier.generate({ skipCollect: true, size: 3 });
  const next = frontier.get().items.map((i) => i.id).sort();
  ok('昨天已推荐过的条目不会再出现在今天的前沿精选里',
    next.length === 0 || before.every((id) => !next.includes(id)),
    `昨天=${before.join(',')} 今天=${next.join(',')}`);

  /* ============ 七、不污染主库与期刊合格统计 ============ */
  console.log('\n【七】前沿条目独立成表，不进入 papers / 期刊合格统计');
  ok('frontier_items 里有数据', store.get('SELECT COUNT(*) c FROM frontier_items').c > 0);
  ok('papers 表没有被前沿条目污染', store.get('SELECT COUNT(*) c FROM papers').c === 0,
    `papers=${store.get('SELECT COUNT(*) c FROM papers').c}`);
  ok('frontier_items 没有任何期刊分区字段（不参与核验）',
    !store.all('PRAGMA table_info(frontier_items)').some((c) => /eligib|jcr|ssci|cssci|cas_zone/.test(c.name)));

  /* ==================== 八、来源状态如实 ==================== */
  console.log('\n【八】来源状态清单：接通 / 待配置 / 批量同步，各有明确文案');
  const st = await frontier.status();
  const keys = (st.sources || []).map((s) => s.key);
  ok('清单包含 eric / arxiv / acl / ieee', ['eric', 'arxiv', 'acl', 'ieee'].every((k) => keys.includes(k)), keys.join(','));
  const aclSrc = (st.sources || []).find((s) => s.key === 'acl');
  ok('ACL 标为批量同步来源（没有在线查询接口）', aclSrc.kind === 'batch' && /没有在线查询接口/.test(aclSrc.coverage));
  ok('ERIC 文案如实说明「日期只到年」「没有 DOI 与作者关键词」',
    /只到「年」/.test(frontier.SOURCE_META.eric.coverage) && /DOI/.test(frontier.SOURCE_META.eric.coverage));
  ok('arXiv 文案如实说明 3 秒限速与正式发表线索覆盖率低',
    /每 3 秒/.test(frontier.SOURCE_META.arxiv.coverage) && /2%–8%/.test(frontier.SOURCE_META.arxiv.coverage));

  /* ============ 九、页面口径：主简报篇数不得写死 ============ */
  console.log('\n【九】「独立于上面 N 篇主简报」必须用本次实际篇数（真实缺陷：写死成 8）');

  function extractFrontierFns() {
    const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    const start = app.indexOf('function frontierSourceStrip(');
    const marker = app.indexOf('前沿条目的题名/摘要译文');
    const end = app.lastIndexOf('/*', marker);
    if (start < 0 || marker < 0 || end <= start) throw new Error('无法在 app.js 定位前沿区块函数');
    const src = app.slice(start, end);
    const esc = (x) => String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const f = new Function('esc', 'attr', 'fmtDate', 'fmtBeijing', 'reasonLabel', 'FRONTIER_TYPE_CLASS',
      'trText', 'trBadge', 'langLabelOf',
      src + '\n; return { frontierSectionHtml, frontierSourceStrip };');
    return f(esc, esc, (d) => String(d == null ? '—' : d), (d) => String(d == null ? '—' : d),
      (r) => String(r == null ? '' : r), {}, () => null, () => '', (l) => String(l == null ? '' : l));
  }
  const FF = extractFrontierFns();
  const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const emptyFrontier = { items: [], sources: [], note: null, run: null };

  ok('主简报 10 篇时标题写「上面 10 篇」（今天就是这种情况）',
    /独立于上面 10 篇主简报/.test(FF.frontierSectionHtml(emptyFrontier, 10)));
  ok('主简报 8 篇时标题写「上面 8 篇」', /独立于上面 8 篇主简报/.test(FF.frontierSectionHtml(emptyFrontier, 8)));
  ok('主简报 6 篇时标题跟着变成「上面 6 篇」，不写死',
    /独立于上面 6 篇主简报/.test(FF.frontierSectionHtml(emptyFrontier, 6)));
  ok('篇数未知时不写数字、也不拿常量兜底',
    /独立于当日主简报/.test(FF.frontierSectionHtml(emptyFrontier, null))
    && !/\d+ 篇主简报/.test(FF.frontierSectionHtml(emptyFrontier, null)));
  ok('app.js 里不再存在写死的「独立于上面 …8… 篇主简报」模板表达式',
    !/独立于上面 \$\{[^}]*'8'/.test(appSrc) && !/\?\s*'8'\s*:\s*''/.test(appSrc));
  ok('标题只由传入的 mainBriefCount 决定（用 || 而不是常量兜底）',
    /\$\{mainBriefCount\} 篇主简报/.test(appSrc) && !/'8'\s*:\s*''/.test(appSrc));
  ok('页脚「本次生成」一行也说清今天新采集/沿用早前采集的篇数',
    /今天新采集 \$\{d\.newTodayCount\} 篇、沿用早前采集 \$\{d\.carriedOverCount\} 篇/.test(appSrc));

  /* ============ 十、不把旧记录说成今日新发现 ============ */
  console.log('\n【十】前沿记录的采集日期口径：区分「今天新采集」与「沿用早前采集」');
  const mkFrontier = (sid, title, firstSeenIso, key) => store.run(
    `INSERT INTO frontier_items(source, source_id, doc_type, title, authors, venue, year, published_date,
        abstract, subjects, peer_reviewed, dedup_key, first_seen)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['arxiv', sid, 'preprint', title, JSON.stringify(['A B']), 'cs.CL', thisYear,
      `${thisYear}-09-20`, 'automated writing evaluation and language learning with large language model feedback.',
      JSON.stringify(['cs.CL']), 0, key, firstSeenIso]);

  const todayIso = new Date().toISOString();
  const yesterdayIso = new Date(Date.now() - 86400000).toISOString();
  mkFrontier('2610.00001', 'Automated writing evaluation with large language models A',
    todayIso, 'ft-fresh-today');
  mkFrontier('2610.00002', 'Automated writing evaluation with large language models B',
    yesterdayIso, 'ft-carried-yesterday');

  await frontier.generate({ skipCollect: true, size: 3 });
  const g2 = frontier.get();
  const freshItem = g2.items.find((x) => x.sourceId === '2610.00001');
  const carriedItem = g2.items.find((x) => x.sourceId === '2610.00002');
  ok('今天采集的记录标为 newlyCollectedToday=true',
    freshItem && freshItem.newlyCollectedToday === true && freshItem.carriedOver === false);
  ok('昨天采集的记录标为 carriedOver=true（不被说成今日新发现）',
    carriedItem && carriedItem.carriedOver === true && carriedItem.newlyCollectedToday === false);
  ok('每篇都带原采集日期（firstSeenDay）',
    Boolean(freshItem && freshItem.firstSeenDay) && Boolean(carriedItem && carriedItem.firstSeenDay));
  ok('carriedOver 的原采集日 != 本次 run 的日期',
    carriedItem && carriedItem.firstSeenDay !== g2.run.runDate);
  ok('汇总里给出今天新采集 / 沿用早前采集的篇数',
    typeof g2.newTodayCount === 'number' && typeof g2.carriedOverCount === 'number'
    && g2.newTodayCount + g2.carriedOverCount === g2.items.length,
    `new=${g2.newTodayCount} carried=${g2.carriedOverCount} total=${g2.items.length}`);
  ok('有沿用记录时 note 明确说明这一点',
    /沿用早前采集/.test(g2.note || ''), String(g2.note || '').slice(0, 90));
  const logMsg = (g2.run.log || []).map((l) => l.msg).join(' | ');
  ok('运行日志里也记下了新采集/沿用的拆分', /今天新采集 \d+ 篇、沿用早前采集 \d+ 篇/.test(logMsg), logMsg.slice(0, 120));

  /* ============ 十一、目标篇数取设置，不写死 ============ */
  console.log('\n【十一】前沿目标篇数取当前设置（不再写死 3）');
  const config = require('../lib/config');
  ok('默认目标篇数来自设置（3）', frontier.get().size === (config.getSettings().frontierSize || 3),
    `size=${frontier.get().size} settings=${config.getSettings().frontierSize}`);
  config.updateSettings({ frontierSize: 2 });
  ok('设置改成 2 后，页面口径跟着变成 2（不是写死的 3）', frontier.get().size === 2, `size=${frontier.get().size}`);
  config.updateSettings({ frontierSize: 3 });

  /* ============ 十二、arXiv 失败原因必须可归类 ============ */
  console.log('\n【十二】arXiv 失败原因诊断（超时 / 限流 / HTTP / 解析），并有界重试');
  const cls = frontier.classifyArxivFailure;
  ok('超时被归类为 timeout', cls({ status: null, error: '超时(45000ms)' }) === 'timeout');
  ok('429 被归类为 throttled', cls({ status: 429, error: 'HTTP 429' }) === 'throttled');
  ok('文案里带「限流」也归为 throttled', cls({ status: null, error: '数据源限流：HTTP 429' }) === 'throttled');
  ok('其他 HTTP 错误归为 http', cls({ status: 503, error: 'HTTP 503' }) === 'http');
  ok('有界重试：最多 3 次（硬上限），默认 2 次',
    /Math\.max\(1, Math\.min\(attempts, 3\)\)/.test(fs.readFileSync(path.join(ROOT, 'lib/frontier.js'), 'utf8')));
  ok('重试前递增退避且不短于官方 3 秒最小间隔',
    /const waitMs = Math\.min\(3000 \* i, 9000\)/.test(fs.readFileSync(path.join(ROOT, 'lib/frontier.js'), 'utf8')));
  ok('被限流时不再继续加重负担（break 出重试）',
    /if \(cause === 'throttled'\) break;/.test(fs.readFileSync(path.join(ROOT, 'lib/frontier.js'), 'utf8')));
  ok('arXiv 单次请求超时上限比全局宽松（45 秒，默认 25 秒）',
    /timeoutMs = 45000/.test(fs.readFileSync(path.join(ROOT, 'lib/frontier.js'), 'utf8')));

  /* ============ 十三、来源状态与 /api/health.frontier ============ */
  console.log('\n【十三】来源状态如实（含 ACL 字段名修复）与 /api/health.frontier');
  const st2 = await frontier.status();
  ok('status() 返回最近一次运行的逐源状态', Array.isArray(st2.lastRunSources));
  /*
   * ACL 的字段名修复（真实缺陷）：aclbib.status() 返回的是 total，
   * 而 frontier 早期写成 st.items，于是页面与日志都显示「库内 undefined 条元数据」。
   * 这里用**离线** collect（只查本地同步状态，不发任何网络请求）验证。
   */
  const aclCollect = await frontier.collect({ sources: ['acl'] });
  const aclEntry = (aclCollect.sources || []).find((x) => x.source === 'acl');
  const aclLog = (aclCollect.log || []).map((l) => l.msg).join(' | ');
  ok('ACL 的条数是数字（不再出现 undefined）',
    aclEntry && typeof aclEntry.items === 'number', aclEntry ? String(aclEntry.items) : '（无 ACL 条目）');
  ok('ACL 日志不出现 undefined', !/undefined/.test(aclLog), aclLog.slice(0, 110));
  ok('只查 ACL 时不会发起 ERIC/arXiv 网络请求（来源清单里没有它们）',
    !(aclCollect.sources || []).some((x) => x.source === 'eric' || x.source === 'arxiv'));
  ok('status() 不再直接用未解析的 lastRun 行',
    st2.lastRun && typeof st2.lastRun === 'object' && !Array.isArray(st2.lastRun));
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok('/api/health 暴露 frontier 区块（含 run / sources / ieee）',
    /frontier: frontierHealth/.test(serverSrc) && /sources: \(f\.sources \|\| \[\]\)\.map/.test(serverSrc)
    && /ieee: frontier\.ieeeStatus\(\)/.test(serverSrc));
  ok('/api/health.frontier 也给出今天新采集/沿用的篇数',
    /newTodayCount: f\.newTodayCount/.test(serverSrc) && /carriedOverCount: f\.carriedOverCount/.test(serverSrc));

  /* -------------------------------- 汇总 -------------------------------- */
  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(62));
  console.log(`  前沿技术来源（ERIC / arXiv / ACL / IEEE）：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(62));

  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
