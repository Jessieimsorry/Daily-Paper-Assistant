"use strict";
module.exports = function ({ route, readJson, revalidate }) {
  const custom = require("./customize"),
    store = require("./store"),
    models = require("./models"),
    tasks = require("./tasks");
  const post = (path, fn) =>
    route("POST", path, async (req, url, m, raw) =>
      fn(await readJson(req, raw), m),
    );
  route("GET", "/api/customization", () => ({
    ok: true,
    identity: custom.get("identity"),
    categories: custom.categories(),
    topics: require("./discover").listTopics(false),
    profiles: models.list(),
    bindings: custom.get("bindings"),
    agents: custom.get("agents"),
    workflows: custom.get("workflows"),
    streams: custom.get("streams"),
    limits: custom.get("limits"),
    translationSettings: custom.get("translationSettings", { target: "auto" }),
    readingPrefs: custom.get("readingPrefs", {}),
    readingPresets: custom.get("readingPresets", {}),
    researchSize: require("./config").getSettings().briefSize,
    frontierSize: require("./config").getSettings().frontierSize,
    catalogTypes: require("./journals").CATALOG_TYPES,
    usage: store.all(
      "SELECT day,COUNT(*) calls,SUM(tokens) tokens,SUM(tokens IS NULL) missingTokens FROM dpa_usage GROUP BY day ORDER BY day DESC LIMIT 30",
    ),
  }));
  post("/api/customization", (b) => {
    const keys = [
      "identity",
      "bindings",
      "streams",
      "limits",
      "translationSettings",
      "readingPrefs",
      "readingPresets",
    ];
    for (const k of keys)
      if (k in b) {
        if (
          k === "bindings" &&
          Object.values(b[k]).some(
            (id) => !models.list().some((p) => p.id === id),
          )
        )
          throw Error("模型连接不存在");
        if (
          k === "streams" &&
          (!b[k] ||
            Number(b[k].scienceSize) < 1 ||
            Number(b[k].scienceSize) > 50)
        )
          throw Error("科学进展数量应为1–50");
        if (k === "identity" && (!b[k].name?.trim() || b[k].name.length > 80))
          throw Error("工作台名称应为1–80字");
        if (
          k === "limits" &&
          (!Number.isInteger(Number(b[k].dailyCalls)) ||
            Number(b[k].dailyCalls) < 0)
        )
          throw Error("每日调用上限应为非负整数");
        if (
          k === "translationSettings" &&
          ![
            "auto",
            ...Object.keys(require("./multilingual").LANGS).filter(
              (x) => x !== "unknown",
            ),
          ].includes(b[k].target)
        )
          throw Error("目标语种无效");
        custom.put(k, b[k]);
      }
    return { ok: true };
  });
  post("/api/categories", (b) => ({
    ok: true,
    items: custom.saveCategories(b.items),
  }));
  post("/api/model-profiles", (b) => ({ ok: true, items: models.save(b) }));
  post("/api/model-profiles/:id/test", async (b, m) => {
    const p = models.resolve(m.id);
    const r = await models.withProfile(m.id, () =>
      require("./interpret").callModel(
        [{ role: "user", content: "请只回复：连接成功" }],
        { profileId: m.id, maxTokens: 256 },
      ),
    );
    return { ok: r.ok, reply: r.content, model: r.model, error: r.error };
  });
  post("/api/agents", (b) => {
    if (!Array.isArray(b.items) || b.items.length > 50)
      throw Error("最多50个智能体");
    const ids = new Set();
    for (const a of b.items) {
      if (
        !/^[a-zA-Z0-9_-]{1,80}$/.test(a.id) ||
        ids.has(a.id) ||
        !a.name ||
        !a.prompt ||
        !["metadata", "abstract", "fulltext"].includes(a.scope)
      )
        throw Error("智能体名称、提示词或输入范围无效");
      ids.add(a.id);
      models.resolve(a.profileId);
      a.trigger = a.trigger === "automatic" ? "automatic" : "manual";
    }
    custom.put("agents", b.items);
    return { ok: true };
  });
  post("/api/workflows", (b) => {
    if (!Array.isArray(b.items)) throw Error("流程格式无效");
    const ids = new Set(custom.get("agents", []).map((a) => a.id));
    for (const w of b.items)
      if (
        !w.id ||
        !w.name ||
        !Array.isArray(w.agentIds) ||
        !w.agentIds.length ||
        w.agentIds.length > 20 ||
        w.agentIds.some((id) => !ids.has(id))
      )
        throw Error("流程包含未知智能体或超过20个步骤");
    custom.put("workflows", b.items);
    return { ok: true };
  });
  post("/api/search-jobs", (b) => {
    if (!["research", "frontier", "science"].includes(b.region))
      throw Error("请选择检索区域");
    if (!Array.isArray(b.sources) || !b.sources.length)
      throw Error("请选择数据源");
    if (
      b.region === "research" &&
      (!Array.isArray(b.topics) || !b.topics.length)
    )
      throw Error("请选择研究方向");
    if (
      b.region === "research" &&
      b.topics.some(
        (x) =>
          !require("./discover")
            .listTopics(false)
            .some((t) => t.slug === x),
      )
    )
      throw Error("研究方向不存在");
    const allowed =
      b.region === "research"
        ? ["crossref", "openalex", "cn-catalog"]
        : b.region === "science"
          ? ["crossref"]
          : ["eric", "arxiv", "acl", "ieee"];
    if (b.sources.some((s) => !allowed.includes(s)))
      throw Error("所选数据源不属于这个区域");
    b.days = Math.max(1, Math.min(365, Number(b.days) || 30));
    return {
      ok: true,
      job: tasks.add("search", {
        region: b.region,
        topics: b.topics || [],
        topicNames: (b.topics || []).map(
          (slug) =>
            require("./discover")
              .listTopics(false)
              .find((t) => t.slug === slug)?.name_zh || slug,
        ),
        sources: b.sources,
        days: b.days,
        size: b.size,
      }),
    };
  });
  route("GET", "/api/tasks", () => ({ ok: true, items: tasks.list() }));
  post("/api/tasks/:id/cancel", (b, m) => ({
    ok: true,
    job: tasks.cancel(m.id),
  }));
  post("/api/tasks/:id/retry", (b, m) => ({
    ok: true,
    job: tasks.retry(m.id),
  }));
  post("/api/agent-jobs", (b) => {
    custom.subject(b.subjectKey);
    let agents;
    if (b.workflowId) {
      const w = custom.get("workflows", []).find((w) => w.id === b.workflowId);
      if (!w) throw Error("流程不存在");
      agents = w.agentIds.map((id) =>
        custom.get("agents", []).find((a) => a.id === id),
      );
    } else agents = [custom.get("agents", []).find((a) => a.id === b.agentId)];
    if (agents.some((a) => !a)) throw Error("智能体不存在");
    return {
      ok: true,
      job: tasks.add("agents", { subjectKey: b.subjectKey, agents }),
    };
  });
  route('GET','/api/translation-history/:kind/:id',(req,url,m)=>{const key=m.kind+':'+m.id;custom.subject(key);const items=store.all('SELECT field,target_lang,text,model,created_at FROM dpa_translations WHERE subject_key=? ORDER BY created_at DESC',[key]);if(m.kind==='paper')items.push(...store.all("SELECT field,target_lang,translated text,model,created_at FROM translations WHERE paper_id=? AND status='ok' ORDER BY created_at DESC",[Number(m.id)]));if(m.kind==='frontier'){const s=custom.subject(key);for(const field of ['title','abstract'])if(s[field+'_zh'])items.push({field,target_lang:'zh',text:s[field+'_zh'],model:s.translate_model,created_at:s.translated_at});}return {ok:true,items};});
  route("GET", "/api/science", () => require("./science").get());
  route("GET", "/api/subject/:kind/:id", (req, url, m) => {
    const key = m.kind + ":" + m.id;
    return {
      ok: true,
      subject: custom.subject(key),
      reading: custom.reading(key),
      translations: Object.fromEntries(
        ["title", "abstract", "keywords"].map((f) => [
          f,
          require("./multilingual").saved(key, f),
        ]),
      ),
    };
  });
  post("/api/subject-reading", (b) => ({
    ok: true,
    reading: custom.reading(b.subjectKey, b.value),
  }));
  post("/api/multilingual", (b) => {
    custom.subject(b.subjectKey);
    if (!["title", "abstract", "keywords"].includes(b.field))
      throw Error("未知字段");
    return { ok: true, job: tasks.add("translation", b) };
  });
  post("/api/subject-language", (b) => {
    custom.subject(b.subjectKey);
    if (!Object.keys(require("./multilingual").LANGS).includes(b.language))
      throw Error("不支持的原文语种");
    const values = custom.get("languageOverrides", {});
    values[b.subjectKey] = b.language;
    custom.put("languageOverrides", values);
    if (b.subjectKey.startsWith("paper:"))
      store.run(
        "UPDATE papers SET language=?,language_source='manual' WHERE id=?",
        [b.language, Number(b.subjectKey.split(":")[1])],
      );
    return { ok: true };
  });
  post("/api/catalog/parse", (b) => require("./catalog-import").parse(b));
  post("/api/catalog/preview", (b) => require("./catalog-import").preview(b));
  post("/api/catalog/commit", (b) => {
    const r = require("./catalog-import").commit(b);
    if (r.ok && b.catalogKey !== "attention") r.revalidate = revalidate();
    return r;
  });
  route("GET", "/api/stream-library", () => {
    const items = [],
      seen = new Set();
    for (const [kind, table] of [
      ["science", "dpa_science"],
      ["frontier", "frontier_items"],
    ])
      for (const row of store.all("SELECT * FROM " + table)) {
        const key = kind + ":" + row.id,
          reading = custom.reading(key),
          doi = row.doi || row.doi_norm;
        if (!reading.starred || reading.paperId || seen.has(doi || key))
          continue;
        seen.add(doi || key);
        items.push({ ...row, subjectKey: key, reading });
      }
    return { ok: true, items };
  });
  route("GET", "/api/attention-journals", () => ({
    ok: true,
    items: store.all("SELECT * FROM dpa_attention"),
  }));
  route("GET", "/api/data/export", (req, url) => ({
    ok: true,
    ...(url.searchParams.get("format")
      ? {
          text: require("./migration-pack").citations(
            url.searchParams.get("format"),
          ),
        }
      : { pack: require("./migration-pack").exportPack() }),
  }));
  post("/api/data/preview", (b) => require("./migration-pack").preview(b.pack));
  post("/api/data/import", (b) => require("./migration-pack").commit(b.pack));
};
