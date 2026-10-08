'use strict';
/**
 * 时区一致性回归测试。
 *
 * 起因（真实 Safari 页面发现）：北京时间 2026-09-28 03:08 做的篇名翻译，
 * 在详情页持久化记录里显示成「2026/09/27 19:08」；AI 解读刚生成时显示
 * 「2026/09/28 03:10」，刷新后历史记录又变回「2026/09/27 19:10」。
 *
 * 根因：SQLite 的 datetime('now') 存的是**不带时区标记的 UTC**（`19:10:03`），
 * 而 JS 的 new Date('2026-09-27 19:10:03') 会按**本地时间**解析，于是同一时刻
 * 在两条渲染路径上差了 8 小时。
 *
 * 本测试锁定：
 *   1. 不带时区的库值与带 Z 的 ISO 是**同一瞬间**（不能改实际时刻）；
 *   2. 前端显示层把两者都渲染成同一个北京时间字符串；
 *   3. 生成路径与刷新路径的时间来源一致（都用服务端存的那条记录）；
 *   4. 库迁移只补时区标记、幂等、且不动纯日期字段。
 *
 * 运行：node test/time-consistency.js
 * 只读正式代码与临时数据目录，不联网、不触碰项目 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-tz-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

/**
 * 从 public/app.js 中提取显示层时间函数并在沙箱里求值。
 * 前端没有模块系统，直接读源码跑真实实现，避免测试另写一份「看起来一样」的逻辑。
 */
function loadFrontendTimeHelpers() {
  const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const startMarker = 'const TZ_NAIVE =';
  const endMarker = '/** 阅读状态文案';
  const i = src.indexOf(startMarker);
  const j = src.indexOf(endMarker);
  if (i < 0 || j < 0 || j <= i) throw new Error('未能定位 app.js 的时间函数区域');
  const body = src.slice(i, j);
  // 该区域只用到 Intl / Date 这些标准对象
  const factory = new Function(`${body}\nreturn { parseTime, fmtDate, fmtDateTime, fmtBeijing };`);
  return factory();
}

const F = loadFrontendTimeHelpers();
const time = require('../lib/time');

/* ================================================================ *
 * 1. 「不带时区的库值」和「带 Z 的 ISO」必须是同一瞬间
 * ================================================================ */
console.log('\n=== 1. 两种存储格式表示同一瞬间（实际时刻不变） ===');
const naive = '2026-09-27 19:08:38';        // 库里老格式（UTC，无标记）
const isoZ = '2026-09-27T19:08:38.000Z';    // 迁移后的格式
ok('lib/time：naive 与 ISO-Z 是同一毫秒',
  time.parse(naive).getTime() === time.parse(isoZ).getTime(),
  `${time.parse(naive).toISOString()}`);
ok('app.js：naive 与 ISO-Z 解析为同一时刻',
  F.parseTime(naive).getTime() === F.parseTime(isoZ).getTime());
ok('该时刻的北京时间是 2026/09/28 03:08',
  F.fmtDateTime(naive) === '2026/09/28 03:08', F.fmtDateTime(naive));

/* ================================================================ *
 * 2. 用户实际遇到的那两个时刻
 * ================================================================ */
console.log('\n=== 2. 复现并锁定用户报告的两个时刻 ===');
const cases = [
  ['篇名翻译', '2026-09-27 19:08:38', '2026/09/28 03:08'],
  ['AI 解读', '2026-09-27 19:10:03', '2026/09/28 03:10'],
];
for (const [what, stored, expect] of cases) {
  const got = F.fmtDateTime(stored);
  ok(`${what}：库里 ${stored} → 显示 ${expect}`, got === expect, got);
  // 迁移后（带 Z）必须显示完全相同，不能因为补了个 Z 就变
  const migrated = time.toIsoUtc(stored);
  const got2 = F.fmtDateTime(migrated);
  ok(`${what}：补成 ${migrated} 后显示不变`, got2 === expect, got2);
  ok(`${what}：绝不出现旧错误值（差 8 小时）`,
    got !== stored.slice(0, 10).replace(/-/g, '/') + ' ' + stored.slice(11, 16));
}

/* ================================================================ *
 * 3. 生成路径与刷新路径的时间来源必须一致
 * ================================================================ */
console.log('\n=== 3. 「刚生成」与「刷新后」渲染同一个时间 ===');
// 生成响应里的 createdAt 直接来自库里那条记录（lib/interpret.js），
// 因此两条路径拿到的是同一个字符串 → 同一个显示结果。
const justGenerated = time.toIsoUtc('2026-09-27 19:10:03');  // 生成响应
const afterReload = '2026-09-27 19:10:03';                   // 刷新后读库（老格式）
ok('生成路径与刷新路径显示一致',
  F.fmtDateTime(justGenerated) === F.fmtDateTime(afterReload),
  `${F.fmtDateTime(justGenerated)} vs ${F.fmtDateTime(afterReload)}`);

const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
ok('前端不再自己造解读时间（无 createdAt: new Date().toISOString()）',
  !/createdAt:\s*new Date\(\)\.toISOString\(\)/.test(appSrc));
ok('前端用服务端返回的 createdAt',
  /createdAt:\s*r\.createdAt/.test(appSrc));
const interpretSrc = fs.readFileSync(path.join(ROOT, 'lib/interpret.js'), 'utf8');
ok('服务端生成接口返回库里那条记录的 createdAt',
  /createdAt:\s*savedRow \? savedRow\.created_at/.test(interpretSrc));

/* ================================================================ *
 * 4. 库迁移：只补时区标记，不改时刻，不动纯日期
 * ================================================================ */
console.log('\n=== 4. 迁移只补时区标记 ===');
const store = require('../lib/store');
store.migrate();

const pid = (() => {
  store.run("INSERT INTO papers (title, eligibility) VALUES ('tz fixture','pending')");
  return store.get('SELECT id FROM papers ORDER BY id DESC LIMIT 1').id;
})();
store.run('INSERT INTO interpretations (paper_id, mode, content, created_at) VALUES (?,?,?,?)',
  [pid, 'quick', 'x', '2026-09-27 19:10:03']);
store.run('INSERT INTO translations (paper_id, field, target_lang, source_hash, translated, created_at) VALUES (?,?,?,?,?,?)',
  [pid, 'title', 'zh', 'h1', 'y', '2026-09-27 19:08:38']);
store.run('INSERT INTO papers (title, journal_name, discovery_date) VALUES (?,?,?)',
  ['date fixture', 'J', '2026-09-27']);

const before = time.parse('2026-09-27 19:10:03').getTime();
const n = store.normalizeStoredTimes();
ok('迁移报告修改了行数', n > 0, `修改 ${n} 行`);

const after = store.get('SELECT created_at v FROM interpretations WHERE paper_id = ?', [pid]).v;
ok('老值被补成带 Z 的 ISO', /Z$/.test(after), after);
ok('实际时刻完全不变', time.parse(after).getTime() === before,
  `${time.parse(after).toISOString()}`);
ok('翻译时间同样被补成 ISO', /Z$/.test(
  store.get('SELECT created_at v FROM translations WHERE paper_id = ?', [pid]).v));
ok('迁移幂等（二次执行为 0）', store.normalizeStoredTimes() === 0);
ok('纯日期字段未被改写（仍是 YYYY-MM-DD）',
  store.get('SELECT discovery_date v FROM papers WHERE title = ?', ['date fixture']).v === '2026-09-27');

/* ================================================================ *
 * 5. 新建记录默认就是带时区的 ISO
 * ================================================================ */
console.log('\n=== 5. 新写入的时间自带时区标记 ===');
store.run('INSERT INTO judgments (paper_id, decision) VALUES (?,?)', [pid, 'interested']);
const jrow = store.get('SELECT created_at, updated_at FROM judgments WHERE paper_id = ?', [pid]);
ok('judgments.created_at 是 ISO-Z', /Z$/.test(jrow.created_at || ''), jrow.created_at);
ok('judgments.updated_at 是 ISO-Z', /Z$/.test(jrow.updated_at || ''), jrow.updated_at);

// 只看代码行，不看注释（注释里会引用历史写法作为说明）
const schemaSrc = fs.readFileSync(path.join(ROOT, 'lib/store.js'), 'utf8');
const schemaCode = schemaSrc.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
ok('schema 默认值不再用 datetime(\'now\')',
  !/DEFAULT \(datetime\('now'\)\)/.test(schemaCode));
ok('schema 默认值改用带 Z 的 strftime',
  (schemaSrc.match(/strftime\('%Y-%m-%dT%H:%M:%SZ','now'\)/g) || []).length >= 10);

// 只找**真的写进 SQL** 的用法：紧跟在 date_col = 或 DEFAULT ( 之后。
// 注释里提到 datetime('now') 是在解释历史，不算问题。
const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'));
let sqlNaive = 0;
for (const f of libFiles) {
  const src = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const hits = (code.match(/(?:DEFAULT\s*\(|_(?:at|At)\s*=\s*)datetime\('now'\)/g) || []).length;
  sqlNaive += hits;
  if (hits) console.log(`      ⚠️ ${f} 仍有 datetime('now') 写入 ${hits} 处`);
}
ok('lib/ 中不再有 SQL 侧 datetime(\'now\') 写入', sqlNaive === 0, `${sqlNaive} 处`);

// 更根本的一层：store.run 会替写入方补上带时区的时间，
// 因此即使老库表上的 DEFAULT 还是 datetime('now')，也不会写出 naive 值。
const w = store.withIsoTimes(
  'INSERT INTO ingest_log(source, topic, ok) VALUES(?,?,?)', ['s', 't', 1]);
ok('store.run 会给省略的时间列补占位符', /, at\)/.test(w.sql) && w.params.length === 4, w.sql);
ok('补进去的是带 Z 的 ISO', /Z$/.test(String(w.params[3])), String(w.params[3]));

const w2 = store.withIsoTimes(
  'INSERT INTO ingest_log(source, topic, ok, at) VALUES(?,?,?,?)', ['a', 'b', 1, '2020-01-01T00:00:00.000Z']);
ok('写入方显式给时间时不覆盖', w2.sql === 'INSERT INTO ingest_log(source, topic, ok, at) VALUES(?,?,?,?)'
  && w2.params.length === 4, w2.sql);

store.logEvent('info', 'test', '时间格式回归');
const evAt = store.get("SELECT at FROM events WHERE scope = 'test' ORDER BY id DESC LIMIT 1").at;
ok('logEvent 写出的时间是 ISO-Z（不依赖老表默认值）', /Z$/.test(String(evAt)), String(evAt));

ok('能报告仍带旧默认值的列（用于发现漏网之鱼）',
  Array.isArray(store.legacyTimeDefaults()));

/* ================================================================ *
 * 6. 纯日期（出版日）不能被时区挪一天
 * ================================================================ */
console.log('\n=== 6. 出版日不被时区换算 ===');
ok('fmtDate 原样保留纯日期', F.fmtDate('2026-09-27') === '2026-09-27', F.fmtDate('2026-09-27'));
ok('fmtDate 对日期+时刻按北京时间取日期',
  F.fmtDate('2026-09-27 19:10:03') === '2026-09-28', F.fmtDate('2026-09-27 19:10:03'));
ok('fmtDate 空值给占位符', F.fmtDate(null) === '—');
ok('fmtDateTime 空值给占位符', F.fmtDateTime('') === '—');

/* ================================================================ *
 * 7. 页面凡是容易误读的时刻都标明「北京时间」
 * ================================================================ */
console.log('\n=== 7. 关键位置标明「北京时间」 ===');
ok('简报生成时间标注北京时间', /生成时间 \$\{esc\(fmtBeijing\(r\.finishedAt\)\)\}/.test(appSrc));
ok('简报日期标注（北京时间）', /简报日期 \$\{esc\(r\.runDate\)\}（北京时间）/.test(appSrc));
ok('页脚「下次更新」标注北京时间', /下次更新 \$\{esc\(fmtBeijing\(h\.scheduler\?\.nextAt\)\)\}/.test(appSrc));
ok('解读记录时间标注北京时间', /fmtDateTime\(it\.createdAt\)\)\} 北京时间/.test(appSrc));
ok('fmtBeijing 会把「（北京时间）」拼上',
  F.fmtBeijing('2026-09-27 19:10:03') === '2026/09/28 03:10（北京时间）',
  F.fmtBeijing('2026-09-27 19:10:03'));

/* ================================================================ *
 * 8. 翻译路径的时间也来自库里那条记录
 * ================================================================ */
console.log('\n=== 8. 翻译时间同样以库中记录为准 ===');
const transSrc = fs.readFileSync(path.join(ROOT, 'lib/translate.js'), 'utf8');
ok('翻译接口不再自造 createdAt（无 new Date().toISOString()）',
  !/createdAt:\s*new Date\(\)\.toISOString\(\)/.test(transSrc));
ok('翻译接口从 translations 表读回 created_at',
  /SELECT created_at FROM translations WHERE paper_id/.test(transSrc));
ok('翻译 upsert 自己带上带时区的时间',
  /created_at=strftime\('%Y-%m-%dT%H:%M:%SZ','now'\)/.test(transSrc));

// store.run 不介入 upsert（DO UPDATE 的占位符与 INSERT 不是同一套）
const up = store.withIsoTimes(
  'INSERT INTO translations(a,b) VALUES(?,?) ON CONFLICT(a) DO UPDATE SET b=excluded.b',
  [1, 'x']);
ok('store.run 不触碰带 ON CONFLICT 的语句',
  up.sql === 'INSERT INTO translations(a,b) VALUES(?,?) ON CONFLICT(a) DO UPDATE SET b=excluded.b'
  && up.params.length === 2, up.sql);

const pass = R.filter((x) => x.ok).length;
console.log('\n' + '═'.repeat(62));
console.log(`  时区一致性：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
console.log('═'.repeat(62));
if (R.length - pass) {
  console.log('\n失败项：');
  for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
}
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
process.exit(R.length - pass ? 1 : 0);
