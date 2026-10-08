'use strict';
/**
 * 推荐排序。
 * 排序只使用可核查的信号（主题匹配、时间新近度、开放获取、被引、方法学线索词），
 * 产出的每个维度都会展示给用户，避免"黑箱推荐"。
 * 期刊是否合格由 lib/journals.js 单独判定，不参与打分，只做门槛。
 */
const store = require('./store');
const N = require('./normalize');

const METHOD_SIGNALS = {
  empirical: ['实验', '调查', '问卷', '访谈', '语料库', '纵向', '追踪', '准实验', '随机对照', '个案研究', '民族志',
    'experiment', 'survey', 'questionnaire', 'interview', 'corpus', 'corpora', 'longitudinal', 'randomized',
    'quasi-experimental', 'ethnograph', 'case study', 'mixed method', 'mixed-method', 'eye-tracking', 'eye tracking',
    'erp', 'reaction time', 'meta-analysis', 'systematic review', 'scoping review', 'data-driven', 'dataset',
    'participants', 'coding', 'thematic analysis', 'pre-test', 'post-test', 'pretest', 'posttest'],
  theory: ['理论', '模型', '框架', '建构', 'theoretical', 'framework', 'model', 'construct', 'theory', 'conceptual'],
  pedagogy: ['教学', '课堂', '教师', '学习者', '课程', '教材', '评价', '反馈', 'teaching', 'classroom', 'teacher',
    'learner', 'curriculum', 'instruction', 'instructional', 'assessment', 'feedback', 'pedagog', 'syllabus',
    'textbook', 'task design', 'course'],
  ai: ['人工智能', '生成式', '大语言模型', '智能', '机器人', '人机', 'artificial intelligence', 'generative ai',
    'large language model', 'llm', 'llms', 'chatbot', 'chatgpt', 'intelligent tutor', 'machine learning',
    'automated', 'automation', 'deep learning', 'neural', 'gpt'],
  chineseLang: ['汉语', '中文', '汉字', '普通话', '华语', 'chinese', 'mandarin', 'hanzi', 'cfl', 'csl',
    'l2 chinese', 'chinese as a second', 'chinese as a foreign'],
};

// 方法线索：中英文并列，避免只认中文导致英文论文全部“方法未知”
const DESIGN_KEYWORDS = {
  '实验/准实验': ['实验', '随机对照', '准实验', '对照', 'experiment', 'randomized', 'randomised',
    'quasi-experimental', 'control group', 'treatment group', 'intervention', 'pre-test', 'post-test'],
  '纵向/追踪': ['纵向', '追踪', '历时', 'longitudinal', 'over time', 'developmental trajectory', 'time series',
    'cross-lagged', 'growth curve'],
  '语料库': ['语料库', 'corpus', 'corpora', 'corpus-based', 'frequency analysis'],
  '问卷/量表': ['问卷', '量表', '调查', 'survey', 'questionnaire', 'scale', 'likert', 'instrument'],
  '访谈/质性': ['访谈', '质性', '民族志', '个案', '焦点小组', 'interview', 'qualitative', 'ethnograph',
    'case study', 'focus group', 'thematic analysis', 'grounded theory', 'narrative inquiry', 'discourse analysis',
    'conversation analysis', 'interactional', '话语分析', '会话分析'],
  '综述/元分析': ['元分析', '综述', '系统评价', '研究述评', 'meta-analysis', 'systematic review', 'scoping review',
    'literature review', 'critical review', 'narrative review', 'state of the art'],
  '眼动/神经': ['眼动', 'erp', '脑电', '事件相关电位', 'eye-tracking', 'eye tracking', 'neuroimaging', 'fmri',
    'reaction time', 'priming', 'self-paced reading', 'brain'],
  '测验/测量': ['测验', '信度', '效度', '因子分析', '结构方程', 'reliability', 'validity', 'factor analysis',
    'structural equation', 'rasch', 'item response', 'measurement invariance', 'cfA'],
  '纵向设计/干预': ['准实验设计', '设计实验', 'design-based research', 'action research', '行动研究', '设计研究'],
};

function daysBetween(a, b) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function countSignals(text, list) {
  const t = String(text || '').toLowerCase();
  let n = 0;
  for (const k of list) if (t.includes(k.toLowerCase())) n++;
  return n;
}

/**
 * 主题相关性：用主题关键词与论文题名/摘要/OpenAlex 概念做词面匹配。
 *
 * 注意：这里不去判断论文「属于」哪个主题，而是对每个主题独立算相关度，取最高分。
 * 论文可以被多个主题同时命中（这在跨领域研究里是正常的）；topics 字段只作为
 * 标签与筛选依据，不参与打分，避免用检索来源循环论证相关性。
 */
/* ------------------------------------------------------------------ *
 * 主题相关度：只用「有区分度」的词，避免通用词把论文推成所有主题都相关
 * ------------------------------------------------------------------ */

/**
 * 这些词在五个主题里几乎都出现，单独命中不构成任何证据。
 * 例如一篇讲口头纠正性反馈的论文，不能因为出现“语言教育”就被判为教育技术研究。
 */
const GENERIC_TERMS = new Set([
  'language', 'languages', 'education', 'educational', 'teaching', 'learning', 'learn',
  'teacher', 'teachers', 'learner', 'learners', 'student', 'students', 'research',
  'study', 'studies', 'practice', 'practices', 'classroom', 'classrooms',
  'instruction', 'instructional', 'curriculum', 'assessment', 'development',
  'analysis', 'review', 'effect', 'effects', 'role', 'use', 'using', 'based',
  '语言', '教育', '教学', '学习', '学习者', '教师', '学生', '研究', '课程',
  '课堂', '实践', '发展', '影响', '作用', '分析', '调查', '方法', '模式', '策略',
]);

/** 有强区分度的主题标志词：命中即视为该主题的实质证据 */
const DISCRIMINATIVE = {
  'general-linguistics': ['linguistic typology','syntax','semantics','phonology','morphology','sociolinguistics','psycholinguistics','neurolinguistics','语法','语义','语音','句法','语言类型学','社会语言学','心理语言学'],
  'language-teaching': ['language teaching','language instruction','language teacher','language assessment','language testing','language curriculum','language education','efl','esl','tesol','汉语教学','语言教学','语言测评','外语教学','语言教师','对外汉语','中文教学',
    // 大量论文写 "teaching Russian as a foreign language"、「汉语作为外语」，
    // 不写 language teaching；不收录 foreign language 会误杀这类语言教学研究。
    'foreign language','foreign language teaching','second language teaching','target language',
    'heritage language','language classroom','classroom language'],
  'chinese-education': ['chinese as a second language','chinese as a foreign language','l2 chinese','chinese language education','chinese teaching','chinese learning','chinese immersion','international chinese','国际中文教育','对外汉语','汉语教学','中文教学','海外中文','汉语作为第二语言','华文教育'],
  linguistics: ['applied linguistics', 'language policy', 'language planning', 'sociolinguist',
    'language teacher', 'teacher education', 'language assessment', 'language testing',
    'language ideology', 'language curriculum', 'coursebook', 'textbook', '材料开发'],
  sla: ['second language acquisition', 'sla', 'interlanguage', 'crosslinguistic', 'cross-linguistic',
    'language transfer', 'working memory', 'language aptitude', 'corrective feedback',
    'oral corrective feedback', 'written corrective feedback', 'recast', 'uptake',
    'l2 motivation', 'willingness to communicate', 'foreign language anxiety',
    /*
     * l1 / l2 / second language：大量二语习得论文的标题与摘要只写 "L2 learners"、
     * "L1 and L2 French and Chinese"、"in a second language"，不写全称
     * second language acquisition。不收录这几个词，这类真论文就会丢掉全部主题。
     * 它们同时也是歧义词（L2 正则化、L2 cache），所以进 AMBIGUOUS_FLAGS：
     * 单独命中时必须另有语言教育领域证据才算数（见 topicHits）。
     */
    'l1', 'l2', 'l1 learners', 'l2 learners', 'second language', 'second-language',
    'second language learners', 'first language',
    // 二语语音/发音习得：这类研究属于二语习得，而不是汉语语言学
    'l2 speech', 'l2 phonology', 'l2 pronunciation', 'second language speech',
    'second language pronunciation', 'english pronunciation', 'foreign accent',
    'accentedness', 'intelligibility', 'speech learning model', 'phonological acquisition',
    'pronunciation acquisition', 'pronunciation instruction', 'pronunciation learning',
    'acquisition of pronunciation', 'segmental', 'suprasegmental',
    '二语习得', '中介语', '语言迁移', '工作记忆', '纠正性反馈', '学习动机', '语言焦虑',
    '语音习得', '发音习得', '二语语音'],
  pragmatics: ['pragmatic', 'pragmatics', 'speech act', 'politeness', 'implicature',
    'conversation analysis', 'interactional competence', 'discourse marker',
    'request', 'apology', 'refusal', 'compliment', 'face-threatening',
    '语用', '言语行为', '礼貌', '会话分析', '互动能力', '话语标记'],
  edtech: ['artificial intelligence', 'generative ai', 'large language model', 'llm', 'chatgpt',
    'chatbot', 'intelligent tutoring', 'machine translation', 'automated writing',
    'automated feedback', 'automated written', 'automated writing', 'automated essay',
    'automatic speech recognition', 'asr', 'speech recognition', 'text-to-speech', 'text to speech',
    'tts', 'speech synthesis', 'automatic writing evaluation', 'computer-assisted',
    'computer assisted', 'computer-mediated', 'pronunciation training software',
    'intelligent language tutoring',
    'mobile-assisted', 'mobile assisted', 'technology-enhanced', 'technology enhanced',
    'virtual reality', 'augmented reality', 'learning analytics', 'human computer interaction', 'human-computer interaction', 'mooc', 'e-learning',
    'online learning', 'blended learning', 'flipped classroom', 'educational technology',
    'digital game', 'corpus tool', 'icall', 'tecall', 'speech synthesis',
    '人工智能', '生成式', '大语言模型', '智能辅导', '机器翻译', '自动评分',
    '计算机辅助', '移动学习', '在线学习', '混合式教学', '翻转课堂', '教育技术',
    '虚拟现实', '学习分析'],
  chinese: ['chinese as a second language', 'chinese as a foreign language', 'l2 chinese',
    'mandarin', 'putonghua', 'hanzi', 'chinese character', 'pinyin', 'csl', 'cfl',
    // 汉语教学与汉语本体研究：这些词指向「以汉语为对象」，不是泛泛提到 Chinese
    'chinese language', 'international chinese', 'chinese teaching', 'chinese learning',
    'chinese learners', 'chinese education', 'chinese pronunciation', 'chinese phonology',
    'chinese grammar', 'chinese syntax', 'chinese vocabulary', 'chinese reading',
    'chinese writing', 'chinese pragmatics', 'chinese discourse', 'chinese corpus',
    '现代汉语', '汉语', '中文', '汉字', '拼音', '普通话', '国际中文教育', '华语', '对外汉语',
    '汉语教学', '汉语学习', '汉语语音', '汉语语法', '汉语词汇'],
};

/*
 * 歧义标志词：它们本身也是常见技术/统计/通用术语，单独命中不足以判定主题。
 *   l1 / l2   —— 机器学习里的 L1/L2 正则化、缓存层次 L2 cache；
 *   uptake    —— 二语习得的「吸收」，也是药物/营养「摄取」；
 *   recast    —— 二语习得的「重铸」，也是别的领域的「重铸/改造」。
 * 命中这些词时，必须另有「语言教育领域」证据才承认（见 topicHits）。
 * 实测：4455（化学论文写作）曾因 "uptake" 被标「第二语言习得 0.14」。
 */
const AMBIGUOUS_FLAGS = new Set(['l1', 'l2', 'uptake', 'recast']);

/* ------------------------------------------------------------------ *
 * 语言域判定：教育技术主题必须与语言学习/教学相关，否则只算跨领域方法参考
 * ------------------------------------------------------------------ */

/**
 * 语言教育领域词。用于判断一篇「教育技术」论文到底是不是语言教育研究。
 *
 * 为什么需要这个：edtech 的检索词是 "artificial intelligence language learning" 这类，
 * 一篇讲「职业教育的 AI 转型」「医学生的技术增强学习」的论文会命中
 * artificial intelligence、technology-enhanced 等标志词，拿到很高的 edtech 分数，
 * 但它与语言教育毫无关系。实测这三篇的语言域词命中数都是 0。
 */
/**
 * 语言教育领域的强信号：这些词/短语几乎只出现在语言学习与教学研究里，
 * 命中一个就足以判定「这篇论文属于语言教育领域」。
 */
/*
 * 语言领域判定分两档，这是修掉两类真实误判的关键：
 *
 *   A. 语言研究对象本身（language、grammar、汉语、语用…）
 *      —— 但 "language" 也可能是「多语言客服」这种用法，
 *         所以这一档还需要一个「学术语境」词（learner / acquisition / teaching…）才算数。
 *
 *   B. 语言教育的强标志（language learning、second language acquisition、
 *      EFL、二语习得…）—— 本身已含教育含义，单独命中即可。
 */
const LANGUAGE_SUBJECT = [
  /*
   * 刻意不收裸写的 'language' / 'languages'。
   *
   * 2026-10-05 第二轮实测漏网：988《Rancang Bangun Chatbot Customer Service
   * Multi-Tenant Berbasis Large Language Model》（印尼语「多租户客服聊天机器人的
   * 设计与实现」）靠「语言研究对象 language + 学术语境 test」这两步被判进语言教育
   * 领域，于是拿到教育技术主题。它说的 language 其实是 Large Language Model /
   * Natural Language 这类 NLP 术语，而 test 只是工程里的「测试」。
   * 真语言教育论文会写 language learning / language teaching / 语言教学，
   * 那些已经在 LANGUAGE_EDU_STRONG 里，删除裸词不会误伤它们。
   */
  'linguistic', 'linguistics', 'phonolog', 'phonetic',
  'pronunciation', 'morpholog', 'pragmatic', 'pragmatics', 'speech act',
  'vocabulary', 'grammar', 'syntax', 'semantic', 'lexical', 'discourse',
  'bilingual', 'multilingual', 'translanguag', 'interlanguage', 'plurilingual',
  'mandarin', 'putonghua', 'hanzi', 'pinyin', 'chinese character',
  'interpreting', 'collocation', 'fluency',
  // 中文
  '汉语', '中文', '汉字', '拼音', '普通话', '词汇', '语法', '句法', '语义', '语用',
  '语音', '音系', '语料库', '华语', '语言学', '语篇', '话语',
];

/** 语言教育强标志：命中即判定属于语言教育领域 */
const LANGUAGE_EDU_STRONG = [
  'language learning', 'language teaching', 'language education', 'language acquisition',
  'language teacher', 'language learner', 'language assessment', 'language test',
  'language proficiency', 'language pedagogy', 'language classroom',
  /*
   * 这里刻意不收录裸写的 'l2 ' / 'l2,' / 'l2.'：它们是机器学习里的 L2 正则化、
   * L2 cache 的常用写法，会把纯技术论文判成语言教育领域（实测 L2 正则化论文
   * 因此拿到「第二语言习得」）。真二语习得论文会写 second language / foreign language，
   * 那两类词已经在上面的列表里。
   */
  'second language', 'foreign language', 'efl', 'esl', 'esol',
  'tefl', 'tesol', 'cfl', 'csl', 'chinese as a', 'academic writing', 'english writing',
  'reading comprehension', 'listening comprehension', 'communicative competence',
  'interactional competence', 'corrective feedback',
  '二语', '外语', '国际中文', '对外汉语', '语言教学', '语言学习', '语言能力', '语言测评',
  '习得', '交际能力', '中介语',
];

/** 学术语境：与 A 档同现才说明这是语言研究，而不是「多语言产品」 */
const ACADEMIC_CONTEXT = [
  'learner', 'learners', 'learning', 'teaching', 'acquisition', 'student', 'students',
  'classroom', 'pedagog', 'instruction', 'curriculum', 'course', 'proficiency',
  'assessment', 'test', 'corpus', 'error', 'errors', 'transfer', 'development',
  'education', 'educational', 'textbook', 'syllabus', 'teacher', 'teachers',
  '学习', '学习者', '学生', '教学', '课堂', '课程', '习得', '教育', '教师', '能力', '水平',
];

const LANGUAGE_WEAK = [
  'literacy', 'reading', 'writing', 'listening', 'speaking', 'translation', 'accuracy',
  '阅读', '写作', '听力', '口语', '翻译', '口译', '准确',
];

/*
 * 语言专用锚点：弱信号必须与它同现才算数。
 *
 * 注意这里刻意不放 'language' / 'languages' 这种泛词：
 * 一篇讲「多语言大学信息检索聊天机器人」的论文里有 language translation、
 * high accuracy，用 language 当锚点就会把它判成语言教育研究。
 * 能当锚点的必须是明确指向语言教学/研究的表述。
 */
const LANGUAGE_ANCHOR = [
  'language learning', 'language teaching', 'language education', 'language acquisition',
  'language teacher', 'language learner', 'language assessment', 'language proficiency',
  'second language', 'foreign language', 'efl', 'esl', 'tefl', 'tesol',
  'chinese as a', 'language classroom', 'language pedagogy',
  'translating', 'interpreting',
  '二语', '外语', '国际中文', '对外汉语', '语言教学', '语言学习', '语言能力', '语言测评', '习得',
];

/** 旧名保留（其他模块可能引用） */
const LANGUAGE_STRONG = LANGUAGE_EDU_STRONG;
const LANGUAGE_DOMAIN_TERMS = LANGUAGE_EDU_STRONG.concat(LANGUAGE_SUBJECT);

/** 需要额外语言域约束的主题：目前只有教育技术 */
const CROSS_DOMAIN_TOPICS = new Set(['edtech']);

/** 中文语言学主题的专用门控：必须真的以汉语为研究对象 */
const CHINESE_FOCUS_TERMS = [
  // 必须是与汉语本体或汉语教学直接相关的词组。
  // 不能只写 'chinese' / 'mandarin' / 'chinese dialect'：
  // 一篇谈「方言者英语发音学习」的论文提到 Mandarin-speaking 学习者，
  // 会被这几种宽泛匹配误判成汉语语言学研究。
  'chinese language', 'mandarin chinese', 'modern chinese', 'standard chinese',
  'chinese syntax', 'chinese grammar', 'chinese phonology', 'chinese phonetics',
  'chinese character', 'chinese characters', 'chinese corpus', 'chinese linguistics',
  'chinese vocabulary', 'chinese reading', 'chinese writing', 'chinese pronunciation',
  'chinese listening', 'chinese speaking', 'chinese pragmatic', 'chinese discourse',
  'chinese as a second', 'chinese as a foreign', 'chinese as an additional',
  'chinese language teaching', 'chinese language learning', 'chinese language education',
  'international chinese', 'chinese teaching', 'chinese learning', 'chinese learners',
  'chinese education', 'learning of chinese', 'teaching of chinese',
  'learning chinese', 'teaching chinese', 'cfl', 'csl', 'putonghua', 'hanzi', 'pinyin',
  'han character', 'tone sandhi', 'measure word', 'classifier',
  '汉语', '中文', '汉字', '拼音', '普通话', '现代汉语', '汉语语法', '汉语方言',
  '汉语语音', '汉语词汇', '汉语语用', '汉语教学', '汉语学习', '中文教学', '华语',
  '国际中文', '对外汉语', '文言', '量词', '声调',
];

/*
 * 与「语言研究」无关、但字面含语言词的固定说法，判定前先屏蔽。
 *
 * 例：「大语言模型」的字面包含「语言」，一篇讲
 * 「大语言模型智能辅导系统在中医诊断学教学中的应用」的论文
 * 会因此被误判成语言教育研究——而它是医学教育研究。
 * 同理 "large language model" 里的 "language"。
 */
const NEUTRALIZE_TERMS = [
  'large language model', 'large language models', 'llm', 'llms',
  '大语言模型', '大模型', '语言模型', '语言大模型',
  'natural language processing', 'natural language understanding',
  '自然语言处理', '多语言支持', '语言服务', '编程语言',
];

/** 屏蔽会让语言域判定误判的技术固定说法 */
function neutralize(text) {
  let t = String(text || '').toLowerCase();
  for (const n of NEUTRALIZE_TERMS) t = t.split(n.toLowerCase()).join(' [技术词] ');
  return t;
}

/**
 * 这篇论文是否站在语言教育领域之内。
 */
function languageDomain(text) {
  const hay = neutralize(text);
  const eduStrong = LANGUAGE_EDU_STRONG.filter((t) => hay.includes(t));
  if (eduStrong.length) {
    return { inDomain: true, tier: 'edu', strong: eduStrong, weak: [], reason: `命中语言教育强标志：${eduStrong.slice(0, 3).join('、')}` };
  }
  const subject = LANGUAGE_SUBJECT.filter((t) => hay.includes(t));
  const academic = ACADEMIC_CONTEXT.filter((t) => hay.includes(t));
  if (subject.length && academic.length) {
    return {
      inDomain: true, tier: 'subject+context', strong: subject, academic, weak: [],
      reason: `语言研究对象「${subject.slice(0, 2).join('、')}」与学术语境「${academic.slice(0, 2).join('、')}」同现`,
    };
  }
  const weak = LANGUAGE_WEAK.filter((t) => hay.includes(t));
  const anchor = LANGUAGE_ANCHOR.filter((t) => hay.includes(t));
  if (weak.length && anchor.length) {
    return { inDomain: true, tier: 'weak+anchor', strong: [], weak, anchor, reason: `弱信号「${weak.slice(0, 2).join('、')}」与语言锚点「${anchor.slice(0, 2).join('、')}」同现` };
  }
  return {
    inDomain: false, tier: 'none', strong: subject, weak, academic,
    reason: subject.length && !academic.length
      ? `只提到语言词「${subject.slice(0, 2).join('、')}」，但缺少语言学习/教学语境（可能是多语言产品、信息服务等），判定为跨领域`
      : (weak.length
          ? `只命中弱信号「${weak.slice(0, 2).join('、')}」，缺少语言专用锚点，判定为跨领域`
          : '没有任何语言教育领域证据'),
  };
}

function hasLanguageDomain(text) {
  return languageDomain(text).inDomain;
}

/*
 * 研究对象证据：这篇论文到底在研究「什么」。
 *
 * 为什么必须单列一档：检索词命中（source_queries）与 AI / learning / education
 * 这类通用词命中，都**不能**证明研究对象是教育与学习。
 * 2026-10-05 实测的误判论文里：
 *   · 4764 研究对象是职业健康建议（occupational / sedentary / health advice），
 *     只是摘要里出现 education，就拿到了教育技术 0.83；
 *   · 4186 是遗忘型轻度认知障碍的临床网络 meta 分析（patient / dementia /
 *     medicine / pharmac），却因摘要含 chinese、second 被判成「国际中文教育」。
 *
 * 判据：非教育类专业领域的对象词（医学/临床/职业健康/药学）多于或等于教育类
 * 对象词时，认定研究对象不是教育。这样：
 *   · 4764（非教育 7 / 教育 2）、4186（非教育 6 / 教育 0）⇒ 非教育研究对象；
 *   · 4962（药学教育：非教育 2 / 教育 5）⇒ 仍是教育研究，可以算广义教育技术。
 */
/*
 * 教育研究对象的**强**证据：这些词说明论文把「学习者/教学活动」当作研究对象本身。
 *
 * 刻意不收 education / educational / school / university / college / undergraduate /
 * postgraduate / instruction / course 这类词：它们大量出现在机构名、可读性结论和
 * 一句展望里，会把临床研究抬成教育研究。
 *
 * 2026-10-05 第二轮验收的真实反例 3329《Evaluation of large language model responses
 * to expert questions in anterior implant dentistry》——研究对象是种植牙治疗规划，
 * 由修复科医生评价 AI 回答，却因为下面这几处**顺带提到**被判成教育技术：
 *   · "their potential role as educational and adjunct informational tools"（一句潜在用途）
 *   · "before integrating such tools into clinical education"（结尾展望）
 *   · "the responses required a high-school to early undergraduate reading level"
 *     （这是**可读性**结论，school/undergraduate 说的是阅读难度，与教育研究无关）
 * 旧写法把这几处算成「教育对象 4 个」，多过非教育对象 3 个，于是放行。
 * 现在这些词一律不算研究对象证据，3329 的教育对象数为 0。
 */
const EDUCATION_OBJECT_TERMS = [
  // 学习者与教学主体
  'student', 'students', 'learner', 'learners', 'pupil', 'pupils', 'trainee', 'trainees',
  'classroom', 'classrooms', 'curriculum', 'teaching', 'teacher', 'teachers', 'pedagog',
  // 学习结果/教学干预（把「教学」当研究对象才会写的表述）
  'learning outcome', 'learning outcomes', 'learning gain', 'learning gains',
  'student performance', 'student learning', 'instructional design',
  '课堂', '课程', '教学', '教师', '学员', '学习者', '学生', '教学法',
];

/*
 * 标题里的教育词：**标题**出现这些词，说明论文自己把教育/教学当主题。
 *
 * 为什么标题单独一档：3329 的问题出在**正文**里的顺带提到（一句潜在用途、一句
 * 结尾展望、一句可读性结论）。而真正研究教育的论文，标题里几乎一定会出现
 * education / learning / students / teaching 这类词——本项目的用例
 * 「Learning analytics and human computer interaction in education」、
 * 4553「…STEM Education」、4559「…Students' Understanding…」都是如此。
 * 标题几乎不会出现「可读性阅读年级」这种偶然搭配，所以这里可以放宽到 education。
 */
const EDUCATION_TITLE_TERMS = [
  'education', 'educational', 'teaching', 'pedagog', 'curriculum', 'classroom',
  'learner', 'learners', 'student', 'students', 'pupil', 'trainee', 'trainees',
  'instruction', 'instructional', 'course', 'courses', 'school', 'university',
  'college', 'training', 'teacher', 'teachers', 'literacy',
  '教育', '教学', '课程', '课堂', '教师', '学员', '学生', '学习者', '培训',
];

/*
 * 非教育专业研究对象：医学、临床、职业健康、药学等。
 * 注意：这里只是判「研究对象是不是教育」，不是把医学领域一刀切排除——
 * 医患沟通、医学术语翻译、临床话语语用这些**语言学研究**由各自的主题标志词判，
 * 不经过这道门控（门控只作用于 edtech）。
 */
const NON_EDUCATION_OBJECT_TERMS = [
  // 医学 / 临床
  'patient', 'patients', 'clinical', 'clinician', 'clinicians', 'disease', 'disorder',
  'diagnosis', 'diagnostic', 'therapy', 'therapeutic', 'treatment', 'symptom', 'symptoms',
  'prevalence', 'alzheimer', 'dementia', 'cognitive impairment', 'rehabilitation',
  'nurse', 'nurses', 'physician', 'physicians', 'medical', 'medicine', 'medication',
  'dosage', 'drug', 'drugs', 'pharmac', 'prescription', 'comorbidity', 'placebo',
  'dentistry', 'dental', 'implant', 'prosthodont', 'surgical', 'surgery',
  // 职业健康 / 公共健康
  'health advice', 'healthcare', 'health care', 'occupational', 'workplace', 'sedentary',
  'office worker', 'office workers', 'public health', 'epidemiolog',
  // 中文
  '患者', '临床', '疾病', '诊断', '治疗', '药物', '护理', '康复', '健康',
  '职业健康', '流行病', '口腔', '牙科', '种植牙',
];

/**
 * 判定论文的研究对象（教育 / 非教育专业领域）。
 * 只用于阻止「非教育对象」的论文冒充教育技术主题，不改变语言教育类论文的判定。
 *
 * @param {string} text  正文（标题+摘要）
 * @param {string} [title] 标题；单独给标题是为了让「标题里的教育词」成为更强的证据
 */
function researchObject(text, title = '') {
  const hay = neutralize(text);
  const titleHay = neutralize(String(title || ''));
  const titleEdu = EDUCATION_TITLE_TERMS.filter((t) => titleHay.includes(t));
  const bodyEdu = EDUCATION_OBJECT_TERMS.filter((t) => hay.includes(t));
  const edu = [...new Set([...titleEdu, ...bodyEdu])];
  const nonEdu = NON_EDUCATION_OBJECT_TERMS.filter((t) => hay.includes(t));
  return {
    isEducation: edu.length > 0,
    educationTerms: edu.slice(0, 5),
    educationTitleTerms: titleEdu,
    nonEducationTerms: nonEdu.slice(0, 5),
    /*
     * 研究对象不是教育：出现非教育专业对象词，且它不少于教育对象词。
     * 一个「教育对象词」就够反驳：真正研究教育的论文会明确写学生/学习者/教学。
     */
    nonEducational: nonEdu.length >= 1 && nonEdu.length >= edu.length,
  };
}



/** 是否真的以汉语为研究对象（用于汉语语言学主题门控） */
function hasChineseFocus(text) {
  const hay = String(text || '').toLowerCase();
  return CHINESE_FOCUS_TERMS.some((t) => hay.includes(t));
}

function tokenize(text) {
  const t = String(text || '').toLowerCase();
  const latin = t.split(/[^a-z0-9'-]+/).filter((w) => w.length > 2);
  const cjk = (t.match(/[\u4e00-\u9fff]{2,}/g) || []);
  return [...latin, ...cjk];
}

/**
 * 词面匹配必须带词边界，否则会出现「specifically 里含 call」「Ansano 里含 ai」
 * 这类把普通论文误判成教育技术研究的问题。
 *  - 纯 ASCII 词/短语：用 \b 边界匹配，并允许连字符/空格互换
 *  - 中文：直接子串匹配（中文没有词边界概念）
 */
function hasTerm(hay, term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return false;
  if (/^[\x00-\x7f]+$/.test(t)) {
    // 短语内的空格与连字符视为等价分隔
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+');
    return new RegExp('(?<![a-z0-9])' + esc + '(?![a-z0-9])', 'i').test(hay);
  }
  return hay.includes(t);
}

/**
 * 对每个主题算相关度。
 *   specificityHits：命中该主题的「有区分度标志词」的个数（最关键的证据）
 *   discriminativeRatio：命中词中排除通用词后的占比
 *   score：综合分，但没有任何区分度证据时上限被压得很低
 */
function topicHits(paper, topics) {
  const hay = [paper.title, paper.abstract, store.parseJson(paper.concepts, []).join(' ')]
    .filter(Boolean).join(' ').toLowerCase();
  const hits = {};
  const strongHits = {};
  const specificityHits = {};
  const matchedFlags = {};
  const crossDomain = {};      // 主题命中但缺乏本领域证据（例如泛教育技术）
  const crossDomainReason = {};
  let best = 0;

  for (const t of topics) {
    if((t.exclude_terms||[]).some(w=>hasTerm(hay,w))){hits[t.slug]=0;continue;}
    const kws = [...(t.keywords_zh || []), ...(t.keywords_en || [])];

    /*
     * 关键：只用「有区分度的词」算分。
     *
     * 反面教材：edtech 的检索词里有 'technology enhanced language learning'、
     * 'online learning language education' 之类。如果按「命中词/总词数」算，
     * 任何一篇讲 language learning 的论文都会命中 language、learning 两个通用词，
     * 于是任何二语习得论文都会显示成「教育技术研究」。
     * 所以每个检索词先去通用词，再算区分度命中率。
     */
    let kwScores = [];
    let strong = 0;
    for (const kw of kws) {
      const terms = tokenize(kw);
      if (!terms.length) continue;
      const specTerms = terms.filter((x) => !GENERIC_TERMS.has(x) && x.length > 3);
      if (!specTerms.length) continue;          // 整条检索词都是通用词，不参与打分
      const usefulMatched = specTerms.filter((x) => hasTerm(hay, x));

      /*
       * 检索词必须真的「作为一条词」被命中，不能被剥剩的单个词代表。
       *
       * 真实缺陷（2026-10-05 实测）：'Chinese language education' 剥掉通用词
       * language / education 之后只剩 'chinese'，于是任何摘要里出现 Chinese
       * （例如「Chinese participants」「Chinese patients」）的论文都在这条上拿满分，
       * 被判成「国际中文教育」——4186（遗忘型轻度认知障碍网络 meta 分析）、
       * 4962（药学虚拟仿真评分表）就是这样进来的。
       * 同类残留还有 'language curriculum design' → 'design'、
       * 'language teaching intervention' → 'intervention'。
       *
       * 规则：
       *   · 整条短语原样出现（含连字符/空格互换）⇒ 命中；
       *   · 剥完通用词后只剩 1 个词的多词检索词 ⇒ 必须整条短语出现才算命中；
       *   · 其余多词检索词 ⇒ 至少命中 2 个实词才算命中。
       * 单字检索词（如 'phonology'、'中介语'）不受影响：它本身就是整条短语。
       */
      const phraseHit = hasTerm(hay, kw);
      let ratio = usefulMatched.length / specTerms.length;
      if (!phraseHit) {
        if (specTerms.length === 1) ratio = 0;
        else if (usefulMatched.length < 2) ratio = 0;
      }

      kwScores.push(ratio);
      if (ratio >= 0.6) strong++;
    }

    const norm = kwScores.length ? kwScores.reduce((a, b) => a + b, 0) / kwScores.length : 0;

    // 区分度标志词命中数（最强的证据）
    const flags = DISCRIMINATIVE[t.slug] || kws.filter(w=>{const words=tokenize(w);return !GENERIC_TERMS.has(w.toLowerCase()) && (words.length>=2||/[\u4e00-\u9fff]/.test(w)||w.length>=5);});
    const spec = flags.filter((f) => hasTerm(hay, f));

    specificityHits[t.slug] = spec.length;
    strongHits[t.slug] = strong;
    matchedFlags[t.slug] = spec.slice(0, 5);

    /*
     * 一个主题要有分，必须有该主题自己的标志词（DISCRIMINATIVE[slug]）。
     *
     * 真实缺陷（2026-10-05 实测）：4186（遗忘型轻度认知障碍网络 meta 分析）、
     * 4962（药学虚拟仿真评分表）在「国际中文教育」上拿到 0.80，但 spec.length === 0
     * —— 一个主题标志词都没命中，分数完全来自检索词比例（当时摘要里只要同时出现
     * chinese 和 second 就够）。检索词是**发现用的线索**，不能证明主题归属。
     *
     * 注意：标志词表本身要够全，否则会误杀真语言研究。
     * 2026-10-05 实测被误杀的三篇正是这样补上来的：
     *   · 3884《Interpretation of pronominal forms in L1 and L2 French and Chinese》
     *     —— 摘要写 "second language (L2) learners"，靠新增的 l2 / second language 标志命中 sla；
     *   · 2684《The Multidimensional Organisation of Embodied Meaning in a Second Language》
     *     —— 同上；
     *   · 4284《Russian-Chinese collocation glossary for teaching written speech…》
     *     —— 靠新增的 foreign language 命中语言教学。
     */
    if (!spec.length) {
      hits[t.slug] = 0;
      continue;
    }

    /*
     * 歧义标志词（l1 / l2 这类）：单独命中不算数，必须同时确认这篇论文
     * 确实在语言教育领域内。否则「L2 正则化」「L2 cache」这类纯技术论文
     * 会被判成第二语言习得。
     */
    if (spec.every((f) => AMBIGUOUS_FLAGS.has(String(f).toLowerCase())) && !languageDomain(hay).inDomain) {
      hits[t.slug] = 0;
      continue;
    }

    /*
     * 跨领域主题（教育技术）额外要求「研究对象」证据。
     *
     * 单纯命中了 AI / learning / education 这类词，不能证明这篇论文研究的是
     * **教育与学习**。2026-10-05 的真实误判：
     *   · 4764《Evaluating AI chatbots for providing health advice on occupational
     *     sedentary behavior》研究对象是职业健康建议，却拿到教育技术 0.83；
     *   · 4962《Rubric for Deep and Interactive Learning in the Pharmacy Virtual
     *     Simulation Environment》是药学教育，可以算广义教育技术。
     * 两者必须区分开。
     *
     * 判定顺序：
     *   1. 有语言教育领域证据 ⇒ 核心（AI 辅助语言学习、TTS 用于二语测评…）；
     *   2. 研究对象确实是教育/学习，且用户打开了 broadTechnology
     *      ⇒ 也算教育技术核心（STEM 教育中的 AI、药学虚拟仿真教学…）；
     *   3. 其余（医学、临床、职业健康等非教育对象）⇒ 只作跨领域方法参考。
     *
     * broadTechnology 只决定第 2 条；它**不能**把非教育对象放进来。
     */
    if (CROSS_DOMAIN_TOPICS.has(t.slug)) {
      const dom = languageDomain(hay);
      const obj = researchObject(hay, paper.title);
      const broad = require('./config').getSettings().broadTechnology;
      /*
       * 非教育研究对象的论文（医学、临床、药学、职业健康…）**一律**不能算教育技术核心，
       * 即使它的语言域判定为真也不行 —— 实测漏网的有
       * 805《AI-driven discovery of herbal drugs》、849《Artificial intelligence in
       * laboratory medicine》，它们靠摘要里的 language 类弱信号混过了语言域门控。
       */
      const ok = !obj.nonEducational && (dom.inDomain || (broad && obj.isEducation));
      if (!ok) {
        hits[t.slug] = 0;
        crossDomain[t.slug] = true;
        crossDomainReason[t.slug] = obj.nonEducational
          ? `研究对象是「${obj.nonEducationTerms.slice(0, 3).join('、')}」等非教育领域，不是教育与学习研究`
          : dom.reason;
        continue;
      }
    }

    /*
     * 汉语语言学主题额外门控：必须真的以汉语为研究对象。
     *
     * 反面教材：Differentiated Difficulties… Dialect Speakers' English Pronunciation Learning
     * 因为正文提到 Mandarin-speaking learners 和 dialect，就被判成「汉语语言学研究」，
     * 但它的研究对象是英语发音习得。
     *
     * 门控只在「证据靠的是中文泛词」时才生效：如果一篇论文本来就凭
     * 汉语本体/汉语教学的明确标志词拿到证据，就不该被这段逻辑挡掉。
     */
    if (t.slug === 'chinese' && !hasChineseFocus(hay)) {
      const flagsHit = (DISCRIMINATIVE.chinese || []).filter((f) => hasTerm(hay, f));
      const genericOnly = flagsHit.every((f) => 'chinese mandarin putonghua hanzi pinyin 汉语 中文 汉字 拼音 普通话 现代汉语 汉语方言 华语'.split(' ').includes(f.toLowerCase()));
      if (genericOnly) {
        hits[t.slug] = 0;
        crossDomain[t.slug] = true;
        crossDomainReason[t.slug] = `只凭「${flagsHit.slice(0, 3).join('、')}」这类泛词命中，且没有汉语本体/汉语教学的明确标志（如 international chinese education、汉语教学），判定为跨领域`;
        continue;
      }
    }

    /*
     * 有效检索词比例 + 标志词加成；单个标志词只给很小加成。
     */
    const coverage = kwScores.length ? kwScores.filter((r) => r > 0).length / kwScores.length : 0;
    const specBonus = spec.length === 0 ? 0
      : (spec.length === 1 ? 0.14 : Math.min(0.18 * spec.length, 0.6));
    const final = Math.min(1, norm * 1.8 + coverage * 0.25 + specBonus);

    hits[t.slug] = Number(final.toFixed(3));
    if (final > best) best = final;
  }
  return { best, hits, strongHits, specificityHits, matchedFlags, crossDomain, crossDomainReason };
}

/**
 * 全篇是否属于「跨领域方法参考」。
 *
 * 定义（这是 P1 修正的核心）：
 *   没有任何有效核心主题证据（所有主题分数为 0）
 *   且存在跨领域方法命中（例如泛教育技术、泛医学教育）
 *   ⇒ 整篇算跨领域。
 *
 * 反例：一篇真正的二语习得研究，因元数据里提到 Mandarin 而在
 * 「汉语语言学」主题上被判跨领域——它仍有一个有效主题（sla），
 * 因此**不应**被整篇降到跨领域区、也不应从主简报排除。
 */
function isPaperCrossDomain(topicResult) {
  const coreTopics = Object.entries(topicResult.hits || {}).filter(([, v]) => v > 0);
  const hasCore = coreTopics.length > 0;
  const hasCross = Object.keys(topicResult.crossDomain || {}).length > 0;
  return !hasCore && hasCross;
}

function topicScore(paper, topics) {
  const { best, hits, strongHits, specificityHits, matchedFlags, crossDomain, crossDomainReason } = topicHits(paper, topics);
  return { score: best, hits, strongHits, specificityHits, matchedFlags, crossDomain, crossDomainReason, assigned: store.parseJson(paper.topics, []) };
}

/**
 * 依据关键词证据给论文打主题标签（用于旧数据回填与手动导入的题录）。
 * 门槛刻意收紧：必须至少命中一个「有区分度标志词」，
 * 否则一篇讲语言教育的论文会被五个主题全部命中，标签就失去意义。
 */
function inferTopics(paper, topics, { minScore = 0.35, minSpecificity = 1, maxTopics = 3, keepExistingWhenEmpty = false } = {}) {
  const existing = store.parseJson(paper.topics, []);
  const { hits, specificityHits, crossDomain } = topicHits(paper, topics);
  const inferred = Object.entries(hits)
    .filter(([k, v]) => v >= minScore && (specificityHits[k] || 0) >= minSpecificity && !crossDomain[k])
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTopics)
    .map(([k]) => k);
  if (inferred.length) return inferred;
  // keepExistingWhenEmpty：采集阶段用——保留「发现它的检索主题」作为兜底。
  // 回填/重新核验阶段不使用，避免旧版本留下的宽泛标签一直粘着：
  // 没有区分度证据就是没有标签（界面显示「暂无主题证据」），而不是硬塞五个主题。
  return keepExistingWhenEmpty ? existing : [];
}

function methodProfile(text) {
  const found = [];
  for (const [label, kws] of Object.entries(DESIGN_KEYWORDS)) {
    if (countSignals(text, kws) > 0) found.push(label);
  }
  const empirical = countSignals(text, METHOD_SIGNALS.empirical) > 0;
  const theory = countSignals(text, METHOD_SIGNALS.theory) > 0;
  return {
    designs: found,
    empirical, theory,
    score: Math.min(1, (found.length * 0.3) + (empirical ? 0.4 : 0) + (theory ? 0.2 : 0)),
  };
}

function researchValue(paper, text) {
  const ai = countSignals(text, METHOD_SIGNALS.ai);
  const ped = countSignals(text, METHOD_SIGNALS.pedagogy);
  const zh = countSignals(text, METHOD_SIGNALS.chineseLang);
  const raw = ai * 0.35 + ped * 0.25 + zh * 0.3;
  return { score: Math.min(1, raw), ai, pedagogy: ped, chineseContext: zh };
}

/**
 * 新近度只依据**可信的在线发表日期**（paper.published_online）。
 *
 * 关键约束（曾经出错的地方）：
 *   · 没有 published_online 时，**不推断**「发表仅 N 天」，也不能按「今天发表」计分；
 *   · 也**不拿 issued_date 顶替**：issued_date 常常只有年份（如 "2026"），
 *     把它当日期同样是编造精度；
 *   · 因此无日期时给低分并让 days=null，调用方据此完全不提「发表多少天」。
 *     「工作台今天采到它」≠「它今天发表」。
 */
function freshness(paper) {
  const today = new Date().toISOString();
  const online = paper.published_online;
  if (!online) return { score: 0.2, days: null, basis: 'unknown' };
  /*
   * 精度不足的在线日期（只有年 '2026' 或只有年月 '2026-09'）不能算「发表仅 N 天」：
   * 我们并不知道具体是哪一天。用一个保守的低分，并让 days=null，
   * 这样 ruleReason 就不会写出一个凭空的「N 天」。
   */
  const prec = N.datePrecision(online);
  if (prec && prec !== 'day') {
    return { score: 0.3, days: null, basis: 'coarse' };
  }
  const d = daysBetween(online, today);
  if (!Number.isFinite(d) || d < 0) return { score: 0.2, days: null, basis: 'unknown' };
  if (d <= 7) return { score: 1, days: d, basis: 'online' };
  if (d <= 30) return { score: 0.85, days: d, basis: 'online' };
  if (d <= 90) return { score: 0.6, days: d, basis: 'online' };
  if (d <= 365) return { score: 0.35, days: d, basis: 'online' };
  return { score: 0.15, days: d, basis: 'online' };
}

function completeness(paper) {
  let s = 0;
  if (paper.abstract) s += 0.5;
  if (paper.doi_norm) s += 0.2;
  if (paper.open_access) s += 0.2;
  if (paper.url) s += 0.1;
  return s;
}

const WEIGHTS = {
  topic: 0.34,
  freshness: 0.2,
  method: 0.16,
  value: 0.18,
  completeness: 0.07,
  citation: 0.05,
};

function scorePaper(paper, topics) {
  const text = [paper.title, paper.abstract, (paper.concepts || []).join(' ')].filter(Boolean).join(' ');
  const t = topicScore(paper, topics);
  const f = freshness(paper);
  const m = methodProfile(text);
  const v = researchValue(paper, text);
  const c = completeness(paper);
  const cites = paper.citation_count || 0;
  const citScore = cites <= 0 ? 0 : Math.min(1, Math.log10(cites + 1) / 2);

  const total = t.score * WEIGHTS.topic + f.score * WEIGHTS.freshness + m.score * WEIGHTS.method +
    v.score * WEIGHTS.value + c * WEIGHTS.completeness + citScore * WEIGHTS.citation;

  return {
    total: Number(total.toFixed(4)),
    dimensions: {
      topic: Number(t.score.toFixed(3)),
      freshness: Number(f.score.toFixed(3)),
      method: Number(m.score.toFixed(3)),
      value: Number(v.score.toFixed(3)),
      completeness: Number(c.toFixed(3)),
      citation: Number(citScore.toFixed(3)),
    },
    detail: {
      topicHits: t.hits,
      // 逐主题的跨领域标记：只表示「这个主题不成立」，不等于整篇论文跨领域
      crossDomain: t.crossDomain || {},
      crossDomainReason: t.crossDomainReason || {},
      // 全篇结论：**没有任何有效核心主题证据**、但存在跨领域方法命中时才算整篇跨领域。
      // 只要有一个主题站得住，它就仍是核心推荐，只是在不成立的主题上不显示分数。
      isCrossDomain: isPaperCrossDomain(t),
      coreTopics: Object.entries(t.hits).filter(([, x]) => x > 0).map(([k]) => k),
      specificityHits: t.specificityHits || {},
      designs: m.designs, empirical: m.empirical, theory: m.theory,
      freshnessDays: f.days, freshnessBasis: f.basis, valueFlags: v,
    },
  };
}

/** 生成可读的推荐理由（规则版；AI 版由 lib/interpret.js 提供） */
function ruleReason(paper, scored, topicMap) {
  const parts = [];
  const hitEntries = Object.entries(scored.detail.topicHits || {})
    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (hitEntries.length) {
    parts.push(`主题相关度最高：${hitEntries.map(([k, v]) => `${topicMap[k] || k}(${v})`).join('、')}`);
  }

  const d = scored.detail;
  const basis = paper.abstract ? '按题名与摘要识别' : '仅按题名识别';
  if (d.designs.length) parts.push(`方法线索（${basis}）：${d.designs.slice(0, 3).join('、')}`);
  else parts.push(`未从题名与摘要中识别到明确的方法关键词，需要进入原文确认设计（${basis}）`);

  if (d.valueFlags.ai) parts.push('题名/摘要中出现 AI、大语言模型或自动化相关表述，与你的「AI 赋能语言教学/人智协同」方向可能衔接');
  if (d.valueFlags.chineseContext) parts.push('题名/摘要中出现汉语/中文语境，可直接对接国际中文教育');
  if (d.valueFlags.pedagogy) parts.push('落脚点在教学、教师或学习者，偏教学研究取向');
  else if (!d.valueFlags.ai && !d.valueFlags.chineseContext) parts.push('偏理论或语言本体取向，可能更适合作为理论/框架参考');

  if (d.freshnessDays != null && d.freshnessDays <= 14) {
    parts.push(`首次在线发表仅 ${d.freshnessDays} 天`);
  } else if (d.freshnessBasis === 'coarse') {
    // 只有年或年月：知道大概，但不足以说「发表仅 N 天」
    parts.push('来源只提供到年/月的在线发表日期，精度不足以判断「发表多少天」，因此不参与新近度加分');
  } else if (d.freshnessBasis === 'unknown') {
    // 没有可信发表日就绝不说「发表仅 N 天」；如实说明为何不参与新近度
    parts.push('来源未提供可信的在线发表日期，因此不参与新近度加分（「刚采集到」不等于「刚发表」）');
  }
  if (paper.open_access) parts.push('有开放获取版本，可直接读全文');
  if (paper.abstract) {
    parts.push(`有摘要（${paper.abstract.length} 字符），可先做依据摘要的快速解读`);
  } else {
    parts.push('暂无摘要，只能依据题名/元数据做有限判断，建议先获取原文');
  }

  const tail = '以上为规则匹配结果，具体的研究问题、理论与证据强度需要进入详情页做解读。';
  return parts.join('；') + '。' + tail;
}

function topicNameMap() {
  const m = {};
  for (const t of store.all('SELECT slug, name_zh FROM topics')) m[t.slug] = t.name_zh;
  return m;
}

module.exports = { scorePaper, ruleReason, topicNameMap, WEIGHTS, DESIGN_KEYWORDS, methodProfile, topicHits, topicScore, inferTopics, isPaperCrossDomain, hasTerm, tokenize, hasLanguageDomain, languageDomain, researchObject, neutralize, hasChineseFocus, GENERIC_TERMS, DISCRIMINATIVE, LANGUAGE_DOMAIN_TERMS, LANGUAGE_STRONG, LANGUAGE_SUBJECT, LANGUAGE_EDU_STRONG, ACADEMIC_CONTEXT, LANGUAGE_WEAK, CHINESE_FOCUS_TERMS, CROSS_DOMAIN_TOPICS };
