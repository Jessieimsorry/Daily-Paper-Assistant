"use strict";
const store = require("./store"),
  custom = require("./customize");
const JOURNALS = [
  { name: "Nature", issn: "0028-0836" },
  { name: "Cell", issn: "0092-8674" },
  { name: "Science", issn: "0036-8075" },
];
function get() {
  const pref = custom.get("streams", {}),
    size = Math.max(1, Math.min(50, Number(pref.scienceSize) || 5)),
    since = new Date(Date.now() - (Number(pref.scienceDays) || 30) * 86400000)
      .toISOString()
      .slice(0, 10);
  let items = store.all(
    "SELECT * FROM dpa_science WHERE date>=? ORDER BY (last_picked IS NULL) DESC,date DESC LIMIT ?",
    [since, size],
  );
  const picks = custom.get("sciencePicks", []);
  if (picks.length)
    items = picks
      .map((id) => store.get("SELECT * FROM dpa_science WHERE id=?", [id]))
      .filter(Boolean);
  return {
    ok: true,
    items: items.map((s) => ({
      ...s,
      subjectKey: "science:" + s.id,
      reading: custom.reading("science:" + s.id),
    })),
    sources: custom.get("scienceStatus", []),
    updatedAt: custom.get("scienceUpdated"),
  };
}
async function collect({ days, size, fetcher, signal } = {}) {
  const pref = custom.get("streams", {}),
    from = new Date(Date.now() - (days || pref.scienceDays || 30) * 86400000)
      .toISOString()
      .slice(0, 10),
    status = [];
  for (const journal of JOURNALS) {
    if (signal?.aborted) break;
    try {
      const url = new URL(
        "https://api.crossref.org/journals/" + journal.issn + "/works",
      );
      url.searchParams.set("filter", "from-pub-date:" + from);
      url.searchParams.set("sort", "published");
      url.searchParams.set("order", "desc");
      url.searchParams.set("rows", "30");
      const res = fetcher
        ? await fetcher(url.toString())
        : await require("./http").fetchJson(url.toString());
      const data = res.data || res;
      const items = data.message?.items;
      if (res.ok === false || !Array.isArray(items))
        throw Error(res.error || "Crossref 返回格式不正确");
      let inserted = 0;
      for (const x of items) {
        if (!x.DOI || !x.title?.[0]) continue;
        const date =
          (x["published-online"] || x.published || x.issued)?.[
            "date-parts"
          ]?.[0]
            ?.map((n, i) => (i ? String(n).padStart(2, "0") : n))
            .join("-") || "";
        if (date < from) continue;
        const abstract = String(x.abstract || "")
          .replace(/<[^>]+>/g, " ")
          .trim();
        const doi = x.DOI.toLowerCase();
        if (!store.get("SELECT id FROM dpa_science WHERE doi=?", [doi]))
          inserted++;
        store.run(
          `INSERT INTO dpa_science(doi,title,journal,abstract,language,date,url,first_seen,type) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(doi) DO UPDATE SET title=excluded.title,abstract=excluded.abstract,date=excluded.date,url=excluded.url`,
          [
            doi,
            x.title[0],
            journal.name,
            abstract,
            x.language || "unknown",
            date,
            x.resource?.primary?.URL || x.URL || "https://doi.org/" + doi,
            new Date().toISOString(),
            x.type || "unknown",
          ],
        );
      }
      status.push({
        source: journal.name,
        ok: true,
        found: items.length,
        inserted,
        checkedAt: new Date().toISOString(),
      });
    } catch (e) {
      status.push({
        source: journal.name,
        ok: false,
        error: String(e.message).slice(0, 300),
        checkedAt: new Date().toISOString(),
      });
    }
  }
  custom.put("scienceStatus", status);
  custom.put("scienceUpdated", new Date().toISOString());
  if (status.some((s) => s.ok)) {
    const pool = store.all(
        "SELECT id,journal,date,last_picked FROM dpa_science WHERE date>=? ORDER BY (last_picked IS NULL) DESC,date DESC",
        [from],
      ),
      limit = Math.max(1, Math.min(50, Number(size || pref.scienceSize) || 5)),
      chosen = [];
    for (const j of JOURNALS) {
      const candidate =
        pool.find((x) => x.journal === j.name && !x.last_picked) ||
        pool.find((x) => x.journal === j.name);
      if (candidate && chosen.length < limit) chosen.push(candidate.id);
    }
    for (const x of pool) {
      if (chosen.length >= limit) break;
      if (!chosen.includes(x.id)) chosen.push(x.id);
    }
    const ids = chosen;
    custom.put("sciencePicks", ids);
    for (const id of ids)
      store.run("UPDATE dpa_science SET last_picked=? WHERE id=?", [
        new Date().toISOString(),
        id,
      ]);
  }
  return { ...get(), ok: status.some((s) => s.ok) };
}
module.exports = { get, collect, JOURNALS };
