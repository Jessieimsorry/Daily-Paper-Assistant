"use strict";
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  http = require("node:http"),
  { spawn } = require("node:child_process"),
  assert = require("node:assert/strict");
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dpa 启动 空格-")),
    probe = http.createServer((q, r) => r.end("occupied"));
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  const { probe: check } = require("../scripts/launch");
  assert.equal(await check(port), "other");
  await new Promise((r) => probe.close(r));
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "../server.js")],
    {
      env: {
        ...process.env,
        LITDESK_DATA_DIR: dir,
        LITDESK_PORT: String(port),
        LITDESK_NO_AUTORUN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stderr.on("data", (b) => (output += b));
  try {
    let health;
    for (let i = 0; i < 80; i++) {
      try {
        const res = await fetch("http://127.0.0.1:" + port + "/api/health");
        health = await res.json();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert(health?.ok, output);
    assert.equal(health.dbFile, path.join(dir, "litdesk.db"));
    assert.equal(await check(port), "ours");
    const r = await fetch("http://127.0.0.1:" + port + "/api/search-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        region: "research",
        topics: [],
        sources: ["crossref"],
      }),
    });
    assert.equal((await r.json()).ok, false);
    const forbidden = await fetch(
      "http://127.0.0.1:" + port + "/api/customization",
      { headers: { Origin: "https://example.org" } },
    );
    assert.equal(forbidden.status, 403);
    console.log(
      "跨平台启动 smoke：中文空格路径、健康检查、重复探测、端口冲突、空选择及跨站拒绝通过",
    );
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
