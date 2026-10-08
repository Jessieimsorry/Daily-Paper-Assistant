"use strict";
const journals = require("./journals"),
  store = require("./store");
async function parse(body) {
  let sheets = [];
  if (body.filename && /\.xlsx$/i.test(body.filename)) {
    const bytes = Buffer.from(body.base64 || "", "base64");
    if (bytes.length > 10 * 1024 * 1024) throw Error("Excel 文件最大10MB");
    const Excel = require("exceljs"),
      wb = new Excel.Workbook();
    await wb.xlsx.load(bytes);
    sheets = wb.worksheets.map((w) => ({
      name: w.name,
      rows: Array.from({ length: Math.min(w.rowCount, 10001) }, (_, i) =>
        w
          .getRow(i + 1)
          .values.slice(1)
          .map((v) =>
            v && typeof v === "object"
              ? v.text ||
                v.result ||
                v.richText?.map((x) => x.text).join("") ||
                ""
              : (v ?? ""),
          ),
      ).filter((r) => r.some((x) => String(x).trim())),
    }));
  } else {
    if (/\.xls$/i.test(body.filename || ""))
      throw Error("旧版 .xls 请另存为 .xlsx 后导入");
    const text = String(body.text || "").replace(/^\uFEFF/, "");
    const delimiter = text.split("\n")[0].includes("\t") ? "\t" : ",";
    sheets = [
      {
        name: "表格",
        rows:
          delimiter === ","
            ? journals.parseCsv(text)
            : text
                .split(/\r?\n/)
                .filter((x) => x.trim())
                .map((x) => x.split("\t")),
      },
    ];
  }
  if (!sheets.length || !sheets[0].rows.length)
    throw Error("文件没有可读取的表格");
  return {
    ok: true,
    sheets: sheets.map((s) => ({
      ...s,
      headers: s.rows[0],
      count: s.rows.length - 1,
    })),
  };
}
function preview(body) {
  const rows = body.rows;
  if (
    !Array.isArray(rows) ||
    rows.length > 10001 ||
    rows.some((r) => !Array.isArray(r))
  )
    throw Error("表格最多10000条记录");
  const fields =
    body.catalogKey === "attention"
      ? ["期刊名称", "ISSN", "备注"]
      : journals.CATALOG_TYPES[body.catalogKey]?.fields;
  if (!fields) throw Error("未知目录类型");
  const map = body.mapping || {};
  const mapped = rows
    .slice(1)
    .map((row) => fields.map((f) => row[Number(map[f])] ?? ""));
  const seen = new Set();
  let duplicates = 0;
  const clean = [];
  for (const r of mapped) {
    const key = String(r[fields.indexOf("ISSN")] || r[0])
      .trim()
      .toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      duplicates++;
      if (body.duplicates === "last") {
        const index = clean.findIndex(
          (x) =>
            String(x[fields.indexOf("ISSN")] || x[0])
              .trim()
              .toLowerCase() === key,
        );
        clean[index] = r;
      }
      continue;
    }
    seen.add(key);
    clean.push(r);
  }
  return {
    ok: true,
    fields,
    rows: clean,
    duplicates,
    valid: clean.length,
    csv: journals.toCsv([fields, ...clean]),
  };
}
function commit(body) {
  const p = preview(body);
  if (body.catalogKey === "attention") {
    store.tx(() => {
      for (const row of p.rows)
        store.run(
          "INSERT INTO dpa_attention(name,issn,note) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET issn=excluded.issn,note=excluded.note",
          row,
        );
    });
    return { ...p, imported: p.valid };
  }
  return journals.importCatalog(body.catalogKey, p.csv, {
    edition: body.edition,
    year: body.year,
    sourceName: body.sourceName,
    verified: body.verified === true,
    reference: body.verified !== true,
  });
}
module.exports = { parse, preview, commit };
