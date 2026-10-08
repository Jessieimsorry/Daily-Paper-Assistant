"use strict";
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  http = require("node:http");
process.env.LITDESK_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "dpa-test-"),
);
process.env.LITDESK_NO_AUTORUN = "1";
const store = require("../lib/store");
store.migrate();
require("../lib/discover").seedTopicsIfEmpty();
require("../lib/categories").seed();
const custom = require("../lib/customize");
custom.initialize();
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log("✓ " + name);
};
async function settle(id) {
  for (let i = 0; i < 200; i++) {
    const j = require("../lib/tasks").get(id);
    if (!["queued", "running"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("任务超时");
}
(async () => {
  let calls = [],
    slow = false;
  const mock = http.createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    const b = JSON.parse(raw);
    calls.push(b);
    if (slow) await new Promise((r) => setTimeout(r, 150));
    res.setHeader("Content-Type", "application/json");
    if (b.model === "bad") {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: "bad" } }));
      return;
    }
    res.end(
      JSON.stringify({
        model: b.model,
        choices: [
          {
            message: { content: "模型 " + b.model + " 的完整结果。" },
            finish_reason: b.model === "truncated" ? "length" : "stop",
          },
        ],
        usage: { total_tokens: 12 },
      }),
    );
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + mock.address().port;
  try {
    check("新增九类且四个新类不自动采集", () => {
      assert.equal(custom.categories().length, 9);
      assert(
        custom
          .categories()
          .slice(5)
          .every((c) => !c.automatic),
      );
    });
    const original = custom.categories();
    custom.saveCategories(
      original.map((c, i) => ({ ...c, automatic: i === 5 })),
    );
    check("自动方向只取所选栏目", () =>
      assert.deepEqual(custom.autoTopics(), ["education-psychology"]),
    );
    custom.saveCategories(original);
    custom.put("identity", {
      name: "测试科研工作台",
      subtitle: "",
      onboarded: true,
    });
    custom.initialize();
    check("重启不覆盖个人名称", () =>
      assert.equal(custom.get("identity").name, "测试科研工作台"),
    );
    store.run(
      "INSERT INTO papers(title,abstract,language,doi_norm,dedup_key) VALUES(?,?,?,?,?)",
      [
        "学习研究",
        "Une étude française complète.",
        "fr",
        "10.5555/test",
        "test",
      ],
    );
    const pid = store.get("SELECT last_insert_rowid() id").id;
    const models = require("../lib/models");
    models.save({
      id: "a",
      name: "A",
      model: "model-a",
      baseUrl: base,
      apiKey: "private-test-key",
    });
    models.save({ id: "b", name: "B", model: "model-b", baseUrl: base });
    models.save({ id: "bad", name: "故障", model: "bad", baseUrl: base });
    models.save({
      id: "trunc",
      name: "截断",
      model: "truncated",
      baseUrl: base,
    });
    custom.put("bindings", { translation: "a", quick: "b", deep: "a" });
    check('深入解读认可单独配置的本地模型连接',()=>assert(models.withProfile('a',()=>require('../lib/interpret').isConfigured())));models.save({id:'missing',name:'未配置',model:'unused',baseUrl:'https://example.invalid'});check('缺密钥的独立连接不借用另一连接的密钥',()=>assert.equal(models.withProfile('missing',()=>require('../lib/interpret').isConfigured()),false));
    check("配置列表不泄露密钥", () =>
      assert(!JSON.stringify(models.list()).includes("private-test-key")),
    );
    check("拒绝带凭据的接口地址", () =>
      assert.throws(() =>
        models.save({
          name: "x",
          model: "x",
          baseUrl: "https://user:password@example.com",
        }),
      ),
    );
    const multi = require("../lib/multilingual");
    let r = await multi.translate({
      subjectKey: "paper:" + pid,
      field: "abstract",
      targetLang: "ja",
    });
    check("法语到日语调用所选模型", () => {
      assert(r.ok);
      assert.equal(r.sourceLang, "fr");
      assert.equal(r.targetLang, "ja");
      assert.equal(calls.at(-1).model, "model-a");
      assert(calls.at(-1).messages[0].content.includes("日文"));
    });
    let n = calls.length;
    await multi.translate({
      subjectKey: "paper:" + pid,
      field: "abstract",
      targetLang: "ja",
    });
    check("相同配置直接复用译文", () => assert.equal(calls.length, n));
    await multi.translate({
      subjectKey: "paper:" + pid,
      field: "abstract",
      targetLang: "en",
    });
    check("目标语种切换不复用错误缓存", () =>
      assert.equal(calls.length, n + 1),
    );
    custom.put("bindings", { translation: "b" });
    await multi.translate({
      subjectKey: "paper:" + pid,
      field: "abstract",
      targetLang: "ja",
    });
    check("模型切换隔离缓存", () =>
      assert.equal(calls.at(-1).model, "model-b"),
    );
    n = calls.length;
    const absent = await multi.translate({
      subjectKey: "paper:" + pid,
      field: "keywords",
    });
    check("缺关键词不调用模型", () => {
      assert(!absent.ok);
      assert.equal(calls.length, n);
    });
    r = await multi.translate({
      subjectKey: "paper:" + pid,
      field: "abstract",
      targetLang: "de",
      profileId: "trunc",
    });
    check("截断译文不缓存成成功", () => assert(!r.ok));
    custom.put("limits", { dailyCalls: 1 });
    r = await models.invoke(models.resolve("a"), [
      { role: "user", content: "test" },
    ]);
    check("调用上限阻止新调用", () => assert(!r.ok));
    custom.put("limits", { dailyCalls: 0 });
    const oldAgents=custom.get('agents');custom.put('agents',oldAgents.map(a=>a.id==='translation'?{...a,prompt:a.prompt+' 注意完整保留结尾。'}:a));n=calls.length;await multi.translate({subjectKey:'paper:'+pid,field:'abstract',targetLang:'ja'});check('提示词改变不会复用旧配置的译文',()=>assert.equal(calls.length,n+1));custom.put('agents',oldAgents);
    const native=await models.withProfile('b',()=>require('../lib/interpret').interpret({paperId:pid,mode:'quick',useFulltext:false}));check('原有论文解读链路实际调用指定连接',()=>{assert(native.ok);assert.equal(native.model,'model-b');});
    const tasks = require("../lib/tasks");
    let j = tasks.add("agents", {
      subjectKey: "paper:" + pid,
      agents: [
        {
          id: "1",
          name: "第一步",
          scope: "abstract",
          prompt: "分析",
          profileId: "a",
        },
        {
          id: "2",
          name: "第二步",
          scope: "fulltext",
          prompt: "深入",
          profileId: "b",
        },
      ],
    });
    j = await settle(j.id);
    check("流程传递前一步结果与证据范围", () => {
      assert.equal(j.status, "completed");
      assert.equal(j.steps.length, 2);
      assert(calls.at(-1).messages[1].content.includes("previousAgentOutputs"));
      assert(j.steps[1].result.scope.includes("全文未提供"));
    });
    n = calls.length;
    j = tasks.add("agents", {
      subjectKey: "paper:" + pid,
      agents: [
        { name: "失败", scope: "abstract", prompt: "x", profileId: "bad" },
        { name: "不执行", scope: "abstract", prompt: "x", profileId: "a" },
      ],
    });
    j = await settle(j.id);
    check("失败停止下游", () => {
      assert.equal(j.status, "failed");
      assert.equal(calls.length, n + 1);
    });
    slow = true;
    j = tasks.add("agents", {
      subjectKey: "paper:" + pid,
      agents: [
        { name: "等待", scope: "abstract", prompt: "x", profileId: "a" },
        { name: "不执行", scope: "abstract", prompt: "x", profileId: "b" },
      ],
    });
    tasks.cancel(j.id);
    j = await settle(j.id);
    check("取消任务不执行后续", () => assert.equal(j.status, "cancelled"));
    slow = false;
    const Excel = require("exceljs"),
      wb = new Excel.Workbook();
    const sheet = wb.addWorksheet("目录");
    sheet.addRow(["刊名", "ISSN"]);
    sheet.addRow(["示例期刊", "1234-5678"]);
    const bytes = await wb.xlsx.writeBuffer();
    const importer = require("../lib/catalog-import"),
      parsed = await importer.parse({
        filename: "目录.xlsx",
        base64: Buffer.from(bytes).toString("base64"),
      });
    check("真实 XLSX 解析工作表", () => {
      assert.equal(parsed.sheets[0].name, "目录");
      assert.equal(parsed.sheets[0].count, 1);
    });
    const input = {
      rows: parsed.sheets[0].rows,
      catalogKey: "attention",
      mapping: { 期刊名称: 0, ISSN: 1, 备注: -1 },
    };
    const preview = importer.preview(input);
    check("字段预览不改变期刊库", () => {
      assert.equal(preview.valid, 1);
      assert.equal(store.get("SELECT COUNT(*) c FROM journals").c, 0);
    });
    importer.commit(input);
    check("个人关注不改变评定等级", () => {
      assert.equal(store.get("SELECT COUNT(*) c FROM dpa_attention").c, 1);
      assert.equal(store.get("SELECT COUNT(*) c FROM journals").c, 0);
    });
    const pack = require("../lib/migration-pack").exportPack();
    check("迁移包无模型密钥", () =>
      assert(!JSON.stringify(pack).includes("private-test-key")),
    );
    const imported = require("../lib/migration-pack").commit(pack);
    check("重复迁移保留本地记录", () =>
      assert.equal(store.get("SELECT COUNT(*) c FROM papers").c, 1),
    );
    const packFile = path.join(process.env.LITDESK_DATA_DIR, "transfer.json");
    fs.writeFileSync(packFile, JSON.stringify(pack));
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpa-restore-"));
    const child = require("node:child_process").spawnSync(
      process.execPath,
      [
        "-e",
        `const s=require('./lib/store');s.migrate();require('./lib/discover').seedTopicsIfEmpty();require('./lib/categories').seed();const c=require('./lib/customize');c.initialize();const p=JSON.parse(require('node:fs').readFileSync(process.argv[1]));const r=require('./lib/migration-pack').commit(p);console.log(JSON.stringify({papers:s.get('SELECT COUNT(*) c FROM papers').c,identity:c.get('identity'),profiles:c.get('profiles')}));`,
        packFile,
      ],
      {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, LITDESK_DATA_DIR: freshDir },
        encoding: "utf8",
      },
    );
    check("干净实例可恢复论文和个人配置且不携带密钥", () => {
      assert.equal(child.status, 0, child.stderr);
      const restored = JSON.parse(child.stdout.trim());
      assert.equal(restored.papers, 1);
      assert.equal(restored.identity.name, "测试科研工作台");
      assert(restored.profiles.every((p) => !p.apiKey));
    });
    const science = require("../lib/science");
    let queries = [];
    const now = new Date().toISOString().slice(0, 10).split("-").map(Number);
    await science.collect({
      fetcher: async (url) => {
        queries.push(url);
        const issn = new URL(url).pathname.split("/")[2];
        return {
          ok: true,
          data: {
            message: {
              items: [
                {
                  DOI: "10.9999/" + issn,
                  title: ["Science example"],
                  published: { "date-parts": [now] },
                  type: "journal-article",
                  URL: "https://doi.org/10.9999/" + issn,
                },
              ],
            },
          },
        };
      },
    });
    check("科学进展限定三本主刊且不改变研究论文数", () => {
      assert.equal(queries.length, 3);
      assert(queries.every((q) => q.includes("/journals/")));
      assert.equal(store.get("SELECT COUNT(*) c FROM papers").c, 1);
      assert.equal(science.get().items.length, 3);
    });
    store.run("INSERT INTO dpa_science(doi,title,date) VALUES(?,?,?)", [
      "10.5555/test",
      "关联",
      new Date().toISOString().slice(0, 10),
    ]);
    const sid = store.get("SELECT last_insert_rowid() id").id;
    custom.reading("science:" + sid, { browsed: true, starred: true });
    check("跨区域 DOI 共享阅读与收藏", () => {
      assert(
        store.get("SELECT browsed_at FROM reader_papers WHERE paper_id=?", [
          pid,
        ]).browsed_at,
      );
      assert.equal(
        store.get("SELECT starred FROM library WHERE paper_id=?", [pid])
          .starred,
        1,
      );
    });
    let discoveryCalls = 0;
    const sources = require("../lib/sources"),
      oldSearch = sources.crossrefSearch;
    sources.crossrefSearch = async () => {
      discoveryCalls++;
      return { ok: true, papers: [], total: 0 };
    };
    await require("../lib/discover").collect({
      topics: [],
      sources: ["crossref"],
      manual: true,
    });
    check("方向选择为空不会联网采集", () => assert.equal(discoveryCalls, 0));
    await require("../lib/discover").collect({
      topics: ["sinology"],
      sources: [],
      manual: true,
      cnSources: false,
    });
    check("来源选择为空不会联网采集", () => assert.equal(discoveryCalls, 0));
    sources.crossrefSearch = oldSearch;
    const hit = require("../lib/rank").topicHits(
      { title: "Global sinology and Chinese studies", abstract: "" },
      require("../lib/discover").listTopics(false),
    );
    check("新栏目有真实主题命中而非只增加按钮", () =>
      assert(hit.hits.sinology > 0),
    );
    console.log("\n" + passed + " checks passed");
  } finally {
    await new Promise((r) => mock.close(r));
    store.db.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
