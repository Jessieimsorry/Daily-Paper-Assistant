"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict"),
  http = require("node:http"),
  { spawn } = require("node:child_process"),
  u = require("../scripts/upgrade");
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "DPA hot upgrade ")),
    runtime = path.join(dir, "runtime"),
    data = path.join(dir, "data"),
    children = [];
  function source(name) {
    const p = path.join(dir, name);
    fs.mkdirSync(p);
    for (const n of [
      "lib",
      "public",
      "scripts",
      "catalogs",
      "server.js",
      "package.json",
      "package-lock.json",
    ])
      fs.cpSync(path.join(__dirname, "..", n), path.join(p, n), {
        recursive: true,
      });
    return p;
  }
  const old = source("old"),
    next = source("new"),
    bad = source("broken");
  fs.appendFileSync(
    path.join(next, "public/style.css"),
    "\n/* new fixture release */",
  );
  fs.writeFileSync(
    path.join(bad, "server.js"),
    "throw Error('fixture startup failure')",
  );
  fs.mkdirSync(runtime);
  fs.cpSync(
    path.join(__dirname, "../node_modules"),
    path.join(runtime, "node_modules"),
    { recursive: true },
  );
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  let output = "";
  function launch(root) {
    const c = spawn(process.execPath, [path.join(root, "scripts/launch.js")], {
      env: {
        ...process.env,
        LITDESK_RUNTIME_DIR: runtime,
        LITDESK_DATA_DIR: data,
        LITDESK_PORT: String(port),
        DPA_NO_BROWSER: "1",
        LITDESK_NO_AUTORUN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(c);
    c.stdout.on("data", (b) => (output += b));
    c.stderr.on("data", (b) => (output += b));
    return c;
  }
  async function wait(id) {
    for (let i = 0; i < 400; i++) {
      try {
        const r = await (
          await fetch("http://127.0.0.1:" + port + "/api/health", {
            signal: AbortSignal.timeout(1000),
          })
        ).json();
        if (r.releaseId === id && !fs.existsSync(runtime + ".upgrade.lock"))
          return r;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error(output);
  }
  try {
    launch(old);
    await wait(u.releaseId(old));
    fs.writeFileSync(
      path.join(data, "secrets.json"),
      JSON.stringify({ deepseekApiKey: "upgrade-private-fixture" }),
    );
    fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
    fs.writeFileSync(
      path.join(data, "uploads", "fixture.txt"),
      "retain uploaded material",
    );
    const denied = await (
      await fetch("http://127.0.0.1:" + port + "/api/app/stop-for-upgrade", {
        method: "POST",
      })
    ).json();
    assert.equal(denied.ok, false);
    const ctl = JSON.parse(fs.readFileSync(runtime + ".control.json"));
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(data, "litdesk.db"));
    db.exec(
      "INSERT INTO papers(id,title,dedup_key,language,abstract) VALUES(1,'保留题名','upgrade-fixture','zh','保留摘要'); INSERT INTO library(paper_id,starred,read_state,note) VALUES(1,1,'reading','保留备注'); INSERT INTO interpretations(paper_id,mode,content) VALUES(1,'quick','保留解读'); INSERT INTO translations(paper_id,field,target_lang,source_hash,translated) VALUES(1,'title','en','fixture','retained translation');",
    );
    function retained() {
      const check = new DatabaseSync(path.join(data, "litdesk.db"), {
        readOnly: true,
      });
      try {
        assert.equal(
          check.prepare("SELECT title FROM papers WHERE id=1").get().title,
          "保留题名",
        );
        const row = check
          .prepare(
            "SELECT starred,read_state,note FROM library WHERE paper_id=1",
          )
          .get();
        assert.equal(row.starred, 1);
        assert.equal(row.read_state, "reading");
        assert.equal(row.note, "保留备注");
        assert.equal(
          check
            .prepare("SELECT content FROM interpretations WHERE paper_id=1")
            .get().content,
          "保留解读",
        );
        assert.equal(
          check
            .prepare("SELECT translated FROM translations WHERE paper_id=1")
            .get().translated,
          "retained translation",
        );
      } finally {
        check.close();
      }
    }

    db.exec(
      "INSERT INTO dpa_jobs(id,kind,status,snapshot,steps,created_at,updated_at) VALUES('busy-fixture','translation','queued','{}','[]','','')",
    );
    const busy = await (
      await fetch("http://127.0.0.1:" + port + "/api/app/stop-for-upgrade", {
        method: "POST",
        headers: { "X-LitDesk-Control": ctl.token },
      })
    ).json();
    assert.equal(busy.ok, false);
    db.exec("DELETE FROM dpa_jobs WHERE id='busy-fixture'");
    db.close();
    const newer = launch(next);
    await wait(u.releaseId(next));
    retained();
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(data, "secrets.json")))
        .deepseekApiKey,
      "upgrade-private-fixture",
    );
    assert.equal(
      fs.readFileSync(path.join(data, "uploads", "fixture.txt"), "utf8"),
      "retain uploaded material",
    );
    assert(fs.readdirSync(path.join(dir, "backups")).length >= 2);
    // Wait for the new launcher to persist its control token before the next upgrade.
    for (let i = 0; i < 50; i++) {
      const c = JSON.parse(fs.readFileSync(runtime + ".control.json"));
      if (c.releaseId === u.releaseId(next)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    launch(bad);
    await new Promise((r) => setTimeout(r, 1000));
    await wait(u.releaseId(next));
    retained();
    assert(output.includes("已恢复升级前程序与资料"), output);
    assert.equal(
      fs.readFileSync(path.join(data, "uploads", "fixture.txt"), "utf8"),
      "retain uploaded material",
    );
    console.log(
      "Hot upgrade and failed-start rollback passed; files, secrets and old program retained.",
    );
  } finally {
    // Terminate launcher parents and their servers without relying on console behavior.
    try {
      const ctl = JSON.parse(fs.readFileSync(runtime + ".control.json"));
      await fetch("http://127.0.0.1:" + port + "/api/app/stop-for-upgrade", {
        method: "POST",
        headers: { "X-LitDesk-Control": ctl.token },
      });
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
    for (const c of children) if (c.exitCode === null) c.kill();
    for (const c of children)
      if (c.exitCode === null) await new Promise((r) => c.once("exit", r));
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
