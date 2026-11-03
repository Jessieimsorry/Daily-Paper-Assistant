"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const CODE = [
  "lib",
  "public",
  "catalogs",
  "server.js",
  "package.json",
  "package-lock.json",
];
function releaseId(root) {
  const hash = crypto.createHash("sha256");
  function walk(rel) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) return;
    if (fs.lstatSync(file).isSymbolicLink())
      throw Error("程序文件不能是链接：" + rel);
    if (fs.statSync(file).isDirectory())
      for (const n of fs.readdirSync(file).sort()) walk(rel + "/" + n);
    else hash.update(rel).update(fs.readFileSync(file));
  }
  CODE.forEach(walk);
  return hash.digest("hex");
}
function copyCode(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of CODE)
    if (fs.existsSync(path.join(from, name)))
      fs.cpSync(path.join(from, name), path.join(to, name), {
        recursive: true,
      });
}
function hasData(dir) {
  return (
    fs.existsSync(dir) && fs.readdirSync(dir).some((n) => !n.startsWith("."))
  );
}
function migrationSource(root, data, from) {
  const candidate = from ? path.resolve(from) : path.join(root, "data");
  if (!fs.existsSync(candidate)) return null;
  if (
    fs.existsSync(data) &&
    fs.realpathSync(candidate) === fs.realpathSync(data)
  )
    return null;
  if (!fs.existsSync(path.join(candidate, "litdesk.db"))) {
    if (from) throw Error("旧数据目录中没有 litdesk.db");
    return null;
  }
  if (hasData(data))
    throw Error(
      "发现两份数据，已停止自动迁移。请保留两个目录，通过任务与数据合并导入，不会覆盖已有资料。",
    );
  return candidate;
}
function assertSeparate(a, b) {
  const rel = path.relative(path.resolve(a), path.resolve(b));
  if (
    !rel ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  )
    throw Error("程序、备份与数据目录不能互相包含");
}
function validateVersion(root, runtime) {
  const version = JSON.parse(
    fs.readFileSync(path.join(root, "package.json")),
  ).version;
  const oldVersion = fs.existsSync(path.join(runtime, "package.json"))
    ? JSON.parse(fs.readFileSync(path.join(runtime, "package.json"))).version
    : null;
  if (oldVersion) {
    const a = version.split(".").map(Number),
      b = oldVersion.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (a[i] > b[i]) break;
      if (a[i] < b[i])
        throw Error("检测到旧安装包，不自动降级；如需回退请使用备份。");
    }
  }
  return { version, oldVersion };
}
function prepare({ root, runtime, data, from }) {
  assertSeparate(runtime, data);
  assertSeparate(data, runtime);
  const legacy = migrationSource(root, data, from);
  const { version, oldVersion } = validateVersion(root, runtime);
  const stamp =
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    crypto.randomBytes(3).toString("hex");
  const backup = path.join(path.dirname(runtime), "backups", stamp),
    stage = runtime + ".stage-" + stamp;
  assertSeparate(data, backup);
  assertSeparate(runtime, backup);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const source = legacy || data;
  if (hasData(source)) {
    // 调用方必须先安全停止服务，包含 WAL、上传、配置及密钥的完整副本。
    fs.cpSync(source, path.join(backup, "data"), { recursive: true });
    if (fs.existsSync(path.join(backup, "data", "litdesk.db"))) {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(path.join(backup, "data", "litdesk.db"), {
        readOnly: true,
      });
      try {
        if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
          throw Error("数据库完整性检查未通过，原数据保持不变");
      } finally {
        db.close();
      }
    }
  }
  if (fs.existsSync(path.join(runtime, "server.js")))
    copyCode(runtime, path.join(backup, "program"));
  copyCode(root, stage);
  const old = runtime + ".previous-" + stamp;
  const record = {
    version,
    oldVersion,
    backup,
    old,
    runtime,
    data,
    legacy,
    at: new Date().toISOString(),
  };
  try {
    if (legacy) {
      fs.mkdirSync(data, { recursive: true, mode: 0o700 });
      fs.cpSync(path.join(backup, "data"), data, { recursive: true });
    }
    if (fs.existsSync(runtime)) fs.renameSync(runtime, old);
    fs.renameSync(stage, runtime);
    if (fs.existsSync(path.join(old, "node_modules")))
      fs.renameSync(
        path.join(old, "node_modules"),
        path.join(runtime, "node_modules"),
      );
    fs.writeFileSync(
      path.join(backup, "upgrade.json"),
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
    );
  } catch (e) {
    if (fs.existsSync(old)) {
      if (fs.existsSync(runtime)) rollback(record);
      else fs.renameSync(old, runtime);
    }
    throw e;
  }

  return record;
}
function rollback(r) {
  const failed = r.runtime + ".failed-" + Date.now();
  fs.renameSync(r.runtime, failed);
  if (fs.existsSync(r.old)) fs.renameSync(r.old, r.runtime);
  if (
    fs.existsSync(path.join(failed, "node_modules")) &&
    !fs.existsSync(path.join(r.runtime, "node_modules"))
  ) {
    fs.mkdirSync(r.runtime, { recursive: true });
    fs.renameSync(
      path.join(failed, "node_modules"),
      path.join(r.runtime, "node_modules"),
    );
  }
  if (fs.existsSync(path.join(r.backup, "data"))) {
    if (fs.existsSync(r.data))
      fs.renameSync(r.data, r.data + ".failed-" + Date.now());
    fs.cpSync(path.join(r.backup, "data"), r.data, { recursive: true });
  }
}
module.exports = {
  releaseId,
  prepare,
  rollback,
  migrationSource,
  copyCode,
  validateVersion,
};
