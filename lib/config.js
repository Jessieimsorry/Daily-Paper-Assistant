'use strict';
/**
 * 全局配置与密钥管理。
 * 密钥只从环境变量或 data/secrets.json 读取；绝不写入代码、数据库或日志。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// 允许用 LITDESK_DATA_DIR 把全部运行数据（数据库/密钥/上传/日志）指向别处，
// 用于自动化自检，避免污染正式数据。
const DATA_DIR = process.env.LITDESK_DATA_DIR
  ? path.resolve(process.env.LITDESK_DATA_DIR)
  : require('./platform').data();
const CATALOG_DIR = path.join(ROOT, 'catalogs');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');

for (const d of [DATA_DIR, CATALOG_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

/** 默认设置：全部可在界面里修改。 */
const DEFAULT_SETTINGS = {
  // 每日简报
  briefHour: 8,                  // 北京时间几点更新
  briefMinute: 0,
  timezone: 'Asia/Shanghai',
  briefSize: 50,                 // 每天推荐目标（5–100），不足时如实显示
  /*
   * broadTechnology：通用技术与教育研究是否可作为「教育技术研究」主题的证据。
   *
   * 语义（本次明确）：
   *   true  —— 研究对象确实是「教育/学习」的通用教育技术论文（如 STEM 教育中的 AI、
   *            药学虚拟仿真教学）也算教育技术主题，供借鉴；
   *   false —— 只有带语言教育领域证据的（AI 辅助语言学习、TTS 用于二语测评）才算。
   *
   * 无论取何值，**研究对象根本不是教育**的论文（医学、职业健康、临床等）都不能
   * 冒充教育技术核心主题 —— 那由 lib/rank.js 的 researchObject() 判定，与本开关无关。
   */
  broadTechnology: true,         // 通用技术与教育研究可供借鉴（研究对象须确为教育/学习）
  briefLookbackDays: 30,         // 采集新论文的时间窗口（天）
  minCandidatesForRetry: 5,      // 合格候选不足多少篇时，下次启动再补采
  minRetryIntervalMs: 60000,     // 更新失败后的最小重试间隔（避免反复触发）
  languageBalance: true,         // 保证中文、英文论文都保持可见
  // 前沿技术每日精选（独立于主简报的 8 篇；单独建表，不计入期刊合格数）
  frontierDaily: true,           // 每日更新时是否顺带刷新前沿技术精选
  frontierSize: 3,               // 每天挑几篇（2–3）
  frontierLookbackDays: 30,
  // 采集
  contactEmail: '',              // 建议填写，Crossref/OpenAlex 会用礼貌池
  openAlexApiKey: '',            // 可选
  ieeeApiKey: '',                // 可选：IEEE Xplore Metadata API（无密钥时工作台不发起任何请求）
  requestTimeoutMs: 25000,
  maxPerTopicQuery: 60,          // 每个检索式最多取多少条
  // 期刊核验策略
  strictJournalFilter: true,     // true=未核验期刊的论文只进“待核验候选”
  acceptCssoExtended: false,     // CSSCI 扩展版是否算来源期刊（默认不算）
  catalogYearNote: '',           // 目录年份备注
  // AI（任何 OpenAI 兼容 /chat/completions 端点都可用：DeepSeek、自建 vLLM/Ollama、其他厂商）
  aiProvider: 'openai-compatible',
  aiBaseUrl: 'https://api.deepseek.com',
  aiModel: 'deepseek-chat',
  aiKeyEnvVar: 'DEEPSEEK_API_KEY',   // 允许改用其他环境变量名
  aiTemperature: 0.3,
  // 推理模型（如 deepseek-flash / deepseek-reasoner）会先消耗思维链 token，
  // 预算太小会导致正式回答为空，因此默认给足。
  aiMaxTokens: 6000,
  // 界面
  uiLanguage: 'zh-CN',
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), {encoding:'utf8',mode:0o600});
  fs.renameSync(tmp, file);
}

let _settings = null;
function getSettings() {
  if (_settings === null) {
    _settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
  }
  return { ..._settings };
}

// 真正需要当作「密钥」保存的字段白名单。
// 不能简单地用「名字里含 key」判断——aiKeyEnvVar 是「用哪个环境变量名」的普通配置，
// 早期版本把它也当成密钥写进 secrets.json，导致这个设置永远改不掉。
const SECRET_FIELDS = new Set(['deepseekApiKey', 'openAlexApiKey', 'crossrefToken', 'ieeeApiKey']);

function isSecretField(k) {
  return SECRET_FIELDS.has(k);
}

function updateSettings(patch) {
  const cur = getSettings();
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (isSecretField(k)) {
      // 密钥类字段走 secrets.json，不落 settings.json
      setSecret(k, v);
      continue;
    }
    if (k === "briefSize") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error("每天推荐数量必须是数字");
      next[k] = Math.max(5, Math.min(100, Math.round(n)));
    } else next[k] = v;
  }
  _settings = next;
  const persisted = { ...next };
  // 兼容旧配置：清理前先转存密钥，避免普通设置保存导致旧密钥丢失。
  for (const k of SECRET_FIELDS) {
    if (cur[k] && !readJson(SECRETS_FILE, {})[k]) setSecret(k, cur[k]);
  }
  // 把仍存在 settings.json 里的密钥字段清掉（只清真正的密钥字段）
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (isSecretField(k)) delete persisted[k];
  }
  writeJsonAtomic(SETTINGS_FILE, persisted);
  return getSettings();
}

/**
 * 密钥读取顺序：环境变量 > data/secrets.json > settings.json（只读兼容）
 */
const ENV_KEYS = {
  deepseekApiKey: ['DEEPSEEK_API_KEY', 'LITDESK_AI_KEY'],
  openAlexApiKey: ['OPENALEX_API_KEY', 'LITDESK_OPENALEX_KEY'],
  crossrefToken: ['CROSSREF_TOKEN'],
};

function getSecret(name) {
  for (const envName of ENV_KEYS[name] || []) {
    const v = process.env[envName];
    if (v && String(v).trim()) return String(v).trim();
  }
  const secrets = readJson(SECRETS_FILE, {});
  const stored = secrets[name];
  if (stored && String(stored).trim()) return String(stored).trim();
  const legacy = readJson(SETTINGS_FILE, {})[name];
  if (legacy && String(legacy).trim()) return String(legacy).trim();
  return '';
}

function setSecret(name, value) {
  const secrets = readJson(SECRETS_FILE, {});
  const v = String(value == null ? '' : value).trim();
  if (!v) delete secrets[name];
  else secrets[name] = v;
  writeJsonAtomic(SECRETS_FILE, secrets);
  try {
    fs.chmodSync(SECRETS_FILE, 0o600);
  } catch {}
  return v;
}

function secretSource(name) {
  for (const envName of ENV_KEYS[name] || []) {
    if (process.env[envName] && String(process.env[envName]).trim()) return 'env:' + envName;
  }
  const secrets = readJson(SECRETS_FILE, {});
  if (secrets[name]) return 'data/secrets.json';
  return '未配置';
}

/** 对外输出用：只显示掩码 */
function maskSecret(v) {
  if (!v) return '';
  const s = String(v);
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

/** 给用户的运行态配置快照（不含任何明文密钥） */
function publicConfig() {
  const s = getSettings();
  const aiKey = getSecret('deepseekApiKey');
  const oaKey = getSecret('openAlexApiKey');
  return {
    ...Object.fromEntries(Object.entries(s).filter(([k])=>!SECRET_FIELDS.has(k))),
    aiKeyConfigured: Boolean(aiKey),
    aiKeyMasked: aiKey ? '已配置（隐藏）' : '',
    aiKeySource: secretSource('deepseekApiKey'),
    openAlexKeyConfigured: Boolean(oaKey),
    aiProviderAutoDetected: detectAiProvider(),
    dataDir: DATA_DIR,
    catalogDir: CATALOG_DIR,
  };
}

/**
 * 如果用户没配 DeepSeek key，但 DSH 运行时提供了 OpenAI 兼容端点，
 * 允许自动借用（仅当存在可用 key 时）。
 */
function detectAiProvider() {
  if (getSecret('deepseekApiKey')) return 'deepseek(已配置密钥)';
  if (process.env.OPENAI_API_KEY) return 'openai-compatible(借用 OPENAI_API_KEY)';
  return '未配置';
}

function getContactEmail() {
  const s = getSettings();
  if (s.contactEmail) return s.contactEmail;
  if (process.env.LITDESK_CONTACT_EMAIL) return process.env.LITDESK_CONTACT_EMAIL;
  return 'litdesk-local@example.invalid';
}

module.exports = {
  SECRET_FIELDS, isSecretField,
  ROOT, DATA_DIR, CATALOG_DIR, UPLOAD_DIR, PUBLIC_DIR,
  SETTINGS_FILE, SECRETS_FILE, DEFAULT_SETTINGS,
  getSettings, updateSettings, getSecret, setSecret, secretSource, maskSecret,
  publicConfig, getContactEmail, readJson, writeJsonAtomic, detectAiProvider,
};
