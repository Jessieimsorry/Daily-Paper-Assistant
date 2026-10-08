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
  if (process.platform === "win32")
    spawn("cmd.exe", ["/d", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
  else
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
      detached: true,
      stdio: "ignore",
    }).unref();
}
async function launch() {
  try {
    require("node:sqlite");
  } catch {
    throw Error(
      "请安装包含 node:sqlite 的 Node.js 22 或更新版本：https://nodejs.org/",
    );
  }
  const port = Number(process.env.LITDESK_PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("端口必须为1024–65535");
  const status = await probe(port),
    url = "http://127.0.0.1:" + port;
  if (status === "ours") {
    console.log("工作台已经运行：" + url);
    open(url);
    return;
  }
  if (status === "other")
    throw Error(
      "端口 " +
        port +
        " 已被其他程序占用；不会停止其他程序，请设置 LITDESK_PORT 换一个端口。",
    );
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  for (const name of [
    "lib",
    "public",
    "catalogs",
    "server.js",
    "package.json",
    "package-lock.json",
  ])
    if (fs.existsSync(path.join(root, name)))
      fs.cpSync(path.join(root, name), path.join(runtime, name), {
        recursive: true,
      });
  if (!fs.existsSync(path.join(runtime, "node_modules", "exceljs"))) {
    if (fs.existsSync(path.join(root, "node_modules")))
      fs.cpSync(
        path.join(root, "node_modules"),
        path.join(runtime, "node_modules"),
        { recursive: true },
      );
    else {
      console.log("首次启动：安装 Excel 导入依赖…");
      const r = spawnSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["ci", "--ignore-scripts", "--no-fund"],
        { cwd: runtime, stdio: "inherit", shell: process.platform === "win32" },
      );
      if (r.status !== 0) throw Error("依赖安装失败，请检查网络后重新启动。");
    }
  }
  const child = spawn(process.execPath, [path.join(runtime, "server.js")], {
    env: { ...process.env, LITDESK_DATA_DIR: data, LITDESK_PORT: String(port) },
    stdio: "inherit",
  });
  child.on("error", (e) => console.error("启动失败：" + e.message));
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw Error("服务启动失败，请查看上方错误");
    if ((await probe(port)) === "ours") {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    child.kill();
    throw Error("启动超时，请查看上方错误信息");
  }
  console.log("工作台已启动：" + url);
  open(url);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill());
  child.on("exit", (code) => (process.exitCode = code || 0));
}
if (require.main === module)
  launch().catch((e) => {
    console.error("无法启动：" + e.message);
    process.exitCode = 1;
  });
module.exports = { launch, probe };
