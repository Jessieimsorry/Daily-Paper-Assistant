'use strict';
/**
 * 全文管理：用户自己取得并上传的 PDF、以及合法开放全文的位置记录。
 * 不抓取需要付费墙的正文，不绕过任何授权限制。
 */
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const { UPLOAD_DIR } = require('./config');

/**
 * 判断抽取出的文本是否像乱码（而不是「没有文字」）。
 * 乱码特征：大量控制字符、替换字符、或非 ASCII 的高位 Latin-1 字符混排。
 * 正常中英文文本里，这些字符占比应接近 0。
 */
function looksLikeGarbage(text) {
  const t = String(text || '');
  if (t.length < 60) return false;
  let bad = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c === 0xFFFD) { bad++; continue; }                  // 替换字符
    if (c < 0x09) { bad++; continue; }                       // 控制字符
    if (c > 0x0D && c < 0x20) { bad++; continue; }           // 其他控制字符
    if (c >= 0x80 && c <= 0x9F) { bad++; continue; }         // C1 控制区
    if (c >= 0xA0 && c <= 0x2FF) { bad++; continue; }        // 高位 Latin-1 / 扩展拉丁
    if (c >= 0xE000 && c <= 0xF8FF) { bad++; continue; }     // 私用区
  }
  const ratio = bad / [...t].length;
  return ratio > 0.15;
}

const HEADING_PATTERNS = [
  /^(abstract|摘要)\b/i, /^(introduction|引言|导言|绪论)\b/i,
  /^(literature review|文献综述|相关研究)\b/i, /^(theoretical|理论框架|概念框架)\b/i,
  /^(method|methodology|方法|研究方法|研究设计)\b/i, /^(participants|研究对象|被试|参与者)\b/i,
  /^(results|findings|结果|研究发现)\b/i, /^(discussion|讨论)\b/i, /^(conclusion|结论|结语)\b/i,
  /^(limitations|局限|研究局限)\b/i, /^(implications|启示|教学启示)\b/i,
  /^(references|参考文献)\b/i, /^(appendix|附录)\b/i,
  /^\d+\.?\s+[A-Z][a-z]/, // 1. Introduction 形式
];

/** 从纯文本里粗切章节，用于让 AI 引用时可指向章节 */
function detectSections(text) {
  const lines = String(text).split('\n');
  const sections = [];
  let cur = { heading: '正文', text: [] };
  for (const line of lines) {
    const t = line.trim();
    const isHeading = t.length > 0 && t.length <= 80 &&
      (HEADING_PATTERNS.some((re) => re.test(t)) || /^[一二三四五六七八九十]+[、.]\s*\S{2,20}$/.test(t));
    if (isHeading && cur.text.join('').length > 200) {
      sections.push({ heading: cur.heading, text: cur.text.join('\n').trim() });
      cur = { heading: t, text: [] };
    } else {
      cur.text.push(line);
    }
  }
  sections.push({ heading: cur.heading, text: cur.text.join('\n').trim() });
  return sections.filter((s) => s.text.length > 40);
}

/** 保存上传的 PDF：写盘 + 抽取文字层 + 入库 */
function saveUploadedPdf(paperId, filename, buffer) {
  const paper = store.get('SELECT id, title FROM papers WHERE id = ?', [paperId]);
  if (!paper) return { ok: false, error: '论文不存在' };

  const safeName = String(filename || 'upload.pdf').replace(/[^\w\u4e00-\u9fff.\-]/g, '_').slice(-80);
  const stored = path.join(UPLOAD_DIR, `p${paperId}-${Date.now()}-${safeName}`);
  fs.writeFileSync(stored, buffer);

  let extracted = { ok: false, text: '', charCount: 0, pages: 0, warning: '未提取', fontsWithToUnicode: 0, usedToUnicode: false };
  let scannedByModule = null;
  try {
    const pdftext = require('./pdftext');
    extracted = pdftext.extractPdfText(buffer);
    if (typeof pdftext.looksScanned === 'function') scannedByModule = pdftext.looksScanned(extracted);
  } catch (e) {
    extracted = { ok: false, text: '', charCount: 0, pages: 0, warning: 'PDF 解析模块异常: ' + e.message, fontsWithToUnicode: 0, usedToUnicode: false };
  }

  const scanned = scannedByModule !== null
    ? scannedByModule
    : (!extracted.text || extracted.charCount < 200);
  // CID/Identity-H 字体缺少 ToUnicode 时会解出乱码。
  // 不能只看「有没有 ToUnicode 映射」——简单的 Type1 字体（Helvetica 等）
  // 用标准编码就能正确解出英文，此时 fontsWithToUnicode=0 却是好文本。
  // 因此直接检查解出来的内容是否像人话。
  const likelyGarbage = !scanned && extracted.ok && looksLikeGarbage(extracted.text);
  const usable = !scanned && !likelyGarbage;
  const sections = usable ? detectSections(extracted.text) : [];
  const note = scanned
    ? `PDF 未检测到可用文字层（可能是扫描件或图片型 PDF）：已保存文件，但无法用于文本解读。${extracted.warning ? ' 详情：' + extracted.warning : ''}`
    : likelyGarbage
      ? `PDF 提取出的文字疑似乱码：该文件的中文/日文/韩文字体没有内嵌 ToUnicode 映射，本地解析无法还原字符。文件已保存，但不会用于 AI 全文解读。建议改用带文字层的版本，或仅依据摘要解读。`
      : `本地 PDF 文字层抽取，共 ${extracted.pages || '?'} 页 / ${extracted.charCount} 字符。抽取结果可能有排版噪声（页眉页脚、断行、公式乱码），引用时请以原文 PDF 为准。${extracted.warning ? ' 详情：' + extracted.warning : ''}`;

  store.run(
    `INSERT INTO fulltexts(paper_id, origin, filename, stored_path, char_count, content, sections, fetched_at, note)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(paper_id) DO UPDATE SET
       origin=excluded.origin, filename=excluded.filename, stored_path=excluded.stored_path,
       char_count=excluded.char_count, content=excluded.content, sections=excluded.sections,
       fetched_at=excluded.fetched_at, note=excluded.note`,
    [paperId, 'uploaded', filename || safeName, stored, extracted.charCount || 0,
     usable ? extracted.text : '', JSON.stringify(sections), store.nowIso(), note]);

  if (usable) {
    store.run(`UPDATE papers SET fulltext_source = 'uploaded', updated_at = ? WHERE id = ?`, [store.nowIso(), paperId]);
  }

  return {
    ok: true, scanned, usable, likelyGarbage,
    pages: extracted.pages, charCount: extracted.charCount,
    sections: sections.map((s) => s.heading), note, warning: extracted.warning || null,
  };
}

/** 记录一个合法开放全文链接（不做绕过） */
function recordOpenFulltextLink(paperId, url, origin = 'open') {
  const paper = store.get('SELECT id FROM papers WHERE id = ?', [paperId]);
  if (!paper) return { ok: false, error: '论文不存在' };
  store.run(`UPDATE papers SET pdf_url = ?, fulltext_source = ?, updated_at = ? WHERE id = ?`,
    [url, origin, store.nowIso(), paperId]);
  return { ok: true };
}

function getFulltext(paperId) {
  const ft = store.get('SELECT * FROM fulltexts WHERE paper_id = ?', [paperId]);
  if (!ft) return null;
  return {
    origin: ft.origin, filename: ft.filename, charCount: ft.char_count,
    fetchedAt: ft.fetched_at, note: ft.note,
    sections: store.parseJson(ft.sections, []),
    content: ft.content,
  };
}

function deleteFulltext(paperId) {
  const ft = store.get('SELECT * FROM fulltexts WHERE paper_id = ?', [paperId]);
  if (ft?.stored_path) { try { fs.unlinkSync(ft.stored_path); } catch {} }
  store.run('DELETE FROM fulltexts WHERE paper_id = ?', [paperId]);
  return { ok: true };
}

module.exports = { saveUploadedPdf, recordOpenFulltextLink, getFulltext, deleteFulltext, detectSections, looksLikeGarbage };
