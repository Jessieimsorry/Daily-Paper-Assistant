'use strict';
/**
 * AI 解读模块。
 *
 * 最重要的约束：依据范围必须真实、可核查。
 *  - 只把「题名/元数据」「摘要」「全文」中实际拿到的那部分给模型；
 *  - 给材料编号 [S1][S2]…，要求模型引用编号，引用不存在编号的段落会被剔除；
 *  - 没有全文时，明确标注依据范围仅为摘要，并在提示词里禁止声称读过全文、
 *    禁止编造样本量/统计量/页码/引文；
 *  - 生成的每段话都保留 evidence_scope，前端强制显示。
 */
const store = require('./store');
const { getSettings, getSecret, detectAiProvider } = require('./config');
const rank = require('./rank');

const MODES = {
  quick: {
    label: '快速解读',
    prompt: `请给出「快速解读」，面向一位每天快速浏览文献的研究者。用 250–400 字，包含：
1) 这篇论文研究的问题是什么（一句话）；
2) 用了什么理论与方法（尽量具体，但只依据已有材料）；
3) 主要结论；
4) 一句话说明它对国际中文教育/语言教育研究者的潜在用处。
不要写套话，不要重复题名。`,
  },
  deep: {
    label: '深入解读',
    prompt: `请给出「深入解读」，面向一位要据此形成研究问题、设计研究、撰写论文与项目申请的资深研究者。用结构化小节输出，每节都要标明依据：
## 一、研究问题
（问题是什么，问题从哪里来，是否清楚可检验）
## 二、理论框架
（用了什么理论/概念框架；若材料未交代，直说"材料未说明"）
## 三、研究对象与方法
（对象、样本、材料、程序、分析方法；材料里没有的项一律写"材料未说明"，不要推测）
## 四、主要发现
（逐条列出，尽量对应原文表述）
## 五、证据与结论是否匹配
（这是重点：结论是否被证据支撑？有无过度推论、样本局限、测量局限？请分开写"材料支持的"和"材料不足以判断的"）
## 六、研究局限
（作者自陈的局限 + 你能从方法上合理指出的局限，两者要分开）
## 七、可借鉴之处（注意：这是研究启发，不是论文已证明的结论）
（对国际中文教育、二语习得、二语语用、动态评估、AI 赋能语言教学、人智协同教学可能有什么启发；给出 2–4 条可操作的想法）
## 八、我还能追问什么
（3–5 个值得向原文追究的问题）

要求：把"论文已经证明的"和"我认为可以借鉴的"严格分开，后者必须放在第七节并明确标为研究启发。`,
  },
};

function buildEvidence(paperId, useFulltext) {
  const p = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (!p) return { ok: false, error: '论文不存在' };

  const meta = [
    `题名：${p.title}`,
    p.title_zh ? `中文题名：${p.title_zh}` : null,
    `作者：${store.parseJson(p.authors, []).join('; ') || '（元数据未提供）'}`,
    `期刊：${p.journal_name || '（未知）'}`,
    `ISSN：${p.issn || '（未知）'}`,
    `DOI：${p.doi_norm || '（无）'}`,
    p.published_online ? `首次在线发表日期：${p.published_online}` : null,
    p.issued_date ? `出版日期：${p.issued_date}` : null,
    (p.volume || p.issue || p.pages) ? `卷期页：${[p.volume, p.issue, p.pages].filter(Boolean).join(' / ')}` : null,
    `原文链接：${p.url || '（无）'}`,
    p.publisher ? `出版商：${p.publisher}` : null,
  ].filter(Boolean).join('\n');

  const sentences = [];
  const segments = [];

  if (p.abstract) {
    const parts = splitSentences(p.abstract);
    parts.forEach((s) => {
      sentences.push({ id: 'S' + (sentences.length + 1), scope: 'abstract', text: s });
    });
  }

  let fulltextInfo = null;
  if (useFulltext) {
    const ft = store.get('SELECT * FROM fulltexts WHERE paper_id = ?', [paperId]);
    if (ft && ft.content) {
      const secs = store.parseJson(ft.sections, []);
      // 分段：优先按识别出的章节切，否则按长度窗口切
      let chunks = [];
      if (secs.length > 1) {
        chunks = secs.map((s) => ({ label: s.heading || s.label || '', text: s.text }));
      } else {
        chunks = splitChunks(ft.content, 2200);
      }
      for (const c of chunks) {
        const parts = splitSentences(c.text);
        parts.forEach((s) => {
          sentences.push({ id: 'S' + (sentences.length + 1), scope: 'fulltext', section: c.label || null, text: s });
        });
      }
      fulltextInfo = {
        origin: ft.origin, filename: ft.filename, charCount: ft.char_count,
        note: ft.note, sections: secs.map((s) => s.heading || s.label).filter(Boolean),
      };
    }
  }

  const scope = fulltextInfo ? 'fulltext' : (p.abstract ? 'abstract' : 'metadata');

  // 控制提示词长度
  const MAX_CHARS = 46000;
  let used = sentences;
  let truncated = false;
  let total = 0;
  const keep = [];
  for (const s of sentences) {
    total += s.text.length;
    if (total > MAX_CHARS) { truncated = true; break; }
    keep.push(s);
  }
  used = keep;

  return {
    ok: true,
    paper: {
      id: p.id, title: p.title, title_zh: p.title_zh, journal: p.journal_name,
      doi: p.doi_norm, url: p.url, language: p.language,
      published_online: p.published_online, published_print: p.published_print,
      discovery_date: p.discovery_date, open_access: Boolean(p.open_access),
      topics: store.parseJson(p.topics, []),
    },
    scope,
    meta,
    sentences: used,
    truncated,
    fulltextInfo,
    abstractSource: p.abstract_source || null,
    discoveryDates: {
      published_online: p.published_online,
      published_print: p.published_print,
      discovery_date: p.discovery_date,
    },
    hasAbstract: Boolean(p.abstract),
    evidenceNote: {
      metadata: '依据范围：题名与元数据（作者、期刊、DOI、链接、日期）。仅凭元数据无法判断研究结论。',
      abstract: '依据范围：题名/元数据 + 摘要。未读取全文，摘要未交代的样本量、统计结果、页码、引文一律不得推定。',
      fulltext: `依据范围：题名/元数据 + 摘要 + 全文（来源：${fulltextInfo ? fulltextInfo.origin : '未知'}${fulltextInfo?.filename ? '·' + fulltextInfo.filename : ''}）。引用仍以原文为准。`,
    }[scope],
  };
}

function splitSentences(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return [];
  // 中英文句末切分
  const parts = t.split(/(?<=[.!?。！？；;])\s*/).map((x) => x.trim()).filter((x) => x.length > 1);
  const out = [];
  for (const p of parts) {
    if (p.length <= 400) { out.push(p); continue; }
    for (let i = 0; i < p.length; i += 300) out.push(p.slice(i, i + 300));
  }
  return out;
}

function splitChunks(text, size) {
  const t = String(text);
  const chunks = [];
  for (let i = 0; i < t.length; i += size) chunks.push({ label: `全文片段 ${chunks.length + 1}`, text: t.slice(i, i + size) });
  return chunks;
}

function systemPrompt() {
  return `你是一位严谨的应用语言学与语言教育研究助手，服务对象是一位从事国际中文教育与语言教育研究的研究者和教师。
她的既有研究方向：第二语言习得、二语语用、动态评估、人工智能赋能语言教学、人智协同教学。
她阅读文献的目的是了解领域进展、形成研究问题、设计研究、开展教学研究、撰写论文与项目申请。

铁的规则（违反即失败）：
1. 只使用我提供的材料。材料里没有的样本量、统计量、效应量、p 值、页码、引文、作者观点，一律不得编造。
2. 每条实质陈述后面用 [S编号] 标注它来自哪条材料；没有材料支撑的判断要显式写"（推断，无材料支撑）"。
3. 当依据范围只是题名/元数据或摘要时，禁止声称读过全文，禁止描述正文结构、图表或具体页码。
4. 严格区分三类内容并分别标注：
   ·【论文原文/摘要的内容】——可直接引用材料
   ·【论文中的实际结论】——作者自己的结论
   ·【AI 提出的研究启发】——你的建议，必须明确标记为启发而非结论
5. 证据不足时直接说"材料不足以判断"，不要用模糊语言掩盖。
6. 用简体中文输出。术语首次出现时给出中文与英文原文，例如"动态评估（dynamic assessment）"。
7. 不要写"本文具有重要意义""提供了新的视角"这类空话。要具体到研究问题、方法、对象、发现。
8. 推荐与解读要服务于科研判断：让读者看清论文研究了什么、用什么理论与方法、证据支持到什么程度、有什么局限、可能怎样启发她的研究。`;
}

function buildUserPrompt(ev, mode, question) {
  const s = getSettings();
  const topicsAll = require('./discover').listTopics(true)
    .map((t) => `${t.name_zh}（关键词：${[...(t.keywords_zh || []).slice(0, 3), ...(t.keywords_en || []).slice(0, 3)].join('、')}）`).join('\n  - ');

  const material = ev.sentences.length
    ? ev.sentences.map((s2) => `[${s2.id}]${s2.section ? '（' + s2.section + '）' : ''} ${s2.text}`).join('\n')
    : '（除元数据外没有任何正文材料，请只基于元数据回答，并明确说明信息不足）';

  const taskText = mode === 'followup'
    ? `我的追问是：${question}\n\n请直接回答该问题，仍然遵守引用与依据范围规则。若材料不足以回答，请说明需要哪些信息（例如需要全文的哪一节）。`
    : MODES[mode].prompt;

  return `## 本次解读的依据范围
${ev.evidenceNote}
${ev.truncated ? '（注意：材料较长，已按长度上限截断，仅提供前面的部分内容）' : ''}
${ev.fulltextInfo ? `全文来源：${ev.fulltextInfo.origin}${ev.fulltextInfo.filename ? ' / ' + ev.fulltextInfo.filename : ''}；抽取字符数 ${ev.fulltextInfo.charCount}；抽取方式为本地 PDF 文字层解析，可能有排版噪声。` : ''}

## 论文元数据（可核实）
${ev.meta}

## 可用材料（每条已编号，引用时请使用编号）
${material}

## 研究者的关注领域
  - ${topicsAll}

## 本次任务
${taskText}`;
}

function apiKey() {
  const s = getSettings();
  const names = [s.aiKeyEnvVar, 'DEEPSEEK_API_KEY', 'LITDESK_AI_KEY', 'OPENAI_API_KEY'].filter(Boolean);
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return getSecret('deepseekApiKey') || '';
}

/** 本机端点（Ollama / vLLM / LM Studio 等）通常不需要密钥 */
function isLocalEndpoint() {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(getSettings().aiBaseUrl || '');
}

/** 是否具备生成 AI 解读的条件（有密钥，或端点是本机且无需密钥） */
function isConfigured() {
  const p=require('./models').resolve(null,'deep');
  if(p&&!p.legacy)return Boolean(require('./config').getSecret('profile:'+p.id))||['localhost','127.0.0.1','[::1]'].includes(new URL(p.baseUrl).hostname);
  return Boolean(apiKey()) || isLocalEndpoint();
}

/**
 * 调用模型，并在「推理模型吃光输出预算」时自动重试一次更大的预算。
 * 这是 deepseek-flash / deepseek-reasoner 这类推理模型的常见坑，
 * 不处理就会把可用的模型误报成失败。
 */
async function callModelWithRetry(messages, opts = {}) {
  const first = await callModel(messages, opts);
  if (first.ok || !first.truncatedByReasoning) return first;
  const s = getSettings();
  const bigger = Math.max(Number(opts.maxTokens || 0), s.aiMaxTokens || 3000, 8000) * 2;
  const second = await callModel(messages, { ...opts, maxTokens: bigger });
  if (second.ok) return { ...second, retriedWithBudget: bigger };
  return { ...second, retriedWithBudget: bigger, error: second.error || first.error };
}

async function callModel(messages, opts = {}) {
 const models=require('./models');let p,id;try{p=models.resolve(opts.profileId,opts.thinking===false?'translation':'deep');if(p&&!p.legacy)return models.invoke(p,messages,opts);if(!apiKey()&&!isLocalEndpoint())return {ok:false,error:'未配置 AI 密钥，请先配置模型连接'};id=models.reserve(p);const r=await legacyCallModel(messages,opts);if(r.error)r.error=models.redact(r.error);return models.finish(id,r);}catch(e){return models.finish(id,{ok:false,error:models.redact(e.message)});}
}
async function legacyCallModel(messages, { maxTokens, temperature, thinking, signal } = {}) {
  const s = getSettings();
  const key = apiKey();
  if (!key && !isLocalEndpoint()) {
    return { ok: false, error: `未配置 AI 密钥。请在「设置」中填入 API Key，或设置环境变量 ${s.aiKeyEnvVar || 'DEEPSEEK_API_KEY'}。` };
  }

  const base = (s.aiBaseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const budget = maxTokens ?? s.aiMaxTokens ?? 3000;
  const body = JSON.stringify({
    model: s.aiModel || 'deepseek-chat',
    messages,
    temperature: temperature ?? s.aiTemperature ?? 0.3,
    max_tokens: budget,
    stream: false,
    ...(thinking===false && new URL(base).hostname==='api.deepseek.com' ? {thinking:{type:'disabled'}} : {}),
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body, signal: signal ? AbortSignal.any([signal,ctl.signal]) : ctl.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) {
      // 绝不回显密钥
      const msg = data?.error?.message || data?.message || text.slice(0, 300);
      return { ok: false, error: `AI 接口返回 ${res.status}: ${msg}`, status: res.status, ms: Date.now() - started };
    }
    const choice = data?.choices?.[0] || {};
    const msg = choice.message || {};
    let content = msg.content || '';
    // 推理模型的坑：输出预算太小时，token 会全部消耗在思维链上，
    // content 为空而 reasoning_content 有内容，finish_reason = 'length'。
    // 这不是接口失败，必须区分处理，否则会误报「AI 返回了空内容」。
    const reasoning = msg.reasoning_content || msg.reasoning || '';
    const truncatedByReasoning = !content.trim() && Boolean(reasoning) && choice.finish_reason === 'length';

    if (!content.trim() && !reasoning.trim()) {
      return { ok: false, error: 'AI 返回了空内容', ms: Date.now() - started, model: data.model || s.aiModel };
    }

    let note = null;
    if (truncatedByReasoning) {
      note = `当前模型是推理模型（${data.model || s.aiModel}），本次输出预算（max_tokens=${budget}）被思维链占满，未能产出正式回答。`
        + '已自动重试更大的预算；若仍失败，请到「设置」把「单次最大输出 tokens」调大，或改用非推理模型（如 deepseek-chat）。';
      content = '';
    } else if (!content.trim() && reasoning.trim()) {
      // 只有思维链、没有正式回答：不要把思维链冒充成答案
      note = '模型只返回了思维链（reasoning_content），没有正式回答。请调大输出 token 上限或更换模型。';
    }

    return {
      ok: Boolean(content.trim()),
      content,
      reasoning: reasoning ? String(reasoning).slice(0, 2000) : null,
      truncatedByReasoning,
      finishReason:choice.finish_reason || null,
      note,
      error: content.trim() ? null : note,
      retryable: !content.trim(),
      ms: Date.now() - started,
      model: data.model || s.aiModel,
      tokens: data.usage?.total_tokens ?? null,
      usage: data.usage || null,
    };
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === 'AbortError' ? 'AI 请求超时（180s）' : e.message;
    return { ok: false, error: msg, ms: Date.now() - started };
  }
}

/**
 * 把「生成这条解读时实际提供给模型的材料」原样存成快照。
 *
 * 为什么必须存快照：论文的摘要或全文之后可能被更新（重新采集、换来源、重新上传 PDF），
 * 如果只存编号，旧解读的 [S1] 就会指向更新后的新材料，等于篡改了证据链。
 * 存下当时的文本，编号才真正可回溯。
 */
function snapshotMaterials(interpId, sentences, { citedIds = [], evidenceScope, fulltextInfo, abstractSource } = {}) {
  if (!interpId || !Array.isArray(sentences) || !sentences.length) return { saved: 0 };
  const cited = new Set(citedIds || []);
  // 同一解读重复保存时先清空，避免叠加
  store.run('DELETE FROM interpretation_materials WHERE interp_id = ?', [interpId]);
  let saved = 0;
  store.tx(() => {
    for (const s2 of sentences) {
      const sourceLabel = s2.scope === 'fulltext'
        ? `全文片段${s2.section ? '（' + s2.section + '）' : ''}` +
          (fulltextInfo ? `｜来源：${fulltextInfo.origin || '未知'}${fulltextInfo.filename ? '·' + fulltextInfo.filename : ''}` : '')
        : (s2.scope === 'abstract'
            ? `摘要${abstractSource ? '（来源：' + abstractSource + '）' : ''}`
            : '题名与元数据');
      store.run(
        `INSERT INTO interpretation_materials(interp_id, paper_id, sid, scope, section, source_label, text, char_count, cited)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [interpId, s2.paperId || null, s2.id, s2.scope, s2.section || null,
         sourceLabel, s2.text, s2.text.length, cited.has(s2.id) ? 1 : 0]);
      saved++;
    }
  });
  return { saved };
}

/** 读取某条解读的材料快照；没有快照时明确返回 missing */
function getMaterialsForInterpretation(interpId) {
  const interp = store.get('SELECT * FROM interpretations WHERE id = ?', [interpId]);
  if (!interp) return { ok: false, error: '解读记录不存在' };
  const mats = store.all(
    'SELECT * FROM interpretation_materials WHERE interp_id = ? ORDER BY id', [interpId]);
  const paper = store.get('SELECT id, title, doi_norm, url, issn, journal_name FROM papers WHERE id = ?', [interp.paper_id]);

  if (!mats.length) {
    return {
      ok: true,
      hasSnapshot: false,
      interpId,
      paperId: interp.paper_id,
      paper: paper || null,
      evidenceScope: interp.evidence_scope,
      evidenceNote: interp.evidence_note,
      createdAt: interp.created_at,
      materials: [],
      message: '这条解读生成于「材料快照」功能上线之前，当时没有保存所依据的原文片段。'
        + '编号无法回溯到具体文本，因此不提供引用原文查看——以免让你以为看到的片段就是当时的证据。'
        + '重新生成一次解读即可获得完整快照。',
    };
  }
  return {
    ok: true,
    hasSnapshot: true,
    interpId,
    paperId: interp.paper_id,
    paper: paper || null,
    evidenceScope: interp.evidence_scope,
    evidenceNote: interp.evidence_note,
    createdAt: interp.created_at,
    model: interp.model,
    materials: mats.map((m) => ({
      sid: m.sid, scope: m.scope, section: m.section, sourceLabel: m.source_label,
      text: m.text, charCount: m.char_count, cited: m.cited === 1,
    })),
  };
}

/** 单条编号的材料（点击 [S1] 时用） */
function getMaterial(interpId, sid) {
  const all = getMaterialsForInterpretation(interpId);
  if (!all.ok) return all;
  const m = all.materials.find((x) => x.sid === sid);
  if (!m) {
    return {
      ok: true, found: false, interpId, sid, hasSnapshot: all.hasSnapshot,
      message: all.hasSnapshot
        ? `这条解读里没有编号 ${sid} 对应的材料。编号存在只说明模型引用了该片段，不能据此推断片段足以支持结论。`
        : all.message,
    };
  }
  return {
    ok: true, found: true, interpId, sid, hasSnapshot: true,
    material: m,
    paper: all.paper,
    evidenceScope: all.evidenceScope,
    evidenceNote: all.evidenceNote,
    createdAt: all.createdAt,
    // 明确限定：编号存在 ≠ 片段足以支撑结论
    caveat: '编号只表示模型引用了这段材料。是否足以支持该结论，需要你对照原文判断。',
  };
}

/** 校验模型引用：剔除不存在的 [Sx] 编号，统计引用覆盖 */
function validateGrounding(content, sentences) {
  const valid = new Set(sentences.map((s) => s.id));
  const cited = new Set();
  const bogus = new Set();
  const re = /\[(S\d+)\]/g;
  let m;
  while ((m = re.exec(content))) {
    if (valid.has(m[1])) cited.add(m[1]); else bogus.add(m[1]);
  }
  let cleaned = content;
  if (bogus.size) {
    cleaned = cleaned.replace(/\[(S\d+)\]/g, (full, id) => (valid.has(id) ? full : '（引用编号无效，已移除）'));
  }
  return {
    citedIds: [...cited], bogusIds: [...bogus],
    citationCount: cited.size, coverage: valid.size ? Number((cited.size / valid.size).toFixed(2)) : 0,
    totalMaterials: valid.size, cleaned,
  };
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

async function interpret({ paperId, mode = 'quick', question = null, useFulltext = true }) {
  if (mode !== 'quick' && mode !== 'deep' && mode !== 'followup') {
    return { ok: false, error: '未知解读模式' };
  }
  if (mode === 'followup' && !question) return { ok: false, error: '追问内容不能为空' };

  const ev = buildEvidence(paperId, useFulltext);
  if (!ev.ok) return ev;

  const s = getSettings();
  if (!isConfigured()) {
    return {
      ok: false, configured: false,
      error: `未配置 AI 密钥，无法生成 AI 解读。请在「设置」页填入 API Key，或设置环境变量 ${s.aiKeyEnvVar || 'DEEPSEEK_API_KEY'} 后重试。`
        + '（如果使用本机模型服务，把接口地址设为 http://127.0.0.1:端口 即可免密钥。）',
      evidenceScope: ev.scope, evidenceNote: ev.evidenceNote,
      ruleSummary: ruleBasedSummary(paperId),
    };
  }

  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: buildUserPrompt(ev, mode, question) },
  ];
  const r = await callModelWithRetry(messages);
  if (!r.ok) {
    return { ok: false, error: r.error, evidenceScope: ev.scope, evidenceNote: ev.evidenceNote, configured: true };
  }

  const g = validateGrounding(r.content, ev.sentences);

  const id = store.run(
    `INSERT INTO interpretations(paper_id, mode, question, evidence_scope, evidence_note, model, provider, content, grounding, tokens, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [paperId, mode, question, ev.scope, ev.evidenceNote, r.model || s.aiModel, s.aiProvider || 'deepseek',
     g.cleaned, JSON.stringify({
       citedIds: g.citedIds, bogusIds: g.bogusIds, coverage: g.coverage,
       totalMaterials: g.totalMaterials, truncated: ev.truncated,
       fulltextOrigin: ev.fulltextInfo?.origin || null,
       fulltextChars: ev.fulltextInfo?.charCount || null,
     }), r.tokens,
     // 显式写入时间：一是保证带时区标记，二是让注入的可控时钟能决定它
     // （否则 SQLite 的 now 是真实时间，测试无法复现「同一时刻」这类断言）
     require('./clock').nowIso()]);

  const interpId = Number(id.lastInsertRowid);

  // 保存材料快照，让 [S1] 这类编号以后真的可回溯
  const snap = snapshotMaterials(interpId,
    ev.sentences.map((x) => ({ ...x, paperId })),
    {
      citedIds: g.citedIds, evidenceScope: ev.scope,
      fulltextInfo: ev.fulltextInfo, abstractSource: ev.abstractSource,
    });

  // 时间以**库里那条记录**为准，不让前端自己 new Date() 造一个：
  // 否则「刚生成」和「刷新后」会走两条不同的时间来源，差 8 小时。
  const savedRow = store.get('SELECT created_at FROM interpretations WHERE id = ?', [interpId]);

  return {
    ok: true,
    id: interpId,
    createdAt: savedRow ? savedRow.created_at : null,
    snapshot: { saved: snap.saved, hasSnapshot: snap.saved > 0 },
    mode, question,
    evidenceScope: ev.scope,
    evidenceNote: ev.evidenceNote,
    content: g.cleaned,
    grounding: { citedIds: g.citedIds, bogusIds: g.bogusIds, coverage: g.coverage, totalMaterials: g.totalMaterials, truncated: ev.truncated },
    model: r.model || s.aiModel,
    tokens: r.tokens,
    ms: r.ms,
    materials: ev.sentences.map((x) => ({ id: x.id, scope: x.scope, section: x.section || null })),
  };
}

/** 未配置 AI 时给出的规则版摘要，明确标注不是 AI 解读 */
function ruleBasedSummary(paperId) {
  const p = store.get('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (!p) return null;
  const topics = require('./discover').listTopics(true);
  const sc = rank.scorePaper(p, topics);
  return {
    label: '规则版速览（非 AI 解读，仅用于在未配置密钥时提供基本信息）',
    title: p.title,
    journal: p.journal_name,
    dates: { online: p.published_online, print: p.published_print, discovery: p.discovery_date },
    abstractAvailable: Boolean(p.abstract),
    abstractPreview: p.abstract ? p.abstract.slice(0, 300) + (p.abstract.length > 300 ? '…' : '') : null,
    methodSignals: sc.detail.designs,
    topicHits: sc.detail.topicHits,
    openAccess: Boolean(p.open_access),
    oaStatus: p.oa_status,
    link: p.url,
  };
}

function listInterpretations(paperId) {
  return store.all(`SELECT * FROM interpretations WHERE paper_id = ? ORDER BY created_at DESC`, [paperId])
    .map((r) => ({
      id: r.id, mode: r.mode, question: r.question,
      evidenceScope: r.evidence_scope, evidenceNote: r.evidence_note,
      model: r.model, provider: r.provider, content: r.content,
      grounding: store.parseJson(r.grounding, {}),
      tokens: r.tokens, createdAt: r.created_at,
    }));
}

function deleteInterpretation(id) {
  store.run('DELETE FROM interpretations WHERE id = ?', [id]);
}

/** 批量生成简报推荐理由（AI 版），失败时调用方回退到规则版 */
async function briefReasons(items) {
  if (!isConfigured()) return { ok: false, error: '未配置 AI 密钥' };
  const s = getSettings();
  const payload = items.map((it) => ({
    paperId: it.paper.id,
    title: it.paper.title,
    journal: it.paper.journal_name,
    language: it.paper.language,
    publishedOnline: it.paper.published_online,
    abstract: (it.paper.abstract || '').slice(0, 1400),
    topicHits: it.scored.detail.topicHits,
    designs: it.scored.detail.designs,
  }));

  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: `下面是我今天候选的若干篇新论文。请为每一篇写一条「值得我读」的具体推荐理由，60–120 字，中文。
要求：
- 必须具体说明这篇论文研究了什么、用了什么方法、为什么对一位做国际中文教育/二语习得/二语语用/动态评估/AI 赋能语言教学/人智协同教学的研究者有用。
- 禁止写"与研究方向相关""具有重要意义"这类空泛说法。
- 只能依据我给的题名、期刊、摘要与规则信号；摘要缺失时就说明"摘要缺失，仅凭题名判断"。
- 若摘要不足以判断，直接说明，不要编造内容。

严格输出 JSON 对象，键是 paperId（字符串），值是一条推荐理由字符串。不要输出任何其他文字。

候选：\n${JSON.stringify(payload, null, 1)}` },
  ];

  const r = await callModelWithRetry(messages, { temperature: 0.4, maxTokens: 2600 });
  if (!r.ok) return { ok: false, error: r.error };
  let jsonText = r.content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  if (start >= 0 && end > start) jsonText = jsonText.slice(start, end + 1);
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { return { ok: false, error: 'AI 返回的推荐理由不是合法 JSON: ' + e.message }; }
  return { ok: true, reasons: obj, model: r.model || s.aiModel };
}

module.exports = {
  interpret, listInterpretations, deleteInterpretation,
  isConfigured, apiKey, isLocalEndpoint, buildEvidence, ruleBasedSummary, briefReasons,
  validateGrounding, callModel, callModelWithRetry, systemPrompt, MODES,
  snapshotMaterials, getMaterialsForInterpretation, getMaterial,
};
