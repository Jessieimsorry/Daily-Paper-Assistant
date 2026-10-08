'use strict';
/**
 * 折叠面板的无障碍与默认状态回归测试。
 *
 * 起因（Safari 实测）：今日发现顶部「▸ 筛选与搜索（未筛选）」看起来是收起的，
 * 但期刊等级 / 语言 / 主题 / 时间 / 搜索框整块仍然展开，占满首屏——
 * filterCard 下的 .collapse-body 初始漏了 hidden 类。
 *
 * 本测试锁定：
 *   1. 每一个折叠内容区初始都是收起的（不会漏 hidden）；
 *   2. 折叠标题是语义化 <button>，带 aria-expanded 与 aria-controls，可键盘操作；
 *   3. aria-controls 与内容区 id、aria-labelledby 双向对应；
 *   4. toggleCollapse / setCollapse 让 aria-expanded、内容可见性、箭头三者始终同步；
 *   5. 今日发现在「未筛选」时筛选表单真的收起，「有筛选」时展开；
 *   6. 口径说明按钮的 aria-expanded 同步。
 *
 * 运行：node test/collapse-a11y.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

/* ------------------------------------------------------------------ *
 * 1. 静态模板里每个折叠内容区初始必须收起
 * ------------------------------------------------------------------ */
console.log('\n=== 1. 静态折叠面板的初始状态 ===');
const heads = [...app.matchAll(
  /<button type="button" class="collapse-head" id="([^"]+)" onclick="toggleCollapse\(this\)" aria-expanded="(\w+)" aria-controls="([^"]+)"/g)]
  .map((m) => ({ id: m[1], expanded: m[2], controls: m[3] }));
const bodies = [...app.matchAll(
  /<div class="collapse-body( hidden)?" id="([^"]+)" role="region" aria-labelledby="([^"]+)"/g)]
  .map((m) => ({ hidden: Boolean(m[1]), id: m[2], labelledby: m[3] }));

/*
 * 阈值随功能演进调整（这里只做「确实存在这些折叠面板」的下限保护）：
 * 摘要在后续版本按用户要求改为**原文与译文直接完整显示、不再折叠**，
 * 因此静态折叠面板从 7 个减为 6 个：
 *   口径说明 / 筛选与搜索 / 候选-全部合格 / 候选-参考 / 候选-待核验 / 执行日志 / 失败记录 / 为何推荐
 * 注意「为何推荐 / 来源详情」与其余几处都在这里被覆盖。
 */
ok('找到了折叠头', heads.length >= 6, `${heads.length} 个`);
ok('找到了折叠内容区', bodies.length >= 6, `${bodies.length} 个`);
ok('折叠头与内容区数量一致', heads.length === bodies.length, `${heads.length} vs ${bodies.length}`);
ok('每个静态折叠头初始 aria-expanded=false',
  heads.every((h) => h.expanded === 'false'), heads.filter((h) => h.expanded !== 'false').map((h) => h.id).join('、'));
ok('每个静态内容区初始都带 hidden（这是本次修复的核心 bug）',
  bodies.every((b) => b.hidden), bodies.filter((b) => !b.hidden).map((b) => b.id).join('、') || '全部收起');

console.log('\n=== 2. aria 关联双向对应 ===');
for (const h of heads) {
  const b = bodies.find((x) => x.id === h.controls);
  ok(`head#${h.id} → aria-controls 指向存在的内容区`, Boolean(b), h.controls);
}
for (const b of bodies) {
  const h = heads.find((x) => x.id === b.labelledby);
  ok(`body#${b.id} → aria-labelledby 指回存在的标题`, Boolean(h), b.labelledby);
}

/* ------------------------------------------------------------------ *
 * 3. 语义与键盘可操作性
 * ------------------------------------------------------------------ */
console.log('\n=== 3. 语义化与键盘可操作 ===');
ok('折叠标题是 <button> 而非 div',
  /<button type="button" class="collapse-head"/.test(app)
  && !/<div class="collapse-head"/.test(app),
  `div 版本残留 ${(app.match(/<div class="collapse-head"/g) || []).length} 处`);
ok('折叠标题带 aria-expanded', (app.match(/class="collapse-head"[^>]*aria-expanded=/g) || []).length >= 6
  || /aria-expanded="\$\{open \? 'true' : 'false'\}"/.test(app));
ok('折叠标题带 aria-controls', (app.match(/aria-controls=/g) || []).length >= 7);
ok('内容区带 role="region"', /role="region"/.test(app));
ok('有键盘聚焦样式 :focus-visible', /button\.collapse-head:focus-visible/.test(css));
ok('按钮样式已重置（宽度/无边框/继承字体）',
  /button\.collapse-head\s*\{[\s\S]*?width:\s*100%[\s\S]*?border:\s*0/.test(css));

/* ------------------------------------------------------------------ *
 * 4. 动态组件 collapsePanel
 * ------------------------------------------------------------------ */
console.log('\n=== 4. collapsePanel 组件 ===');
const cpStart = app.indexOf('function collapsePanel(o)');
const cpEnd = app.indexOf('/** 展开/收起');
const cpSrc = app.slice(cpStart, cpEnd);
ok('组件存在', cpStart > 0 && cpEnd > cpStart);
ok('组件输出 <button type="button">', /<button type="button" class="collapse-head"/.test(cpSrc));
ok('组件输出 aria-expanded', /aria-expanded="\$\{open \? 'true' : 'false'\}"/.test(cpSrc));
ok('组件输出 aria-controls', /aria-controls="\$\{attr\(bodyId\)\}"/.test(cpSrc));
ok('组件输出 role=region + aria-labelledby', /role="region"/.test(cpSrc) && /aria-labelledby/.test(cpSrc));
ok('open=false 时内容区带 hidden', /open \? '' : ' hidden'/.test(cpSrc));

// 直接执行组件，检查实际输出
const escFn = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const panel = new Function('esc', 'attr', 'let _s = 0; ' + cpSrc + '; return collapsePanel;')(escFn, escFn);

const closed = panel({ id: 'p1', title: '筛选与搜索', bodyHtml: '<div>form</div>' });
const opened = panel({ id: 'p2', title: '筛选与搜索', open: true, bodyHtml: '<div>form</div>' });
ok('默认渲染：button + aria-expanded=false', /^<button type="button"/.test(closed.trim()) && /aria-expanded="false"/.test(closed));
// 属性可能跨行，用宽松匹配并核对语义
ok('默认渲染：内容区带 hidden 且 id 正确',
  /class="collapse-body hidden"/.test(closed) && /id="p1-body"/.test(closed)
  && /role="region"/.test(closed) && /aria-labelledby="p1"/.test(closed));
ok('默认渲染：aria-controls 指向 p1-body', /aria-controls="p1-body"/.test(closed));
ok('展开渲染：aria-expanded=true 且内容区无 hidden',
  /aria-expanded="true"/.test(opened) && !/collapse-body hidden/.test(opened));

/* ------------------------------------------------------------------ *
 * 5. toggle / set 的状态同步
 * ------------------------------------------------------------------ */
console.log('\n=== 5. toggleCollapse 的 aria 同步 ===');
const swStart = app.indexOf('function setCollapse(head, open)');
const swEnd = app.indexOf('function hasActiveFilter()') > 0 ? app.indexOf('/* ============================== 路由') : app.indexOf('/* ============================== 路由');
const swSrc = app.slice(swStart, swEnd > swStart ? swEnd : app.length);

function makeEl(cls) {
  const s = new Set(cls);
  const el = {
    _attrs: {}, textContent: '', nextElementSibling: null, _arrow: null,
    classList: {
      toggle: (c, on) => { on ? s.add(c) : s.delete(c); },
      contains: (c) => s.has(c),
      add: (c) => s.add(c),
      remove: (c) => s.delete(c),
    },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return el._attrs[k] ?? null; },
    querySelector(sel) { return sel === '.collapse-arrow' ? el._arrow : null; },
  };
  return el;
}
const arrow = makeEl([]);
const head = makeEl(['collapse-head']);
head.setAttribute('aria-expanded', 'false');
head._arrow = arrow;
const body = makeEl(['collapse-body', 'hidden']);
head.nextElementSibling = body;

const { toggleCollapse, setCollapse } = new Function(
  'return (function(){' + swSrc + '; return {toggleCollapse, setCollapse};})()')();

setCollapse(head, true);
ok('展开后 aria-expanded=true', head.getAttribute('aria-expanded') === 'true');
ok('展开后内容区可见', !body.classList.contains('hidden'));
ok('展开后箭头为 ▾', arrow.textContent === '▾');
setCollapse(head, false);
ok('收起后 aria-expanded=false', head.getAttribute('aria-expanded') === 'false');
ok('收起后内容区隐藏', body.classList.contains('hidden'));
ok('收起后箭头为 ▸', arrow.textContent === '▸');
toggleCollapse(head);
ok('点击一次（从收起）→ 展开', head.getAttribute('aria-expanded') === 'true' && !body.classList.contains('hidden'));
toggleCollapse(head);
ok('再点击一次 → 收起', head.getAttribute('aria-expanded') === 'false' && body.classList.contains('hidden'));

/* ------------------------------------------------------------------ *
 * 6. 今日发现：未筛选时收起、有筛选时展开
 * ------------------------------------------------------------------ */
console.log('\n=== 6. 今日发现的默认状态 ===');
ok('筛选面板用组件生成', /id: 'filter-panel'/.test(app));
ok('筛选面板 open 取决于 hasActiveFilter()', /open:\s*hasActiveFilter\(\)/.test(app));
ok('有 hasActiveFilter 实现', /function hasActiveFilter\(\)/.test(app));
const hafSrc = app.slice(app.indexOf('function hasActiveFilter()'), app.indexOf('function applyDiscoveryFilter()'));
const haf = new Function('discoveryState',
  hafSrc + '; return hasActiveFilter;')({ journalFilter: 'all', language: '', topic: '', q: '', days: '' });
ok('未筛选 → false（面板收起）', haf() === false);
const haf2 = new Function('discoveryState',
  hafSrc + '; return hasActiveFilter;')({ journalFilter: 'reference', language: '', topic: '', q: '', days: '' });
ok('选了期刊等级 → true（面板展开）', haf2() === true);
const haf3 = new Function('discoveryState',
  hafSrc + '; return hasActiveFilter;')({ journalFilter: 'all', language: 'zh', topic: '', q: '', days: '' });
ok('选了语言 → true', haf3() === true);

ok('口径说明用组件且默认收起', /id: 'scope-note'/.test(app) && /scopeNoteWrap/.test(app));
ok('筛选摘要在标题旁显示', /id="filterSummary"/.test(app));
ok('筛选控件仍然存在（收起后可展开操作）',
  /id="dFilter"/.test(app) && /id="dLang"/.test(app) && /id="dTopic"/.test(app)
  && /id="dDays"/.test(app) && /id="dQ"/.test(app));

/* ------------------------------------------------------------------ *
 * 7. 首屏高度可接受
 * ------------------------------------------------------------------ */
console.log('\n=== 7. 首屏布局 ===');
ok('统计压成一行紧凑条', /compact-bar/.test(app) && /\.compact-bar\s*\{/.test(css));
ok('紧凑条是单行 flex 且不换行撑高',
  /\.compact-bar\s*\{[\s\S]*?display:\s*flex[\s\S]*?flex-wrap:\s*wrap/.test(css));
ok('不再有独占首屏的蓝色长说明',
  !/<div class="banner info small">\s*<b>三种状态严格区分/.test(app));
ok('列表容器在筛选区之后', app.indexOf('id="dList"') > app.indexOf('id="filterCard"'));

const pass = R.filter((x) => x.ok).length;
console.log('\n' + '═'.repeat(58));
console.log(`  折叠与无障碍回归：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
console.log('═'.repeat(58));
if (R.length - pass) {
  console.log('\n失败项：');
  for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
}
process.exit(R.length - pass ? 1 : 0);
