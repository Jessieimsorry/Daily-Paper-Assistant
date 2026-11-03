"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawn, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  base = require("../lib/platform").home(),
  runtime = process.env.LITDESK_RUNTIME_DIR
    ? path.resolve(process.env.LITDESK_RUNTIME_DIR)
    : path.join(base, "runtime"),
  data = require("../lib/platform").data();
async function probe(port) {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/api/health", {
      signal: AbortSignal.timeout(1500),
    });
    const d = await r.json();
    return d.app === "文献阅读工作台" && d.ok ? "ours" : "other";
  } catch (e) {
    try {
      const r = await fetch("http://127.0.0.1:" + port, {
        signal: AbortSignal.timeout(1000),
      });
      return "other";
    } catch {
      return "none";
    }
  }
}
function open(url) {
  if (process.env.DPA_NO_BROWSER === "1") return;
  let browser;
  if (process.platform === "win32")
    browser = spawn("cmd.exe", ["/d", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    });
  else
    browser = spawn(
      process.platform === "darwin" ? "open" : "xdg-open",
      [url],
      {
        detached: true,
        stdio: "ignore",
      },
    );
  browser.on("error", () => console.log("请在浏览器手动打开：" + url));
  browser.unref();
}
async function health(port) {
  try {
    return await (
      await fetch("http://127.0.0.1:" + port + "/api/health", {
        signal: AbortSignal.timeout(2000),
      })
    ).json();
  } catch {
    return null;
  }
}
async function launch() {
  try {
    require("node:sqlite");
  } catch {
    throw Error("请安装 Node.js 24 LTS：https://nodejs.org/");
  }
  const u = require("./upgrade"),
    crypto = require("node:crypto");
  const port = Number(process.env.LITDESK_PORT || 8787),
    url = "http://127.0.0.1:" + port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("端口必须为1024–65535");
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  const lock = runtime + ".upgrade.lock";
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let alive = true;
    try {
      process.kill(Number(fs.readFileSync(lock, "utf8")), 0);
    } catch (err) {
      alive = err.code !== "ESRCH";
    }
    if (alive) throw Error("另一个启动或升级正在进行，请稍后重试");
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  }
  let record,
    child,
    stoppedOld = false;
  const control = runtime + ".control.json",
    id = u.releaseId(root),
    version = require("../package.json").version;
  const spawnServer = (release, token) => {
    const c = spawn(process.execPath, [path.join(runtime, "server.js")], {
      env: {
        ...process.env,
        LITDESK_DATA_DIR: data,
        LITDESK_PORT: String(port),
        LITDESK_RELEASE_ID: release,
        LITDESK_CONTROL_TOKEN: token,
      },
      stdio: "inherit",
    });
    c.on("error", (e) => console.error("启动失败：" + e.message));
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => c.kill());
    c.on("exit", (code) => {
      process.exitCode = code || 0;
    });
    return c;
  };
  const ready = async (c, release) => {
    for (let i = 0; i < 160; i++) {
      if (c.exitCode !== null) throw Error("服务启动失败");
      const h = await health(port);
      if (h?.ok && h.releaseId === release) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw Error("启动超时");
  };
  try {
    const status = await probe(port);
    if (status === "other")
      throw Error("端口被其他程序占用，请设置 LITDESK_PORT 换一个端口");
    const fromIndex = process.argv.indexOf("--from"),
      from = fromIndex >= 0 ? process.argv[fromIndex + 1] : undefined;
    if (fromIndex >= 0 && !from) throw Error("--from 后请填写旧版 data 目录");
    u.validateVersion(root, runtime);
    u.migrationSource(root, data, from);
    if (status === "ours") {
      const h = await health(port);
      if (
        h.releaseId === id &&
        path.resolve(h.dbFile) === path.join(data, "litdesk.db")
      ) {
        console.log("已是当前版本 " + version + "：" + url);
        open(url);
        return;
      }
      if (path.resolve(h.dbFile) !== path.join(data, "litdesk.db"))
        throw Error(
          "运行中的工作台使用另一份数据，请先关闭旧启动窗口，再选择正确的数据目录",
        );
      let ctl;
      try {
        ctl = JSON.parse(fs.readFileSync(control, "utf8"));
      } catch {}
      if (!ctl?.token || ctl.releaseId !== h.releaseId)
        throw Error(
          "检测到早期版本仍在运行。请关闭旧版启动窗口后再次双击新版；资料不会丢失。",
        );
      const stopped = await (
        await fetch(url + "/api/app/stop-for-upgrade", {
          method: "POST",
          headers: { "X-LitDesk-Control": ctl.token },
          signal: AbortSignal.timeout(5000),
        })
      ).json();
      if (!stopped.ok) throw Error(stopped.error || "暂不能安全升级");
      for (let i = 0; i < 100; i++) {
        let alive = true;
        try {
          process.kill(h.pid, 0);
        } catch (err) {
          alive = err.code !== "ESRCH";
        }
        if (!alive && (await probe(port)) === "none") {
          stoppedOld = true;
          break;
        }
        if (i === 99)
          throw Error("旧服务仍在结束请求，请等待旧启动窗口退出后再试");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // 已停止服务后才备份数据库；不在运行中复制 WAL 数据库。
    u.migrationSource(root, data, from);
    if (
      path.resolve(root) !== path.resolve(runtime) &&
      (!fs.existsSync(path.join(runtime, "server.js")) ||
        u.releaseId(runtime) !== id ||
        u.migrationSource(root, data, from))
    ) {
      record = u.prepare({ root, runtime, data, from });
      console.log("升级前备份已保存：" + record.backup);
    }
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(runtime, "node_modules", "exceljs"))) {
      if (fs.existsSync(path.join(root, "node_modules")))
        fs.cpSync(
          path.join(root, "node_modules"),
          path.join(runtime, "node_modules"),
          { recursive: true },
        );
      else {
        console.log("首次启动：安装 Excel 依赖…");
        const r = spawnSync(
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["ci", "--ignore-scripts", "--no-fund"],
          {
            cwd: runtime,
            stdio: "inherit",
            shell: process.platform === "win32",
          },
        );
        if (r.status !== 0) throw Error("依赖安装失败，请检查网络后重试");
      }
    }
    const token = crypto.randomBytes(32).toString("hex");
    child = spawnServer(id, token);
    await ready(child, id);
    fs.writeFileSync(
      control,
      JSON.stringify({ releaseId: id, token, version }),
      { mode: 0o600 },
    );
    console.log("工作台 " + version + " 已启动：" + url);
    open(url);
  } catch (e) {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once("exit", r));
    }
    if (record) {
      u.rollback(record);
      console.error("升级失败，已恢复升级前程序与资料。备份：" + record.backup);
      if (fs.existsSync(path.join(runtime, "server.js"))) {
        const oldId = u.releaseId(runtime),
          token = crypto.randomBytes(32).toString("hex");
        child = spawnServer(oldId, token);
        try {
          await ready(child, oldId);
          fs.writeFileSync(
            control,
            JSON.stringify({ releaseId: oldId, token }),
            { mode: 0o600 },
          );
          open(url);
        } catch {
          child.kill();
        }
      }
    }
    if (
      stoppedOld &&
      !record &&
      fs.existsSync(path.join(runtime, "server.js"))
    ) {
      const oldId = u.releaseId(runtime),
        token = crypto.randomBytes(32).toString("hex");
      child = spawnServer(oldId, token);
      try {
        await ready(child, oldId);
        fs.writeFileSync(control, JSON.stringify({ releaseId: oldId, token }), {
          mode: 0o600,
        });
      } catch {
        child.kill();
      }
    }
    throw e;
  } finally {
    fs.unlinkSync(lock);
  }
}
if (require.main === module)
  launch().catch((e) => {
    console.error("无法启动：" + e.message);
    process.exitCode = 1;
  });
module.exports = { launch, probe };
