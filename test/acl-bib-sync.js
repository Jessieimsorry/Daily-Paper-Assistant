'use strict';
/**
 * ACL Anthology 元数据同步回归测试（lib/aclbib.js）。
 *
 * 背景缺口：ACL Anthology **没有 REST API，也没有搜索接口**，只能整包下载
 * BibTeX 后本地建索引；42 MB 下载 + 178 MB 解压必须流式，12 万条落库必须分批。
 * 本测试**不联网**，只用本地固定样本验证解析、流式文件解析（含 gzip 路径）
 * 与落库 upsert 逻辑：
 *   1. 花括号保护 `{LLM}s` 原样保留，只剥最外层定界符；
 *   2. ` and ` 多作者切分（作者名内部可以有逗号）；
 *   3. `--` 页码原样保留；
 *   4. 双引号 / 花括号两种定界，以及 `"17-20 " # jun` 这类字符串拼接安全降级；
 *   5. abstract 解析；anthology ID 从 url 提取；
 *   6. 日期精度：年+月 → YYYY-MM；只有年 → YYYY；绝不补日；
 *   7. DOI 归一；
 *   8. 重复落库不重复插入，first_seen / matched_paper_id 不被覆盖；
 *   9. source='acl'、doc_type 映射正确、summary 计数正确；
 *  10. 零依赖与不越界（不抓全文、不绕过限制）。
 *
 * 运行：node test/acl-bib-sync.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-acl-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

/* 离线固定样本：形态与真实 anthology+abstracts.bib 一致（含宏与干扰文本） */
const FIXTURE = `
% ACL Anthology 固定样本（离线，不联网）
% 条目之间故意夹注释与非条目文本，扫描器必须忽略

@string{acl = "Association for Computational Linguistics"}

@inproceedings{zhang-etal-2024-quantized,
    title = "Quantized Side Tuning: Fast and Memory-Efficient Tuning of Quantized Large Language Models",
    author = "Zhang, Zhengxin  and Zhao, Dan  and Miao, Xupeng",
    editor = "Ku, Lun-Wei and Martins, Andre",
    booktitle = "Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers)",
    month = aug, year = "2024", address = "Bangkok, Thailand",
    publisher = "Association for Computational Linguistics",
    url = "https://aclanthology.org/2024.acl-long.1/",
    doi = "10.18653/v1/2024.acl-long.1",
    pages = "1--17",
    ISBN = "979-8-89176-378-4",
    abstract = "Finetuning large language models (LLMs) has been shown to be effective."
}

中间这段不是条目，必须被忽略。

@inproceedings{chen-2023-council,
  title = {Council of {LLM}s: Bridging the Gap Between Natural Language and Formal Reasoning},
  author = {Chen, Wei and M{\\"u}ller, Anna},
  booktitle = {Proceedings of the 2023 Conference on Empirical Methods in Natural Language Processing},
  month = dec,
  year = {2023},
  pages = {100--115},
  url = {https://aclanthology.org/2023.emnlp-main.7/},
  doi = {https://doi.org/10.18653/V1/2023.EMNLP-Main.7},
  abstract = {We propose a council of {LLM}s for reasoning.}
}

@comment{这不是论文}

@article{luo-2022-tacl,
  title = "A Survey of {NLP}",
  author = "Luo, Mei",
  journal = "Transactions of the Association for Computational Linguistics",
  year = "2022",
  url = "https://aclanthology.org/2022.tacl-1.5/",
  pages = "1--20"
}

@misc{misc-2020-note,
  title = "A Note Without a Venue",
  author = "Anonymous",
  year = "2020",
  url = "https://aclanthology.org/2020.ignored.1/"
}

@preamble{"\\newcommand{\\noopsort}[1]{}"}

@inproceedings{wang-2021-concat,
  title = "String Concatenation Tolerance",
  author = "Wang, Li and Sun, Qiang",
  booktitle = "Proceedings of Some Workshop",
  month = "17-20 " # jun, year = "2021",
  pages = "5--9",
  note = "no url and no doi on purpose"
}
`;

const EXPECTED_TOTAL = 5;   // @string/@comment/@preamble 不计入

(async () => {
  const store = require('../lib/store');
  const acl = require('../lib/aclbib');
  store.migrate();

  /* ================================================================ *
   * 1. 导出接口与元数据
   * ================================================================ */
  console.log('\n=== 1. 导出接口与来源元数据 ===');
  ok('SOURCE_KEY = acl', acl.SOURCE_KEY === 'acl');
  for (const k of ['url', 'urlLight', 'label', 'license', 'note']) {
    ok(`META.${k} 已给出`, typeof acl.META[k] === 'string' && acl.META[k].length > 0);
  }
  ok('默认源是含摘要版', /anthology\+abstracts\.bib\.gz$/.test(acl.META.url), acl.META.url);
  ok('轻量版地址正确', /anthology\.bib\.gz$/.test(acl.META.urlLight), acl.META.urlLight);
  ok('note 如实说明「没有 REST API、只能整包下载」',
    /没有 REST API|没有搜索接口/.test(acl.META.note) && /304/.test(acl.META.note));
  ok('User-Agent 是纯 ASCII 且符合要求',
    acl.USER_AGENT === 'LitDesk/1.0 (literature reading desk)'
    && /^[\x20-\x7E]+$/.test(acl.USER_AGENT), acl.USER_AGENT);
  for (const fn of ['parseBibtex', 'parseBibFile', 'download', 'sync', 'status']) {
    ok(`导出 ${fn}()`, typeof acl[fn] === 'function');
  }

  /* ================================================================ *
   * 2. 纯文本解析
   * ================================================================ */
  console.log('\n=== 2. parseBibtex 纯解析 ===');
  const recs = acl.parseBibtex(FIXTURE);
  ok(`解析出 ${EXPECTED_TOTAL} 条论文记录（宏与注释被跳过）`,
    recs.length === EXPECTED_TOTAL, `实际 ${recs.length} 条：${recs.map((r) => r.bibkey).join(',')}`);

  const byKey = new Map(recs.map((r) => [r.bibkey, r]));
  const zh = byKey.get('zhang-etal-2024-quantized');
  const chen = byKey.get('chen-2023-council');
  const luo = byKey.get('luo-2022-tacl');
  const misc = byKey.get('misc-2020-note');
  const wang = byKey.get('wang-2021-concat');
  ok('五条目标条目都在', Boolean(zh && chen && luo && misc && wang));

  console.log('\n=== 3. 花括号保护 ===');
  ok('title 去掉最外层定界花括号，但保留 {LLM}s',
    chen.title === 'Council of {LLM}s: Bridging the Gap Between Natural Language and Formal Reasoning',
    chen.title);
  ok('双引号定界同样只去引号、保留内部花括号',
    luo.title === 'A Survey of {NLP}', luo.title);
  ok('abstract 里的 {LLM}s 也原样保留',
    chen.abstract === 'We propose a council of {LLM}s for reasoning.', chen.abstract);
  ok('LaTeX 重音转义 {\\"u} 原样保留（不音译、不删除）',
    chen.authors.some((a) => a.includes('{\\"u}ller')), JSON.stringify(chen.authors));

  console.log('\n=== 4. 作者切分 ===');
  ok('` and ` 切分 3 位作者（作者名内含逗号不受影响）',
    JSON.stringify(zh.authors) === JSON.stringify(['Zhang, Zhengxin', 'Zhao, Dan', 'Miao, Xupeng']),
    JSON.stringify(zh.authors));
  ok('花括号定界的作者同样切分',
    JSON.stringify(chen.authors) === JSON.stringify(['Chen, Wei', 'M{\\"u}ller, Anna']),
    JSON.stringify(chen.authors));
  ok('单作者也正确', JSON.stringify(luo.authors) === JSON.stringify(['Luo, Mei']));

  console.log('\n=== 5. 页码 / 摘要 / ID / 字段 ===');
  ok('`--` 页码原样保留', zh.pages === '1--17', zh.pages);
  ok('abstract 已解析', /Finetuning large language models/.test(zh.abstract), (zh.abstract || '').slice(0, 40));
  ok('anthology ID 从 url 提取', zh.anthologyId === '2024.acl-long.1', String(zh.anthologyId));
  ok('花括号 url 同样提取', chen.anthologyId === '2023.emnlp-main.7', String(chen.anthologyId));
  ok('ISBN 字段（大写字段名）被读到', zh.isbn === '979-8-89176-378-4', String(zh.isbn));
  ok('venue 会议取 booktitle', /Annual Meeting of the Association/.test(zh.venue), zh.venue);
  ok('venue 期刊取 journal', luo.venue === 'Transactions of the Association for Computational Linguistics', luo.venue);
  ok('缺少摘要时 abstract 为空（不编造）', wang.abstract === null, String(wang.abstract));

  console.log('\n=== 6. 日期精度 ===');
  ok('year + month=aug → 2024-08', zh.publishedDate === '2024-08', String(zh.publishedDate));
  ok('year + month=dec → 2023-12', chen.publishedDate === '2023-12', String(chen.publishedDate));
  ok('只有 year → 2022（不补月份、绝不补日）', luo.publishedDate === '2022', String(luo.publishedDate));
  ok('字符串拼接 `"17-20 " # jun` 安全降级（取第一段，不算月份）',
    wang.month === null && wang.publishedDate === '2021', `${wang.month}/${wang.publishedDate}`);
  ok('year 是整数', zh.year === 2024 && luo.year === 2022, `${zh.year}/${luo.year}`);

  console.log('\n=== 7. 记录类型 ===');
  ok('@inproceedings → conference-paper', acl.docTypeFor('inproceedings') === 'conference-paper');
  ok('@article → journal-article', acl.docTypeFor('article') === 'journal-article');
  ok('其他类型 → other（跳过而不报错）', acl.docTypeFor('misc') === 'other');
  ok('@misc 被解析为 other 而不是崩溃', misc.type === 'misc');

  /* ================================================================ *
   * 8. 流式文件解析
   * ================================================================ */
  console.log('\n=== 8. parseBibFile 流式解析 ===');
  const bibFile = path.join(TEST_DIR, 'sample.bib');
  fs.writeFileSync(bibFile, FIXTURE, 'utf8');
  const streamed = await acl.parseBibFile(bibFile, { gzip: false });
  ok('流式解析条数与纯解析一致', streamed.count === EXPECTED_TOTAL, `count=${streamed.count}`);
  ok('带 gzip:false 时 ok 为真且无错误',
    streamed.ok === true && streamed.errors.length === 0, JSON.stringify(streamed.errors));
  let seen = 0;
  const cbRes = await acl.parseBibFile(bibFile, { collect: false, onRecord: () => { seen++; } });
  ok('回调模式逐条送达且不驻留数组',
    seen === EXPECTED_TOTAL && cbRes.count === EXPECTED_TOTAL && cbRes.records.length === 0,
    `seen=${seen}, records=${cbRes.records.length}`);

  const gzFile = path.join(TEST_DIR, 'sample.bib.gz');
  fs.writeFileSync(gzFile, zlib.gzipSync(Buffer.from(FIXTURE, 'utf8')));
  const gz = await acl.parseBibFile(gzFile, { gzip: true });
  ok('gzip 路径可解析', gz.ok === true && gz.count === EXPECTED_TOTAL, `count=${gz.count}`);
  ok('省略 gzip 时按扩展名自动识别',
    (await acl.parseBibFile(gzFile)).count === EXPECTED_TOTAL);
  const limited = await acl.parseBibFile(bibFile, { limit: 2 });
  ok('limit 生效', limited.count === 2 && limited.records.length === 2, `count=${limited.count}`);
  const missing = await acl.parseBibFile(path.join(TEST_DIR, '不存在.bib'));
  ok('文件不存在时返回 ok:false 而不是抛异常',
    missing.ok === false && Boolean(missing.error), String(missing.error).slice(0, 50));

  /* ================================================================ *
   * 9. 落库
   * ================================================================ */
  console.log('\n=== 9. 落库 upsert ===');
  const c1 = acl.persistRecords(recs);
  ok('首次落库：5 条插入、0 条更新',
    c1.inserted === EXPECTED_TOTAL && c1.updated === 0 && c1.skipped === 0,
    JSON.stringify(c1));
  ok('frontier_items 中 source=acl 共 5 条',
    store.get("SELECT COUNT(*) c FROM frontier_items WHERE source='acl'").c === EXPECTED_TOTAL);

  const row1 = store.get('SELECT * FROM frontier_items WHERE dedup_key = ?', ['doi:10.18653/v1/2024.acl-long.1']);
  ok('DOI 去重键已归一（小写、去 doi.org 前缀）',
    Boolean(row1), row1 && row1.dedup_key);
  ok('大小写混杂的 doi.org URL 也归一',
    Boolean(store.get('SELECT 1 x FROM frontier_items WHERE dedup_key = ?', ['doi:10.18653/v1/2023.emnlp-main.7'])));
  ok('无 DOI 时用 anthology ID 作键',
    Boolean(store.get('SELECT 1 x FROM frontier_items WHERE dedup_key = ?', ['acid:2022.tacl-1.5'])));
  ok('无 DOI 无 url 时退回 bibkey 作键',
    Boolean(store.get('SELECT 1 x FROM frontier_items WHERE dedup_key = ?', ['aclbib:wang-2021-concat'])));

  ok('source 写入 acl', row1.source === 'acl', row1.source);
  ok('source_id = anthology ID', row1.source_id === '2024.acl-long.1', row1.source_id);
  ok('doc_type = conference-paper', row1.doc_type === 'conference-paper', row1.doc_type);
  ok('authors 是 JSON 字符串数组',
    JSON.stringify(JSON.parse(row1.authors)) === JSON.stringify(['Zhang, Zhengxin', 'Zhao, Dan', 'Miao, Xupeng']),
    row1.authors);
  ok('published_date = 2024-08', row1.published_date === '2024-08', String(row1.published_date));
  ok('year 存为整数', row1.year === 2024, String(row1.year));
  ok('abstract 已落库', /Finetuning/.test(row1.abstract || ''));
  // frontier_items 没有 pages 列（schema 如此，且不允许改 store.js），
  // 因此页码保留在 raw.fields.pages 里，不丢。
  ok('pages 保留 `--`（存于 raw.fields.pages）',
    JSON.parse(row1.raw).fields.pages === '1--17',
    String(JSON.parse(row1.raw).fields.pages));
  ok('subjects = []（ACL 不提供主题词）', row1.subjects === '[]', row1.subjects);
  ok('peer_reviewed = 1', row1.peer_reviewed === 1, String(row1.peer_reviewed));
  ok('pdf_url 留空（不推断链接）', row1.pdf_url == null, String(row1.pdf_url));
  ok('language 留空（BibTeX 不提供语种，不猜）', row1.language == null, String(row1.language));
  ok('raw 是精简 JSON 且带原始 type',
    (() => { try { const r = JSON.parse(row1.raw); return r.type === 'inproceedings' && r.bibkey === 'zhang-etal-2024-quantized'; } catch { return false; } })(),
    String(row1.raw).slice(0, 80));
  ok('raw 不重复存 abstract',
    !JSON.parse(row1.raw).fields || !('abstract' in JSON.parse(row1.raw).fields));

  const articleRow = store.get('SELECT * FROM frontier_items WHERE dedup_key = ?', ['acid:2022.tacl-1.5']);
  ok('期刊论文 doc_type = journal-article', articleRow.doc_type === 'journal-article', articleRow.doc_type);
  ok('期刊论文 published_date 只有年', articleRow.published_date === '2022', String(articleRow.published_date));
  const miscRow = store.get('SELECT * FROM frontier_items WHERE dedup_key = ?', ['acid:2020.ignored.1']);
  ok('其他类型 doc_type = other', miscRow.doc_type === 'other', miscRow.doc_type);

  console.log('\n=== 10. 重复落库不重复插入 ===');
  const beforeCount = store.get('SELECT COUNT(*) c FROM frontier_items').c;
  const firstSeen = new Map(store.all('SELECT dedup_key, first_seen FROM frontier_items').map((r) => [r.dedup_key, r.first_seen]));
  const updatedAt1 = store.get('SELECT updated_at FROM frontier_items WHERE dedup_key = ?', [row1.dedup_key]).updated_at;
  // 手工写一个 matched_paper_id，验证 upsert 不会覆盖它
  store.run('UPDATE frontier_items SET matched_paper_id = 4242 WHERE dedup_key = ?', [row1.dedup_key]);

  await new Promise((r) => setTimeout(r, 5));
  const c2 = acl.persistRecords(recs);
  const afterCount = store.get('SELECT COUNT(*) c FROM frontier_items').c;
  ok('第二次：0 条插入、5 条更新', c2.inserted === 0 && c2.updated === EXPECTED_TOTAL, JSON.stringify(c2));
  ok('总行数不变（不重复插入）', beforeCount === afterCount, `${beforeCount} → ${afterCount}`);
  const firstSeenKept = store.all('SELECT dedup_key, first_seen FROM frontier_items')
    .every((r) => r.first_seen === firstSeen.get(r.dedup_key));
  ok('first_seen 完全不变', firstSeenKept);
  ok('matched_paper_id 未被覆盖',
    store.get('SELECT matched_paper_id FROM frontier_items WHERE dedup_key = ?', [row1.dedup_key]).matched_paper_id === 4242);
  const updatedAt2 = store.get('SELECT updated_at FROM frontier_items WHERE dedup_key = ?', [row1.dedup_key]).updated_at;
  ok('updated_at 被刷新', updatedAt2 !== updatedAt1, `${updatedAt1} → ${updatedAt2}`);
  ok('标题等字段被更新而不是留旧值',
    store.get('SELECT title FROM frontier_items WHERE dedup_key = ?', [row1.dedup_key]).title === zh.title);

  console.log('\n=== 11. 缺标题/缺 ID 的条目被跳过 ===');
  const bad = acl.persistRecords([
    { key: 'no-title', bibkey: 'no-title', type: 'misc', title: '', url: 'https://aclanthology.org/2024.x.1/' },
    { key: '', bibkey: '', type: 'misc', title: 'Has Title But No Id', url: null },
  ]);
  ok('无标题 / 无 ID 的条目都被跳过', bad.skipped === 2, JSON.stringify(bad));

  /* ================================================================ *
   * 12. status()
   * ================================================================ */
  console.log('\n=== 12. status() ===');
  const st = await acl.status();
  ok('status 返回 source=acl', st.source === 'acl');
  ok('统计 frontier_items 的 acl 条数', st.total === EXPECTED_TOTAL, String(st.total));
  ok('按 doc_type 分组', Array.isArray(st.byDocType)
    && st.byDocType.find((x) => x.doc_type === 'conference-paper').count === 3, JSON.stringify(st.byDocType));
  ok('尚未下载时 lastModified 为空', st.lastModified === null, String(st.lastModified));
  ok('返回了同步状态集合', st.state && typeof st.state === 'object');

  /* ================================================================ *
   * 13. 零依赖与不越界
   * ================================================================ */
  console.log('\n=== 13. 零依赖与不越界 ===');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'aclbib.js'), 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  ok('只依赖 node: 内置模块与本地 ./ 模块',
    requires.every((r) => r.startsWith('node:') || r.startsWith('./')),
    requires.join(', '));
  ok('没有 npm 第三方依赖', !/node_modules/.test(src));
  ok('没有抓取 PDF 全文 / 绕过付费墙的逻辑',
    !/\.pdf["'`)]|downloadPdf|fetchFulltext/i.test(src.replace(/pdf_url/g, '')));
  ok('没有登录/凭据逻辑', !/password|passwd|signin|api[_ ]?key\s*=/i.test(src));
  ok('导出接口齐全',
    ['SOURCE_KEY', 'META', 'parseBibtex', 'parseBibFile', 'download', 'sync', 'status']
      .every((k) => k in acl));

  /* ================================================================ *
   * 汇总
   * ================================================================ */
  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(62));
  console.log(`  ACL Anthology 元数据同步：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(62));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => {
  console.error('异常：', e);
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(2);
});
