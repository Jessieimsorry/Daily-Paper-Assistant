"use strict";
let dpa = {},
  dpaRegion = "research",
  catalogDraft = null,
  transferDraft = null,
  dpaTimer = null;
const dpaLanguages = {
  auto: "自动（非中文→中文；中文→英文）",
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
};
const dpaInput = (id, label, value = "", type = "text") =>
  `<label class="field"><span>${esc(label)}</span><input id="${id}" type="${type}" value="${attr(value)}"></label>`;
const dpaSelect = (id, label, options, value) =>
  `<label class="field"><span>${esc(label)}</span><select id="${id}" aria-label="${attr(label)}">${Object.entries(
    options,
  )
    .map(
      ([k, v]) =>
        `<option value="${attr(k)}" ${k === String(value) ? "selected" : ""}>${esc(v)}</option>`,
    )
    .join("")}</select></label>`;
const dpaArg = (v) => attr(JSON.stringify(v));
async function dpaReload() {
  dpa = await api("/api/customization");
  if (!dpa.ok) throw Error(dpa.error);
  return dpa;
}
async function dpaPost(path, body) {
  const r = await api(path, { method: "POST", body });
  if (!r.ok) throw Error(r.error || "操作失败");
  return r;
}
function dpaIdentity() {
  document.title = dpa.identity.name;
  $(".brand-title").textContent = dpa.identity.name;
  $(".brand-sub").textContent = dpa.identity.subtitle || "";
}
async function installV2() {
  await dpaReload();
  dpaIdentity();
  if (!Object.keys(readerUI.prefs).length && dpa.readingPrefs)
    readerUI.prefs = { ...dpa.readingPrefs };
  else readerUI.prefs = { ...dpa.readingPrefs, ...readerUI.prefs };
  applyReaderPrefs();
  const oldPrefs = applyReaderPrefs;
  applyReaderPrefs = function () {
    oldPrefs();
    const p = readerUI.prefs,
      root = document.documentElement;
    root.style.setProperty(
      "--reading-width",
      p.width === "medium"
        ? "1000px"
        : p.width === "custom"
          ? Math.max(600, Math.min(2400, Number(p.customWidth) || 1280)) + "px"
          : "none",
    );
    root.style.setProperty("--reading-line", p.line || 1.85);
    root.style.setProperty("--reading-gap", (p.gap ?? 12) + "px");
    root.style.setProperty(
      "--reading-align",
      p.align === "left" ? "left" : "justify",
    );
    root.style.setProperty(
      "--english-font",
      p.englishFont === "system" ? "system-ui" : p.englishFont || "Arial",
    );
    root.style.setProperty(
      "--reading-font",
      p.fontFamily === "serif"
        ? 'Georgia, "Songti SC", SimSun, serif'
        : p.fontFamily === "system"
          ? "system-ui, sans-serif"
          : 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
    );
    document.body.dataset.readingTheme = p.theme || "warm";
    document.body.dataset.translationLayout = p.layout || "original";
    document.body.classList.toggle("hide-paper-meta", p.hideMeta === true);
  };
  applyReaderPrefs();
  const oldSetPref = setReaderPref;
  setReaderPref = function (k, v) {
    oldSetPref(k, v);
    dpaPost("/api/customization", { readingPrefs: readerUI.prefs }).catch((e) =>
      toast(e.message, true),
    );
  };
  const oldToolbar = renderReaderToolbar;
  renderReaderToolbar = function () {
    oldToolbar();
    $("#readerToolbar").insertAdjacentHTML(
      "beforeend",
      `<button class="btn" onclick="go('personalize')">更多阅读设置</button><label>译文语言<select aria-label="译文语言" onchange="dpaTarget(this.value)">${Object.entries(
        dpaLanguages,
      )
        .map(
          ([k, v]) =>
            `<option value="${k}" ${k === (dpa.translationSettings?.target || "auto") ? "selected" : ""}>${esc(v)}</option>`,
        )
        .join("")}</select></label>`,
    );
  };
  renderReaderToolbar();
  const oldDiscovery = viewDiscovery;
  viewDiscovery = async function (...args) {
    await oldDiscovery(...args);
    if (state.view === "discovery") {
      const main = $("#main");
      main.innerHTML = `<div class="dpa-region-tabs"><button class="btn" onclick="dpaHome('research')">研究文献</button><button class="btn" onclick="dpaHome('frontier')">技术前沿</button><button class="btn" onclick="dpaHome('science')">科学进展 · Nature / Cell / Science</button><button class="btn" onclick="go('personalize')">选择栏目</button></div><div id="dpaResearch">${main.innerHTML}</div><div id="dpaStreams" class="hidden"></div>`;
      if (dpaRegion !== "research") await dpaHome(dpaRegion);
    }
  };
  const oldPaper = viewPaper;
  viewPaper = async function (id) {
    await oldPaper(id);
    $("#main").insertAdjacentHTML(
      "afterbegin",
      `<div class="dpa-region-tabs"><button class="btn" onclick="dpaSubject('paper:${id}')">多语翻译与智能体</button></div>`,
    );
    dpaAutoAgents("paper:" + id);
  };
  runFullUpdate = async () => dpaSearchDialog(dpaRegion);
  const oldLibrary = viewLibrary;
  viewLibrary = async function (...args) {
    await oldLibrary(...args);
    const r = await api("/api/stream-library");
    $("#dpaStreamLibrary")?.remove();
    if (r.items?.length) {
      $("#main").insertAdjacentHTML(
        "beforeend",
        `<section id="dpaStreamLibrary"><h2>技术前沿与科学进展收藏</h2>${r.items.map((s) => dpaStreamCard(s, s.subjectKey.split(":")[0])).join("")}</section>`,
      );
      for (const s of r.items) dpaLoadStreamTranslation(s.subjectKey);
    }
  };
  const oldTopics = viewTopics;
  viewTopics = async function () {
    await oldTopics();
    $("#main").insertAdjacentHTML(
      "afterbegin",
      `<p><button class="btn" onclick="go('personalize')">栏目归属、排除词与自动检索设置</button></p>`,
    );
  };
  const oldJournals = viewJournals;
  viewJournals = async function () {
    await oldJournals();
    $("#main").insertAdjacentHTML(
      "afterbegin",
      `<p><button class="btn primary" onclick="go('catalog-import')">导入 CSV / Excel / TSV 与字段预览</button></p>`,
    );
  };
  if (!dpa.identity.onboarded) go("personalize");
}
async function dpaTarget(value) {
  await dpaPost("/api/customization", {
    translationSettings: { target: value },
  });
  await dpaReload();
  readerUI.lastList = null;
  renderReaderToolbar();
  await render();
}
async function dpaHome(region) {
  dpaRegion = region;
  $("#dpaResearch")?.classList.toggle("hidden", region !== "research");
  const box = $("#dpaStreams");
  if (!box) return;
  box.classList.toggle("hidden", region === "research");
  if (region === "research") return;
  box.innerHTML = '<p class="muted">读取本地缓存…</p>';
  const r = await api(region === "science" ? "/api/science" : "/api/frontier");
  if (dpaRegion !== region) return;
  const items = r.items || [],
    label = region === "science" ? "科学进展" : "技术前沿";
  box.innerHTML = `<div class="section-head"><h1>${label}</h1><button class="btn primary" onclick="dpaSearchDialog('${region}')">选择范围后检索</button></div><p class="muted">独立于研究文献；只有题录或摘要时不会冒充全文。${r.updatedAt ? "最近检查：" + esc(r.updatedAt) : ""}</p><details><summary>来源状态</summary>${(r.sources || []).map((s) => `<p>${esc(s.label || s.source)}：${s.ok ? "本次可用" : esc(s.error || "暂无记录")}</p>`).join("")}</details>${items.length ? items.map((s) => dpaStreamCard(s, region)).join("") : '<div class="empty">尚无缓存记录。可选择范围后检索；来源无摘要时只展示题录。</div>'}`;
  for (const s of items) dpaLoadStreamTranslation(region + ":" + s.id);
}
function dpaStreamCard(s, kind) {
  const key = kind + ":" + s.id,
    url = s.url || "";
  const safe = /^https?:\/\//i.test(url) ? url : "#";
  return `<article class="paper-card" id="stream-${kind}-${s.id}"><h2><a href="${attr(safe)}" target="_blank" rel="noopener">${esc(s.title)}</a></h2><p class="dpa-stream-title" data-stream-title="${key}"></p><p class="small">${esc(s.journal || s.venue || s.source || "")} · ${esc(s.date || s.publishedDate || "出版日期未提供")} · ${esc(s.docTypeLabel || { "journal-article": "期刊条目（类型未细分）", "conference-paper": "会议论文", preprint: "预印本" }[s.type] || "文章类型未知")}</p><div class="abs-full"><div class="abs-col"><div class="abs-col-label">原文摘要</div><p dir="auto" class="abs-text">${esc(s.abstract || "原始数据未提供摘要")}</p></div><div class="abs-col"><div class="abs-col-label">AI 译文</div><p dir="auto" class="abs-text" data-stream-translation="${key}">${esc(s.abstractZh || "尚未生成")}</p></div></div><p><button class="btn" onclick="dpaTranslate(${dpaArg(key)},'abstract')">翻译摘要</button><button class="btn" onclick="dpaSubject(${dpaArg(key)})">智能体与多语设置</button><button class="btn" onclick="dpaMark(${dpaArg(key)})">标记已浏览</button><button class="btn" onclick="dpaStar(${dpaArg(key)})">收藏／取消收藏</button><span data-stream-reading="${key}"></span></p>${s.matchedPaperId || s.reading?.paperId ? `<button class="btn" onclick="goPaper(${s.matchedPaperId || s.reading.paperId})">库内关联论文</button>` : ""}</article>`;
}
async function dpaLoadStreamTranslation(key) {
  const r = await api("/api/subject/" + key.replace(":", "/"));
  const el = document.querySelector(`[data-stream-translation="${key}"]`);
  if (el && r.ok) {
    const title = document.querySelector(`[data-stream-title="${key}"]`);
    if (title) title.textContent = r.translations.title.text || "";
    const reading = document.querySelector(`[data-stream-reading="${key}"]`);
    if (reading)
      reading.textContent =
        (r.reading.browsed ? "已浏览" : "未浏览") +
        " · " +
        (r.reading.starred ? "已收藏" : "未收藏");
    el.textContent = "尚未生成该目标语言的译文";
    if (r.translations.abstract.text)
      el.textContent = r.translations.abstract.text;
    else if (r.subject.abstract) {
      const visible =
        el.getBoundingClientRect().top < innerHeight &&
        el.getBoundingClientRect().bottom > 0;
      if (visible) dpaTranslate(key, "abstract", true);
    }
    dpaAutoAgents(key);
    if (!r.translations.abstract.text && r.subject.abstract)
      setTimeout(async () => {
        if (!el.isConnected) return;
        const fresh = await api("/api/subject/" + key.replace(":", "/"));
        if (fresh.translations?.abstract?.text)
          el.textContent = fresh.translations.abstract.text;
      }, 2500);
  }
}
async function dpaStar(key) {
  const r = await api("/api/subject/" + key.replace(":", "/"));
  await dpaPost("/api/subject-reading", {
    subjectKey: key,
    value: { starred: !r.reading.starred },
  });
  toast(r.reading.starred ? "已取消收藏" : "已收藏");
  dpaLoadStreamTranslation(key);
}
async function dpaMark(key) {
  await dpaPost("/api/subject-reading", {
    subjectKey: key,
    value: { browsed: true },
  });
  toast("已标记浏览");
  dpaLoadStreamTranslation(key);
}
async function dpaSearchDialog(region = "research") {
  await dpaReload();
  const topics = dpa.topics,
    auto = new Set(
      dpa.categories.filter((c) => c.automatic).flatMap((c) => c.topics),
    );
  const sourceOptions =
    region === "research"
      ? {
          crossref: "Crossref",
          openalex: "OpenAlex",
          "cn-catalog": "中文公开目录",
        }
      : region === "science"
        ? { crossref: "Crossref（三本主刊）" }
        : {
            eric: "ERIC",
            arxiv: "arXiv",
            acl: "ACL 已同步数据",
            ieee: "IEEE Xplore（需密钥）",
          };
  $("#modal").classList.remove("hidden");
  $("#modalBox").innerHTML =
    `<h2>本次检索范围</h2><p>这是本次手动选择，不改变每日自动检索设置。</p>${region === "research" ? `<div class="dpa-options">${topics.map((t) => `<label><input type="checkbox" name="manual-topic" value="${attr(t.slug)}" ${auto.has(t.slug) ? "checked" : ""}> ${esc(t.name_zh)}</label>`).join("")}</div>` : ""}<h3>数据源</h3>${Object.entries(
      sourceOptions,
    )
      .map(
        ([id, name]) =>
          `<label class="dpa-check"><input type="checkbox" name="manual-source" value="${id}" checked> ${esc(name)}</label>`,
      )
      .join(
        "",
      )}${dpaInput("manual-days", "最近多少天", 30, "number")}<div id="searchReview"></div><p><button class="btn primary" onclick="dpaReviewSearch('${region}')">查看检索清单</button><button class="btn" onclick="$('#modal').classList.add('hidden')">取消</button></p>`;
}
let dpaSearchSnapshot = null;
function dpaReviewSearch(region) {
  const topics = $$('input[name="manual-topic"]:checked').map((e) => e.value),
    sources = $$('input[name="manual-source"]:checked').map((e) => e.value);
  if (!sources.length || (region === "research" && !topics.length)) {
    toast("请选择研究方向和数据源", true);
    return;
  }
  dpaSearchSnapshot = {
    region,
    topics,
    sources,
    days: Number($("#manual-days").value) || 30,
  };
  $("#searchReview").innerHTML =
    `<div class="banner">方向：${region === "research" ? topics.map((id) => esc(dpa.topics.find((t) => t.slug === id)?.name_zh || id)).join("、") : region === "science" ? "Nature、Cell、Science 主刊" : "技术前沿"}<br>来源：${sources.map(esc).join("、")}<br>时间：最近 ${esc(dpaSearchSnapshot.days)} 天</div><button class="btn primary" onclick="dpaConfirmSearch()">确认并开始检索</button>`;
}
async function dpaConfirmSearch() {
  const r = await dpaPost("/api/search-jobs", dpaSearchSnapshot);
  $("#modal").classList.add("hidden");
  toast("检索已排队，任务编号 " + r.job.id.slice(0, 8));
  go("tasks");
}
async function viewPersonalize() {
  await dpaReload();
  const p = readerUI.prefs;
  $("#main").innerHTML =
    `<h1>个性化与栏目</h1><div class="card"><h2>工作台名称</h2>${dpaInput("identityName", "名称", dpa.identity.name)}${dpaInput("identitySub", "副标题", dpa.identity.subtitle)}<button class="btn primary" onclick="dpaSaveIdentity()">保存名称</button></div><div class="card"><h2>栏目与自动检索</h2><p>首页显示和每日检索分别设置；主题停用后不参与自动检索。</p><div class="dpa-category-list">${dpa.categories.map((c, i) => `<div class="dpa-category"><input aria-label="栏目名称" id="cat-name-${i}" value="${attr(c.name)}"><label><input id="cat-visible-${i}" type="checkbox" ${c.visible ? "checked" : ""}>首页显示</label><label><input id="cat-auto-${i}" type="checkbox" ${c.automatic ? "checked" : ""}>每日检索</label><details><summary>关联研究方向（${c.topics.length}）</summary>${dpa.topics.map((t) => `<label class="dpa-check"><input type="checkbox" name="cat-topic-${i}" value="${attr(t.slug)}" ${c.topics.includes(t.slug) ? "checked" : ""}>${esc(t.name_zh)}</label>`).join("")}</details><button class="btn small" onclick="dpaRemoveCategory(${i})">移除栏目</button></div>`).join("")}</div><button class="btn" onclick="dpaAddCategory()">新增栏目</button><button class="btn primary" onclick="dpaSaveCategories()">保存栏目</button></div><div class="card"><h2>研究方向</h2><button class="btn" onclick="dpaTopicEditor()">新增研究方向</button>${dpa.topics.map((t) => `<p><button class="btn" onclick="dpaTopicEditor(${t.id})">编辑 ${esc(t.name_zh)}</button> <span class="tiny">${esc(t.slug)} · ${t.enabled ? "已启用" : "已停用"}</span></p>`).join("")}</div><div class="card"><h2>每日更新</h2>${["research", "frontier", "science"].map((k) => `<label class="dpa-check"><input id="auto-${k}" type="checkbox" ${dpa.streams[k] ? "checked" : ""}>${{ research: "研究文献", frontier: "技术前沿", science: "科学进展" }[k]}</label>`).join("")}${dpaInput("researchSize", "研究文献目标篇数", dpa.researchSize, "number")}${dpaInput("frontierSize", "技术前沿篇数", dpa.frontierSize, "number")}${dpaInput("scienceSize", "科学进展篇数", dpa.streams.scienceSize, "number")}<button class="btn primary" onclick="dpaSaveStreams()">保存每日设置</button></div><div class="card"><h2>阅读界面</h2>${dpaSelect("prefWidth", "正文宽度", { full: "铺满", medium: "适中", custom: "自定义" }, p.width || "full")}${dpaInput("prefCustom", "自定义宽度（像素）", p.customWidth || 1280, "number")}${dpaSelect("prefFont", "字体", { system: "系统字体", sans: "中英无衬线", serif: "中英衬线" }, p.fontFamily || "sans")}${dpaSelect("prefEnglish", "英文字体", { system: "系统字体", Arial: "Arial", Georgia: "Georgia", Verdana: "Verdana" }, p.englishFont || "Arial")}${dpaInput("prefLine", "行距", p.line || 1.85, "number")}${dpaInput("prefGap", "段距（像素）", p.gap ?? 12, "number")}${dpaSelect("prefAlign", "对齐", { justify: "两端对齐", left: "左对齐" }, p.align || "justify")}${dpaSelect("prefTheme", "配色", { warm: "暖灰", white: "纸白", green: "浅绿", dark: "深色" }, p.theme || "warm")}${dpaSelect("prefLayout", "原文与译文", { original: "原文在上", translated: "译文在上", parallel: "左右对照" }, p.layout || "original")}<label><input type="checkbox" id="prefMeta" ${p.hideMeta ? "checked" : ""}>隐藏作者与期刊辅助信息</label><p><button class="btn primary" onclick="dpaSaveReading()">应用并保存</button><button class="btn" onclick="dpaResetReading()">恢复阅读默认</button></p>${dpaInput("presetName", "阅读方案名称")}<button class="btn" onclick="dpaSavePreset()">保存方案</button>${Object.keys(
      dpa.readingPresets || {},
    )
      .map(
        (n) =>
          `<button class="btn" onclick="dpaLoadPreset(${dpaArg(n)})">${esc(n)}</button>`,
      )
      .join("")}</div>`;
}
async function dpaSaveIdentity() {
  await dpaPost("/api/customization", {
    identity: {
      name: $("#identityName").value.trim(),
      subtitle: $("#identitySub").value.trim(),
      onboarded: true,
    },
  });
  await dpaReload();
  dpaIdentity();
  toast("名称已保存");
}
function dpaReadCategories() {
  return dpa.categories.map((c, i) => ({
    ...c,
    name: $("#cat-name-" + i).value,
    visible: $("#cat-visible-" + i).checked,
    automatic: $("#cat-auto-" + i).checked,
    topics: $$('input[name="cat-topic-' + i + '"]:checked').map((x) => x.value),
  }));
}
async function dpaSaveCategories() {
  await dpaPost("/api/categories", { items: dpaReadCategories() });
  readerUI.overview = null;
  toast("栏目已保存");
}
async function dpaAddCategory() {
  await dpaSaveCategories();
  dpa.categories.push({
    id: "category-" + Date.now(),
    name: "新栏目",
    visible: true,
    automatic: false,
    color: "sage",
    topics: [],
  });
  await dpaPost("/api/categories", { items: dpa.categories });
  await viewPersonalize();
}
async function dpaRemoveCategory(i) {
  const items = dpaReadCategories();
  items.splice(i, 1);
  await dpaPost("/api/categories", { items });
  await viewPersonalize();
}
async function dpaSaveStreams() {
  await dpaPost("/api/customization", {
    streams: {
      ...dpa.streams,
      research: $("#auto-research").checked,
      frontier: $("#auto-frontier").checked,
      science: $("#auto-science").checked,
      scienceSize: Number($("#scienceSize").value),
    },
  });
  await dpaPost("/api/settings", {
    briefSize: Number($("#researchSize").value),
    frontierSize: Number($("#frontierSize").value),
    frontierDaily: $("#auto-frontier").checked,
  });
  toast("每日设置已保存");
}
async function dpaTopicEditor(id) {
  await dpaReload();
  const t = dpa.topics.find((t) => t.id === id) || {
    name_zh: "",
    keywords_zh: [],
    keywords_en: [],
    exclude_terms: [],
    enabled: true,
  };
  $("#modal").classList.remove("hidden");
  $("#modalBox").innerHTML =
    `<h2>${id ? "编辑" : "新增"}研究方向</h2>${dpaInput("topicName", "名称", t.name_zh)}${dpaInput("topicOrder", "排序", t.sort_order || 100, "number")}<label class="field">中文检索词（每行一个）<textarea id="topicZh">${esc(t.keywords_zh.join("\n"))}</textarea></label><label class="field">其他语言检索词（每行一个）<textarea id="topicEn">${esc(t.keywords_en.join("\n"))}</textarea></label><label class="field">排除词（每行一个）<textarea id="topicExclude">${esc((t.exclude_terms || []).join("\n"))}</textarea></label><label><input id="topicEnabled" type="checkbox" ${t.enabled ? "checked" : ""}>启用该主题</label><h3>所属栏目</h3>${dpa.categories.map((c) => `<label class="dpa-check"><input name="topicCategory" type="checkbox" value="${attr(c.id)}" ${c.topics.includes(t.slug) ? "checked" : ""}>${esc(c.name)}</label>`).join("")}<p><button class="btn primary" onclick="dpaSaveTopic(${id || 0})">保存</button><button class="btn" onclick="$('#modal').classList.add('hidden')">取消</button></p>`;
}
async function dpaSaveTopic(id) {
  const lines = (sel) =>
    $(sel)
      .value.split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  const old = dpa.topics.find((t) => t.id === id) || {},
    r = await dpaPost("/api/topics" + (id ? "/" + id : ""), {
      ...old,
      name_zh: $("#topicName").value,
      keywords_zh: lines("#topicZh"),
      keywords_en: lines("#topicEn"),
      exclude_terms: lines("#topicExclude"),
      enabled: $("#topicEnabled").checked,
      sort_order: Number($("#topicOrder").value),
    });
  const slug = r.topic.slug,
    chosen = $$('input[name="topicCategory"]:checked').map((x) => x.value);
  await dpaPost("/api/categories", {
    items: dpa.categories.map((c) => ({
      ...c,
      topics: [
        ...c.topics.filter((s) => s !== slug),
        ...(chosen.includes(c.id) ? [slug] : []),
      ],
    })),
  });
  $("#modal").classList.add("hidden");
  await reloadTopics();
  await viewPersonalize();
}
async function dpaSaveReading() {
  Object.assign(readerUI.prefs, {
    width: $("#prefWidth").value,
    customWidth: Number($("#prefCustom").value),
    fontFamily: $("#prefFont").value,
    englishFont: $("#prefEnglish").value,
    line: Math.max(1.2, Math.min(3, Number($("#prefLine").value) || 1.85)),
    gap: Math.max(0, Math.min(60, Number($("#prefGap").value) || 0)),
    align: $("#prefAlign").value,
    theme: $("#prefTheme").value,
    layout: $("#prefLayout").value,
    hideMeta: $("#prefMeta").checked,
  });
  applyReaderPrefs();
  document.documentElement.style.setProperty(
    "--english-font",
    readerUI.prefs.englishFont === "system"
      ? "system-ui"
      : readerUI.prefs.englishFont,
  );
  localStorage.setItem(
    "litdesk.reader.preferences",
    JSON.stringify(readerUI.prefs),
  );
  await dpaPost("/api/customization", { readingPrefs: readerUI.prefs });
  toast("阅读设置已保存");
}
async function dpaResetReading() {
  readerUI.prefs = {
    zoom: 100,
    font: 16,
    mode: "full",
    collapsed: readerUI.prefs.collapsed,
  };
  applyReaderPrefs();
  localStorage.setItem(
    "litdesk.reader.preferences",
    JSON.stringify(readerUI.prefs),
  );
  await dpaPost("/api/customization", { readingPrefs: readerUI.prefs });
  await viewPersonalize();
}
async function dpaSavePreset() {
  await dpaSaveReading();
  const name = $("#presetName").value.trim();
  if (!name) {
    toast("请填写方案名称", true);
    return;
  }
  await dpaPost("/api/customization", {
    readingPresets: { ...dpa.readingPresets, [name]: readerUI.prefs },
  });
  await viewPersonalize();
}
async function dpaLoadPreset(name) {
  readerUI.prefs = { ...dpa.readingPresets[name] };
  applyReaderPrefs();
  localStorage.setItem(
    "litdesk.reader.preferences",
    JSON.stringify(readerUI.prefs),
  );
  await dpaPost("/api/customization", { readingPrefs: readerUI.prefs });
  await viewPersonalize();
}
async function viewModels() {
  await dpaReload();
  const options = Object.fromEntries(dpa.profiles.map((p) => [p.id, p.name]));
  $("#main").innerHTML =
    `<h1>模型与智能体</h1><div class="card"><h2>模型连接</h2><p>接口需兼容 OpenAI chat/completions；密钥只由本机后端保存。</p>${dpa.profiles.map((p) => `<p><button class="btn" onclick="dpaProfileEditor(${dpaArg(p.id)})">${esc(p.name)} · ${esc(p.model)}</button> ${p.keyConfigured ? "已配置密钥" : "未配置密钥／本地接口"} <button class="btn" onclick="dpaTestProfile(${dpaArg(p.id)})">测试连接</button></p>`).join("")}<button class="btn primary" onclick="dpaProfileEditor()">新增连接</button></div><div class="card"><h2>各功能使用的模型</h2>${Object.entries(
      { translation: "翻译", quick: "速览", deep: "深入解读" },
    )
      .map(([k, n]) => dpaSelect("binding-" + k, n, options, dpa.bindings[k]))
      .join(
        "",
      )}<button class="btn primary" onclick="dpaSaveBindings()">保存分工</button>${dpaInput("dailyCalls", "每天最多调用次数（0 表示不限制）", dpa.limits.dailyCalls, "number")}<button class="btn" onclick="dpaSaveLimit()">保存上限</button><p>模型实际 token 用量在任务与数据中查看；未配置价格不估算金额。</p></div><div class="card"><h2>智能体</h2>${dpa.agents.map((a) => `<p><button class="btn" onclick="dpaAgentEditor(${dpaArg(a.id)})">${esc(a.name)}</button> · ${esc({ metadata: "题录", abstract: "摘要", fulltext: "已有全文" }[a.scope] || a.scope)} · ${a.trigger === "automatic" ? "进入阅读页面时自动" : "手动运行"}</p>`).join("")}<button class="btn primary" onclick="dpaAgentEditor()">新增智能体</button></div><div class="card"><h2>顺序流程</h2><p>选择智能体并调整顺序；后一步可使用前一步结果，失败时停止。</p>${dpa.workflows.map((w) => `<p><button class="btn" onclick="dpaWorkflowEditor(${dpaArg(w.id)})">${esc(w.name)}</button> ${w.agentIds.map((id) => esc(dpa.agents.find((a) => a.id === id)?.name || "已移除的智能体")).join(" → ")}</p>`).join("")}<button class="btn" onclick="dpaWorkflowEditor()">新增流程</button></div>`;
}
function dpaProfileEditor(id) {
  const p = dpa.profiles.find((x) => x.id === id) || {};
  $("#modal").classList.remove("hidden");
  $("#modalBox").innerHTML =
    `<h2>模型连接</h2>${dpaInput("profileName", "名称", p.name)}${dpaInput("profileUrl", "接口基础地址", p.baseUrl || "https://api.deepseek.com")}${dpaInput("profileModel", "模型名称", p.model)}${dpaInput("profileKey", "API Key（留空保留原配置）", "", "password")}${dpaInput("profileTemp", "温度", p.temperature ?? 0.3, "number")}${dpaInput("profileTokens", "最大输出 token", p.maxTokens || 6000, "number")}<label><input id="profileClear" type="checkbox">清除已存密钥</label><p><button class="btn primary" onclick="dpaSaveProfile(${dpaArg(id || "")})">保存连接</button><button class="btn" onclick="$('#modal').classList.add('hidden')">取消</button></p>`;
}
async function dpaSaveProfile(id) {
  await dpaPost("/api/model-profiles", {
    id: id || undefined,
    name: $("#profileName").value,
    baseUrl: $("#profileUrl").value,
    model: $("#profileModel").value,
    apiKey: $("#profileKey").value,
    clearKey: $("#profileClear").checked,
    temperature: Number($("#profileTemp").value),
    maxTokens: Number($("#profileTokens").value),
  });
  $("#modal").classList.add("hidden");
  await viewModels();
}
async function dpaTestProfile(id) {
  const r = await api("/api/model-profiles/" + id + "/test", {
    method: "POST",
    body: {},
  });
  toast(r.ok ? "连接成功：" + r.model : r.error, !r.ok);
}
async function dpaSaveBindings() {
  const bindings = {};
  for (const k of ["translation", "quick", "deep"])
    bindings[k] = $("#binding-" + k).value;
  await dpaPost("/api/customization", { bindings });
  toast("模型分工已保存");
}
async function dpaSaveLimit() {
  await dpaPost("/api/customization", {
    limits: { dailyCalls: Number($("#dailyCalls").value) },
  });
  toast("调用上限已保存");
}
function dpaAgentEditor(id) {
  const a = dpa.agents.find((x) => x.id === id) || {
    scope: "abstract",
    profileId: "default",
    trigger: "manual",
  };
  $("#modal").classList.remove("hidden");
  $("#modalBox").innerHTML =
    `<h2>智能体</h2>${dpaInput("agentName", "名称", a.name)}${dpaSelect("agentProfile", "模型连接", Object.fromEntries(dpa.profiles.map((p) => [p.id, p.name])), a.profileId)}${dpaSelect("agentScope", "输入材料", { metadata: "题录", abstract: "摘要", fulltext: "已有全文；无全文时说明只用摘要" }, a.scope)}${dpaSelect("agentOutput", "输出位置", { inline: "论文页面与任务页", task: "仅任务页" }, a.output || "inline")}${dpaSelect("agentTrigger", "触发方式", { manual: "手动", automatic: "进入阅读页面时自动（会调用模型）" }, a.trigger)}<label class="field">任务提示词<textarea id="agentPrompt">${esc(a.prompt || "")}</textarea></label><p><button class="btn primary" onclick="dpaSaveAgent(${dpaArg(id || "")})">保存</button><button class="btn" onclick="$('#modal').classList.add('hidden')">取消</button></p>`;
}
async function dpaSaveAgent(id) {
  const a = {
    id: id || "agent-" + Date.now(),
    name: $("#agentName").value,
    profileId: $("#agentProfile").value,
    scope: $("#agentScope").value,
    trigger: $("#agentTrigger").value,
    output: $("#agentOutput").value,
    prompt: $("#agentPrompt").value,
  };
  await dpaPost("/api/agents", {
    items: [...dpa.agents.filter((x) => x.id !== a.id), a],
  });
  $("#modal").classList.add("hidden");
  await viewModels();
}
let dpaWorkflowSteps = [];
function dpaWorkflowEditor(id) {
  const w = dpa.workflows.find((x) => x.id === id) || {};
  dpaWorkflowSteps = [...(w.agentIds || [])];
  $("#modal").classList.remove("hidden");
  $("#modalBox").innerHTML =
    `<h2>顺序流程</h2>${dpaInput("workflowName", "名称", w.name)}${dpaSelect("workflowAgent", "选择智能体", Object.fromEntries(dpa.agents.map((a) => [a.id, a.name])), dpa.agents[0]?.id)}<button class="btn" onclick="dpaWorkflowSteps.push($('#workflowAgent').value);dpaWorkflowList()">加入流程</button><div id="workflowSteps"></div><p><button class="btn primary" onclick="dpaSaveWorkflow(${dpaArg(id || "")})">保存流程</button><button class="btn" onclick="$('#modal').classList.add('hidden')">取消</button></p>`;
  dpaWorkflowList();
}
function dpaWorkflowList() {
  $("#workflowSteps").innerHTML = dpaWorkflowSteps
    .map(
      (id, i) =>
        `<p>${i + 1}. ${esc(dpa.agents.find((a) => a.id === id)?.name || "已移除的智能体")} <button class="btn small" onclick="dpaWorkflowMove(${i},-1)">上移</button><button class="btn small" onclick="dpaWorkflowMove(${i},1)">下移</button><button class="btn small" onclick="dpaWorkflowSteps.splice(${i},1);dpaWorkflowList()">移除</button></p>`,
    )
    .join("");
}
function dpaWorkflowMove(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= dpaWorkflowSteps.length) return;
  [dpaWorkflowSteps[i], dpaWorkflowSteps[j]] = [
    dpaWorkflowSteps[j],
    dpaWorkflowSteps[i],
  ];
  dpaWorkflowList();
}
async function dpaSaveWorkflow(id) {
  const w = {
    id: id || "workflow-" + Date.now(),
    name: $("#workflowName").value,
    agentIds: [...dpaWorkflowSteps],
  };
  await dpaPost("/api/workflows", {
    items: [...dpa.workflows.filter((x) => x.id !== w.id), w],
  });
  $("#modal").classList.add("hidden");
  await viewModels();
}
async function dpaSubject(key) {
  const target = "#/subject/" + key.replace(":", "/");
  if (location.hash === target) await viewSubject(key);
  else location.hash = target;
}
async function viewSubject(key) {
  await dpaReload();
  const r = await api("/api/subject/" + key.replace(":", "/"));
  if (!r.ok) throw Error(r.error);
  const s = r.subject;
  $("#main").innerHTML =
    `<h1>${esc(s.title)}</h1><p class="muted">${esc(s.doi || "无 DOI")} · 原文语言 ${esc(s.language)}</p>${dpaSelect("subjectLanguage", "纠正原文语种", { unknown: "自动识别", ...Object.fromEntries(Object.entries(dpaLanguages).filter(([k]) => k !== "auto")) }, s.language)}<button class="btn" onclick="dpaCorrectLanguage(${dpaArg(key)})">保存原文语种</button><div class="abs-full"><div class="abs-col"><div class="abs-col-label">原文摘要</div><p dir="auto" class="abs-text">${esc(s.abstract || "原始数据未提供摘要")}</p></div><div class="abs-col"><div class="abs-col-label">AI 译文</div><p dir="auto" class="abs-text">${esc(r.translations.abstract.text || "尚未生成")}</p></div></div>${dpaSelect("subjectTarget", "目标语种", dpaLanguages, dpa.translationSettings.target || "auto")}<p>${["title", "keywords", "abstract"].map((f) => `<button class="btn" onclick="dpaTranslate(${dpaArg(key)},'${f}')">翻译${{ title: "标题", keywords: "关键词", abstract: "摘要" }[f]}</button>`).join("")}</p><div class="card"><h2>运行智能体</h2>${dpa.agents.map((a) => `<button class="btn" onclick="dpaRunAgent(${dpaArg(key)},${dpaArg(a.id)})">${esc(a.name)}</button>`).join("")}<h3>顺序流程</h3>${dpa.workflows.map((w) => `<button class="btn" onclick="dpaRunWorkflow(${dpaArg(key)},${dpaArg(w.id)})">${esc(w.name)}</button>`).join("")}</div>${s.paperId ? `<button class="btn" onclick="goPaper(${s.paperId})">返回论文详情</button>` : ""}`;
  const jobs = await api("/api/tasks");
  const done = jobs.items.filter(
    (j) => j.snapshot.subjectKey === key && j.steps.length,
  );
  $("#main").insertAdjacentHTML(
    "beforeend",
    done
      .map(
        (j) =>
          `<div class="card"><h2>智能体结果 · ${esc(j.status)}</h2>${j.steps
            .filter((step) => step.output !== "task")
            .map(
              (step) =>
                `<h3>${esc(step.name)} · ${esc(step.result.scope || "")}</h3><pre class="dpa-output">${esc(step.result.content || step.result.text || "")}</pre>`,
            )
            .join("")}</div>`,
      )
      .join(""),
  );
  const history=await api('/api/translation-history/'+key.replace(':','/'));if(history.items?.length)$('#main').insertAdjacentHTML('beforeend',`<details class="card"><summary>历史译文（保留旧配置下的结果）</summary>${history.items.map(x=>`<h3>${esc({title:'标题',abstract:'摘要',keywords:'关键词'}[x.field]||x.field)} · ${esc(dpaLanguages[x.target_lang]||x.target_lang)} · ${esc(x.model||'历史模型')} · ${esc(x.created_at||'')}</h3><p dir="auto" class="abs-text">${esc(x.text)}</p>`).join('')}</details>`);
  dpaAutoAgents(key);
}
async function dpaCorrectLanguage(key) {
  await dpaPost("/api/subject-language", {
    subjectKey: key,
    language: $("#subjectLanguage").value,
  });
  await viewSubject(key);
}
async function dpaTranslate(key, field, quiet = false) {
  const target =
    $("#subjectTarget")?.value || dpa.translationSettings?.target || "auto";
  const r = await api("/api/multilingual", {
    method: "POST",
    body: {
      subjectKey: key,
      field,
      targetLang: target === "auto" ? undefined : target,
    },
  });
  if (!r.ok) {
    if (!quiet) toast(r.error, true);
    return;
  }
  if (!quiet) {
    toast("翻译已排队");
    go("tasks");
  }
}
async function dpaRunAgent(key, agentId) {
  await dpaPost("/api/agent-jobs", { subjectKey: key, agentId });
  toast("智能体已排队");
  go("tasks");
}
async function dpaRunWorkflow(key, workflowId) {
  await dpaPost("/api/agent-jobs", { subjectKey: key, workflowId });
  toast("流程已排队");
  go("tasks");
}
const dpaAutoSeen = new Set();
function dpaAutoAgents(key) {
  for (const a of dpa.agents || []) {
    if (a.trigger !== "automatic") continue;
    const fingerprint = key + "|" + a.id + "|" + a.prompt + "|" + a.profileId;
    if (dpaAutoSeen.has(fingerprint)) continue;
    dpaAutoSeen.add(fingerprint);
    dpaPost("/api/agent-jobs", { subjectKey: key, agentId: a.id }).catch((e) =>
      toast(e.message, true),
    );
  }
}
async function viewTasks() {
  await dpaReload();
  const r = await api("/api/tasks");
  $("#main").innerHTML = `<h1>任务与数据</h1><div class="card"><h2>用量</h2>${
    (dpa.usage || [])
      .slice(0, 7)
      .map(
        (u) =>
          `<p>${esc(u.day)}：${u.calls} 次调用 · ${u.tokens == null ? "接口未报告 token" : u.tokens + " token" + (u.missingTokens ? "；另有 " + u.missingTokens + " 次未报告 token" : "")}</p>`,
      )
      .join("") || "<p>尚无模型调用</p>"
  }</div><div class="card"><h2>任务</h2><button class="btn" onclick="viewTasks()">刷新任务</button>${r.items.map((j) => `<div class="dpa-job"><strong>${esc({ agents: "智能体", translation: "翻译", search: "检索" }[j.kind] || j.kind)}</strong> · ${esc({ queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消" }[j.status])} · ${esc(j.created_at)}<div class="small">${esc(j.snapshot.title || { research: "研究文献", science: "科学进展", frontier: "技术前沿" }[j.snapshot.region] || "")} ${j.snapshot.topicNames ? j.snapshot.topicNames.map(esc).join("、") : ""}</div>${j.error ? `<p class="danger">${esc(j.error)}</p>` : ""}${["running", "queued"].includes(j.status) ? `<button class="btn" onclick="dpaTaskAction(${dpaArg(j.id)},'cancel')">取消任务</button>` : ["failed", "cancelled"].includes(j.status) ? `<button class="btn" onclick="dpaTaskAction(${dpaArg(j.id)},'retry')">重试</button>` : ""}${j.steps.map((s) => `<details ${j.kind === "search" ? "" : "open"}><summary>${esc(s.name)} · ${esc(s.result.scope || "")} · ${esc(s.result.model || "")}</summary><pre class="dpa-output">${esc(s.result.content || s.result.text || JSON.stringify(s.result, null, 2))}</pre></details>`).join("")}</div>`).join("") || "<p>尚无任务</p>"}</div><div class="card"><h2>导出与迁移</h2><p>JSON 包包含个人论文与阅读记录，请自行保管；不含 API 密钥，不包含上传的全文文件。</p><button class="btn" onclick="dpaExport()">导出 JSON 迁移包</button><button class="btn" onclick="dpaExport('ris')">导出收藏 RIS</button><button class="btn" onclick="dpaExport('bibtex')">导出收藏 BibTeX</button><label class="field">导入迁移包<input type="file" accept=".json" onchange="dpaTransferPreview(this.files[0])"></label><div id="transferPreview"></div></div>`;
  clearTimeout(dpaTimer);
  if (r.items.some((j) => ["queued", "running"].includes(j.status)))
    dpaTimer = setTimeout(() => {
      if (state.view === "tasks") viewTasks();
    }, 2500);
}
async function dpaTaskAction(id, action) {
  await dpaPost("/api/tasks/" + id + "/" + action, {});
  await viewTasks();
}
function dpaDownload(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function dpaExport(format) {
  const r = await api("/api/data/export" + (format ? "?format=" + format : ""));
  if (!r.ok) throw Error(r.error);
  dpaDownload(
    "Daily-Paper-Assistant-" +
      new Date().toISOString().slice(0, 10) +
      "." +
      (format === "bibtex" ? "bib" : format || "json"),
    format ? r.text : JSON.stringify(r.pack, null, 2),
  );
}
async function dpaTransferPreview(file) {
  if (!file) return;
  transferDraft = JSON.parse(await file.text());
  const r = await dpaPost("/api/data/preview", { pack: transferDraft });
  $("#transferPreview").innerHTML =
    `<pre>${esc(JSON.stringify(r.counts, null, 2))}</pre><p>${esc(r.policy)}；重复论文 ${r.paperConflicts} 篇</p><button class="btn primary" onclick="dpaTransferCommit()">确认导入</button>`;
}
async function dpaTransferCommit() {
  const r = await dpaPost("/api/data/import", { pack: transferDraft });
  toast(`新增 ${r.inserted} 条，保留本地冲突 ${r.conflicts} 条`);
  transferDraft = null;
  await viewTasks();
}
async function viewCatalogImport() {
  await dpaReload();
  $("#main").innerHTML =
    `<h1>期刊目录表格导入</h1><p>支持 CSV、TSV、Excel .xlsx 和粘贴文本。旧版 .xls 请先另存为 .xlsx；不识别 PDF。</p>${dpaSelect(
      "importKind",
      "目录类型",
      {
        attention: "个人关注期刊（不产生评定等级）",
        ...Object.fromEntries(
          Object.entries(dpa.catalogTypes)
            .filter(([k]) => !k.startsWith("ref_"))
            .map(([k, c]) => [k, c.label]),
        ),
      },
      "attention",
    )}<label class="field">选择文件<input type="file" accept=".csv,.tsv,.xlsx,.xls" onchange="dpaParseCatalogFile(this.files[0])"></label><label class="field">或者粘贴含表头的文本<textarea id="importText"></textarea></label><button class="btn" onclick="dpaParseCatalogText()">读取表格</button><div id="catalogPreview"></div>`;
  $("#importKind").onchange = () => {
    if (catalogDraft) dpaCatalogMapping();
  };
}
async function dpaParseCatalogFile(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    toast("文件最大10MB", true);
    return;
  }
  let body = { filename: file.name };
  if (/\.xlsx$/i.test(file.name)) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 32768)
      s += String.fromCharCode(...buf.subarray(i, i + 32768));
    body.base64 = btoa(s);
  } else body.text = await file.text();
  catalogDraft = await dpaPost("/api/catalog/parse", body);
  dpaCatalogMapping();
}
async function dpaParseCatalogText() {
  catalogDraft = await dpaPost("/api/catalog/parse", {
    text: $("#importText").value,
  });
  dpaCatalogMapping();
}
function dpaCatalogMapping() {
  const sheet = catalogDraft.sheets[0],
    kind = $("#importKind").value,
    fields =
      kind === "attention"
        ? ["期刊名称", "ISSN", "备注"]
        : dpa.catalogTypes[kind].fields;
  $("#catalogPreview").innerHTML =
    `<h2>字段匹配</h2>${dpaSelect("importSheet", "工作表", Object.fromEntries(catalogDraft.sheets.map((s, i) => [i, s.name])), 0)}${fields
      .map((f, i) =>
        dpaSelect(
          "mapping-" + i,
          f,
          {
            "-1": "不导入",
            ...Object.fromEntries(sheet.headers.map((h, n) => [n, h])),
          },
          sheet.headers.findIndex((h) => String(h).trim() === f),
        ),
      )
      .join(
        "",
      )}${dpaInput("importYear", "年份／版次")}${dpaInput("importSource", "来源说明")}${dpaSelect("importDuplicates", "文件内重复记录", { first: "保留第一条", last: "保留最后一条" }, "first")}<label class="dpa-check"><input id="importVerified" type="checkbox">这是已核实的官方评定目录（个人关注列表不受此项影响）</label><p>读取 ${sheet.count} 条；不会执行 Excel 公式。</p><button class="btn" onclick="dpaCatalogPreview()">预览导入结果</button><div id="catalogRows"></div>`;
  $("#importSheet").onchange = () => {
    const i = Number($("#importSheet").value);
    const selected = catalogDraft.sheets.splice(i, 1)[0];
    catalogDraft.sheets.unshift(selected);
    dpaCatalogMapping();
  };
}
let catalogCommitBody = null;
async function dpaCatalogPreview() {
  const kind = $("#importKind").value,
    fields =
      kind === "attention"
        ? ["期刊名称", "ISSN", "备注"]
        : dpa.catalogTypes[kind].fields,
    mapping = {};
  fields.forEach((f, i) => (mapping[f] = Number($("#mapping-" + i).value)));
  catalogCommitBody = {
    catalogKey: kind,
    rows: catalogDraft.sheets[0].rows,
    mapping,
    duplicates: $("#importDuplicates").value,
    year: $("#importYear").value,
    sourceName: $("#importSource").value,
    verified: $("#importVerified").checked,
  };
  const r = await dpaPost("/api/catalog/preview", catalogCommitBody);
  $("#catalogRows").innerHTML =
    `<p>可导入 ${r.valid} 条；文件内重复 ${r.duplicates} 条</p><div class="dpa-table"><table><thead><tr>${r.fields.map((f) => `<th>${esc(f)}</th>`).join("")}</tr></thead><tbody>${r.rows
      .slice(0, 20)
      .map((row) => `<tr>${row.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`)
      .join(
        "",
      )}</tbody></table></div><button class="btn primary" onclick="dpaCatalogCommit()">确认导入</button>`;
}
async function dpaCatalogCommit() {
  const r = await dpaPost("/api/catalog/commit", catalogCommitBody);
  toast("导入完成：" + JSON.stringify(r.stats || { imported: r.imported }));
  catalogCommitBody = null;
  await viewCatalogImport();
}
document.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.message) toast(e.reason.message, true);
});
