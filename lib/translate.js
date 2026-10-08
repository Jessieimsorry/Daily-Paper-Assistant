'use strict';
/**
 * 「篇关摘」翻译模块：篇名（篇）、关键词（关）、摘要（摘）。
 *
 * 设计要点：
 *  1. 原文永远保留，译文只是附加层；原文变了（source_hash 变化）旧译文自动失效。
 *  2. 只翻译原文里真实存在的内容。没有摘要就不生成摘要译文，
 *     没有作者关键词就明确显示「原始数据未提供关键词」，绝不把主题标签拿去翻译充数。
 *  3. 译文必须保持学术术语、专名、数字、统计结果与文内引用准确，不得补写原文没有的信息。
 *  4. 每次翻译都记录模型、提供商、时间；重复打开直接复用已保存的译文（可手动强制重译）。
 *  5. 失败时保留原文，并把失败原因与「可重试」状态写进记录。
 */
const store = require('./store');
const { getSettings } = require('./config');
const interpret = require('./interpret');

const FIELDS = {
  title: { label: '篇名', maxChars: 1200 },
  keywords: { label: '关键词', maxChars: 1200 },
  abstract: { label: '摘要', maxChars: 12000 },
};

/**
 * 关键词归一：历史数据里可能存成 {name, score} 对象，统一成字符串数组。
 */
function normalizeKeywordList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((k) => {
      if (typeof k === 'string') return k.trim();
      if (k && typeof k === 'object') return String(k.name || k.display_name || '').trim();
      return '';
    })
    .filter(Boolean);
}

function hash(text) {
  return store.sha1(String(text == null ? '' : text).trim());
}

const TARGET_BY_LANG = { en: 'zh', zh: 'en' };

/** 该论文该字段的原文与可用性 */
function sourceFor(paper, field) {
  if (field === 'title') {
    return { text: (paper.title || '').trim(), available: Boolean((paper.title || '').trim()), note: null };
  }
  if (field === 'keywords') {
    const kw = normalizeKeywordList(store.parseJson(paper.keywords, []));
    if (!kw.length) {
      return {
        text: '', available: false,
        note: '原始数据未提供关键词',
        detail: '该论文来源（Crossref / OpenAlex）没有提供作者关键词。工作台的自动主题标签与数据库主题词不是作者关键词，因此不参与翻译。',
      };
    }
    return {
      text: kw.join('; '), available: true,
      note: paper.keywords_source ? `关键词来源：${paper.keywords_source}` : null,
      detail: paper.keywords_source === 'openalex'
        ? '这些关键词由 OpenAlex 从论文中提取，可能与出版商页面上列出的作者关键词不完全一致。'
        : null,
      list: kw,
    };
  }
  if (field === 'abstract') {
    const a = (paper.abstract || '').trim();
    if (!a) {
      return {
        text: '', available: false,
        note: '原始数据未提供摘要',
        detail: '没有摘要就无法提供摘要译文。工作台不会生成或臆测摘要内容。',
      };
    }
    return { text: a, available: true, note: paper.abstract_source ? `摘要来源：${paper.abstract_source}` : null };
  }
  return { text: '', available: false, note: '未知字段' };
}

function targetLangFor(paper) {
  const lang = paper.language === 'zh' ? 'zh' : 'en';
  return { sourceLang: lang, targetLang: TARGET_BY_LANG[lang] };
}

/** 读取已保存的译文（不调用模型） */
function getSaved(paperId, field) {
  const paper = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (!paper) return { ok: false, error: '论文不存在' };
  const src = sourceFor(paper, field);
  const { sourceLang, targetLang } = targetLangFor(paper);
  if (!src.available) {
    return {
      ok: true, field, available: false, sourceText: null, translated: null,
      note: src.note, detail: src.detail || null,
      sourceLang, targetLang,
    };
  }
  const h = hash(src.text);
  const row = store.get('SELECT * FROM translations WHERE paper_id = ? AND field = ? AND target_lang = ? AND source_hash = ?',
    [paperId, field, targetLang, h]);
  return {
    ok: true, field, available: true,
    sourceText: src.text, sourceLang, targetLang,
    note: src.note, detail: src.detail || null, list: src.list || null,
    translated: row && row.status === 'ok' ? row.translated : null,
    status: row ? row.status : 'missing',
    model: row?.model || null, provider: row?.provider || null,
    createdAt: row?.created_at || null, error: row?.error || null,
    stale: false,
  };
}

/** 一次取回篇名 / 关键词 / 摘要三个字段的译文状态（详情页初始加载用） */
function getAll(paperId) {
  const paper = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (!paper) return { ok: false, error: '论文不存在' };
  const fields = {};
  for (const f of Object.keys(FIELDS)) fields[f] = getSaved(paperId, f);
  return {
    ok: true,
    aiConfigured: interpret.isConfigured(),
    fields,
    attribution: '译文由 AI 生成，仅供参考；引用请以原文为准。',
  };
}

/**
 * 批量读取**已缓存**的篇关摘译文（列表卡片用，绝不调用模型）。
 *
 * 为什么要批量：今日发现一页 30 篇、简报 8 篇，如果每篇 3 次单独查询，
 * 一屏就是近百次 SQL。这里一次把论文与译文全部取出，在内存里配对
 * （同一张 paper 同一字段同一 target_lang 且 source_hash 相符才算命中）。
 *
 * 关键约束（与用户要求一致）：
 *   · 命中缓存就返回译文；没命中就返回 status='missing'，由前端决定是否懒加载；
 *   · 来源没有摘要/关键词时，明确写「原始数据未提供…」，绝不生成内容；
 *   · 工作台主题标签、数据库主题词永远不会出现在 keywords 字段里。
 */
function bundlesFor(paperIds) {
  const ids = [...new Set((paperIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
  const out = new Map();
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const papers = store.all(`SELECT * FROM papers WHERE id IN (${ph})`, ids);
  const rows = store.all(`SELECT * FROM translations WHERE paper_id IN (${ph})`, ids);
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.paper_id}|${r.field}|${r.target_lang}|${r.source_hash}`, r);
  const aiConfigured = interpret.isConfigured();

  for (const paper of papers) {
    const { sourceLang, targetLang } = targetLangFor(paper);
    const fields = {};
    for (const f of Object.keys(FIELDS)) {
      const src = sourceFor(paper, f);
      if (!src.available) {
        fields[f] = {
          available: false, text: null, status: 'unavailable',
          note: src.note, detail: src.detail || null,
        };
        continue;
      }
      const row = byKey.get(`${paper.id}|${f}|${targetLang}|${hash(src.text)}`);
      fields[f] = {
        available: true,
        sourceText: src.text,
        text: row && row.status === 'ok' ? row.translated : null,
        status: row ? row.status : 'missing',     // ok | failed | missing
        model: row?.model || null,
        provider: row?.provider || null,
        createdAt: row?.created_at || null,
        error: row?.error || null,
        note: src.note || null,
        detail: src.detail || null,
        list: src.list || null,
      };
    }
    out.set(paper.id, { sourceLang, targetLang, aiConfigured, fields });
  }
  return out;
}

/** 单篇卡片用的缓存译文（bundlesFor 的便捷封装） */
function cachedBundle(paperId) {
  return bundlesFor([paperId]).get(Number(paperId)) || null;
}

/**
 * 分批预生成译文（列表页懒加载用）。
 *
 * 与详情页「一键翻译」的区别：这里只处理**还没有译文**的字段，
 * 并且有硬上限，避免打开首页就把 1200+ 篇全部翻译、把页面和额度拖死。
 * 每篇最多 3 个字段（篇名 / 关键词 / 摘要），失败不抛出，只如实返回状态。
 */
async function translateBatch({ paperIds = [], fields = ['title', 'keywords', 'abstract'], force = false, limit = 24 } = {}) {
  const allowed = fields.filter((f) => FIELDS[f]);
  const ids = [...new Set((paperIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
  if (!ids.length) return { ok: false, error: '缺少 paperIds' };
  if (!allowed.length) return { ok: false, error: '缺少有效 field' };

  const aiConfigured = interpret.isConfigured();
  if (!aiConfigured) {
    return {
      ok: false, configured: false,
      error: '未配置 AI 密钥，暂不能生成译文。译文缓存仍会正常显示。',
      results: {}, remaining: ids.length,
    };
  }

  const before = bundlesFor(ids);
  const results = {};
  let calls = 0;
  let skipped = 0;
  let remaining = 0;
  const jobs=[];

  for (const pid of ids) {
    const bundle = before.get(pid);
    if (!bundle) continue;
    results[pid] = {};
    for (const f of allowed) {
      const cur = bundle.fields[f];
      if (!cur.available) { results[pid][f] = { ok: false, available: false, error: cur.note }; continue; }
      // 已有缓存且未强制重译 ⇒ 直接用缓存，不消耗模型调用
      if (cur.text && !force) {
        results[pid][f] = { ok: true, cached: true, text: cur.text, createdAt: cur.createdAt, model: cur.model };
        skipped++;
        continue;
      }
      if (calls >= limit) { remaining++; continue; }
      calls++;
      jobs.push((async()=>{try {
        const r = await translate({ paperId: pid, field: f, force });
        if (r.ok) {
          results[pid][f] = { ok: true, cached: Boolean(r.cached), text: r.translated, createdAt: r.createdAt, model: r.model };
        } else {
          results[pid][f] = { ok: false, error: r.error, retryable: r.retryable !== false, available: r.available !== false };
        }
      } catch (e) {
        results[pid][f] = { ok: false, error: e.message, retryable: true };
      }})());
    }
  }
  await Promise.all(jobs);

  return {
    ok: calls > 0 || skipped > 0,
    configured: true,
    fields: allowed,
    calls, fromCache: skipped, remaining,
    results,
    attribution: '译文由 AI 生成，仅供参考；引用请以原文为准。',
  };
}

function systemPrompt(sourceLang, targetLang) {
  const srcName = sourceLang === 'zh' ? '中文' : '英文';
  const dstName = targetLang === 'zh' ? '中文' : '英文';
  return `你是学术文献翻译助手，把${srcName}学术论文的「篇名、关键词、摘要」翻译成${dstName}。

铁规则：
1. 只翻译我给的内容，不得增加、删减、解释、评论或补写任何信息。
2. 学术术语必须使用该领域的规范译法。例如 dynamic assessment → 动态评估，corrective feedback → 纠正性反馈，
   interlanguage pragmatics → 中介语语用学，translanguaging → 超语，self-regulated learning → 自我调节学习，
   worked examples → 样例。没有把握的术语可保留原文并在括号内给出译名。
3. 专名（人名、机构名、期刊名、量表名、理论名缩写）保留原文，必要时在首次出现处加括号译名。
   人名按「名 姓」顺序保留原文拼写，不要音译成中文。
4. 数字、百分比、p 值、F 值、t 值、效应量、样本量、年份、卷期页必须逐字保留，不得改写或四舍五入。
5. 文内引用标记（如 (Smith, 2020)、[1]、Author et al.）原样保留，不得翻译或改动。
6. 保持原文的段落与分句结构；摘要通常是一段，不要拆成多段或加小标题。
7. 如果原文里有看不懂或残缺的片段，原样保留，不要猜测补全。
8. 只输出译文本身，不要输出任何前言、说明、标题或 Markdown 标记。`;
}

const FIELD_INSTRUCTION = {
  title: '请翻译以下论文篇名。只输出译文，不要加书名号或引号。',
  keywords: '以下是用分号分隔的论文关键词。请逐个翻译，仍用分号分隔，顺序与数量必须与原文一致。只输出译文。',
  abstract: '请翻译以下论文摘要。只输出译文，保持一段，不要加「摘要」二字。',
};

/**
 * 翻译一个字段。
 * @param {{paperId:number, field:'title'|'keywords'|'abstract', force?:boolean}} opts
 */
// 全站最多4个翻译调用；相同原文/字段的重复请求共享一次生成。
const translationInflight=new Map(), translationQueue=[];
let translationActive=0;
function pumpTranslationQueue(){
  while(translationActive<4 && translationQueue.length){
    const task=translationQueue.shift();translationActive++;
    Promise.resolve().then(task.run).then(task.resolve,task.reject).finally(()=>{translationActive--;pumpTranslationQueue();});
  }
}
function translate(opts){
  const p=store.get('SELECT * FROM papers WHERE id=?',[opts.paperId]);
  const src=p?sourceFor(p,opts.field):{text:''};const settings=getSettings();
  const key=JSON.stringify([opts.paperId,opts.field,hash(src.text),Boolean(opts.force),settings.aiModel,settings.aiBaseUrl]);
  if(translationInflight.has(key))return translationInflight.get(key);
  const promise=new Promise((resolve,reject)=>{translationQueue.push({run:()=>translateImpl(opts),resolve,reject});pumpTranslationQueue();});
  translationInflight.set(key,promise);promise.finally(()=>translationInflight.delete(key)).catch(()=>{});return promise;
}

async function translateImpl({ paperId, field, force = false }) {
  if (!FIELDS[field]) return { ok: false, error: '未知字段：' + field };
  const paper = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (!paper) return { ok: false, error: '论文不存在' };

  const src = sourceFor(paper, field);
  const { sourceLang, targetLang } = targetLangFor(paper);

  if (!src.available) {
    return {
      ok: false, available: false, field,
      error: src.note, detail: src.detail || null,
      hint: field === 'abstract'
        ? '没有原文摘要，无法翻译。可以先上传你自己取得的 PDF，或换个有摘要的来源。'
        : '原始数据没有提供该字段，无法翻译。',
    };
  }

  const h = hash(src.text);
  if (!force) {
    const cached = store.get('SELECT * FROM translations WHERE paper_id = ? AND field = ? AND target_lang = ? AND source_hash = ?',
      [paperId, field, targetLang, h]);
    if (cached && cached.status === 'ok') {
      return {
        ok: true, cached: true, field,
        sourceText: src.text, translated: cached.translated,
        sourceLang, targetLang, model: cached.model, provider: cached.provider,
        createdAt: cached.created_at, tokens: cached.tokens,
        note: src.note, detail: src.detail || null, list: src.list || null,
      };
    }
  }

  if (!interpret.isConfigured()) {
    // 未配置 AI：不写失败记录（那不是翻译失败，而是没配密钥）
    return {
      ok: false, configured: false, field,
      error: '未配置 AI 密钥，无法翻译。请在「设置」页填入 API Key（或用本机模型端点）。',
      sourceText: src.text, sourceLang, targetLang, retryable: true,
    };
  }

  const s = getSettings();
  const truncated = src.text.length > FIELDS[field].maxChars;
  const textToSend = truncated ? src.text.slice(0, FIELDS[field].maxChars) : src.text;

  const messages = [
    { role: 'system', content: systemPrompt(sourceLang, targetLang) },
    { role: 'user', content: `${FIELD_INSTRUCTION[field]}\n\n---\n${textToSend}\n---` },
  ];

  const budget=field==='abstract' ? Math.min(Math.max(2600,Math.ceil(textToSend.length*0.65+512)),Math.max(2600,s.aiMaxTokens||6000)) : 900;
  const r = await interpret.callModel(messages, { temperature: 0.15, maxTokens: budget, thinking:false });
  if(r.finishReason==='length'){r.ok=false;r.error='译文输出达到长度上限，未生成完整译文；原文已保留，可调整输出上限后重试';}

  if (!r.ok) {
    // 记录失败，保留原文，供用户重试
    store.run(
      `INSERT INTO translations(paper_id, field, target_lang, source_lang, source_hash, source_text, translated, status, model, provider, error)
       VALUES(?,?,?,?,?,?,?, 'failed', ?, ?, ?)
       ON CONFLICT(paper_id, field, target_lang, source_hash) DO UPDATE SET
         status='failed', error=excluded.error, model=excluded.model, created_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
      [paperId, field, targetLang, sourceLang, h, src.text, null, s.aiModel, s.aiProvider, String(r.error).slice(0, 500)]);
    return {
      ok: false, field, error: r.error, sourceText: src.text,
      sourceLang, targetLang, retryable: true,
      hint: '原文已保留。可稍后点「重新翻译」重试。',
    };
  }

  const translated = String(r.content || '').trim();
  if (!translated) {
    store.run(
      `INSERT INTO translations(paper_id, field, target_lang, source_lang, source_hash, source_text, translated, status, model, provider, error)
       VALUES(?,?,?,?,?,?,?, 'failed', ?, ?, ?)
       ON CONFLICT(paper_id, field, target_lang, source_hash) DO UPDATE SET
         status='failed', error=excluded.error, created_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
      [paperId, field, targetLang, sourceLang, h, src.text, null, s.aiModel, s.aiProvider, '模型返回空内容']);
    return { ok: false, field, error: '模型返回空内容', retryable: true, sourceText: src.text };
  }

  // 数字保真校验：原文里出现的统计量在译文里应仍然出现
  const check = verifyNumbers(src.text, translated);

  store.run(
    `INSERT INTO translations(paper_id, field, target_lang, source_lang, source_hash, source_text, translated, status, model, provider, tokens, error)
     VALUES(?,?,?,?,?,?,?, 'ok', ?, ?, ?, NULL)
     ON CONFLICT(paper_id, field, target_lang, source_hash) DO UPDATE SET
       translated=excluded.translated, status='ok', model=excluded.model, provider=excluded.provider,
       tokens=excluded.tokens, error=NULL, created_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    [paperId, field, targetLang, sourceLang, h, src.text, translated,
     r.model || s.aiModel, s.aiProvider, r.tokens ?? null]);

  // 时间以库里那条记录为准，不让前端自己造：
  // 否则「刚翻译完」与「刷新后」走两个时间来源，会差 8 小时。
  const savedT = store.get(
    'SELECT created_at FROM translations WHERE paper_id = ? AND field = ? AND target_lang = ? AND source_hash = ?',
    [paperId, field, targetLang, h]);

  return {
    ok: true, field, sourceText: src.text, translated,
    sourceLang, targetLang, model: r.model || s.aiModel, provider: s.aiProvider,
    tokens: r.tokens, createdAt: savedT ? savedT.created_at : null,
    note: src.note, detail: src.detail || null, list: src.list || null,
    truncated, numberCheck: check,
  };
}

/** 批量翻译（详情页「一键翻译」）：篇名 → 关键词 → 摘要 */
async function translateAll({ paperId, force = false, fields = ['title', 'keywords', 'abstract'] }) {
  const out = {};
  const errors = [];
  await Promise.all(fields.map(async f=>{
    try {
      out[f] = await translate({ paperId, field: f, force });
      if (!out[f].ok && out[f].available !== false) errors.push({ field: f, error: out[f].error });
    } catch (e) {
      out[f] = { ok: false, field: f, error: e.message, retryable: true };
      errors.push({ field: f, error: e.message });
    }
  }));
  return { ok: errors.length === 0, results: out, errors };
}

/**
 * 数字保真校验：抽出原文里的统计量（p 值、F 值、t 值、百分比、年份、样本量等），
 * 检查译文是否原样保留。这是「译文不得改动数字」这条规则的自动检查。
 */
function verifyNumbers(sourceText, translated) {
  const re = /(?:[pFtrz]\s*[=<>]\s*\.?\d+(?:\.\d+)?)|(?:\d+(?:\.\d+)?\s*%)|(?:\d+(?:\.\d+)?\s*(?:participants|learners|students|teachers|items|classes|schools))|(?:\b(?:19|20)\d{2}\b)|(?:\bN\s*=\s*\d+)/gi;
  const srcNums = [...new Set((String(sourceText).match(re) || []).map((x) => x.replace(/\s+/g, ' ').trim()))];
  const tgt = String(translated);
  const missing = srcNums.filter((n) => {
    const digits = n.replace(/[^\d.<>=]/g, '');
    return digits.length > 1 && !tgt.replace(/\s+/g, '').includes(digits);
  });
  return {
    checked: srcNums.length,
    missing,
    ok: missing.length === 0,
    note: missing.length
      ? `译文可能未完整保留这些数字/统计量：${missing.join('、')}。请对照原文核对。`
      : '原文中的数字与统计量在译文中均能找到。',
  };
}

/** 详情页展示用的字段状态（含「原始数据未提供」的明确说明） */
function statusForPaper(paperId) {
  const paper = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (!paper) return null;
  const kw = normalizeKeywordList(store.parseJson(paper.keywords, []));
  const src = paper.keywords_source || null;
  const dbTopics = store.parseJson(paper.openalex_topics, []);
  const wbTopics = store.parseJson(paper.topics, []);
  // 关键词来源决定措辞：不能把机器提取的关键词说成「作者关键词」
  const label = src === 'imported' || src === 'imported:cnki'
    ? '作者关键词（题录导入）'
    : (src === 'openalex' ? 'OpenAlex 提取的关键词' : (kw.length ? '关键词' : '作者关键词'));
  const caveat = src === 'openalex'
    ? '这些关键词由 OpenAlex 从论文全文自动提取，不是出版商页面上列出的作者关键词，可能包含通用词（如 Process、Identification）。'
    : (src === 'semanticscholar:fieldsOfStudy'
        ? '这些是 Semantic Scholar 的学科领域标签，不是作者关键词。'
        : (src === 'imported' || src === 'imported:cnki'
            ? '来自你导入的中文数据库题录，属于作者关键词。'
            : null));
  return {
    keywords: {
      items: kw,
      source: src,
      label,
      isAuthorSupplied: src === 'imported' || src === 'imported:cnki',
      available: kw.length > 0,
      emptyText: '原始数据未提供关键词',
      caveat,
    },
    dbTopics: { items: dbTopics, label: '数据库主题词', source: 'OpenAlex topics' },
    workbenchTopics: {
      items: wbTopics,
      label: '工作台主题标签',
      source: '本工作台按检索词与关键词匹配生成',
      caveat: '这是工作台自动生成的标签，不是作者关键词，也不是数据库主题词。',
    },
    dbSubjects: { items: store.parseJson(paper.db_subjects, []), label: '出版商主题分类' },
  };
}

/** 手动把主题标签误当关键词的情况检查（自检用） */
function assertNoTopicLeak(paperId) {
  const paper = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  const kw = store.parseJson(paper.keywords, []);
  const topicSlugs = store.parseJson(paper.topics, []);
  const leaked = kw.filter((k) => topicSlugs.includes(String(k).toLowerCase()));
  return { keywords: kw, topicSlugs, leaked, ok: leaked.length === 0 };
}

module.exports = {
  translate, translateAll, getSaved, getAll, statusForPaper,
  verifyNumbers, sourceFor, targetLangFor, hash, FIELDS, assertNoTopicLeak,
  bundlesFor, cachedBundle, translateBatch,
};

// 升级后的任务接口；未迁移的测试库仍沿用原实现。
const legacyExports={...module.exports};
function upgraded(){return Boolean(require('./customize').get('profiles'));}
module.exports.bundlesFor=function(ids){if(!upgraded())return legacyExports.bundlesFor(ids);return new Map(ids.filter(id=>store.get('SELECT id FROM papers WHERE id=?',[id])).map(id=>[id,require('./multilingual').paperBundle(id)]));};
module.exports.getAll=function(id){if(!upgraded())return legacyExports.getAll(id);return {ok:true,...require('./multilingual').paperBundle(id),attribution:'译文由 AI 生成，仅供参考。'};};
module.exports.translate=function(o){return upgraded()?require('./multilingual').translate({...o,subjectKey:'paper:'+o.paperId}):legacyExports.translate(o);};
module.exports.translateBatch=function(o){return upgraded()?require('./multilingual').batch(o):legacyExports.translateBatch(o);};
module.exports.translateAll=async function(o){if(!upgraded())return legacyExports.translateAll(o);return module.exports.translateBatch({...o,paperIds:[o.paperId],limit:3});};

module.exports.cachedBundle=id=>module.exports.bundlesFor([Number(id)]).get(Number(id))||null;
module.exports.getSaved=(id,field)=>upgraded()?require('./multilingual').saved('paper:'+id,field):legacyExports.getSaved(id,field);
