"use strict";
const store = require("./store");
function forSubject(s, scope = "abstract") {
  const meta = {
    title: s.title,
    doi: s.doi,
    authors: s.authors,
    journal: s.journal || s.journal_name,
  };
  if (scope === "metadata")
    return { scope: "题录", text: JSON.stringify(meta) };
  if (scope === "fulltext" && s.paperId) {
    const r = store.get(
      "SELECT * FROM fulltexts WHERE paper_id=? ORDER BY id DESC LIMIT 1",
      [s.paperId],
    );
    const text = r?.content;
    if (text)
      return { scope: "已有全文", text: JSON.stringify(meta) + "\n" + text };
  }
  return {
    scope: scope === "fulltext" ? "全文未提供，仅摘要" : "摘要",
    text: JSON.stringify(meta) + "\n" + (s.abstract || "原始数据未提供摘要"),
  };
}
module.exports = { forSubject };
