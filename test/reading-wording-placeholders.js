'use strict';
/**
 * 科研阅读用词与元数据占位符回归测试。
 *
 * 起因（真实 Safari 页面确认）：
 *   ① 今日发现统计栏写「745 可读」——实际只是 30 天窗口内的主题候选，
 *      多数只有题录/摘要，并未确认能读到全文；
 *   ② 同栏「核心 509」容易被读成「北大核心」期刊等级合格，
 *      实际含义是「主题核心 / 本领域匹配」；
 *   ③ 简报第 2 篇 paper/385 卷期页显示字面量「None-None」——
 *      那是 Crossref 对某些出版商原样返回的 Python None 占位符。
 *
 * 本测试锁定这三处，并确保**真实元数据不被误删**。
 *
 * 运行：node test/reading-wording-placeholders.js
 * 不联网、不碰项目 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-rw2-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const N = require('../lib/normalize');

/* ================================================================ *
 * 1. 「可读」不能再用来指代主题候选
 * ================================================================ */
console.log('\n=== 1. 「可读」表述已改 ===');
ok('今日发现页不再出现「可读」作为统计口径',
  !/>\$\{d\.total\}<\/b> 可读/.test(appSrc) && !/\$\{d\.total\}<\/b> 可读/.test(appSrc));
// 统计条现在用 scopeLabel（默认「中英文主题候选」/全部「全部语种主题候选」），
// 统一口径仍是「主题候选」，不再裸写「可读」
ok('改为「主题候选」口径',
  /esc\(c\.scopeLabel \|\| c\.labels\?\.total \|\| '主题候选'\)/.test(appSrc));
ok('口径说明明确「有摘要 ≠ 有全文」',
  /有摘要 ≠ 有全文/.test(appSrc), '');
ok('口径说明明确不代表已确认可读全文',
  /不代表已确认能读到全文/.test(appSrc));
// 统计条的作用域提示改由 scopeLabel 承担；「有摘要≠有全文」在口径说明里
ok('统计条明确是本次视图范围',
  /本次视图范围内的主题相关候选，不等于已确认可读全文/.test(appSrc));

const labels = (() => {
  const s = fs.readFileSync(path.join(ROOT, 'lib/desk.js'), 'utf8');
  return {
    total: /total: '主题候选'/.test(s),
    core: /core: '主题核心'/.test(s),
    cross: /crossDomain: '跨领域参考'/.test(s),
    coreNote: /主题匹配.*与「北大核心」期刊等级无关/s.test(s),
    basis: /不等于已确认可读全文/.test(s),
  };
})();
console.log('\n=== 2. 后端标签是唯一口径来源 ===');
ok("desk.js labels.total = '主题候选'", labels.total);
ok("desk.js labels.core = '主题核心'", labels.core);
ok("desk.js labels.crossDomain = '跨领域参考'", labels.cross);
ok('desk.js 有 coreNote 说明与北大核心无关', labels.coreNote);
ok('desk.js basis 说明不等于已确认可读全文', labels.basis);

/* ================================================================ *
 * 3. 「主题核心」必须与「北大核心」区分
 * ================================================================ */
console.log('\n=== 3. 主题核心 vs 北大核心 ===');
ok('统计条用「主题核心」而不是裸「核心」',
  /esc\(c\.labels\?\.core \|\| '主题核心'\)/.test(appSrc));
ok('统计条 title 说明与北大核心无关',
  /title="主题匹配概念，与「北大核心」期刊等级无关"/.test(appSrc));
ok('口径说明写明与「北大核心」完全无关',
  /与「北大核心」期刊等级完全无关/.test(appSrc));
ok('跨领域卡片也点明「核心」指主题匹配',
  /这里的「核心」指主题匹配，与「北大核心」期刊等级无关/.test(appSrc));
ok('跨领域仍然单列（保留独立标签）',
  /跨领域方法参考/.test(appSrc) && /labels\?\.crossDomain/.test(appSrc));
// 「北大核心」仍然只出现在期刊等级语境
const pkLines = appSrc.split('\n').filter((l) => /北大核心/.test(l));
ok('「北大核心」只出现在期刊等级相关文案里',
  pkLines.every((l) => /期刊|CSSCI|合格|目录|tier-cn-core|等级/.test(l)),
  `${pkLines.length} 行`);

/* ================================================================ *
 * 4. 占位符清洗：真实数据必须原样保留
 * ================================================================ */
console.log('\n=== 4. 占位符清洗不误伤真实数据 ===');
const shouldDrop = ['None-None', 'None', 'none-null', 'null', 'N/A', 'n/a', 'undefined', 'nil', 'NaN', '', '   ', '-', '—'];
for (const v of shouldDrop) {
  ok(`「${v}」被判为无效`, N.cleanPlaceholder(v) === null, String(N.cleanPlaceholder(v)));
}
const shouldKeep = ['134', '1-21', '1–21', 'e12345', 'S1-S10', '2753-7048', '12(3)', 'Article 5', '2026', '1-21-30'];
for (const v of shouldKeep) {
  ok(`真实值「${v}」被保留`, N.cleanPlaceholder(v) === v, String(N.cleanPlaceholder(v)));
}
ok('半真半假「None-10」保留真实部分', N.cleanPlaceholder('None-10') === '10');
ok('半真半假「10-None」保留真实部分', N.cleanPlaceholder('10-None') === '10');

/* ================================================================ *
 * 5. 前端显示层：占位符不落到页面上
 * ================================================================ */
console.log('\n=== 5. 前端显示层同样清洗 ===');
function loadFrontendBibHelpers() {
  const i = appSrc.indexOf('const BIB_PLACEHOLDER =');
  const j = appSrc.indexOf('/** 卡片上的卷/期信息');
    // 用「fmtDateTime 定义之前」作为结束位置，比匹配某条注释文本更稳
    const k = appSrc.indexOf('function fmtDateTime(d)');
    if (i < 0 || j < 0 || k <= j) throw new Error('未能定位 app.js 的卷期页函数区域');
  // esc 在浏览器里可用，测试里给一个最小等价实现
  const esc = (s) => String(s == null ? '' : s);
  const body = appSrc.slice(i, j) + appSrc.slice(j, k);
  return new Function('esc', `${body}\nreturn { cleanBibValue, bibLine, bibDetail };`)(esc);
}
const F = loadFrontendBibHelpers();
ok('前端 cleanBibValue 同样丢弃 None-None', F.cleanBibValue('None-None') === '');
ok('前端 cleanBibValue 保留 134', F.cleanBibValue('134') === '134');
ok('前端 cleanBibValue 保留 S1-S10', F.cleanBibValue('S1-S10') === 'S1-S10');
ok('卡片不渲染占位符页码',
  !F.bibLine({ volume: '150', issue: '1', pages: 'None-None' }).includes('None'),
  F.bibLine({ volume: '150', issue: '1', pages: 'None-None' }));
ok('卡片保留真实卷期页',
  F.bibLine({ volume: '150', issue: '1', pages: '1-21' }).includes('第 150 卷')
  && F.bibLine({ volume: '150', issue: '1', pages: '1-21' }).includes('1-21'));
// 卷期页每项都带标签，缺哪项省略哪项（旧版只把非空值用 " / " 连接，
// 卷为空时会显示成「2 / 268-286」，看不出那个 2 是期号）
ok('详情的卷期页不出现占位符',
  F.bibDetail({ volume: '150', issue: '1', pages: 'None-None' }) === '第 150 卷 · 第 1 期',
  F.bibDetail({ volume: '150', issue: '1', pages: 'None-None' }));
ok('卷为空时期号仍带标签',
  F.bibDetail({ volume: null, issue: '2', pages: '268-286' }) === '第 2 期 · 页 268-286',
  F.bibDetail({ volume: null, issue: '2', pages: '268-286' }));
ok('详情的卷期页全空时返回空串（渲染为 —）',
  F.bibDetail({ volume: null, issue: null, pages: 'None-None' }) === '');

/* ================================================================ *
 * 6. 全链路：占位符既不进库、也不出口
 * ================================================================ */
(async () => {
  const store = require('../lib/store');
  const clock = require('../lib/clock');
  const journals = require('../lib/journals');
  const discover = require('../lib/discover');
  const desk = require('../lib/desk');
  const brief = require('../lib/brief');
  const config = require('../lib/config');

  store.migrate();
  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();
  config.updateSettings({ briefHour: 8, briefMinute: 0, timezone: 'Asia/Shanghai' });
  clock.setClock(() => new Date(Date.UTC(2026, 8, 28, 1, 0)).getTime());

  console.log('\n=== 6. 采集进来的占位符不会入库 ===');
  // 模拟上游真的给了 "None-None"（这正是 Crossref 的行为）
  discover.persistPapers([
    {
      title: 'Explicit Instruction of Request and Refusal Speech Acts in High School English',
      abstract: 'This study examines explicit pragmatic instruction of request and refusal speech acts with L2 learners in classroom intervention.',
      journalName: 'Lecture Notes in Education Psychology and Public Media',
      volume: '150', issue: '1', pages: 'None-None',
      publishedOnline: '2026-09-22', language: 'en', sources: ['crossref'],
      doi: '10.54254/2753-7048/2026.pe37039',
    },
    {
      title: 'Pragmatic instruction and second language pragmatic competence development',
      abstract: 'This study examines pragmatic instruction and second language pragmatic competence with L2 learners over one semester.',
      journalName: '待核验期刊PH',
      volume: null, issue: '2', pages: '1-21',
      publishedOnline: '2026-09-21', language: 'en', sources: ['crossref'],
      doi: '10.9999/test.keep.pages',
    },
  ]);

  const badRow = store.get("SELECT id, pages, volume, issue, doi_norm FROM papers WHERE doi_norm = '10.54254/2753-7048/2026.pe37039'");
  ok('占位符页码没有入库（存 null）', badRow.pages === null, JSON.stringify(badRow.pages));
  ok('同篇的真实卷/期被保留', badRow.volume === '150' && badRow.issue === '1',
    `v=${badRow.volume} i=${badRow.issue}`);
  ok('DOI 未被改动', badRow.doi_norm === '10.54254/2753-7048/2026.pe37039');

  const goodRow = store.get("SELECT id, pages FROM papers WHERE doi_norm = '10.9999/test.keep.pages'");
  ok('真实页码 1-21 原样入库', goodRow.pages === '1-21', JSON.stringify(goodRow.pages));

  console.log('\n=== 7. 出口（API）也不会透出占位符 ===');
  // 直接往库里塞一个历史遗留的占位符，验证出口清洗有效
  store.run("UPDATE papers SET pages = 'None-None' WHERE id = ?", [badRow.id]);
  const d = desk.listDiscovery({ page: 1, pageSize: 50, journalFilter: 'all' });
  const card = (d.items || []).find((x) => x.id === badRow.id);
  ok('今日发现 API 里该篇存在', Boolean(card));
  ok('出口把占位符清成 null', card && card.pages === null, card && JSON.stringify(card.pages));
  ok('出口保留了真实卷/期', card && card.volume === '150' && card.issue === '1');

  const det = require('../lib/library').getPaperDetail(badRow.id);
  ok('详情 API 的 pages 也被清成 null', det.pages === null, JSON.stringify(det.pages));
  ok('详情 API 的 title 未被改动',
    /Explicit Instruction/.test(det.title));

  console.log('\n=== 8. 统计口径文案随接口一起返回 ===');
  ok('接口返回 labels.total = 主题候选',
    d.counts.labels.total === '主题候选', d.counts.labels.total);
  ok('接口返回 labels.core = 主题核心',
    d.counts.labels.core === '主题核心', d.counts.labels.core);
  ok('接口返回 coreNote（与北大核心无关）',
    /北大核心/.test(d.counts.coreNote || ''), (d.counts.coreNote || '').slice(0, 60));
  ok('接口 basis 说明不等于已确认可读全文',
    /不等于已确认可读全文/.test(d.counts.basis || ''), (d.counts.basis || '').slice(0, 80));
  // 这些文案经 esc() 原样显示，带 Markdown 的 ** 会变成字面星号
  ok('coreNote 不含未渲染的 Markdown 标记', !/\*\*/.test(d.counts.coreNote || ''),
    (d.counts.coreNote || '').slice(0, 40));
  ok('basis 不含未渲染的 Markdown 标记', !/\*\*/.test(d.counts.basis || ''),
    (d.counts.basis || '').slice(0, 40));

  ok('统计里 core + crossDomain === total',
    d.counts.core + d.counts.crossDomain === d.total,
    `${d.counts.core} + ${d.counts.crossDomain} = ${d.total}`);

  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(62));
  console.log(`  用词与占位符：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(62));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
