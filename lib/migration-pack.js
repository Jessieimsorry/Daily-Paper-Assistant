"use strict";
const store = require("./store"),
  custom = require("./customize");
const TABLES = [
  "topics",
  "journals",
  "papers",
  "library",
  "judgments",
  "interpretations",
  "interpretation_materials",
  "translations",
  "reader_papers",
  "frontier_items",
  "dpa_science",
  "dpa_translations",
  "dpa_attention",
  "dpa_shared_reading",
  "dpa_jobs",
];
const DOCS = [
  "identity",
  "categories",
  "profiles",
  "bindings",
  "agents",
  "workflows",
  "streams",
  "limits",
  "translationSettings",
  "languageOverrides",
  "readingPrefs",
  "readingPresets",
];
function exportPack() {
  return {
    format: "Daily-Paper-Assistant",
    version: 1,
    at: new Date().toISOString(),
    tables: Object.fromEntries(
      TABLES.map((t) => [t, store.all("SELECT * FROM " + t)]),
    ),
    config: Object.fromEntries(
      DOCS.map((k) => [
        k,
        k === "profiles"
          ? require("./models")
              .list()
              .map(({ keyConfigured, ...p }) => p)
          : custom.get(k),
      ]),
    ),
  };
}
function preview(p) {
  if (
    p?.format !== "Daily-Paper-Assistant" ||
    p.version !== 1 ||
    !p.tables ||
    typeof p.tables !== "object"
  )
    throw Error("不是支持的数据迁移包");
  let count = 0;
  for (const t of TABLES) {
    if (p.tables[t] && !Array.isArray(p.tables[t]))
      throw Error("迁移表格式错误");
    count += (p.tables[t] || []).length;
  }
  if (count > 200000) throw Error("迁移包记录过多");
  const conflicts = (p.tables.papers || []).filter((r) =>
    r.doi_norm
      ? store.get("SELECT id FROM papers WHERE doi_norm=?", [r.doi_norm])
      : store.get("SELECT id FROM papers WHERE dedup_key=?", [r.dedup_key]),
  ).length;
  return {
    ok: true,
    counts: Object.fromEntries(
      TABLES.map((t) => [t, (p.tables[t] || []).length]),
    ),
    paperConflicts: conflicts,
    policy: "保留本地已有记录；只添加未存在的内容；不导入密钥",
  };
}
function commit(p) {
  preview(p);
  const fresh =
    !custom.get("identity", {}).onboarded &&
    store.get("SELECT COUNT(*) c FROM papers").c === 0;
  const maps = {},
    stats = { inserted: 0, conflicts: 0 };
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS dpa_imported(key TEXT PRIMARY KEY)",
  );
  store.tx(() => {
    for (const t of TABLES) {
      maps[t] = new Map();
      const columns = store
        .all("PRAGMA table_info(" + t + ")")
        .map((c) => c.name);
      for (const src of p.tables[t] || []) {
        let row = Object.fromEntries(
          Object.entries(src).filter(([k]) => columns.includes(k)),
        );
        if (row.paper_id != null) {
          const mapped = maps.papers.get(row.paper_id);
          if (!mapped) continue;
          row.paper_id = mapped;
        }
        if (row.interp_id != null) {
          row.interp_id = maps.interpretations.get(row.interp_id);
          if (!row.interp_id) continue;
        }
        if (row.matched_paper_id)
          row.matched_paper_id = maps.papers.get(row.matched_paper_id) || null;
        if (row.journal_id != null)
          row.journal_id = maps.journals.get(row.journal_id) || null;
        if (
          t === "dpa_shared_reading" &&
          /^(paper|frontier|science):/.test(row.key || "")
        ) {
          const [kind, oldId] = row.key.split(":");
          const id = maps[
            kind === "paper"
              ? "papers"
              : kind === "frontier"
                ? "frontier_items"
                : "dpa_science"
          ]?.get(Number(oldId));
          if (!id) continue;
          row.key = kind + ":" + id;
        }
        if (t === "dpa_translations" && row.subject_key?.startsWith("paper:")) {
          const id = maps.papers.get(Number(row.subject_key.split(":")[1]));
          if (!id) continue;
          row.subject_key = "paper:" + id;
        } else if (t === "dpa_translations" && row.subject_key) {
          const kind = row.subject_key.split(":")[0],
            id = maps[
              kind === "frontier" ? "frontier_items" : "dpa_science"
            ]?.get(Number(row.subject_key.split(":")[1]));
          if (!id) continue;
          row.subject_key = kind + ":" + id;
        }
        let old;
        if (t === "papers")
          old = row.doi_norm
            ? store.get("SELECT id FROM papers WHERE doi_norm=?", [
                row.doi_norm,
              ])
            : store.get("SELECT id FROM papers WHERE dedup_key=?", [
                row.dedup_key,
              ]);
        if (t === "journals")
          old = row.issn
            ? store.get("SELECT id FROM journals WHERE issn=?", [row.issn])
            : store.get("SELECT id FROM journals WHERE name=?", [row.name]);
        if (t === "topics")
          old = store.get("SELECT id FROM topics WHERE slug=?", [row.slug]);
        if (t === "frontier_items")
          old = store.get("SELECT id FROM frontier_items WHERE dedup_key=?", [
            row.dedup_key,
          ]);
        if (t === "dpa_science")
          old = store.get("SELECT id FROM dpa_science WHERE doi=?", [row.doi]);
        if (old) {
          maps[t].set(src.id, old.id);
          stats.conflicts++;
          continue;
        }
        if (t === "library" || t === "reader_papers" || t === "judgments") {
          if (
            store.get("SELECT * FROM " + t + " WHERE paper_id=?", [
              row.paper_id,
            ])
          ) {
            stats.conflicts++;
            continue;
          }
        }
        const importKey = t + ":" + store.sha1(JSON.stringify(src));
        if (
          store.get("SELECT key FROM dpa_imported WHERE key=?", [importKey])
        ) {
          stats.conflicts++;
          continue;
        }
        if (columns.includes("id")) delete row.id;
        if (t === "dpa_jobs") {
          const snap = store.parseJson(row.snapshot, {});
          if (snap.subjectKey) {
            const [kind, oldId] = snap.subjectKey.split(":");
            const mapped = maps[
              kind === "paper"
                ? "papers"
                : kind === "frontier"
                  ? "frontier_items"
                  : "dpa_science"
            ]?.get(Number(oldId));
            if (mapped) snap.subjectKey = kind + ":" + mapped;
            row.snapshot = JSON.stringify(snap);
          }
          row.id = require("node:crypto").randomUUID();
          if (["running", "queued"].includes(row.status)) {
            row.status = "failed";
            row.error = "迁移时停止的任务；可手动重试";
          }
        }
        const keys = Object.keys(row);
        if (!keys.length) continue;
        const r = store.run(
          `INSERT OR IGNORE INTO ${t}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
          keys.map((k) => row[k]),
        );
        const id = store.get("SELECT last_insert_rowid() id").id;
        if (src.id != null) maps[t].set(src.id, id);
        if (r.changes) {
          stats.inserted++;
          store.run("INSERT OR IGNORE INTO dpa_imported(key) VALUES(?)", [
            importKey,
          ]);
        } else stats.conflicts++;
      }
    } // 配置是本地优先；干净实例只补缺失项，连接永远不含密钥。
    for (const k of DOCS) {
      if ((fresh || !custom.get(k)) && p.config?.[k]) {
        let v = p.config[k];
        if (k === "profiles")
          v = v.map((x) => ({
            ...Object.fromEntries(
              [
                "id",
                "name",
                "baseUrl",
                "model",
                "temperature",
                "maxTokens",
              ].map((f) => [f, x[f]]),
            ),
            legacy: false,
          }));
        custom.put(k, v);
      }
    }
  });
  return { ok: true, ...stats };
}
function citations(format) {
  const rows = store.all(
    "SELECT p.* FROM papers p JOIN library l ON p.id=l.paper_id WHERE l.starred=1",
  );
  const safe = (s) =>
    String(s || "")
      .replace(/[{}\\]/g, " ")
      .replace(/[\r\n]/g, " ");
  if (format === "bibtex")
    return rows
      .map(
        (p) =>
          `@article{paper${p.id},\n title={${safe(p.title)}},\n author={${store.parseJson(p.authors, []).map(safe).join(" and ")}},\n journal={${safe(p.journal_name)}},\n year={${safe((p.issued_date || p.published_online || "").slice(0, 4))}},\n doi={${safe(p.doi_norm)}},\n url={${safe(p.url)}}\n}`,
      )
      .join("\n\n");
  return rows
    .map((p) =>
      [
        "TY  - JOUR",
        "TI  - " + safe(p.title),
        ...store.parseJson(p.authors, []).map((a) => "AU  - " + safe(a)),
        "JO  - " + safe(p.journal_name),
        "DO  - " + safe(p.doi_norm),
        "UR  - " + safe(p.url),
        "PY  - " +
          safe((p.issued_date || p.published_online || "").slice(0, 4)),
        "ER  - ",
      ].join("\n"),
    )
    .join("\n\n");
}
module.exports = { exportPack, preview, commit, citations };
