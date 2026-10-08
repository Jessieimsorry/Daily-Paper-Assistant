'use strict';
/**
 * ACL Anthology 元数据采集：批量下载 + 流式解析 + 落库。
 *
 * 为什么是「批量下载」而不是在线检索：
 *   ACL Anthology **没有 REST API，也没有可用的搜索接口**。唯一可靠的取数方式是
 *   下载全量 BibTeX（含摘要版）后在本地建立索引。所以本模块的链路是
 *   `download() → parseBibFile()（流式）→ 分批 upsert frontier_items`。
 *
 * 事实依据（2026-09-28 实测，未在代码里再猜）：
 *   · https://aclanthology.org/anthology+abstracts.bib.gz
 *       42,440,222 字节；解压约 178 MB；约 127,960 条记录。
 *       abstract 96.9% / doi 90.1% / author 98.1% / pages 98.1% / year 100% / url 100%。
 *   · https://aclanthology.org/anthology.bib.gz
 *       12,663,095 字节；**没有摘要**（abstract 0%）。
 *   · 该文件带 Last-Modified 与 ETag，支持 If-Modified-Since；无变化返回 HTTP 304。
 *   · 授权：2016 年起 CC BY 4.0，2016 年前 CC BY-NC-SA 3.0；元数据可再分发。
 *
 * 设计取舍：
 *   · 零依赖，只用 node: 内置模块；不 npm install。
 *   · 42 MB 下载 + 178 MB 解压必须全程流式（https.get → createGunzip → readline），
 *     绝不把解压结果整体读成字符串。
 *   · 落库每 500 条一个事务，避免 12 万条逐条提交。
 *   · LaTeX 花括号保护（{LLM}s）**原样保留**，`{\'e}` 这类重音转义不音译、不删除；
 *     只剥掉值最外层的定界符（{...} 的外层花括号或 "..." 的双引号）。
 *   · BibTeX 字符串拼接（`month = "17-20 " # jun`）安全降级：取第一段，不崩溃。
 *   · 只写能证明的日期精度：有年有月写 YYYY-MM，只有年写 YYYY，绝不补日。
 *
 * 与 frontier_items 表结构的一处事实差异（如实记录，未擅改 schema）：
 *   store.migrate() 建出的 frontier_items **没有 pages 列**。落库规则里要求保留页码，
 *   因此页码不做「猜测性映射」到别的语义列，而是原样保留在 raw.fields.pages 里
 *   （raw 会以 JSON 存下该条目的精简原始字段，其中就包含 pages 与 ISBN）。
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const readline = require('node:readline');

const { DATA_DIR } = require('./config');
const store = require('./store');
const N = require('./normalize');

const SOURCE_KEY = 'acl';

// 纯 ASCII：HTTP 头只能是 Latin-1，非 ASCII 会让请求直接抛错。
const USER_AGENT = 'LitDesk/1.0 (literature reading desk)';

// ACL Anthology 的正文 PDF 走固定命名，但 BibTeX 里**没有** pdf 字段，
// 因此 pdf_url 一律留空（只写能证明的，不靠推断补链接）。
const FULL_FILE = 'acl-anthology+abstracts.bib.gz';
const LIGHT_FILE = 'acl-anthology.bib.gz';

const META = {
  url: 'https://aclanthology.org/anthology+abstracts.bib.gz',
  urlLight: 'https://aclanthology.org/anthology.bib.gz',
  label: 'ACL Anthology（ACL 计算语言学协会论文库）',
  license: '2016 年起内容为 CC BY 4.0；2016 年前为 CC BY-NC-SA 3.0。元数据可再分发。',
  note: 'ACL Anthology 没有 REST API，也没有搜索接口，只能整包下载 BibTeX 后本地建立索引。'
    + '默认使用含摘要版：约 42.4 MB（解压约 178 MB，约 12.8 万条；摘要覆盖 96.9%）。'
    + '轻量版 anthology.bib.gz 约 12.7 MB，但**没有摘要**。'
    + '服务端带 Last-Modified 与 ETag，支持 If-Modified-Since，无变化时返回 HTTP 304。',
};

/** 同步状态的 key（都写在 frontier_sync_state 表里） */
const K_LAST_MODIFIED = 'acl:last_modified';
const K_ETAG = 'acl:etag';
const K_FILE = 'acl:file';
const K_BYTES = 'acl:bytes';
const K_LIGHT = 'acl:light';
const K_LAST_DOWNLOAD_AT = 'acl:last_download_at';
const K_LAST_SYNC_AT = 'acl:last_sync_at';
const K_LAST_ERROR = 'acl:last_error';
const K_PARSED = 'acl:parsed';
const K_INSERTED = 'acl:inserted';
const K_UPDATED = 'acl:updated';
const K_SKIPPED = 'acl:skipped';

const STATE_KEYS = [
  K_LAST_MODIFIED, K_ETAG, K_FILE, K_BYTES, K_LIGHT,
  K_LAST_DOWNLOAD_AT, K_LAST_SYNC_AT, K_LAST_ERROR,
  K_PARSED, K_INSERTED, K_UPDATED, K_SKIPPED,
];

/** 这些是 BibTeX 的「宏/序言/注释」，不是论文条目，解析时跳过且不报错。 */
const META_TYPES = new Set(['string', 'preamble', 'comment']);

const DOC_TYPE_BY_BIB_TYPE = {
  article: 'journal-article',
  inproceedings: 'conference-paper',
  conference: 'conference-paper',
};
function docTypeFor(bibType) {
  return DOC_TYPE_BY_BIB_TYPE[String(bibType || '').toLowerCase()] || 'other';
}

/* ================================================================== *
 * 1. BibTeX 解析（纯函数，不碰网络与数据库）
 * ================================================================== */

const MONTH_ABBR = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
const MONTH_FULL = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

/** 折叠空白（换行/缩进不定），但**不动花括号与反斜杠转义** */
function collapseWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * 读一个 BibTeX 值，返回**去掉最外层定界符**后的原文。
 *   · "..."  → 双引号内原文（内部的 {LLM}、{\'e} 完整保留）
 *   · {...}  → 花括号内原文（剥掉最外层定界花括号，嵌套花括号保留）
 *   · bare   → 宏名 / 数字（如 aug、2024）
 * 反斜杠转义（\"、\'、\{）整段跳过，避免把 `{\"u}` 里的引号当成字符串结束。
 * @returns {{value:string, i:number}}
 */
function readValue(body, start) {
  let i = start;
  while (i < body.length && /\s/.test(body[i])) i++;
  if (i >= body.length) return { value: '', i };

  const ch0 = body[i];
  if (ch0 === '"') {
    i++;
    let depth = 0;
    let out = '';
    while (i < body.length) {
      const ch = body[i];
      if (ch === '\\') { out += ch + (body[i + 1] || ''); i += 2; continue; }
      if (ch === '{') { depth++; out += ch; i++; continue; }
      if (ch === '}') { depth--; out += ch; i++; continue; }
      if (ch === '"' && depth <= 0) { i++; break; }
      out += ch; i++;
    }
    return { value: out, i };
  }

  if (ch0 === '{') {
    let depth = 0;
    i++;
    let out = '';
    while (i < body.length) {
      const ch = body[i];
      if (ch === '\\') { out += ch + (body[i + 1] || ''); i += 2; continue; }
      if (ch === '{') { depth++; out += ch; i++; continue; }
      if (ch === '}') {
        if (depth === 0) { i++; break; }   // 最外层定界花括号，剥掉
        depth--; out += ch; i++; continue;
      }
      out += ch; i++;
    }
    return { value: out, i };
  }

  // bare：宏名 / 数字，到空白、逗号、# 或右括号为止
  let out = '';
  while (i < body.length && !/[\s,#})]/.test(body[i])) { out += body[i]; i++; }
  return { value: out, i };
}

/**
 * 解析单条条目文本（形如 `@inproceedings{key, field = {...}, ...}`）。
 * @returns {object|null} 宏/序言/注释返回 null；无法识别为条目也返回 null
 */
function parseEntry(raw) {
  const m = /^\s*@([A-Za-z][A-Za-z0-9_-]*)\s*([{(])/.exec(String(raw || ''));
  if (!m) return null;
  const type = m[1].toLowerCase();
  if (META_TYPES.has(type)) return null;

  const closeCh = m[2] === '{' ? '}' : ')';
  let body = raw.slice(m[0].length).replace(/\s+$/, '');
  if (body.endsWith(closeCh)) body = body.slice(0, -1);

  // 引用键：到第一个逗号为止
  let i = 0;
  let key = '';
  while (i < body.length && body[i] !== ',') { key += body[i]; i++; }
  key = key.trim();
  if (body[i] === ',') i++;

  const fields = {};
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;
    const nm = /^[A-Za-z][A-Za-z0-9_:.-]*/.exec(body.slice(i));
    if (!nm) { i++; continue; }
    const name = nm[0].toLowerCase();
    i += nm[0].length;
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== '=') continue;   // 字段残缺：跳过这一个，不整体失败
    i++;
    const first = readValue(body, i);
    i = first.i;
    // 字符串拼接 `"17-20 " # jun`：只保留第一段，其余安全消费掉
    for (;;) {
      let j = i;
      while (j < body.length && /\s/.test(body[j])) j++;
      if (body[j] !== '#') break;
      j++;
      const seg = readValue(body, j);
      i = seg.i;
    }
    fields[name] = first.value;
  }

  return buildRecord(type, key, fields);
}

/** 从 url 提取 anthology ID：https://aclanthology.org/2024.acl-long.1/ → 2024.acl-long.1 */
function anthologyIdFromUrl(url) {
  const s = String(url == null ? '' : url).trim();
  const m = /aclanthology\.org\/([^/\s#?]+)\/?/i.exec(s);
  return m ? m[1] : null;
}

function normYear(raw, anthologyId) {
  const m = /(\d{4})/.exec(String(raw == null ? '' : raw));
  if (m) return Number(m[1]);
  if (anthologyId) {
    const a = /^(\d{4})\./.exec(anthologyId);
    if (a) return Number(a[1]);
  }
  return null;
}

/** 月份归一为 '01'..'12'；识别不了就 null（例如 `"17-20 "` 这种页码式拼接） */
function normMonth(raw) {
  const s = collapseWs(raw).toLowerCase().replace(/\.$/, '');
  if (!s) return null;
  if (MONTH_ABBR[s]) return MONTH_ABBR[s];
  if (MONTH_FULL[s]) return MONTH_FULL[s];
  const n = /^(\d{1,2})$/.exec(s);
  if (n) {
    const k = Number(n[1]);
    if (k >= 1 && k <= 12) return String(k).padStart(2, '0');
  }
  return null;
}

/** 只写能证明的精度：有年+月 → YYYY-MM；只有年 → YYYY；否则 null。绝不补日。 */
function publishedDateOf(year, month) {
  if (!Number.isInteger(year) || year <= 0) return null;
  return month ? `${year}-${month}` : String(year);
}

/** 作者切分：BibTeX 用 ` and ` 分隔（作者名内部可以有逗号） */
function splitAuthors(raw) {
  const s = collapseWs(raw);
  if (!s) return [];
  return s.split(/\s+and\s+/i).map((x) => collapseWs(x)).filter(Boolean);
}

function buildRecord(type, key, fields) {
  const url = collapseWs(fields.url) || null;
  const anthologyId = anthologyIdFromUrl(url);
  const year = normYear(fields.year, anthologyId);
  const monthRaw = fields.month == null ? null : collapseWs(fields.month);
  const month = normMonth(monthRaw);
  return {
    key: key || null,
    bibkey: key || null,
    type,
    title: collapseWs(fields.title),
    authors: splitAuthors(fields.author),
    // venue：会议论文取 booktitle，期刊论文取 journal
    venue: collapseWs(fields.booktitle) || collapseWs(fields.journal) || null,
    year,
    month,
    monthRaw,
    publishedDate: publishedDateOf(year, month),
    pages: collapseWs(fields.pages) || null,
    doi: collapseWs(fields.doi) || null,
    url,
    anthologyId,
    abstract: collapseWs(fields.abstract) || null,
    isbn: collapseWs(fields.isbn) || null,
    booktitle: collapseWs(fields.booktitle) || null,
    journal: collapseWs(fields.journal) || null,
    editor: collapseWs(fields.editor) || null,
    publisher: collapseWs(fields.publisher) || null,
    address: collapseWs(fields.address) || null,
    // 全部原始字段（小写名），供 raw 精简落库
    fields,
  };
}

/**
 * 流式 BibTeX 扫描器：按字符维护花括号/圆括号深度，
 * 只把「从 @type{ 到配对右括号」的完整条目交给回调，条目之间的
 * 注释、空行、非条目文本一律忽略。
 */
function createScanner(onEntry) {
  let buf = '';
  let depth = 0;
  let open = '';
  let close = '';
  let inEntry = false;

  function feed(text) {
    const s = String(text == null ? '' : text);
    let i = 0;
    while (i < s.length) {
      if (!inEntry) {
        const m = /@([A-Za-z][A-Za-z0-9_-]*)\s*([{(])/.exec(s.slice(i));
        if (!m) return;
        i += m.index;
        buf = m[0];
        open = m[2];
        close = open === '{' ? '}' : ')';
        depth = 1;
        inEntry = true;
        i += m[0].length;
        continue;
      }
      const ch = s[i++];
      buf += ch;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth <= 0) {
          const raw = buf;
          buf = '';
          inEntry = false;
          onEntry(raw);
        }
      }
    }
  }

  function flush() {
    if (inEntry && buf) {
      const raw = buf;
      buf = '';
      inEntry = false;
      onEntry(raw);
    }
  }

  return { feed, flush, get inEntry() { return inEntry; } };
}

/**
 * 把 BibTeX 文本解析成记录数组（纯函数）。
 * @returns {Array<object>} 记录含 key/type/bibkey/title/authors/venue/year/month/pages/
 *          doi/url/anthologyId/abstract/isbn/publishedDate 等
 */
function parseBibtex(text) {
  const out = [];
  const scanner = createScanner((raw) => {
    const rec = parseEntry(raw);
    if (rec) out.push(rec);
  });
  scanner.feed(text);
  scanner.flush();
  return out;
}

/* ================================================================== *
 * 2. 流式解析文件（.bib 或 .bib.gz）
 * ================================================================== */

/**
 * 流式解析一个 BibTeX 文件，逐条回调，避免 178 MB 驻留内存。
 * @param {string} filePath
 * @param {{gzip?:boolean, limit?:number, onRecord?:Function, collect?:boolean, onProgress?:Function}} [opts]
 *        gzip     省略时按扩展名 .gz 判断
 *        limit    最多解析多少条（0/未给 = 全部）
 *        onRecord 每条记录的回调（流式消费建议用它，此时默认不收集数组）
 *        collect  是否把记录收集进返回值（默认：未提供 onRecord 时为 true）
 * @returns {Promise<{ok:boolean,count:number,records:Array,errors:Array,path:string,gzip:boolean,bytes:number,error:string|null}>}
 */
function parseBibFile(filePath, opts = {}) {
  return new Promise((resolve) => {
    const gzip = opts.gzip !== undefined ? !!opts.gzip : /\.gz$/i.test(String(filePath));
    const limit = Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 0;
    const collect = opts.collect !== undefined ? !!opts.collect : typeof opts.onRecord !== 'function';
    const onRecord = typeof opts.onRecord === 'function' ? opts.onRecord : null;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    const records = [];
    const errors = [];
    let count = 0;
    let bytes = 0;
    let settled = false;
    let stopped = false;

    const handleEntry = (raw) => {
      if (limit && count >= limit) return;
      let rec = null;
      try { rec = parseEntry(raw); } catch (e) { errors.push(`条目解析异常：${e.message}`); return; }
      if (!rec) return;                    // 宏/序言/注释，或无法识别的条目：跳过
      count++;
      if (collect) records.push(rec);
      if (onRecord) {
        try { onRecord(rec); } catch (e) { errors.push(`onRecord 回调异常：${e.message}`); }
      }
      if (onProgress) {
        try { onProgress({ phase: 'parse', count, bytes }); } catch { /* 进度回调不参与成败 */ }
      }
      if (limit && count >= limit) stop();
    };

    const scanner = createScanner(handleEntry);

    const rs = fs.createReadStream(filePath);
    const input = gzip ? rs.pipe(zlib.createGunzip()) : rs;
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    let carry = '';   // 极少数情况下 @type 与 { 被折到两行

    function cleanup() {
      try { rl.close(); } catch {}
      try { rl.removeAllListeners(); } catch {}
      try { input.destroy(); } catch {}
      try { rs.destroy(); } catch {}
    }

    function finish(err) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ok: !err, count, records, errors, path: filePath, gzip, bytes,
        error: err ? String(err.message || err) : null,
      });
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      try { scanner.flush(); } catch {}
      finish(null);
    }

    const onLine = (line) => {
      if (settled) return;
      const s = carry + line;
      carry = '';
      try {
        scanner.feed(s);
      } catch (e) {
        errors.push(`扫描异常：${e.message}`);
        return;
      }
      if (limit && count >= limit) { stop(); return; }
      if (!scanner.inEntry) {
        // 保留可能是「折行的条目开头」的尾巴
        const at = s.lastIndexOf('@');
        if (at >= 0 && !/[{(]/.test(s.slice(at))) carry = s.slice(at);
      }
    };

    rl.on('line', onLine);
    // readline 会把输入流的错误**重新在 Interface 上抛一次**；
    // 不接住这个事件会变成未捕获异常（文件不存在/解压失败时直接崩进程）。
    rl.on('error', (e) => finish(e));
    rl.on('close', () => {
      if (settled) return;
      try { if (carry) scanner.feed(carry); scanner.flush(); } catch (e) { errors.push(`收尾异常：${e.message}`); }
      finish(null);
    });
    rs.on('data', (chunk) => { bytes += chunk.length; });
    rs.on('error', (e) => finish(e));
    input.on('error', (e) => finish(e));
  });
}

/* ================================================================== *
 * 3. 同步状态
 * ================================================================== */

function readState(key) {
  try {
    const row = store.get('SELECT value FROM frontier_sync_state WHERE key = ?', [key]);
    return row ? row.value : null;
  } catch { return null; }
}

function writeState(key, value) {
  try {
    store.run(
      'INSERT INTO frontier_sync_state(key, value, updated_at) VALUES(?,?,?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, value == null ? null : String(value), store.nowIso()],
    );
  } catch { /* 状态写入失败不应让整次同步失败 */ }
}

/* ================================================================== *
 * 4. 下载（流式 + 304）
 * ================================================================== */

/**
 * 下载 ACL 全量 BibTeX 到 DATA_DIR。
 * @param {{force?:boolean, light?:boolean, onProgress?:Function}} [opts]
 * @returns {Promise<{ok:boolean,notModified:boolean,bytes:number,lastModified:string|null,file:string|null,status:number|null,error:string|null}>}
 */
async function download(opts = {}) {
  const force = !!opts.force;
  const light = !!opts.light;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const url = light ? META.urlLight : META.url;
  const file = path.join(DATA_DIR, light ? LIGHT_FILE : FULL_FILE);
  const tmp = file + '.part';
  const ims = force ? null : readState(K_LAST_MODIFIED);

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
  };
  if (ims) headers['If-Modified-Since'] = ims;

  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}

  return await new Promise((resolve) => {
    let settled = false;
    let lastReport = 0;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fail = (msg, status = null) => {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      finish({
        ok: false, notModified: false, bytes: 0, lastModified: ims,
        file: null, status, error: String(msg || '下载失败'),
      });
    };

    const go = (target, redirectsLeft) => {
      let req;
      try {
        const u = new URL(target);
        req = https.get({
          protocol: 'https:',
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          headers,
        }, (res) => {
          const status = res.statusCode;

          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            return go(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
          }

          if (status === 304) {
            res.resume();
            // 服务端说「没变」，但本地文件可能已被清理（换了 DATA_DIR、手工删过）。
            // 这时不能只报 notModified，否则永远拿不到数据：去掉条件头重下一次。
            if (!fs.existsSync(file) && headers['If-Modified-Since']) {
              delete headers['If-Modified-Since'];
              return go(target, 0);
            }
            writeState(K_LAST_DOWNLOAD_AT, store.nowIso());
            return finish({
              ok: true, notModified: true, bytes: 0, lastModified: ims,
              file, status: 304, error: null,
            });
          }

          if (status !== 200) {
            res.resume();
            return fail(`HTTP ${status}`, status);
          }

          const lastModified = res.headers['last-modified'] || null;
          const etag = res.headers.etag || null;
          const total = Number(res.headers['content-length']) || 0;
          let received = 0;

          const ws = fs.createWriteStream(tmp);
          ws.on('error', (e) => { try { res.destroy(); } catch {} fail('写入失败：' + e.message); });
          res.on('error', (e) => fail('下载中断：' + e.message));

          res.on('data', (chunk) => {
            received += chunk.length;
            if (onProgress) {
              const now = Date.now();
              if (now - lastReport > 500 || (total && received >= total)) {
                lastReport = now;
                try { onProgress({ phase: 'download', received, total, url }); } catch {}
              }
            }
          });

          ws.on('finish', () => {
            try { fs.renameSync(tmp, file); } catch (e) { return fail('落盘失败：' + e.message); }
            if (lastModified) writeState(K_LAST_MODIFIED, lastModified);
            if (etag) writeState(K_ETAG, etag);
            writeState(K_FILE, file);
            writeState(K_BYTES, String(received));
            writeState(K_LIGHT, light ? '1' : '0');
            writeState(K_LAST_DOWNLOAD_AT, store.nowIso());
            return finish({
              ok: true, notModified: false, bytes: received, lastModified,
              file, status: 200, error: null,
            });
          });

          res.pipe(ws);
        });
      } catch (e) {
        return fail(e.message);
      }
      // 42 MB 下载是重操作，给足超时；超时后销毁请求并如实返回失败
      req.setTimeout(120000, () => req.destroy(new Error('下载超时（120 秒无数据）')));
      req.on('error', (e) => fail(e.message));
    };

    go(url, 5);
  });
}

/* ================================================================== *
 * 5. 落库（分批 upsert frontier_items）
 * ================================================================== */

const UPSERT_SQL = `
INSERT INTO frontier_items (
  source, source_id, doc_type, title, authors, venue, year, published_date,
  abstract, doi_norm, url, pdf_url, language, subjects, peer_reviewed,
  published_note, raw, first_seen, updated_at, dedup_key
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(dedup_key) DO UPDATE SET
  source = excluded.source,
  source_id = excluded.source_id,
  doc_type = excluded.doc_type,
  title = excluded.title,
  authors = excluded.authors,
  venue = excluded.venue,
  year = excluded.year,
  published_date = excluded.published_date,
  abstract = excluded.abstract,
  doi_norm = excluded.doi_norm,
  url = excluded.url,
  pdf_url = excluded.pdf_url,
  language = excluded.language,
  subjects = excluded.subjects,
  peer_reviewed = excluded.peer_reviewed,
  published_note = excluded.published_note,
  raw = excluded.raw,
  updated_at = excluded.updated_at
`;   // 故意不写 first_seen / matched_paper_id：插入时由本语句给出 first_seen，冲突时两者都保留

/** raw 只存精简条目，不含已在独立列里的 abstract（否则 12.8 万条会翻倍） */
function pruneFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (k === 'abstract') continue;
    const s = collapseWs(v);
    if (!s) continue;
    out[k] = s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  }
  return out;
}

/**
 * 把一条解析记录映射成 frontier_items 的一行（纯函数，便于离线核对）。
 * 取不到 source_id 或标题的返回 null（调用方计为 skipped）。
 */
function recordToRow(rec, nowIso) {
  if (!rec) return null;
  const anthologyId = rec.anthologyId || null;
  const bibkey = rec.bibkey || rec.key || null;
  const sourceId = anthologyId || bibkey;
  const title = collapseWs(rec.title);
  if (!sourceId || !title) return null;

  const doiNorm = N.normalizeDoi(rec.doi);
  const dedupKey = doiNorm
    ? 'doi:' + doiNorm
    : (anthologyId ? 'acid:' + anthologyId : (bibkey ? 'aclbib:' + bibkey : null));
  if (!dedupKey) return null;

  const raw = JSON.stringify({
    type: rec.type || null,
    bibkey,
    fields: pruneFields(rec.fields),
  });

  return {
    source: SOURCE_KEY,
    source_id: sourceId,
    doc_type: docTypeFor(rec.type),
    title,
    authors: JSON.stringify(Array.isArray(rec.authors) ? rec.authors : []),
    venue: rec.venue || null,
    year: Number.isInteger(rec.year) && rec.year > 0 ? rec.year : null,
    published_date: rec.publishedDate || publishedDateOf(rec.year, rec.month),
    abstract: rec.abstract || null,
    doi_norm: doiNorm,
    url: rec.url || null,
    pdf_url: null,                       // BibTeX 不提供 PDF 链接，不推断
    language: null,                      // BibTeX 不提供语种，不猜
    subjects: '[]',                      // ACL 不提供主题词
    peer_reviewed: 1,                    // ACL 主会与 workshop 均为同行评议
    published_note: null,
    raw,
    first_seen: nowIso,                  // 仅新插入时写入
    updated_at: nowIso,
    dedup_key: dedupKey,
  };
}

function rowParams(row) {
  return [
    row.source, row.source_id, row.doc_type, row.title, row.authors, row.venue,
    row.year, row.published_date, row.abstract, row.doi_norm, row.url, row.pdf_url,
    row.language, row.subjects, row.peer_reviewed, row.published_note, row.raw,
    row.first_seen, row.updated_at, row.dedup_key,
  ];
}

/**
 * 分批写入器：每 batchSize 条一个事务提交。
 * store.tx 是同步的，因此这里刻意保持同步——由流式解析的回调逐条喂入。
 */
function createBatchWriter({ batchSize = 500, nowIso } = {}) {
  const size = Math.max(1, Number(batchSize) || 500);
  const now = nowIso || store.nowIso();
  let buf = [];
  const counts = { parsed: 0, inserted: 0, updated: 0, skipped: 0 };

  function classify(keys) {
    const existing = new Set();
    if (keys.length) {
      const ph = keys.map(() => '?').join(',');
      try {
        for (const r of store.all(`SELECT dedup_key FROM frontier_items WHERE dedup_key IN (${ph})`, keys)) {
          existing.add(r.dedup_key);
        }
      } catch { /* 表不存在等情况：按新插入计数 */ }
    }
    const seen = new Set();
    for (const k of keys) {
      if (existing.has(k) || seen.has(k)) counts.updated++;
      else { counts.inserted++; seen.add(k); }
    }
  }

  function flush() {
    if (!buf.length) return;
    const batch = buf;
    buf = [];
    const keys = batch.map((r) => r.dedup_key);
    classify(keys);
    store.tx(() => {
      for (const row of batch) store.run(UPSERT_SQL, rowParams(row));
    });
  }

  function add(rec) {
    counts.parsed++;
    const row = recordToRow(rec, now);
    if (!row) { counts.skipped++; return; }
    buf.push(row);
    if (buf.length >= size) flush();
  }

  return { add, flush, counts };
}

/**
 * 把已解析的记录落库（sync 内部使用；也便于离线测试整条落库链路）。
 * @returns {{parsed:number,inserted:number,updated:number,skipped:number}}
 */
function persistRecords(records, opts = {}) {
  const writer = createBatchWriter({ batchSize: opts.batchSize, nowIso: opts.nowIso });
  for (const rec of records || []) writer.add(rec);
  writer.flush();
  return writer.counts;
}

/* ================================================================== *
 * 6. 完整同步
 * ================================================================== */

/**
 * download → parseBibFile（流式）→ 分批 upsert。
 * @param {{force?:boolean,light?:boolean,limit?:number,onProgress?:Function}} [opts]
 * @returns {Promise<{ok:boolean,notModified:boolean,downloaded:number,parsed:number,inserted:number,updated:number,skipped:number,elapsedMs:number,error:string|null,state:object}>}
 */
async function sync(opts = {}) {
  const { force = false, light = false, limit = 0, onProgress } = opts;
  const t0 = Date.now();

  const emptyCounts = { downloaded: 0, parsed: 0, inserted: 0, updated: 0, skipped: 0 };
  const result = (extra) => ({
    ok: false, notModified: false, ...emptyCounts, elapsedMs: Date.now() - t0,
    error: null, state: null, ...extra,
  });

  const dl = await download({ force, light, onProgress });
  if (!dl.ok || dl.notModified) {
    if (!dl.ok) {
      writeState(K_LAST_ERROR, dl.error);
      return result({ ok: false, error: dl.error, downloaded: 0, state: await status() });
    }
    writeState(K_LAST_SYNC_AT, store.nowIso());
    return result({
      ok: true, notModified: true, downloaded: 0,
      state: await status(),
    });
  }

  const writer = createBatchWriter({ batchSize: 500 });
  try {
    const parsed = await parseBibFile(dl.file, {
      gzip: true,
      limit,
      collect: false,
      onRecord: (rec) => writer.add(rec),
    });
    writer.flush();
    for (const e of parsed.errors.slice(0, 20)) {
      // 解析中的局部异常不使整次同步失败，但如实留痕
      writeState('acl:last_parse_warning', e);
    }
    writeState(K_LAST_SYNC_AT, store.nowIso());
    writeState(K_PARSED, String(writer.counts.parsed));
    writeState(K_INSERTED, String(writer.counts.inserted));
    writeState(K_UPDATED, String(writer.counts.updated));
    writeState(K_SKIPPED, String(writer.counts.skipped));
    writeState(K_LAST_ERROR, '');
    return result({
      ok: parsed.ok,
      notModified: false,
      downloaded: dl.bytes,
      parsed: writer.counts.parsed,
      inserted: writer.counts.inserted,
      updated: writer.counts.updated,
      skipped: writer.counts.skipped,
      error: parsed.ok ? null : parsed.error,
      state: await status(),
    });
  } catch (e) {
    writeState(K_LAST_ERROR, e.message);
    return result({ ok: false, downloaded: dl.bytes, error: `解析/落库失败：${e.message}`, state: await status() });
  }
}

/* ================================================================== *
 * 7. 状态
 * ================================================================== */

async function status() {
  const state = {};
  for (const k of STATE_KEYS) state[k] = readState(k);

  let total = 0;
  let byDocType = [];
  try {
    total = store.get('SELECT COUNT(*) c FROM frontier_items WHERE source = ?', [SOURCE_KEY]).c;
    byDocType = store.all(
      'SELECT doc_type, COUNT(*) c FROM frontier_items WHERE source = ? GROUP BY doc_type ORDER BY c DESC',
      [SOURCE_KEY],
    ).map((r) => ({ doc_type: r.doc_type, count: r.c }));
  } catch { /* 尚未 migrate：视为空库 */ }

  return {
    ok: true,
    source: SOURCE_KEY,
    total,
    byDocType,
    lastModified: state[K_LAST_MODIFIED] || null,
    etag: state[K_ETAG] || null,
    file: state[K_FILE] || null,
    bytes: Number(state[K_BYTES]) || 0,
    light: state[K_LIGHT] === '1',
    lastDownloadAt: state[K_LAST_DOWNLOAD_AT] || null,
    lastSyncAt: state[K_LAST_SYNC_AT] || null,
    lastError: state[K_LAST_ERROR] || null,
    counts: {
      parsed: Number(state[K_PARSED]) || 0,
      inserted: Number(state[K_INSERTED]) || 0,
      updated: Number(state[K_UPDATED]) || 0,
      skipped: Number(state[K_SKIPPED]) || 0,
    },
    state,
  };
}

module.exports = {
  SOURCE_KEY,
  META,
  parseBibtex,
  parseBibFile,
  download,
  sync,
  status,
  // 以下为离线可测的辅助导出，sync 内部复用同一份实现
  parseEntry,
  recordToRow,
  persistRecords,
  docTypeFor,
  anthologyIdFromUrl,
  USER_AGENT,
  FULL_FILE,
  LIGHT_FILE,
};
