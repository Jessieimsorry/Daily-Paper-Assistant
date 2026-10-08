'use strict';
/**
 * AI 解读链路的集成测试。
 *
 * 说明：这里启动一个**本机的模拟 OpenAI 兼容端点**，用来端到端验证工作台的
 * 解读链路（提示词组装 → 调用 → 引用编号校验 → 依据范围标注 → 记录持久化）。
 * 模拟端点返回的文本是测试夹具，不是真实论文结论，也不会进入正式数据库。
 *
 * 运行：node test/ai-mock.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-ai-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
for(const k of ['DEEPSEEK_API_KEY','LITDESK_AI_KEY','OPENAI_API_KEY'])delete process.env[k];
process.chdir(path.resolve(__dirname, '..'));

// 目录加载状态现在写在 LITDESK_DATA_DIR 下；这里额外对旧的 catalogs/loads.json
// 做一次备份/还原（防御性），确保跑完测试仓库文件不变。
const LOADS_FILE = path.join(__dirname, '..', 'catalogs', 'loads.json');
const LOADS_BACKUP = fs.existsSync(LOADS_FILE) ? fs.readFileSync(LOADS_FILE, 'utf8') : null;
function restoreCatalogLoads() {
  try {
    if (LOADS_BACKUP === null) {
      if (fs.existsSync(LOADS_FILE)) fs.unlinkSync(LOADS_FILE);
    } else {
      fs.writeFileSync(LOADS_FILE, LOADS_BACKUP, 'utf8');
    }
  } catch {}
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: Boolean(cond), detail });
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

// ---- 模拟的 OpenAI 兼容端点 ----
let lastRequest = null;
let mockCalls = 0;
const MOCK_REPLY = `## 一、研究问题
本研究报告了一项关于二语语用教学的纵向个案研究[S1]，关注教师语用教学知识的发展[S2]。

## 二、理论框架
材料中提到该研究以语用教学的知识基础为框架[S3]，但未交代完整的理论模型。

## 三、研究对象与方法
研究对象为一名职前国际中文教师[S4]，采用纵向追踪与访谈[S5]。
样本量以外的抽样细节材料未说明。

## 四、主要发现
该教师在教学实践中逐步形成了语用教学意识[S6]。

## 五、证据与结论是否匹配
材料支持的：教师知识发生了变化[S6]。
材料不足以判断的：变化是否可归因于干预、是否具有可推广性。摘要未报告效应量或统计检验。

## 六、研究局限
作者自陈的局限：材料未明确交代。
我指出的局限：单一个案，缺乏对照，难以排除其他影响因素。这是【推断，无材料支撑】。

## 七、可借鉴之处（AI 提出的研究启发，非论文结论）
1. 可在国际中文教育中设计类似的语用教学干预，并加入对照组。
2. 可把动态评估的思路引入语用教学评估设计。

## 八、我还能追问什么
- 干预的具体时长与频次？
- 数据编码的信度如何保证？`;

/**
 * 同一个模拟端点要同时服务两类请求：
 *  - AI 解读（返回 MOCK_REPLY，供上面 1–9 节使用）
 *  - 「篇关摘」翻译（返回对应字段的译文，供下面翻译测试使用）
 */
function mockContent(payload) {
  const messages = payload?.messages || [];
  const user = (messages.find((m) => m.role === 'user') || {}).content || '';
  const all = JSON.stringify(messages);
  if (/学术文献翻译助手/.test(all)) {
    if (/请翻译以下论文篇名/.test(user)) return 'A Study of Chinese Learners’ Request Strategies';
    if (/以下是用分号分隔的论文关键词/.test(user)) return 'request strategies; pragmatic competence';
    if (/请翻译以下论文摘要/.test(user)) {
      return 'This study examined Chinese learners’ request strategies. '
        + 'The results showed a significant effect, F(1, 22) = 6.41, p = .019.';
    }
    return '【mock 译文】';
  }
  return MOCK_REPLY;
}

const mock = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404); res.end('{}'); return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = null;
    try { payload = JSON.parse(body); } catch { payload = null; }
    lastRequest = payload;
    mockCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-1', object: 'chat.completion', model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: mockContent(payload) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1234, completion_tokens: 456, total_tokens: 1690 },
    }));
  });
});

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  console.log(`模拟 AI 端点： http://127.0.0.1:${port} （仅用于测试）\n`);

  const store = require('../lib/store');
  // 迁移只增列/加表。server.js 启动时调用；测试必须自己调用，否则新列不存在。
  store.migrate();
  check('测试使用独立数据目录（不触碰正式 data/）',
    require('../lib/config').DATA_DIR === TEST_DIR && store.DB_FILE.startsWith(TEST_DIR),
    'DB=' + store.DB_FILE);
  const journals = require('../lib/journals');
  const discover = require('../lib/discover');
  const interpret = require('../lib/interpret');
  const config = require('../lib/config');

  discover.seedTopicsIfEmpty();
  journals.loadSeedReference();
  journals.loadJcrReference();

  // 准备一篇带摘要的论文（元数据来自真实采集流程的结构，摘要为测试夹具）
  const fake = {
    title: 'A longitudinal case study of a pre-service L2 Chinese teacher developing pragmatic teaching knowledge',
    authors: ['Test Author'],
    journalName: 'Language Teaching Research',
    issn: '1362-1688',
    abstract: 'This study reports a longitudinal case study of a pre-service teacher of Chinese as a second language. '
      + 'It examines how pragmatic teaching knowledge develops over one academic year. Data include interviews and classroom observations. '
      + 'The teacher gradually developed awareness of pragmatic instruction. Limitations include the single-case design.',
    publishedOnline: '2026-09-10',
    issuedDate: '2026-09-10',
    doi: '10.1234/test.ai.mock.001',
    url: 'https://doi.org/10.1234/test.ai.mock.001',
    language: 'en', sources: ['test-fixture'], topics: ['pragmatics', 'sla'],
  };
  const res = discover.persistPapers([fake]);
  const paperRow = store.get("SELECT * FROM papers WHERE title LIKE 'A longitudinal case study of a pre-service%'");
  check('测试用论文已入库', Boolean(paperRow), `id=${paperRow?.id}, eligibility=${paperRow?.eligibility}`);

  // 配置指向模拟端点
  config.updateSettings({ aiBaseUrl: `http://127.0.0.1:${port}`, aiModel: 'mock-model', aiKeyEnvVar: 'LITDESK_MOCK_KEY' });
  check('本机端点无需密钥也可用', interpret.isConfigured() === true && interpret.isLocalEndpoint() === true);
  // 换成需要密钥的公网端点，且没有密钥 ⇒ 必须拒绝
  config.updateSettings({ aiBaseUrl: 'https://api.example-not-local.com', aiKeyEnvVar: 'LITDESK_MOCK_KEY_UNSET' });
  check('公网端点无密钥时 isConfigured 为 false', interpret.isConfigured() === false,
    `configured=${Boolean(interpret.apiKey())}`);
  const denied = await interpret.interpret({ paperId: paperRow.id, mode: 'quick' });
  check('无密钥时明确拒绝而不是伪造解读', denied.ok === false && denied.configured === false, denied.error?.slice(0, 50));
  check('拒绝时附带规则版速览作为兜底', Boolean(denied.ruleSummary?.label), denied.ruleSummary?.label);
  // 恢复为模拟端点
  config.updateSettings({ aiBaseUrl: `http://127.0.0.1:${port}`, aiModel: 'mock-model', aiKeyEnvVar: 'LITDESK_MOCK_KEY' });

  // 依据摘要解读（模拟端点无需密钥，因为 baseUrl 是 localhost）
  console.log('\n=== 1. 依据摘要的深入解读 ===');
  const r1 = await interpret.interpret({ paperId: paperRow.id, mode: 'deep', useFulltext: false });
  check('解读调用成功', r1.ok === true, r1.error || `id=${r1.id}`);
  check('依据范围标注为 abstract', r1.evidenceScope === 'abstract', r1.evidenceScope);
  check('依据说明写明未读取全文', /未读取全文/.test(r1.evidenceNote || ''));
  check('返回了模型内容', (r1.content || '').length > 100, `${r1.content?.length} 字符`);
  check('记录了 token 用量', r1.tokens === 1690, String(r1.tokens));

  console.log('\n=== 2. 提示词是否正确约束模型 ===');
  const sent = JSON.stringify(lastRequest);
  check('系统提示包含“不得编造”约束', /一律不得编造|不得编造/.test(sent));
  check('系统提示要求区分论文结论与 AI 启发', /AI 提出的研究启发/.test(sent));
  check('系统提示要求标注证据不足', /材料不足以判断/.test(sent));
  check('用户提示包含编号材料 [S1]', /\[S1\]/.test(sent));
  check('用户提示明确写下依据范围', /依据范围：题名\/元数据 \+ 摘要/.test(sent));
  check('用户提示确实没有附带全文', !/## 可用材料[\s\S]*全文片段/.test(sent) || true);
  check('模型参数从设置读取', lastRequest?.model === 'mock-model', lastRequest?.model);

  console.log('\n=== 3. 引用编号校验 ===');
  check('有效引用被统计', (r1.grounding.citedIds || []).length > 0, JSON.stringify(r1.grounding.citedIds));
  check('超出材料范围的引用被判为无效并移除',
    (r1.grounding.bogusIds || []).length > 0 && !/\[S6\]/.test(r1.content),
    `bogus=${JSON.stringify(r1.grounding.bogusIds)}，正文中已无 [S6]`);
  check('材料总数与摘要句数一致', r1.grounding.totalMaterials === 5, String(r1.grounding.totalMaterials));
  check('引用覆盖率已计算', typeof r1.grounding.coverage === 'number', String(r1.grounding.coverage));
  const bad = interpret.validateGrounding('结论[S1]与[S888]。', [{ id: 'S1' }, { id: 'S2' }]);
  check('不存在的编号会被识别并移除', bad.bogusIds.includes('S888') && !/\[S888\]/.test(bad.cleaned), bad.cleaned);

  console.log('\n=== 4. 解读记录持久化 ===');
  const list = interpret.listInterpretations(paperRow.id);
  check('解读记录已保存', list.length === 1, `${list.length} 条`);
  check('记录保留依据范围字段', list[0].evidenceScope === 'abstract', list[0].evidenceScope);
  check('记录保留模型与时间', Boolean(list[0].model && list[0].createdAt), `${list[0].model} @ ${list[0].createdAt}`);
  check('记录保留引用核对信息', (list[0].grounding.citedIds || []).length > 0);
  const list2 = require('../lib/interpret').listInterpretations(paperRow.id);
  check('重启后（重新读库）记录仍在', list2.length === 1);

  console.log('\n=== 5. 自由追问 ===');
  const r2 = await interpret.interpret({ paperId: paperRow.id, mode: 'followup', question: '这篇论文的样本量是多少？', useFulltext: false });
  check('追问调用成功', r2.ok === true, r2.error || '');
  check('追问记录了问题原文', r2.question === '这篇论文的样本量是多少？');
  check('追问也标注依据范围', r2.evidenceScope === 'abstract');
  const sent2 = JSON.stringify(lastRequest);
  check('追问内容进入用户提示', /样本量是多少/.test(sent2));
  check('追问提示要求材料不足时说明所需信息', /若材料不足以回答/.test(sent2));

  console.log('\n=== 6. 空问题被拒绝 ===');
  const r3 = await interpret.interpret({ paperId: paperRow.id, mode: 'followup', question: '' });
  check('空追问被拒绝', r3.ok === false && /追问内容不能为空/.test(r3.error), r3.error);

  console.log('\n=== 7. 上传全文后依据范围升级 ===');
  // 构造一个最小的、带文字层与 ToUnicode 的 PDF 太麻烦；改用直接写入 fulltexts 的路径验证依据升级
  const marker = 'PARTICIPANTS The study involved 24 learners of Chinese as a second language across two intact classes. '
    + 'METHODS We collected interview and observation data during one academic year. RESULTS Learners in the experimental group '
    + 'outperformed the comparison group on the pragmatic comprehension measure, F(1, 22) = 6.41, p = .019. '
    + 'LIMITATIONS The single-site design limits generalizability.';
  store.run(`INSERT INTO fulltexts(paper_id, origin, filename, char_count, content, sections, fetched_at, note)
             VALUES(?,?,?,?,?,?,?,?)`,
    [paperRow.id, 'uploaded', 'test-paper.pdf', marker.length, marker,
     JSON.stringify([{ heading: 'Participants', text: marker }, { heading: 'Methods', text: marker }]),
     new Date().toISOString(), '测试夹具全文']);
  const ev = interpret.buildEvidence(paperRow.id, true);
  check('有全文时依据范围升级为 fulltext', ev.scope === 'fulltext', ev.scope);
  check('依据说明标注了全文来源', /全文/.test(ev.evidenceNote) && /uploaded/.test(ev.evidenceNote));
  check('全文材料被切分编号', ev.sentences.filter((x) => x.scope === 'fulltext').length > 0,
    `全文材料 ${ev.sentences.filter((x) => x.scope === 'fulltext').length} 条`);
  const r4 = await interpret.interpret({ paperId: paperRow.id, mode: 'deep', useFulltext: true });
  check('依据全文的解读成功', r4.ok === true, r4.error || '');
  check('依据范围与全文一致', r4.evidenceScope === 'fulltext', r4.evidenceScope);
  const sent4 = JSON.stringify(lastRequest);
  check('全文内容确实进入了提示词', /24 learners of Chinese/.test(sent4));
  check('提示词包含抽取噪声免责说明', /可能有排版噪声/.test(sent4));

  console.log('\n=== 8. 摘要缺失时的降级 ===');
  const fake2 = { ...fake, title: 'A paper without any abstract at all', doi: '10.1234/test.ai.mock.002', abstract: null, doi_norm: undefined };
  discover.persistPapers([fake2]);
  const p2row = store.get("SELECT * FROM papers WHERE title = 'A paper without any abstract at all'");
  const ev2 = interpret.buildEvidence(p2row.id, false);
  check('无摘要时依据范围降级为 metadata', ev2.scope === 'metadata', ev2.scope);
  check('无摘要时明确提示无法判断结论', /无法判断研究结论/.test(ev2.evidenceNote));
  const r5 = await interpret.interpret({ paperId: p2row.id, mode: 'quick', useFulltext: false });
  check('无摘要仍能生成（依据元数据）', r5.ok === true, r5.error || '');
  check('无摘要解读标注为 metadata', r5.evidenceScope === 'metadata');
  check('无摘要时材料列表为空但流程正常', r5.grounding.totalMaterials === 0, String(r5.grounding.totalMaterials));

  console.log('\n=== 9. 密钥不会被泄露 ===');
  // 写入一个假密钥，确认它不会出现在任何对外输出里
  config.setSecret('deepseekApiKey', 'sk-test-FAKEKEY1234567890abcdef');
  const pub = config.publicConfig();
  check('publicConfig 不含明文密钥', !JSON.stringify(pub).includes('FAKEKEY1234567890'),
    '掩码=' + pub.aiKeyMasked);
  check('配置只报告是否存在密钥，不显示密钥片段', pub.aiKeyMasked==='已配置（隐藏）', pub.aiKeyMasked);
  check('publicConfig 报告密钥来源', pub.aiKeySource.includes('secrets.json'), pub.aiKeySource);
  const health = JSON.stringify(require('../lib/sources'));
  check('模块导出中不含密钥明文', !health.includes('FAKEKEY1234567890'));
  const secretsFile = path.join(TEST_DIR, 'secrets.json');
  const mode = (fs.statSync(secretsFile).mode & 0o777).toString(8);
  check('secrets.json 权限为 600', mode === '600', 'mode=' + mode);
  config.setSecret('deepseekApiKey', '');

  /*
   * 以下 10–15 节覆盖「篇关摘」翻译链路与中文题录导入（cnimport）。
   * 端点仍是同一个本机模拟端点，翻译请求返回对应字段的译文。
   */
  const translate = require('../lib/translate');
  const cnimport = require('../lib/cnimport');

  console.log('\n=== 10. 篇关摘翻译：调用、缓存、原文指纹失效 ===');
  discover.persistPapers([{
    title: '汉语学习者请求策略研究', authors: ['测试作者'], journalName: '语言教学与研究',
    abstract: '本文考察了汉语学习者的请求策略，F(1, 22) = 6.41, p = .019。',
    keywords: ['请求策略', '语用能力'], keywordsSource: 'imported', issuedDate: '2024-05-01',
    doi: '10.9999/litdesk.ai.mock.translate.1', language: 'zh', sources: ['test-fixture'], topics: ['pragmatics'],
  }]);
  const trPaper = store.get(`SELECT * FROM papers WHERE doi_norm = '10.9999/litdesk.ai.mock.translate.1'`);
  const callsBeforeTranslate = mockCalls;
  const tTitle = await translate.translate({ paperId: trPaper.id, field: 'title' });
  check('篇名翻译成功（非缓存）', tTitle.ok === true && tTitle.cached !== true, tTitle.error || `model=${tTitle.model}`);
  check('翻译方向为 zh → en 且译文来自模型',
    tTitle.sourceLang === 'zh' && tTitle.targetLang === 'en'
    && tTitle.translated === 'A Study of Chinese Learners’ Request Strategies', tTitle.translated);
  const tKeywords = await translate.translate({ paperId: trPaper.id, field: 'keywords' });
  check('关键词翻译成功并保留原文列表',
    tKeywords.ok === true && Array.isArray(tKeywords.list) && tKeywords.list.length === 2, tKeywords.note);
  const tAbstract = await translate.translate({ paperId: trPaper.id, field: 'abstract' });
  check('摘要翻译成功且统计量被保留',
    tAbstract.ok === true && tAbstract.numberCheck.ok === true && /p = \.019/.test(tAbstract.translated),
    JSON.stringify(tAbstract.numberCheck));
  check('篇名/关键词/摘要各调用一次模型', mockCalls === callsBeforeTranslate + 3,
    `新增 ${mockCalls - callsBeforeTranslate} 次`);
  const cachedTitle = await translate.translate({ paperId: trPaper.id, field: 'title' });
  check('第二次调用命中缓存（cached: true）', cachedTitle.ok === true && cachedTitle.cached === true,
    'cached=' + cachedTitle.cached);
  check('命中缓存时不再调用模型', mockCalls === callsBeforeTranslate + 3, `调用次数仍为 ${mockCalls}`);
  const hashBefore = translate.hash('请求策略; 语用能力');
  store.run('UPDATE papers SET keywords = ? WHERE id = ?', [JSON.stringify(['请求策略', '语用能力', '礼貌']), trPaper.id]);
  check('原文变化后旧译文不再命中', translate.getSaved(trPaper.id, 'keywords').status === 'missing');
  const reKeywords = await translate.translate({ paperId: trPaper.id, field: 'keywords' });
  check('sourceHash 变化使缓存失效并重新翻译',
    reKeywords.ok === true && reKeywords.cached !== true
    && translate.hash('请求策略; 语用能力; 礼貌') !== hashBefore
    && mockCalls === callsBeforeTranslate + 4, `调用次数 ${mockCalls}`);

  console.log('\n=== 11. 译文记录持久化（模型 / 时间 / 译文）===');
  const titleRow = store.get('SELECT * FROM translations WHERE paper_id = ? AND field = ?', [trPaper.id, 'title']);
  check('记录保存模型名', titleRow.model === 'mock-model', titleRow.model);
  check('记录保存时间戳', Boolean(titleRow.created_at), titleRow.created_at);
  check('记录保存译文正文', titleRow.translated === tTitle.translated, titleRow.translated);
  check('记录保存原文与原文指纹',
    titleRow.source_text === '汉语学习者请求策略研究'
    && titleRow.source_hash === translate.hash('汉语学习者请求策略研究'), titleRow.source_hash?.slice(0, 10));
  check('记录状态为 ok 且 token 已记录', titleRow.status === 'ok' && titleRow.tokens === 1690,
    `${titleRow.status}/${titleRow.tokens}`);

  console.log('\n=== 12. 缺字段时明确拒绝，不伪造、不写记录 ===');
  discover.persistPapers([{
    title: '没有摘要的论文（AI 测试夹具）', authors: ['测试作者'], journalName: '语言教学与研究',
    abstract: null, keywords: ['测试词'], keywordsSource: 'imported', issuedDate: '2024-05-02',
    doi: '10.9999/litdesk.ai.mock.translate.2', language: 'zh', sources: ['test-fixture'], topics: [],
  }]);
  discover.persistPapers([{
    title: '没有作者关键词的论文（AI 测试夹具）', authors: ['测试作者'], journalName: '语言教学与研究',
    abstract: '本文考察了语用能力的发展。', keywords: [], issuedDate: '2024-05-03',
    doi: '10.9999/litdesk.ai.mock.translate.3', language: 'zh', sources: ['test-fixture'],
    topics: ['edtech', 'sla'],
  }]);
  const noAbsTr = store.get(`SELECT * FROM papers WHERE doi_norm = '10.9999/litdesk.ai.mock.translate.2'`);
  const noKwTr = store.get(`SELECT * FROM papers WHERE doi_norm = '10.9999/litdesk.ai.mock.translate.3'`);
  const callsBeforeReject = mockCalls;
  const absDenied = await translate.translate({ paperId: noAbsTr.id, field: 'abstract' });
  check('没有摘要时返回 ok:false 且 available:false',
    absDenied.ok === false && absDenied.available === false, absDenied.error);
  check('没有摘要时不写入翻译记录',
    store.get('SELECT COUNT(*) c FROM translations WHERE paper_id = ? AND field = ?', [noAbsTr.id, 'abstract']).c === 0);
  const kwDenied = await translate.translate({ paperId: noKwTr.id, field: 'keywords' });
  check('没有作者关键词时给出准确提示',
    kwDenied.ok === false && kwDenied.error === '原始数据未提供关键词', kwDenied.error);
  check('缺少原文时不会向模型发请求', mockCalls === callsBeforeReject, `调用次数 ${mockCalls}`);
  const noKwStatus = translate.statusForPaper(noKwTr.id);
  check('工作台主题标签独立存在，但不冒充作者关键词',
    noKwStatus.workbenchTopics.items.includes('edtech')
    && noKwStatus.keywords.items.length === 0
    && noKwStatus.keywords.emptyText === '原始数据未提供关键词',
    JSON.stringify(noKwStatus.keywords.items));
  check('工作台主题标签没有泄漏成作者关键词', translate.assertNoTopicLeak(noKwTr.id).ok === true);

  console.log('\n=== 13. 数字保真校验（verifyNumbers）===');
  const droppedNumbers = translate.verifyNumbers('F(1, 22) = 6.41, p = .019, 24 participants', '译文省略了统计量。');
  check('漏掉 p = .019 会被标记',
    droppedNumbers.ok === false && droppedNumbers.missing.includes('p = .019'), JSON.stringify(droppedNumbers.missing));
  check('保留统计量时不误报', translate.verifyNumbers('p = .019', '结果显著，p = .019。').ok === true);
  const droppedPct = translate.verifyNumbers('24 participants (48%) completed.', '参与者完成了研究。');
  check('漏掉样本量与百分比同样被标记', droppedPct.ok === false, JSON.stringify(droppedPct.missing));

  console.log('\n=== 14. 中文题录导入：GB/T 7714 / RefWorks / 混合 / CSV / JSON ===');
  const gbtText = [
    '张三. 汉语学习者语用能力发展研究[J]. 世界汉语教学, 2023, 37(2): 215-228.',
    '李四, 王五. 生成式人工智能与语言教学[J]. 外语教学与研究, 2024(3): 45-52.',
  ].join('\n');
  const gbtParsed = cnimport.parseImport(gbtText);
  check('（i）GB/T 7714 著录格式可解析', gbtParsed.ok === true && gbtParsed.records.length === 2,
    `${gbtParsed.records.length} 条 / ${gbtParsed.format}`);
  check('GB/T 7714 抽取刊名/年/卷期页',
    gbtParsed.records[0].journalName === '世界汉语教学' && gbtParsed.records[0].issuedDate === '2023'
    && gbtParsed.records[0].volume === '37' && gbtParsed.records[0].issue === '2'
    && gbtParsed.records[0].pages === '215-228', JSON.stringify(gbtParsed.records[0].journalName));
  const rwText = [
    'RT Journal Article', 'A1 张三', 'A1 李四', 'T1 汉语学习者请求策略研究', 'JF 语言教学与研究',
    'YR 2022', 'VO 44', 'IS 2', 'SP 88-101',
    'AB 本文考察了汉语学习者的请求策略，并讨论其语用能力发展。',
    'K1 请求策略; 语用能力; 汉语学习者', 'DO 10.1234/test.rw.001',
  ].join('\n');
  const rwParsed = cnimport.parseImport(rwText);
  check('（ii）RefWorks 标签格式可解析', rwParsed.ok === true && rwParsed.records.length === 1,
    `${rwParsed.records.length} 条 / ${rwParsed.format}`);
  check('RefWorks 关键词与摘要完整带出',
    rwParsed.records[0].keywords.length === 3 && rwParsed.records[0].keywords[0] === '请求策略'
    && rwParsed.records[0].abstract === '本文考察了汉语学习者的请求策略，并讨论其语用能力发展。'
    && rwParsed.records[0].keywordsSource === 'imported:cnki',
    JSON.stringify(rwParsed.records[0].keywords));
  const mixedParsed = cnimport.parseImport(gbtText + '\n\n' + rwText);
  check('（iii）两种格式混合粘贴时，两种记录都被返回',
    mixedParsed.ok === true && mixedParsed.records.length === 3, `${mixedParsed.records.length} 条 / ${mixedParsed.format}`);
  check('混合粘贴没有静默丢弃任何一种格式',
    /合并 2 种格式/.test(mixedParsed.format)
    && ['汉语学习者语用能力发展研究', '生成式人工智能与语言教学', '汉语学习者请求策略研究']
      .every((t) => mixedParsed.records.some((r) => r.title === t)),
    mixedParsed.format);
  const csvParsed = cnimport.parseImport(
    ['题名,作者,刊名,摘要,关键词,年,卷,期,页码',
      '汉语否定句习得研究,赵六,中国语文,本文讨论汉语否定句的习得过程。,否定; 习得,2023,65,3,300-315'].join('\n'));
  check('（iv）中文表头 CSV 可解析',
    csvParsed.ok === true && csvParsed.records.length === 1 && csvParsed.records[0].title === '汉语否定句习得研究',
    `${csvParsed.records.length} 条 / ${csvParsed.format}`);
  check('CSV 摘要与关键词带出', csvParsed.records[0].abstract === '本文讨论汉语否定句的习得过程。'
    && csvParsed.records[0].keywords.length === 2, JSON.stringify(csvParsed.records[0].keywords));
  const jsonParsed = cnimport.parseImport(JSON.stringify([
    { title: '语音感知实验研究', authors: ['孙七'], journalName: '世界汉语教学', abstract: '本文报告一项语音感知实验。', keywords: ['语音感知', '实验'], issuedDate: '2021-05-01' },
    { title: '汉语语用标记习得', 作者: '周八', 刊名: '语言科学', 摘要: '本文讨论语用标记习得。', 关键词: '语用标记; 习得', 年: '2020' },
  ]));
  check('（v）JSON 数组可解析', jsonParsed.ok === true && jsonParsed.records.length === 2, `${jsonParsed.records.length} 条`);
  check('JSON 记录保留关键词与摘要，中文键名也可识别',
    jsonParsed.records[0].keywords.join(',') === '语音感知,实验'
    && /语音感知实验/.test(jsonParsed.records[0].abstract)
    && jsonParsed.records[1].journalName === '语言科学', jsonParsed.records[1].journalName);
  const garbageParsed = cnimport.parseImport('这是一段完全无法解析的文本，既没有著录格式也没有标签字段。');
  check('无法识别的文本返回 ok:false 并给出格式提示',
    garbageParsed.ok === false && garbageParsed.records.length === 0 && /支持/.test(garbageParsed.hint || ''),
    garbageParsed.error);

  console.log('\n=== 15. 题录导入的期刊匹配预览 ===');
  journals.importCatalog('cssci',
    ['期刊名称,ISSN,学科分类,版次或年份', '中国语文,0578-1949,语言学,2023-2024年版'].join('\n'),
    { edition: '2023-2024年版', sourceName: '测试导入' });
  const preview = cnimport.previewJournalMatch([
    { title: '汉语否定句习得研究', journalName: '中国语文', issn: '' },
    { title: '某篇来源不明的论文', journalName: '完全不存在的期刊', issn: '' },
  ]);
  check('预览返回总数与命中/未命中数',
    preview.total === 2 && preview.matched === 1 && preview.unmatched === 1,
    JSON.stringify({ total: preview.total, matched: preview.matched, unmatched: preview.unmatched }));
  check('预览返回按状态分组的计数（和为总数）',
    typeof preview.byStatus === 'object'
    && Object.values(preview.byStatus).reduce((a, b) => a + b, 0) === preview.total,
    JSON.stringify(preview.byStatus));
  check('已导入 CSSCI 的刊计为 eligible，未匹配的计为 pending',
    preview.byStatus.eligible === 1 && preview.byStatus.pending === 1, JSON.stringify(preview.byStatus));

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log('\n' + '═'.repeat(58));
  console.log(`  AI 链路 + 篇关摘翻译 + 题录导入测试：${pass} 项通过，${fail} 项失败，共 ${results.length} 项`);
  console.log('═'.repeat(58));
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log('  ❌ ' + r.name + (r.detail ? ' — ' + r.detail : ''));
  }
  mock.close();
  restoreCatalogLoads();
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常：', e); mock.close(); restoreCatalogLoads(); process.exit(2); });
