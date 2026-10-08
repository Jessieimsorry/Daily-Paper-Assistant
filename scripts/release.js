"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  dest = path.join(root, "release", "Daily-Paper-Assistant");
const dirs = [
  "lib",
  "public",
  "scripts",
  "test",
  "catalogs/templates",
  ".github/workflows",
  "docs/images",
];
const files = [
  "server.js",
  "package.json",
  "package-lock.json",
  "start.sh",
  "启动工作台.command",
  "启动工作台.cmd",
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  ".gitignore",
  ".env.example",
  "catalogs/seed-topics.json",
  "docs/隐私与发布说明.md",
  "docs/第三方依赖.md",
  "docs/验证记录.md",
];
const blocked =
  /(^|\/)(node_modules|data|data-[^/.]*|release|\.git|期刊目录|验收截图)(\/|$)|(?:secrets|settings)\.json$|\.(?:db|sqlite|log|zip)$/i;
const selected = [];
function walk(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return;
  if (fs.lstatSync(p).isSymbolicLink())
    throw Error("发布清单含符号链接：" + rel);
  if (fs.statSync(p).isDirectory()) {
    for (const n of fs.readdirSync(p)) walk(rel + "/" + n);
  } else {
    if (blocked.test(rel.replace(/\\/g, "/")) && !/\.js$/.test(rel))
      throw Error("禁止发布：" + rel);
    selected.push(rel);
  }
}
for (const d of dirs) walk(d);
for (const f of files) walk(f);
const secrets = [];
const data = process.env.LITDESK_DATA_DIR || require("../lib/platform").data();
for (const file of ["secrets.json", "settings.json"]) {
  try {
    const values = JSON.parse(fs.readFileSync(path.join(data, file), "utf8"));
    for (const [k, v] of Object.entries(values))
      if (
        /key|token|secret/i.test(k) &&
        typeof v === "string" &&
        v.length > 10 &&
        !/EnvVar/.test(k)
      )
        secrets.push(v);
  } catch {}
}
for (const [k, v] of Object.entries(process.env))
  if (/(?:API_KEY|TOKEN|SECRET)$/.test(k) && v.length > 12) secrets.push(v);
for (const rel of selected) {
  if (/\.(?:png|jpg)$/.test(rel)) continue;
  const bytes = fs.readFileSync(path.join(root, rel)),
    s = bytes.toString("utf8");
  if (secrets.some((secret) => s.includes(secret)))
    throw Error("发现真实密钥，停止发布；文件：" + rel);
  if (
    /\/Users\/[^/\s]+\//.test(s) ||
    s.includes(require("node:os").userInfo().username)
  )
    throw Error("发现个人身份或路径，停止发布；文件：" + rel);
}
if (fs.existsSync(dest)) fs.renameSync(dest, dest + "-previous-" + Date.now());
fs.mkdirSync(dest, { recursive: true });
const manifest = [];
for (const rel of selected) {
  const to = path.join(dest, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, rel), to);
  manifest.push({
    file: rel,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(to))
      .digest("hex"),
  });
}
// 发布版没有机构期刊评定名录；程序首次启动从空期刊库开始。
fs.writeFileSync(
  path.join(dest, "catalogs", "seed-reference-journals.json"),
  JSON.stringify({ journals: [], note: "请导入合法取得的期刊目录。" }, null, 2),
);
// 源工作目录排除私人名录；发布目录只允许提交这里生成的空模板。
fs.appendFileSync(path.join(dest, ".gitignore"), "\n!catalogs/seed-reference-journals.json\n");
manifest.find((x) => x.file === ".gitignore").sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(dest, ".gitignore"))).digest("hex");
manifest.push({file: "catalogs/seed-reference-journals.json", sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(dest, "catalogs", "seed-reference-journals.json"))).digest("hex")});
fs.chmodSync(path.join(dest, "启动工作台.command"), 0o755);
fs.chmodSync(path.join(dest, "start.sh"), 0o755);
fs.writeFileSync(
  path.join(dest, "发布清单.json"),
  JSON.stringify(
    {
      project: "Daily-Paper-Assistant",
      at: new Date().toISOString(),
      privacy: {
        personalData: false,
        secrets: false,
        privateScreenshots: false,
        licensedCatalogs: false,
        gitHistory: false,
      },
      files: manifest,
    },
    null,
    2,
  ),
);
console.log("发布副本已生成：" + dest);
console.log(
  "审查文件数：" +
    manifest.length +
    "；未复制用户数据、密钥、备份或 Git 历史。",
);
