'use strict';
/**
 * 参考名录与官方目录的优先级回归测试。
 * 覆盖两个已修复的真实缺陷：
 *   1. 载入参考分区名录不得把官方目录的合格结论降级为 reference（loadJcrReference 曾改写官方条目）；
 *   2. 全新数据库上，只有参考名录记录的期刊应得到 reference（而非 pending）。
 * 运行：node test/reference-precedence.js
 */
const fs=require('fs'),path=require('path'),os=require('os');
const T=fs.mkdtempSync(path.join(os.tmpdir(),'litdesk-b1-'));
process.env.LITDESK_DATA_DIR=T;
const ROOT=require('path').resolve(__dirname,'..');
process.chdir(ROOT);
const store=require('../lib/store');const j=require('../lib/journals');const cfg=require('../lib/config');
const R=[]; const ok=(n,c,d)=>{R.push({n,ok:!!c,d}); console.log(`  ${c?'✅':'❌'} ${n}${d?'  — '+d:''}`);};
store.migrate();j.loadSeedReference();
// 官方导入 Applied Linguistics，标 SSCI
const r=j.importCatalog('ssci_jcr',"期刊名称,ISSN,JCR年份,JCR学科类别1,分区1,收录数据库\nApplied Linguistics,0142-6001,2024,LINGUISTICS,Q1,SSCI",{edition:'2024',sourceName:'机构JCR目录'});
const before=j.eligibilityOf(j.findJournal({issn:'0142-6001'}),cfg.getSettings());
ok('官方 JCR+SSCI 导入后该刊合格', before.status==='eligible' && before.basis==='official', `${before.status}/${before.basis}`);
// 再载入参考名录
const ref=j.loadJcrReference();
const after=j.eligibilityOf(j.findJournal({issn:'0142-6001'}),cfg.getSettings());
ok('载入参考名录后官方合格结论未被降级', after.status==='eligible' && after.basis==='official', `${after.status}/${after.basis}`);
const row=j.findJournal({issn:'0142-6001'});
ok('官方 ssci_jcr 条目未被改写成参考条目', JSON.parse(row.catalogs).filter(c=>c.catalogKey==='ssci_jcr').every(c=>c.reference!==true));
const jcr=JSON.parse(row.jcr);
ok('jcr 字段仍来自官方目录', jcr.reference!==true, jcr.source);
// BUG2：全新库上的参考名录刊应得到 reference
const q=j.eligibilityOf(j.findJournal({issn:'0039-8322'}),cfg.getSettings());
ok('全新库上仅参考名录的刊得到 reference（不是 pending）', q.status==='reference', `实际 ${q.status}`);
ok('参考条目不会被计为已核验', j.findJournal({issn:'0039-8322'}).verified===0);
ok('参考结果不计入「期刊条件合格」', q.basis==='reference' && q.officialEligible===false);

const pass=R.filter(x=>x.ok).length;
console.log('\n'+'═'.repeat(52));
console.log(`  参考名录优先级回归：${pass} 项通过，${R.length-pass} 项失败，共 ${R.length} 项`);
console.log('═'.repeat(52));
fs.rmSync(T,{recursive:true,force:true});
process.exit(R.length-pass?1:0);
