'use strict';
/**
 * 篇关摘翻译 + 中文题录导入 的集成测试。
 *
 * 用本机模拟的 OpenAI 兼容端点，验证：
 *   翻译缓存、原文指纹失效、数字保真校验、无摘要/无关键词的拒绝、
 *   失败可重试且保留原文、工作台主题标签不冒充作者关键词、
 *   CNKI GB/T 与 RefWorks 标签格式（含混合粘贴）的解析。
 *
 * 运行：node test/translate-cnimport.js
 * 使用独立临时数据目录，不会触碰正式的 data/。
 */
const ROOT=require('path').resolve(__dirname,'..');
process.chdir(ROOT);
const fs=require('fs'), path=require('path'), os=require('os'), http=require('http');
const T=fs.mkdtempSync(path.join(os.tmpdir(),'litdesk-tr-'));
process.env.LITDESK_DATA_DIR=T;

const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d});

// 模拟端点：返回遵循规则的译文；对特定输入故意丢掉统计量以测试数字校验
let calls=0;
const mock=http.createServer((req,res)=>{
  let b='';req.on('data',c=>b+=c);req.on('end',()=>{
    calls++;
    const body=JSON.parse(b);
    const user=body.messages[body.messages.length-1].content;
    let out='';
    if (/篇名|title/i.test(user) && /Abstract/i.test(user)) out='Abstract translation.';
    if (/关键词|keyword/i.test(user)) out='dynamic assessment; corrective feedback';
    if (/p = \.019/.test(user)) out='研究结果表明差异显著（省略统计量）';  // 故意丢数字
    else out='这是译文，保留统计量 p = .019 与 F(1, 22) = 6.41 以及 24 名学习者（2024）。';
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({model:'mock',choices:[{message:{role:'assistant',content:out},finish_reason:'stop'}],usage:{total_tokens:42}}));
  });
});

(async()=>{
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const port=mock.address().port;
  const store=require('../lib/store');
  const config=require('../lib/config');
  const discover=require('../lib/discover');
  const tr=require('../lib/translate');
  const cnimp=require('../lib/cnimport');
  store.migrate(); discover.seedTopicsIfEmpty();
  config.updateSettings({aiBaseUrl:`http://127.0.0.1:${port}`,aiModel:'mock'});

  const base={authors:['A'],journalName:'J',issn:'1234-5678',publishedOnline:'2026-09-01',language:'zh',sources:['test']};
  discover.persistPapers([
    {...base, title:'带统计量的中文论文', abstract:'结果显示差异显著，F(1, 22) = 6.41，p = .019，共 24 名学习者（2024）。', keywords:['动态评估','纠正性反馈'], keywordsSource:'imported:cnki'},
    {...base, title:'没有摘要的论文', abstract:null, keywords:['测试词'], keywordsSource:'imported:cnki'},
    {...base, title:'没有关键词的论文', abstract:'本文考察了语用能力的发展。', keywords:[]},
  ]);
  const p1=store.get("SELECT * FROM papers WHERE title='带统计量的中文论文'");
  const p2=store.get("SELECT * FROM papers WHERE title='没有摘要的论文'");
  const p3=store.get("SELECT * FROM papers WHERE title='没有关键词的论文'");

  console.log('=== 1. 翻译与缓存 ===');
  const r1=await tr.translate({paperId:p1.id,field:'abstract'});
  ok('翻译成功', r1.ok, r1.error);
  ok('记录了模型与时间', r1.model==='mock' && !!r1.createdAt);
  const before=calls;
  const r2=await tr.translate({paperId:p1.id,field:'abstract'});
  ok('第二次复用已保存译文（cached）', r2.cached===true, 'cached='+r2.cached);
  ok('未再次调用模型', calls===before, `调用数 ${before}→${calls}`);
  ok('译文写入数据库', (store.get("SELECT COUNT(*) c FROM translations WHERE paper_id=? AND field='abstract' AND status='ok'",[p1.id]).c)===1);

  console.log('=== 2. 数字保真校验 ===');
  const chk=tr.verifyNumbers('F(1, 22) = 6.41, p = .019, 24 participants, 2024','译文没有保留这些数字');
  ok('能检出丢失的统计量', chk.ok===false && chk.missing.length>0, JSON.stringify(chk.missing));
  const chk2=tr.verifyNumbers('p = .019','结果 p = .019 显著');
  ok('数字保留时不误报', chk2.ok===true);

  console.log('=== 3. 原文变化使旧译文失效 ===');
  const h1=tr.hash('原文A'), h2=tr.hash('原文B');
  ok('不同原文指纹不同', h1!==h2);
  const oldCount=store.get("SELECT COUNT(*) c FROM translations WHERE paper_id=? AND field='abstract'",[p1.id]).c;
  store.run('UPDATE papers SET abstract=? WHERE id=?',['改成了完全不同的摘要内容，包含 p = .019。',p1.id]);
  const r3=await tr.translate({paperId:p1.id,field:'abstract'});
  const newCount=store.get("SELECT COUNT(*) c FROM translations WHERE paper_id=? AND field='abstract'",[p1.id]).c;
  ok('原文变化后重新翻译（不是复用旧译文）', r3.ok===true && r3.cached!==true, 'cached='+r3.cached);
  ok('旧译文记录保留、新译文是另一条', newCount>oldCount, `${oldCount}→${newCount}`);

  console.log('=== 4. 无摘要 / 无关键词 ===');
  const a2=await tr.translate({paperId:p2.id,field:'abstract'});
  ok('无摘要时明确拒绝', a2.ok===false && a2.available===false, a2.error);
  ok('无摘要时不写入翻译记录', store.get("SELECT COUNT(*) c FROM translations WHERE paper_id=? AND field='abstract'",[p2.id]).c===0);
  const k3=await tr.translate({paperId:p3.id,field:'keywords'});
  ok('无关键词时提示「原始数据未提供关键词」', k3.ok===false && k3.error==='原始数据未提供关键词', k3.error);
  const st3=tr.statusForPaper(p3.id);
  ok('工作台主题标签不冒充作者关键词', st3.keywords.items.length===0 && st3.keywords.available===false);
  ok('单独列出工作台主题标签', Array.isArray(st3.workbenchTopics.items) && /不是作者关键词/.test(st3.workbenchTopics.caveat));

  console.log('=== 5. 失败可重试、原文保留 ===');
  const prev=config.getSettings().aiBaseUrl;
  config.updateSettings({aiBaseUrl:'http://127.0.0.1:1'});
  const f=await tr.translate({paperId:p1.id,field:'title',force:true});
  ok('失败时返回可重试标记', f.ok===false && f.retryable===true, f.error?.slice(0,60));
  ok('失败时保留原文', f.sourceText==='带统计量的中文论文', f.sourceText);
  ok('失败写入 failed 记录供重试', store.get("SELECT COUNT(*) c FROM translations WHERE paper_id=? AND field='title' AND status='failed'",[p1.id]).c===1);
  config.updateSettings({aiBaseUrl:prev});

  console.log('=== 6. 中文题录导入解析 ===');
  const mixed=`张三. 汉语学习者语用能力发展研究[J]. 世界汉语教学, 2023, 37(2): 215-228.
RT Journal Article
A1 陈七
T1 人机协同教学中的教师角色研究
JF 中国电化教育
YR 2024
K1 人机协同;教师角色
AB 本研究探讨人机协同教学环境下教师角色的转变。`;
  const mi=cnimp.parseImport(mixed);
  ok('混合格式全部解析', mi.ok && mi.records.length===2, '条数='+mi.records?.length);
  ok('GB/T 记录字段正确', mi.records.some(r=>r.journalName==='世界汉语教学'&&r.volume==='37'&&r.issue==='2'));
  ok('RefWorks 记录带关键词与摘要', mi.records.some(r=>r.keywords.length===2&&r.abstract));
  ok('无法识别时报错', cnimp.parseImport('随便一段文字').ok===false);
  ok('CSV（中文表头）可解析', cnimp.parseImport('题名,刊名,作者,年\n测试篇名,中国语文,甲,2024').records.length===1);

  const pass=R.filter(x=>x.ok).length;
  console.log('\n'+'═'.repeat(52));
  console.log(`  翻译与中文导入测试：${pass} 项通过，${R.length-pass} 项失败，共 ${R.length} 项`);
  console.log('═'.repeat(52));
  for(const x of R.filter(y=>!y.ok)) console.log('  ❌ '+x.n+(x.d?' — '+x.d:''));
  mock.close(); fs.rmSync(T,{recursive:true,force:true});
  process.exit(R.length-pass?1:0);
})().catch(e=>{console.error('异常:',e);mock.close();process.exit(2);});
