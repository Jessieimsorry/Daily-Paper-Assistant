"use strict";
const store = require("./store"),
  reader = require("./reader");
const EXTRA = [
  [
    "education-psychology",
    "教育学与教育心理学",
    ["教育心理学", "学习动机", "教育学"],
    ["educational psychology", "learning motivation", "pedagogy"],
  ],
  [
    "culture",
    "文化学与跨文化交际学",
    ["跨文化交际", "文化研究", "超文化"],
    [
      "intercultural communication",
      "cross-cultural communication",
      "transcultural communication",
      "cultural studies",
    ],
  ],
  [
    "area-studies",
    "区域国别学",
    ["区域国别研究", "区域研究"],
    ["area studies", "regional studies"],
  ],
  [
    "sinology",
    "汉学与世界汉学",
    ["汉学", "世界汉学", "海外汉学"],
    ["sinology", "Chinese studies", "global sinology"],
  ],
];
function initialize() {
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS dpa_documents(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS dpa_jobs(id TEXT PRIMARY KEY,kind TEXT,status TEXT,snapshot TEXT,steps TEXT,created_at TEXT,updated_at TEXT,error TEXT);
 CREATE TABLE IF NOT EXISTS dpa_translations(subject_key TEXT,field TEXT,target_lang TEXT,fingerprint TEXT,text TEXT,model TEXT,created_at TEXT,PRIMARY KEY(subject_key,field,target_lang,fingerprint));
 CREATE TABLE IF NOT EXISTS dpa_usage(id INTEGER PRIMARY KEY,day TEXT,profile_id TEXT,model TEXT,tokens INTEGER,ok INTEGER);
 CREATE TABLE IF NOT EXISTS dpa_science(id INTEGER PRIMARY KEY,doi TEXT UNIQUE,title TEXT,journal TEXT,abstract TEXT,language TEXT,date TEXT,url TEXT,first_seen TEXT,last_picked TEXT,type TEXT);
 CREATE TABLE IF NOT EXISTS dpa_attention(name TEXT PRIMARY KEY,issn TEXT,note TEXT);
 CREATE TABLE IF NOT EXISTS dpa_shared_reading(key TEXT PRIMARY KEY,value TEXT);
 `);
  if (
    !store
      .all("PRAGMA table_info(topics)")
      .some((c) => c.name === "exclude_terms")
  )
    store.db.exec(
      "ALTER TABLE topics ADD COLUMN exclude_terms TEXT DEFAULT '[]'",
    );
  if (!reader.getState("dpa-v2-initialized", false)) {
    const old = require("./categories").BUILTIN_CATEGORIES.map((c) => ({
      ...c,
      visible: true,
      automatic: true,
    }));
    for (const [slug, name, zh, en] of EXTRA) {
      store.run(
        "INSERT OR IGNORE INTO topics(slug,name_zh,keywords_zh,keywords_en,enabled) VALUES(?,?,?,?,1)",
        [slug, name, JSON.stringify(zh), JSON.stringify(en)],
      );
      old.push({
        id: slug,
        name,
        color: "sage",
        topics: [slug],
        visible: true,
        automatic: false,
      });
    }
    put("categories", old);
    const config = require("./config"),
      s = config.getSettings();
    put(
      "identity",
      store.get("SELECT COUNT(*) c FROM papers").c > 0
        ? {
            ...reader.getState("legacyIdentity", {
              name: "科研文献阅读工作台",
              subtitle: "",
            }),
            onboarded: true,
          }
        : { name: "科研文献阅读工作台", subtitle: "", onboarded: false },
    );
    put("profiles", [
      {
        id: "default",
        name: "默认连接",
        baseUrl: s.aiBaseUrl,
        model: s.aiModel,
        temperature: s.aiTemperature,
        maxTokens: s.aiMaxTokens,
        legacy: true,
      },
    ]);
    put("bindings", {
      translation: "default",
      quick: "default",
      deep: "default",
    });
    put("agents", [
      {
        id: "translation",
        name: "翻译",
        scope: "abstract",
        profileId: "default",
        prompt: "忠实翻译以下材料，保留数字和术语，不补充原文没有的信息。",
        trigger: "manual",
      },
      {
        id: "quick",
        name: "速览",
        scope: "abstract",
        profileId: "default",
        prompt: "基于所给材料总结研究问题、方法与发现，说明证据范围。",
        trigger: "manual",
      },
      {
        id: "methods",
        name: "方法分析",
        scope: "fulltext",
        profileId: "default",
        prompt: "分析研究设计、测量和分析方法；全文未提供时明确说明，不猜测。",
        trigger: "manual",
      },
      {
        id: "ideas",
        name: "研究启发",
        scope: "abstract",
        profileId: "default",
        prompt: "提出可供研究或教学借鉴的方向，区分原文结论与自己的建议。",
        trigger: "manual",
      },
    ]);
    put("workflows", [
      {
        id: "reading",
        name: "速览 → 方法分析 → 研究启发",
        agentIds: ["quick", "methods", "ideas"],
      },
    ]);
    put("streams", {
      research: true,
      frontier: s.frontierDaily !== false,
      science: true,
      scienceSize: 5,
      scienceDays: 30,
      sources: ["crossref", "openalex", "cn-catalog"],
      frontierSources: ["eric", "arxiv", "acl", "ieee"],
    });
    put("limits", { dailyCalls: 0 });
    reader.setState("dpa-v2-initialized", true);
  }
  if(!get('legacyTranslationBaseline')){const s=require('./config').getSettings();put('legacyTranslationBaseline',{model:s.aiModel,baseUrl:s.aiBaseUrl,temperature:s.aiTemperature,maxTokens:s.aiMaxTokens,prompt:get('agents',[]).find(a=>a.id==='translation')?.prompt});}
}
function get(key, fallback) {
  try {
    const r = store.get("SELECT value FROM dpa_documents WHERE key=?", [key]);
    return r ? store.parseJson(r.value, fallback) : fallback;
  } catch {
    return fallback;
  }
}
function put(key, value) {
  store.run(
    "INSERT INTO dpa_documents(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [key, JSON.stringify(value)],
  );
  return value;
}
function categories() {
  return get("categories", require("./categories").BUILTIN_CATEGORIES);
}
function autoTopics() {
  if (!get("categories"))
    return require("./discover")
      .listTopics(true)
      .map((t) => t.slug);
  const enabled = new Set(
    require("./discover")
      .listTopics(true)
      .map((t) => t.slug),
  );
  return [
    ...new Set(
      categories()
        .filter((c) => c.automatic)
        .flatMap((c) => c.topics),
    ),
  ].filter((s) => enabled.has(s));
}
function saveCategories(items) {
  if (!Array.isArray(items) || items.length > 50) throw Error("栏目最多50个");
  const ids = new Set();
  for (const c of items) {
    if (
      !/^[a-z0-9_-]{1,64}$/.test(c.id) ||
      ids.has(c.id) ||
      !c.name?.trim() ||
      !Array.isArray(c.topics)
    )
      throw Error("栏目名称或编号无效");
    ids.add(c.id);
    c.color = ["sage", "blue", "purple", "ochre", "clay"].includes(c.color)
      ? c.color
      : "sage";
    c.visible = c.visible !== false;
    c.automatic = Boolean(c.automatic);
  }
  put("categories", items);
  return items;
}
function linked(key) {
  const [kind, id] = String(key).split(":");
  if (kind === "paper") return Number(id);
  let doi =
    kind === "science"
      ? store.get("SELECT doi FROM dpa_science WHERE id=?", [id])?.doi
      : store.get("SELECT doi_norm FROM frontier_items WHERE id=?", [id])
          ?.doi_norm;
  return doi
    ? store.get("SELECT id FROM papers WHERE doi_norm=?", [doi])?.id
    : null;
}
function subject(key) {
  const [kind, id] = String(key).split(":");
  if (
    !["paper", "science", "frontier"].includes(kind) ||
    !/^\d+$/.test(id || "")
  )
    throw Error("无效文献编号");
  const row = store.get(
    `SELECT * FROM ${kind === "paper" ? "papers" : kind === "science" ? "dpa_science" : "frontier_items"} WHERE id=?`,
    [id],
  );
  if (!row) throw Error("文献不存在");
  return {
    ...row,
    subjectKey: key,
    title: row.title,
    abstract: row.abstract || "",
    language: row.language || "unknown",
    doi: row.doi || row.doi_norm,
    url: row.url || row.source_url,
    paperId: linked(key),
  };
}
function readingKey(key) {
  const s = subject(key);
  return s.doi ? "doi:" + s.doi.toLowerCase() : key;
}
function reading(key, value) {
  const pid = linked(key);
  if (value) {
    value = {
      ...store.parseJson(
        store.get("SELECT value FROM dpa_shared_reading WHERE key=?", [
          readingKey(key),
        ])?.value,
        {},
      ),
      ...value,
    };
    if (pid && "browsed" in value)
      reader.action("browsed", [pid], Boolean(value.browsed));
    if (pid && "starred" in value)
      reader.action("starred", [pid], Boolean(value.starred));
    store.run(
      "INSERT INTO dpa_shared_reading(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [readingKey(key), JSON.stringify(value)],
    );
  }
  const row = store.get("SELECT value FROM dpa_shared_reading WHERE key=?", [
    readingKey(key),
  ]);
  const paper = pid
    ? store.get("SELECT starred,read_state FROM library WHERE paper_id=?", [
        pid,
      ])
    : null;
  const browsed = pid
    ? store.get("SELECT browsed_at FROM reader_papers WHERE paper_id=?", [pid])
    : null;
  return {
    ...store.parseJson(row?.value, {}),
    ...(pid
      ? {
          starred: Boolean(paper?.starred),
          browsed: Boolean(browsed?.browsed_at),
        }
      : {}),
    paperId: pid,
  };
}
module.exports = {
  initialize,
  get,
  put,
  categories,
  autoTopics,
  saveCategories,
  subject,
  linked,
  reading,
};
