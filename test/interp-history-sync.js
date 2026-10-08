'use strict';
/**
 * 「解读记录」即时同步回归测试。
 *
 * 起因（真实 Safari 页面发现）：点「快速解读」生成成功后，页面顶部总数从 5 变 6，
 * 但同一页下方的「解读记录」仍写「0 条」；按 Safari 刷新后才变成「1 条」。
 * 也就是说「本次结果」和「解读记录」用的是两份互不同步的状态。
 *
 * 期望：生成 / 追问 / 删除 / 重新解读后，历史列表与计数**当次就**同步，
 * 不需要手动刷新；而且列表里那条记录的时间，与刚生成时显示的时间完全一致。
 *
 * 运行：node test/interp-history-sync.js
 * 不联网（AI 调用走注入的模拟实现），不触碰项目 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-hs-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/* ================================================================ *
 * 1. 静态契约：生成成功后必须同步历史区，而不是只刷新页脚
 * ================================================================ */
console.log('\n=== 1. 生成路径必须调用历史同步 ===');

/** 取出一个函数的源码体（按大括号配对） */
function fnBody(name) {
  const sig = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = sig.exec(appSrc);
  if (!m) return null;
  let i = appSrc.indexOf('{', m.index + m[0].length - 1);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < appSrc.length; j++) {
    if (appSrc[j] === '{') depth++;
    else if (appSrc[j] === '}') { depth--; if (depth === 0) return appSrc.slice(i, j + 1); }
  }
  return null;
}

for (const fn of ['runInterpret', 'askFollowup', 'regenerateInterpretation', 'deleteInterp']) {
  const body = fnBody(fn);
  ok(`能定位 ${fn}`, Boolean(body));
  if (!body) continue;
  const syncs = /syncInterpHistory\s*\(/.test(body) || /keepInterpBox/.test(body);
  ok(`${fn} 生成/删除后同步历史区`, syncs,
    syncs ? '' : '只刷新页脚或整页重绘，历史区可能仍是旧值');
}

const runBody = fnBody('runInterpret') || '';
ok('runInterpret 不再只调用 refreshFoot()',
  !/^\s*refreshFoot\(\);\s*$/m.test(runBody) || /syncInterpHistory/.test(runBody));

/* ================================================================ *
 * 2. 列表与计数共用同一份渲染，避免又出现两套口径
 * ================================================================ */
console.log('\n=== 2. 列表与计数只有一份实现 ===');
ok('存在共享的计数文案函数 interpHistoryCountText', /function interpHistoryCountText\(/.test(appSrc));
ok('存在共享的列表渲染函数 interpHistoryListHtml', /function interpHistoryListHtml\(/.test(appSrc));
ok('初次渲染用共享函数', /\$\{interpHistoryCountText\(d\.interpretations\)\}/.test(appSrc)
  && /\$\{interpHistoryListHtml\(d, p\.id\)\}/.test(appSrc));
ok('同步时也用同一对共享函数',
  /countEl\.textContent = interpHistoryCountText\(/.test(appSrc)
  && /host\.innerHTML = interpHistoryListHtml\(/.test(appSrc));
ok('计数元素有稳定 id（同步时能定位）', /id="interpHistoryCount"/.test(appSrc));

/* ================================================================ *
 * 3. 真实链路：生成后立刻查库，计数与列表当次就更新
 * ================================================================ */
(async () => {
  const store = require('../lib/store');
  const clock = require('../lib/clock');
  const config = require('../lib/config');
  const journals = require('../lib/journals');
  const discover = require('../lib/discover');
  const library = require('../lib/library');
  const interpret = require('../lib/interpret');

  store.migrate();
  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();
  // 指向本机端点：无需密钥即可走真实生成链路，而 fetch 已被下面的模拟替换，不会真的联网
  config.updateSettings({
    briefHour: 8, briefMinute: 0, timezone: 'Asia/Shanghai',
    aiBaseUrl: 'http://127.0.0.1:9', aiModel: 'mock-model',
  });

  /**
   * 复刻 server.js 里 GET /api/papers/:id 的组装方式
   * （详情 + 解读列表 + 每条是否有材料快照）。
   * 前端「解读记录」用的就是这份数据，所以测试必须走同一条路。
   */
  const detailLikeApi = (paperId) => {
    const d = library.getPaperDetail(paperId);
    if (!d) return null;
    return {
      ...d,
      interpretations: interpret.listInterpretations(paperId).map((it) => {
        const mats = store.all('SELECT sid FROM interpretation_materials WHERE interp_id = ?', [it.id]);
        return { ...it, materialCount: mats.length, hasSnapshot: mats.length > 0 };
      }),
    };
  };

  console.log('\n=== 3. 生成后当次读到的记录数 ===');
  clock.setClock(() => new Date(Date.UTC(2026, 8, 27, 19, 10, 3)).getTime()); // 北京时间 09-28 03:10

  discover.persistPapers([{
    title: 'Pragmatic instruction and second language pragmatic competence development',
    abstract: 'This study examines pragmatic instruction and second language pragmatic competence with L2 learners. '
      + 'Data were collected through discourse completion tasks and analyzed with mixed-effects models.',
    journalName: '待核验期刊HS', language: 'en', publishedOnline: '2026-09-20', sources: ['test'],
  }]);
  const pid = store.get('SELECT id FROM papers ORDER BY id DESC LIMIT 1').id;

  const beforeDetail = detailLikeApi(pid);
  ok('生成前详情页解读条数为 0', beforeDetail.interpretations.length === 0,
    `${beforeDetail.interpretations.length} 条`);

  // 用模拟模型跑一次真实生成链路（不联网）
  const prevFetch = globalThis.fetch;
  const mockPayload = {
    model: 'mock-model',
    choices: [{ message: { content: '研究问题：语用教学能否提升二语语用能力 [S1]。' }, finish_reason: 'stop' }],
    usage: { total_tokens: 42 },
  };
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(mockPayload),
    json: async () => mockPayload,
  });
  let gen;
  try {
    gen = await interpret.interpret({ paperId: pid, mode: 'quick' });
  } finally {
    globalThis.fetch = prevFetch;
  }
  ok('生成成功', Boolean(gen && gen.ok), gen && gen.error);
  ok('生成响应带 createdAt（来自库里那条记录）', Boolean(gen && gen.createdAt), gen && gen.createdAt);

  // 这是关键：不重新加载页面，直接读「当前」详情 —— 计数必须已经是 1
  const afterDetail = detailLikeApi(pid);
  ok('生成后当次详情页解读条数即为 1', afterDetail.interpretations.length === 1,
    `${afterDetail.interpretations.length} 条`);
  ok('列表里就是刚生成的那条',
    afterDetail.interpretations[0].id === gen.id,
    `列表 ${afterDetail.interpretations[0].id} vs 生成 ${gen.id}`);

  console.log('\n=== 4. 列表时间与刚生成时显示的时间一致 ===');
  const time = require('../lib/time');
  const listTime = afterDetail.interpretations[0].createdAt;
  ok('列表时间的北京时间 = 生成那一刻', time.fmtShanghai(listTime) === '2026/09/28 03:10',
    time.fmtShanghai(listTime));
  ok('生成响应时间与列表时间是同一时刻',
    time.parse(gen.createdAt).getTime() === time.parse(listTime).getTime(),
    `${time.parse(gen.createdAt).toISOString()} vs ${time.parse(listTime).toISOString()}`);
  ok('列表时间带明确时区（Z 结尾）', /Z$/.test(String(listTime)), String(listTime));

  console.log('\n=== 5. 删除后计数同样当次更新 ===');
  store.run('DELETE FROM interpretations WHERE id = ?', [gen.id]);
  const afterDel = detailLikeApi(pid);
  ok('删除后当次条数回到 0', afterDel.interpretations.length === 0,
    `${afterDel.interpretations.length} 条`);

  console.log('\n=== 6. 页脚总数与详情页条数一致（不再一个 5 一个 0） ===');
  const stats = library.libraryStats();
  const detail4 = detailLikeApi(pid);
  ok('libraryStats.interpretations 与详情页条数一致',
    stats.interpretations === detail4.interpretations.length,
    `页脚 ${stats.interpretations} vs 详情 ${detail4.interpretations.length}`);

  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(62));
  console.log(`  解读记录即时同步：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(62));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
