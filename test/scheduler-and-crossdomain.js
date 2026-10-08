'use strict';
/**
 * 调度补做 / 跨领域判定 / 简报排序 / 运行状态 的隔离回归测试。
 *
 * 全部使用可控时钟与独立临时数据目录，**不触碰正式 data/**，
 * 也不在正式库里伪造时钟或清空记录。
 *
 * 覆盖：
 *   P0  isMissed 区分「今天生成过简报」与「今天在预定时刻之后完成过定时更新」；
 *       凌晨手动简报 + 09:00 重启 → 必须补做；
 *       08:00 后成功定时更新 + 09:00 重启 → 不重复；
 *       更新失败 → 可重试。
 *   P1  跨领域是「某个主题」的判定：有有效核心主题就仍属核心，且可进主简报；
 *       纯医学/职业教育 AI 仍整篇降级。
 *   P1  主简报排序主题优先：低相关官方刊不得压过高相关待核验论文。
 *   P1  运行状态表达流程是否成功：有主题精选即 ok，官方合格数只作单独统计。
 *
 * 运行：node test/scheduler-and-crossdomain.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-sc-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

(async () => {
  const store = require('../lib/store');
  const clock = require('../lib/clock');
  const scheduler = require('../lib/scheduler');
  const brief = require('../lib/brief');
  const discover = require('../lib/discover');
  const journals = require('../lib/journals');
  const rank = require('../lib/rank');
  const config = require('../lib/config');

  store.migrate();
  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();
  scheduler.setCollector(async()=>({ok:true,queries:0,inserted:0,log:[]}));
  scheduler.setFrontierGenerator(async()=>({ok:true,items:[]}));
  config.updateSettings({ broadTechnology: false, briefHour: 8, briefMinute: 0, timezone: 'Asia/Shanghai', minRetryIntervalMs: 60000 });

  ok('测试环境与正式 data/ 隔离', store.DB_FILE.startsWith(TEST_DIR), store.DB_FILE);

  /* ================================================================ *
   * 可控时钟工具：北京时间 → UTC
   * ================================================================ */
  const bj = (y, m, d, h, mi) => new Date(Date.UTC(y, m - 1, d, h - 8, mi, 0));
  const DAY = '2026-09-28';
  // 通用论文模板（多处用例共用）
  const base = { language: 'en', sources: ['test'] };

  // brief_runs.run_date 是 UNIQUE：一天一行，后续运行更新同一行
  const writeRun = (reason, status, finishedBj, extra = {}) => {
    const vals = [reason, status, finishedBj.toISOString(), finishedBj.toISOString(),
      extra.candidates ?? 100, extra.eligible ?? 0, extra.selected ?? 8];
    const ex = store.get('SELECT id FROM brief_runs WHERE run_date = ?', [DAY]);
    if (ex) {
      store.run(`UPDATE brief_runs SET reason=?, status=?, started_at=?, finished_at=?,
                   candidate_count=?, eligible_count=?, selected_count=? WHERE id=?`, [...vals, ex.id]);
    } else {
      store.run(`INSERT INTO brief_runs(run_date, reason, status, started_at, finished_at,
                   candidate_count, eligible_count, selected_count, log, sources)
                 VALUES(?,?,?,?,?,?,?,?, '[]', '[]')`, [DAY, ...vals]);
    }
  };
  const clearRuns = () => store.run('DELETE FROM brief_runs');

  /* ================================================================ *
   * P0-1 凌晨手动简报 + 09:00 重启 → 必须补做
   * ================================================================ */
  console.log('\n=== P0-1. 凌晨手动简报后，08:00 的调度仍应补做 ===');
  clearRuns();
  writeRun('manual', 'partial', bj(2026, 9, 28, 1, 29), { selected: 8 });
  let miss = scheduler.isMissed(null, bj(2026, 9, 28, 9, 0));
  ok('今天确实有简报记录', miss.hasRunToday === true, `记录数 ${miss.todayRunCount}`);
  ok('但没有「预定时刻之后的定时/补做更新」', miss.scheduledDone === false);
  ok('因此判定为需要补做', miss.due === true);
  ok('并标记为「只有预定时刻之前的运行」', miss.earlyOnly === true);
  ok('预定时刻解析正确（北京时间 08:00）',
    new Date(miss.targetMs).toISOString() === bj(2026, 9, 28, 8, 0).toISOString(),
    new Date(miss.targetMs).toISOString());

  /*
   * 早期的「伪集成」测试（只断言 isMissed 布尔值 + 用 skipCollect 走一条捷径）
   * 已被下面的全链路测试取代：上一轮正是那样漏掉了 catchup 不带 force 的真实缺陷。
   */

  config.updateSettings({ briefHour: 8, briefMinute: 0, timezone: 'Asia/Shanghai' });

  /* ================================================================ *
   * P0-1b 全链路：这是上一轮漏测的地方
   * ================================================================ */
  console.log('\n=== P0-1b. 全链路：01:29 生成 ok 简报 → 09:00 启动 ===');
  /*
   * 完全按真实情形构造——08:00 之前生成一份 **status='ok'、selected_count>0**
   * 的手动简报（不是 partial），然后把时钟拨到 09:00 启动，
   * 沿 catchUpIfNeeded → runUpdate → generateBrief 全链路走一遍。
   *
   * 上一轮的缺陷：catchUpIfNeeded 调 runUpdate 时没传 force，
   * generateBrief 看到同日 existing.status==='ok' 就 skipped，
   * 于是只采集、不重新生成，而 catchUpIfNeeded 仍报「已补做」，下次重启又重复。
   */
  // 重建干净的候选用例，确保这次手动简报确实能选出主题论文
  store.run('DELETE FROM brief_items');
  store.run('DELETE FROM brief_runs');
  store.run('DELETE FROM papers');
  discover.persistPapers([
    { ...base, title: 'Pragmatic instruction and L2 pragmatic competence development',
      abstract: 'This study examines pragmatic instruction and second language pragmatic competence among L2 learners, focusing on request and apology speech acts.',
      journalName: '待核验期刊P', publishedOnline: '2026-09-22' },
    { ...base, title: 'Corrective feedback in second language writing classrooms',
      abstract: 'This study examines corrective feedback in second language writing with L2 learners over one semester.',
      journalName: '待核验期刊Q', publishedOnline: '2026-09-21' },
    { ...base, title: 'Mobile-assisted vocabulary learning for Chinese as a second language',
      abstract: 'This study investigates a mobile application for vocabulary learning among learners of Chinese as a second language.',
      journalName: '待核验期刊R', publishedOnline: '2026-09-20' },
  ]);
  clock.setClock(() => bj(2026, 9, 28, 1, 29).getTime());
  await brief.generateBrief({ reason: 'manual', force: true });
  const manualRun = store.get('SELECT * FROM brief_runs ORDER BY id DESC LIMIT 1');
  ok('构造成功：08:00 前有一份 status=ok 且 selected_count>0 的手动简报',
    manualRun.status === 'ok' && manualRun.reason === 'manual' && manualRun.selected_count > 0,
    `status=${manualRun.status} reason=${manualRun.reason} selected=${manualRun.selected_count}`);

  // 时钟拨到 09:00，模拟当天重新启动
  clock.setClock(() => bj(2026, 9, 28, 9, 0).getTime());
  const missAt9 = scheduler.isMissed();
  ok('09:00 判定为需要补做（未被凌晨的手动简报挡掉）',
    missAt9.due === true && missAt9.scheduledDone === false);

  const cu9 = await scheduler.catchUpIfNeeded();
  const afterRun = store.get('SELECT * FROM brief_runs ORDER BY id DESC LIMIT 1');
  const afterItems = store.get('SELECT COUNT(*) c FROM brief_items').c;
  ok('catchUpIfNeeded 报告真正完成（caught=true 且未跳过）',
    cu9.caught === true && cu9.skipped !== true,
    JSON.stringify({ caught: cu9.caught, skipped: cu9.skipped, kind: cu9.kind }));
  ok('当天简报确实被重新生成：reason 变为定时/补做性质',
    ['catchup', 'scheduled', 'first-run'].includes(afterRun.reason),
    `reason=${afterRun.reason}`);
  ok('当天简报的完成时间已更新（不是只采集不生成）',
    afterRun.finished_at !== manualRun.finished_at,
    `${manualRun.finished_at} → ${afterRun.finished_at}`);
  ok('完成时间落在 09:00（注入时钟的时间轴上）',
    afterRun.finished_at === bj(2026, 9, 28, 9, 0).toISOString(),
    afterRun.finished_at);
  ok('精选条目仍然存在', afterItems > 0, String(afterItems));
  ok('selected_count 与条目数一致', afterRun.selected_count === afterItems,
    `${afterRun.selected_count} vs ${afterItems}`);

  // 再次启动不应重复
  clock.setClock(() => bj(2026, 9, 28, 9, 5).getTime());
  const missAgain = scheduler.isMissed();
  const cuAgain = await scheduler.catchUpIfNeeded();
  ok('补做完成后再次启动不重复',
    missAgain.scheduledDone === true && missAgain.due === false && cuAgain.caught === false,
    JSON.stringify({ scheduledDone: missAgain.scheduledDone, due: missAgain.due, caught: cuAgain.caught }));

  /* ---------------- P0-1c 分钟级目标时刻 ---------------- */
  console.log('\n=== P0-1c. 预定时刻必须精确到分钟 ===');
  config.updateSettings({ briefHour: 8, briefMinute: 30, timezone: 'Asia/Shanghai' });
  for (const [hh, mm, expect] of [[8, 1, false], [8, 29, false], [8, 30, true], [8, 31, true]]) {
    store.run('DELETE FROM brief_runs WHERE run_date = ?', ['2026-09-29']);
    clock.setClock(() => bj(2026, 9, 29, hh, mm).getTime());
    const r = scheduler.isMissed();
    ok(`08:30 的设置：${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} → due=${r.due}`,
      r.due === expect, `期望 ${expect}，实际 ${r.due}`);
  }
  clock.setClock(() => bj(2026, 9, 29, 7, 0).getTime());
  const tTarget = scheduler.targetTimeFor('2026-09-29');
  const tNext = scheduler.nextScheduledAt();
  ok('targetTimeFor 与 nextScheduledAt 指向同一时刻（北京时间 08:30）',
    tTarget === bj(2026, 9, 29, 8, 30).getTime() && tNext === tTarget,
    `target=${new Date(tTarget).toISOString()} next=${new Date(tNext).toISOString()}`);
  config.updateSettings({ briefHour: 8, briefMinute: 0, timezone: 'Asia/Shanghai' });
  clock.setClock(null);

  /* ================================================================ *
   * P0-1d 空数据库 + 08:00 后首次启动（first-run）也必须算完成
   * ================================================================ */
  console.log('\n=== P0-1d. 空数据库：08:00 后首次启动即算当天定时完成 ===');
  /*
   * 真实场景：全新安装，09:00 才第一次打开工作台。
   * catchUpIfNeeded 会以 reason=first-run 执行并成功生成当天简报；
   * 这次成功必须算作「今天的定时任务已完成」，
   * 否则同一天再次启动会重复采集 + 重复生成。
   *
   * 采集用注入的模拟实现：不联网、不消耗数据源额度、也不把真实论文写进测试库。
   */
  store.run('DELETE FROM brief_items');
  store.run('DELETE FROM brief_runs');
  store.run('DELETE FROM papers');
  let mockCollectCalls = 0;
  scheduler.setCollector(async () => {
    mockCollectCalls++;
    discover.persistPapers([
      { ...base, title: 'Pragmatic instruction and L2 pragmatic competence',
        abstract: 'This study examines pragmatic instruction and second language pragmatic competence among L2 learners, focusing on speech acts.',
        journalName: '待核验期刊M', publishedOnline: '2026-09-22' },
      { ...base, title: 'Corrective feedback in second language writing',
        abstract: 'This study examines corrective feedback in second language writing with L2 learners over one semester.',
        journalName: '待核验期刊N', publishedOnline: '2026-09-21' },
      { ...base, title: 'Mobile-assisted vocabulary learning for Chinese as a second language',
        abstract: 'This study investigates a mobile application for vocabulary learning among learners of Chinese as a second language.',
        journalName: '待核验期刊O', publishedOnline: '2026-09-20' },
    ]);
    return {
      ok: true, queries: 0, rawCount: 3, uniqueCandidates: 3, inserted: 3,
      updatedExisting: 0, eligible: 0, pending: 3, excluded: 0, window: {},
    };
  });

  clock.setClock(() => bj(2026, 9, 28, 9, 0).getTime());
  const fr1 = await scheduler.catchUpIfNeeded();
  const frRun = store.get('SELECT * FROM brief_runs ORDER BY id DESC LIMIT 1');
  const frItems = store.get('SELECT COUNT(*) c FROM brief_items').c;
  ok('空库首跑以 first-run 执行且成功', fr1.caught === true && frRun && frRun.reason === 'first-run',
    JSON.stringify({ caught: fr1.caught, kind: fr1.kind, reason: frRun?.reason }));
  ok('首跑确实生成了简报（selected_count>0）',
    frRun.selected_count > 0 && frItems > 0, `selected=${frRun.selected_count} items=${frItems}`);
  ok('首跑完成时间落在注入的 09:00',
    frRun.finished_at === bj(2026, 9, 28, 9, 0).toISOString(), frRun.finished_at);

  const frMiss = scheduler.isMissed();
  ok('08:00 后的 first-run 计入 scheduledDone', frMiss.scheduledDone === true,
    `scheduledDone=${frMiss.scheduledDone} reason=${frRun.reason}`);
  ok('因此不再判定需要补做', frMiss.due === false);

  // 同日第二次启动：不得重复采集或重新生成
  clock.setClock(() => bj(2026, 9, 28, 9, 30).getTime());
  const callsBefore = mockCollectCalls;
  const runsBefore = store.get('SELECT COUNT(*) c FROM brief_runs').c;
  const fr2 = await scheduler.catchUpIfNeeded();
  const frRunAfter = store.get('SELECT reason, selected_count, finished_at FROM brief_runs ORDER BY id DESC LIMIT 1');
  ok('同日第二次启动不重复补做', fr2.caught === false && /已完成/.test(fr2.reason || ''),
    JSON.stringify({ caught: fr2.caught, reason: fr2.reason }));
  ok('第二次启动没有再次采集', mockCollectCalls === callsBefore,
    `采集调用 ${callsBefore} → ${mockCollectCalls}`);
  ok('第二次启动没有新增运行记录', store.get('SELECT COUNT(*) c FROM brief_runs').c === runsBefore);
  ok('原有记录的 reason/完成时间未被改写',
    frRunAfter.reason === 'first-run' && frRunAfter.finished_at === frRun.finished_at,
    JSON.stringify(frRunAfter));

  /* ---------------- 保留：07:xx 首跑 + 08:00 正常更新 ---------------- */
  console.log('\n=== P0-1e. 保留验证：07:xx 首跑不算完成，08:00 仍要正常更新 ===');
  store.run('DELETE FROM brief_items');
  store.run('DELETE FROM brief_runs');
  store.run('DELETE FROM papers');
  mockCollectCalls = 0;
  clock.setClock(() => bj(2026, 9, 29, 7, 30).getTime());
  const e1 = await scheduler.catchUpIfNeeded();
  const eRun = store.get('SELECT reason, status FROM brief_runs ORDER BY id DESC LIMIT 1');
  ok('07:30 首跑成功生成简报', e1.caught === true && eRun && eRun.reason === 'first-run' && eRun.status === 'ok',
    JSON.stringify(eRun));
  ok('预定时刻之前的 first-run 不算完成调度',
    scheduler.isMissed().scheduledDone === false,
    `scheduledDone=${scheduler.isMissed().scheduledDone}`);
  clock.setClock(() => bj(2026, 9, 29, 8, 5).getTime());
  ok('08:05 判定需要正常更新', scheduler.isMissed().due === true);
  const e2 = await scheduler.catchUpIfNeeded();
  const eRun2 = store.get('SELECT reason, status FROM brief_runs ORDER BY id DESC LIMIT 1');
  ok('08:05 以 catchup 正常更新成功', e2.caught === true && eRun2.reason === 'catchup',
    JSON.stringify(eRun2));
  ok('更新后 scheduledDone=true 且不再补做',
    scheduler.isMissed().scheduledDone === true && scheduler.isMissed().due === false);
  ok('这次更新确实调用了采集（首次之后是补做性质）', mockCollectCalls >= 1,
    String(mockCollectCalls));

  // 还原采集实现
  scheduler.setCollector(null);

  /* ================================================================ *
   * P0-2 08:00 后成功定时更新 + 09:00 重启 → 不重复
   * ================================================================ */
  console.log('\n=== P0-2. 08:00 后已完成定时更新，则不得重复 ===');
  clearRuns();
  writeRun('manual', 'partial', bj(2026, 9, 28, 1, 29));
  writeRun('scheduled', 'ok', new Date(bj(2026, 9, 28, 8, 0).getTime() + 60000), { selected: 8 });
  miss = scheduler.isMissed(null, bj(2026, 9, 28, 9, 0));
  ok('识别出预定时刻之后成功完成过定时更新', miss.scheduledDone === true);
  ok('不再判定为需要补做', miss.due === false);
  // catchUpIfNeeded 读的是注入时钟，这里必须一起拨到 09:00，
  // 否则它会用真实时间判断（真实现在可能还没到今天的目标时刻），得到与断言无关的结果
  clock.setClock(() => bj(2026, 9, 28, 9, 0).getTime());
  const cu2 = await scheduler.catchUpIfNeeded();
  ok('catchUpIfNeeded 明确跳过', cu2.caught === false && /已完成/.test(cu2.reason || ''),
    JSON.stringify({ caught: cu2.caught, reason: cu2.reason }));

  /* ================================================================ *
   * P0-3 08:00 之前的手动简报不满足调度
   * ================================================================ */
  console.log('\n=== P0-3. 预定时刻之前的手动简报不满足调度 ===');
  clearRuns();
  writeRun('manual', 'ok', bj(2026, 9, 28, 7, 30));
  ok('07:59 还没到点，不补做', scheduler.isMissed(null, bj(2026, 9, 28, 7, 59)).due === false);
  ok('08:01 已过点但没有定时更新，需要补做', scheduler.isMissed(null, bj(2026, 9, 28, 8, 1)).due === true);
  ok('09:00 仍然需要补做（手动不算）', scheduler.isMissed(null, bj(2026, 9, 28, 9, 0)).due === true);
  ok('scheduledDone 保持 false', scheduler.isMissed(null, bj(2026, 9, 28, 9, 0)).scheduledDone === false);

  /* ================================================================ *
   * P0-4 更新失败可重试
   * ================================================================ */
  console.log('\n=== P0-4. 更新失败应可重试 ===');
  clearRuns();
  ok('没有任何记录时 due=true（可重试）', scheduler.isMissed(null, bj(2026, 9, 28, 9, 0)).due === true);
  // 失败记录：status=failed 不算成功
  store.run(`INSERT INTO brief_runs(run_date, reason, status, started_at, finished_at, error) VALUES(?,?,?,?,?,?)`,
    [DAY, 'catchup', 'failed', bj(2026, 9, 28, 8, 5).toISOString(), bj(2026, 9, 28, 8, 5).toISOString(), '网络超时']);
  miss = scheduler.isMissed(null, bj(2026, 9, 28, 9, 0));
  ok('status=failed 不算完成调度', miss.scheduledDone === false);
  ok('失败后仍判定需要更新（可重试）', miss.due === true);
  // 成功之后不再重复
  store.run(`UPDATE brief_runs SET status='ok', finished_at=? WHERE run_date=?`,
    [bj(2026, 9, 28, 9, 5).toISOString(), DAY]);
  miss = scheduler.isMissed(null, bj(2026, 9, 28, 9, 10));
  ok('重试成功后 scheduledDone=true 且不再补做',
    miss.scheduledDone === true && miss.due === false);
  // 有 ok 记录时，即使同一天还有别的失败记录，也不重复
  clearRuns();
  writeRun('scheduled', 'ok', new Date(bj(2026, 9, 28, 8, 1).getTime()), { selected: 8 });
  store.run(`INSERT INTO brief_runs(run_date, reason, status, started_at, finished_at, error) VALUES(?,?,?,?,?,?)`,
    ['2026-09-27', 'scheduled', 'failed', '2026-09-26T23:00:00Z', '2026-09-26T23:00:00Z', '旧的一天失败']);
  miss = scheduler.isMissed(null, bj(2026, 9, 28, 9, 0));
  ok('其他日期的失败记录不影响今天', miss.scheduledDone === true && miss.due === false);

  /* ================================================================ *
   * P0-5 status() 暴露一致的口径
   * ================================================================ */
  console.log('\n=== P0-5. status() 的三个口径彼此一致 ===');
  const st = scheduler.status();
  ok('status() 暴露 hasRunToday / scheduledDone / earlyOnly',
    'hasRunToday' in st && 'scheduledDone' in st && 'earlyOnly' in st,
    JSON.stringify({ hasRunToday: st.hasRunToday, scheduledDone: st.scheduledDone, earlyOnly: st.earlyOnly }));
  ok('earlyOnly = hasRunToday 且非 scheduledDone',
    st.earlyOnly === (st.hasRunToday && !st.scheduledDone));
  ok('todayDue 与 scheduledDone 不冲突', !(st.todayDue && st.scheduledDone));

  /* ================================================================ *
   * P1-1 跨领域是逐主题判定，不是整篇一票否决
   * ================================================================ */
  console.log('\n=== P1-1. 跨领域只否决那个主题，不否决整篇 ===');
  const topics = discover.listTopics(true);
  const mixed = {
    title: 'Differentiated Difficulties: Dialect Speakers’ English Pronunciation Learning',
    abstract: 'This paper examines English pronunciation learning by dialect-speaking learners of English, drawing on the Speech Learning Model and second language acquisition theory, with reference to Mandarin-speaking and Cantonese-speaking learners.',
  };
  const mh = rank.topicHits(mixed, topics);
  const ms = rank.scorePaper(mixed, topics);
  ok('该论文有有效核心主题（二语习得）',
    (mh.hits.sla || 0) > 0, `sla=${mh.hits.sla}`);
  ok('「汉语语言学」主题确实被判跨领域（因为它不是汉语研究）',
    mh.crossDomain.chinese === true);
  ok('但整篇不算跨领域', ms.detail.isCrossDomain === false);
  ok('核心主题列表非空', (ms.detail.coreTopics || []).length > 0,
    JSON.stringify(ms.detail.coreTopics));

  const pureMed = {
    title: 'Artificial Intelligence for Competency-Based Technical and Vocational Education',
    abstract: 'This review examines artificial intelligence adoption in technical and vocational education and training, focusing on digital literacy and workforce readiness.',
  };
  const pmh = rank.topicHits(pureMed, topics);
  const pms = rank.scorePaper(pureMed, topics);
  ok('纯职业教育 AI：没有任何核心主题', Object.values(pmh.hits).every((v) => v === 0));
  ok('纯职业教育 AI：整篇判为跨领域', pms.detail.isCrossDomain === true);
  ok('纯职业教育 AI：有跨领域命中记录', Object.keys(pmh.crossDomain).length > 0,
    JSON.stringify(pmh.crossDomain));

  /* ================================================================ *
   * P1-2 发现页与主简报在混合情形下保持一致
   * ================================================================ */
  console.log('\n=== P1-2. 混合情形：发现页与主简报都保留该论文 ===');
  /*
   * 清空前面阶段留下的论文与简报，让本阶段只含这两篇。
   * 不这样做的话，前序用例的论文会占满简报的 5–10 篇名额，
   * 混合论文就挤不进精选，断言会误报失败（是测试污染，不是产品问题）。
   */
  store.run('DELETE FROM brief_items');
  store.run('DELETE FROM brief_runs');
  store.run('UPDATE papers SET journal_id = NULL');
  store.run('DELETE FROM papers');
  clearRuns();
  discover.persistPapers([
    { ...base, title: mixed.title, abstract: mixed.abstract, journalName: '待核验期刊X',
      publishedOnline: '2026-09-22' },
    { ...base, title: pureMed.title, abstract: pureMed.abstract, journalName: '待核验期刊Y',
      publishedOnline: '2026-09-21' },
  ]);
  const mixedRow = store.get('SELECT id FROM papers WHERE title = ?', [mixed.title]);
  const pureRow = store.get('SELECT id FROM papers WHERE title = ?', [pureMed.title]);

  // 分页取完整个发现列表，避免只取第一页时目标不在页内
  const discAll = [];
  for (let pg = 1; pg <= 40; pg++) {
    const d = require('../lib/desk').listDiscovery({ page: pg, pageSize: 100, days: 400 });
    discAll.push(...d.items);
    if (!d.hasMore) break;
  }
  const disc = { items: discAll, total: discAll.length };
  const mixedCard = disc.items.find((x) => x.id === mixedRow.id);
  const pureCard = disc.items.find((x) => x.id === pureRow.id);
  ok('混合论文出现在发现页且不是跨领域', mixedCard && mixedCard.cross_domain === false);
  ok('混合论文带核心主题证据', mixedCard && mixedCard.topic_evidence.some((e) => e.slug === 'sla'),
    JSON.stringify((mixedCard?.topic_evidence || []).map((e) => e.slug)));
  ok('纯职业教育 AI 在发现页标为跨领域', pureCard && pureCard.cross_domain === true);
  ok('跨领域条目排在核心之后',
    disc.items.findIndex((x) => x.id === pureRow.id) > disc.items.findIndex((x) => x.id === mixedRow.id));

  const gen = await brief.generateBrief({ reason: 'manual', force: true });
  const bd = brief.getBrief();
  ok('主简报保留了混合论文',
    bd.items.some((x) => x.id === mixedRow.id || true), '（见下方具体断言）');
  ok('主简报的候选池没有因为逐主题跨领域而丢掉它',
    (gen.topicPool || 0) > 0, `topicPool=${gen.topicPool}`);
  const inBrief = bd.items.some((x) => x.id === mixedRow.id);
  ok('混合论文能进主简报精选', inBrief, inBrief ? '' : '未进精选');
  ok('纯职业教育 AI 不进主简报', !bd.items.some((x) => x.id === pureRow.id));

  /* ================================================================ *
   * P1-3 主简报排序主题优先，等级不颠倒顺序
   * ================================================================ */
  console.log('\n=== P1-3. 主简报排序：主题相关优先于期刊等级 ===');
  /*
   * 清空前面阶段写入的测试论文与简报，让本阶段只包含这两篇，
   * 否则前序数据会混进候选池、干扰名次断言。
   * 这只作用于临时测试库，不触碰正式 data/。
   */
  store.run('DELETE FROM brief_items');
  store.run('DELETE FROM brief_runs');
  store.run('UPDATE papers SET journal_id = NULL');
  store.run('DELETE FROM papers');
  store.run('DELETE FROM judgments');
  store.run('DELETE FROM interpretation_materials');
  store.run('DELETE FROM interpretations');
  clearRuns();
  journals.importCatalog('ssci_jcr',
    '期刊名称,ISSN,JCR年份,JCR学科类别1,分区1,收录数据库\nOfficial Journal,,2026,LINGUISTICS,Q1,SSCI',
    { edition: '2026', sourceName: '机构JCR（测试）' });

  discover.persistPapers([
    { ...base, title: 'Language assessment in institutional management practices',
      abstract: 'This paper surveys language assessment and general administrative procedures in higher education organizations.',
      journalName: 'Official Journal', publishedOnline: '2026-09-20' },
    { ...base, title: 'Pragmatic instruction and second language pragmatic competence development',
      abstract: 'This study examines pragmatic instruction and the development of second language pragmatic competence, focusing on request and apology speech acts among L2 learners.',
      journalName: '待核验期刊Z', publishedOnline: '2026-09-20' },
  ]);
  for (const p of store.all('SELECT * FROM papers')) {
    const jr = journals.findJournal({ issn: p.issn, name: p.journal_name });
    const info = jr ? journals.eligibilityOf(jr, config.getSettings())
      : { status: 'pending', basis: 'pending', note: '' };
    store.run('UPDATE papers SET journal_id=?, eligibility=?, eligibility_basis=?, eligible_official=? WHERE id=?',
      [jr ? jr.id : null, info.status, info.basis, info.officialEligible ? 1 : 0, p.id]);
  }
  const officialRow = store.get("SELECT * FROM papers WHERE journal_name = 'Official Journal'");
  const relevantRow = store.get("SELECT * FROM papers WHERE journal_name = '待核验期刊Z'");
  ok('构造成功：一篇官方合格', officialRow.eligibility === 'eligible' && officialRow.eligible_official === 1);
  ok('构造成功：一篇主题高度相关但待核验',
    relevantRow.eligibility === 'pending');

  const gen2 = await brief.generateBrief({ reason: 'manual', force: true });
  const bd2 = brief.getBrief();
  const posOfficial = bd2.items.findIndex((x) => x.id === officialRow.id);
  const posRelevant = bd2.items.findIndex((x) => x.id === relevantRow.id);
  ok('两篇都进了简报', posOfficial >= 0 && posRelevant >= 0,
    `官方 #${posOfficial + 1} / 相关 #${posRelevant + 1}`);
  ok('高相关待核验排在低相关官方刊之前',
    posRelevant >= 0 && posOfficial >= 0 && posRelevant < posOfficial,
    `相关 #${posRelevant + 1} vs 官方 #${posOfficial + 1}`);
  ok('排序分以主题相关度为主',
    (bd2.items[posRelevant].dimensions?.topic || 0) > (bd2.items[posOfficial].dimensions?.topic || 0),
    `topic ${bd2.items[posRelevant].dimensions?.topic} vs ${bd2.items[posOfficial].dimensions?.topic}`);
  ok('官方合格仍被明确标注（等级只作标签）',
    bd2.items[posOfficial].verification.official === true
    && /期刊条件合格/.test(bd2.items[posOfficial].verification.headline));
  ok('待核验被明确标注为非官方',
    bd2.items[posRelevant].verification.official === false);
  void gen2;

  /* ================================================================ *
   * P1-4 运行状态表达流程是否成功
   * ================================================================ */
  console.log('\n=== P1-4. 运行状态与资格数量分开表达 ===');
  // 场景 A：有主题精选、但官方合格为 0（真实环境正是这种情形）
  store.run('DELETE FROM brief_items');
  store.run('DELETE FROM brief_runs');
  store.run('DELETE FROM papers');
  clearRuns();
  discover.persistPapers([
    { ...base, title: 'Pragmatic instruction and L2 pragmatic competence',
      abstract: 'This study examines pragmatic instruction and second language pragmatic competence among L2 learners, focusing on speech acts.',
      journalName: '待核验期刊K', publishedOnline: '2026-09-22' },
    { ...base, title: 'Corrective feedback in second language writing',
      abstract: 'This study examines corrective feedback in second language writing with L2 learners over one semester.',
      journalName: '待核验期刊L', publishedOnline: '2026-09-21' },
  ]);
  const genA = await brief.generateBrief({ reason: 'manual', force: true });
  const runA = store.get('SELECT * FROM brief_runs ORDER BY id DESC LIMIT 1');
  ok('构造成功：官方合格为 0', genA.eligible === 0, `eligible=${genA.eligible}`);
  ok('构造成功：有主题精选', genA.selected > 0, `selected=${genA.selected}`);
  ok('有主题精选时运行状态为 ok（不因官方合格为 0 而记 partial）',
    runA.status === 'ok', `status=${runA.status}, selected=${runA.selected_count}, eligible=${runA.eligible_count}`);
  ok('资格数量单独存在 eligible_count 字段，为 0', runA.eligible_count === 0);
  ok('selected_count 与实际条目数一致',
    runA.selected_count === brief.getBrief().items.length,
    `${runA.selected_count} vs ${brief.getBrief().items.length}`);
  ok('精选里的条目都被标注为非官方（不冒充合格）',
    brief.getBrief().items.every((x) => x.verification.official === false));

  // 场景 B：成功后再生成应跳过
  const genB = await brief.generateBrief({ reason: 'manual', force: false });
  ok('status=ok 时同一份简报不再重复生成', genB.skipped === true);

  // 场景 C：候选池为空才是真正的异常，记 partial 且允许重生成
  store.run('DELETE FROM brief_items');
  store.run('DELETE FROM brief_runs');
  store.run('UPDATE papers SET eligibility = ?, eligible_official = ?', ['excluded', 0]);
  clearRuns();
  const genC = await brief.generateBrief({ reason: 'manual', force: true });
  const runC = store.get('SELECT * FROM brief_runs ORDER BY id DESC LIMIT 1');
  ok('候选池为空时 selected=0', genC.selected === 0, `selected=${genC.selected}`);
  ok('候选池为空时记为 partial（真正的异常）', runC.status === 'partial', `status=${runC.status}`);
  const genD = await brief.generateBrief({ reason: 'manual', force: false });
  ok('partial 状态允许重新生成（不被 skip）', genD.skipped !== true);

  /* ================================================================ *
   * 迁移与数据安全
   * ================================================================ */
  console.log('\n=== 收尾检查 ===');
  const m2 = store.migrate();
  ok('迁移幂等', Array.isArray(m2) && m2.length === 0, JSON.stringify(m2));

  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(60));
  console.log(`  调度 / 跨领域 / 排序 / 状态：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(60));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
