/* 科研文献阅读工作台 —— 前端（原生 JS，无构建步骤） */
'use strict';

/* ============================== 基础工具 ============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function attr(s) { return esc(s).replace(/\n/g, ' '); }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body && !(opts.body instanceof Uint8Array)
      ? { 'Content-Type': 'application/json' }
      : (opts.headers || {}),
    body: opts.body instanceof Uint8Array ? opts.body
      : (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  let data = null;
  try { data = await res.json(); } catch { data = { ok: false, error: 'HTTP ' + res.status }; }
  if (!res.ok && data && !data.error) data.error = 'HTTP ' + res.status;
  return data;
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, isErr ? 5200 : 3000);
}

function openModal(html) {
  $('#modalBox').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/* ------------------------------------------------------------------
 * 时间显示（统一北京时间）
 *
 * 数据库与接口一律用带时区的 ISO UTC（结尾 Z）。但老库里的值来自
 * SQLite 的 datetime('now')，形状是「2026-09-27 19:10:03」——**不带时区标记**。
 * 而 new Date('2026-09-27 19:10:03') 按规范会把它当**本地时间**解析，
 * 于是同一时刻在「刚生成」和「刷新后」两条渲染路径上差了 8 小时。
 *
 * 所以这里统一入口：自己解析，不带时区的「日期+时刻」按 UTC 处理。
 * 纯日期（出版日）不做换算，也不补时间。
 * ------------------------------------------------------------------ */
const TZ_NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const TZ_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TZ_ZONED = /(Z|[+-]\d{2}:?\d{2})$/i;

/** 解析为 Date；不带时区标记的「日期+时刻」按 UTC 解释 */
function parseTime(d) {
  if (d == null || d === '') return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d;
  if (typeof d === 'number') { const x = new Date(d); return Number.isNaN(x.getTime()) ? null : x; }
  const s = String(d).trim();
  if (!s) return null;
  if (TZ_DATE_ONLY.test(s)) { const x = new Date(s + 'T00:00:00Z'); return Number.isNaN(x.getTime()) ? null : x; }
  if (TZ_NAIVE.test(s) && !TZ_ZONED.test(s)) {
    const x = new Date(s.replace(' ', 'T') + 'Z');
    return Number.isNaN(x.getTime()) ? null : x;
  }
  const x = new Date(s);
  return Number.isNaN(x.getTime()) ? null : x;
}

/** 北京时间的日期（YYYY-MM-DD）；纯日期原样返回，避免出版日被时区挪一天 */
// 精度不足的日期：只有年或只有年月
const TZ_PARTIAL_DATE = /^\d{4}(-\d{2})?$/;
function fmtDate(d) {
  if (!d) return '—';
  const raw = String(d).trim();
  if (TZ_DATE_ONLY.test(raw)) return raw.slice(0, 10);
  /*
   * 精度不足就按原精度显示：只有年显示「2026」，只有年月显示「2026-09」，
   * **不要补日**。new Date('2026') → 2026-01-01、new Date('2026-09') → 2026-09-01，
   * 会在页面上凭空长出一个「1 日」——我们知道多少就显示多少。
   */
  if (TZ_PARTIAL_DATE.test(raw)) return raw;
  const x = parseTime(d);
  if (!x) return String(d).slice(0, 10);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(x).replace(/\//g, '-');
}

/* ------------------------------------------------------------------
 * 卷 / 期 / 页的占位符清理
 *
 * 上游元数据里会出现字面量占位符——真实遇到的是 Crossref 返回
 * `page: "None-None"`（出版商把 Python 的 None 格式化进了元数据）。
 * 这类值不能显示给用户，也不能被当成真实页码。
 * 只识别「整段就是占位符」或「以 - 相连的每一段都是占位符」，
 * `134` / `1-21` / `e12345` / `S1-S10` 一律原样保留。
 * ------------------------------------------------------------------ */
const BIB_PLACEHOLDER = /^(none|null|nil|nan|undefined|n\/?a|na|unknown|-+|—+|–+|\?+|\.+)$/i;
function cleanBibValue(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  if (BIB_PLACEHOLDER.test(s)) return '';
  if (/[-–—/]/.test(s)) {
    const parts = s.split(/\s*[-–—/]\s*/).map((x) => x.trim());
    const keep = parts.filter((x) => x && !BIB_PLACEHOLDER.test(x));
    if (!keep.length) return '';
    if (keep.length === parts.length) return s;
    return keep.join('-');
  }
  return s;
}

/** 卡片上的卷/期信息：缺哪一项就省略哪一项，绝不显示占位符 */
function bibLine(it) {
  const vol = cleanBibValue(it && it.volume);
  const iss = cleanBibValue(it && it.issue);
  const pg = cleanBibValue(it && it.pages);
  let out = '';
  if (vol) out += ` · 第 ${esc(vol)} 卷`;
  if (iss) out += ` 第 ${esc(iss)} 期`;
  if (pg) out += ` · ${esc(pg)}`;
  return out;
}

/**
 * 详情页的「出版年 / 期」。
 *
 * 问题背景：目录源只给到「年 + 期 + 页码」，没有任何具体出版日。
 * 旧版把 issued_date（"2026"）放进「出版日期」一行，页面显示成「出版日期 2026」，
 * 读者容易当成「2026 年某月某日」；更早还有把 "2026" 渲染成 "2026-01-01" 的缺陷。
 * 现在明确写「出版年 2026 · 第 2 期」，把「具体出版日」单列一行、缺就写「未提供」，
 * 不把年份占位当真实日期；用户手动补充的完整日期优先显示。
 */
function publicationLine(p) {
  const d = (p && p.dates) || {};
  const issued = String(d.issued_date || '').trim();
  const year = /^\d{4}/.test(issued) ? issued.slice(0, 4) : '';
  const issue = cleanBibValue(p && p.issue);
  const vol = cleanBibValue(p && p.volume);
  // 用户手动补充的可信完整日期优先
  if (/^\d{4}-\d{2}-\d{2}$/.test(issued)) return esc(fmtDate(issued));
  const bits = [];
  if (year) bits.push(`出版年 ${esc(year)}`);
  if (vol) bits.push(`第 ${esc(vol)} 卷`);
  if (issue) bits.push(`第 ${esc(issue)} 期`);
  return bits.length ? bits.join(' · ') : '<span class="muted">未提供</span>';
}

/**
 * 详情页的「卷 / 期 / 页」——每一项都带自己的标签，缺哪项就省略哪项。
 *
 * 旧版只是把非空值用 " / " 连起来，卷为空时就成了「2 / 268-286」，
 * 读者不知道那个 2 是期号还是别的什么。
 */
function bibDetail(p) {
  const vol = cleanBibValue(p && p.volume);
  const iss = cleanBibValue(p && p.issue);
  const pg = cleanBibValue(p && p.pages);
  const bits = [];
  // 注意：调用处会再 esc() 一次，这里返回纯文本，不要自己转义（否则双重转义）
  if (vol) bits.push(`第 ${vol} 卷`);
  if (iss) bits.push(`第 ${iss} 期`);
  if (pg) bits.push(`页 ${pg}`);
  return bits.join(' · ');
}
/*
 * 北京时间的日期+时刻
 *
 * 注意：上面这一段的结束标记。tests 会按
 * `const BIB_PLACEHOLDER =` → `/** 卡片上的卷/期信息` → 本注释
 * 三段定位并抽取卷/期/页与时间函数来跑真实实现，
 * 因此**本注释不要删除或改字**，否则相关测试会定位失败。
 */
function fmtDateTime(d) {
  if (!d) return '—';
  const x = parseTime(d);
  if (!x) return String(d);
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(x);
  } catch { return String(d); }
}

/** 北京时间 + 显式标注，用于容易误读的时刻 */
function fmtBeijing(d) {
  const s = fmtDateTime(d);
  return s === '—' ? s : s + '（北京时间）';
}
/** 阅读状态文案：unread=待读 / reading=在读 / read=已读（三态不能混） */
function readStateLabel(st) {
  return { unread: '待读', reading: '在读', read: '已读' }[st] || '待读';
}

/**
 * 语种标签。
 * 注意：**不把「不是中文」显示成英文**。语种没判定出来就说「语种待确认」，
 * 判成其他语种就显示具体语种（如印尼语），而不是一律「语言未定」。
 */
const LANG_LABELS = { zh: '中文', en: '英文', id: '印尼语', other: '其他语种', unknown: '语种待确认' };
function langLabelOf(l) { return LANG_LABELS[l] || (l ? String(l).toUpperCase() : '语种待确认'); }
function langTag(l) {
  if (l === 'zh') return '<span class="tag zh">中文</span>';
  if (l === 'en') return '<span class="tag en">英文</span>';
  if (l === 'unknown' || !l) return '<span class="tag src" title="自动判定证据不足，可在论文详情页人工确认">语种待确认</span>';
  return `<span class="tag src" title="按题名/来源证据判定的语种">${esc(langLabelOf(l))}</span>`;
}

/** 详情页「语种」一行：显示判定结果 + 来源依据 + 人工纠正入口 */
function languageCellHtml(li) {
  if (!li) return '<span class="muted">—</span>';
  const src = li.sourceLabel ? `<span class="tiny muted">判定来源：${esc(li.sourceLabel)}</span>` : '';
  const ev = li.evidence ? `<div class="tiny muted">依据：${esc(li.evidence)}</div>` : '';
  const conflict = li.conflict
    ? '<div class="tiny" style="color:#b45309">来源标注与题名证据不一致，已按题名判定。</div>' : '';
  const manual = li.source === 'manual'
    ? '<span class="tag elig">人工确认</span>' : '';
  const autoRestore = li.auto
    ? `<button class="btn ghost small" onclick="clearPaperLanguage(${state.currentPaper ? state.currentPaper.id : 0})">恢复自动判定</button>` : '';
  return `${langTag(li.language)} ${manual}
    <div class="tiny muted" style="margin-top:4px">${src}</div>
    ${ev}${conflict}
    <div class="btn-row" style="margin-top:7px">
      <select id="langSelect" class="tiny" title="人工纠正这篇论文的语种">
        ${(li.choices || []).map((c) => `<option value="${attr(c.code)}"${c.code === li.language ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
      </select>
      <button class="btn small" onclick="setPaperLanguage(${state.currentPaper ? state.currentPaper.id : 0})">确认语种</button>
      ${autoRestore}
    </div>
    <div class="tiny muted" style="margin-top:4px">人工确认后会记录为「你人工确认」，下次采集不会覆盖。</div>`;
}

async function setPaperLanguage(paperId) {
  const sel = $('#langSelect');
  if (!sel || !paperId) return;
  const r = await api('/api/language/' + paperId, { method: 'POST', body: { language: sel.value } });
  if (!r.ok) { toast(r.error || '设置失败', true); return; }
  toast(`已记为人工确认：${r.label}。下次采集不会覆盖。`);
  await viewPaper(paperId);
}

async function clearPaperLanguage(paperId) {
  if (!paperId) return;
  const r = await api('/api/language/' + paperId, { method: 'DELETE' });
  if (!r.ok) { toast(r.error || '无法恢复', true); return; }
  toast(`已恢复为自动判定：${langLabelOf(r.language)}`);
  await viewPaper(paperId);
}
function eligTag(status, basis) {
  if (status === 'eligible' && basis === 'official') return '<span class="verdict eligible">✔ 期刊条件合格</span>';
  if (status === 'eligible') return '<span class="verdict eligible">✔ 期刊条件合格</span>';
  if (status === 'reference') return '<span class="verdict reference">◇ 参考候选</span>';
  if (status === 'excluded') return '<span class="verdict excluded">✕ 已排除</span>';
  return '<span class="verdict pending">? 待核验</span>';
}
/* ==================================================================
   期刊等级色块
   - 色块内必须写明文字等级，不靠颜色单独表意
   - 官方目录已核验 = 实心；非官方参考名录 = 虚线描边；待核验 = 灰虚线
   - 点击/悬停显示目录来源、版次、匹配依据、核验状态
   ================================================================== */

/** 从标签对象推断 CSS 类：等级 + 来源可信度 */
function tierClass(t) {
  const cls = ['tier'];
  const text = String(t.text || '');
  if (t.type === 'jcr') {
    const q = (t.quartiles || []).find((x) => /^Q[1-4]$/.test(x)) || 'unknown';
    cls.push('tier-jcr-' + q.toLowerCase());
  } else if (t.type === 'cas') {
    const z = String(t.zone || '').replace(/[^\d]/g, '') || 'unknown';
    cls.push(['1', '2', '3'].includes(z) ? 'tier-cas-' + z : 'tier-cas-4');
  } else if (t.type === 'cssci') cls.push('tier-cssci');
  else if (t.type === 'cssci_ext') cls.push('tier-cssci-ext');
  else if (t.type === 'cn_core') cls.push('tier-cn-core');
  else if (t.type === 'ssci') cls.push('tier-ssci');
  else if (t.type === 'blacklist') cls.push('tier-blacklist');
  else if (t.type === 'whitelist') cls.push('tier-whitelist');
  else cls.push('tier-ssci');

  // 溯源以显式的 kind 为准（official / reference / pending），不去反推 verified
  if (t.kind === 'reference' || t.reference === true) cls.push('prov-reference');
  else if (t.kind === 'official') cls.push('prov-official');
  else if (t.kind === 'custom') cls.push('prov-official');
  else if (t.verified) cls.push('prov-official');
  else cls.push('prov-pending');

  // 待核验的 JCR 完全没分区时不要用深色冒充分区
  if (t.type === 'jcr' && !t.quartiles) cls.push('tier-jcr-unknown');
  // 只有 ESCI 证据时不要用 JCR 的深色分区色块冒充分区结论
  if (t.onlyEsci) cls.push('tier-jcr-unknown');
  if (text.includes('分区未录入') || text.includes('年份未标')) {
    const i = cls.indexOf('tier-jcr-q1');
    if (i >= 0) cls[i] = 'tier-jcr-unknown';
  }
  return cls.join(' ');
}

/** 悬停提示：目录来源、版次、匹配依据、核验状态 */
function tierTooltip(t) {
  const L = [];
  L.push('等级：' + (t.text || ''));
  if (t.catalog) L.push('目录：' + t.catalog);
  if (t.edition) L.push('版次/年份：' + t.edition);
  if (t.year && !t.edition) L.push('年份：' + t.year);
  if (t.basis) L.push('匹配依据：' + t.basis);
  if (t.source) L.push('来源：' + t.source);
  L.push('核验状态：' + (t.kind === 'reference' || t.reference === true
    ? '参考候选（未经官方核验，不可作为合格依据）'
    : (t.kind === 'official' || t.verified ? '官方目录已核验' : '待核验')));
  if (t.evidenceStatus) L.push('证据状态：' + t.evidenceStatus);
  if (t.screenshotRow) L.push('截图行号：' + t.screenshotRow);
  if (t.jif) L.push('2025 JIF：' + t.jif);
  if (t.sourceUrl) L.push('来源网址：' + t.sourceUrl);
  return L.join('\n');
}

/** 来源可信度标记 */
function provMark(t) {
  if (t.kind === 'reference' || t.reference === true) return '<span class="tier-mark" aria-hidden="true">◇</span>';
  if (t.kind === 'official' || t.verified) return '<span class="tier-mark" aria-hidden="true">✔</span>';
  return '<span class="tier-mark" aria-hidden="true">?</span>';
}

function journalTagHtml(t) {
  const aria = (t.reference === true ? '参考名录，' : (t.verified ? '官方目录已核验，' : '待核验，')) + (t.text || '');
  return `<span class="${tierClass(t)}" title="${attr(tierTooltip(t))}" aria-label="${attr(aria)}" tabindex="0">`
    + provMark(t) + `<span>${esc(t.text)}</span></span>`;
}

/** 资格结论行 */
function verdictHtml(status, basis) {
  if (status === 'eligible' && basis === 'official') {
    return '<span class="verdict eligible">✔ 期刊条件合格（官方目录）</span>';
  }
  if (status === 'eligible') return '<span class="verdict eligible">✔ 期刊条件合格</span>';
  if (status === 'reference') {
    return '<span class="verdict reference">◇ 参考候选（非官方名录，不计入合格）</span>';
  }
  if (status === 'excluded') return '<span class="verdict excluded">✕ 已排除</span>';
  return '<span class="verdict pending">? 待核验</span>';
}

/** 期刊信息块：JCR 与中科院分行显示，不合并为「综合等级」 */
function journalBoxHtml(journal) {
  if (!journal) return '';
  const tags = journal.tags || [];
  const jcrTags = tags.filter((t) => t.type === 'jcr' || t.type === 'ssci');
  const casTags = tags.filter((t) => t.type === 'cas');
  const cnTags = tags.filter((t) => ['cssci', 'cssci_ext', 'cn_core'].includes(t.type));
  const otherTags = tags.filter((t) => ['whitelist', 'blacklist'].includes(t.type));

  const row = (label, items) => items.length
    ? `<div class="tier-row"><span class="tier-label">${esc(label)}</span><span class="tags">${items.map(journalTagHtml).join('')}</span></div>`
    : '';

  const noTier = !jcrTags.length && !casTags.length && !cnTags.length;
  return `<div class="journal-box">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
      <div><b>${esc(journal.name || '期刊未识别')}</b>
        ${journal.issn ? `<span class="mono tiny muted">${esc(journal.issn)}</span>` : ''}</div>
      ${verdictHtml(journal.status, journal.basis)}
    </div>
    <div class="tier-rows">
      ${row('JCR 分区', jcrTags)}
      ${row('中科院分区', casTags)}
      ${row('中文目录', cnTags)}
      ${row('其他标记', otherTags)}
      ${noTier ? '<div class="tier-row"><span class="verdict pending">? 无任何目录记录，无法核实收录与分区</span></div>' : ''}
    </div>
    <div class="tiny muted" style="margin-top:8px">${esc(journal.note || '')}</div>
  </div>`;
}

/** 色块图例（设置页与期刊页用） */
function tierLegendHtml() {
  const items = [
    ['tier tier-jcr-q1 prov-official', 'JCR Q1（官方目录）'],
    ['tier tier-jcr-q2 prov-official', 'JCR Q2'],
    ['tier tier-jcr-q3 prov-official', 'JCR Q3'],
    ['tier tier-jcr-q4 prov-official', 'JCR Q4'],
    ['tier tier-cas-1 prov-official', '中科院 1 区'],
    ['tier tier-cas-2 prov-official', '中科院 2 区'],
    ['tier tier-cas-3 prov-official', '中科院 3 区'],
    ['tier tier-cssci prov-official', 'CSSCI 来源期刊'],
    ['tier tier-cssci-ext prov-official', 'CSSCI 扩展版'],
    ['tier tier-cn-core prov-official', '北大核心'],
    ['tier tier-jcr-q1 prov-reference', '参考名录（非官方，不计入合格）'],
    ['tier tier-jcr-q4 prov-pending', '待核验'],
  ];
  return `<div class="tier-legend">${items.map(([c, label]) =>
    `<div class="tier-legend-item"><span class="${c}">${esc(label.split('（')[0])}</span><span class="tiny muted">${esc(label)}</span></div>`).join('')}</div>`;
}

/* ==================================================================
   引用编号渲染
   规则（对应实测反馈）：
     · 有材料快照 ⇒ 渲染成可点击按钮，点开能看到生成当时的原文片段；
     · 没有快照的旧解读 ⇒ 渲染成不可点击样式，并在正文旁直接说明
       「旧解读无可回溯材料，重新生成后可用」，不能等到点开才告知；
     · [S1–S6] 这类范围写法必须规范化：若能逐个对上快照编号，
       展开为可核验编号；否则明确标为「未核验范围引用」，不留貌似有效的引用。
   ================================================================== */

/**
 * 取当前正在渲染的解读上下文。
 *
 * 为什么从 DOM 读而不是用全局变量：一个页面会同时渲染多条解读记录，
 * 全局变量会被后一条覆盖，导致第一条的 [S1] 用错上下文
 * （历史记录里的旧解读甚至会被误判成可点）。渲染时给容器打上
 * data-interp-id / data-has-snapshot / data-known-sids，逐条读取即可。
 */
function citeContext() {
  const host = state._citingHost || null;
  if (!host) return { interpId: null, clickable: false, known: new Set() };
  const known = String(host.dataset.knownSids || '').split(',').filter(Boolean);
  return {
    interpId: host.dataset.interpId || null,
    clickable: host.dataset.hasSnapshot === '1',
    known: new Set(known),
  };
}

function renderCitation(tag) {
  const sid = tag.slice(1, -1);
  const ctx = citeContext();
  const known = ctx.known.size ? ctx.known.has(sid) : true;
  if (!ctx.clickable || !known) {
    const why = !ctx.clickable
      ? '旧解读没有材料快照，编号无法回溯'
      : `快照里没有 ${sid}，该编号未能核验`;
    return `<span class="cite cite-dead" title="${attr(why)}">[${esc(sid)}]</span>`;
  }
  return `<button type="button" class="cite cite-btn" data-sid="${attr(sid)}" `
    + `onclick="showEvidence(${ctx.interpId},'${attr(sid)}')" title="查看这条编号对应的原文片段">[${esc(sid)}]</button>`;
}

function renderCitationRange(tag) {
  const m = tag.match(/\[S(\d+)\s*[–—~-]\s*S(\d+)\]/);
  if (!m) return esc(tag);
  const a = Number(m[1]); const b = Number(m[2]);
  const ctx = citeContext();
  const ids = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b) && ids.length < 40; i++) ids.push('S' + i);
  const allKnown = ctx.known.size ? ids.every((x) => ctx.known.has(x)) : true;
  if (ctx.clickable && allKnown) {
    // 能逐个对上 ⇒ 展开为可核验编号
    return ids.map((sid) => renderCitation(`[${sid}]`)).join('')
      + `<span class="cite-note" title="原文写作范围形式，已按材料快照逐个展开">（范围已展开核验）</span>`;
  }
  return `<span class="cite cite-bad" title="这是一个范围写法，无法对应到具体材料快照">`
    + `[${esc('S' + a + '–S' + b)}] 未核验范围引用</span>`;
}

/** 极简 Markdown 渲染：标题、列表、粗体、行内代码、引用、分隔线、[Sn] 引用角标 */
function renderMarkdown(md, hostEl) {
  const prevHost = state._citingHost;
  if (hostEl) state._citingHost = hostEl;
  try {
    return renderMarkdownInner(md);
  } finally {
    state._citingHost = prevHost;
  }
}

function renderMarkdownInner(md) {
  const lines = String(md || '').split('\n');
  let out = '', inUl = false, inOl = false;
  const closeLists = () => {
    if (inUl) { out += '</ul>'; inUl = false; }
    if (inOl) { out += '</ol>'; inOl = false; }
  };
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/（引用编号无效，已移除）/g, '<span class="cite-bad">（引用编号无效，已移除）</span>')
    .replace(/\[S\d+\s*[–—~-]\s*S\d+\]/g, (m) => renderCitationRange(m))
    .replace(/\[S\d+\]/g, (m) => renderCitation(m));
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeLists(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { closeLists(); const lv = Math.min(m[1].length + 1, 4); out += `<h${lv}>${inline(m[2])}</h${lv}>`; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { closeLists(); out += '<hr>'; continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { if (!inUl) { closeLists(); out += '<ul>'; inUl = true; } out += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+[.、)]\s+(.*)$/))) { if (!inOl) { closeLists(); out += '<ol>'; inOl = true; } out += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { closeLists(); out += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    closeLists();
    out += `<p>${inline(line)}</p>`;
  }
  closeLists();
  return out;
}

/* ============================== 应用状态 ============================== */

const state = {
  view: 'brief', config: null, topics: [], currentPaper: null,
  // 最近一次生成的解读结果：整页重绘（重新解读/删除）后用它把「本次结果」恢复回来
  lastInterpResult: null,
  // 当前论文的语种判定信息（来源 / 依据 / 人工纠正）
  languageInfo: null,
  // 当前列表里每张卡片的完整数据（译文懒加载时按 id 取回字段状态）
  trItems: new Map(),
};

async function refreshFoot() {
  const h = await api('/api/health');
  if (!h.ok) return;
  state.health = h;
  const s = h.stats || {};
  $('#footStats').innerHTML =
    `论文 <b>${s.papers || 0}</b> 篇 · 合格 <b>${s.eligiblePapers || 0}</b> · 待核验 <b>${s.pendingPapers || 0}</b><br>
     收藏 <b>${s.starred || 0}</b> · 解读 <b>${s.interpretations || 0}</b><br>
     <span class="tiny">下次更新 ${esc(fmtBeijing(h.scheduler?.nextAt))}</span>`;
}


/* ==================================================================
   视图：今日发现（首页）
   目标：打开就看到值得读的论文；主题优先，期刊等级做筛选；
        即使没有官方合格论文也照常展示，并明确标注状态。
   ================================================================== */

const discoveryState = {
  page: 1, pageSize: 50, journalFilter: 'all', language: '', topic: '', q: '', days: '',
  items: [], total: 0, hasMore: false, counts: null, loading: false,
};

let discoveryRequestVersion=0;
async function viewDiscovery(reset = true) {
  const version=++discoveryRequestVersion;
  const main = $('#main');
  if (reset) {
    discoveryState.page = 1;
    discoveryState.items = [];
    if(!$('#dList'))main.innerHTML = '<div class="loading">正在按你的研究主题发现论文…</div>';
    else main.setAttribute('aria-busy','true');
  }

  const qs = new URLSearchParams({
    page: String(discoveryState.page),
    pageSize: String(discoveryState.pageSize),
    journalFilter: discoveryState.journalFilter,
  });
  // 'all' 表示「全部语种」，用 languageScope 传递；其余按单一语言精确筛
  if (discoveryState.language === 'all') qs.set('languageScope', 'all');
  else if (discoveryState.language) qs.set('language', discoveryState.language);
  if (discoveryState.topic) qs.set('topic', discoveryState.topic);
  if (discoveryState.q) qs.set('q', discoveryState.q);
  if (discoveryState.days) qs.set('days', discoveryState.days);

  const d = await api('/api/desk/discovery?' + qs.toString());
  if(version!==discoveryRequestVersion || state.view!=='discovery')return;
  main.removeAttribute('aria-busy');
  if (!d.ok) { main.innerHTML = `<div class="banner danger">${esc(d.error || '读取失败')}</div>`; return; }

  discoveryState.total = d.total;
  discoveryState.hasMore = d.hasMore;
  discoveryState.counts = d.counts;
  discoveryState.items = reset ? d.items : discoveryState.items.concat(d.items);

  if (reset) {
    main.innerHTML = discoveryShell(d);
  }
  renderDiscoveryList(d);
  // 译文：缓存已有的直接显示；缺的先只处理首屏几张，其余滚动到可见再生成
  indexTrItems(d.items);
  if (reset) warmTranslations(d.items, 3);
}

function discoveryShell(d) {
  const c = d.counts || {};
  const opt = (v, label, cur) => `<option value="${attr(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(label)}</option>`;
  return `
    <div class="page-head">
      <div>
        <h1>今日发现</h1>
        <div class="page-sub">按 ${d.topics.length} 个研究主题发现与排序 · 期刊等级是筛选条件而非排序依据 · 窗口 ${d.windowDays} 天</div>
      </div>
      <div class="btn-row">
        <button class="btn" onclick="go('qualified')">期刊条件合格精选</button>
        <button class="btn" onclick="runFullUpdate(this)">立即采集更新</button>
      </div>
    </div>

    <div class="compact-bar">
      <span class="cb-item" title="本次视图范围内的主题相关候选，不等于已确认可读全文">${esc(c.scopeLabel || c.labels?.total || '主题候选')} <b>${d.total}</b></span>
      ${c.outsideHint ? `
      <span class="cb-sep">·</span>
      <span class="cb-item cb-others" title="${attr(c.outsideHint.variant === 'default' ? '这些论文不在上面的数字里，点「查看全部语种」可以看到' : '这些论文已经包含在上面的数字里')}">${esc(c.outsideHint.text)}
        ${c.outsideHint.showAll
          ? `<button type="button" class="btn ghost small cb-link" onclick="showAllLanguages()">查看全部语种</button>`
          : ''}
      </span>` : ''}
      <span class="cb-sep">·</span>
      <span class="cb-item">今天首次发现 <b>${c.new || 0}</b></span>
      <span class="cb-sep">·</span>
      <span class="cb-item">近期未推荐 <b>${c.catchup || 0}</b></span>
      <span class="cb-sep">·</span>
      <span class="cb-item">已进过简报 <b>${c.shown || 0}</b></span>
      <span class="cb-sep">·</span>
      <span class="cb-item" title="主题匹配概念，与「北大核心」期刊等级无关">${esc(c.labels?.core || '主题核心')} <b>${c.core || 0}</b></span>
      <span class="cb-sep">·</span>
      <span class="cb-item">${esc(c.labels?.crossDomain || '跨领域参考')} <b>${c.crossDomain || 0}</b></span>
      ${c.mutedExcluded ? `<span class="cb-sep">·</span><span class="cb-item">已隐藏 <b>${c.mutedExcluded}</b></span>` : ''}
      <span class="right"></span>
    </div>
    <div id="scopeNoteWrap">${collapsePanel({
      id: 'scope-note',
      title: '口径说明',
      headClass: 'collapse-head compact',
      bodyHtml: `<div class="banner info small" style="margin:0">
        ${d.languageScope === 'zh-en'
          ? `<b>默认视图口径</b>：本页默认<b>只显示已判定为中文或英文</b>的论文——这是你的每日优先阅读范围。
          其他语种与「语种待确认」<b>不会被删除或丢弃</b>，把上面的「语言」切到「全部语种」或具体语种即可查看。
          默认视图里的每一篇都<u>只有</u>中文或英文判定，不会把待确认的语种算作英文。
          ${c.outsideDefaultScope ? `<br>当前窗口内另有 <b>${c.outsideDefaultScope}</b> 篇非中英文或语种待确认的候选<b>未显示在本页</b>（不在上面的数字里）。` : ''}`
          : `<b>当前不是默认视图</b>：你正在看 <b>${esc(c.scopeLabel || '全部语种')}</b>。
          ${d.languageScope === 'all'
            ? `其他语种与「语种待确认」的 <b>${c.outsideDefaultScope || 0}</b> 篇<b>已经包含在上面 ${d.total} 篇里</b>，不是额外的篇数。`
            : `上面的数字<b>只是该语种</b>；其他语种请切到「全部语种」查看。`}
          默认视图（只显示已判定为中文或英文，即你的每日优先阅读范围）可把「语言」切回「中文+英文（默认）」。`}
        <br><br><b>${esc(c.scopeLabel || c.labels?.total || '主题候选')} ${d.total} 篇</b>（当前视图范围）= 30 天窗口内的<b>主题相关候选</b>。
        这个数字<b>不代表已确认能读到全文</b>：其中多数只有题录与摘要，
        是否存在全文要在详情页看，或由你自己获取。有摘要 ≠ 有全文。
        <br>· <b>三种状态严格区分、数字相加等于主题候选总数</b>：${esc(c.basis || '')}
        <br>· <b>${esc(c.labels?.new || '今天首次发现')}</b>：工作台今天首次采集到；
        · <b>${esc(c.labels?.catchup || '近期发现且尚未推荐')}</b>：更早采集到、从未在任何简报里推荐过；
        · <b>${esc(c.labels?.shown || '已进过简报')}</b>：已经在某次简报里推荐过。
        ${(c.core !== undefined) ? `<br>· <b>${esc(c.labels?.core || '主题核心')} ${c.core}</b>：命中了本工作台研究主题、且带有本领域（语言教育 / 应用语言学等）证据的论文。
        <b>这是主题匹配的结果，与「北大核心」期刊等级完全无关</b>——期刊是否合格请看「期刊条件合格精选」页。
        <br>· <b>${esc(c.labels?.crossDomain || '跨领域参考')} ${c.crossDomain}</b>：命中了主题词、但缺少本领域证据的论文，单列并排在主题核心之后，只在方法层面可能值得参考。` : ''}
      </div>`,
      bodyStyle: 'margin-bottom:10px',
    })}</div>

    <div class="card" id="filterCard">
      ${collapsePanel({
        id: 'filter-panel',
        title: '筛选与搜索',
        open: hasActiveFilter(),
        headStyle: 'padding:2px 0',
        extra: '<span class="tiny muted" id="filterSummary"></span>',
        bodyHtml: `
      <div class="grid-3">
        <label class="field"><span>期刊等级</span>
          <select id="dFilter" onchange="applyDiscoveryFilter()">
            ${(d.journalFilters || []).map((f) => opt(f.key, f.label, discoveryState.journalFilter)).join('')}
          </select>
          <div class="help">「仅官方目录合格」只看已核验的；参考候选与待核验也可以单独筛出来读。</div>
        </label>
        <label class="field"><span>语言</span>
          <select id="dLang" onchange="applyDiscoveryFilter()">
            ${opt('', '中文+英文（默认）', discoveryState.language)}${opt('all', '全部语种', discoveryState.language)}${opt('zh', '仅中文', discoveryState.language)}${opt('en', '仅英文', discoveryState.language)}${opt('id', '印尼语', discoveryState.language)}${opt('other', '其他语种', discoveryState.language)}${opt('unknown', '语种待确认', discoveryState.language)}
          </select>
          <div class="help"><b>默认只显示已判定为中文或英文</b>的论文（你的每日优先阅读范围）。
            其他语种与「语种待确认」不会被删除，选「全部语种」或对应语种即可查看。
            「仅英文」只含<b>确实判定为英文</b>的论文，语种待确认不会被算作英文。</div>
        </label>
        <label class="field"><span>研究主题</span>
          <select id="dTopic" onchange="applyDiscoveryFilter()">
            ${opt('', '全部主题', discoveryState.topic)}
            ${(d.topics || []).map((t) => opt(t.slug, t.name, discoveryState.topic)).join('')}
          </select>
        </label>
        <label class="field"><span>时间窗口</span>
          <select id="dDays" onchange="applyDiscoveryFilter()">
            ${opt('', `最近 ${d.windowDays} 天（默认）`, discoveryState.days)}
            ${opt('7', '最近 7 天', discoveryState.days)}
            ${opt('30', '最近 30 天', discoveryState.days)}
            ${opt('90', '最近 90 天', discoveryState.days)}
          </select>
        </label>
      </div>
      <label class="field"><span>在题目 / 摘要 / 期刊 / 关键词里搜索</span>
        <input type="text" id="dQ" value="${attr(discoveryState.q)}" placeholder="输入后回车" onkeydown="if(event.key==='Enter')applyDiscoveryFilter()">
      </label>
      <div class="btn-row">
        <button class="btn small" onclick="applyDiscoveryFilter()">应用筛选</button>
        <button class="btn small" onclick="resetDiscoveryFilter()">清空筛选</button>
        <span class="muted small" id="dCount"></span>
      </div>
      ${(d.counts?.byTopic && Object.keys(d.counts.byTopic).length) ? `<div class="tiny muted" style="margin-top:8px">
        主题分布：${Object.entries(d.counts.byTopic).map(([k, v]) => {
          const t = (d.topics || []).find((x) => x.slug === k);
          return esc(t ? t.name : k) + ' ' + v;
        }).join('　·　')}
      </div>` : ''}`,
      })}
    </div>

    ${d.note ? `<div class="banner warn">${esc(d.note)}</div>` : ''}
    <div id="dList" class="section"></div>
    <div id="dMore" class="section"></div>
  `;
}

/** 是否有已应用的筛选（用于决定筛选面板默认是否展开） */
function hasActiveFilter() {
  return Boolean(discoveryState.language || discoveryState.topic || discoveryState.q
    || discoveryState.days || (discoveryState.journalFilter && discoveryState.journalFilter !== 'all'));
}

/**
 * 统计条上的「查看全部语种」直通动作。
 * 效果与把「语言」下拉切到「全部语种」完全一致，只是少一次点击——
 * 这样「默认视图排除了其他语种」这件事，在不展开任何折叠面板时也可见、可操作。
 */
function showAllLanguages() {
  discoveryState.language = 'all';
  discoveryState.page = 1;
  const sel = $('#dLang');
  if (sel) sel.value = 'all';
  viewDiscovery(true);
}

function applyDiscoveryFilter() {
  discoveryState.journalFilter = $('#dFilter') ? $('#dFilter').value : 'all';
  discoveryState.language = $('#dLang') ? $('#dLang').value : '';
  discoveryState.topic = $('#dTopic') ? $('#dTopic').value : '';
  discoveryState.days = $('#dDays') ? $('#dDays').value : '';
  discoveryState.q = $('#dQ') ? $('#dQ').value.trim() : '';
  viewDiscovery(true);
}

function resetDiscoveryFilter() {
  discoveryState.journalFilter = 'all';
  discoveryState.language = '';
  discoveryState.topic = '';
  discoveryState.days = '';
  discoveryState.q = '';
  viewDiscovery(true);
}

function renderDiscoveryList(d) {
  const box = $('#dList');
  if (!box) return;
  const cnt = $('#dCount');
  if (cnt) cnt.textContent = `当前筛选：${d.total} 篇，已显示 ${discoveryState.items.length} 篇`;
  const fs = $('#filterSummary');
  if (fs) {
    const bits = [];
    const f = (d.journalFilters || []).find((x) => x.key === discoveryState.journalFilter);
    if (f && f.key !== 'all') bits.push(f.label);
      // 语言范围：默认（中英文）/ 全部语种 / 单一语种，三种状态都要写清楚
      if (discoveryState.language === 'all') bits.push('全部语种');
      else if (discoveryState.language) bits.push('仅' + langLabelOf(discoveryState.language));
      else bits.push('默认：中文+英文');
    if (discoveryState.topic) { const t = (d.topics || []).find((x) => x.slug === discoveryState.topic); bits.push(t ? t.name : discoveryState.topic); }
    if (discoveryState.q) bits.push('含「' + discoveryState.q + '」');
    fs.textContent = bits.length ? '（' + bits.join(' · ') + '）' : '（未筛选）';
  }

  if (!discoveryState.items.length) {
    box.innerHTML = `<div class="empty">当前筛选条件下没有主题相关的论文。
      <div class="vsmall" style="margin-top:8px">可尝试：放宽「期刊等级」到「全部（含待核验）」、扩大时间窗口，或到「主题与检索词」补充检索词后点「立即采集更新」。</div>
    </div>`;
    $('#dMore').innerHTML = '';
    return;
  }

  box.innerHTML = `<div class="section-head"><h2>值得一看</h2>
    <span class="muted small">默认 ${discoveryState.pageSize} 篇一页，继续浏览会自动追加 · 译文按需生成</span></div>`
    + discoveryState.items.map(discoveryCardHtml).join('');

  $('#dMore').innerHTML = d.hasMore
    ? `<div class="btn-row" style="justify-content:center">
         <button class="btn primary" onclick="loadMoreDiscovery(this)">继续浏览更多（还有 ${d.total - discoveryState.items.length} 篇）</button>
       </div>`
    : `<div class="muted small" style="text-align:center">已显示全部 ${discoveryState.items.length} 篇</div>`;
}

/** 把列表条目登记到译文懒加载索引（供 requestTranslations 按 id 取字段状态） */
function indexTrItems(items) {
  for (const it of items || []) if (it && it.id) state.trItems.set(it.id, it);
}

async function loadMoreDiscovery(btn) {
  if (discoveryState.loading) return;
  discoveryState.loading = true;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>加载中…';
  discoveryState.page += 1;
  const qs = new URLSearchParams({
    page: String(discoveryState.page), pageSize: String(discoveryState.pageSize),
    journalFilter: discoveryState.journalFilter,
  });
  // 'all' 表示「全部语种」，用 languageScope 传递；其余按单一语言精确筛
  if (discoveryState.language === 'all') qs.set('languageScope', 'all');
  else if (discoveryState.language) qs.set('language', discoveryState.language);
  if (discoveryState.topic) qs.set('topic', discoveryState.topic);
  if (discoveryState.q) qs.set('q', discoveryState.q);
  if (discoveryState.days) qs.set('days', discoveryState.days);
  const d = await api('/api/desk/discovery?' + qs.toString());
  discoveryState.loading = false;
  if (!d.ok) { discoveryState.page -= 1; toast(d.error, true); btn.disabled = false; btn.textContent = '继续浏览'; return; }
  discoveryState.items = discoveryState.items.concat(d.items);
  discoveryState.hasMore = d.hasMore;
  $('#dList').insertAdjacentHTML('beforeend', d.items.map(discoveryCardHtml).join(''));
  renderDiscoveryList({ ...d, items: discoveryState.items });
  indexTrItems(d.items);
  requestTranslations(d.items.slice(0, 6).map((x) => x.id), { limit: 9 });
  observeTranslationLazy();
}

function judgmentButtonsHtml(p, opts = {}) {
  const d = p.judgment;
  const compact = opts.compact;
  const b = (decision, label, cls) =>
    `<button class="btn small ${d === decision ? 'primary' : ''} ${cls || ''}" onclick="setJudgment(${p.id},'${decision}',this,${opts.reloadView ? "'" + opts.reloadView + "'" : 'null'})">${esc(label)}</button>`;
  return `<span class="judge-group">
    ${b('interested', d === 'interested' ? '★ 已感兴趣' : '☆ 感兴趣')}
    ${b('muted', d === 'muted' ? '✕ 已暂不关注' : '✕ 暂不关注')}
    ${d ? `<button class="btn small ghost" onclick="setJudgment(${p.id},'cleared',this,${opts.reloadView ? "'" + opts.reloadView + "'" : 'null'})">撤销判断</button>` : ''}
  </span>`;
}

/** 发现状态标签：三态必须与计数口径一致 */
function stateTagHtml(it) {
  if (it.kind === 'new') return '<span class="tag elig" title="工作台今天（北京时间）首次采集到">今天首次发现</span>';
  if (it.kind === 'shown') return '<span class="tag src" title="已经在某次简报里推荐过">已进过简报</span>';
  return '<span class="tag src" title="更早采集到，但从未在任何简报里推荐过">近期发现 · 尚未推荐</span>';
}

/** 跨领域方法参考标记 */
function crossDomainHtml(it) {
  if (!it.cross_domain) return '';
  return `<div class="cross-domain-note">
    <span class="tag pending">跨领域方法参考</span>
    <span class="tiny">命中了「${esc((it.cross_domain_topics || []).join('、'))}」的主题词，但缺少语言教育领域证据（${esc(it.cross_domain_reason || '')}）。
    它排在「主题核心」之后，只在方法层面可能值得参考。这里的「核心」指主题匹配，与「北大核心」期刊等级无关。</span>
  </div>`;
}

/* ==================================================================
   卡片阅读层级：篇关摘（原文 → 译文）
   ------------------------------------------------------------------
   用户要求（原文口径）：
     · 卡片首屏突出原文题名、作者、刊名、可信发表时间、醒目的期刊等级/核验状态；
     · 英文论文必须按【英文原题 → 中文译文；原关键词 → 中文译文；英文原摘要 → 中文译文】
       的顺序呈现，首页就能直接看到译文，不需要进详情、也不需要再点翻译；
     · 摘要的原文与译文都**直接完整显示**，不需要展开（用户后续口径）；
     · 没有来源摘要就明确写缺失，绝不让 AI 补写；
     · 作者关键词、OpenAlex 自动提取词、工作台主题标签不得混称。
   实现要点：译文一律来自后端已缓存记录（translations 表），卡片只渲染缓存；
   缺译文时按可见范围分批懒加载（/api/translate/batch），失败保留原文并可重试。
   ================================================================== */

/** 某字段的译文状态对象（来自后端 translations，未命中缓存则 status='missing'） */
function trField(it, field) {
  const t = it && it.translations;
  return (t && t[field]) || null;
}

/** 已缓存的译文文本（没有就返回 null，绝不返回空字符串冒充译文） */
function trText(it, field) {
  const f = trField(it, field);
  return f && f.available && f.text ? f.text : null;
}

/** 关键词来源的真实说法：作者关键词 / OpenAlex 提取词 / 学科标签，绝不混称 */
function kwSourceLabel(src) {
  if (src === 'imported' || src === 'imported:cnki') return '作者关键词（题录导入）';
  if (src === 'openalex') return 'OpenAlex 自动提取词，不是作者关键词';
  if (src === 'semanticscholar:fieldsOfStudy') return 'Semantic Scholar 学科标签，不是作者关键词';
  if (src) return `关键词来源：${src}`;
  return '来源未标注关键词出处';
}

/**
 * 译文状态角标。
 * 四种状态必须能区分：已生成 / 生成中 / 失败可重试 / 未配置密钥。
 */
function trBadge(it, field) {
  const f = trField(it, field);
  if (!f || !f.available) return '';
  if (f.text) {
    return `<span class="tr-badge ai" title="译文由 AI 生成，仅供参考；引用请以原文为准">AI 译文</span>`;
  }
  if (f.status === 'failed') {
    return `<button type="button" class="tr-badge err" data-tr-retry="${it.id}" data-tr-field="${attr(field)}" title="${attr(f.error || '翻译失败')}">翻译失败 · 点击重试</button>`;
  }
  if (it.aiConfigured === false) {
    return `<span class="tr-badge off" title="未配置 AI 密钥，无法生成译文；原文照常显示">未配置 AI，暂不能生成译文</span>`;
  }
  return `<span class="tr-badge wait">译文生成中…</span>`;
}

/** 译文行的内部结构：文本 + 角标，便于懒加载后局部更新（不整页重绘） */
function trLineHtml(it, field, opts = {}) {
  const text = trText(it, field);
  const cls = opts.cls || '';
  const view = opts.view || 'full';
  const body = text
    ? esc(text)
    : `<span class="muted">${it.aiConfigured === false ? '未配置 AI 密钥，暂无译文（原文见上）' : '译文生成中…'}</span>`;
  return `<div class="${cls}" data-tr-field="${attr(field)}" data-tr-view="${attr(view)}" data-id="${it.id}"><span class="tr-text">${body}</span> ${trBadge(it, field)}</div>`;
}

/** 卡片上唯一的可信发表时间：有完整在线发表日优先，否则按实际精度显示 */
function pubTimeHtml(it) {
  const p = it && it.pub;
  if (!p || !p.value) {
    return `<span class="pub-time unknown" title="来源没有提供可信的发表日期，工作台不会用「发现日期」冒充发表日">发表时间未提供</span>`;
  }
  const shown = fmtDate(p.value);
  const note = p.precision === 'day' ? '' : '（来源只提供到' + (p.precision === 'month' ? '年月' : '年') + '，未补具体日期）';
  return `<span class="pub-time${p.precision === 'day' ? '' : ' coarse'}" title="${attr(`发表时间来源：${p.kind === 'online' ? '在线发表日期' : (p.kind === 'print' ? '正式出版' : '出版信息')}${note ? '；' + note : ''}`)}">${esc(p.label)} ${esc(shown)}${note ? `<span class="tiny muted">${esc(note)}</span>` : ''}</span>`;
}

/**
 * 作者关键词（原文）+ 关键词译文，来源必须写清楚。
 *
 * 缺关键词时**只留一行**「原文未提供关键词」——
 * 早期版本在这里挂了一整句关于「主题标签不是作者关键词」的解释，
 * 在卡面上过于抢眼。细节已经移到「为何推荐 / 来源详情」里。
 */
function keywordBlockHtml(it) {
  const kw = it.keywords || [];
  if (!kw.length) {
    return `<div class="kw-line">
      <span class="kw-label">作者关键词</span>
      <span class="kw-missing">原文未提供关键词</span>
    </div>`;
  }
  const list = kw.map((k) => esc(typeof k === 'string' ? k : (k && k.name) || '')).filter(Boolean);
  return `<div class="kw-line">
    <div class="kw-row">
      <span class="kw-label">原文关键词</span>
      <span class="kw-orig">${list.join('、')}</span>
      <span class="tiny muted">（${esc(kwSourceLabel(it.keywords_source))}）</span>
    </div>
    ${trLineHtml(it, 'keywords', { cls: 'kw-tr' })}
  </div>`;
}

/**
 * 摘要：原文与译文同卡对应，**两份都直接全部显示，不需要展开**。
 *
 * 用户口径（原话）：「原文摘要和 ai 译文直接全部显示就可以，不用展开原文，直接全部显示」。
 * 因此这里不再做「截断预览 + 展开全文」的折叠：
 *   · 原文摘要在上、AI 译文在下（纵向，桌面宽度也不并排）；
 *   · 两份都是完整正文，不用点任何按钮；
 *   · 译文还没生成时如实显示状态（生成中 / 失败可重试 / 未配置密钥），原文照常完整显示。
 */
function abstractBlockHtml(it, idPrefix) {
  if (!it.abstract) {
    return `<div class="banner warn small abs-missing" style="margin:8px 0 0">
      原始数据未提供摘要：只能依据题名与元数据做有限解读；<b>工作台不会用 AI 补写摘要</b>，摘要译文也不会生成。
    </div>`;
  }
  const tr = trText(it, 'abstract');
  const trBody = tr
    ? esc(tr)
    : `<span class="muted">${it.aiConfigured === false ? '未配置 AI 密钥，未生成摘要译文（原文见上）' : '摘要译文生成中…'}</span>`;
  const colLabel = (text) => `<div class="abs-col-label">${text}</div>`;
  return `<div class="abs-block">
    <div class="abs-full">
      <div class="abs-col">
        ${colLabel(`原文摘要 <span class="tiny muted">（${esc(langLabelOf(it.language))}，${it.abstract_length || (it.abstract || '').length} 字符）</span>`)}
        <p dir="auto" class="abs-text">${esc(it.abstract)}</p>
      </div>
      <div class="abs-col">
        ${colLabel('AI 译文')}
        <p dir="auto" class="abs-text" data-tr-field="abstract" data-tr-view="full" data-id="${it.id}"><span class="tr-text">${trBody}</span> ${trBadge(it, 'abstract')}</p>
      </div>
    </div>
    <div class="tiny muted" style="margin-top:6px">译文由 AI 生成，仅供参考；引用与统计数字请以原文为准。</div>
  </div>`;
}

/**
 * 「为何推荐 / 来源详情」——把**长篇说明与内部诊断**从卡面收进可展开区域。
 *
 * 收进来的东西（用户明确要求「真正移进去」）：
 *   · 完整的推荐理由（卡面只留一句不带小数分数的短理由）
 *   · 期刊核验的详细说明与证据来源（卡面只留状态色块 + 一句短说明）
 *   · 综合分、维度小数、方法线索、被引数、主题命中小数
 *   · 关键词出处/缺失的完整解释
 *   · 采集日期与元数据来源
 */
function diagnosticsHtml(it) {
  const ev = it.topic_evidence || [];
  const dims = it.dimensions || {};
  const groups = [];   // 带小标题的成组内容
  const rows = [];     // 平铺的内部指标

  // 1) 完整推荐理由（卡面只保留一句短理由）
  if (it.reason) {
    groups.push(`<div class="diag-group">
      <div class="diag-group-title">完整推荐理由（规则匹配结果）</div>
      <div class="diag-group-body">${esc(it.reason)}</div>
    </div>`);
  }

  // 2) 期刊核验详情与证据（卡面只保留状态色块 + 一句短说明）
  const vd = verificationDetailHtml(it);
  if (vd) {
    groups.push(`<div class="diag-group">
      <div class="diag-group-title">期刊核验详情与证据</div>
      <div class="diag-group-body">${vd}</div>
    </div>`);
  }

  // 3) 内部排序指标
  if (ev.length) {
    rows.push(`<div>主题命中（检索词命中程度，内部排序用）：${ev.map((e) => `${esc(e.name)} ${e.score}`).join('　')}</div>`);
  }
  if (it.method_signals && it.method_signals.length) {
    rows.push(`<div>方法线索：${esc(it.method_signals.slice(0, 5).join('、'))}</div>`);
  }
  const dimBits = ['topic', 'freshness', 'method', 'value', 'completeness']
    .filter((k) => dims[k] != null)
    .map((k) => `${({ topic: '主题相关', freshness: '新近度', method: '方法信息', value: '研究价值', completeness: '元数据完整' })[k]} ${dims[k]}`);
  if (dimBits.length) rows.push(`<div>维度得分：${dimBits.join('　')}${it.score != null ? `　综合 ${it.score}` : ''}</div>`);
  if (it.citation_count != null) rows.push(`<div>被引：${it.citation_count}（来源数据，仅作参考）</div>`);
  /*
   * 关键词的说明细节放在这里，不占卡面：
   * 卡面上缺关键词只写一行「原文未提供关键词」。
   */
  if (!(it.keywords || []).length) {
    rows.push(`<div>作者关键词：该来源元数据未提供作者关键词。`
      + '工作台的自动主题标签与数据库主题词（如 OpenAlex topics）<b>都不是作者关键词</b>，因此不会显示在关键词位置。</div>');
  } else if (it.keywords_source === 'openalex' || it.keywords_source === 'semanticscholar:fieldsOfStudy') {
    rows.push(`<div>关键词出处：${esc(kwSourceLabel(it.keywords_source))}。`
      + '它们由该来源自动提取，可能与出版商页面上列出的作者关键词不完全一致，请以原文为准。</div>');
  }
  // 来源与采集时间属于可追溯信息，放在这里而不是卡面：
  // 卡面只允许出现一个可信发表时间，「工作台发现日」不是发表日期。
  if (it.discovery_date) rows.push(`<div>工作台首次采集：${esc(fmtDate(it.discovery_date))}（这是采集日期，不是论文发表日期）</div>`);
  if (it.sources && it.sources.length) rows.push(`<div>元数据来源：${esc(it.sources.join('、'))}</div>`);

  if (!groups.length && !rows.length) return '';
  const id = `diag-${it.id}`;
  return `<div class="diag-block">
    <button type="button" class="collapse-head" id="${id}" onclick="toggleCollapse(this)" aria-expanded="false" aria-controls="${id}-body"><span class="collapse-arrow" aria-hidden="true">▸</span><span class="collapse-title">为何推荐 / 来源详情</span></button>
    <div class="collapse-body hidden" id="${id}-body" role="region" aria-labelledby="${id}"><div class="diag-inner">
      ${groups.join('')}
      ${rows.join('')}
      <div class="tiny muted" style="margin-top:5px">这些是工作台的内部排序与诊断指标，不是论文质量结论；期刊等级看上方色块。</div>
    </div></div>
  </div>`;
}

/** 卡面核心主题：最多 2 个，不带小数（今日发现用 topic_evidence，简报用 topics） */
function coreTopicsHtml(it) {
  const ev = (it.topic_evidence && it.topic_evidence.length)
    ? it.topic_evidence.map((e) => ({ name: e.name }))
    : (it.topics || []).map((t) => ({ name: t.name }));
  if (!ev.length) return '';
  return `<div class="topic-evidence">
    <span class="te-label">主题</span>
    ${ev.slice(0, 2).map((e) => `<span class="te-chip">${esc(e.name)}</span>`).join('')}
    ${ev.length > 2 ? `<span class="te-chip muted">等 ${ev.length} 个主题（见「为何推荐」）</span>` : ''}
  </div>`;
}

/* ---------------------- 译文懒加载（分批、可见优先） ---------------------- */

const trLoad = { inflight: 0, unavailable: false, queued: new Set(), pending: [], observer: null };

/** 该卡片还有哪些字段缺译文（只算来源确实提供、且没有缓存文本的字段） */
function missingTrFields(it) {
  const out = [];
  for (const f of ['title', 'keywords', 'abstract']) {
    const x = trField(it, f);
    if (!x || !x.available) continue;
    if (!x.text && x.status !== 'ok') out.push(f);
  }
  return out;
}

/** 把返回的译文写回 DOM（局部更新，不重绘整页） */
function applyTrResults(results) {
  for (const [pid, fields] of Object.entries(results || {})) {
    const id = Number(pid);
    const item = state.trItems.get(id);
    for (const [field, res] of Object.entries(fields || {})) {
      if (!item || !item.translations || !item.translations[field]) continue;
      if (res && res.ok && res.text) {
        item.translations[field].text = res.text;
        item.translations[field].status = 'ok';
        item.translations[field].createdAt = res.createdAt || null;
        item.translations[field].model = res.model || null;
      } else if (res && res.available === false) {
        item.translations[field].available = false;
        item.translations[field].status = 'unavailable';
      } else {
        item.translations[field].status = 'failed';
        item.translations[field].error = (res && res.error) || '翻译失败';
      }
      // 标题/关键词/摘要的预览与全文节点统一刷新
      $$(`[data-tr-field="${field}"][data-id="${id}"]`).forEach((node) => {
        const textEl = node.querySelector('.tr-text');
        if (!textEl) return;
        const fresh = item.translations[field];
        if (fresh.text) {
          textEl.textContent = fresh.text;
          textEl.className = 'tr-text';
        } else if (fresh.available === false) {
          textEl.textContent = '原始数据未提供该字段，无法翻译';
          textEl.className = 'tr-text muted';
        } else {
          textEl.textContent = item.aiConfigured===false ? '未配置 AI，原文照常显示' : fresh.status === 'failed'
            ? '翻译失败，原文已保留'
            : '译文生成中…';
          textEl.className = 'tr-text muted';
        }
        const oldBadge = node.querySelector('.tr-badge');
        if (oldBadge) oldBadge.remove();
        node.insertAdjacentHTML('beforeend', ' ' + trBadge(item, field));
      });
    }
  }
  // 重试按钮：整页只绑定一次（事件委托）
}

/**
 * 按可见范围分批请求译文。
 * 绝不一次性翻译整页/全库：只处理还在队列里的、可见的少量卡片。
 */
function requestTranslations(ids, opts = {}) {
  if(trLoad.unavailable)return;
  const items=[...new Set(ids)].map(id=>state.trItems.get(id)).filter(Boolean);
  // 按字段独立请求与显示；短篇名不再等待长摘要以及整批其余论文。
  for(const field of ['title','keywords','abstract'])for(const it of items){
    if(!missingTrFields(it).includes(field))continue;
    const key=it.id+':'+field+':'+(trField(it,field)?.sourceText||'');
    if(trLoad.queued.has(key))continue;
    trLoad.queued.add(key);trLoad.pending.push({id:it.id,field,key});
  }
  drainTranslationQueue();
}
function drainTranslationQueue(){
  while(trLoad.inflight<4 && trLoad.pending.length && !trLoad.unavailable){
    const task=trLoad.pending.shift();
    if(!document.querySelector(`[data-paper-id="${task.id}"]`)){trLoad.queued.delete(task.key);continue;}
    trLoad.inflight++;
    api('/api/translate/batch',{method:'POST',body:{paperIds:[task.id],fields:[task.field],limit:1}}).then(r=>{
      if(r?.configured===false){
        trLoad.unavailable=true;trLoad.pending=[];
        for(const it of state.trItems.values())it.aiConfigured=false;
        applyTrResults({[task.id]:{[task.field]:{ok:false,error:r.error}}});
      } else if(r?.results)applyTrResults(r.results);
      else applyTrResults({[task.id]:{[task.field]:{ok:false,error:r?.error||'翻译失败，可重试'}}});
    }).catch(e=>applyTrResults({[task.id]:{[task.field]:{ok:false,error:e.message}}}))
      .finally(()=>{trLoad.inflight--;drainTranslationQueue();});
  }
}

/** 滚动到可见时才加载译文：避免打开首页就翻译全部 */
function observeTranslationLazy() {
  if (typeof IntersectionObserver === 'undefined') return;
  if (!trLoad.observer) {
    trLoad.observer = new IntersectionObserver((entries) => {
      const ids = [];
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const id = Number(en.target.getAttribute('data-paper-id'));
        if (id) ids.push(id);
      }
      if (ids.length) requestTranslations(ids, { limit: 9 });
    }, { rootMargin: '200px' });
  }
  $$('[data-paper-id]').forEach((el) => trLoad.observer.observe(el));
}

/** 首屏优先：渲染后先给最前面几张卡片取译文（其余交给滚动懒加载） */
function warmTranslations(items, firstN = 3) {
  const ids = (items || []).slice(0, firstN).map((x) => x.id).filter(Boolean);
  if (ids.length) requestTranslations(ids, { limit: 9 });
  observeTranslationLazy();
}


/**
 * 今日发现卡片。
 *
 * 阅读层级（首屏从上到下）：
 *   1. 状态标签 + 原文题名 + 译文题名
 *   2. 作者 / 刊名 / **唯一的**可信发表时间
 *   3. 期刊等级与核验状态色块（带文字，参考候选绝不显示成官方合格）
 *   4. 核心主题（最多 2 个，不带小数）
 *   5. 作者关键词（原文 → 译文）
 *   6. 摘要（原文在上、译文在下，两份都直接完整显示，不用展开）
 *   7. 链接、操作（收藏 / 不感兴趣 / 详情与 AI 解读），其余收进次级区
 */
function discoveryCardHtml(it) {
  const links = [];
  if (it.doi) links.push(`<a href="https://doi.org/${attr(it.doi)}" target="_blank" rel="noopener">DOI: ${esc(it.doi)}</a>`);
  if (it.url && !it.doi) links.push(`<a href="${attr(it.url)}" target="_blank" rel="noopener">原文链接</a>`);
  if (it.pdf_url) links.push(`<a href="${attr(it.pdf_url)}" target="_blank" rel="noopener">开放全文</a>`);

  const titleTr = trText(it, 'title') || it.title_zh || null;

  return `
  <article class="paper-card${it.cross_domain ? ' cross-domain-card' : ''}" id="dcard-${it.id}" data-paper-id="${it.id}">
    <div class="pc-head">
      <div class="pc-title-block">
        <div class="brief-title">
          ${stateTagHtml(it)}
          <a href="#/paper/${it.id}" onclick="return goPaper(${it.id})">${esc(it.title)}</a>
        </div>
        ${/* 译文行始终渲染：已缓存→显示译文；生成中→「生成中」；未配置密钥→明确说明。
             隐藏它会让人误以为「没有译文」是正常的，而实际是「还没生成」或「缺密钥」。 */ ''}
        <div class="brief-title-zh" data-tr-field="title" data-tr-view="full" data-id="${it.id}"><span class="tr-text">${titleTr ? esc(titleTr) : `<span class="muted">${it.aiConfigured === false ? '未配置 AI 密钥，暂无译文（原文见上）' : '译文生成中…'}</span>`}</span> ${trBadge(it, 'title')}</div>
      </div>
      <div class="pc-actions">
        <button class="btn small ${it.starred ? 'primary' : ''}" onclick="toggleStar(${it.id}, ${it.starred ? 'false' : 'true'}, this)" title="收藏到本地书库">${it.starred ? '★ 已收藏' : '☆ 收藏'}</button>
        <button class="btn small ${it.judgment === 'muted' ? 'primary' : ''}" onclick="setJudgment(${it.id},'${it.judgment === 'muted' ? 'cleared' : 'muted'}',this,'discovery')" title="不进入默认视图（仍可通过筛选查看）">${it.judgment === 'muted' ? '✕ 已不关注' : '✕ 不感兴趣'}</button>
      </div>
    </div>

    <div class="brief-meta">
      ${esc((it.authors || []).slice(0, 5).join('；'))}${(it.authors || []).length > 5 ? ' 等' : ''}<br>
      <b>${esc(it.journal_name || '期刊未识别')}</b>${bibLine(it)}<br>
      ${pubTimeHtml(it)}
    </div>

    <div class="tags" style="margin-bottom:6px">
      ${langTag(it.language)}
      ${eligTag(it.eligibility, it.eligibility_basis)}
      ${(it.journal_tags || []).map(journalTagHtml).join('')}
      ${it.open_access ? `<span class="tag oa">开放获取${it.oa_status ? ' · ' + esc(it.oa_status) : ''}</span>` : ''}
    </div>

    ${crossDomainHtml(it)}
    ${coreTopicsHtml(it)}
    ${keywordBlockHtml(it)}
    ${abstractBlockHtml(it, 'd')}
    ${diagnosticsHtml(it)}

    <div class="brief-meta card-links">${links.join(' · ') || '（无链接）'}</div>

    <div class="btn-row card-actions">
      <button class="btn small primary" onclick="goPaper(${it.id})">进入详情与 AI 解读</button>
      <details class="more-actions">
        <summary class="btn small">更多操作</summary>
        <div class="more-actions-body">
          ${judgmentButtonsHtml(it, { reloadView: 'discovery' })}
          <button class="btn small" onclick="setRead(${it.id},'${it.read_state === 'read' ? 'unread' : 'read'}',this)">${it.read_state === 'read' ? '标为待读' : '标记已读'}</button>
          <button class="btn small" onclick="quickInterpret(${it.id}, this)">快速解读（依据摘要）</button>
        </div>
      </details>
    </div>
  </article>`;
}

/* ==================================================================
   视图：期刊条件合格精选（只含官方目录核验合格的论文）
   ================================================================== */

async function viewQualified() {
  const main = $('#main');
  main.innerHTML = '<div class="loading">正在读取期刊条件合格精选…</div>';
  const d = await api('/api/desk/qualified?pageSize=30');
  if (!d.ok) { main.innerHTML = `<div class="banner danger">${esc(d.error || '')}</div>`; return; }

  main.innerHTML = `
    <div class="page-head">
      <div><h1>期刊条件合格精选</h1>
        <div class="page-sub">只包含期刊已被<strong>官方目录核验</strong>为合格的论文；参考候选与待核验论文不会出现在这里。</div></div>
      <button class="btn" onclick="go('discovery')">← 回到今日发现</button>
    </div>
    ${d.emptyReason ? `<div class="banner warn">${esc(d.emptyReason)}</div>` : ''}
    ${d.total ? '' : emptyQualifiedHtml()}
    <div class="section">${d.items.map(qualifiedCardHtml).join('')}</div>
    ${d.hasMore ? `<div class="btn-row" style="justify-content:center">
      <button class="btn" onclick="loadMoreQualified(this)">继续浏览（还有 ${d.total - d.items.length} 篇）</button></div>` : ''}
  `;
  qualifiedState.page = 1;
  qualifiedState.items = d.items;
}

const qualifiedState = { page: 1, items: [] };

function emptyQualifiedHtml() {
  return [
    '<div class="card">',
    '<h3>想让这里出现论文，需要一张官方目录</h3>',
    '<div class="sep"></div>',
    '<div class="small">',
    '本工作台不会用公众号截图或二手清单冒充官方核验。当前规则是：',
    '<br>· 中文刊：<b>CSSCI 来源期刊</b>或<b>《中文核心期刊要目总览》</b>收录；',
    '<br>· 英文刊：<b>已确认 SSCI 收录</b>，并且 JCR Q1–Q3 或中科院 1–3 区之一。',
    '<br>导入入口：<b>期刊目录与核验</b>。你之前的截图清单已作为「参考候选」导入，可以用它先读论文，但不会计入这里的合格数量。',
    '</div>',
    '<div class="btn-row" style="margin-top:10px"><button class="btn primary" onclick="go(\'journals\')">去导入官方目录</button></div>',
    '</div>',
  ].join('');
}

async function loadMoreQualified(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>加载中…';
  qualifiedState.page += 1;
  const d = await api(`/api/desk/qualified?page=${qualifiedState.page}&pageSize=30`);
  btn.disabled = false; btn.textContent = '继续浏览';
  if (!d.ok) { toast(d.error, true); return; }
  qualifiedState.items = qualifiedState.items.concat(d.items);
  const holder = $('.section');
  if (holder) holder.insertAdjacentHTML('beforeend', d.items.map(qualifiedCardHtml).join(''));
  btn.parentElement.innerHTML = d.hasMore
    ? `<button class="btn" onclick="loadMoreQualified(this)">继续浏览（还有 ${d.total - qualifiedState.items.length} 篇）</button>`
    : `<div class="muted small">已显示全部 ${qualifiedState.items.length} 篇</div>`;
}

function qualifiedCardHtml(it) {
  return `
  <article class="paper-card" style="border-left:3px solid #1a6b3c">
    <div class="pc-head">
      <div class="pc-title-block">
        <div class="brief-title"><a href="#/paper/${it.id}" onclick="return goPaper(${it.id})">${esc(it.title)}</a></div>
        ${it.title_zh ? `<div class="brief-title-zh">${esc(it.title_zh)}</div>` : ''}
      </div>
      <div class="pc-actions">
        <button class="btn small" onclick="toggleStar(${it.id}, true, this)">☆ 收藏</button>
      </div>
    </div>
    <div class="brief-meta">${esc((it.authors || []).slice(0, 5).join('；'))}<br>
      <b>${esc(it.journal_name || '—')}</b>${bibLine(it)}<br>${pubTimeHtml(it)}</div>
    <div class="tags" style="margin-bottom:6px">
      ${langTag(it.language)} ${eligTag(it.eligibility, it.eligibility_basis)}
      ${(it.journal_tags || []).map(journalTagHtml).join('')}
    </div>
    <div class="btn-row" style="margin-top:8px">
      <button class="btn small primary" onclick="goPaper(${it.id})">详情与 AI 解读</button>
    </div>
  </article>`;
}

/* ==================================================================
   视图：阅读判断（感兴趣 / 暂不关注，都可撤销）
   ================================================================== */

async function viewJudgments() {
  const main = $('#main');
  main.innerHTML = '<div class="loading">正在读取你的阅读判断…</div>';
  const d = await api('/api/judgments');
  if (!d.ok) { main.innerHTML = `<div class="banner danger">${esc(d.error || '')}</div>`; return; }

  main.innerHTML = `
    <div class="page-head">
      <div><h1>阅读判断</h1>
        <div class="page-sub">${esc(d.note)}</div></div>
    </div>
    <div class="stat-row card">
      <div class="stat"><b>${d.stats.interested}</b>感兴趣</div>
      <div class="stat"><b>${d.stats.muted}</b>暂不关注</div>
    </div>

    <div class="section">
      <div class="section-head"><h2>感兴趣（${d.interested.length}）</h2>
        <span class="muted small">这里只是「你想读」的清单；收藏是另一个动作，需要你在卡片上单独点收藏</span></div>
      ${d.interested.length ? d.interested.map(judgeRowHtml).join('') : '<div class="empty">还没有标记「感兴趣」的论文。<br><span class="small">在「今日发现」的卡片上点「☆ 感兴趣」即可。</span></div>'}
    </div>

    <div class="section">
      <div class="section-head"><h2>暂不关注（${d.muted.length}）</h2>
        <span class="muted small">这些论文已从「今日发现」隐藏，但随时可以在这里找回</span></div>
      ${d.muted.length ? d.muted.map(judgeRowHtml).join('') : '<div class="empty">没有暂不关注的论文。</div>'}
    </div>
  `;
}

function judgeRowHtml(it) {
  return `
  <div class="paper-card" style="padding:13px 15px">
    <div class="pc-head">
      <div style="min-width:0">
        <div class="brief-title" style="font-size:15px"><a href="#/paper/${it.id}" onclick="return goPaper(${it.id})">${esc(it.title)}</a></div>
        <div class="brief-meta" style="margin:6px 0 0">${esc(it.journal_name || '—')} · ${fmtDate(it.published_online || it.issued_date)} · 判断于 ${esc(fmtDateTime(it.judged_at))}</div>
      </div>
      <div class="pc-actions">${judgmentButtonsHtml({ id: it.id, judgment: it.judgment }, { reloadView: 'judgments' })}</div>
    </div>
    ${it.judgment_note ? `<div class="reason" style="margin-top:8px"><span class="reason-label">你的备注</span>${esc(it.judgment_note)}</div>` : ''}
    <div class="tags" style="margin-top:8px">
      ${langTag(it.language)} ${eligTag(it.eligibility, it.eligibility_basis)}
      ${(it.journal_tags || []).map(journalTagHtml).join('')}
      ${it.starred ? '<span class="tag elig">已收藏</span>' : ''}
      ${it.read_state && it.read_state !== 'none'
        ? `<span class="tag src">${readStateLabel(it.read_state)}</span>` : ''}
    </div>
    <div class="btn-row" style="margin-top:9px">
      <button class="btn small" onclick="goPaper(${it.id})">详情</button>
      ${it.starred ? '' : `<button class="btn small" onclick="toggleStar(${it.id}, true, this)">☆ 收藏</button>`}
      <button class="btn small" onclick="setRead(${it.id},'unread',this)">标为待读</button>
    </div>
  </div>`;
}

async function setJudgment(paperId, decision, btn, reloadView) {
  if (btn) { btn.disabled = true; }
  const r = await api('/api/judgments/' + paperId, { method: 'POST', body: { decision, source: state.view } });
  if (btn) { btn.disabled = false; }
  if (!r.ok) { toast(r.error, true); return; }
  toast(decision === 'interested' ? '已记为感兴趣（不会自动收藏）'
    : decision === 'muted' ? '已暂不关注，可在「阅读判断」里找回并撤销'
    : '已撤销判断，该论文已回到「今日发现」');
  if (reloadView === 'discovery') viewDiscovery(true);
  else if (reloadView === 'qualified') viewQualified();
  else if (reloadView === 'judgments') viewJudgments();
  else if (state.currentPaper && state.currentPaper.id === paperId) viewPaper(paperId);
  refreshFoot();
}

/* ============================== 视图：AI 简报 ============================== */

async function viewBrief() {
  const main = $('#main');
  main.innerHTML = '<div class="loading">正在读取今日简报…</div>';
  const d = await api('/api/brief');

  if (!d.ok) { main.innerHTML = `<div class="banner danger">读取失败：${esc(d.error || '')}</div>`; return; }
  if (d.empty) {
    main.innerHTML = `
      <div class="page-head"><div><h1>今日简报</h1><div class="page-sub">还没有生成过简报</div></div></div>
      ${schedulerBanner(d.scheduler)}
      <div class="card">
        <p>${esc(d.message || '')}</p>
        <p class="small muted">提示：日常阅读请用左侧的「<b>今日发现</b>」——它不依赖期刊是否已核验，打开就能按你的研究主题看到值得读的论文。</p>
        <p class="muted small">系统会在每天 <b>${d.scheduler?.briefHour ?? 8}:00</b>（北京时间）自动采集并生成简报；
        如果电脑当时没有开机，下次打开工作台会自动补做。</p>
        <div class="btn-row">
          <button class="btn primary" onclick="runFullUpdate(this)">立即采集并生成简报</button>
          <button class="btn" onclick="go('settings')">先配置数据源与 AI 密钥</button>
        </div>
      </div>
      ${schedulerLogHtml(null)}
      <div id="frontierBox" class="section"></div>`;
    // 还没有主简报：不传数字，标题就不写「独立于上面 N 篇」
    loadFrontierSection({ mainBriefCount: null });
    return;
  }

  const r = d.run;
  const shortfall = d.items.length < (d.run.selectedCount || 0) ? false : d.items.length < 5;
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>今日简报</h1>
        <div class="page-sub">简报日期 ${esc(r.runDate)}（北京时间）· 生成时间 ${esc(fmtBeijing(r.finishedAt))} · 触发方式 ${esc(reasonLabel(r.reason))}</div>
      </div>
      <div class="btn-row">
        <button class="btn" onclick="generateBrief(this, false)">重新生成</button>
        <button class="btn primary" onclick="runFullUpdate(this)">立即采集更新</button>
      </div>
    </div>
    ${schedulerBanner(d.scheduler)}
    ${shortfall ? `<div class="banner warn">今天符合条件的<b>新</b>论文只有 ${d.items.length} 篇，不足 5 篇。这里如实显示实际篇数，不使用旧论文或虚构条目补足。可点击「立即采集更新」尝试扩大检索窗口，或查看下方的待核验候选。</div>` : ''}
    ${d.languageDiagnosis?.note ? `<div class="banner warn">${esc(d.languageDiagnosis.note)}</div>` : ''}
    ${d.items.length === 0 ? `<div class="banner info"><strong>今天没有符合期刊条件的新论文。</strong>这不是错误：窗口内共有 ${d.pendingCandidates.length} 篇待核验候选。
      若你希望它们进入简报，请到「期刊目录与核验」导入官方目录（中文：CSSCI / 北大核心；英文：SSCI-JCR / 中科院分区），
      或先启用「参考分区名录」让英文主流期刊通过条件。系统不会用旧论文或虚构条目填充简报。</div>` : ''}
    <div class="stat-row card">
      <div class="stat"><b>${r.candidateCount}</b>窗口内候选</div>
      <div class="stat"><b>${d.items.filter((i) => i.kind === 'new').length}</b>今天新发现</div>
      <div class="stat"><b>${d.items.filter((i) => i.kind !== 'new').length}</b>补推（近期遗漏）</div>
      <div class="stat"><b>${r.eligibleCount}</b>期刊条件合格<br><span class="tiny">（官方目录）</span></div>
      <div class="stat"><b>${(d.referenceCandidates || []).length}</b>参考候选<br><span class="tiny">（非官方，不计入合格）</span></div>
      <div class="stat"><b>${d.pendingCandidates.length}</b>待核验候选</div>
    </div>

    <div class="section">
      <div class="section-head"><h2>今日精选（按研究主题选出）</h2>
        <span class="muted small">入选依据是主题相关性与新近度，<b>不代表已通过期刊等级核验</b>；每张卡片都标注了核验状态</span>
      </div>
      ${briefVerificationSummary(d.items)}
      ${d.items.map(briefCardHtml).join('') || '<div class="empty">今天没有符合条件的论文。</div>'}
    </div>

    ${d.allEligibleCandidates.length ? `
    <div class="section">
      <button type="button" class="collapse-head" id="cand-all" onclick="toggleCollapse(this)" aria-expanded="false" aria-controls="cand-all-body"><span class="collapse-arrow" aria-hidden="true">▸</span><span class="collapse-title">展开全部合格候选（${d.allEligibleCandidates.length} 篇，未入选精选）</span></button>
      <div class="collapse-body hidden" id="cand-all-body" role="region" aria-labelledby="cand-all">
        ${candidateListHtml(d.allEligibleCandidates, 'eligible')}
      </div>
    </div>` : ''}

    ${(d.referenceCandidates || []).length ? `
    <div class="section">
      <button type="button" class="collapse-head" id="cand-ref" onclick="toggleCollapse(this)" aria-expanded="false" aria-controls="cand-ref-body"><span class="collapse-arrow" aria-hidden="true">▸</span><span class="collapse-title">参考候选（${d.referenceCandidates.length} 篇，仅来自非官方参考名录，不计入「期刊条件合格」）</span></button>
      <div class="collapse-body hidden" id="cand-ref-body" role="region" aria-labelledby="cand-ref">
        <div class="banner warn small">这些论文的期刊信息来自随程序附带的<b>参考分区名录</b>，不是官方目录。
          它们<b>不会</b>被计入「期刊条件合格」数量，也<b>不会</b>作为合格论文进入精选。
          导入官方 JCR / SSCI 目录后，它们会自动升级为合格。</div>
        ${candidateListHtml(d.referenceCandidates, 'reference')}
      </div>
    </div>` : ''}

    ${d.pendingCandidates.length ? `
    <div class="section">
      <button type="button" class="collapse-head" id="cand-pending" onclick="toggleCollapse(this)" aria-expanded="false" aria-controls="cand-pending-body"><span class="collapse-arrow" aria-hidden="true">▸</span><span class="collapse-title">待核验候选（${d.pendingCandidates.length} 篇，期刊收录或分区尚未核实）</span></button>
      <div class="collapse-body hidden" id="cand-pending-body" role="region" aria-labelledby="cand-pending">
        <div class="banner warn small">这些论文的期刊未在已导入的官方目录中匹配到，因此<b>不能</b>视为满足期刊条件。到「期刊目录与核验」导入 CSSCI / 北大核心 / SSCI-JCR / 中科院分区后，系统会自动重新核验。</div>
        ${candidateListHtml(d.pendingCandidates, 'pending')}
      </div>
    </div>` : ''}

    ${schedulerLogHtml(r)}
    <div id="frontierBox" class="section"></div>`;

  // 主简报（篇数随当天实际情况变化）：首屏就该看到译文，按批预生成（有缓存直接命中）
  indexTrItems(d.items);
  warmTranslations(d.items, d.items.length);
  // 关键：把**本次实际**的主简报篇数传给前沿区块，标题不再写死
  loadFrontierSection({ mainBriefCount: d.items.length });
}

/* ==================================================================
   前沿技术每日精选（独立于当日主简报，篇数随当天实际入选数变化）
   ------------------------------------------------------------------
   用户要求：
     · 每天独立挑 2–3 篇，围绕 AI 语言教学、自动评估、语音技术、学习分析；
     · 只用真实接通的官方来源（ERIC / arXiv / ACL Anthology），
       IEEE 需要密钥就明确显示「待配置」，不假装采到；
     · 预印本 / 会议论文 / 期刊论文分别标识；
     · 与主简报分开，数量不足如实显示；记录来源与失败原因；
     · 篇数必须用**本次实际**的主简报篇数，不能写死（曾经写死成 8 篇）。
   界面上保持简单：一张卡 = 类型 + 来源 + 题名（原文→译文）+ 摘要 + 链接。
   ================================================================== */

const FRONTIER_TYPE_CLASS = {
  preprint: 'src',                  // 预印本用中性色，绝不显示成已核验
  'conference-paper': 'topic',
  'journal-article': 'en',
  report: 'pending',
  other: 'src',
};

/**
 * @param {{mainBriefCount?:number|null}} opts
 *   mainBriefCount 本次主简报的实际篇数（来自 /api/brief 的 items.length）。
 *   传 null/undefined 时标题就不写数字，绝不用写死的常量兜底。
 */
async function loadFrontierSection(opts = {}) {
  const box = $('#frontierBox');
  if (!box) return;
  const mainBriefCount = Number.isFinite(opts.mainBriefCount) ? opts.mainBriefCount : null;
  box.innerHTML = '<div class="loading">正在读取前沿技术精选…</div>';
  let d;
  try { d = await api('/api/frontier'); } catch (e) { d = { ok: false, error: e.message }; }
  if (!d || !d.ok) {
    box.innerHTML = `<div class="banner warn">前沿技术精选读取失败：${esc((d && d.error) || '未知错误')}</div>`;
    return;
  }
  box.innerHTML = frontierSectionHtml(d, mainBriefCount);
  if (d.items && d.items.length) frontierTranslateIfNeeded(d);
}

function frontierSourceStrip(sources) {
  if (!sources || !sources.length) return '';
  return `<div class="frontier-sources">${sources.map((s) => {
    let state, cls, tip, extra = '';
    if (s.needsKey && !s.configured) {
      state = '待配置'; cls = 'off'; tip = s.error || '需要 API Key';
      extra = '（未发起请求）';
    } else if (s.batch) {
      state = s.items > 0 ? `已同步 ${s.items} 条` : '待同步'; cls = s.items > 0 ? 'ok' : 'off';
      tip = s.error || s.note || '';
    } else if (s.ok) {
      state = '已接通'; cls = 'ok'; tip = `本次取回 ${s.found || 0} 条`;
    } else {
      /*
       * 失败时把原因直接写在页面上，而不是只塞进 title 提示：
       * 用户需要一眼看到「哪个源这次没成功、为什么」，而不是去悬停或翻日志。
       */
      state = '本次失败'; cls = 'err'; tip = s.error || '未知失败原因';
      const q = (s.queries != null && s.okQueries != null) ? `${s.okQueries}/${s.queries} 查询成功 · ` : '';
      const CAUSE_LABEL = { timeout: '超时', throttled: '被限流(429)', http: 'HTTP 错误', parse: '解析失败', network: '网络错误' };
      /*
       * 优先用本次运行**当场所做的**按原因计数；
       * 老记录没有计数时，只用从错误文本推导出的单一主要原因标签（不编造次数）。
       */
      const cause = s.causes ? Object.entries(s.causes)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} 次${CAUSE_LABEL[k] || k}`)
        .join('、')
        : (s.primaryCauseLabel ? `主要原因：${s.primaryCauseLabel}` : '');
      extra = `（${q}${cause || (s.status ? 'HTTP ' + s.status : '未取回记录')}）`;
    }
    return `<span class="fs-chip ${cls}" title="${attr(tip)}">${esc(s.label || s.source)}：<b>${esc(state)}</b>${esc(extra)}</span>`;
  }).join('')}</div>`;
}

function frontierCardHtml(it) {
  const links = [];
  if (it.url) links.push(`<a href="${attr(it.url)}" target="_blank" rel="noopener">来源页面</a>`);
  if (it.pdfUrl) links.push(`<a href="${attr(it.pdfUrl)}" target="_blank" rel="noopener">开放全文/PDF</a>`);
  if (it.doi) links.push(`<a href="https://doi.org/${attr(it.doi)}" target="_blank" rel="noopener">DOI: ${esc(it.doi)}</a>`);
  const typeCls = FRONTIER_TYPE_CLASS[it.docType] || 'src';
  // 日期按实际精度显示：ERIC 只有年，绝不补成某一天
  const dateText = it.publishedDate
    ? (it.publishedPrecision === 'day' ? `发表 ${fmtDate(it.publishedDate)}`
      : it.publishedPrecision === 'month' ? `发表 ${fmtDate(it.publishedDate)}（仅到月）`
      : `发表年 ${esc(String(it.publishedDate))}`)
    : '发表时间未提供';
  const peer = it.peerReviewed ? '<span class="tag elig" title="该来源标注为同行评议">同行评议</span>' : '<span class="tag src" title="预印本未经同行评议">未经同行评议</span>';
  /*
   * 采集时间口径：只有 first_seen 就是本次 run 当天，才算「今天新采集」；
   * 否则如实标明「沿用早前采集 + 原采集日」——绝不把旧记录说成今日新发现。
   */
  const seenDay = it.firstSeenDay || (it.firstSeen ? fmtDate(it.firstSeen) : null);
  const collectedTag = it.newlyCollectedToday
    ? '<span class="tag elig" title="这是本次更新当天首次采集到的记录">今天新采集</span>'
    : (seenDay
      ? `<span class="tag src" title="这条记录不是今天采集的，是沿用早前采集的结果；原采集日期见右侧">沿用早前采集 · ${esc(seenDay)}</span>`
      : '<span class="tag src" title="未记录首次采集时间">采集时间未知</span>');
  const trTitle = it.titleZh
    ? `<div class="brief-title-zh" data-fr-title="${it.id}">${esc(it.titleZh)} <span class="tr-badge ai">AI 译文</span></div>`
    : `<div class="brief-title-zh" data-fr-title="${it.id}"><span class="muted">${it.aiConfigured === false ? '未配置 AI 密钥，暂无译文（原文见上）' : '译文生成中…'}</span></div>`;

  return `
  <article class="paper-card frontier-card" data-frontier-id="${it.id}">
    <div class="pc-head">
      <div class="pc-title-block">
        <div class="brief-title"><span class="rank">${it.rank}</span>
          ${it.url ? `<a href="${attr(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)}
        </div>
        ${trTitle}
      </div>
    </div>
    <div class="brief-meta">
      ${esc((it.authors || []).slice(0, 6).join('；'))}${(it.authors || []).length > 6 ? ' 等' : ''}<br>
      <b>${esc(it.venue || '来源未标注')}</b> · ${esc(dateText)}<br>
      <span class="tiny muted">来源：${esc(it.sourceLabel || it.source)}${it.sourceId ? ` · 编号 ${esc(it.sourceId)}` : ''}${seenDay ? ` · 工作台采集 ${esc(seenDay)}` : ''}</span>
    </div>
    <div class="tags" style="margin-bottom:6px">
      <span class="tag ${typeCls}" title="文档类型由来源元数据判定">${esc(it.docTypeLabel || it.docType)}</span>
      ${peer}
      ${collectedTag}
      ${(it.subjects || []).slice(0, 4).map((s) => `<span class="tag src" title="来源提供的主题词/分类，不是作者关键词">${esc(s)}</span>`).join('')}
    </div>
    ${it.publishedNote ? `<div class="banner info small" style="margin:6px 0 0">来源标注的正式发表线索：${esc(it.publishedNote)}<br>
      <span class="tiny">实测这类线索覆盖率很低（arXiv 的 journal_ref/doi 仅约 2%–8%），因此工作台<b>只展示、不自动合并</b>记录。</span></div>` : ''}
    ${it.matchedPaperId ? `<div class="banner ok small" style="margin:6px 0 0">库内已有一篇对应的正式发表版：
      <a href="#/paper/${it.matchedPaperId}" onclick="return goPaper(${it.matchedPaperId})">查看正式版（paper/${it.matchedPaperId}）</a>
      <span class="tiny">（按 DOI 或题名精确匹配；两份记录分开保留，不互相覆盖）</span></div>` : ''}
    ${it.reason ? `<div class="reason"><span class="reason-label">为什么进入前沿精选</span>${esc(it.reason)}</div>` : ''}
    ${it.abstract
      ? `<div class="abs-block"><div class="abs-full">
           <div class="abs-col"><div class="abs-col-label">原文摘要</div><p dir="auto" class="abs-text">${esc(it.abstract)}</p></div>
           <div class="abs-col"><div class="abs-col-label">AI 译文</div><p dir="auto" class="abs-text" data-fr-abs="${it.id}">${it.abstractZh ? esc(it.abstractZh) : `<span class="muted">${it.aiConfigured === false ? '未配置 AI 密钥，未生成摘要译文' : '摘要译文生成中…'}</span>`}</p></div>
         </div></div>`
      : '<div class="banner warn small" style="margin:8px 0 0">该来源未提供摘要。工作台不会用 AI 补写摘要。</div>'}
    <div class="brief-meta card-links">${links.join(' · ') || '（无链接）'}</div>
    <div class="tiny muted" style="margin-top:6px">前沿精选不参与期刊等级核验，也<b>不计入「期刊条件合格」数量</b>。</div>
  </article>`;
}

/**
 * 前沿技术精选区块。
 *
 * @param d              /api/frontier 的返回
 * @param mainBriefCount 本次主简报的**实际**篇数（items.length）。
 *   标题里必须用它，不能写死——真实缺陷：曾写死成「独立于上面 8 篇主简报」，
 *   而 2026-09-29 的主简报是 10 篇，页面就自相矛盾了。
 *   没有拿到数字时（例如还没有主简报）就不写数字，绝不用常量兜底。
 */
function frontierSectionHtml(d, mainBriefCount = null) {
  const items = d.items || [];
  const briefScope = Number.isFinite(mainBriefCount)
    ? `独立于上面 ${mainBriefCount} 篇主简报`
    : '独立于当日主简报';
  return `
    <div class="section-head"><h2>前沿技术每日精选</h2>
      <span class="muted small">${esc(briefScope)}；只用真实接通的官方来源，数量不足如实显示</span>
    </div>
    ${d.note ? `<div class="banner warn small">${esc(d.note)}</div>` : ''}
    ${frontierSourceStrip(d.sources)}
    ${items.length ? items.map(frontierCardHtml).join('') : `<div class="empty">当前还没有前沿技术精选。
      <div class="vsmall" style="margin-top:8px">可以点上面的「立即采集更新」，或在「设置与数据源」查看各来源的真实状态。</div></div>`}
    ${d.run ? `<div class="tiny muted" style="margin-top:8px">本次生成：${esc(fmtBeijing(d.run.finishedAt || d.run.startedAt))} · 触发方式 ${esc(reasonLabel(d.run.reason))} · 候选 ${d.run.candidates} 条 · 入选 ${d.run.pickedCount} 篇${d.newTodayCount != null ? `（今天新采集 ${d.newTodayCount} 篇、沿用早前采集 ${d.carriedOverCount} 篇）` : ''}</div>` : ''}`;
}

/** 前沿条目的题名/摘要译文：一次性批量生成（已缓存直接命中） */
async function frontierTranslateIfNeeded(d) {
  const need = (d.items || []).some((it) => !it.titleZh && it.title);
  if (!need || d.aiConfigured === false) return;
  try {
    const r = await api('/api/frontier/translate', { method: 'POST', body: { runId: d.run ? d.run.id : null, limit: 6 } });
    if (!r || !r.results) return;
    for (const [id, fields] of Object.entries(r.results)) {
      if (fields.title && fields.title.ok && fields.title.text) {
        const node = $(`[data-fr-title="${id}"]`);
        if (node) node.innerHTML = `${esc(fields.title.text)} <span class="tr-badge ai">AI 译文</span>`;
      }
      if (fields.abstract && fields.abstract.ok && fields.abstract.text) {
        const node = $(`[data-fr-abs="${id}"]`);
        if (node) node.textContent = fields.abstract.text;
      }
    }
  } catch { /* 译文失败不影响原文展示 */ }
}

function reasonLabel(r) {
  return { scheduled: '定时更新', catchup: '开机补做', 'catchup-missed-day': '补做漏掉的更新', 'first-run': '首次运行', manual: '手动触发' }[r] || r || '—';
}

function schedulerBanner(sch) {
  if (!sch) return '';
  return `<div class="banner info small">
    每日自动更新：<b>${sch.briefHour}:${String(sch.briefMinute).padStart(2, '0')}</b>（${esc(sch.timezone)}）
    · 下次：${esc(fmtDateTime(sch.nextAt))}
    · 今天${sch.scheduledDone
      ? '<b>定时更新已完成</b>'
      : (sch.earlyOnly
          ? `<b>只在预定时刻（${esc(fmtDateTime(sch.targetAt))}）之前生成过简报</b>，这不算完成定时更新；到点或下次打开会自动补做`
          : (sch.todayDue ? '<b>已到点但尚未生成</b>（下次打开会自动补做）' : '尚未到点'))}
    · 上次成功：${esc(sch.lastSuccessDate || '无')}
  </div>`;
}

function schedulerLogHtml(run) {
  if (!run || !run.log || !run.log.length) return '';
  return `<div class="section">
    <button type="button" class="collapse-head" id="run-log" onclick="toggleCollapse(this)" aria-expanded="false" aria-controls="run-log-body"><span class="collapse-arrow" aria-hidden="true">▸</span><span class="collapse-title">本次更新的执行日志（${run.log.length} 条）</span></button>
    <div class="collapse-body hidden" id="run-log-body" role="region" aria-labelledby="run-log"><div class="card small mono" style="line-height:1.8">
      ${run.log.map((l) => `<div>${esc(fmtDateTime(l.at))} — ${esc(l.msg)}</div>`).join('')}
    </div></div>
  </div>`;
}

/**
 * 简报条目上的核验状态块。
 * 硬要求：参考候选 / 待核验绝不能出现「期刊条件合格」这类表述；
 * 必须给出状态、参考等级与证据来源。
 */
/**
 * 今日精选的核验状态汇总。
 *
 * 目的：让「今日精选」不会被误读成「已通过期刊等级核验」。
 * 精选是按研究主题与相关性选出的，其中可能包含参考候选与待核验论文。
 */
function briefVerificationSummary(items) {
  if (!items || !items.length) return '';
  const n = { official: 0, reference: 0, pending: 0 };
  for (const it of items) {
    const k = it.verification?.atRecommendation;
    if (k === 'official') n.official++; else if (k === 'reference') n.reference++; else n.pending++;
  }
  const nonOfficial = n.reference + n.pending;
  if (!nonOfficial) {
    return `<div class="banner ok small">本期 ${items.length} 篇精选的期刊<strong>全部</strong>来自官方目录已核验合格的论文。</div>`;
  }
  return `<div class="banner warn small">
    <strong>本期 ${items.length} 篇精选中，有 ${nonOfficial} 篇尚未通过官方目录核验</strong>
    （参考候选 ${n.reference} 篇、待核验 ${n.pending} 篇${n.official ? `；官方核验合格 ${n.official} 篇` : ''}）。
    精选按<strong>研究主题</strong>选出，所以这些论文可以出现在这里；
    但它们是「<strong>参考候选</strong>」或「<strong>待核验</strong>」，<strong>不计入「期刊条件合格」数量，也不属于「期刊条件合格精选」</strong>。
    要查看已核验合格的论文，请到「期刊条件合格精选」页。
  </div>`;
}

/**
 * 卡面上的核验状态：**只保留醒目的状态色块 + 一句非常短的状态说明**。
 *
 * 用户口径：整块黄色长说明（含 eligibility_note、证据来源）不应占据卡面，
 * 应真正移进默认收起的「为何推荐 / 来源详情」——见 verificationDetailHtml。
 * 徽标文字保持不变（它必须写明「不计入合格」，这是核验口径的硬要求）。
 */
function verificationFaceHtml(it) {
  const v = it.verification || {};
  const official = v.official === true;
  const status = official ? 'official' : (v.atRecommendation === 'reference' ? 'reference' : 'pending');
  const badge = official
    ? '✔ 期刊条件合格（官方目录已核验）'
    : (status === 'reference'
      ? '◇ 参考候选 · 未经官方核验（不计入合格）'
      : '? 待核验 · 未匹配到官方目录（不计入合格）');
  const short = official
    ? '证据来自你导入的官方目录。'
    : (status === 'reference'
      ? '证据来自非官方参考名录，只作阅读线索。'
      : '尚未匹配到任何官方目录，资格待核验。');
  return `<div class="verify-face ${official ? 'is-official' : 'is-unofficial'}">
    <span class="verdict ${official ? 'eligible' : (status === 'reference' ? 'reference' : 'pending')}">${badge}</span>
    <span class="vf-note">${esc(short)}</span>
  </div>`;
}

/**
 * 核验的**详细内容**（进折叠区，不在卡面）：
 * 认可状态说明、参考等级、完整证据来源、以及「推荐之后状态变化」的提示。
 */
function verificationDetailHtml(it) {
  const v = it.verification || {};
  const snap = it.verificationSnapshot || null;
  const official = v.official === true;
  const parts = [];
  if (v.headline) parts.push(`<div>${esc(v.headline)}</div>`);
  if (!official && it.eligibility_note) parts.push(`<div>${esc(it.eligibility_note)}</div>`);
  const ev = (snap && snap.evidence && snap.evidence.length)
    ? snap.evidence.map((e) => [e.catalog, e.edition || e.year, e.basis].filter(Boolean).join('／'))
    : (it.journal_tags || []).filter((t) => t.kind === 'official' || t.reference === true)
      .map((t) => [t.catalog, t.edition || t.year, t.basis].filter(Boolean).join('／'));
  if (ev.length) parts.push(`<div>证据来源：${esc(ev.join('；'))}</div>`);
  if (v.changedSince) {
    parts.push(`<div style="color:var(--warn)">注意：这条推荐做出时的状态是「${esc(v.headline || '')}」，之后期刊目录有更新，当前状态已变化。</div>`);
  }
  return parts.join('');
}

/**
 * 卡面上的「一句阅读理由」。
 * 硬要求：**不带小数分数**（主题相关 0.622 这类内部排序指标在折叠区里）。
 */
function shortReasonText(it) {
  const names = [...new Set((it.topics || []).map((t) => t.name)
    .concat((it.topic_evidence || []).map((e) => e.name)))].filter(Boolean).slice(0, 2);
  const bits = [];
  if (names.length) bits.push(`命中你的「${names.join('、')}」主题`);
  if (it.kind === 'catchup') bits.push('属于近期补推');
  bits.push(it.abstract ? '有摘要可先做依据摘要的解读' : '暂无摘要，只能依据题名与元数据做有限判断');
  return bits.join('；') + '。';
}

/**
 * 今日简报卡片。
 * 与今日发现同一套阅读层级：原文题名/关键词/摘要 → 各自译文；
 * 卡面只显示一个可信发表时间；内部指标收进「为何推荐/来源详情」。
 */
function briefCardHtml(it) {
  const links = [];
  if (it.doi) links.push(`<a href="https://doi.org/${attr(it.doi)}" target="_blank" rel="noopener">DOI: ${esc(it.doi)}</a>`);
  if (it.url && !it.doi) links.push(`<a href="${attr(it.url)}" target="_blank" rel="noopener">原文链接</a>`);
  if (it.pdf_url) links.push(`<a href="${attr(it.pdf_url)}" target="_blank" rel="noopener">开放全文（合法来源）</a>`);

  const titleTr = trText(it, 'title') || it.title_zh || null;

  return `
  <article class="brief-card" data-paper-id="${it.id}">
    <div class="pc-head">
      <div class="pc-title-block">
        <div class="brief-title"><span class="rank">${it.rank}</span>
          <a href="#/paper/${it.id}" onclick="return goPaper(${it.id})">${esc(it.title)}</a>
        </div>
        ${/* 译文行始终渲染：已缓存→显示译文；生成中→「生成中」；未配置密钥→明确说明。
             隐藏它会让人误以为「没有译文」是正常的，而实际是「还没生成」或「缺密钥」。 */ ''}
        <div class="brief-title-zh" data-tr-field="title" data-tr-view="full" data-id="${it.id}"><span class="tr-text">${titleTr ? esc(titleTr) : `<span class="muted">${it.aiConfigured === false ? '未配置 AI 密钥，暂无译文（原文见上）' : '译文生成中…'}</span>`}</span> ${trBadge(it, 'title')}</div>
      </div>
      <div class="pc-actions">
        <button class="btn small ${it.starred ? 'primary' : ''}" title="收藏到本地书库" onclick="toggleStar(${it.id}, ${it.starred ? 'false' : 'true'}, this)">${it.starred ? '★ 已收藏' : '☆ 收藏'}</button>
        <button class="btn small ${it.judgment === 'muted' ? 'primary' : ''}" onclick="setJudgment(${it.id},'${it.judgment === 'muted' ? 'cleared' : 'muted'}',this,null)" title="不感兴趣：不再出现在默认视图">${it.judgment === 'muted' ? '✕ 已不关注' : '✕ 不感兴趣'}</button>
      </div>
    </div>
    <div class="brief-meta">
      ${esc((it.authors || []).slice(0, 6).join('；'))}${(it.authors || []).length > 6 ? ' 等' : ''}<br>
      <b>${esc(it.journal_name || '期刊未识别')}</b>${bibLine(it)}<br>
      ${pubTimeHtml(it)}
    </div>
    <div class="tags" style="margin-bottom:6px">
      ${langTag(it.language)}
      ${eligTag(it.eligibility, it.eligibility_basis)}
      ${it.kind === 'catchup'
        ? '<span class="tag src" title="它不是今天新发现的，而是此前采集到但从未推送过">补推（近期遗漏）</span>'
        : '<span class="tag elig">今天新发现</span>'}
      ${(it.journal_tags || []).map(journalTagHtml).join('')}
      ${it.open_access ? `<span class="tag oa">开放获取${it.oa_status ? ' · ' + esc(it.oa_status) : ''}</span>` : ''}
    </div>
    ${coreTopicsHtml(it)}

    ${/*
      卡面只保留：核验状态色块 + 一句短说明 + 一句不带小数分数的阅读理由。
      完整核验说明与证据、完整推荐理由都在下方「为何推荐 / 来源详情」里（默认收起）。
    */ ''}
    ${verificationFaceHtml(it)}
    <div class="reason short"><span class="reason-label">为什么值得你读</span>${esc(shortReasonText(it))}</div>
    ${keywordBlockHtml(it)}
    ${abstractBlockHtml(it, 'b')}
    ${diagnosticsHtml(it)}

    <div class="brief-meta card-links">${links.join(' · ') || '（无链接）'}</div>

    <div class="btn-row card-actions">
      <button class="btn small primary" onclick="goPaper(${it.id})">进入详情与 AI 解读</button>
      <details class="more-actions">
        <summary class="btn small">更多操作</summary>
        <div class="more-actions-body">
          ${judgmentButtonsHtml(it, { reloadView: null })}
          <button class="btn small" onclick="setRead(${it.id}, '${it.read_state === 'read' ? 'unread' : 'read'}', this)">${it.read_state === 'read' ? '标为待读' : '标记已读'}</button>
          <button class="btn small" onclick="quickInterpret(${it.id}, this)">快速解读（依据摘要）</button>
        </div>
      </details>
    </div>
  </article>`;
}

function candidateListHtml(list, kind) {
  return `<div class="card"><table><thead><tr>
      <th style="width:56px">综合分</th><th>题名</th><th style="width:210px">期刊与等级</th>
      <th style="width:70px">语言</th><th style="width:96px">在线日期</th><th style="width:70px"></th>
    </tr></thead><tbody>
    ${list.map((c) => `<tr>
      <td class="mono small">${c.score != null ? c.score : '—'}</td>
      <td><a href="#/paper/${c.id}" onclick="return goPaper(${c.id})">${esc(c.title)}</a>
        ${kind !== 'eligible' && c.reason ? `<div class="tiny muted">${esc(c.reason)}</div>` : ''}</td>
      <td class="small">
        <div>${esc(c.journal_name || '—')}</div>
        ${c.issn ? `<div class="tiny muted mono">${esc(c.issn)}</div>` : ''}
        <div class="tags" style="margin-top:4px">${(c.journal_tags || []).map(journalTagHtml).join('')}</div>
      </td>
      <td>${langTag(c.language)}</td>
      <td class="small">${fmtDate(c.published_online)}</td>
      <td><button class="btn ghost small" onclick="goPaper(${c.id})">详情</button></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

/* ============================== 视图：论文详情 ============================== */

async function viewPaper(id, opts) {
  const keepInterpBox = Boolean(opts && opts.keepInterpBox);
  // 先留住「本次解读结果」的数据（重绘后要重新渲染），不搬 DOM
  const savedInterpResult = keepInterpBox ? (state.lastInterpResult || null) : null;
  const savedInterpId = keepInterpBox ? ((state.currentInterpMeta || {}).id || '') : '';
  const main = $('#main');
  main.innerHTML = '<div class="loading">正在读取论文详情…</div>';
  const [d, jr] = await Promise.all([api('/api/papers/' + id), api('/api/judgments/' + id)]);
  if (!d.ok) { main.innerHTML = `<div class="banner danger">${esc(d.error)}</div>`; return; }
  const p = d.paper;
  const li = d.languageInfo || null;   // 语种判定信息（来源 + 依据 + 人工纠正入口）
  state.currentPaper = p;
  state.judgment = jr && jr.ok && jr.decision ? { decision: jr.decision, label: jr.label } : null;
  state.translations = d.translations;
  state.vocabulary = d.vocabulary;
  state.languageInfo = d.languageInfo || null;
  state.transView = state.transView || 'side';

  const jt = p.journal;
  const v = d.vocabulary || {};
  const tr = d.translations || { fields: {} };

  main.innerHTML = `
    <div class="btn-row" style="margin-bottom:14px">
      <button class="btn ghost small" onclick="go('discovery')">← 返回今日发现</button>
      <button class="btn ghost small" onclick="go('library')">我的收藏</button>
    </div>

    <div class="detail-head">
      <h1 style="font-size:20px">${esc(p.title)}</h1>
      ${tr.fields?.title?.translated ? `<div class="muted" style="margin-top:6px;font-size:16px">${esc(tr.fields.title.translated)}
        <span class="ai-badge">AI 译文</span></div>` : ''}
      <div class="tags" style="margin-top:12px">
        ${langTag(p.language)}
        ${eligTag(p.eligibility, p.eligibility_basis)}
        ${p.open_access ? `<span class="tag oa">开放获取${p.oa_status ? ' · ' + esc(p.oa_status) : ''}</span>` : '<span class="tag src">未确认为开放获取</span>'}
      </div>
      <div class="btn-row" style="margin-top:14px">
        ${judgmentButtonsHtml({ id: p.id, judgment: state.judgment || null }, { reloadView: 'paper' })}
        <button class="btn ${p.library.starred ? 'primary' : ''}" onclick="toggleStar(${p.id}, ${p.library.starred ? 'false' : 'true'}, this, true)">${p.library.starred ? '★ 已收藏' : '☆ 收藏本文'}</button>
        <span class="pill-select" id="readSel">
          <button class="${p.library.read_state === 'unread' ? 'active' : ''}" onclick="setRead(${p.id},'unread',this,true)">待读</button>
          <button class="${p.library.read_state === 'reading' ? 'active' : ''}" onclick="setRead(${p.id},'reading',this,true)">在读</button>
          <button class="${p.library.read_state === 'read' ? 'active' : ''}" onclick="setRead(${p.id},'read',this,true)">已读</button>
        </span>
        ${p.url ? `<a class="btn" href="${attr(p.url)}" target="_blank" rel="noopener">打开原文</a>` : ''}
        ${p.pdf_url ? `<a class="btn" href="${attr(p.pdf_url)}" target="_blank" rel="noopener">开放全文</a>` : ''}
      </div>
    </div>

    <div class="section" style="margin-top:0">
      <div class="section-head"><h2>期刊等级</h2>
        <span class="muted small">JCR 与中科院分区分别显示，不合并为综合等级</span></div>
      ${journalBoxHtml(jt)}
      ${p.eligibility === 'reference' ? `<div class="banner warn small" style="margin-top:10px">
        该论文的期刊依据是<b>非官方参考线索</b>，因此状态是「<b>参考候选</b>」：
        <br>· <b>可以进入</b>主题优先的今日简报，卡片上会醒目标注「参考候选 · 未经官方核验」；
        <br>· <b>不计入</b>「期刊条件合格」数量，也<b>不会进入</b>「期刊条件合格精选」页；
        <br>· 导入官方 JCR/SSCI / CSSCI / 北大核心目录后，会自动重新核验并升级。
      </div>` : ''}
      ${p.eligibility === 'pending' ? `<div class="banner warn small" style="margin-top:10px">${esc(jt.note)}</div>` : ''}
    </div>

    <div class="section">
      <div class="section-head"><h2>篇关摘翻译</h2>
        <span class="muted small">篇名 · 关键词 · 摘要；原文始终保留</span></div>
      <div class="card">
        <div class="btn-row" style="margin-bottom:10px">
          <button class="btn primary" onclick="translateAll(${p.id}, false, this)">一键翻译（篇名 / 关键词 / 摘要）</button>
          <button class="btn" onclick="translateAll(${p.id}, true, this)">全部重新翻译</button>
          <span class="pill-select" id="transViewSel">
            <button class="${state.transView === 'side' ? 'active' : ''}" onclick="setTransView('side')">并排</button>
            <button class="${state.transView === 'orig' ? 'active' : ''}" onclick="setTransView('orig')">仅原文</button>
            <button class="${state.transView === 'trans' ? 'active' : ''}" onclick="setTransView('trans')">仅译文</button>
          </span>
        </div>
        ${tr.aiConfigured === false ? `<div class="banner warn small">未配置 AI 密钥，翻译不可用。可在「设置」页填入 API Key，或使用本机模型端点。原文不受影响，配置后即可翻译。</div>` : ''}
        <div id="transBox">${renderTranslations(p, v, tr)}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>关键词与主题</h2>
        <span class="muted small">作者关键词、数据库主题词、工作台主题标签三者分开显示</span></div>
      <div class="card">${renderVocabulary(v, p)}</div>
    </div>

    <div class="section">
      <div class="section-head"><h2>可核实的元数据</h2></div>
      <div class="grid-2">
        <div class="card">
          <dl class="meta-grid">
            <dt>作者</dt><dd>${esc((p.authors || []).join('；') || '（元数据未提供）')}</dd>
            <dt>期刊</dt><dd>${esc(jt.name || '—')} ${jt.issn ? `<span class="mono tiny muted">${esc(jt.issn)}</span>` : ''}</dd>
            <dt>DOI</dt><dd>${p.doi ? `<a href="https://doi.org/${attr(p.doi)}" target="_blank" rel="noopener" class="mono">${esc(p.doi)}</a>` : '<span class="muted">无</span>'}</dd>
            <dt>首次在线</dt><dd>${fmtDate(p.dates.published_online)}</dd>
            <dt>正式出版</dt><dd>${fmtDate(p.dates.published_print)}</dd>
              <dt>出版年 / 期</dt><dd>${publicationLine(p)}</dd>
              <dt>具体出版日</dt><dd>${p.dates.published_print || (/^\d{4}-\d{2}-\d{2}$/.test(String(p.dates.issued_date || '')) ? fmtDate(p.dates.issued_date) : '<span class="muted">未提供</span>')}</dd>
            <dt>工作台发现</dt><dd>${fmtDate(p.dates.discovery_date)} <span class="tiny muted">（北京时间）</span></dd>
            ${p.catalogSource ? `<dt>目录首次见到</dt><dd>${p.catalogSource.catalogDate ? esc(fmtDate(p.catalogSource.catalogDate)) + '（北京时间）' : '—'}
              <div class="tiny muted">这是工作台从公开目录页看到这条题录的日期，<b>不是论文出版日期</b>。
              来源：${esc(p.catalogSource.sourceKey)}${p.catalogSource.issueLabel ? ' · ' + esc(p.catalogSource.issueLabel) : ''}
              ${p.catalogSource.articleUrl ? ` · <a href="${attr(p.catalogSource.articleUrl)}" target="_blank" rel="noopener">文章原页</a>` : ''}
              ${p.catalogSource.sourceUrl ? ` · <a href="${attr(p.catalogSource.sourceUrl)}" target="_blank" rel="noopener">目录页</a>` : ''}
              </div></dd>` : ''}
            <dt>卷期页</dt><dd>${esc(bibDetail(p) || '—')}</dd>
            <dt>语种</dt><dd id="langCell">${languageCellHtml(li)}</dd>
            <dt>数据来源</dt><dd>${(p.sources || []).map((x) => `<span class="tag src">${esc(x)}</span>`).join(' ') || '—'}</dd>
            <dt>被引</dt><dd>${p.citation_count != null ? p.citation_count + '（来源数据源，仅供参考）' : '—'}</dd>
            <dt>发现检索词</dt><dd class="tiny">${esc((p.source_queries || []).join(' / ') || '—')}</dd>
          </dl>
          <div class="sep"></div>
          <h4 style="font-size:13.5px">目录依据明细</h4>
          <div class="tiny muted">${(jt.catalogs || []).length
            ? jt.catalogs.map((c) => `${esc(c.catalog)}／${esc(c.edition || '未标版次')}／${esc(c.basis || '')}／来源：${esc(c.source || '')}／${c.reference ? '<b>非官方参考名录</b>' : '官方目录已核验'}`).join('<br>')
            : '尚未导入任何目录记录'}</div>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn small" onclick="verifyJournal(${jt.id || 0}, ${p.id})">用 Crossref/DOAJ 核验该刊</button>
            <button class="btn small" onclick="enrichPaper(${p.id}, this)">补全开放获取与摘要</button>
          </div>
        </div>

        <div class="card">
          <h3>摘要</h3>
          <div class="sep"></div>
          ${p.abstract
            ? `<p style="font-size:13.6px;line-height:1.8">${esc(p.abstract)}</p>
               <div class="tiny muted">摘要来源：${esc(p.abstract_source || '元数据源')}</div>`
            : `<div class="banner warn small">原始数据未提供摘要。AI 解读只能依据题名与元数据；也不会生成或臆测摘要译文。</div>`}
          <div class="sep"></div>
          <h4 style="font-size:14px">全文（可选）</h4>
          ${p.fulltext ? `
            <div class="small">已保存全文：<b>${esc(p.fulltext.filename || '')}</b>（来源：${esc(p.fulltext.origin)}，${p.fulltext.charCount} 字符）</div>
            ${p.fulltext.sections.length ? `<div class="tiny muted" style="margin-top:4px">识别章节：${esc(p.fulltext.sections.join(' / '))}</div>` : ''}
            <div class="tiny muted" style="margin-top:6px">${esc(p.fulltext.note || '')}</div>
            <div class="btn-row" style="margin-top:10px">
              <button class="btn small" onclick="showFulltext(${p.id})">查看抽取文本</button>
              <button class="btn small danger" onclick="deleteFulltext(${p.id}, this)">删除全文</button>
            </div>`
            : `<div class="small muted">尚未保存全文。可上传你自己合法取得的 PDF（仅用于本机个人解读，不上传任何服务器）。</div>`}
          <div class="btn-row" style="margin-top:10px">
            <button class="btn small" onclick="uploadFulltext(${p.id})">上传我的 PDF</button>
          </div>
          <div class="tiny muted" style="margin-top:8px">本工作台不会绕过付费墙获取正文；只使用你上传的文件与合法开放链接。</div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>个人备注</h3>
      <textarea id="noteBox" placeholder="记下你的判断：可借鉴之处、待验证的问题、与自己研究的关系…">${esc(p.library.note)}</textarea>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn primary small" onclick="saveNote(${p.id}, this)">保存备注</button>
        <span class="muted tiny" id="noteSaved"></span>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <h2>AI 解读</h2>
        <span class="muted small">每一条解读都会标注依据范围</span>
      </div>
      ${p.evidenceOptions.note ? `<div class="banner warn small">${esc(p.evidenceOptions.note)}</div>` : ''}
      <div class="card">
        <div class="btn-row">
          <button class="btn primary" onclick="runInterpret(${p.id}, 'quick', this)">快速解读</button>
          <button class="btn primary" onclick="runInterpret(${p.id}, 'deep', this)">深入解读</button>
          <button class="btn" onclick="previewEvidence(${p.id})">查看可依据材料</button>
          <button class="btn ghost small" onclick="ruleSummary(${p.id})">规则版速览（非 AI）</button>
        </div>
        <div class="sep"></div>
        <label class="field">
          <span>自由追问</span>
          <textarea id="askBox" placeholder="例如：这篇论文的控制组是如何设计的？它的结论是否被证据支持？如果我要在国际中文教育里复现，需要补什么？"></textarea>
        </label>
        <div class="btn-row"><button class="btn" onclick="askFollowup(${p.id}, this)">提交追问</button></div>
        <div id="interpBox"></div>
      </div>
    </div>

    <div class="section" id="historySection">
      <div class="section-head"><h2>解读记录</h2><span class="muted small" id="interpHistoryCount">${interpHistoryCountText(d.interpretations)}</span></div>
      <div id="interpHistory">${interpHistoryListHtml(d, p.id)}</div>
    </div>
  `;
  // 正文与引用编号必须在容器进入 DOM 之后再渲染
  hydrateInterpretations($('#interpHistory'));
  await refreshFoot();

  // 「重新解读 / 删除」后不整页抹掉用户正在看的「本次解读结果」：
  // 整页重绘会连 #interpBox 一起清空，用户刚生成的结果就没了。
  // 这里用当初的数据**重新渲染**一份（比搬 DOM 干净），并在历史列表里高亮新出现的那条。
  if (keepInterpBox && savedInterpResult) {
    renderInterpResult(savedInterpResult);
    const fresh = $('#interpHistory [data-interp="' + savedInterpId + '"]');
    if (fresh) {
      fresh.classList.add('just-created');
      fresh.scrollIntoView({ block: 'nearest' });
    }
  }
}

/** 渲染「本次解读结果」区块（生成成功与重绘恢复共用一份，避免两处写法不一致） */
function renderInterpResult(res) {
  const box = $('#interpBox');
  if (!box) return;
  const known = new Set(res.knownSids || []);
  state.currentInterpMeta = {
    id: res.id, hasSnapshot: res.hasSnapshot, knownSids: [...known],
  };
  box.innerHTML = (res.title ? `<div class="section-head"><h3>${esc(res.title)}</h3></div>` : '')
    + interpHtml({
      id: res.id, mode: res.mode, question: res.question || null,
      evidenceScope: res.evidenceScope, evidenceNote: res.evidenceNote,
      model: res.model, content: res.content, grounding: res.grounding, tokens: res.tokens,
      createdAt: res.createdAt, paperId: res.paperId,
      hasSnapshot: res.hasSnapshot, materialCount: res.materialCount,
    }, [...known]);
  hydrateInterpretations(box);
}

/** 「解读记录」的计数文案（渲染与即时同步共用一份，避免两处口径不一致） */
function interpHistoryCountText(list) {
  const n = (list || []).length;
  return `${n} 条，保存在本机`;
}

/** 「解读记录」的列表 HTML（渲染与即时同步共用一份） */
function interpHistoryListHtml(d, paperId) {
  const list = (d && d.interpretations) || [];
  if (!list.length) return '<div class="empty">还没有解读记录。</div>';
  return list.map((x) => interpHtml({ ...x, paperId }, (d.snapshots || {})[x.id])).join('');
}

/**
 * 生成 / 删除 / 重新解读后，**立即**同步「解读记录」列表与计数。
 *
 * 为什么必须重新拉一次：新记录的时间、材料快照数只有服务端知道；
 * 只在本地插一条会与刷新后的结果不一致（这正是「刚生成显示 03:10、
 * 刷新后变 19:10」那个 bug 的另一面）。
 * 同时刷新页脚总数，让「总共几条」和「本页几条」一起更新。
 */
async function syncInterpHistory(paperId) {
  const host = $('#interpHistory');
  const countEl = $('#interpHistoryCount');
  if (!host || !paperId) { await refreshFoot(); return; }
  const d = await api('/api/papers/' + paperId);
  if (!d || !d.ok) { await refreshFoot(); return; }
  state.currentPaper = d.paper;
  host.innerHTML = interpHistoryListHtml(d, paperId);
  if (countEl) countEl.textContent = interpHistoryCountText(d.interpretations);
  hydrateInterpretations(host);
  await refreshFoot();
}

/* ---------------------- 篇关摘翻译渲染 ---------------------- */

function setTransView(v) {
  state.transView = v;
  $$('#transViewSel button').forEach((b) => b.classList.remove('active'));
  const idx = { side: 0, orig: 1, trans: 2 }[v];
  const btns = $$('#transViewSel button');
  if (btns[idx]) btns[idx].classList.add('active');
  if (state.currentPaper) {
    $('#transBox').innerHTML = renderTranslations(state.currentPaper, state.vocabulary, state.translations);
  }
}

function renderTranslations(p, v, tr) {
  const view = state.transView || 'side';
  const F = tr.fields || {};
  const order = ['title', 'keywords', 'abstract'];
  const labels = { title: '篇名', keywords: '关键词', abstract: '摘要' };

  return order.map((f) => {
    const t = F[f] || {};
    const orig = t.sourceText || (f === 'title' ? p.title : (f === 'abstract' ? p.abstract : null));
    const available = t.available !== false;

    if (!available) {
      return `<div class="trans-block">
        <div class="trans-head"><span class="trans-title">${labels[f]}</span>
          <span class="tag pending">无原文可译</span></div>
        <div class="trans-body"><div class="kw-empty">${esc(t.note || '原始数据未提供该字段')}
          ${t.detail ? `<div class="tiny" style="margin-top:5px;color:var(--ink-2)">${esc(t.detail)}</div>` : ''}</div></div>
      </div>`;
    }

    const failed = t.status === 'failed' && !t.translated;
    const srcHtml = `<div class="src">${esc(orig || '')}</div>`;
    const tgtHtml = t.translated
      ? `<div class="tgt">${esc(t.translated)}</div>`
      : failed
        ? `<div class="kw-empty">上次翻译失败：${esc(t.error || '未知原因')}
             <div class="tiny" style="margin-top:5px">原文已保留。可点下方「重试」。</div></div>`
        : `<div class="muted small">尚未翻译。</div>`;

    const body = view === 'orig' ? `<div class="trans-body">${srcHtml}</div>`
      : view === 'trans' ? `<div class="trans-body">${tgtHtml}</div>`
      : `<div class="trans-side">
           <div><div class="trans-col-label">原文</div>${srcHtml}</div>
           <div><div class="trans-col-label">译文（AI 生成）</div>${tgtHtml}</div>
         </div>`;

    const meta = [];
    if (t.translated) {
      meta.push(`<span class="ai-badge">AI 译文</span>`);
      if (t.model) meta.push(`<span class="tiny muted">模型 ${esc(t.model)}</span>`);
      if (t.createdAt) meta.push(`<span class="tiny muted">${esc(fmtDateTime(t.createdAt))}</span>`);
      if (t.tokens) meta.push(`<span class="tiny muted">${t.tokens} tokens</span>`);
    }
    if (t.note) meta.push(`<span class="tiny muted">${esc(t.note)}</span>`);

    const numWarn = t.numberCheck && !t.numberCheck.ok
      ? `<div class="kw-empty" style="margin:8px 13px">数字核对：${esc(t.numberCheck.note)}</div>` : '';

    return `<div class="trans-block">
      <div class="trans-head">
        <span class="trans-title">${labels[f]}</span>
        ${meta.join(' ')}
        <span class="right"></span>
        <button class="btn small" onclick="translateField(${p.id}, '${f}', ${t.translated ? 'true' : 'false'}, this)">${t.translated ? '重新翻译' : '翻译'}</button>
      </div>
      ${t.detail ? `<div class="tiny muted" style="padding:7px 13px 0">${esc(t.detail)}</div>` : ''}
      ${body}
      ${numWarn}
    </div>`;
  }).join('') + `<div class="tiny muted" style="margin-top:6px">${esc(tr.attribution || '译文由 AI 生成，仅供参考；引用请以原文为准。')}</div>`;
}

/* ---------------------- 关键词与主题渲染 ---------------------- */

function renderVocabulary(v, p) {
  if (!v) return '<div class="muted small">无数据</div>';
  const kw = v.keywords || {};
  const dt = v.dbTopics || {};
  const wt = v.workbenchTopics || {};
  const ds = v.dbSubjects || {};

  const kwHtml = kw.available
    ? `<div class="tags">${(kw.items || []).map((k) => `<span class="tag topic">${esc(k)}</span>`).join('')}</div>`
    : `<div class="kw-empty">${esc(kw.emptyText || '原始数据未提供关键词')}
         <div class="tiny" style="margin-top:5px">工作台的自动主题标签与数据库主题词不是作者关键词，因此不会出现在这里，也不会被拿去翻译充数。</div></div>`;

  const block = (label, obj, cls, caveat) => {
    const items = obj.items || [];
    if (!items.length) return '';
    return `<div class="kw-group">
      <div class="kw-head">${esc(label)}${obj.source ? `<span class="tiny muted">来源：${esc(obj.source)}</span>` : ''}</div>
      <div class="tags">${items.map((x) => `<span class="tag ${cls}">${esc(typeof x === 'string' ? x : x.name)}</span>`).join('')}</div>
      ${caveat ? `<div class="tiny muted" style="margin-top:4px">${esc(caveat)}</div>` : ''}
    </div>`;
  };

  return `
    <div class="kw-group">
      <div class="kw-head"><b>${esc(kw.label || '作者关键词')}</b>
        ${kw.source ? `<span class="tiny muted">来源：${esc(kw.source)}</span>` : ''}
        ${kw.available
          ? (kw.isAuthorSupplied
              ? '<span class="tag elig">原始数据提供的作者关键词</span>'
              : '<span class="tag pending">机器提取，非作者关键词</span>')
          : '<span class="tag pending">原始数据未提供</span>'}
      </div>
      ${kwHtml}
      ${kw.caveat ? `<div class="tiny muted" style="margin-top:5px">${esc(kw.caveat)}</div>` : ''}
      ${kw.available ? `<div class="btn-row" style="margin-top:7px"><button class="btn small" onclick="translateField(${p.id}, 'keywords', false, this)">翻译关键词</button></div>` : ''}
    </div>
    ${block('数据库主题词', dt, 'src', dt.caveat)}
    ${block('工作台主题标签', wt, 'topic', wt.caveat || '这是工作台自动生成的标签，不是作者关键词。')}
    ${block('出版商主题分类', ds, 'src', null)}
  `;
}

/* ---------------------- 翻译动作 ---------------------- */

async function translateField(paperId, field, force, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span>翻译中…'; }
  const r = await api('/api/translate/' + paperId, { method: 'POST', body: { field, force } });
  if (btn) { btn.disabled = false; btn.textContent = force ? '重新翻译' : '翻译'; }
  if (!r.ok) {
    if (r.configured === false) { toast('未配置 AI 密钥，已跳转到设置页', true); go('settings'); return; }
    toast(r.error || '翻译失败，原文已保留', true);
  } else {
    toast(r.cached ? '已使用保存的译文' : '翻译完成');
    if (r.numberCheck && !r.numberCheck.ok) toast(r.numberCheck.note, true);
  }
  await reloadTranslations(paperId);
}

async function translateAll(paperId, force, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span>翻译中（篇名/关键词/摘要）…'; }
  const r = await api('/api/translate/' + paperId, { method: 'POST', body: { all: true, force } });
  if (btn) { btn.disabled = false; btn.textContent = force ? '全部重新翻译' : '一键翻译（篇名 / 关键词 / 摘要）'; }
  if (!r.ok && r.errors && r.errors.length) {
    const first = r.errors[0];
    toast(`部分字段未能翻译：${first.field} — ${first.error}`, true);
  } else if (r.ok) {
    toast(force ? '已全部重新翻译' : '翻译完成');
  }
  await reloadTranslations(paperId);
}

async function reloadTranslations(paperId) {
  const d = await api('/api/translate/' + paperId);
  if (!d.ok) return;
  state.translations = d;
  if ($('#transBox') && state.currentPaper) {
    $('#transBox').innerHTML = renderTranslations(state.currentPaper, state.vocabulary, d);
  }
}

function interpHtml(it, knownSids) {
  const scopeLabel = { metadata: '依据：仅题名/元数据', abstract: '依据：题名/元数据 + 摘要', fulltext: '依据：题名/元数据 + 摘要 + 全文', mixed: '依据：混合', uploaded: '依据：你上传的全文' }[it.evidenceScope] || '依据：' + it.evidenceScope;
  const weak = it.evidenceScope === 'metadata' || it.evidenceScope === 'abstract';
  const g = it.grounding || {};
  const modeLabel = { quick: '快速解读', deep: '深入解读', followup: '追问' }[it.mode] || it.mode;
  return `
  <div class="interp" data-interp="${it.id}">
    <div class="interp-head">
      <span class="tag topic">${esc(modeLabel)}</span>
      ${weak ? `<span class="tag pending">${esc(scopeLabel)}</span>` : `<span class="tag elig">${esc(scopeLabel)}</span>`}
      <span class="muted tiny">${esc(it.model || '')} · ${esc(fmtDateTime(it.createdAt))} 北京时间${it.tokens ? ' · ' + it.tokens + ' tokens' : ''}</span>
      <span class="right"></span>
      <button class="btn ghost small danger" onclick="deleteInterp(${it.id}, ${state.currentPaper ? state.currentPaper.id : 0})">删除</button>
    </div>
    ${it.question ? `<div class="qa"><div class="q">我的追问：${esc(it.question)}</div></div>` : ''}
    <div class="evidence-note ${weak ? 'weak' : ''}">${esc(it.evidenceNote || scopeLabel)}</div>
    ${it.hasSnapshot === false ? `<div class="banner warn small" style="margin:8px 0">
      <b>旧解读无可回溯材料。</b>
      这条解读生成时还没有保存所依据的原文片段，因此正文里的 <span class="cite cite-dead">[S1]</span> 这类编号
      只能作为位置标记，无法点击查看原文。
      <div class="btn-row" style="margin-top:7px">
        <button class="btn small primary" onclick="regenerateInterpretation(${it.paperId || (state.currentPaper && state.currentPaper.id)}, '${esc(it.mode)}', this)">
          生成一条带材料快照的新解读
        </button>
        <span class="tiny">会新增一条记录，<b>原有解读不会被删除或修改</b>，两条可以对照着看。</span>
      </div>
    </div>` : ''}
    <div class="md" data-interp-host="1"
         data-interp-id="${attr(it.id)}"
         data-has-snapshot="${it.hasSnapshot === true ? '1' : '0'}"
         data-known-sids="${attr((knownSids || []).join(','))}"
         data-evidence-scope="${attr(it.evidenceScope || '')}"
         data-content-b64="${attr(stashContent(it.content))}"
         data-snapshot-count="${attr(it.materialCount || 0)}"></div>
    <div class="tiny muted" style="margin-top:10px">
      引用核对：共 ${g.totalMaterials ?? '?'} 条可用材料，模型引用了 ${(g.citedIds || []).length} 条${(g.bogusIds || []).length ? `，另有 ${(g.bogusIds || []).length} 处无效引用编号已被移除` : ''}。
      ${g.truncated ? '（材料超长已截断）' : ''}
    </div>
    <div class="snapshot-line">
      ${it.hasSnapshot === false
        ? '<span class="tag pending">无材料快照（旧解读）</span><span class="tiny muted">这条解读生成时还没有保存原文片段，编号无法回溯。重新生成一次即可获得快照。</span>'
        : `<button class="btn small" onclick="showEvidence(${it.id})">查看这条解读的全部依据材料${it.materialCount ? '（' + it.materialCount + ' 条）' : ''}</button>
           <span class="tiny muted">点击正文里的 [S1] 可以直接跳到对应片段</span>`}
    </div>
  </div>`;
}

async function runInterpret(paperId, mode, btn) {
  const box = $('#interpBox');
  const label = mode === 'deep' ? '深入解读' : '快速解读';
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${label}中…`; }
  box.innerHTML = `<div class="banner info small"><span class="spinner dark"></span>正在生成${label}。深入解读需要更长时间，请稍候。解读只在你的机器与 AI 服务之间进行。</div>`;
  const r = await api('/api/interpret', { method: 'POST', body: { paperId, mode } });
  if (btn) { btn.disabled = false; btn.textContent = label; }
  if (!r.ok) {
    box.innerHTML = `<div class="banner danger"><strong>未能生成解读。</strong>${esc(r.error || '')}
      ${r.ruleSummary ? `<div class="sep"></div><div class="small">${esc(r.ruleSummary.label)}<br>题名：${esc(r.ruleSummary.title)}<br>期刊：${esc(r.ruleSummary.journal || '—')}<br>摘要：${r.ruleSummary.abstractAvailable ? '有' : '无'} · 方法线索：${esc((r.ruleSummary.methodSignals || []).join('、') || '未识别')}</div>` : ''}
    </div>`;
    return;
  }
  // 新解读一定有快照；把编号集合传进去，渲染时逐个核验
  const known = new Set(r.materials ? r.materials.map((m) => m.id) : []);
  state.lastInterpResult = {
    id: r.id, mode, question: null, title: `本次${label}结果`,
    evidenceScope: r.evidenceScope, evidenceNote: r.evidenceNote,
    model: r.model, content: r.content, grounding: r.grounding, tokens: r.tokens,
    createdAt: r.createdAt || null, paperId,
    hasSnapshot: r.snapshot ? r.snapshot.hasSnapshot : true,
    materialCount: r.snapshot ? r.snapshot.saved : 0,
    knownSids: [...known],
  };
  renderInterpResult(state.lastInterpResult);
  // 「本次结果」已经渲染，但「解读记录」列表与计数必须同时跟上，
  // 否则会出现「上面 6 条、下面 0 条」，要手动刷新才对。
  await syncInterpHistory(paperId);
}

async function askFollowup(paperId, btn) {
  const q = $('#askBox').value.trim();
  if (!q) { toast('请先输入追问内容', true); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>思考中…';
  const box = $('#interpBox');
  box.innerHTML = `<div class="banner info small"><span class="spinner dark"></span>正在回答你的追问…</div>`;
  const r = await api('/api/interpret', { method: 'POST', body: { paperId, mode: 'followup', question: q } });
  btn.disabled = false; btn.textContent = '提交追问';
  if (!r.ok) { box.innerHTML = `<div class="banner danger">${esc(r.error)}</div>`; return; }
  const knownF = new Set(r.materials ? r.materials.map((m) => m.id) : []);
  state.lastInterpResult = {
    id: r.id, mode: 'followup', question: q, title: '',
    evidenceScope: r.evidenceScope, evidenceNote: r.evidenceNote,
    model: r.model, content: r.content, grounding: r.grounding, tokens: r.tokens,
    createdAt: r.createdAt || null, paperId,
    hasSnapshot: r.snapshot ? r.snapshot.hasSnapshot : true,
    materialCount: r.snapshot ? r.snapshot.saved : 0,
    knownSids: [...knownF],
  };
  renderInterpResult(state.lastInterpResult);
  $('#askBox').value = '';
  await syncInterpHistory(paperId);
}

async function previewEvidence(paperId) {
  const r = await api('/api/preview/' + paperId);
  if (!r.ok) { toast(r.error, true); return; }
  openModal(`
    <h2>AI 解读可以依据的材料</h2>
    <div class="sep"></div>
    <div class="evidence-note ${r.evidenceScope === 'fulltext' ? '' : 'weak'}">${esc(r.evidenceNote)}</div>
    <p class="small muted">共 ${r.materialCount} 条材料${r.truncated ? '（超长已截断）' : ''}。模型只能引用这些编号。</p>
    <h3 style="font-size:14px;margin-top:12px">元数据</h3>
    <pre class="small" style="white-space:pre-wrap;background:var(--panel-2);padding:10px;border-radius:6px">${esc(r.metadata)}</pre>
    <h3 style="font-size:14px;margin-top:12px">材料编号预览</h3>
    <div class="table-wrap" style="max-height:260px"><table><tbody>
      ${r.materials.slice(0, 120).map((m) => `<tr><td class="mono tiny" style="width:44px">[${esc(m.id)}]</td><td class="tiny">${esc(m.preview)}…</td></tr>`).join('')}
    </tbody></table></div>
    <div class="btn-row" style="margin-top:14px"><button class="btn" onclick="closeModal()">关闭</button></div>
  `);
}

async function ruleSummary(paperId) {
  const r = await api('/api/preview/' + paperId);
  if (!r.ok || !r.ruleSummary) { toast('无法获取', true); return; }
  const s = r.ruleSummary;
  openModal(`
    <h2>规则版速览（非 AI 解读）</h2>
    <div class="banner warn small">${esc(s.label)}。这部分内容由本地规则从元数据生成，不含任何 AI 推断，也不能替代对原文的阅读。</div>
    <dl class="meta-grid">
      <dt>题名</dt><dd>${esc(s.title)}</dd>
      <dt>期刊</dt><dd>${esc(s.journal || '—')}</dd>
      <dt>日期</dt><dd>在线 ${fmtDate(s.dates.online)} · 出版 ${fmtDate(s.dates.print)} · 发现 ${fmtDate(s.dates.discovery)}</dd>
      <dt>摘要</dt><dd>${s.abstractAvailable ? '有（可在详情页阅读）' : '无'}</dd>
      <dt>方法线索</dt><dd>${esc((s.methodSignals || []).join('、') || '未从题名/摘要中识别到')}</dd>
      <dt>主题命中</dt><dd>${Object.entries(s.topicHits || {}).map(([k, v]) => `${esc(k)}: ${v}`).join('；') || '—'}</dd>
      <dt>开放获取</dt><dd>${s.openAccess ? '是（' + esc(s.oaStatus || '') + '）' : '否/未知'}</dd>
    </dl>
    <div class="btn-row" style="margin-top:14px"><button class="btn" onclick="closeModal()">关闭</button></div>
  `);
}

/* ---------------------- 证据快照：点击 [S1] 查看原文 ---------------------- */

async function showEvidence(interpId, sid) {
  const url = sid ? `/api/evidence/${interpId}?sid=${encodeURIComponent(sid)}` : `/api/evidence/${interpId}`;
  const r = await api(url);
  if (!r.ok) { toast(r.error || '无法读取材料', true); return; }

  // 没有快照的旧解读：明确提示，绝不伪装成可回溯
  if (r.hasSnapshot === false) {
    openModal(`
      <h2>依据材料不可回溯</h2>
      <div class="sep"></div>
      <div class="banner warn">${esc(r.message || '这条解读没有保存材料快照。')}</div>
      ${r.paper ? `<div class="small">论文：<a href="#/paper/${r.paper.id}" onclick="closeModal();return goPaper(${r.paper.id})">${esc(r.paper.title)}</a></div>` : ''}
      <div class="btn-row" style="margin-top:14px"><button class="btn" onclick="closeModal()">关闭</button></div>
    `);
    return;
  }

  const paperLink = r.paper
    ? `<div class="btn-row" style="margin-top:10px">
         <a class="btn small" href="#/paper/${r.paper.id}" onclick="closeModal();return goPaper(${r.paper.id})">打开论文详情</a>
         ${r.paper.url ? `<a class="btn small" href="${attr(r.paper.url)}" target="_blank" rel="noopener">打开原文</a>` : ''}
         ${r.paper.doi_norm ? `<a class="btn small" href="https://doi.org/${attr(r.paper.doi_norm)}" target="_blank" rel="noopener">DOI</a>` : ''}
       </div>`
    : '';

  if (sid && r.found) {
    const m = r.material;
    openModal(`
      <h2>材料 ${esc(sid)} 的原文片段</h2>
      <div class="sep"></div>
      <div class="materials-meta">
        <span class="tag ${m.scope === 'fulltext' ? 'elig' : 'src'}">${m.scope === 'fulltext' ? '全文' : (m.scope === 'abstract' ? '摘要' : '题名与元数据')}</span>
        ${m.section ? `<span class="tag src">章节：${esc(m.section)}</span>` : ''}
        <span class="tiny muted">${esc(m.sourceLabel || '')}</span>
        <span class="tiny muted">${m.charCount} 字符</span>
        ${m.cited ? '<span class="tag elig">模型引用了它</span>' : ''}
      </div>
      <div class="material-text">${esc(m.text)}</div>
      <div class="banner info small" style="margin-top:10px">${esc(r.caveat || '')}</div>
      <div class="tiny muted">这是生成该解读时保存的材料快照（${esc(fmtDateTime(r.createdAt))}），不是论文当前的最新内容；论文摘要或全文后来可能已经变化。</div>
      ${paperLink}
      <div class="btn-row" style="margin-top:12px"><button class="btn" onclick="closeModal()">关闭</button></div>
    `);
    return;
  }

  if (sid && !r.found) {
    openModal(`
      <h2>找不到材料 ${esc(sid)}</h2>
      <div class="sep"></div>
      <div class="banner warn">${esc(r.message || '')}</div>
      ${paperLink}
      <div class="btn-row" style="margin-top:12px"><button class="btn" onclick="closeModal()">关闭</button></div>
    `);
    return;
  }

  // 列出全部材料
  const citedIds = new Set((state.currentPaper && state.currentPaper._citedIds) || []);
  openModal(`
    <h2>这条解读的全部依据材料</h2>
    <div class="sep"></div>
    <div class="evidence-note">${esc(r.evidenceNote || '')}</div>
    <div class="tiny muted" style="margin-bottom:8px">
      共 ${r.materials.length} 条。模型生成于 ${esc(fmtDateTime(r.createdAt))}${r.model ? '，模型 ' + esc(r.model) : ''}。
      编号存在只说明模型引用了该片段，不代表片段足以支撑结论。
    </div>
    <div class="table-wrap" style="max-height:56vh">
      <table><tbody>
        ${r.materials.map((m) => `<tr>
          <td class="mono tiny" style="width:46px">[${esc(m.sid)}]</td>
          <td class="tiny" style="width:78px">${m.scope === 'fulltext' ? '全文' : (m.scope === 'abstract' ? '摘要' : '元数据')}${
            m.section ? '<div class="muted">' + esc(m.section) + '</div>' : ''}</td>
          <td>${esc(m.text.slice(0, 260))}${m.text.length > 260 ? '…' : ''}
            <div class="tiny muted">${esc(m.sourceLabel || '')}${m.cited ? ' · <b>模型引用了它</b>' : ''}</div></td>
        </tr>`).join('')}
      </tbody></table>
    </div>
    ${paperLink}
    <div class="btn-row" style="margin-top:12px"><button class="btn" onclick="closeModal()">关闭</button></div>
  `);
}

/**
 * 把页面上所有 [data-interp-host] 的正文填进去。
 * 必须在容器已经插入 DOM 之后调用：引用编号的渲染依赖容器上的 dataset。
 */
function hydrateInterpretations(root) {
  const scope = root || document;
  $$('[data-interp-host]', scope).forEach((el) => {
    if (el.dataset.hydrated === '1') return;
    const src = el.dataset.contentB64;
    if (!src) return;
    let md = '';
    try { md = decodeURIComponent(escape(atob(src))); } catch { md = ''; }
    el.innerHTML = renderMarkdown(md, el);
    el.dataset.hydrated = '1';
  });
}

/** 正文原文以 base64 暂存，避免 HTML 属性转义问题 */
function stashContent(md) {
  try { return btoa(unescape(encodeURIComponent(String(md || '')))); } catch { return ''; }
}

/**
 * 为旧解读生成一条带材料快照的新记录。
 * 关键：不删除、不修改原记录——旧解读作为历史保留，新记录可逐条回溯。
 */
async function regenerateInterpretation(paperId, mode, btn) {
  if (!paperId) { toast('无法确定论文', true); return; }
  const m = (mode === 'deep' || mode === 'quick') ? mode : 'quick';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span>重新解读中…'; }
  const r = await api('/api/interpret', { method: 'POST', body: { paperId, mode: m } });
  if (btn) { btn.disabled = false; btn.textContent = '生成一条带材料快照的新解读'; }
  if (!r.ok) { toast(r.error || '生成失败', true); return; }
  toast('已新增一条带材料快照的解读，旧记录保持不变');
  // 不整页重绘（会清掉「本次结果」），只同步历史列表与计数
  await viewPaper(paperId, { keepInterpBox: true });
}

async function deleteInterp(id, paperId) {
  if (!confirm('删除这条解读记录？')) return;
  await api('/api/interpret/' + id, { method: 'DELETE' });
  toast('已删除');
  if (paperId) await viewPaper(paperId, { keepInterpBox: true });
}

async function saveNote(paperId, btn) {
  const note = $('#noteBox').value;
  btn.disabled = true;
  const r = await api('/api/library/note/' + paperId, { method: 'POST', body: { note } });
  btn.disabled = false;
  if (r.ok) { $('#noteSaved').textContent = '已保存 ' + fmtBeijing(r.savedAt || new Date()); }
  else toast(r.error, true);
}

async function showFulltext(paperId) {
  const r = await api('/api/fulltext/' + paperId);
  if (!r.ok) { toast(r.error, true); return; }
  openModal(`
    <h2>全文抽取文本</h2>
    <div class="banner warn small">${esc(r.fulltext.note || '')}</div>
    <div class="tiny muted">识别章节：${esc((r.fulltext.sections || []).map((s) => s.heading).join(' / ') || '未识别')}</div>
    <pre style="white-space:pre-wrap;max-height:52vh;overflow:auto;background:var(--panel-2);padding:12px;border-radius:6px;font-size:12px;line-height:1.7">${esc(r.fulltext.content.slice(0, 60000))}</pre>
    <div class="btn-row" style="margin-top:12px"><button class="btn" onclick="closeModal()">关闭</button></div>
  `);
}

function uploadFulltext(paperId) {
  openModal(`
    <h2>上传我自己的 PDF</h2>
    <div class="banner info small">文件保存在本机 <span class="mono">data/uploads/</span>，只用于你自己的解读。系统会尝试解析 PDF 的文字层；扫描件没有文字层时会提示无法用于文本解读。</div>
    <input type="file" id="pdfFile" accept="application/pdf">
    <div id="upStatus" class="small muted" style="margin-top:10px"></div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn primary" onclick="doUpload(${paperId})">开始上传并解析</button>
      <button class="btn" onclick="closeModal()">取消</button>
    </div>
  `);
}

async function doUpload(paperId) {
  const f = $('#pdfFile').files[0];
  if (!f) { toast('请选择 PDF 文件', true); return; }
  const st = $('#upStatus');
  st.innerHTML = '<span class="spinner dark"></span>正在上传并解析…';
  const buf = new Uint8Array(await f.arrayBuffer());
  const r = await api(`/api/fulltext/upload/${paperId}`, {
    method: 'POST', body: buf,
    headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(f.name) },
  });
  if (!r.ok) { st.innerHTML = `<span style="color:var(--danger)">${esc(r.error)}</span>`; return; }
  st.innerHTML = `完成：${r.charCount} 字符 / ${r.pages} 页${r.scanned ? '（未检测到文字层）' : ''}`;
  toast(r.scanned ? '已保存，但未检测到文字层' : '全文已解析并保存');
  setTimeout(() => { closeModal(); viewPaper(paperId); }, 900);
}

async function deleteFulltext(paperId, btn) {
  if (!confirm('删除已保存的全文？')) return;
  await api('/api/fulltext/' + paperId, { method: 'DELETE' });
  toast('已删除全文');
  viewPaper(paperId);
}

async function enrichPaper(paperId, btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span>查询中…';
  const r = await api('/api/fulltext/resolve/' + paperId, { method: 'POST', body: {} });
  btn.disabled = false; btn.textContent = '补全开放获取与摘要';
  if (!r.ok) { toast(r.error, true); return; }
  toast((r.notes || []).join('；') || '无新增信息');
  viewPaper(paperId);
}

async function verifyJournal(journalId, paperId) {
  if (!journalId) { toast('该论文未匹配到本地期刊记录', true); return; }
  const r = await api('/api/journals/verify/' + journalId, { method: 'POST', body: {} });
  if (!r.ok) { toast(r.error, true); return; }
  openModal(`
    <h2>期刊自动核验结果：${esc(r.journal)}</h2>
    <div class="sep"></div>
    <table><tbody>
      ${r.checks.map((c) => `<tr>
        <td style="width:90px"><b>${esc(c.source)}</b></td>
        <td>${c.ok
          ? (c.title ? `刊名：${esc(c.title)}${c.publisher ? '<br><span class="muted tiny">出版商：' + esc(c.publisher) + '</span>' : ''}${c.inDoaj ? '<br><span class="tag oa">DOAJ 收录</span>' : ''}` : '<span class="muted">未收录 / 无记录</span>')
          : `<span style="color:var(--danger)">失败：${esc(c.error || '')}</span>`}</td>
      </tr>`).join('')}
    </tbody></table>
    <div class="banner warn small" style="margin-top:12px">${esc(r.note)}</div>
    ${r.nameMatches === false ? '<div class="banner danger small">注意：Crossref 上的刊名与本地记录不一致，请人工确认是否为同一刊物。</div>' : ''}
    <div class="btn-row" style="margin-top:12px"><button class="btn" onclick="closeModal()">关闭</button></div>
  `);
}

/* ============================== 视图：收藏 ============================== */

async function viewLibrary() {
  const main = $('#main');
  main.innerHTML = '<div class="loading">正在读取收藏…</div>';
  const [lib, topics] = await Promise.all([api('/api/library'), api('/api/topics')]);
  if (!lib.ok) { main.innerHTML = `<div class="banner danger">${esc(lib.error)}</div>`; return; }
  state.topics = topics.topics || [];
  const s = lib.stats;

  main.innerHTML = `
    <div class="page-head">
      <div><h1>我的收藏</h1>
        <div class="page-sub">收藏状态保存在本机数据库，关闭与重启后仍然存在</div></div>
      <div class="btn-row"><button class="btn" onclick="exportLibrary()">导出收藏 JSON</button></div>
    </div>
    <div class="stat-row card">
      <div class="stat"><b>${s.starred}</b>已收藏</div>
      <div class="stat"><b>${s.unread}</b>待读</div>
      <div class="stat"><b>${s.reading}</b>在读</div>
      <div class="stat"><b>${s.read}</b>已读</div>
      <div class="stat"><b>${s.interpretations}</b>解读记录</div>
      <div class="stat"><b>${s.eligiblePapers}</b>期刊条件合格<br><span class="tiny">（官方目录）</span></div>
      <div class="stat"><b>${s.referencePapers || 0}</b>参考候选</div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="grid-3">
        <label class="field"><span>阅读状态</span>
          <select id="fRead" onchange="loadLibraryList()">
            <option value="">全部</option><option value="unread">待读</option>
            <option value="reading">在读</option><option value="read">已读</option>
          </select></label>
        <label class="field"><span>语言</span>
          <select id="fLang" onchange="loadLibraryList()">
            <option value="">全部</option><option value="zh">中文</option><option value="en">英文</option>
          </select></label>
        <label class="field"><span>主题</span>
          <select id="fTopic" onchange="loadLibraryList()">
            <option value="">全部</option>
            ${state.topics.map((t) => `<option value="${attr(t.slug)}">${esc(t.name_zh)}</option>`).join('')}
          </select></label>
        <label class="field"><span>期刊名包含</span><input type="text" id="fJournal" placeholder="如 Applied Linguistics" oninput="debounce(loadLibraryList)"></label>
        <label class="field"><span>发表日期从</span><input type="date" id="fFrom" onchange="loadLibraryList()"></label>
        <label class="field"><span>到</span><input type="date" id="fTo" onchange="loadLibraryList()"></label>
      </div>
      <label class="field"><span>关键词（题名/摘要/作者/备注）</span><input type="text" id="fQ" placeholder="输入后自动筛选" oninput="debounce(loadLibraryList)"></label>
      <div class="btn-row">
        <button class="btn small" onclick="clearLibFilters()">清空筛选</button>
        <label class="checkline" style="margin:0"><input type="checkbox" id="fAll" onchange="loadLibraryList()"> 显示全部（含未收藏）</label>
      </div>
    </div>

    <div id="libList" class="section"><div class="loading">加载中…</div></div>
  `;
  loadLibraryList();
}

let _deb = null;
function debounce(fn) { clearTimeout(_deb); _deb = setTimeout(fn, 420); }

async function loadLibraryList() {
  const q = new URLSearchParams();
  const g = (id) => $(id) ? $(id).value : '';
  if (g('#fRead')) q.set('read_state', g('#fRead'));
  if (g('#fLang')) q.set('language', g('#fLang'));
  if (g('#fTopic')) q.set('topic', g('#fTopic'));
  if (g('#fJournal')) q.set('journal', g('#fJournal'));
  if (g('#fFrom')) q.set('from', g('#fFrom'));
  if (g('#fTo')) q.set('to', g('#fTo'));
  if (g('#fQ')) q.set('q', g('#fQ'));
  if ($('#fAll') && $('#fAll').checked) q.set('all', '1');

  const r = await api('/api/library?' + q.toString());
  const box = $('#libList');
  if (!r.ok) { box.innerHTML = `<div class="banner danger">${esc(r.error)}</div>`; return; }
  if (!r.items.length) { box.innerHTML = '<div class="empty">没有符合条件的收藏。<br><span class="small">在今日简报里点「☆ 收藏」把论文加入这里。</span></div>'; return; }

  box.innerHTML = `<div class="section-head"><h2>收藏列表</h2><span class="muted small">${r.items.length} 条</span></div>` +
    r.items.map((it) => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;gap:12px">
        <div style="min-width:0">
          <div class="brief-title" style="font-size:15.5px"><a href="#/paper/${it.id}" onclick="return goPaper(${it.id})">${esc(it.title)}</a></div>
          <div class="brief-meta">${esc((it.authors || []).slice(0, 5).join('；'))}<br>
            <b>${esc(it.journal_name || '—')}</b> · ${fmtDate(it.published_online || it.issued_date)} · ${esc(it.doi || '无 DOI')}</div>
          <div class="tags" style="margin-bottom:6px">
            ${langTag(it.language)} ${eligTag(it.eligibility, it.eligibility_basis)}
            <span class="tag src">${readStateLabel(it.read_state)}</span>
            ${it.interpretations ? `<span class="tag topic">${it.interpretations} 条解读</span>` : ''}
            ${(it.topics || []).map((t) => `<span class="tag topic">${esc(t.name)}</span>`).join('')}
          </div>
          ${(it.journal_tags || []).length ? `<div class="tags" style="margin-bottom:6px">${it.journal_tags.map(journalTagHtml).join('')}</div>` : ''}
          <textarea style="margin-top:10px" placeholder="个人备注…" onchange="saveNoteInline(${it.id}, this)">${esc(it.note || '')}</textarea>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;white-space:nowrap">
          <button class="btn small" onclick="toggleStar(${it.id}, false, this, true)">★ 取消收藏</button>
          <button class="btn small" onclick="goPaper(${it.id})">详情</button>
          <button class="btn small danger" onclick="removeLib(${it.id})">删除</button>
        </div>
      </div>
    </div>`).join('');
}

async function saveNoteInline(paperId, el) {
  const r = await api('/api/library/note/' + paperId, { method: 'POST', body: { note: el.value } });
  if (r.ok) toast('备注已保存'); else toast(r.error, true);
}

async function removeLib(paperId) {
  if (!confirm('从收藏中删除这篇论文的收藏记录？（论文本身与解读记录保留）')) return;
  await api('/api/library/' + paperId, { method: 'DELETE' });
  toast('已从收藏移除');
  loadLibraryList();
  refreshFoot();
}

async function exportLibrary() {
  const r = await api('/api/library?all=1&limit=1000');
  const blob = new Blob([JSON.stringify(r.items || [], null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `收藏导出-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast('已导出');
}

function clearLibFilters() {
  readerUI.libraryTag = '';
  ['#fRead', '#fLang', '#fTopic', '#fJournal', '#fFrom', '#fTo', '#fQ'].forEach((id) => { if ($(id)) $(id).value = ''; });
  if ($('#fAll')) $('#fAll').checked = false;
  loadLibraryList();
}

/* ============================== 视图：主题与检索词 ============================== */

async function viewTopics() {
  const main = $('#main');
  const r = await api('/api/topics');
  state.topics = r.topics || [];
  main.innerHTML = `
    <div class="page-head">
      <div><h1>主题与检索词</h1>
        <div class="page-sub">研究主题可编辑中英文检索词；首页分类可以交叉，细分主题继续保留。采集时每个检索词会分别送到 Crossref 与 OpenAlex。</div></div>
      <button class="btn primary" onclick="addTopic()">新增主题</button>
    </div>
    <div class="banner info small">主题范围的宽窄直接决定你每天看到什么。建议每个主题保留 5–8 条检索词：太窄会漏掉重要论文，太窄的检索词（如把一个小课题的完整标题当检索词）会让简报长期没有新论文。</div>
    ${state.topics.map(topicCard).join('')}
  `;
}

function topicCard(t) {
  return `
  <div class="card" data-topic="${t.id}">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <label class="field"><span>主题名称（中文）</span><input type="text" id="tname-${t.id}" value="${attr(t.name_zh)}"></label>
        <label class="field"><span>英文名称</span><input type="text" id="tnameen-${t.id}" value="${attr(t.name_en || '')}"></label>
      </div>
      <label class="checkline" style="margin-top:22px"><input type="checkbox" id="ten-${t.id}" ${t.enabled ? 'checked' : ''}> 启用采集</label>
    </div>
    <div class="grid-2">
      <div>
        <div class="small muted">中文检索词 <span class="tiny">（用于发现中文论文）</span></div>
        <div class="kw-list" id="kwzh-${t.id}">
          ${t.keywords_zh.map((k) => `<span class="kw">${esc(k)}<button onclick="removeKw(${t.id},'zh',${JSON.stringify(k).replace(/"/g, '&quot;')})">×</button></span>`).join('')}
        </div>
        <div class="btn-row"><input type="text" id="newzh-${t.id}" placeholder="输入中文检索词后回车" onkeydown="if(event.key==='Enter')addKw(${t.id},'zh')"></div>
      </div>
      <div>
        <div class="small muted">英文检索词 <span class="tiny">（用于发现英文论文）</span></div>
        <div class="kw-list" id="kwen-${t.id}">
          ${t.keywords_en.map((k) => `<span class="kw">${esc(k)}<button onclick="removeKw(${t.id},'en',${JSON.stringify(k).replace(/"/g, '&quot;')})">×</button></span>`).join('')}
        </div>
        <div class="btn-row"><input type="text" id="newen-${t.id}" placeholder="输入英文检索词后回车" onkeydown="if(event.key==='Enter')addKw(${t.id},'en')"></div>
      </div>
    </div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn primary small" onclick="saveTopic(${t.id})">保存主题</button>
      <button class="btn small danger" onclick="deleteTopic(${t.id})">删除主题</button>
      ${t.builtin ? '<span class="tiny muted">内置主题（可编辑，删除后不再自动恢复）</span>' : ''}
    </div>
  </div>`;
}

function topicById(id) { return state.topics.find((t) => t.id === Number(id)); }
function collectTopicForm(id) {
  const t = topicById(id);
  return {
    id: Number(id),
    name_zh: $('#tname-' + id).value.trim(),
    name_en: $('#tnameen-' + id).value.trim(),
    enabled: $('#ten-' + id).checked,
    keywords_zh: t ? [...t.keywords_zh] : [],
    keywords_en: t ? [...t.keywords_en] : [],
    sort_order: t ? t.sort_order : 100,
  };
}
function addKw(id, kind) {
  const input = $(`#new${kind}-${id}`);
  const v = input.value.trim();
  if (!v) return;
  const t = topicById(id);
  if (!t) return;
  const arr = kind === 'zh' ? t.keywords_zh : t.keywords_en;
  if (!arr.includes(v)) arr.push(v);
  input.value = '';
  saveTopic(id, true);
}
function removeKw(id, kind, kw) {
  const t = topicById(id);
  if (!t) return;
  if (kind === 'zh') t.keywords_zh = t.keywords_zh.filter((x) => x !== kw);
  else t.keywords_en = t.keywords_en.filter((x) => x !== kw);
  saveTopic(id, true);
}
async function saveTopic(id, silent) {
  const body = collectTopicForm(id);
  if (!body.name_zh) { toast('主题名称不能为空', true); return; }
  const r = await api('/api/topics/' + id, { method: 'PUT', body });
  if (!r.ok) { toast(r.error, true); return; }
  if (silent) { await reloadTopics(); viewTopics(); } else { toast('已保存'); await reloadTopics(); viewTopics(); }
}
async function reloadTopics() { const r = await api('/api/topics'); state.topics = r.topics || []; }

async function addTopic() {
  const name = prompt('新主题名称（中文）：');
  if (!name) return;
  const r = await api('/api/topics', { method: 'POST', body: { name_zh: name, keywords_zh: [], keywords_en: [], enabled: true } });
  if (!r.ok) { toast(r.error, true); return; }
  toast('已新增主题，请补充检索词');
  await reloadTopics(); viewTopics();
}
async function deleteTopic(id) {
  if (!confirm('删除该主题？已采集的论文不会被删除。')) return;
  await api('/api/topics/' + id, { method: 'DELETE' });
  await reloadTopics(); viewTopics(); toast('已删除');
}

/* ============================== 视图：期刊目录 ============================== */

async function viewJournals() {
  const main = $('#main');
  main.innerHTML = '<div class="loading">正在读取期刊数据…</div>';
  const [cat, list] = await Promise.all([api('/api/journals/catalogs'), api('/api/journals')]);
  const c = cat.catalogs || {};

  main.innerHTML = `
    <div class="page-head">
      <div><h1>期刊目录与核验</h1>
        <div class="page-sub">CSSCI / 北大核心 / SSCI-JCR / 中科院分区都必须由你导入官方目录，系统不代为猜测</div></div>
      <div class="btn-row">
        <button class="btn" onclick="revalidate(this)">按当前目录重新核验全部论文</button>
        <button class="btn" onclick="loadSeed(this)">重载参考识别表</button>
      </div>
    </div>

    <div class="card">
      <h3>色块图例</h3>
      <div class="sep"></div>
      <div class="tiny muted" style="margin-bottom:9px">
        每个色块里都写明了文字等级，不靠颜色单独表意。带 <b>✔</b> 的是官方目录已核验；
        带 <b>◇</b> 且为虚线描边的是参考名录（不计入合格）；带 <b>?</b> 的是待核验。
      </div>
      ${tierLegendHtml()}
    </div>

    <div class="card">
      <h3>参考分区名录（可选，默认关闭）</h3>
      <div class="sep"></div>
      <div class="banner warn small">
        程序附带一份覆盖本工作台主流期刊的<b>参考分区名录</b>（36 刊，依据 2023–2024 年公开的领域常识性判断）。
        它<b>不是</b>官方 JCR 目录，<b>一定不完整</b>，也可能过时。启用后：
        <br>· 据此判定合格的论文会标注「参考分区（非官方目录）」，与官方目录导入的结果在界面上有区别；
        <br>· 中科院分区不包含在这份名录里（该表 2026 年起不再更新，请导入官方历史数据）；
        <br>· CSSCI 与北大核心<b>没有任何</b>参考数据，必须由你导入。
      </div>
      <label class="checkline"><input type="checkbox" id="jcrRefConfirm"> 我已了解上述限制，仍要启用参考分区名录</label>
      <div class="btn-row">
        <button class="btn" onclick="loadJcrRef(this)">载入参考分区名录并重新核验</button>
      </div>
    </div>

    <div class="banner warn">
      <strong>关于期刊资格的重要说明。</strong>
      本工作台不会用网页搜索结果去猜分区，也不会编造收录信息。目前本地期刊记录共 <b>${cat.totalJournals}</b> 条，
      其中经官方目录导入而<b>认定为已核验</b>的有 <b>${cat.verifiedJournals}</b> 条。
      <br>· <b>英文刊规则</b>：必须<b>已确认 SSCI 收录</b>，并且 JCR Q1–Q3 或中科院 1–3 区之一。仅有中科院分区、无法确认 SSCI 收录时列为待核验（JCR 也收录 SCIE 期刊，不能只看分区）。
      <br>· <b>中文刊规则</b>：CSSCI 来源期刊或《中文核心期刊要目总览》收录；CSSCI 扩展版默认不算。
      <br>· <b>参考线索</b>（随程序附带的参考名录，或你导入的截图清单）只会给出「参考候选」：
      可以进入主题优先的今日简报（醒目标注为参考候选），但<b>不计入</b>「期刊条件合格」数量，也<b>不进</b>「期刊条件合格精选」页。
      <br>· <b>待核验</b>同理：可以进今日简报并明确标示，但不计入合格。
      <br>· 中科院期刊分区表自 2026 年起不再更新发布，只能录入最后可核实年份的历史数据，系统会强制标注年份。
      <br>· JCR 分区与中科院分区<b>分别显示</b>，不合并为一个「综合等级」；某刊有多个 JCR 学科类别时逐个类别保留。
    </div>

    <div class="section">
      <div class="section-head"><h2>目录导入</h2><span class="muted small">支持含表头的 CSV；也可直接在表格里粘贴（第一行为表头）</span></div>
      <div class="grid-2">
        ${Object.values(c).map(catalogCard).join('')}
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>期刊清单</h2>
        <input type="text" id="jQ" placeholder="按刊名 / ISSN 搜索" style="max-width:280px" oninput="debounce(loadJournals)">
        <span class="muted small">${list.journals.length} 条</span>
      </div>
      <div id="journalTable">${journalTableHtml(list.journals)}</div>
    </div>
  `;
}

function catalogCard(c) {
  return `
  <div class="card">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
      <div><h3>${esc(c.label)}</h3>
        <div class="tiny muted" style="margin-top:4px">${esc(c.hint)}</div></div>
      <span class="tag ${c.loaded ? 'elig' : 'pending'}">${c.loaded ? '已导入' : '未导入'}</span>
    </div>
    <div class="sep"></div>
    <div class="small">
      覆盖：${esc(c.coverage)}<br>
      最后更新：${c.lastUpdate ? esc(fmtDateTime(c.lastUpdate)) : '—'}<br>
      状态：<span class="${c.status === 'ok' ? '' : 'muted'}">${c.status === 'ok' ? '正常' : '缺失（该目录未导入，相关论文只能进入待核验）'}</span>
    </div>
    <div class="sep"></div>
    <label class="field"><span>版次 / 年份（会写入每条记录）</span>
      <input type="text" id="ed-${c.key}" placeholder="如 2023-2024年版 / 2024"></label>
    <label class="field"><span>粘贴 CSV 内容</span>
      <textarea id="csv-${c.key}" placeholder="第一行为表头。标准列：${attr(c.fields.join(', '))}"></textarea></label>
    <div class="btn-row">
      <button class="btn primary small" onclick="importCatalog('${c.key}', this)">导入</button>
      <button class="btn small" onclick="downloadTemplate('${c.key}')">下载模板</button>
      <input type="file" id="file-${c.key}" accept=".csv,text/csv" style="display:none" onchange="readCsvFile('${c.key}', this)">
      <button class="btn small" onclick="document.getElementById('file-${c.key}').click()">选择 CSV 文件</button>
    </div>
  </div>`;
}

function journalTableHtml(list) {
  return `<div class="table-wrap"><table>
    <thead><tr><th style="width:210px">刊名</th><th style="width:100px">ISSN</th><th style="width:60px">语言</th>
      <th style="width:64px">核验</th><th>目录记录与分区</th><th style="width:176px">操作</th></tr></thead>
    <tbody>${list.map((j) => `<tr>
      <td>${esc(j.name)}${j.publisher ? `<div class="tiny muted">${esc(j.publisher)}</div>` : ''}</td>
      <td class="mono tiny">${esc(j.issn || '—')}</td>
      <td>${j.language === 'zh' ? '中文' : '英文'}</td>
      <td>${j.verified
        ? '<span class="verdict eligible" title="来自官方目录导入">✔ 已核验</span>'
        : (j.eligibility?.hasReference
            ? '<span class="verdict reference" title="仅来自非官方参考名录">◇ 参考</span>'
            : '<span class="verdict pending">? 待核验</span>')}</td>
      <td class="tiny">
        ${j.eligibility?.tags?.length
          ? `<div class="tags" style="margin-bottom:5px">${j.eligibility.tags.map(journalTagHtml).join('')}</div>`
          : '<span class="verdict pending">? 无任何目录记录</span>'}
        ${j.catalogs.length
          ? j.catalogs.map((c) => `<div>${c.reference ? '◇ 参考名录（非官方）' : '✔ 官方目录已核验'}：${esc(c.catalog)}／${esc(c.edition || '未标版次')}`
              + `${c.ssciIndexed === false ? ' <span class="tag pending">标注为非 SSCI</span>' : ''}`
              + ` <span class="muted">（${esc(c.basis || '')}）</span></div>`).join('')
          : '<span class="muted">无目录记录</span>'}
      </td>
      <td>
        <div class="btn-row">
          <button class="btn small" onclick="verifyJournal(${j.id}, 0)">核验</button>
          <button class="btn small" onclick="toggleWhitelist(${j.id}, ${j.in_whitelist ? 'false' : 'true'}, false)">${j.in_whitelist ? '取消关注' : '重点关注'}</button>
          <button class="btn small danger" onclick="toggleWhitelist(${j.id}, false, ${j.in_blacklist ? 'false' : 'true'})">${j.in_blacklist ? '取消排除' : '排除'}</button>
        </div>
      </td>
    </tr>`).join('')}</tbody></table></div>`;
}

async function loadJournals() {
  const q = $('#jQ') ? $('#jQ').value : '';
  const r = await api('/api/journals' + (q ? '?q=' + encodeURIComponent(q) : ''));
  if (r.ok) $('#journalTable').innerHTML = journalTableHtml(r.journals);
}

async function importCatalog(key, btn) {
  const csv = $('#csv-' + key).value;
  const edition = $('#ed-' + key).value;
  if (!csv.trim()) { toast('请先粘贴 CSV 内容或选择文件', true); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>导入中…';
  const r = await api('/api/journals/import', { method: 'POST', body: { catalogKey: key, csv, edition } });
  btn.disabled = false; btn.textContent = '导入';
  if (!r.ok) { toast(r.error, true); if (r.detectedHeaders) toast('识别到的表头：' + r.detectedHeaders.join(' | '), true); return; }
  const s = r.stats;
  toast(`导入完成：${s.imported} 行，新建 ${s.createdJournals} 刊，更新 ${s.updatedJournals} 刊。重新核验：合格 ${r.revalidate.eligible} / 待核验 ${r.revalidate.pending}`);
  viewJournals();
  refreshFoot();
}

function readCsvFile(key, input) {
  const f = input.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { $('#csv-' + key).value = rd.result; toast('已读取 ' + f.name + '，请确认版次后点击导入'); };
  rd.readAsText(f, 'utf-8');
}

async function downloadTemplate(key) {
  const r = await api('/api/journals/template/' + key);
  if (!r.ok) { toast(r.error, true); return; }
  const blob = new Blob(['\uFEFF' + r.csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = r.filename;
  a.click();
}

async function toggleWhitelist(id, white, black) {
  await api('/api/journals/whitelist/' + id, { method: 'POST', body: { whitelist: white, blacklist: black } });
  toast('已更新'); loadJournals();
}

async function revalidate(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>核验中…';
  const r = await api('/api/revalidate', { method: 'POST', body: {} });
  btn.disabled = false; btn.textContent = '按当前目录重新核验全部论文';
  if (!r.ok) { toast(r.error, true); return; }
  toast(`重新核验 ${r.total} 篇：合格 ${r.eligible} · 待核验 ${r.pending} · 排除 ${r.excluded}`);
  refreshFoot();
}

async function loadJcrRef(btn) {
  const confirmBox = $('#jcrRefConfirm');
  if (!confirmBox || !confirmBox.checked) { toast('请先勾选确认复选框', true); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>载入中…';
  const r = await api('/api/journals/load-jcr-reference', { method: 'POST', body: { confirm: true } });
  btn.disabled = false; btn.textContent = '载入参考分区名录并重新核验';
  if (!r.ok) { toast(r.error, true); return; }
  toast(`已载入 ${r.期刊数} 刊的参考分区。重新核验：合格 ${r.revalidate.eligible} / 待核验 ${r.revalidate.pending}`);
  viewJournals(); refreshFoot();
}

async function loadSeed(btn) {
  btn.disabled = true;
  const r = await api('/api/journals/seed', { method: 'POST', body: {} });
  btn.disabled = false;
  toast(r.ok ? `参考识别表已加载：新增 ${r.added}，更新 ${r.updated}（版本 ${r.版本}，核验日期 ${r.核验日期}）` : r.error, !r.ok);
  viewJournals();
}

/* ============================== 视图：检索 / 添加 ============================== */

async function viewSearch() {
  const main = $('#main');
  main.innerHTML = `
    <div class="page-head"><div><h1>库内检索 / 添加论文</h1>
      <div class="page-sub">检索已采集的论文，按 DOI 添加，或导入中文数据库题录</div></div></div>

    <div class="card">
      <h3>按 DOI 添加</h3>
      <div class="sep"></div>
      <div class="btn-row">
        <input type="text" id="doiInput" placeholder="10.1017/S0272263121000010" style="max-width:420px">
        <button class="btn primary" onclick="addDoi(this)">从 Crossref / OpenAlex 获取并加入</button>
      </div>
      <div class="tiny muted" style="margin-top:8px">只读取公开元数据，不会下载付费全文。添加后仍会按期刊目录判定是否合格。</div>
    </div>

    <div class="card">
      <h3>导入中文数据库题录（CNKI / 万方 / 维普 自行导出的合法题录）</h3>
      <div class="sep"></div>
      <div class="banner warn small">
        <b>中文来源现状（如实说明，不夸大覆盖）：</b>CNKI、万方、维普都没有公开 API；而且实测确认，
        <b>真正被 CSSCI 收录的中文期刊极少在 Crossref 注册 DOI</b>
        （中国语文、世界汉语教学、语言教学与研究、外语教学与研究等查询结果均为 0 条），
        Crossref 上搜到的中文「教育类期刊」绝大多数来自非正规出版商、不具备 CSSCI/北大核心资格。
        <br><br>
        <b>已经自动覆盖的目前只有一本刊：</b>国家哲学社会科学文献中心《世界汉语教学》的公开目录页，
        随每日更新自动检查（已采集 2026 年第 2 期共 9 条题录，只有题名、作者、年/期/页码，
        <b>没有摘要与关键词</b>）。<b>其余中文期刊尚未自动覆盖</b>，
        需要你在有权访问的数据库里自行导出题录后粘贴到这里。
        <br><br>
        注意：该公开目录页只提供题录，<b>不作为 CSSCI / 北大核心的核验依据</b>。
      </div>
      <textarea id="bulkBox" placeholder="支持以下格式，直接粘贴即可：

① CNKI「导出/参考文献」文本（GB/T 7714）
张三. 汉语学习者语用能力发展研究[J]. 世界汉语教学, 2023, 37(2): 215-228.

② RefWorks 标签格式
RT Journal Article
A1 陈七
T1 人机协同教学中的教师角色研究
JF 中国电化教育
YR 2024
K1 人机协同;教师角色
AB 本研究探讨……

③ 带表头的 CSV / TSV（题名,刊名,作者,摘要,关键词,年）

④ JSON 数组" style="min-height:170px"></textarea>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn primary" onclick="parseImport(this)">先解析并预览期刊匹配</button>
        <input type="file" id="bulkFile" accept=".csv,.json,.txt,.ris,.refworks" style="display:none" onchange="readBulkFile(this)">
        <button class="btn" onclick="document.getElementById('bulkFile').click()">选择文件</button>
        <button class="btn" onclick="clearBulk()">清空</button>
      </div>
      <div id="importPreview" class="section"></div>
    </div>

    <div class="card">
      <h3>库内检索</h3>
      <div class="sep"></div>
      <div class="btn-row">
        <input type="text" id="pq" placeholder="题名 / 摘要 / 作者 / 期刊 / DOI" style="max-width:320px" onkeydown="if(event.key==='Enter')doSearch()">
        <select id="pe" style="width:auto">
          <option value="">全部资格</option>
          <option value="eligible">期刊条件合格（官方目录）</option>
          <option value="reference">参考候选（非官方名录）</option>
          <option value="pending">待核验</option>
          <option value="excluded">已排除</option>
        </select>
        <select id="pl" style="width:auto"><option value="">全部语言</option><option value="zh">中文</option><option value="en">英文</option></select>
        <button class="btn primary" onclick="doSearch()">检索</button>
      </div>
      <div id="searchResult" class="section"></div>
    </div>
  `;
}

/* ---------------------- 中文题录导入 ---------------------- */

let _importRecords = null;

function clearBulk() {
  $('#bulkBox').value = '';
  $('#importPreview').innerHTML = '';
  _importRecords = null;
}

async function parseImport(btn) {
  const text = $('#bulkBox').value.trim();
  if (!text) { toast('请粘贴或选择题录内容', true); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span>解析中…';
  const r = await api('/api/import/parse', { method: 'POST', body: { text } });
  btn.disabled = false; btn.textContent = '先解析并预览期刊匹配';
  if (!r.ok) {
    toast(r.error || '解析失败', true);
    $('#importPreview').innerHTML = `<div class="banner danger">${esc(r.error || '')}
      ${r.hint ? `<div class="small" style="margin-top:6px">${esc(r.hint)}</div>` : ''}</div>`;
    return;
  }
  _importRecords = r.records;
  const c = r.counts || {};
  const pv = r.preview || { byStatus: {}, samples: [] };
  const statusLabel = { eligible: '期刊条件合格', reference: '参考候选', pending: '待核验', excluded: '已排除' };

  $('#importPreview').innerHTML = `
    <div class="banner ok small">${esc(r.note)}
      ${r.otherFormatsDetected?.length ? `<div class="tiny" style="margin-top:4px">同时也能被这些格式解析：${esc(r.otherFormatsDetected.join('、'))}</div>` : ''}</div>
    ${r.warning ? `<div class="banner warn small">${esc(r.warning)}</div>` : ''}
    <div class="stat-row card">
      <div class="stat"><b>${c.total || 0}</b>解析出的题录</div>
      <div class="stat"><b>${c.withJournal || 0}</b>有刊名</div>
      <div class="stat"><b>${c.withAbstract || 0}</b>有摘要</div>
      <div class="stat"><b>${c.withKeywords || 0}</b>有关键词</div>
      <div class="stat"><b>${c.withDoi || 0}</b>有 DOI</div>
      <div class="stat"><b>${pv.matched || 0}</b>期刊已在本地目录匹配</div>
    </div>
    <div class="banner info small" style="margin-top:10px">
      期刊匹配预览：${Object.entries(pv.byStatus || {}).map(([k, v]) => `${statusLabel[k] || k} ${v} 条`).join('　·　') || '无'}
      ${pv.unmatched ? `<br><b>${pv.unmatched}</b> 条的期刊没有在本地目录中匹配到——它们会进入「待核验候选」。要判定它们，需要先导入 CSSCI / 北大核心目录。` : ''}
    </div>
    <div class="table-wrap" style="max-height:300px;margin-top:10px"><table>
      <thead><tr><th>题名</th><th style="width:190px">刊名</th><th style="width:110px">资格</th></tr></thead>
      <tbody>${(pv.samples || []).map((x) => `<tr>
        <td class="small">${esc(x.title)}</td>
        <td class="small">${esc(x.journalName || '—')}</td>
        <td>${eligTag(x.status)}</td>
      </tr>`).join('')}</tbody></table></div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary" onclick="commitImport(this)">确认导入这 ${c.total || 0} 条题录</button>
      <span class="muted small">导入后会自动按现有目录判定期刊资格</span>
    </div>
  `;
}

async function commitImport(btn) {
  if (!_importRecords || !_importRecords.length) { toast('请先解析题录', true); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span>导入中…';
  const r = await api('/api/import/commit', { method: 'POST', body: { records: _importRecords } });
  btn.disabled = false; btn.textContent = '确认导入';
  if (!r.ok) { toast(r.error, true); return; }
  const res = r.result || {};
  toast(`导入 ${r.count} 条：新增 ${res.inserted}，更新 ${res.updatedExisting}，官方目录合格 ${res.eligible}，参考候选 ${res.reference || 0}，待核验 ${res.pending}`);
  $('#importPreview').insertAdjacentHTML('afterbegin', `<div class="banner ok">已导入 ${r.count} 条题录。</div>`);
  refreshFoot();
}

async function addDoi(btn) {
  const doi = $('#doiInput').value.trim();
  if (!doi) { toast('请输入 DOI', true); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>获取中…';
  const r = await api('/api/papers/doi', { method: 'POST', body: { doi } });
  btn.disabled = false; btn.textContent = '从 Crossref / OpenAlex 获取并加入';
  if (!r.ok) { toast(r.error, true); return; }
  const res = r.result || {};
  toast(`已加入：新增 ${res.inserted || 0}，更新 ${res.updatedExisting || 0}，其中期刊条件合格 ${res.eligible || 0}，待核验 ${res.pending || 0}`);
  refreshFoot();
  if (r.paperId) goPaper(r.paperId);
}

function readBulkFile(input) {
  const f = input.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { $('#bulkBox').value = rd.result; toast('已读取 ' + f.name); };
  rd.readAsText(f, 'utf-8');
}

async function doSearch() {
  const q = new URLSearchParams();
  if ($('#pq').value) q.set('q', $('#pq').value);
  if ($('#pe').value) q.set('eligibility', $('#pe').value);
  if ($('#pl').value) q.set('language', $('#pl').value);
  const r = await api('/api/papers?' + q.toString());
  const box = $('#searchResult');
  if (!r.ok) { box.innerHTML = `<div class="banner danger">${esc(r.error)}</div>`; return; }
  if (!r.papers.length) { box.innerHTML = '<div class="empty">没有匹配的论文。</div>'; return; }
  box.innerHTML = `<div class="section-head"><h3>结果（${r.papers.length}）</h3></div>` + journalLikeTable(r.papers);
}

function journalLikeTable(list) {
  return `<div class="table-wrap"><table><thead><tr>
    <th>题名</th><th style="width:170px">期刊</th><th style="width:60px">语言</th>
    <th style="width:96px">日期</th><th style="width:96px">资格</th><th style="width:60px"></th>
  </tr></thead><tbody>${list.map((p) => `<tr>
    <td><a href="#/paper/${p.id}" onclick="return goPaper(${p.id})">${esc(p.title)}</a>
      <div class="tiny muted">${esc(p.doi || '')} ${(p.topics || []).map((t) => esc(t.name)).join(' · ')}</div></td>
    <td class="small">${esc(p.journal_name || '—')}
      <div class="tags" style="margin-top:4px">${(p.journal_tags || []).map(journalTagHtml).join('')}</div></td>
    <td>${langTag(p.language)}</td>
    <td class="small">${fmtDate(p.published_online || p.issued_date)}</td>
    <td>${eligTag(p.eligibility, p.eligibility_basis)}</td>
    <td><button class="btn ghost small" onclick="goPaper(${p.id})">详情</button></td>
  </tr>`).join('')}</tbody></table></div>`;
}

/* ============================== 视图：设置 ============================== */

async function viewSettings() {
  const main = $('#main');
  main.innerHTML = '<div class="loading">正在读取设置…</div>';
  const [cfg, health, sch, srcStats] = await Promise.all([
    api('/api/settings'), api('/api/sources/health'), api('/api/health'), api('/api/ingest/stats?days=30'),
  ]);
  const c = cfg.config;
  state.config = c;

  main.innerHTML = `
    <div class="page-head"><div><h1>设置与数据源</h1>
      <div class="page-sub">所有数据与密钥都保存在本机 <span class="mono">${esc(c.dataDir)}</span></div></div>
      <div class="btn-row"><button class="btn primary" onclick="saveSettings(this)">保存设置</button></div>
    </div>

    <div class="card">
      <h3>AI 解读</h3>
      <div class="sep"></div>
      <div class="banner ${c.aiKeyConfigured ? 'ok' : 'warn'} small">
        当前状态：<b>${esc(c.aiProviderAutoDetected)}</b>${c.aiKeyConfigured ? `（密钥来源：${esc(c.aiKeySource)}，掩码 ${esc(c.aiKeyMasked)}）` : ''}
        ${c.aiKeyConfigured ? '' : '<br>未配置密钥时，工作台仍可采集、筛选、收藏与生成规则版速览，但无法生成 AI 解读。'}
      </div>
      <label class="field"><span>AI API Key（DeepSeek）</span>
        <input type="password" id="sKey" placeholder="${c.aiKeyConfigured ? '已配置，留空则不修改' : 'sk-…'}">
        <div class="help">优先读取环境变量 <span class="mono">DEEPSEEK_API_KEY</span>；否则保存在 <span class="mono">data/secrets.json</span>（权限 600）。
        密钥不会出现在代码、数据库、日志或任何界面输出中。</div>
      </label>
      <div class="grid-2">
        <label class="field"><span>接口地址</span><input type="text" id="sBase" value="${attr(c.aiBaseUrl)}"></label>
        <label class="field"><span>模型</span><input type="text" id="sModel" value="${attr(c.aiModel)}"></label>
        <label class="field"><span>温度（0–1，越低越保守）</span><input type="number" id="sTemp" step="0.1" min="0" max="1" value="${attr(c.aiTemperature)}"></label>
        <label class="field"><span>单次最大输出 tokens</span><input type="number" id="sMax" value="${attr(c.aiMaxTokens)}"></label>
      </div>
      <div class="btn-row">
        <button class="btn" onclick="testAi(this)">测试连接</button>
        <button class="btn" onclick="clearKey()">清除已保存的密钥</button>
      </div>
      <div id="aiTestResult" class="small" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <h3>每日更新</h3>
      <div class="sep"></div>
      <div class="grid-3">
        <label class="field"><span>更新时间（北京时间，小时）</span><input type="number" id="sHour" min="0" max="23" value="${attr(c.briefHour)}"></label>
        <label class="field"><span>分钟</span><input type="number" id="sMin" min="0" max="59" value="${attr(c.briefMinute)}"></label>
        <label class="field"><span>时区</span><input type="text" id="sTz" value="${attr(c.timezone)}"></label>
        <label class="field"><span>每天推荐数量（5–100）</span><input type="number" id="sSize" min="5" max="100" value="${attr(c.briefSize)}"></label>
        <label class="field"><span>采集时间窗口（天）</span><input type="number" id="sLook" min="1" max="180" value="${attr(c.briefLookbackDays)}"></label>
        <label class="field"><span>每个检索式最多取回</span><input type="number" id="sPer" min="5" max="60" value="${attr(c.maxPerTopicQuery)}"></label>
      </div>
      <label class="checkline"><input type="checkbox" id="sBalance" ${c.languageBalance ? 'checked' : ''}> 保证中文与英文论文都保持可见</label>
      <div class="banner info small">
        当前调度：下次更新 ${esc(fmtBeijing(sch.scheduler?.nextAt))}；
        今天的定时更新${sch.scheduler?.scheduledDone
          ? '<b>已完成</b>'
          : (sch.scheduler?.earlyOnly
              ? `尚未完成（今天只在北京时间预定时刻之前生成过 ${sch.scheduler.todayRunCount} 次，不满足定时更新）`
              : '尚未完成')}。
        电脑在预定时刻未开机时，下次打开工作台会自动补做漏掉的更新。
      </div>
      <div class="btn-row"><button class="btn" onclick="runCatchup(this)">立即检查是否需要补做</button></div>
    </div>

    <div class="card">
      <h3>期刊核验策略</h3>
      <div class="sep"></div>
      <label class="checkline"><input type="checkbox" id="sStrict" ${c.strictJournalFilter ? 'checked' : ''}> 严格模式：期刊收录或分区未核实的论文只进入「待核验候选」（强烈建议保持开启）</label>
      <label class="checkline"><input type="checkbox" id="sExt" ${c.acceptCssoExtended ? 'checked' : ''}> 把 CSSCI 扩展版也算作合格来源期刊（默认<b>不</b>算）</label>
      <label class="field"><span>联系邮箱（Crossref / OpenAlex / Unpaywall 礼貌池，建议填写）</span>
        <input type="text" id="sEmail" value="${attr(c.contactEmail)}" placeholder="you@example.com">
        <div class="help">填写后请求会进入公共礼貌池，获得更稳定的配额；该邮箱会随请求发送给这些服务。</div>
      </label>
      <label class="field"><span>OpenAlex API Key</span>
        <input type="text" id="sOaKey" placeholder="${c.openAlexKeyConfigured ? '已配置，留空则不修改' : '建议填写（免费）'}">
        <div class="help">
          匿名调用 OpenAlex 限流非常严格（实测大批量请求会返回 HTTP 429 并被熔断）。
          填写免费 Key（<a href="https://openalex.org/rest-api" target="_blank" rel="noopener">申请地址</a>）后：
          被引数与开放获取状态更完整；「按 DOI 回填作者关键词」也能跑完（我实测 235 篇后就因限流中断）。
        </div>
      </label>
    </div>

    <div class="card">
      <h3>数据源状态</h3>
      <div class="sep"></div>
      <div class="btn-row" style="margin-bottom:10px">
        <button class="btn small" onclick="refreshSources(this)">重新检测</button>
        <span class="tiny muted">检测时间：${esc(fmtBeijing(health.checkedAt))}</span>
      </div>
      <table><thead><tr><th style="width:210px">数据源</th><th style="width:80px">状态</th><th>覆盖范围</th></tr></thead>
      <tbody>${(health.sources || []).map((s) => `<tr>
        <td><b>${esc(s.name)}</b>${s.ms != null ? `<div class="tiny muted">${s.ms} ms</div>` : ''}</td>
        <td>${s.ok ? '<span class="tag elig">连通</span>'
              : (s.needsApiKey ? '<span class="tag pending">需 API Key</span>' : '<span class="tag excluded">失败</span>')}</td>
        <td class="small">${esc(s.coverage)}
          ${s.fix ? `<div class="tiny" style="color:var(--warn)">处理建议：${esc(s.fix)}</div>` : ''}
          ${s.error ? `<div class="tiny" style="color:var(--danger)">错误：${esc(s.error).slice(0, 220)}</div>` : ''}</td>
      </tr>`).join('')}</tbody></table>
      <div class="sep"></div>
      <h4 style="font-size:14px">期刊目录覆盖</h4>
      <table><thead><tr><th style="width:230px">目录</th><th style="width:80px">状态</th><th>覆盖 / 最后更新</th></tr></thead>
      <tbody>${Object.values(health.catalog?.catalogs || {}).map((c2) => `<tr>
        <td>${esc(c2.label)}</td>
        <td>${c2.loaded ? '<span class="tag elig">已导入</span>' : '<span class="tag pending">未导入</span>'}</td>
        <td class="small">${esc(c2.coverage)}${c2.lastUpdate ? `<div class="tiny muted">最后更新 ${esc(fmtDateTime(c2.lastUpdate))}</div>` : ''}</td>
      </tr>`).join('')}</tbody></table>
      <div class="banner warn small" style="margin-top:12px">${esc(health.note || '')}</div>
    </div>

    <div class="card">
      <h3>前沿技术来源（ERIC / arXiv / ACL / IEEE）</h3>
      <div class="sep"></div>
      <div id="frontierSources"><div class="muted small">加载中…</div></div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn small primary" onclick="generateFrontier(this)">立即生成前沿精选</button>
        <button class="btn small" onclick="syncAcl(this)">同步 ACL Anthology 元数据</button>
      </div>
      <div class="banner info small" style="margin-top:10px">
        <b>如实说明各来源现状：</b>ERIC 与 arXiv 的官方接口无需密钥、已真实接通，随每日更新自动检索；
        ACL Anthology <b>没有在线查询接口</b>，只能整包同步元数据后本地检索（约 42MB，需手动触发或等待定时同步）；
        IEEE Xplore Metadata API <b>必须提供机构 API Key</b>——实测无密钥一律返回 HTTP 403（Developer Inactive），
        因此工作台在未配置密钥时<b>不会发起任何请求</b>，也不会假装采到数据。
        <br>三个可用来源都<b>不提供作者关键词与被引次数</b>（ERIC 的 subject 是官方叙词表），因此这里只展示来源真实提供的字段。
        前沿精选<b>独立于主简报</b>，也<b>不计入「期刊条件合格」数量</b>。
      </div>
    </div>

    <div class="card">
      <h3>各来源采集情况</h3>
      <div class="sep"></div>
      <div id="sourceStats"><div class="muted small">加载中…</div></div>
      <div class="banner info small" style="margin-top:10px">
        <b>中文来源现状（必须如实说明）：</b>CNKI、万方、维普均无公开 API；真正被 CSSCI 收录的中文期刊
        极少在 Crossref 注册 DOI（实测：中国语文、世界汉语教学、语言教学与研究、外语教学与研究查询结果均为 0 条），
        而 Crossref 上搜到的中文「教育类期刊」多来自非正规出版商。
        <br><br>
        <b>已经接通的自动覆盖目前只有一本刊：</b>国家哲学社会科学文献中心《世界汉语教学》的公开目录页
          （逐篇题名 / 作者 / 年/期/页码；<b>没有摘要与关键词</b>。随每日更新自动检查，最近检查时间与发现篇数见上方「各来源采集情况」，也可查 <span class="mono">GET /api/cn-sources</span>）。
        <b>其余中文期刊尚未自动覆盖</b>，仍需要你在「库内检索 / 添加论文」里导入题录。
        另一候选来源延边大学《汉语学习》往期目录实测只有整版 JPEG 扫描图、没有可解析的逐篇文字，因此没有接入。
        <br><br>
        注意：这些公开目录页只提供题录，<b>不作为 CSSCI / 北大核心的核验依据</b>——期刊等级仍需你导入官方目录。
        Semantic Scholar 对「汉语作为第二语言」类英文期刊覆盖较好，但匿名调用限流严格，默认不参与采集。
      </div>
    </div>

    <div class="card">
      <h3>操作与日志</h3>
      <div class="sep"></div>
      <div class="btn-row">
        <button class="btn primary" onclick="runFullUpdate(this)">立即采集并重新生成简报</button>
        <button class="btn" onclick="showEvents()">查看事件日志</button>
        <button class="btn" onclick="showIngestLog()">查看采集日志</button>
      </div>
      <div class="tiny muted" style="margin-top:8px">数据库：<span class="mono">${esc(sch.dbFile || '')}</span>　Node ${esc(sch.node || '')}</div>
    </div>
  `;
  renderSourceStats(srcStats);
  loadFrontierSources();
}

function renderSourceStats(d) {
  const box = $('#sourceStats');
  if (!box) return;
  if (!d || !d.ok) { box.innerHTML = '<div class="muted small">无法读取</div>'; return; }
  const src = d.bySource || [];
  if (!src.length) {
    box.innerHTML = '<div class="banner warn small">最近 30 天没有采集记录。点上方「立即采集并重新生成简报」开始采集。</div>';
    return;
  }
  box.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th style="width:130px">数据源</th><th style="width:70px">请求</th><th style="width:80px">成功/失败</th>
        <th style="width:80px">取回</th><th style="width:80px">入库</th><th>最后活动</th></tr></thead>
      <tbody>${src.map((r) => `<tr>
        <td><b>${esc(r.source)}</b></td>
        <td class="mono">${r.requests}</td>
        <td><span class="tag elig">${r.okCount}</span> / ${r.failCount ? `<span class="tag excluded">${r.failCount}</span>` : '<span class="muted">0</span>'}</td>
        <td class="mono">${r.found || 0}</td>
        <td class="mono">${r.added || 0}</td>
        <td class="tiny muted">${esc(fmtDateTime(r.lastAt))}</td>
      </tr>`).join('')}</tbody></table></div>
    ${(d.circuits || []).length ? `<div class="banner warn small" style="margin-top:8px">
      <b>正在熔断的数据源</b>（被限流后自动暂停，避免拖慢整轮采集）：
      ${d.circuits.map((c) => `${esc(c.host)}（${esc(c.reason)}，约 ${Math.ceil(c.resumeInMs / 1000)} 秒后恢复）`).join('；')}
    </div>` : ''}
    ${(d.failures || []).length ? `
      <button type="button" class="collapse-head" id="fail-log" onclick="toggleCollapse(this)" aria-expanded="false" aria-controls="fail-log-body"><span class="collapse-arrow" aria-hidden="true">▸</span><span class="collapse-title">最近的失败记录（${d.failures.length} 条）</span></button>
      <div class="collapse-body hidden" id="fail-log-body" role="region" aria-labelledby="fail-log"><table><tbody>
        ${d.failures.map((f) => `<tr><td class="small" style="width:110px">${esc(f.source)}</td>
          <td class="tiny" style="width:70px">${esc(String(f.http_status || '—'))}</td>
          <td class="tiny">${esc((f.message || '').slice(0, 170))}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="small muted" style="margin-top:8px">
      中英文论文数：${(d.languages || []).map((l) => `${l.language || '未知'} ${l.c}`).join('　·　')}
      　·　通过题录导入的论文：${d.importedPapers || 0} 篇
    </div>
    <div class="tiny muted" style="margin-top:6px">${esc(d.note || '')}</div>
  `;
}

async function saveSettings(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>保存中…';
  const g = (id) => ($(id) ? $(id).value : '');
  const body = {
    aiBaseUrl: g('#sBase'), aiModel: g('#sModel'),
    aiTemperature: Number(g('#sTemp')), aiMaxTokens: Number(g('#sMax')),
    briefHour: Number(g('#sHour')), briefMinute: Number(g('#sMin')), timezone: g('#sTz'),
    briefSize: Number(g('#sSize')), briefLookbackDays: Number(g('#sLook')), maxPerTopicQuery: Number(g('#sPer')),
    languageBalance: $('#sBalance').checked,
    strictJournalFilter: $('#sStrict').checked, acceptCssoExtended: $('#sExt').checked,
    contactEmail: g('#sEmail'),
  };
  if (g('#sKey')) body.deepseekApiKey = g('#sKey');
  if (g('#sOaKey')) body.openAlexApiKey = g('#sOaKey');
  const r = await api('/api/settings', { method: 'POST', body });
  btn.disabled = false; btn.textContent = '保存设置';
  if (!r.ok) { toast(r.error, true); return; }
  toast('设置已保存');
  viewSettings();
}

async function testAi(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span>测试中…';
  const r = await api('/api/settings/test-ai', { method: 'POST', body: {} });
  btn.disabled = false; btn.textContent = '测试连接';
  $('#aiTestResult').innerHTML = r.ok
    ? `<span class="tag elig">连接正常</span> 模型 ${esc(r.model)}，返回：${esc(r.reply)}（${r.ms} ms）`
    : `<span class="tag excluded">失败</span> ${esc(r.error)}`;
}

async function clearKey() {
  if (!confirm('清除已保存在本机的 AI 密钥？')) return;
  await api('/api/settings', { method: 'POST', body: { deepseekApiKey: '', aiBaseUrl: $('#sBase').value, aiModel: $('#sModel').value } });
  toast('密钥已清除'); viewSettings();
}

async function refreshSources(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>检测中…';
  await api('/api/sources/health?refresh=1');
  btn.disabled = false; btn.textContent = '重新检测';
  viewSettings();
}

/* ---------------------- 前沿技术来源（设置页） ---------------------- */

async function loadFrontierSources() {
  const box = $('#frontierSources');
  if (!box) return;
  let d;
  try { d = await api('/api/frontier/status'); } catch (e) { d = { ok: false, error: e.message }; }
  if (!d || !d.ok) { box.innerHTML = `<div class="banner warn small">读取失败：${esc((d && d.error) || '未知错误')}</div>`; return; }
  // 「来源是否可用」与「最近一次运行到底成没成功」必须分开写，
  // 否则 arXiv 今天全部失败时，设置页仍会显示「已接通」，属于失真。
  const lastBy = {};
  for (const s of d.lastRunSources || []) lastBy[s.source] = s;
  box.innerHTML = `<table><thead><tr><th style="width:210px">来源</th><th style="width:104px">可用性</th><th style="width:210px">最近一次运行</th><th>覆盖范围与限制</th></tr></thead>
    <tbody>${(d.sources || []).map((s) => {
      const key = s.key || s.source;
      let tag;
      if (s.kind === 'needs-key') tag = s.key === 'ieee' && d.ieee && !d.ieee.configured ? '<span class="tag pending">待配置密钥</span>' : '<span class="tag pending">待配置</span>';
      else if (s.kind === 'batch') tag = (d.items > 0) ? '<span class="tag elig">可本地检索</span>' : '<span class="tag pending">待同步</span>';
      else tag = '<span class="tag elig">已接通</span>';
      const L = lastBy[key] || lastBy[s.source];
      let lastCell = '<span class="muted tiny">尚未运行</span>';
      if (L) {
        if (L.ok) lastCell = `<span class="tag elig">成功</span><div class="tiny muted">取回 ${L.found == null ? 0 : L.found} 条</div>`;
        else if (L.needsKey && !L.configured) lastCell = '<span class="tag pending">未发起请求</span>';
        else if (L.batch) lastCell = '<span class="tag pending">未同步</span>';
        else lastCell = `<span class="tag excluded">失败</span>${L.error ? `<div class="tiny" style="color:var(--danger)">${esc(String(L.error).slice(0, 190))}</div>` : ''}`;
      }
      return `<tr>
        <td><b>${esc(s.label)}</b><div class="tiny muted mono">${esc(s.api || '')}</div>
          <div class="tiny muted">${s.needsKey ? '需要 API Key' : '无需密钥'}</div></td>
        <td>${tag}</td>
        <td class="small">${lastCell}</td>
        <td class="small">${esc(s.coverage)}
          ${s.kind === 'needs-key' && d.ieee && d.ieee.error ? `<div class="tiny" style="color:var(--warn)">${esc(d.ieee.error)}</div>
            <div class="tiny muted">处理建议：${esc(d.ieee.fix || '')}</div>` : ''}
        </td></tr>`;
    }).join('')}</tbody></table>
    <div class="tiny muted" style="margin-top:8px">库内前沿元数据：<b>${d.items || 0}</b> 条${d.lastRun ? ` · 最近一次生成 ${esc(fmtBeijing(d.lastRun.finishedAt || d.lastRun.startedAt))}（入选 ${d.lastRunPicked == null ? d.lastRun.pickedCount : d.lastRunPicked} 篇${d.lastRunNewToday != null ? `，其中今天新采集 ${d.lastRunNewToday} 篇、沿用早前采集 ${d.lastRunCarriedOver} 篇` : ''}）` : ''}</div>`;
}

async function generateFrontier(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>检索中（ERIC / arXiv）…';
  try {
    const r = await api('/api/frontier/generate', { method: 'POST', body: {} });
    toast(r.insufficient ? `已生成，但只选到 ${r.picked} 篇（目标 ${r.size || 3} 篇，原因见简报页来源状态）` : `已生成 ${r.picked} 篇前沿精选`);
  } catch (e) { toast('生成失败：' + e.message, true); }
  btn.disabled = false; btn.textContent = '立即生成前沿精选';
  await loadFrontierSources();
}

async function syncAcl(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>同步中（约 42MB，可能需要 1–2 分钟）…';
  try {
    const r = await api('/api/frontier/sync-acl', { method: 'POST', body: {} });
    if (r.notModified) toast('ACL 元数据没有更新（304），已跳过解析');
    else if (r.ok) toast(`ACL 同步完成：解析 ${r.parsed} 条，新增 ${r.inserted} 条`);
    else toast('ACL 同步失败：' + (r.error || '未知错误'), true);
  } catch (e) { toast('ACL 同步失败：' + e.message, true); }
  btn.disabled = false; btn.textContent = '同步 ACL Anthology 元数据';
  await loadFrontierSources();
}

async function runCatchup(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>检查中…';
  const r = await api('/api/scheduler/run', { method: 'POST', body: {} });
  btn.disabled = false; btn.textContent = '立即检查是否需要补做';
  toast(r.caught ? `已补做（${reasonLabel(r.kind)}）` : (r.reason || '无需补做'));
  refreshFoot();
}

async function showEvents() {
  const r = await api('/api/events?limit=150');
  openModal(`<h2>事件日志</h2><div class="sep"></div>
    <div class="table-wrap" style="max-height:56vh"><table><tbody>
    ${(r.events || []).map((e) => `<tr><td class="tiny mono" style="width:140px">${esc(fmtDateTime(e.at))}</td>
      <td style="width:70px">${e.level === 'error' ? '<span class="tag excluded">错误</span>' : '<span class="tag src">信息</span>'}</td>
      <td class="small">${esc(e.scope)} — ${esc(e.message)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="btn-row" style="margin-top:12px"><button class="btn" onclick="closeModal()">关闭</button></div>`);
}

async function showIngestLog() {
  const r = await api('/api/ingest/log?limit=150');
  openModal(`<h2>采集日志</h2><div class="banner info small">每条记录对应一次真实的 API 调用，失败项会显示 HTTP 状态与错误原因。</div>
    <div class="table-wrap" style="max-height:56vh"><table><thead><tr><th style="width:96px">数据源</th><th style="width:110px">主题</th><th style="width:64px">结果</th><th>说明</th></tr></thead><tbody>
    ${(r.log || []).map((l) => `<tr>
      <td class="small">${esc(l.source)}</td><td class="small">${esc(l.topic)}</td>
      <td>${l.ok ? '<span class="tag elig">成功</span>' : `<span class="tag excluded">失败 ${esc(String(l.http_status || ''))}</span>`}</td>
      <td class="tiny">${esc(l.message || '')}<div class="muted">${esc(fmtDateTime(l.at))} · ${l.ms || 0} ms</td></tr>`).join('')}
    </tbody></table></div>
    <div class="btn-row" style="margin-top:12px"><button class="btn" onclick="closeModal()">关闭</button></div>`);
}

/* ============================== 全局动作 ============================== */

async function toggleStar(paperId, value, btn, isDetail) {
  const r = await api('/api/library/star/' + paperId, { method: 'POST', body: { value } });
  if (!r.ok) { toast(r.error, true); return; }
  toast(r.starred ? '已收藏' : '已取消收藏');
  if (state.view === 'library') await loadLibraryList();
  else if (isDetail && state.view === 'paper') await viewPaper(paperId);
  else if (btn) {
    btn.textContent = r.starred ? '★ 已收藏' : '☆ 收藏';
    btn.classList.toggle('primary', r.starred);
    btn.setAttribute('onclick', `toggleStar(${paperId}, ${!r.starred}, this)`);
  }
  refreshFoot();
}

async function setRead(paperId, st, btn, isDetail) {
  const r = await api('/api/library/read/' + paperId, { method: 'POST', body: { read_state: st } });
  if (!r.ok) { toast(r.error, true); return; }
  toast({ unread: '已标为待读', reading: '已标为在读', read: '已标为已读' }[st]);
  if (state.view === 'library') await loadLibraryList();
  else if (isDetail && state.view === 'paper') await viewPaper(paperId);
  else if (btn) {
    btn.textContent = st === 'read' ? '标为待读' : '标记已读';
    btn.setAttribute('onclick', `setRead(${paperId}, '${st === 'read' ? 'unread' : 'read'}', this)`);
  }
  refreshFoot();
}

async function quickInterpret(paperId, btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span>解读中…';
  const r = await api('/api/interpret', { method: 'POST', body: { paperId, mode: 'quick' } });
  btn.disabled = false; btn.textContent = '快速解读';
  if (!r.ok) {
    if (r.configured === false) { toast('未配置 AI 密钥，已跳转到设置页', true); go('settings'); return; }
    toast(r.error, true); return;
  }
  openModal(`<h2>快速解读</h2><div class="sep"></div>
    <div class="evidence-note ${r.evidenceScope === 'fulltext' ? '' : 'weak'}">${esc(r.evidenceNote)}</div>
    <div class="md">${renderMarkdown(r.content)}</div>
    <div class="tiny muted" style="margin-top:10px">引用核对：可用材料 ${r.grounding.totalMaterials} 条，模型引用 ${r.grounding.citedIds.length} 条${r.grounding.bogusIds.length ? `，移除无效引用 ${r.grounding.bogusIds.length} 处` : ''}。</div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn primary" onclick="closeModal();goPaper(${paperId})">进入详情页继续深入解读</button>
      <button class="btn" onclick="closeModal()">关闭</button>
    </div>`);
  refreshFoot();
}

async function generateBrief(btn, aiReasons) {
  btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span>生成中…';
  const r = await api('/api/brief/generate', { method: 'POST', body: { force: true, aiReasons } });
  btn.disabled = false; btn.textContent = '重新生成';
  if (!r.ok) { toast(r.error, true); return; }
  toast(`已生成：精选 ${r.selected} 篇（合格候选 ${r.eligible} 篇）`);
  viewBrief(); refreshFoot();
}

/* 采集在后台执行，前端轮询进度，避免请求超时 */
let _pollTimer = null;

function updateBannerHtml(job, collect) {
  const bySrc = Object.entries(collect?.bySource || {})
    .map(([k, v]) => `${k}: 成功 ${v.ok} / 失败 ${v.fail} / 取回 ${v.found}`).join('　·　');
  const pct = collect && collect.totalQueries
    ? Math.round((collect.doneQueries / collect.totalQueries) * 100) : 0;
  return `
    <div class="banner ${job.stage === 'failed' ? 'danger' : 'info'}" id="jobBanner">
      <strong>${esc(job.message || '处理中…')}</strong>
      <div class="small" style="margin-top:5px">
        进度：${collect?.doneQueries ?? 0} / ${collect?.totalQueries ?? '?'} 次检索（${pct}%）
        · 取回 ${collect?.rawCount ?? 0} 条 · 去重后 ${collect?.unique ?? 0} 篇
        ${bySrc ? '<br>' + esc(bySrc) : ''}
      </div>
      ${(collect?.recent || []).length ? `<div class="tiny mono" style="margin-top:6px;max-height:100px;overflow:auto">
        ${collect.recent.slice(-6).reverse().map((l) => `${esc(l.ok ? '✔' : '✘')} [${esc(l.source)}] ${esc(l.message || '').slice(0, 110)}`).join('<br>')}
      </div>` : ''}
    </div>`;
}

async function runFullUpdate(btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>已启动…'; }
  const r = await api('/api/scheduler/update', { method: 'POST', body: { reason: 'manual' } });
  if (!r.ok) { if (btn) { btn.disabled = false; btn.textContent = '立即采集更新'; } toast('启动失败：' + (r.error || ''), true); return; }
  if (r.already) toast('已有采集任务在进行中，显示当前进度');

  const main = $('#main');
  const holder = document.createElement('div');
  main.insertBefore(holder, main.firstChild);

  clearInterval(_pollTimer);
  const tick = async () => {
    const p = await api('/api/ingest/progress');
    if (!p.ok) return;
    holder.innerHTML = updateBannerHtml(p.job, p.collect);
    if (!p.job.running) {
      clearInterval(_pollTimer); _pollTimer = null;
      if (btn) { btn.disabled = false; btn.textContent = '立即采集更新'; }
      const res = p.job.result;
      if (p.job.error) { toast('更新失败：' + p.job.error, true); }
      else if (res) {
        const c = res.collect || {};
        toast(`完成：检索 ${c.queries || 0} 次，取回 ${c.rawCount || 0} 条，新增 ${c.inserted || 0} 篇（合格 ${c.eligible || 0}，待核验 ${c.pending || 0}）；简报精选 ${res.brief?.selected ?? 0} 篇` +
          (c.throttled ? '。注意：有数据源被限流，本次结果可能不完整，建议稍后重试或配置 OpenAlex Key。' : ''));
      }
      await render();
      refreshFoot();
    }
  };
  await tick();
  _pollTimer = setInterval(tick, 2000);
}

/** 折叠面板计数器，用于生成 aria-controls 的唯一 id */
let _collapseSeq = 0;

/**
 * 生成一个语义化、可键盘操作的折叠面板。
 *
 * 无障碍要点：
 *   · 标题是真正的 <button>（不是带 onclick 的 div），因此天然可 Tab 聚焦、
 *     Enter/Space 触发、被屏幕阅读器识别为按钮；
 *   · button 上带 aria-expanded 反映当前展开状态、aria-controls 指向内容区 id；
 *   · 内容区带 id 与 role="region"、aria-labelledby 指回按钮。
 *
 * @param {{id?:string, title:string, bodyHtml:string, open?:boolean, headClass?:string,
 *          bodyClass?:string, bodyStyle?:string, headStyle?:string, titleHtml?:string, extra?:string}} o
 */
function collapsePanel(o) {
  const id = o.id || ('collapse-' + (++_collapseSeq));
  const bodyId = id + '-body';
  const open = o.open === true;
  return `
    <button type="button" class="collapse-head" id="${attr(id)}"
            aria-expanded="${open ? 'true' : 'false'}" aria-controls="${attr(bodyId)}"
            onclick="toggleCollapse(this)"${o.headStyle ? ` style="${attr(o.headStyle)}"` : ''}>
      <span class="collapse-arrow" aria-hidden="true">${open ? '▾' : '▸'}</span>
      <span class="collapse-title">${o.titleHtml || esc(o.title)}</span>
      ${o.extra || ''}
    </button>
    <div class="collapse-body${open ? '' : ' hidden'}${o.bodyClass ? ' ' + o.bodyClass : ''}"
         id="${attr(bodyId)}" role="region" aria-labelledby="${attr(id)}"${o.bodyStyle ? ` style="${attr(o.bodyStyle)}"` : ''}>
      ${o.bodyHtml}
    </div>`;
}

/** 展开/收起，并同步 aria-expanded（供按钮与程序调用） */
function setCollapse(head, open) {
  if (!head) return;
  const body = head.nextElementSibling;
  if (!body) return;
  body.classList.toggle('hidden', !open);
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  const arrow = head.querySelector('.collapse-arrow');
  if (arrow) arrow.textContent = open ? '▾' : '▸';
}

function toggleCollapse(head) {
  const expanded = head.getAttribute('aria-expanded') === 'true';
  setCollapse(head, !expanded);
}

/* ============================== 路由 ============================== */

function go(view) { location.hash = '#/' + view; }
function goPaper(id) { location.hash = '#/paper/' + id; return false; }

async function render() {
  const hash = location.hash || '#/discovery';
  const mPaper = hash.match(/^#\/paper\/(\d+)/);
  $$('#nav .nav-item').forEach((b) => b.classList.remove('active'));
  try {
    if (mPaper) {
      state.view = 'paper';
      await viewPaper(Number(mPaper[1]));
    } else {
      const view = hash.replace(/^#\//, '') || 'discovery';
      state.view = view;
      const btn = $(`#nav .nav-item[data-view="${view}"]`);
      if (btn) btn.classList.add('active');
      if (view === 'discovery') await viewDiscovery(true);
      else if (view === 'qualified') await viewQualified();
      else if (view === 'judgments') await viewJudgments();
      else if (view === 'brief') await viewBrief();
      else if (view === 'library') await viewLibrary();
      else if (view === 'topics') await viewTopics();
      else if (view === 'journals') await viewJournals();
      else if (view === 'search') await viewSearch();
      else if (view === 'personalize') await viewPersonalize();
      else if (view === 'models') await viewModels();
      else if (view === 'tasks') await viewTasks();
      else if (view === 'catalog-import') await viewCatalogImport();
      else if (view.startsWith('subject/')) await viewSubject(view.slice(8).replace('/',':'));
      else if (view === 'settings') await viewSettings();
      else await viewDiscovery(true);
    }
  } catch (e) {
    $('#main').innerHTML = `<div class="banner danger"><strong>页面渲染出错</strong><br>${esc(e.message)}<pre class="small">${esc(e.stack || '')}</pre></div>`;
  }
  refreshFoot();
}

$$('#nav .nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
window.addEventListener('hashchange', render);

/*
 * 译文「点击重试」：事件委托，避免每张卡片重复绑定。
 * 重试是显式动作，因此允许 force 重译，并且只针对这一个字段。
 */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tr-retry]');
  if (!btn) return;
  e.preventDefault();
  const id = Number(btn.getAttribute('data-tr-retry'));
  const field = btn.getAttribute('data-tr-field');
  if (!id || !field) return;
  btn.disabled = true;
  btn.textContent = '重试中…';
  api(`/api/translate/${id}`, { method: 'POST', body: { field, force: true } }).then((r) => {
    if (r && r.ok && r.translated) {
      applyTrResults({ [id]: { [field]: { ok: true, text: r.translated, createdAt: r.createdAt, model: r.model } } });
      toast('已重新翻译');
    } else {
      btn.disabled = false;
      btn.textContent = '翻译失败 · 点击重试';
      toast((r && (r.error || r.hint)) || '翻译失败', true);
    }
  }).catch((err) => {
    btn.disabled = false;
    btn.textContent = '翻译失败 · 点击重试';
    toast(err.message, true);
  });
});

(async function boot() {
  await installReader();
  await installV2();
  await render();
  // 如果后台已经有采集任务在跑（例如刷新了页面），自动接管进度显示
  const p = await api('/api/ingest/progress');
  if (p.ok && (p.job.running || p.collect?.running)) {
    const btn = { disabled: false, textContent: '' };
    const main = $('#main');
    const holder = document.createElement('div');
    main.insertBefore(holder, main.firstChild);
    clearInterval(_pollTimer);
    const tick = async () => {
      const q = await api('/api/ingest/progress');
      if (!q.ok) return;
      holder.innerHTML = updateBannerHtml({ ...q.job, running: q.job.running || q.collect?.running }, q.collect);
      if (!q.job.running && !q.collect?.running) { clearInterval(_pollTimer); _pollTimer = null; await render(); refreshFoot(); }
    };
    await tick();
    _pollTimer = setInterval(tick, 2000);
  }
})();
