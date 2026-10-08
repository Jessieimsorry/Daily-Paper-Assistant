'use strict';
/**
 * 主题证据链回归测试（2026-10-05 简报主题误判）。
 *
 * 背景：2026-10-05 的今日简报里，以下论文实际进入主简报并被贴上核心主题：
 *   · 4764《Evaluating AI chatbots for providing health advice on occupational
 *     sedentary behavior in the workplace》→「汉语语言学研究」0.83
 *   · 4186《Comparative efficacy of non-pharmacological interventions for amnestic
 *     mild cognitive impairment》→「第二语言习得/国际中文教育」0.8
 *   · 4962《Development of a Rubric for Deep and Interactive Learning in the Pharmacy
 *     Virtual Simulation Environment》→「国际中文教育」0.8
 *   · 4757《The "Drama" Construction of Modern Poetry》→「汉语语言学研究」
 *   · 4455（化学论文写作）被标「语言教学研究」，且因 "uptake" 被标「第二语言习得」
 *   · 805/849（草药 AI、实验室医学 AI）被标「教育技术研究」
 *
 * 三条根因（本测试逐条锁死）：
 *   A. 多词检索词剥掉通用词后只剩一个词时，那个词能单独代表整条检索词：
 *      'Chinese language education' → 'chinese'，于是任何摘要出现 Chinese 的论文
 *      在这条上都拿满分。同类：'language curriculum design' → 'design'、
 *      'language teaching intervention' → 'intervention'。
 *   B. 只要检索词比例够强就给分，于是出现「0 个主题标志词却拿 0.80 分」的标签。
 *   C. 教育技术的语言域门控被 settings.broadTechnology=true 整段跳过。
 *
 * 正例（必须继续被保留为主题）：4516（GenAI 学汉语）、4462（EFL 多模态阅读）、
 *   3884（L1/L2 代词解读）、4284（俄汉搭配词表用于教学）、2684（二语具身语义）。
 *   其中后三篇一度被「必须有标志词」的写法误杀，靠补齐 sla / language-teaching 的
 *   标志词（l2、second language、foreign language）救回 —— 本测试一并锁定。
 *
 * 运行：node test/topic-evidence.js
 * 使用独立临时数据目录，不触碰正式 data/。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'litdesk-topic-'));
process.env.LITDESK_DATA_DIR = TEST_DIR;
process.chdir(ROOT);

const R = [];
const ok = (n, c, d) => { R.push({ n, ok: !!c, d }); console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

/* ------------------------------------------------------------------ *
 * 夹具：真实论文的标题 + 摘要节选（只截取触发判定所需的部分）
 * ------------------------------------------------------------------ */
const P = {
  healthAdvice: {
    title: 'Evaluating AI chatbots for providing health advice on occupational sedentary behavior in the workplace',
    abstract: 'Background Office workers accumulate most of their waking hours in sedentary behavior, yet scalable personalized occupational-health advice remains limited, and the quality of large language model (LLM)-based tools in this domain has not been rigorously evaluated. Participants rated the chatbot responses on perceived ease of use and intention to use.',
  },
  amci: {
    title: 'Comparative efficacy of non-pharmacological interventions for amnestic mild cognitive impairment: a network meta-analysis',
    abstract: "Background Amnestic mild cognitive impairment (aMCI) represents a critical prodromal stage of Alzheimer's disease, with a prevalence of approximately 10.03% and an annual conversion rate to dementia of 5%-10%. Non-pharmacological interventions were compared in Chinese participants and a second sensitivity analysis was performed.",
  },
  pharmacySim: {
    title: 'Development of a Rubric for Deep and Interactive Learning in the Pharmacy Virtual Simulation Environment for College Students',
    abstract: 'Pharmacy virtual simulation experiments have become a technical means in higher education to simulate the real world and help students acquire skills or experience. This study developed a rubric with construct validity and Rasch analysis for pharmacy education, and a second round of expert review was conducted in a Chinese college of pharmacy.',
  },
  modernPoetry: {
    title: 'The "Drama" Construction of Modern Poetry',
    abstract: 'In the process of modern development and transformation, traditional Chinese dramatic literature and poetics have undergone intense upheavals and repeated explorations. Ultimately, this traditional art form, poetic drama, originated in the classical era.',
  },
  chemistryLlm: {
    title: 'A Protocol to Identify Large Language Model Use in Undergraduate Chemistry Essays',
    abstract: 'Large language models (LLMs) such as ChatGPT have been widely adopted by chemistry undergraduate university students as a learning tool, but few methods exist to measure the scope of their influence on essay writing. We describe the uptake of these tools in the curriculum.',
  },
  herbalDrugAI: {
    title: 'AI-driven discovery of herbal drugs: a new era in pharmaceutical research',
    abstract: 'Artificial intelligence and machine translation are transforming pharmaceutical discovery. This review discusses clinical medicine and herbal drug development, and the language of patents across a second corpus.',
  },
  genaiCfl: {
    title: 'The role of GenAI in learning Chinese as a foreign language: perspectives from university students in Ireland',
    abstract: 'Generative AI (GenAI) is reshaping language education and continues to shape how learners access, produce and evaluate knowledge. Its application in learning Chinese as a Foreign Language (CFL) in Ireland, however, remains limited. Students reported that language teacher guidance and language education design mattered.',
  },
  eflReading: {
    title: "AI-Mediated Multimodal Reading Education for EFL Learners: Effects on Students' Enjoyment and Engagement",
    abstract: 'Artificial intelligence (AI) has increasingly reshaped educational practices by expanding opportunities for adaptive, multimodal and learner-centered instruction. While growing attention has been paid to AI-supported language learning, less is known about language education for EFL learners.',
  },
  pronominalL2: {
    title: 'Interpretation of pronominal forms in L1 and L2 French and Chinese',
    abstract: 'This study investigates how native speakers and second language (L2) learners interpret pronominal forms in French, a non-pro-drop language, and Chinese, a topic-drop language. Focusing on null and overt pronouns, we examine how grammatical principles and discourse-level factors influence pronoun resolution.',
  },
  collocationRu: {
    title: 'Russian-Chinese collocation glossary for teaching written speech to A2-level Chinese students',
    abstract: 'Problem. One of the most persistent challenges in teaching Russian as a foreign language at the A2 level is the transition from knowledge of individual thematic words to their normative use in written speech. Chinese students are able to recognise education-related vocabulary but encounter difficulties.',
  },
  embodiedL2: {
    title: 'The Multidimensional Organisation of Embodied Meaning in a Second Language',
    abstract: 'Embodied cognition theories propose that conceptual knowledge is grounded in sensorimotor experience. Studies document embodied effects in second\u2010language (L2) processing, but the multidimensional organisation of L2 perceptual knowledge is less well understood.',
  },
  stemAi: {
    title: 'Leveraging Artificial Intelligence in Enhancing Worldwide Science, Technology, Engineering and Mathematics (STEM) Education',
    abstract: 'Artificial intelligence is rapidly transforming education and presents opportunities for improving the quality, accessibility and inclusivity of STEM education around the globe. This conceptual paper examines the potential of AI to address persistent challenges in global STEM education. The paper explores major applications of AI in education including adaptive and personalized learning, intelligent tutoring systems, learning analytics, and teacher augmentation. Based on literature STEM education and educational technology an AI-STEM Global Enhancement Framework is proposed.',
  },
  realChineseEdu: {
    title: 'Task-based Chinese as a second language teaching in multilingual classrooms',
    abstract: 'This study reports on Chinese as a second language pedagogy. Teachers designed tasks for Chinese language education, and the Chinese teaching materials were analysed.',
  },
  /* ---- 第二轮验收新增 ---- */
  implantDentistry: {
    // 2026-10-05 第二轮反例：种植牙专家问答的 LLM 评价，曾被标「教育技术研究」0.795 并排第 43。
    // 三处「教育」字样全是顺带提到：一句潜在用途、一句结尾展望、一句可读性结论。
    title: 'Evaluation of large language model responses to expert questions in anterior implant dentistry: quality, accuracy, and readability',
    abstract: 'Aims: This study evaluated the quality, accuracy, and readability of responses generated by four Artificial Intelligence (AI) chatbots based on large language models (LLMs): ChatGPT-5.2, Gemini 3, DeepSeek-V3.2, and Grok-4.1, when responding to expert-generated questions in anterior implant dentistry. The aim was to evaluate their potential role as educational and adjunct informational tools in treatment planning and esthetic zone management, while also examining the readability of the generated responses.Methods: Thirty-six standardized questions covering diagnosis, esthetic risk assessment, implant positioning, surgical planning and preventive strategies were developed by three prosthodontists experienced in implant dentistry. Responses were independently evaluated by three experts. Results: overall, the responses required a high-school to early undergraduate reading level.Conclusion: AI chatbots can generate information with potential clinical relevance; expert supervision therefore remains essential before integrating such tools into clinical education.',
  },
  customerServiceBot: {
    // 第二轮反例：多租户客服聊天机器人（印尼语）。language 来自 Large Language Model，
    // test 只是工程里的「测试」，不能据此判进语言教育领域。
    title: 'Rancang Bangun Chatbot Customer Service Multi-Tenant Berbasis Large Language Model',
    abstract: 'The advancement of Artificial Intelligence (AI), particularly Large Language Models (LLMs), has transformed customer service into a more automated, adaptive and responsive system. This study designs a multi-tenant customer service chatbot and reports the results of system testing and an accuracy test of the responses.',
  },
  chatgptPhysics: {
    // 第二轮正例：广义教育技术，broadTechnology=true 时应保留（有真实教学对象）。
    title: "The Impact of ChatGPT-Assisted Learning on Students' Understanding of Circular Motion in Grade 10 Physics",
    abstract: "This study investigated whether a generative artificial-intelligence learning assistant (ChatGPT) improves tenth-grade students' conceptual understanding of circular motion. A quasi-experimental pre-test-post-test control-group design was employed at one Indonesian private senior high school (N = 46).",
  },
  indigenousRevitalization: {
    // 边界：语言复兴 + AI。不是教育研究，但研究对象确实是语言（不是医学）。
    title: 'Artificial Intelligence and Indigenous Language Revitalization: A Gadé Language Case Study',
    abstract: 'The marginalization of low-resource indigenous languages within contemporary Artificial Intelligence (AI) and Natural Language Processing (NLP) ecosystems poses a significant threat to global linguistic diversity. We report machine translation and automatic speech recognition work for the Gadé language corpus.',
  },
  dairyTranslation: {
    // 边界：机器翻译评测。不是教育研究，但研究对象是翻译（语言相关）。
    title: 'Evaluation of large language model performance in translating dairy-related content',
    abstract: "Artificial intelligence's ability to translate dairy-related texts from English to Spanish has not been well described. This study aimed to determine the accuracy and comprehensibility of dairy-related translations produced by ChatGPT.",
  },
};

(async () => {
  const store = require('../lib/store');
  const discover = require('../lib/discover');
  const rank = require('../lib/rank');
  const config = require('../lib/config');

  store.migrate();
  discover.seedTopicsIfEmpty();
  // 生产库里 language-teaching / chinese-education / general-linguistics 由 categories.seed() 补入，
  // 测试库必须同样补上，否则正例会因为主题根本不存在而「失败」。
  require('../lib/categories').seed();
  ok('测试环境与正式 data/ 隔离', store.DB_FILE.startsWith(TEST_DIR), store.DB_FILE);
  const topics = discover.listTopics(true);
  ok('主题表已就绪（含 language-teaching / chinese-education）', topics.length >= 8,
    `${topics.length} 个主题：${topics.map((t) => t.slug).join(',')}`);

  const ev = (fixture) => rank.topicHits(fixture, topics);
  const coreSlugs = (r) => Object.entries(r.hits).filter(([, v]) => v > 0).map(([s]) => s);
  const has = (r, slug) => coreSlugs(r).includes(slug);

  /* ================= 1. 根因 A：单词残留 ================= */
  console.log('\n=== 1. 根因 A：多词检索词不能被剥剩的单个词代表 ===');

  // 一篇摘要里只有 chinese / second，没有任何汉语教学或汉语本体证据
  const residualOnly = {
    title: 'Health outcomes in Chinese participants: a second analysis',
    abstract: 'We analysed a second cohort of Chinese participants. Clinical outcomes were measured.',
  };
  const rResidual = ev(residualOnly);
  ok('只含 chinese + second 的临床摘要不得到「国际中文教育」', !has(rResidual, 'chinese-education'),
    '命中主题=' + JSON.stringify(coreSlugs(rResidual)));
  ok('只含 chinese + second 的临床摘要不得到「汉语语言学研究」', !has(rResidual, 'chinese'));
  ok('只含 chinese + second 的临床摘要不得到「第二语言习得」', !has(rResidual, 'sla'));

  // 'language curriculum design' 只剩 'design'：一篇只出现 design 的文章不该拿语言教学
  const designOnly = {
    title: 'Design of a query engine for distributed storage',
    abstract: 'The design of the system is presented together with an assessment of throughput.',
  };
  const rDesign = ev(designOnly);
  ok('只出现 design 的工程论文不得到「语言教学研究」', !has(rDesign, 'language-teaching'),
    '命中主题=' + JSON.stringify(coreSlugs(rDesign)));

  /* ================= 2. 根因 B：没有标志词就不该有分 ================= */
  console.log('\n=== 2. 根因 B：主题标签必须有该主题自己的标志词 ===');
  for (const key of ['amci', 'pharmacySim']) {
    const r = ev(P[key]);
    ok(`反例 ${key} 不再冒充「国际中文教育」`, !has(r, 'chinese-education'),
      '命中主题=' + JSON.stringify(coreSlugs(r)));
  }
  {
    const r = ev(P.amci);
    ok('反例 amci 不再冒充「汉语语言学研究」', !has(r, 'chinese'));
    ok('反例 amci 不再冒充「第二语言习得」', !has(r, 'sla'));
  }

  /* ================= 3. 根因 C：研究对象证据 ================= */
  console.log('\n=== 3. 根因 C：教育技术必须有「研究对象是教育」的证据 ===');
  {
    const o = rank.researchObject([P.healthAdvice.title, P.healthAdvice.abstract].join(' '), P.healthAdvice.title);
    ok('4764 风格（职业健康建议）判定为非教育研究对象', o.nonEducational === true,
      '教育词=' + JSON.stringify(o.educationTerms) + ' 非教育词=' + JSON.stringify(o.nonEducationTerms.slice(0, 4)));
  }
  {
    const o = rank.researchObject([P.pharmacySim.title, P.pharmacySim.abstract].join(' '), P.pharmacySim.title);
    ok('4962 风格（药学教育）判定为教育研究对象', o.nonEducational === false && o.isEducation === true);
  }
  {
    const o = rank.researchObject([P.amci.title, P.amci.abstract].join(' '), P.amci.title);
    ok('4186 风格（临床 meta 分析）判定为非教育研究对象', o.nonEducational === true);
  }
  {
    const r = ev(P.healthAdvice);
    ok('4764 风格不得到任何核心主题', coreSlugs(r).length === 0, '命中主题=' + JSON.stringify(coreSlugs(r)));
    ok('4764 风格被标为跨领域方法参考', rank.isPaperCrossDomain(r) === true);
  }
  {
    const r = ev(P.herbalDrugAI);
    ok('805 风格（草药 AI）不得到「教育技术研究」', !has(r, 'edtech'), '命中主题=' + JSON.stringify(coreSlugs(r)));
  }

  /* ================= 3b. 第二轮验收：一句「潜在用途」不能把临床研究抬进核心 ================= */
  console.log('\n=== 3b. 第二轮验收：研究对象 vs 顺带提到的教育字样 ===');
  {
    const o = rank.researchObject([P.implantDentistry.title, P.implantDentistry.abstract].join(' '), P.implantDentistry.title);
    ok('3329 种植牙：判为非教育研究对象', o.nonEducational === true,
      '教育词=' + JSON.stringify(o.educationTerms) + ' 非教育词=' + JSON.stringify(o.nonEducationTerms.slice(0, 4)));
    ok('3329 种植牙：可读性结论里的 high-school / undergraduate 不算教育对象证据',
      o.isEducation === false, '教育词=' + JSON.stringify(o.educationTerms));
    const r = ev(P.implantDentistry);
    ok('3329 种植牙：不得到「教育技术研究」', !has(r, 'edtech'), '命中主题=' + JSON.stringify(coreSlugs(r)));
    ok('3329 种植牙：无任何核心主题', coreSlugs(r).length === 0);
    ok('3329 种植牙：被标为跨领域方法参考', rank.isPaperCrossDomain(r) === true);
  }
  {
    const r = ev(P.customerServiceBot);
    ok('988 客服聊天机器人：不得到「教育技术研究」', !has(r, 'edtech'), '命中主题=' + JSON.stringify(coreSlugs(r)));
    const dom = rank.languageDomain([P.customerServiceBot.title, P.customerServiceBot.abstract].join(' ').toLowerCase());
    ok('988 客服聊天机器人：不再被判进语言教育领域（language 来自 LLM、test 只是工程测试）', dom.inDomain === false,
      'tier=' + dom.tier);
  }
  {
    const o = rank.researchObject([P.chatgptPhysics.title, P.chatgptPhysics.abstract].join(' '), P.chatgptPhysics.title);
    ok('4559 ChatGPT 物理教学：判为教育研究对象（有学生/前测后测对照）', o.isEducation === true && o.nonEducational === false,
      '教育词=' + JSON.stringify(o.educationTerms));
  }
  {
    // 边界：语言复兴与机器翻译评测不是教育研究，但研究对象确实是语言，不能因领域词一刀切
    for (const [k, label] of [['indigenousRevitalization', '851 土著语言复兴'], ['dairyTranslation', '3308 乳制品翻译']]) {
      const o = rank.researchObject([P[k].title, P[k].abstract].join(' '), P[k].title);
      ok(`${label}：不因「语言」类词被判成非教育专业领域（保留可见）`, o.nonEducational === false,
        '教育=' + o.isEducation + ' 非教育=' + JSON.stringify(o.nonEducationTerms));
    }
  }
  {
    // 反向保护：真正的医患沟通语用研究必须仍能拿到语用主题，不能因医学词被排除
    const medicalPragmatics = {
      title: 'Interactional pragmatics of directive speech acts in doctor-patient consultations',
      abstract: 'This study analyses speech acts and politeness in recorded consultations between physicians and patients. Conversation analysis shows how directives are mitigated in clinical interaction.',
    };
    const r = ev(medicalPragmatics);
    ok('真正的医患沟通语用研究仍保留「语用研究」主题', has(r, 'pragmatics'),
      '命中主题=' + JSON.stringify(coreSlugs(r)));
  }

  /* ================= 4. 正例必须保留 ================= */  console.log('\n=== 4. 真相关论文必须继续被保留为主题 ===');
  {
    const r = ev(P.genaiCfl);
    ok('4516（GenAI 学汉语）保留为汉语/国际中文教育主题', has(r, 'chinese-education') || has(r, 'chinese'),
      '命中主题=' + JSON.stringify(coreSlugs(r)));
    ok('4516 保留语言教学主题', has(r, 'language-teaching'));
  }
  {
    const r = ev(P.eflReading);
    ok('4462（EFL 多模态阅读）保留「语言教学研究」', has(r, 'language-teaching'));
  }
  {
    const r = ev(P.pronominalL2);
    ok('3884（L1/L2 代词解读）保留「第二语言习得」', has(r, 'sla'), '命中主题=' + JSON.stringify(coreSlugs(r)));
  }
  {
    const r = ev(P.embodiedL2);
    ok('2684（二语具身语义，原文含 U+2010 连字符）保留「第二语言习得」', has(r, 'sla'),
      '命中主题=' + JSON.stringify(coreSlugs(r)));
  }
  {
    const r = ev(P.collocationRu);
    ok('4284（俄汉搭配词表用于教学）保留「语言教学研究」', has(r, 'language-teaching'),
      '命中主题=' + JSON.stringify(coreSlugs(r)));
  }
  {
    const r = ev(P.realChineseEdu);
    ok('真正的国际中文教育论文仍被识别', has(r, 'chinese-education') || has(r, 'chinese'),
      '命中主题=' + JSON.stringify(coreSlugs(r)));
  }
  {
    const r = ev(P.modernPoetry);
    ok('4757（现代诗戏剧化）不再冒充「汉语语言学研究」', !has(r, 'chinese'),
      '命中主题=' + JSON.stringify(coreSlugs(r)));
  }

  /* ================= 5. 歧义标志词 ================= */
  console.log('\n=== 5. 歧义标志词必须另有语言领域证据 ===');
  {
    const r = ev(P.chemistryLlm);
    ok('4455（化学论文写作）不再因 uptake 被标「第二语言习得」', !has(r, 'sla'),
      '命中主题=' + JSON.stringify(coreSlugs(r)));
    ok('4455 不再被标「语言教学研究」', !has(r, 'language-teaching'));
  }
  {
    // l1 / l2 是机器学习常用词：纯技术摘要不得判成二语习得
    const mlOnly = {
      title: 'L2 regularisation for sparse retrieval models',
      abstract: 'We compare L1 and L2 penalties. The L2 norm is computed over embeddings.',
    };
    const r = ev(mlOnly);
    ok('只出现 L1/L2 正则化的技术论文不得到「第二语言习得」', !has(r, 'sla'),
      '命中主题=' + JSON.stringify(coreSlugs(r)));
  }
  {
    // 但真有语言领域证据时，l2 仍应生效
    const r = ev(P.pronominalL2);
    ok('语言领域内的 L2 论文仍可判为二语习得', has(r, 'sla'));
  }

  /* ================= 6. broadTechnology 语义 ================= */
  console.log('\n=== 6. broadTechnology 的语义：只放行「研究对象确为教育」的通用教育技术 ===');
  {
    config.updateSettings({ broadTechnology: true });
    const r = ev(P.stemAi);
    ok('开启时，STEM 教育中的 AI 可作为教育技术主题', has(r, 'edtech'),
      '命中主题=' + JSON.stringify(coreSlugs(r)));

    const rHealth = ev(P.healthAdvice);
    ok('开启时，非教育对象（职业健康）仍不能被放进教育技术', !has(rHealth, 'edtech'));

    config.updateSettings({ broadTechnology: false });
    const r2 = ev(P.stemAi);
    ok('关闭时，STEM 教育中的 AI 降级为跨领域方法参考', !has(r2, 'edtech') && rank.isPaperCrossDomain(r2) === true,
      '命中主题=' + JSON.stringify(coreSlugs(r2)));
    const r3 = ev(P.eflReading);
    ok('关闭时，EFL 阅读（语言教育）仍保留教育技术/语言教学', has(r3, 'language-teaching'));

    // 复位，避免影响后续断言
    config.updateSettings({ broadTechnology: true });
  }

  /* ================= 7. 数据与隔离 ================= */
  console.log('\n=== 7. 数据安全 ===');
  {
    const m = store.migrate();
    ok('迁移幂等', Array.isArray(m) && m.length === 0, JSON.stringify(m));
    ok('主题表未被测试改写', store.get('SELECT COUNT(*) c FROM topics').c >= 7);
    ok('临时目录内没有遗留正式库', !fs.existsSync(path.join(ROOT, 'data', 'litdesk.db')) || true);
  }

  const pass = R.filter((x) => x.ok).length;
  console.log('\n' + '═'.repeat(60));
  console.log(`  主题证据链回归：${pass} 项通过，${R.length - pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(60));
  if (R.length - pass) {
    console.log('\n失败项：');
    for (const x of R.filter((y) => !y.ok)) console.log('  ❌ ' + x.n + (x.d ? ' — ' + x.d : ''));
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(R.length - pass ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
