"use strict";
const custom = require("./customize"),
  store = require("./store"),
  models = require("./models");
const active = new Map(),
  pending = [];
let running = 0;
const LANGS = {
  zh: "中文",
  en: "英文",
  ja: "日文",
  fr: "法文",
  de: "德文",
  es: "西班牙文",
  ru: "俄文",
  ko: "韩文",
  ar: "阿拉伯文",
  pt: "葡萄牙文",
  it: "意大利文",
  vi: "越南文",
  th: "泰文",
  tr: "土耳其文",
  id: "印尼文",
  unknown: "自动识别原文语言",
};
function language(s) {
  const override = custom.get("languageOverrides", {})[s.subjectKey];
  return override || s.language || "unknown";
}
function settings(s, opts = {}) {
  const pref = custom.get("translationSettings", { target: "auto" }),
    source = language(s);
  const target = opts.targetLang || pref.target;
  return {
    sourceLang: source,
    targetLang:
      !target || target === "auto" ? (source === "zh" ? "en" : "zh") : target,
  };
}
function info(key, field, opts = {}) {
  if (!["title", "abstract", "keywords"].includes(field))
    throw Error("未知翻译字段");
  const s = custom.subject(key),
    { sourceLang, targetLang } = settings(s, opts);
  if (!LANGS[targetLang] || targetLang === "unknown")
    throw Error("不支持的目标语种");
  let text = s[field] || "";
  if (field === "keywords")
    text = store
      .parseJson(s.keywords, [])
      .map((x) => (typeof x === "string" ? x : x?.name || x?.display_name))
      .filter(Boolean)
      .join("; ");
  const p = models.resolve(opts.profileId, "translation"),
    template =
      custom.get("agents", []).find((a) => a.id === "translation")?.prompt ||
      "忠实翻译，保留数字、统计结果、引文及术语，不补充不存在的信息。";
  const fingerprint = store.sha1(
    JSON.stringify([
      text,
      sourceLang,
      targetLang,
      p?.id,
      p?.model,
      p?.baseUrl,
      p?.temperature,
      p?.maxTokens,
      template,
    ]),
  );
  const row = store.get(
    "SELECT * FROM dpa_translations WHERE subject_key=? AND field=? AND target_lang=? AND fingerprint=?",
    [key, field, targetLang, fingerprint],
  );
  let legacy = null;
  const baseline=custom.get('legacyTranslationBaseline');const compatible=!baseline||JSON.stringify([p?.model,p?.baseUrl,p?.temperature,p?.maxTokens,template])===JSON.stringify([baseline.model,baseline.baseUrl,baseline.temperature,baseline.maxTokens,baseline.prompt]);
  if (!row && (!p || p.legacy) && !opts.force && compatible) {
    if (key.startsWith("paper:") && ["en", "zh"].includes(sourceLang))
      legacy = store.get(
        "SELECT * FROM translations WHERE paper_id=? AND field=? AND target_lang=? AND source_hash=? AND status='ok'",
        [s.id, field, targetLang, store.sha1(text.trim())],
      );
    if (key.startsWith("frontier:") && targetLang === "zh")
      legacy = {
        translated: s[field + "_zh"],
        model: s.translate_model,
        created_at: s.translated_at,
      };
  }
  return {
    s,
    p,
    template,
    text,
    fingerprint,
    sourceLang,
    targetLang,
    row,
    legacy,
  };
}
function saved(key, field, opts = {}) {
  const i = info(key, field, opts),
    text = i.row?.text || i.legacy?.translated || null;
  return {
    ok: true,
    available: Boolean(i.text),
    sourceText: i.text,
    sourceLang: i.sourceLang,
    targetLang: i.targetLang,
    translated: text,
    text,
    status: !i.text ? "unavailable" : text ? "ok" : "missing",
    model: i.row?.model || i.legacy?.model,
    createdAt: i.row?.created_at || i.legacy?.created_at,
    note: i.text
      ? null
      : "原始数据未提供" + (field === "keywords" ? "关键词" : "摘要"),
    legacyCache: !i.row && Boolean(text),
  };
}
async function perform(o) {
  const i = info(o.subjectKey, o.field, o),
    old = saved(o.subjectKey, o.field, o);
  if (!i.text) return { ...old, ok: false, error: old.note };
  if (old.text && !o.force)
    return { ...old, ok: true, cached: true, translated: old.text };
  const r = await models.withProfile(i.p?.id, () =>
    require("./interpret").callModel(
      [
        {
          role: "system",
          content:
            i.template +
            `\n原文语言：${LANGS[i.sourceLang] || "自动识别"}；目标语言：${LANGS[i.targetLang]}。只返回完整译文。`,
        },
        { role: "user", content: i.text },
      ],
      { thinking: false, signal: o.signal, profileId: i.p?.id },
    ),
  );
  if (!r.ok || r.finishReason === "length")
    return { ok: false, error: r.error || "译文输出未完成，请增大输出上限" };
  store.run(
    "INSERT OR REPLACE INTO dpa_translations(subject_key,field,target_lang,fingerprint,text,model,created_at) VALUES(?,?,?,?,?,?,?)",
    [
      o.subjectKey,
      o.field,
      i.targetLang,
      i.fingerprint,
      r.content,
      r.model,
      new Date().toISOString(),
    ],
  );
  return {
    ok: true,
    translated: r.content,
    text: r.content,
    sourceLang: i.sourceLang,
    targetLang: i.targetLang,
    model: r.model,
    tokens: r.tokens,
  };
}
function translate(o) {
  const i = info(o.subjectKey, o.field, o),
    key = [o.subjectKey, o.field, i.fingerprint, Boolean(o.force)].join("|");
  if (active.has(key)) return active.get(key);
  const promise = new Promise((resolve) => {
    pending.push({ o, resolve, key });
    pump();
  });
  active.set(key, promise);
  return promise;
}
function pump() {
  while (running < 4 && pending.length) {
    const { o, resolve, key } = pending.shift();
    running++;
    perform(o)
      .then(resolve, (e) =>
        resolve({ ok: false, error: models.redact(e.message) }),
      )
      .finally(() => {
        active.delete(key);
        running--;
        pump();
      });
  }
}
function paperBundle(id) {
  const fields = {};
  let sourceLang, targetLang;
  for (const f of ["title", "keywords", "abstract"]) {
    const r = saved("paper:" + id, f);
    fields[f] = r;
    sourceLang = r.sourceLang;
    targetLang = r.targetLang;
  }
  const p = models.resolve(null, "translation"),
    key = p?.legacy
      ? models.withProfile(p.id,()=>require("./interpret").isConfigured())
      : Boolean(
          p &&
            (require("./config").getSecret("profile:" + p.id) ||
              ["localhost", "127.0.0.1", "[::1]"].includes(
                new URL(p.baseUrl).hostname,
              )),
        );
  return { sourceLang, targetLang, aiConfigured: key, fields };
}
async function batch({
  paperIds = [],
  fields = ["title", "keywords", "abstract"],
  force = false,
  limit = 24,
  targetLang,
} = {}) {
  const results = {};
  let calls = 0,
    remaining = 0,
    cached = 0;
  const jobs = [];
  for (const id of [...new Set(paperIds)].slice(0, 60)) {
    results[id] = {};
    for (const f of fields) {
      if (!["title", "keywords", "abstract"].includes(f)) continue;
      const cur = saved("paper:" + id, f, { targetLang });
      if (cur.text && !force) {
        results[id][f] = {
          ok: true,
          cached: true,
          text: cur.text,
          model: cur.model,
        };
        cached++;
        continue;
      }
      if (!cur.available) {
        results[id][f] = { ok: false, available: false, error: cur.note };
        continue;
      }
      if (calls >= limit) {
        remaining++;
        continue;
      }
      calls++;
      jobs.push(
        translate({
          subjectKey: "paper:" + id,
          field: f,
          force,
          targetLang,
        }).then((r) => {
          results[id][f] = { ...r, text: r.translated };
        }),
      );
    }
  }
  await Promise.all(jobs);
  return { ok: true, results, calls, fromCache: cached, remaining };
}
module.exports = { LANGS, saved, translate, paperBundle, batch, settings };
