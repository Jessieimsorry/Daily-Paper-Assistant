'use strict';
// 首页分类与细分主题分开；一篇可命中多个分类，列表始终以 paper.id 去重。
const store = require('./store');
const BUILTIN_CATEGORIES = [
  { id: 'sla', name: '第二语言习得', color: 'sage', topics: ['sla'] },
  { id: 'technology', name: '计算机与教育技术', color: 'blue', topics: ['edtech'] },
  { id: 'linguistics', name: '语言学与汉语语言学研究', color: 'purple', topics: ['linguistics', 'general-linguistics', 'chinese', 'pragmatics'] },
  { id: 'teaching', name: '语言教学研究', color: 'ochre', topics: ['language-teaching'] },
  { id: 'chinese-education', name: '国际中文教育', color: 'clay', topics: ['chinese-education'] },
];
const NEW_TOPICS = [
  { slug: 'general-linguistics', name_zh: '通用语言学研究', name_en: 'General linguistics', keywords_zh: ['语言类型学', '句法语义接口', '社会语言学', '语音加工'], keywords_en: ['linguistic typology', 'syntax semantics interface', 'sociolinguistics', 'phonological processing'] },
  { slug: 'language-teaching', name_zh: '语言教学研究', name_en: 'Language teaching', keywords_zh: ['语言教学干预', '语言教师教育', '语言课程设计', '语言测评'], keywords_en: ['language teaching intervention', 'language teacher education', 'language curriculum design', 'language assessment'] },
  { slug: 'chinese-education', name_zh: '国际中文教育', name_en: 'Chinese language education', keywords_zh: ['国际中文教育', '汉语作为第二语言', '对外汉语教学', '海外中文教育'], keywords_en: ['Chinese as a second language', 'Chinese as a foreign language', 'Chinese language education', 'Chinese immersion education'] },
];
function ids(paper, evidence) {
  const rank = require('./rank');
  const hit = evidence || rank.topicHits(paper, require('./discover').listTopics(true)).hits;
  return getCategories().filter(c => c.topics.some(t => Number(hit[t]) > 0)).map(c => c.id);
}
function seed() {
  // 一次性增加，不在重启时恢复用户已经删除的主题，不覆盖原有检索词。
  const reader = require('./reader');
  if (reader.getState('categories-v1', false)) return;
  for (const t of NEW_TOPICS) store.run(`INSERT OR IGNORE INTO topics
    (slug,name_zh,name_en,keywords_zh,keywords_en,enabled,sort_order,builtin) VALUES(?,?,?,?,?,1,?,1)`,
    [t.slug,t.name_zh,t.name_en,JSON.stringify(t.keywords_zh),JSON.stringify(t.keywords_en),80 + NEW_TOPICS.indexOf(t)]);
  const tech = store.get("SELECT * FROM topics WHERE slug='edtech'");
  if (tech) {
    const zh = [...new Set([...store.parseJson(tech.keywords_zh, []),'教育技术','人机交互','学习分析'])];
    const en = [...new Set([...store.parseJson(tech.keywords_en, []),'educational technology','human computer interaction','learning analytics','large language model evaluation'])];
    store.run('UPDATE topics SET keywords_zh=?, keywords_en=? WHERE id=?',[JSON.stringify(zh),JSON.stringify(en),tech.id]);
  }
  reader.setState('categories-v1', true);
}
function diverseSelect(candidates, limit, { languageBalance = true } = {}) {
  const remaining = [...new Map(candidates.map(c => [(c.paper || c).id, c])).values()];
  const chosen = [], counts = Object.fromEntries(getCategories().map(c => [c.id, 0]));
  const paperOf = c => c.paper || c;
  const catOf = c => c.category_ids || ids(paperOf(c), c.scored?.detail?.topicHits);
  // 每天新发现优先；补充近期尚未推荐的文献时仍做多方向分配。
  for (const tier of ['new','catchup','shown']) {
    const pool = remaining.filter(c => (c.kind || 'catchup') === tier);
    const langCounts = { zh: 0, en: 0 };
    const add = c => {
      chosen.push(c); for (const cat of catOf(c)) counts[cat]++;
      const lang = paperOf(c).language; langCounts[lang] = (langCounts[lang] || 0) + 1;
    };
    // 给当前有候选的方向留少量探索位置，剩余名额仍依相关性灵活分配。
    for (let round=0; round<Math.min(3,Math.floor(limit/10)); round++) {
      for (const cat of getCategories()) {
        if (chosen.length >= limit || counts[cat.id] > round) continue;
        const i = pool.findIndex(c => catOf(c).includes(cat.id));
        if (i>=0) add(pool.splice(i,1)[0]);
      }
    }
    while (pool.length && chosen.length < limit) {
      let best = 0, bestValue = -Infinity;
      pool.forEach((c,i) => {
        const cs = catOf(c);
        const coverage = cs.length ? Math.min(...cs.map(k => counts[k] || 0)) : chosen.length;
        const lang = paperOf(c).language;
        const languageBonus = languageBalance && !langCounts[lang] ? 0.10 : 0;
        const value = Number(c.sort_score || c.score || 0) - 0.035 * coverage + languageBonus;
        if (value > bestValue) { bestValue = value; best = i; }
      });
      add(pool.splice(best, 1)[0]);
    }
  }
  return chosen;
}
function getCategories(){try{return require('./customize').categories();}catch{return BUILTIN_CATEGORIES;}}
module.exports = { get CATEGORIES(){return getCategories();}, BUILTIN_CATEGORIES, NEW_TOPICS, ids, seed, diverseSelect };
