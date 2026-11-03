"use strict";
const { test, after } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "DPA 升级 ")),
  u = require("../scripts/upgrade");
after(() => fs.rmSync(dir, { recursive: true, force: true }));
function app(name, version) {
  const p = path.join(dir, name);
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(p, "server.js"), "// " + version);
  return p;
}
function data(p) {
  fs.mkdirSync(p, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(p, "litdesk.db"));
  db.exec(
    "CREATE TABLE favorite(title); INSERT INTO favorite VALUES('我的收藏')",
  );
  db.close();
  fs.writeFileSync(path.join(p, "secrets.json"), "private-fixture");
  fs.mkdirSync(path.join(p, "uploads"));
  fs.writeFileSync(path.join(p, "uploads", "paper.pdf"), "fixture");
}
test("old local data migrates once; backup and rollback preserve database, keys and files", () => {
  const root = app("new", "2.1.0"),
    runtime = app("runtime", "2.0.0"),
    target = path.join(dir, "data");
  data(path.join(root, "data"));
  const r = u.prepare({ root, runtime, data: target });
  assert.equal(
    fs.readFileSync(path.join(target, "secrets.json"), "utf8"),
    "private-fixture",
  );
  assert(fs.existsSync(path.join(r.backup, "data", "uploads", "paper.pdf")));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(runtime, "package.json"))).version,
    "2.1.0",
  );
  fs.writeFileSync(path.join(target, "secrets.json"), "changed");
  u.rollback(r);
  assert.equal(
    fs.readFileSync(path.join(target, "secrets.json"), "utf8"),
    "private-fixture",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(runtime, "package.json"))).version,
    "2.0.0",
  );
  assert(fs.existsSync(path.join(root, "data", "litdesk.db")));
});
test("two nonempty data locations are never merged or overwritten silently", () => {
  const root = app("conflict", "2.1.0"),
    target = path.join(dir, "second");
  data(path.join(root, "data"));
  data(target);
  assert.throws(() => u.migrationSource(root, target), /两份数据/);
});
test("an old package cannot silently downgrade an installed version", () => {
  const root = app("old", "2.0.0"),
    runtime = app("current", "2.1.0");
  assert.throws(
    () => u.prepare({ root, runtime, data: path.join(dir, "unused") }),
    /降级/,
  );
});
