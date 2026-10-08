'use strict';
/**
 * 本地持久化层：node:sqlite（Node 22+ 内置，无需安装依赖）。
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('./config');
const time = require('./time');

const DB_FILE = path.join(DATA_DIR, 'litdesk.db');
const db = new DatabaseSync(DB_FILE);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS topics (
  id           INTEGER PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  name_zh      TEXT NOT NULL,
  name_en      TEXT,
  keywords_zh  TEXT DEFAULT '[]',
  keywords_en  TEXT DEFAULT '[]',
  enabled      INTEGER DEFAULT 1,
  sort_order   INTEGER DEFAULT 100,
  builtin      INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS journals (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  name_variants TEXT DEFAULT '[]',
  issn          TEXT,
  eissn         TEXT,
  publisher     TEXT,
  language      TEXT,              -- zh | en | other
  catalogs      TEXT DEFAULT '[]', -- [{catalog, edition, year, list, basis, verified, source, note}]
  jcr           TEXT,              -- JSON: {year, categories:[{name,quartile}], source}
  cas           TEXT,              -- JSON: {year, zone, category, source}
  verified      INTEGER DEFAULT 0, -- 0=参考信息 1=用户目录已核验
  in_whitelist  INTEGER DEFAULT 0,
  in_blacklist  INTEGER DEFAULT 0,
  source        TEXT,
  last_checked  TEXT,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_journals_issn ON journals(issn) WHERE issn IS NOT NULL AND issn <> '';
CREATE INDEX IF NOT EXISTS idx_journals_name ON journals(name);

CREATE TABLE IF NOT EXISTS papers (
  id                INTEGER PRIMARY KEY,
  doi_norm          TEXT,
  title             TEXT NOT NULL,
  title_zh          TEXT,
  authors           TEXT DEFAULT '[]',
  journal_name      TEXT,
  journal_id        INTEGER REFERENCES journals(id),
  issn              TEXT,
  language          TEXT,          -- zh | en | unknown
  abstract          TEXT,
  abstract_source   TEXT,
  published_online  TEXT,
  published_print   TEXT,
  issued_date       TEXT,
  volume            TEXT, issue TEXT, pages TEXT,
  url               TEXT,
  pdf_url           TEXT,
  open_access       INTEGER DEFAULT 0,
  oa_status         TEXT,
  license           TEXT,
  fulltext_source   TEXT,          -- crossref-tdm | pmc | unpaywall | uploaded | none
  sources           TEXT DEFAULT '[]',  -- ['crossref','openalex']
  external_ids      TEXT DEFAULT '{}',
  citation_count    INTEGER,
  is_retracted      INTEGER DEFAULT 0,
  topics            TEXT DEFAULT '[]',
  topic_scores      TEXT DEFAULT '{}',
  eligibility       TEXT DEFAULT 'pending', -- eligible | pending | excluded
  eligibility_note  TEXT,
  discovery_date    TEXT,
  dedup_key         TEXT UNIQUE,
  raw               TEXT,
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi_norm);
CREATE INDEX IF NOT EXISTS idx_papers_disc ON papers(discovery_date);
CREATE INDEX IF NOT EXISTS idx_papers_elig ON papers(eligibility);
CREATE INDEX IF NOT EXISTS idx_papers_journal ON papers(journal_id);

CREATE TABLE IF NOT EXISTS brief_runs (
  id            INTEGER PRIMARY KEY,
  run_date      TEXT NOT NULL,      -- 北京时间自然日
  reason        TEXT,               -- scheduled | catchup | manual | first-run
  started_at    TEXT,
  finished_at   TEXT,
  status        TEXT,               -- running | ok | partial | failed
  candidate_count INTEGER DEFAULT 0,
  eligible_count  INTEGER DEFAULT 0,
  selected_count  INTEGER DEFAULT 0,
  log           TEXT DEFAULT '[]',
  sources       TEXT DEFAULT '[]',
  error         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_date ON brief_runs(run_date);

CREATE TABLE IF NOT EXISTS brief_items (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER REFERENCES brief_runs(id) ON DELETE CASCADE,
  paper_id     INTEGER REFERENCES papers(id) ON DELETE CASCADE,
  rank         INTEGER,
  score        REAL,
  reason       TEXT,
  dimension_scores TEXT DEFAULT '{}',
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(run_id, paper_id)
);

CREATE TABLE IF NOT EXISTS library (
  id          INTEGER PRIMARY KEY,
  paper_id    INTEGER UNIQUE REFERENCES papers(id) ON DELETE CASCADE,
  starred     INTEGER DEFAULT 0,
  read_state  TEXT DEFAULT 'unread',   -- unread | reading | read
  note        TEXT DEFAULT '',
  tags        TEXT DEFAULT '[]',
  added_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_library_state ON library(read_state, starred);

CREATE TABLE IF NOT EXISTS interpretations (
  id            INTEGER PRIMARY KEY,
  paper_id      INTEGER REFERENCES papers(id) ON DELETE CASCADE,
  mode          TEXT,                  -- quick | deep | followup
  question      TEXT,
  evidence_scope TEXT,                 -- metadata | abstract | fulltext | mixed | uploaded
  evidence_note TEXT,
  model         TEXT,
  provider      TEXT,
  content       TEXT,
  grounding     TEXT DEFAULT '{}',
  tokens        INTEGER,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_interp_paper ON interpretations(paper_id, created_at);

CREATE TABLE IF NOT EXISTS fulltexts (
  id          INTEGER PRIMARY KEY,
  paper_id    INTEGER UNIQUE REFERENCES papers(id) ON DELETE CASCADE,
  origin      TEXT,        -- uploaded | crossref-tdm | pmc | open
  filename    TEXT,
  stored_path TEXT,
  char_count  INTEGER,
  content     TEXT,
  sections    TEXT DEFAULT '[]',
  fetched_at  TEXT,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  source      TEXT,
  topic       TEXT,
  ok          INTEGER,
  http_status INTEGER,
  found       INTEGER,
  added       INTEGER,
  message     TEXT,
  ms          INTEGER
);

/*
 * 中文期刊目录源：记录每个公开目录源的最近检查情况。
 * 为什么单独建表：每日更新与失败日志要能直接回答
 * 「这个源上次什么时候查的、查到什么、为什么跳过」，
 * 而不是只留一条笼统的采集日志。
 */
CREATE TABLE IF NOT EXISTS cn_sources (
  id             INTEGER PRIMARY KEY,
  source_key     TEXT UNIQUE,          -- 稳定标识，例如 ncpssd_sjhyjx
  name           TEXT,                 -- 人可读名称
  homepage       TEXT,                 -- 公开目录页
  kind           TEXT,                 -- toc_html | ...
  last_check_at  TEXT,                 -- 最近一次检查（无论成败）
  last_ok_at     TEXT,                 -- 最近一次成功
  last_status    TEXT,                 -- ok | empty | not_modified | parse_failed | http_error
  last_issue     TEXT,                 -- 最近一次解析到的期次，例如 2026年第2期
  last_found     INTEGER DEFAULT 0,    -- 最近一次发现的新篇数
  last_added     INTEGER DEFAULT 0,    -- 最近一次实际入库的新篇数
  last_message   TEXT,                 -- 跳过原因 / 失败原因
  total_added    INTEGER DEFAULT 0,    -- 累计入库篇数
  first_seen_at  TEXT,
  updated_at     TEXT
);

/*
 * 中文目录逐篇题录：用来做「按源 + 文章 ID」的可靠去重，
 * 并存下可公开核实的来源证据（目录页、文章原页、采集时间）。
 */
CREATE TABLE IF NOT EXISTS cn_article_imports (
  id            INTEGER PRIMARY KEY,
  source_key    TEXT,
  article_id    TEXT,                 -- 源站稳定 ID（不可得时留空）
  paper_id      INTEGER REFERENCES papers(id) ON DELETE SET NULL,
  title         TEXT,
  authors       TEXT,
  journal_name  TEXT,
  year          TEXT,
  issue         TEXT,
  pages         TEXT,
  issue_label   TEXT,                 -- 2026年第2期
  source_url    TEXT,                 -- 目录页
  article_url   TEXT,                 -- 文章原页（缺失留空）
  evidence      TEXT,                 -- JSON：本次判定用到的公开字段
  fetched_at    TEXT,                 -- 采集时间
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cnai_dedup ON cn_article_imports(source_key, article_id);
CREATE INDEX IF NOT EXISTS idx_cnai_paper ON cn_article_imports(paper_id);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY,
  at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  level   TEXT,
  scope   TEXT,
  message TEXT,
  meta    TEXT
);
`);

/* ------------------------------------------------------------------ *
 * 安全迁移：只增列、只建表，不删数据。
 * 每次启动都会执行；已存在的列/表会被跳过。
 * ------------------------------------------------------------------ */

function tableColumns(table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }
  catch { return []; }
}

function addColumnIfMissing(table, column, ddl) {
  const cols = tableColumns(table);
  if (!cols.length) return { table, column, action: 'skipped-no-table' };
  if (cols.includes(column)) return { table, column, action: 'exists' };
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return { table, column, action: 'added' };
}

/**
 * 迁移记录写在 schema_migrations 里，便于你查看这台机器上跑过哪些变更。
 * 所有变更都是「加列 / 加表 / 加索引」，不会丢失现有的论文、收藏、备注、解读或密钥。
 */
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      version TEXT UNIQUE,
      applied_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS judgments (
      id         INTEGER PRIMARY KEY,
      paper_id   INTEGER REFERENCES papers(id) ON DELETE CASCADE,
      decision   TEXT NOT NULL,          -- interested | muted | cleared
      note       TEXT,                   -- 可选：为什么感兴趣/不关注
      source     TEXT,                   -- 做出判断的位置：discovery | brief | library | paper
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_judgments_paper ON judgments(paper_id);
    CREATE INDEX IF NOT EXISTS idx_judgments_decision ON judgments(decision, updated_at);

    /*
     * 解读材料快照。
     * 生成解读时把「实际提供给模型的那段材料」原样存下来，
     * 这样以后论文摘要/全文更新了，旧解读的 [S1] 仍然能指回当时那段文字，
     * 而不是错误地指向新材料。
     */
    CREATE TABLE IF NOT EXISTS interpretation_materials (
      id            INTEGER PRIMARY KEY,
      interp_id     INTEGER REFERENCES interpretations(id) ON DELETE CASCADE,
      paper_id      INTEGER REFERENCES papers(id) ON DELETE CASCADE,
      sid           TEXT NOT NULL,       -- S1 / S2 …
      scope         TEXT,                -- abstract | fulltext | metadata
      section       TEXT,                -- 章节标题（全文时）
      source_label  TEXT,                -- 例如「摘要（来源：crossref）」「上传文件 test.pdf」
      text          TEXT NOT NULL,       -- 当时的原文片段（快照）
      char_count    INTEGER,
      cited         INTEGER DEFAULT 0,   -- 模型是否实际引用了它
      created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_im_interp ON interpretation_materials(interp_id, sid);
    CREATE INDEX IF NOT EXISTS idx_im_paper ON interpretation_materials(paper_id);

    CREATE TABLE IF NOT EXISTS translations (
      id          INTEGER PRIMARY KEY,
      paper_id    INTEGER REFERENCES papers(id) ON DELETE CASCADE,
      field       TEXT NOT NULL,          -- title | keywords | abstract
      target_lang TEXT NOT NULL,          -- zh | en
      source_lang TEXT,
      source_hash TEXT NOT NULL,          -- 原文指纹：原文变了就作废旧译文
      source_text TEXT,
      translated  TEXT,
      status      TEXT DEFAULT 'ok',      -- ok | failed
      model       TEXT,
      provider    TEXT,
      error       TEXT,
      tokens      INTEGER,
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );    CREATE UNIQUE INDEX IF NOT EXISTS idx_tr_unique
      ON translations(paper_id, field, target_lang, source_hash);
    CREATE INDEX IF NOT EXISTS idx_tr_paper ON translations(paper_id);

    /*
     * ── 前沿技术来源（ERIC / arXiv / ACL Anthology / IEEE）──────────────
     *
     * 为什么单独建表而不并入 papers：
     *   1. 这些是预印本、会议论文与 ERIC 报告，**没有期刊分区**，
     *      混进 papers 会污染「期刊条件合格」的统计口径；
     *   2. 用户明确要求「前沿技术精选与主简报 8 篇分开」；
     *   3. papers 表里的论文数（每日发现/简报基数）不应因前沿源而变动。
     * 因此它们完全独立：既不进「期刊条件合格精选」，也不计入 SSCI/JCR 合格数。
     */
    CREATE TABLE IF NOT EXISTS frontier_items (
      id            INTEGER PRIMARY KEY,
      source        TEXT NOT NULL,        -- eric | arxiv | acl
      source_id     TEXT NOT NULL,        -- ERIC 号 / arXiv 基础 ID / anthology ID
      doc_type      TEXT NOT NULL,        -- journal-article | conference-paper | preprint | report | other
      title         TEXT NOT NULL,
      authors       TEXT DEFAULT '[]',
      venue         TEXT,                 -- 期刊名 / 会议名 / 授权机构
      year          INTEGER,
      published_date TEXT,                -- 按来源实际精度（arXiv 到日；ERIC 只有年）
      abstract      TEXT,
      doi_norm      TEXT,
      url           TEXT,
      pdf_url       TEXT,
      language      TEXT,
      /* ERIC 叙词表 / 数据库主题词——**不是作者关键词**，必须分开存 */
      subjects      TEXT DEFAULT '[]',
      peer_reviewed INTEGER,
      /* 正式发表版的弱信号（arXiv journal_ref / doi 覆盖率仅 2%–8%，只作展示，不自动合并） */
      published_note TEXT,
      matched_paper_id INTEGER,           -- 与库内正式发表论文关联（按 DOI/题名，命中才写）
      raw           TEXT,
      first_seen    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      dedup_key     TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_frontier_source ON frontier_items(source, first_seen);
    CREATE INDEX IF NOT EXISTS idx_frontier_doi ON frontier_items(doi_norm);

    CREATE TABLE IF NOT EXISTS frontier_runs (
      id           INTEGER PRIMARY KEY,
      run_date     TEXT NOT NULL,         -- 北京时间自然日
      reason       TEXT,                  -- scheduled | manual | sync
      started_at   TEXT,
      finished_at  TEXT,
      status       TEXT,                  -- ok | partial | failed
      picked_count INTEGER DEFAULT 0,
      candidates   INTEGER DEFAULT 0,
      log          TEXT DEFAULT '[]',
      sources      TEXT DEFAULT '[]',     -- 每个源的真实状态（含失败原因）
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_frontier_runs_date ON frontier_runs(run_date);
    /*
     * 注意：frontier_runs(run_date) 的 UNIQUE 索引**不在这里创建**。
     * 早期版本每次生成都插一行，同一天可能已经存在多行；直接建唯一索引会失败。
     * 处理顺序见本函数末尾：先去重，再建索引。
     */

    CREATE TABLE IF NOT EXISTS frontier_picks (
      id         INTEGER PRIMARY KEY,
      run_id     INTEGER REFERENCES frontier_runs(id) ON DELETE CASCADE,
      item_id    INTEGER REFERENCES frontier_items(id) ON DELETE CASCADE,
      rank       INTEGER,
      reason     TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE(run_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_frontier_picks_run ON frontier_picks(run_id, rank);

    /* ACL Anthology 全量元数据的同步状态（批量同步，不是在线查询） */
    CREATE TABLE IF NOT EXISTS frontier_sync_state (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);

  const migrations = [
    ['papers', 'keywords', 'TEXT'],            // 作者关键词（原始数据提供时才写入）
    ['papers', 'keywords_source', 'TEXT'],     // 关键词来自哪个数据源
    ['papers', 'openalex_topics', 'TEXT'],     // 数据库主题词（OpenAlex topics），与作者关键词分开
    ['papers', 'db_subjects', 'TEXT'],         // 出版商主题分类（Crossref subject），第三种来源
    ['papers', 'source_queries', 'TEXT'],      // 哪些检索词发现了它（可追溯）
    ['papers', 'eligible_official', 'INTEGER DEFAULT 0'], // 是否仅凭官方目录判定合格
    ['papers', 'eligibility_basis', 'TEXT'],   // official | reference | pending
    ['journals', 'ssci_confirmed', 'INTEGER DEFAULT 0'],  // SSCI 收录是否已确认
    ['brief_items', 'kind', "TEXT DEFAULT 'new'"],        // new | catchup | shown
    ['brief_items', 'verification', 'TEXT'],               // 推荐当时的核验状态快照（official/reference/pending）
    // 语种判定的「来源与依据」：manual | publisher | title | abstract | unknown
    // manual 表示用户人工确认过，后续采集不得覆盖。
    ['papers', 'language_source', 'TEXT'],
    // 题名语种与摘要语种分开存：避免「英文摘要 ⇒ 英文论文」
    ['papers', 'title_language', 'TEXT'],
    ['papers', 'abstract_language', 'TEXT'],
    // 判定细节（置信度、命中的功能词、冲突说明），供复核
    ['papers', 'language_detail', 'TEXT'],
    /*
     * 前沿技术条目的中文译文缓存。
     * 单独放在 frontier_items 上，而不是复用 translations 表——
     * translations 的主键与外键都绑定 papers(id)，前沿条目不在 papers 里。
     * 只缓存译文，原文永远保留。
     */
    ['frontier_items', 'title_zh', 'TEXT'],
    ['frontier_items', 'abstract_zh', 'TEXT'],
    ['frontier_items', 'translated_at', 'TEXT'],
    ['frontier_items', 'translate_model', 'TEXT'],
    ['frontier_items', 'translate_error', 'TEXT'],
  ];
  const applied = [];
  for (const [t, c, ddl] of migrations) {
    const r = addColumnIfMissing(t, c, ddl);
    if (r.action === 'added') {
      applied.push(`${t}.${c}`);
      try {
        db.prepare('INSERT OR IGNORE INTO schema_migrations(version, note) VALUES(?,?)')
          .run(`2026-09-27.${t}.${c}`, `新增列 ${t}.${c}`);
      } catch {}
    }
  }

  // 时间格式归一化：老值来自 datetime('now')，是**不带时区标记的 UTC**。
  // JS 的 new Date() 会把它当本地时间，导致同一时刻显示差 8 小时。
  // 这里只把表示形式补成明确时区的 ISO（19:10:03 → 19:10:03Z），
  // **实际时刻完全不变**；幂等，可反复执行。
  const timeFixed = normalizeStoredTimes();
  if (timeFixed > 0) {
    try {
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version, note) VALUES(?,?)')
        .run('2026-09-28.time-iso-utc', `时间值补时区标记：${timeFixed} 行`);
    } catch {}
  }

  /*
   * 前沿精选「每天只有一份」：先去重，再建唯一索引。
   *
   * 背景：早期实现每次生成 frontier_runs 都插一行，同一天可能已经堆了多行。
   * 直接建 UNIQUE 索引会失败并让整个 migrate 抛错（进而影响启动）。
   * 这里保留每个 run_date **id 最大（最近一次）**的那一行，
   * 删掉同日更早的行与它们的 picks；然后才建唯一索引。
   * 幂等：没有重复行时什么也不做。
   */
  const dupDates = db.prepare(
    'SELECT run_date, COUNT(*) c, MAX(id) keep_id FROM frontier_runs GROUP BY run_date HAVING COUNT(*) > 1').all();
  let frontierDeduped = 0;
  for (const d of dupDates) {
    const stale = db.prepare('SELECT id FROM frontier_runs WHERE run_date = ? AND id <> ?').all(d.run_date, d.keep_id);
    for (const s of stale) {
      db.prepare('DELETE FROM frontier_picks WHERE run_id = ?').run(s.id);
      db.prepare('DELETE FROM frontier_runs WHERE id = ?').run(s.id);
      frontierDeduped++;
    }
  }
  if (frontierDeduped > 0) {
    try {
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version, note) VALUES(?,?)')
        .run('2026-09-28.frontier-one-run-per-day', `合并同日前沿精选记录：删除 ${frontierDeduped} 行`);
    } catch {}
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_frontier_runs_unique_date ON frontier_runs(run_date)');

  return applied;
}

/**
 * 把库里「不带时区标记的 datetime」补成 ISO UTC。
 * 只处理形状匹配的字符串，无法解析的一律不动。
 * @returns {number} 实际修改的行数
 */
function normalizeStoredTimes() {
  const targets = [
    ['interpretations', 'created_at'],
    ['translations', 'created_at'],
    ['events', 'at'],
    ['ingest_log', 'at'],
    ['judgments', 'created_at'],
    ['judgments', 'updated_at'],
    ['interpretation_materials', 'created_at'],
    ['journals', 'created_at'],
    ['journals', 'updated_at'],
    ['papers', 'created_at'],
    ['papers', 'updated_at'],
    ['topics', 'created_at'],
    ['topics', 'updated_at'],
    ['brief_items', 'created_at'],
  ];
  let changed = 0;
  for (const [table, col] of targets) {
    let rows;
    try {
      rows = db.prepare(`SELECT rowid AS rid, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`).all();
    } catch { continue; }  // 表或列不存在（老版本库）就跳过
    for (const r of rows) {
      if (!time.isNaive(r.v)) continue;
      db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`).run(time.toIsoUtc(r.v), r.rid);
      changed++;
    }
  }
  return changed;
}

/**
 * 找出**已有表**里仍是旧默认值 `datetime('now')` 的时间列。
 *
 * 为什么需要：SQLite 的 CREATE TABLE IF NOT EXISTS 不会更新已有表的列默认值。
 * 所以即使代码里的 CREATE TABLE 已经写成带 Z 的 strftime，老库的表仍然是
 * `DEFAULT (datetime('now'))`——插入时会写出不带时区标记的 UTC。
 * 写入方不应依赖这个默认值（关键写入已显式带上时间），这个扫描把任何
 * 遗留的漏网之鱼暴露出来，而不是让它悄悄产生 8 小时偏差。
 *
 * @returns {Array<{table:string,column:string,ddl:string}>}
 */
function legacyTimeDefaults() {
  const out = [];
  let tables;
  try {
    tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
  } catch { return out; }
  for (const t of tables) {
    const sql = String(t.sql || '');
    if (!/datetime\('now'\)/.test(sql)) continue;
    let cols = [];
    try { cols = db.prepare(`PRAGMA table_info(${t.name})`).all(); } catch { continue; }
    for (const c of cols) {
      if (c.dflt_value && /datetime\('now'\)/.test(String(c.dflt_value))) {
        out.push({ table: t.name, column: c.name, ddl: String(c.dflt_value) });
      }
    }
  }
  return out;
}

function nowIso() {
  return time.toIsoUtc(new Date());
}

/**
 * 这些表的时间列由 SQLite 的 DEFAULT 填充，而老库建表时用的是
 * `datetime('now')`（不带时区标记）。SQLite 的 CREATE TABLE IF NOT EXISTS
 * 不会更新已有表的默认值，所以不能指望改 schema 就能修好老库。
 *
 * 做法：在 store.run 这一层，凡是用 DEFAULT 的时间列，一律由应用显式填入
 * 带时区标记的 ISO UTC。这样无论哪个写入方、无论表上默认值是新是旧，
 * 写出来的时间都一定带时区，从结构上消掉「同一时刻两种显示」的可能。
 */
const DEFAULTED_TIME_COLUMNS = {
  topics: ['created_at', 'updated_at'],
  journals: ['created_at', 'updated_at'],
  papers: ['created_at', 'updated_at'],
  library: ['added_at', 'updated_at'],
  brief_items: ['created_at'],
  interpretations: ['created_at'],
  ingest_log: ['at'],
  events: ['at'],
  schema_migrations: ['applied_at'],
  translations: ['created_at'],
  judgments: ['created_at', 'updated_at'],
  interpretation_materials: ['created_at'],
};

/**
 * 若这条 INSERT 省略了某些「有默认值的时间列」，就在这里补上。
 * 只处理 INSERT，且只补那些**确实没写**的列，不改动写入方显式给的值。
 */
const _tableColsCache = new Map();
/** 该表实际存在的列（避免往不存在的列写值——表结构在不同版本间有差异） */
function tableColumnSet(table) {
  if (_tableColsCache.has(table)) return _tableColsCache.get(table);
  let set = new Set();
  try {
    set = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name).toLowerCase()));
  } catch { /* 表不存在 */ }
  _tableColsCache.set(table, set);
  return set;
}

function withIsoTimes(sql, params) {
  if (!/^\s*INSERT\s/i.test(sql)) return { sql, params };
  // upsert 的 DO UPDATE 列表与 INSERT 列表不是同一套占位符，
  // 位置推导会算错（12 values for 13 columns），因此这里不介入。
  // 这类语句的写入方自己带上带时区的时间。
  if (/\bON\s+CONFLICT\b/i.test(sql)) return { sql, params };
  const m = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/i.exec(sql);
  if (!m) return { sql, params };
  const nominal = DEFAULTED_TIME_COLUMNS[m[1]];
  if (!nominal || !nominal.length) return { sql, params };
  // 只补「这张表真的有」的列：表结构在不同版本间有差异
  const actual = tableColumnSet(m[1]);
  const cols = nominal.filter((c) => actual.has(c));
  if (!cols.length) return { sql, params };

  const listed = m[2].split(',').map((c) => c.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase());
  const missing = cols.filter((c) => !listed.includes(c));
  if (!missing.length) return { sql, params };

  const insertCols = m[2] + ', ' + missing.join(', ');
  const newSql = sql.replace(m[0], `INSERT INTO ${m[1]}(${insertCols})`);
  // 在 VALUES 的最后一组括号结束处追加对应占位符
  const valuesIdx = newSql.search(/\bVALUES\s*\(/i);
  if (valuesIdx < 0) return { sql, params };
  const closeIdx = newSql.lastIndexOf(')');
  if (closeIdx < 0) return { sql, params };
  if (newSql.slice(closeIdx).includes('ON CONFLICT')) return { sql, params };
  const filled = newSql.slice(0, closeIdx) + ', ' + missing.map(() => '?').join(', ') + newSql.slice(closeIdx);

  const stamp = nowIso();
  return { sql: filled, params: [...params, ...missing.map(() => stamp)] };
}

function run(sql, params = []) {
  const t = withIsoTimes(sql, params);
  return db.prepare(t.sql).run(...t.params);
}
function all(sql, params = []) {
  return db.prepare(sql).all(...params).map((r) => ({ ...r }));
}
function get(sql, params = []) {
  const r = db.prepare(sql).get(...params);
  return r ? { ...r } : null;
}
function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function logEvent(level, scope, message, meta) {
  try {
    // 显式写入时间，不依赖表上的 DEFAULT：
    // 老库的 events 表是 `DEFAULT (datetime('now'))` 建的，
    // 而 SQLite 的 CREATE TABLE IF NOT EXISTS 不会更新已有表的默认值，
    // 所以走默认值就会写出「不带时区标记」的 UTC，前端当本地时间解析后差 8 小时。
    run('INSERT INTO events(at,level,scope,message,meta) VALUES(?,?,?,?,?)',
      [nowIso(), level, scope, String(message || '').slice(0, 2000), meta ? JSON.stringify(meta) : null]);
  } catch {}
}

function parseJson(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

module.exports = {
  db, DB_FILE, nowIso, run, all, get, tx, logEvent, parseJson, sha1,
  migrate, tableColumns, addColumnIfMissing, normalizeStoredTimes, legacyTimeDefaults, withIsoTimes,
};
