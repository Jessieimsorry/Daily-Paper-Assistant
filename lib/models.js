"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const context = new AsyncLocalStorage(),
  custom = require("./customize"),
  config = require("./config"),
  store = require("./store");
function list() {
  return custom
    .get("profiles", [])
    .map((p) => ({
      ...p,
      ...(p.legacy
        ? {
            model: config.getSettings().aiModel,
            baseUrl: config.getSettings().aiBaseUrl,
          }
        : {}),
      keyConfigured: Boolean(
        p.legacy
          ? config.getSecret("deepseekApiKey")
          : config.getSecret("profile:" + p.id),
      ),
    }));
}
function save(p) {
  if (!p.name?.trim() || !p.model?.trim()) throw Error("请输入连接名称和模型");
  const url = new URL(p.baseUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("接口地址必须是没有凭据和查询参数的 HTTP(S) 地址");
  p.id = p.id || require("node:crypto").randomUUID();
  if (!/^[a-zA-Z0-9_-]+$/.test(p.id)) throw Error("无效连接编号");
  const items = custom.get("profiles", []);
  const old = items.find((x) => x.id === p.id);
  const safe = {
    id: p.id,
    name: p.name.trim(),
    baseUrl: p.baseUrl.replace(/\/+$/, ""),
    model: p.model.trim(),
    temperature: Math.max(0, Math.min(2, Number(p.temperature) || 0)),
    maxTokens: Math.max(256, Math.min(64000, Number(p.maxTokens) || 6000)),
    legacy: false,
  };
  if ("apiKey" in p && p.apiKey) config.setSecret("profile:" + p.id, p.apiKey);
  else if (old?.legacy && !config.getSecret("profile:" + p.id))
    config.setSecret(
      "profile:" + p.id,
      config.getSecret("deepseekApiKey") || "",
    );
  if (p.clearKey) config.setSecret("profile:" + p.id, "");
  custom.put("profiles", [...items.filter((x) => x.id !== p.id), safe]);
  return list();
}
function resolve(id, feature) {
  const choice =
    id ||
    context.getStore()?.profileId ||
    custom.get("bindings", {})[feature] ||
    "default";
  const p = custom.get("profiles", []).find((x) => x.id === choice);
  if (!p && custom.get("profiles", []).length)
    throw Error("所选模型连接已删除，请重新选择");
  if (p?.legacy) {
    const s = config.getSettings();
    return {
      ...p,
      model: s.aiModel,
      baseUrl: s.aiBaseUrl,
      maxTokens: s.aiMaxTokens,
      temperature: s.aiTemperature,
    };
  }
  return p;
}
function withProfile(id, fn) {
  return context.run({ profileId: id }, fn);
}
function reserve(p) {
  if (!custom.get("profiles", []).length) return null;
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  const count = store.get("SELECT COUNT(*) c FROM dpa_usage WHERE day=?", [
      day,
    ]).c,
    limit = Number(custom.get("limits", {}).dailyCalls) || 0;
  if (limit && count >= limit) throw Error("已达到今日模型调用上限");
  store.run("INSERT INTO dpa_usage(day,profile_id,model,ok) VALUES(?,?,?,0)", [
    day,
    p?.id || "default",
    p?.model || config.getSettings().aiModel,
  ]);
  return store.get("SELECT last_insert_rowid() id").id;
}
function finish(id, r) {
  if (id)
    store.run("UPDATE dpa_usage SET tokens=?,ok=? WHERE id=?", [
      r.tokens ?? null,
      r.ok ? 1 : 0,
      id,
    ]);
  return r;
}
function redact(text) {
  let s = String(text || "");
  for (const k of config.SECRET_FIELDS) {
    const value = config.getSecret(k);
    if (value) s = s.split(value).join("[密钥已隐藏]");
  }
  for (const [name, value] of Object.entries(process.env))
    if (/(?:API_KEY|TOKEN|SECRET)$/.test(name) && value.length > 8)
      s = s.split(value).join("[密钥已隐藏]");
  for (const p of custom.get("profiles", [])) {
    const k = config.getSecret("profile:" + p.id);
    if (k) s = s.split(k).join("[密钥已隐藏]");
  }
  const k = config.getSecret("deepseekApiKey");
  if (k) s = s.split(k).join("[密钥已隐藏]");
  return s.replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]");
}
async function invoke(p, messages, opts = {}) {
  let id;
  try {
    const key = config.getSecret("profile:" + p.id) || "";
    if (
      !key &&
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(p.baseUrl).hostname)
    )
      return { ok: false, error: "此模型连接尚未配置密钥" };
    id = reserve(p);
    const r = await fetch(p.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: "Bearer " + key } : {}),
      },
      body: JSON.stringify({
        model: p.model,
        messages,
        temperature: opts.temperature ?? p.temperature,
        max_tokens: Math.min(opts.maxTokens ?? p.maxTokens,p.maxTokens),
        stream: false,
        ...(opts.thinking === false &&
        new URL(p.baseUrl).hostname === "api.deepseek.com"
          ? { thinking: { type: "disabled" } }
          : {}),
      }),
      signal: opts.signal || AbortSignal.timeout(180000),
    });
    if (!r.ok)
      return finish(id, {
        ok: false,
        error: "模型接口返回 HTTP " + r.status,
        status: r.status,
      });
    const data = await r.json(),
      c = data.choices?.[0],
      content = c?.message?.content || "";
    return finish(id, {
      ok: Boolean(content.trim()),
      content,
      model: data.model || p.model,
      tokens: data.usage?.total_tokens ?? null,
      usage: data.usage,
      finishReason: c?.finish_reason,
      error: content.trim() ? null : "模型没有返回正式回答",
    });
  } catch (e) {
    return finish(id, { ok: false, error: redact(e.message) });
  }
}
module.exports = {
  list,
  save,
  resolve,
  withProfile,
  reserve,
  finish,
  invoke,
  redact,
  context,
};
