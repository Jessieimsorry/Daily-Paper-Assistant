"use strict";
// 为普通用户生成精简目录；仅从经过隐私审查的发布副本取文件。
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  src = path.join(root, "release", "Daily-Paper-Assistant");
if (!fs.existsSync(path.join(src, "发布清单.json")))
  throw Error("请先运行 npm run release");
const manifest = JSON.parse(fs.readFileSync(path.join(src, "发布清单.json")));
for (const f of manifest.files)
  if (
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(src, f.file)))
      .digest("hex") !== f.sha256
  )
    throw Error("发布文件校验失败：" + f.file);
const version = JSON.parse(
  fs.readFileSync(path.join(src, "package.json")),
).version;
const dest = path.join(root, "dist", "Daily-Paper-Assistant-" + version);
if (fs.existsSync(dest))
  throw Error("安装包目录已存在，请保留或移动旧安装包后重新运行");
const files = [
  "lib",
  "public",
  "catalogs",
  "server.js",
  "package.json",
  "package-lock.json",
  "scripts/launch.js",
  "scripts/upgrade.js",
  "启动工作台.cmd",
  "启动工作台.command",
  "start.sh",
  "README.md",
  "LICENSE",
  "docs/升级指南.md",
  "docs/使用指南.md",
  "docs/开发指南.md",
  "docs/隐私与发布说明.md",
  "docs/第三方依赖.md",
  "docs/验证记录.md",
  "docs/images",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
];
fs.mkdirSync(dest, { recursive: true });
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
  fs.cpSync(path.join(src, f), path.join(dest, f), { recursive: true });
}
const pkg = JSON.parse(fs.readFileSync(path.join(dest, "package.json")));
pkg.scripts = { start: "node scripts/launch.js" };
fs.writeFileSync(
  path.join(dest, "package.json"),
  JSON.stringify(pkg, null, 2) + "\n",
);
const entries = [];
function walk(dir) {
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else
      entries.push({
        file: path.relative(dest, p).split(path.sep).join("/"),
        sha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(p))
          .digest("hex"),
      });
  }
}
walk(dest);
fs.writeFileSync(
  path.join(dest, "发布清单.json"),
  JSON.stringify({ version, files: entries }, null, 2),
);
console.log(dest);
