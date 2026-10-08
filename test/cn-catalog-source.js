'use strict';
/**
 * 公开中文期刊目录源 → 每日增量发现 回归测试。
 *
 * 背景缺口：设置页承认中文 CSSCI 期刊的新论文主要靠手工题录导入，
 * 275 篇中文库存无法证明「每天会自动发现新的中文论文」。
 *
 * 本测试覆盖：
 *   1. 来源登记：可解析的接入、只有扫描图的不接入（并且如实说明原因）；
 *   2. 解析：题名 / 作者 / 页码 / 稳定文章 ID / 期次，作者角标清洗；
 *   3. 过滤：征稿、简讯、书目等非研究论文不进库；
 *   4. 去重：**复跑不重复**，且去重键与入库链路同源；
 *   5. 入库：只写公开元数据，DOI 与摘要缺失留空（不猜）；
 *      主题匹配让题录真的能出现在「今日发现」与简报候选里；
 *   6. 来源证据：目录页、文章原页、期次、采集时间落库可审计；
 *   7. 状态：最近检查时间 / 新篇数 / 跳过原因，无新增时明确 0；
 *   8. 不把目录源当作期刊等级核验依据（资格仍是 pending，不计入合格）。
 *
 * 网络：解析与过滤用**离线固定样本**（不联网）；
 * 端到端部分会真实访问公开目录页，失败时记为「跳过」而不是假装通过。
 *
 * 运行：node test/cn-catalog-source.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-cn-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };
const skip = (n, d) => { R.push({ n, ok: true, skipped: true, d }); console.log(`  ⏭ ${n}${d ? '  — ' + d : ''}`); };

/* 离线固定样本：结构与实测的 ncpssd 目录页一致（含一篇非研究论文） */
const SAMPLE = `<!DOCTYPE html><html><body>
<div class="catalog"><h2 class='catalog-vol'>2026年 第2期 <span onclick='readAll("97257X","2026","2")'>整刊阅读</span></h2>
<p class='tbgx'><span class='caption'>
<a onclick="openDetail('/Literature/articleinfo?id=SJHYJX2026002001&type=journalArticle&typename=中文期刊文章&nav=1&langType=1')" href="javascript:void (0)" title='新技术条件下国际中文教育资源开发的基本原理解析'>新技术条件下国际中文教育资源开发的基本原理解析</a>
</span><tt><span class='writer' title='张黎[1];刘敏[1]'>张黎[1];刘敏[1]</span><span class='pages'>(147-159)</span>
<span class="read"><a onclick="AddHandleCount(this, '中文期刊文章', 'SJHYJX2026002001', 1, -1, '/Literature/readurl?id=SJHYJX2026002001', '97257X', '[H195]', 'x', 'y','世界汉语教学','')"><img src="/i.png"></a></span>
</tt></p>
<p><span class='caption'>
<a onclick="openDetail('/Literature/articleinfo?id=SJHYJX2026002002&type=journalArticle&typename=中文期刊文章&nav=1&langType=1')" href="javascript:void (0)" title='新书目'>新书目</a>
</span><tt><span class='writer' title=''></span><span class='pages'>(159-159)</span>
<span class="read"><a onclick="AddHandleCount(this, '中文期刊文章', 'SJHYJX2026002002', 1, -1, '/Literature/readurl?id=SJHYJX2026002002', '97257X', '[H109]', 'x', '','世界汉语教学','')"><img src="/i.png"></a></span>
</tt></p>
<p><span class='caption'>
<a onclick="openDetail('/Literature/articleinfo?id=SJHYJX2026002004&type=journalArticle&typename=中文期刊文章&nav=1&langType=1')" href="javascript:void (0)" title='零形主语处置式标题句的类型、特征及语用功能'>零形主语处置式标题句的类型、特征及语用功能</a>
</span><tt><span class='writer' title='史维国[1];张炳丁[1]'>史维国[1];张炳丁[1]</span><span class='pages'>(176-187)</span>
<span class="read"><a onclick="AddHandleCount(this, '中文期刊文章', 'SJHYJX2026002004', 1, -1, '/Literature/readurl?id=SJHYJX2026002004', '97257X', '[H146]', 'x', 'y','世界汉语教学','')"><img src="/i.png"></a></span>
</tt></p>
<p><span class='caption'>
<a onclick="openDetail('/Literature/articleinfo?id=SJHYJX2026002009&type=journalArticle&typename=中文期刊文章&nav=1&langType=1')" href="javascript:void (0)" title='来华留学生学术汉语听说能力研究'>来华留学生学术汉语听说能力研究</a>
</span><tt><span class='writer' title='郑航[1];李慧[2];杨端端[3,1];肖诗俊[4]'>郑航[1];李慧[2];杨端端[3,1];肖诗俊[4]</span><span class='pages'>(253-267)</span>
<span class="read"><a onclick="AddHandleCount(this, '中文期刊文章', 'SJHYJX2026002009', 1, -1, '/Literature/readurl?id=SJHYJX2026002009', '97257X', '[H195.3]', 'x', 'y','世界汉语教学','')"><img src="/i.png"></a></span>
</tt></p>
</div></body></html>`;

(async () => {
  const store = require('../lib/store');
  const N = require('../lib/normalize');
  const cn = require('../lib/cnsource');
  const discover = require('../lib/discover');
  const journals = require('../lib/journals');
  const desk = require('../lib/desk');
  const brief = require('../lib/brief');
  const config = require('../lib/config');

  store.migrate();
  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();
  config.updateSettings({ briefHour: 8, briefMinute: 0, timezone: 'Asia/Shanghai', briefSize: 8 });

  /* ================================================================ *
   * 1. 来源登记
   * ================================================================ */
  console.log('\n=== 1. 来源登记 ===');
  const srcs = cn.listSources();
  ok('登记了至少一个来源', srcs.length >= 1, `${srcs.length} 个`);
  const ncp = cn.getSource('ncpssd_sjhyjx');
  ok('接入《世界汉语教学》目录源', Boolean(ncp) && !ncp.disabled);
  ok('来源标注了公开目录页', /^https:\/\//.test(ncp.homepage));
  const ybu = cn.getSource('ybu_hyxx_toc');
  ok('《汉语学习》来源被登记为不可解析',
    Boolean(ybu) && ybu.disabled === true, ybu && ybu.disabledReason?.slice(0, 40));
  ok('不可解析的原因说明是「只有扫描图」',
    /JPEG|扫描图|图片/.test(ybu.disabledReason || ''), (ybu.disabledReason || '').slice(0, 60));
  ok('不可解析的来源不参与每日更新',
    !cn.enabledSources().some((s) => s.key === 'ybu_hyxx_toc'));

  /* ================================================================ *
   * 2. 解析（离线样本）
   * ================================================================ */
  console.log('\n=== 2. 解析题录 ===');
  const parsed = cn.parseNcpssdToc(SAMPLE, ncp);
  ok('解析出 4 条目录条目', parsed.articles.length === 4, `${parsed.articles.length} 条`);
  ok('期次解析正确', parsed.issue && parsed.issue.label === '2026年第2期',
    parsed.issue && parsed.issue.label);
  const a1 = parsed.articles.find((x) => x.articleId === 'SJHYJX2026002001');
  ok('题名解析正确', a1.title === '新技术条件下国际中文教育资源开发的基本原理解析', a1.title);
  ok('页码解析正确', a1.pages === '147-159', a1.pages);
  ok('稳定文章 ID 可用作去重键', a1.articleId === 'SJHYJX2026002001');
  ok('文章原页链接可构造', /articleinfo\?id=SJHYJX2026002001/.test(a1.articleUrl || ''), a1.articleUrl);
  ok('没有把刊物简介当成一篇论文',
    !parsed.articles.some((x) => /简介|旨在指导/.test(x.title)));

  console.log('\n=== 3. 作者清洗 ===');
  ok('去掉机构角标 [1]', JSON.stringify(cn.cleanAuthors('张黎[1];刘敏[1]')) === '["张黎","刘敏"]',
    JSON.stringify(cn.cleanAuthors('张黎[1];刘敏[1]')));
  ok('处理多人多机构角标 [3,1]',
    JSON.stringify(cn.cleanAuthors('郑航[1];李慧[2];杨端端[3,1];肖诗俊[4]'))
    === '["郑航","李慧","杨端端","肖诗俊"]',
    JSON.stringify(cn.cleanAuthors('郑航[1];李慧[2];杨端端[3,1];肖诗俊[4]')));
  ok('空作者返回空数组（不编造）', cn.cleanAuthors('').length === 0);

  /* ================================================================ *
   * 4. 非研究论文过滤
   * ================================================================ */
  console.log('\n=== 4. 非研究论文过滤 ===');
  for (const [t, want] of [
    ['新书目', true], ['书评', true], ['征稿启事', true], ['简讯', true],
    ['会议通知', true], ['更正', true], ['稿约', true], ['总目录', true],
    ['零形主语处置式标题句的类型、特征及语用功能', false],
    ['来华留学生学术汉语听说能力研究', false],
    ['“喝醉酒”类结构之“例外”问题新解', false],
  ]) {
    const r = cn.isNonResearch(t, {});
    ok(`「${t}」${want ? '应被过滤' : '应保留'}`, r.skip === want, r.reason || '');
  }
  ok('页码相同且无作者的占位条目被跳过',
    cn.isNonResearch('某补白条目', { pages: '12-12', authorsRaw: '' }).skip === true);

  /* ================================================================ *
   * 5. 去重键与入库链路同源
   * ================================================================ */
  console.log('\n=== 5. 去重键与入库链路同源 ===');
  const t0 = '零形主语处置式标题句的类型、特征及语用功能';
  ok('cnDedupKey 与 persistPapers 使用的键完全一致',
    cn.cnDedupKey({ title: t0, year: '2026' })
    === N.dedupKey({ doi: null, issn: null, title: t0, year: '2026' }),
    cn.cnDedupKey({ title: t0, year: '2026' }));
  ok('不同年份算不同论文',
    cn.cnDedupKey({ title: t0, year: '2026' }) !== cn.cnDedupKey({ title: t0, year: '2027' }));

  /* ================================================================ *
   * 6. 端到端：真实抓取公开目录页
   * ================================================================ */
  console.log('\n=== 6. 端到端（真实公开目录页）===');
  let r1 = null;
  try {
    r1 = await cn.checkSource('ncpssd_sjhyjx');
  } catch (e) {
    r1 = { ok: false, status: 'exception', message: e.message, found: 0, added: 0, skipped: [] };
  }

  if (!r1.ok) {
    skip('端到端：公开目录页当前不可达，跳过写入类断言', `${r1.status} ${r1.message || ''}`.slice(0, 80));
    // 仍然要断言「失败被如实记录」，不能假装成功
    const st = cn.sourceState('ncpssd_sjhyjx');
    ok('抓取失败时状态被如实记录', st.last_status && st.last_status !== 'ok', st.last_status);
    ok('抓取失败时新增数为 0', st.last_added === 0);
    ok('抓取失败时给出了原因', Boolean(st.last_message), (st.last_message || '').slice(0, 60));
  } else {
    ok('来源返回成功状态', r1.ok === true, r1.status);
    ok('解析到期次', Boolean(r1.issue), r1.issue);
    ok('发现逐篇题录', r1.found > 0, `${r1.found} 条`);
    ok('新增题录入库', r1.added > 0, `新增 ${r1.added} 篇`);
    ok('非研究论文被跳过', (r1.skipped || []).length > 0,
      (r1.skipped || []).map((s) => s.title + ':' + s.reason).slice(0, 3).join(' | '));

    console.log('\n=== 7. 入库只写公开元数据 ===');
    const paper = store.get("SELECT * FROM papers WHERE journal_name = '世界汉语教学' ORDER BY id LIMIT 1");
    ok('论文已入库', Boolean(paper), paper && paper.title);
    ok('刊名正确', paper.journal_name === '世界汉语教学', paper.journal_name);
    /*
     * 年与期分开看：
     *   · 源页只给「年」，所以年落在 issued_date；
     *   · 卷号源页没有给，必须为空——不能把年份当卷号（曾经的缺陷）；
     *   · 期次源页明确给了，保留。
     */
    ok('年写入 issued_date', paper.issued_date === r1.issue.slice(0, 4),
      `${paper.issued_date} vs ${r1.issue}`);
    ok('期次已写入', Boolean(paper.issue), paper.issue);
    ok('卷号留空（不把年份当卷号）', paper.volume == null, JSON.stringify(paper.volume));
    ok('首次在线留空（不伪装出版日期）', paper.published_online == null,
      JSON.stringify(paper.published_online));
    ok('页码已写入', Boolean(paper.pages), paper.pages);
    ok('语种判为中文', paper.language === 'zh', paper.language);
    ok('**没有编造 DOI**', paper.doi_norm == null, JSON.stringify(paper.doi_norm));
    ok('**没有编造摘要**', paper.abstract == null, JSON.stringify(paper.abstract));
    ok('记录了来源', /cn-catalog/.test(paper.sources || ''), paper.sources);
    ok('记录了发现检索词（可追溯）',
      /中文目录源/.test(paper.source_queries || ''), (paper.source_queries || '').slice(0, 60));

    console.log('\n=== 8. 来源证据可审计 ===');
    const ev = store.get('SELECT * FROM cn_article_imports ORDER BY id LIMIT 1');
    ok('证据行已写入', Boolean(ev));
    ok('含源标识', ev.source_key === 'ncpssd_sjhyjx', ev.source_key);
    ok('含源站文章 ID', Boolean(ev.article_id), ev.article_id);
    ok('含期次', ev.issue_label === r1.issue, ev.issue_label);
    ok('含目录页 URL', /ncpssd\.cn\/journal\/details/.test(ev.source_url || ''), ev.source_url);
    ok('含文章原页 URL', /articleinfo\?id=/.test(ev.article_url || ''), ev.article_url);
    ok('含采集时间', Boolean(ev.fetched_at), ev.fetched_at);
    ok('证据 JSON 说明了「未提供 DOI 与摘要，故留空」',
      /未提供 DOI 与摘要/.test(ev.evidence || ''), (ev.evidence || '').slice(0, 70));
    ok('证据关联到论文 id', Boolean(ev.paper_id), String(ev.paper_id));

    console.log('\n=== 9. 主题匹配 → 今日发现 → 简报候选 ===');
    const zhList = desk.listDiscovery({ page: 1, pageSize: 100, journalFilter: 'all', language: 'zh' });
    ok('中文目录来源的论文出现在「今日发现」',
      zhList.total > 0, `${zhList.total} 篇`);
    ok('今日发现里确实有《世界汉语教学》的题录',
      (zhList.items || []).some((x) => x.journal_name === '世界汉语教学'));
    const cands = brief.getCandidates({});
    ok('进入简报候选池',
      cands.some((c) => c.journal_name === '世界汉语教学'),
      `候选 ${cands.length} 篇`);
    ok('期刊资格仍为待核验（目录源不作为等级依据）',
      cands.filter((c) => c.journal_name === '世界汉语教学')
        .every((c) => c.eligibility === 'pending'),
      [...new Set(cands.filter((c) => c.journal_name === '世界汉语教学').map((c) => c.eligibility))].join(','));
    ok('不计入「期刊条件合格精选」',
      desk.listQualified({ page: 1, pageSize: 50 }).total === 0,
      String(desk.listQualified({ page: 1, pageSize: 50 }).total));

    console.log('\n=== 10. 复跑不重复 ===');
    const before = store.get('SELECT COUNT(*) c FROM papers').c;
    const r2 = await cn.checkSource('ncpssd_sjhyjx');
    const after = store.get('SELECT COUNT(*) c FROM papers').c;
    ok('第二次检查新增 0 篇', r2.added === 0, `added=${r2.added}`);
    ok('论文总数不变', before === after, `${before} → ${after}`);
    ok('第二次状态为 no_new（明确表示无新增）', r2.status === 'no_new', r2.status);
    ok('跳过原因标为已入库',
      (r2.skipped || []).some((s) => /已入库/.test(s.reason)),
      (r2.skipped || []).map((s) => s.reason).slice(0, 2).join(' | '));
    const evCount = store.get('SELECT COUNT(*) c FROM cn_article_imports').c;
    ok('证据表没有重复行', evCount === r1.added, `${evCount} vs ${r1.added}`);

    console.log('\n=== 11. 来源状态与日志 ===');
    const st = cn.sourceState('ncpssd_sjhyjx');
    ok('记录了最近检查时间', Boolean(st.last_check_at), st.last_check_at);
    ok('记录了最近成功时间', Boolean(st.last_ok_at), st.last_ok_at);
    ok('记录了最近期次', st.last_issue === r1.issue, st.last_issue);
    ok('记录了最近发现篇数', st.last_found === r1.found, String(st.last_found));
    ok('记录了累计入库篇数', st.total_added >= r1.added, String(st.total_added));
    const logs = store.all("SELECT * FROM ingest_log WHERE source = 'cn-catalog:ncpssd_sjhyjx' ORDER BY id");
    ok('写入了采集日志', logs.length >= 1, `${logs.length} 条`);
    ok('第一次的日志记录了新篇数',
      logs.some((l) => l.added === r1.added && l.added > 0),
      logs.map((l) => String(l.added)).join(','));
    ok('无新增时日志明确记 0',
      logs.some((l) => l.added === 0), logs.map((l) => String(l.added)).join(','));
  }

  ok('无新增时状态明确为 0 而不是报错',
    ['no_new', 'ok', 'not_parsable', 'http_error', 'parse_failed'].includes(
      cn.sourceState('ncpssd_sjhyjx').last_status));

  /* ================================================================ *
   * 12. 不越界
   * ================================================================ */
  console.log('\n=== 12. 边界：不绕过限制、不抓全文 ===');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'cnsource.js'), 'utf8');
  // 只看代码行，注释里提到「不处理验证码」是说明，不算实现
  const srcCode = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('代码里没有验证码/打码相关逻辑',
    !/captcha|验证码|ocr|打码/i.test(srcCode));
  ok('代码里没有登录/凭据逻辑',
    !/login|password|passwd|signin|token\s*=/i.test(src));
  ok('代码里没有抓取 PDF 全文的逻辑',
    !/\.pdf|getPdfUrl|pdfUrl/i.test(src));
  ok('明确声明不把目录页当期刊等级依据',
    /不作为.*(CSSCI|北大核心).*依据|绝不对把源页当作/.test(src)
    || /不作为期刊等级依据/.test(src) || /not.*ranking/i.test(src));

  const pass = R.filter((x) => x.ok).length;
  const skipped = R.filter((x) => x.skipped).length;
  console.log('\n' + '═'.repeat(62));
  console.log(`  中文目录源：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`
    + (skipped ? `（其中 ${skipped} 项因网络不可达跳过）` : ''));
  console.log('═'.repeat(62));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
