'use strict';
/**
 * HTTP 工具：超时、重试、礼貌间隔、内存缓存、结构化结果。
 * 所有外部请求都经过这里，便于统计数据源覆盖与失败状态。
 */
const { getContactEmail, getSettings, getSecret } = require('./config');

// 注意：HTTP 头只能是 Latin-1 字节，任何非 ASCII 字符都会让 fetch 直接抛错，
// 因此 User-Agent 必须保持纯 ASCII。
const UA = () => `LitDesk/1.0 (literature reading desk; mailto:${toAsciiHeader(getContactEmail())})`;

/** 把任意字符串压成可安全放进 HTTP 头的 ASCII */
function toAsciiHeader(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .trim() || 'unknown';
}

const lastCallAt = new Map();      // host -> ts
const cache = new Map();           // key -> {at, data}
// 熔断：遇到 429/连续失败后，一段时间内不再请求该主机，避免整轮采集被限流拖死
const circuit = new Map();         // host -> {until, reason, failures}

function circuitState(host) {
  const c = circuit.get(host);
  if (!c) return null;
  if (Date.now() > c.until) { circuit.delete(host); return null; }
  return c;
}
function tripCircuit(host, ms, reason) {
  const prev = circuit.get(host);
  circuit.set(host, { until: Date.now() + ms, reason, failures: (prev?.failures || 0) + 1 });
}
function circuitReport() {
  const out = [];
  for (const [host, c] of circuit.entries()) {
    if (Date.now() < c.until) out.push({ host, reason: c.reason, resumeInMs: c.until - Date.now() });
  }
  return out;
}
function resetCircuits() { circuit.clear(); }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 每个主机一条串行队列 + 最小间隔。
 * 关键点：并发采集时多个请求会同时通过 politeWait，造成突发被 429。
 * 这里把「排队 → 间隔 → 更新时间戳」放在临界区里，保证同一主机真正串行。
 */
const hostQueue = new Map();   // host -> Promise chain tail
const HOST_GAP_MS = {
  'api.crossref.org': 1300,     // Crossref 对匿名突发限流很敏感
  'api.openalex.org': 1100,
  'api.unpaywall.org': 500,
  'doaj.org': 700,
  'api.semanticscholar.org': 1200,
  /*
   * 前沿技术来源（官方条款公开可查，按规定的最小间隔来）。
   *   arXiv TOU 原文：make no more than one request every three seconds,
   *   and limit requests to a single connection at a time。
   *   这里给 3100ms 留余量；hostQueue 本身已保证「同一主机串行」。
   *   ERIC 规格未规定速率，服务端响应本身约 2.5s。
   */
  'export.arxiv.org': 3100,
  'oaipmh.arxiv.org': 3100,
  'api.ies.ed.gov': 1200,
  'aclanthology.org': 1500,     // 单次可能 12–42MB，避免与其它请求并发
  'raw.githubusercontent.com': 1000,
};
function gapFor(host, minGapMs) {
  const fixed = HOST_GAP_MS[host];
  return fixed != null ? fixed : minGapMs;
}

async function withHostSlot(host, minGapMs, fn) {
  const gap = gapFor(host, minGapMs);
  const prev = hostQueue.get(host) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  hostQueue.set(host, prev.then(() => mine).catch(() => mine));
  await prev.catch(() => {});
  try {
    const wait = (lastCallAt.get(host) || 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    return await fn();
  } finally {
    lastCallAt.set(host, Date.now());
    release();
    if (hostQueue.get(host) === mine) hostQueue.delete(host);
  }
}

function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) { cache.delete(key); return null; }
  return hit.data;
}
function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) cache.delete(k);
  }
}

/**
 * @returns {Promise<{ok:boolean,status:number|null,data:any,error:string|null,ms:number,url:string}>}
 */
async function fetchJson(url, opts = {}) {
  const {
    headers = {}, method = 'GET', body = null,
    timeoutMs = getSettings().requestTimeoutMs,
    retries = 2, minGapMs = 350, cacheTtlMs = 0, cacheKey = null,
  } = opts;

  const key = cacheKey || (method === 'GET' && cacheTtlMs ? 'GET ' + url : null);
  if (key) {
    const hit = cacheGet(key, cacheTtlMs);
    if (hit) return { ...hit, cached: true };
  }

  const host = (() => { try { return new URL(url).host; } catch { return 'unknown'; } })();
  const started = Date.now();
  let lastErr = null;

  const tripped = circuitState(host);
  if (tripped) {
    return {
      ok: false, status: 429, data: null, ms: 0, url, throttled: true,
      error: `数据源 ${host} 已暂停请求（${tripped.reason}），约 ${Math.ceil((tripped.until - Date.now()) / 1000)} 秒后自动恢复`,
    };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await withHostSlot(host, minGapMs, () => fetch(url, {
        method,
        headers: {
          'User-Agent': UA(),
          'Accept': 'application/json',
          ...headers,
        },
        body,
        signal: ctl.signal,
      }));
      clearTimeout(timer);
      const text = await res.text();
      let data = null;
      let parseErr = null;
      if (opts.rawText) {
        // HTML 目录页：只要原始文本，不做 JSON 解析
        data = text;
      } else {
        try { data = text ? JSON.parse(text) : null; } catch (e) { parseErr = e; }
      }

      if (!res.ok) {
        const msg = data && data.message ? JSON.stringify(data.message).slice(0, 240) : '';
        if (res.status === 429) {
          // 尊重 Retry-After；等待时间过长则直接熔断该主机，让本轮采集继续走其他源
          const ra = Number(res.headers.get('retry-after'));
          const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0;
          const hint = /retry in (\d+)/i.exec(msg);
          const hinted = hint ? Number(hint[1]) * 1000 : 0;
          const need = Math.max(waitMs, hinted);
          if (need > 0 && need <= 12000 && attempt < retries) {
            lastErr = `HTTP 429 限流，等待 ${Math.round(need / 1000)} 秒后重试`;
            await sleep(need + 500);
            continue;
          }
          tripCircuit(host, 10 * 60 * 1000, '被数据源限流(HTTP 429)');
          return {
            ok: false, status: 429, data, ms: Date.now() - started, url, throttled: true,
            error: `数据源限流：HTTP 429${msg ? ' — ' + msg : ''}。该源已暂停 10 分钟，其余数据源继续。` +
              (/api key/i.test(msg) ? '（提示：配置 OpenAlex API Key 可避免匿名限流）' : ''),
          };
        }
        if (res.status >= 500 && attempt < retries) {
          lastErr = `HTTP ${res.status}`;
          await sleep(1200 * (attempt + 1));
          continue;
        }
        if (res.status >= 500) tripCircuit(host, 3 * 60 * 1000, `服务端错误 HTTP ${res.status}`);
        return {
          ok: false, status: res.status, data, ms: Date.now() - started, url,
          error: `HTTP ${res.status}${msg ? ': ' + msg : ''}`,
        };
      }
      if (parseErr) {
        const out = { ok: false, status: res.status, data: null, ms: Date.now() - started, url, error: 'JSON 解析失败: ' + parseErr.message };
        return out;
      }
      const out = { ok: true, status: res.status, data, ms: Date.now() - started, url, error: null };
      if (key) cacheSet(key, out);
      return out;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : e.message;
      if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
    }
  }
  return { ok: false, status: null, data: null, ms: Date.now() - started, url, error: lastErr || '未知网络错误' };
}

async function fetchText(url, opts = {}) {
  // 必须走 rawText：否则 fetchJson 会把 HTML 当成 JSON 解析失败
  return fetchJson(url, {
    ...opts,
    rawText: true,
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml,text/plain,*/*', ...(opts.headers || {}) },
  });
}

function clearCache() { cache.clear(); }

function hostGaps() { return { ...HOST_GAP_MS }; }

module.exports = {
  fetchJson, fetchText, cacheGet, cacheSet, clearCache, sleep, UA, toAsciiHeader,
  circuitState, circuitReport, resetCircuits, hostGaps,
};
