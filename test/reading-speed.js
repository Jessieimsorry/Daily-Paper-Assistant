'use strict';
// 隔离数据库与模拟模型，不消耗正式模型额度，不改个人数据。
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'litdesk-reading-speed-'));
process.env.LITDESK_DATA_DIR=dir;
const store=require('../lib/store');store.migrate();
const config=require('../lib/config'),discover=require('../lib/discover'),cats=require('../lib/categories'),desk=require('../lib/desk'),translate=require('../lib/translate'),ai=require('../lib/interpret');
const realCallModel=ai.callModel;
discover.seedTopicsIfEmpty();cats.seed();config.updateSettings({aiBaseUrl:'http://127.0.0.1:12345',aiModel:'test-fixture'});
let passed=0;
function check(name,fn){fn();passed++;console.log('PASS '+name);}
(async()=>{
  discover.importRecords(Array.from({length:5},(_,i)=>({title:'Second language acquisition experiment '+i,doi:'10.9999/speed.'+i,language:'en',abstract:'An empirical study of second language acquisition and learning.',keywords:['second language acquisition']})));
  const initial=desk.listDiscovery();const id=initial.items[0].id;
  require('../lib/reader').action('browsed',[id],true);require('../lib/library').toggleStar(id,true);
  check('复用主题缓存仍立即显示最新浏览和收藏',()=>{const p=desk.listDiscovery().items.find(p=>p.id===id);assert(p.browsed_at);assert(p.starred);});
  store.run('UPDATE papers SET title=?,abstract=?,keywords=?,source_queries=? WHERE id=?',['unrelated stone catalog','','[]','[]',id]);
  check('论文内容变化立即失效，不返回旧主题命中',()=>assert(!desk.listDiscovery().items.some(p=>p.id===id)));
  const remaining=desk.listDiscovery().items.map(p=>p.id);
  store.run('UPDATE topics SET enabled=0');
  check('编辑主题立即失效，不缓存过期分类',()=>assert.equal(desk.listDiscovery().total,0));
  let calls=0,active=0,peak=0;
  ai.callModel=async(messages,opts)=>{assert.equal(opts.thinking,false);calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,60));active--;return {ok:true,content:'这是隔离测试译文',model:'test-fixture',tokens:1};};
  const before=Date.now();const batch=await translate.translateBatch({paperIds:remaining.slice(0,3),limit:9});
  check('九个真实翻译任务并发但全站不超过四个',()=>{assert(batch.ok);assert.equal(batch.calls,9);assert(peak>=2&&peak<=4);assert(Date.now()-before<9*60);});
  const count=calls;await translate.translateBatch({paperIds:remaining.slice(0,3),limit:9});
  check('第二次读取完整缓存不再调用模型',()=>assert.equal(calls,count));
  const pid=remaining[3];const old=calls;
  await Promise.all([translate.translate({paperId:pid,field:'title'}),translate.translate({paperId:pid,field:'title'})]);
  check('两个窗口同篇同字段共享一次生成',()=>assert.equal(calls,old+1));
  ai.callModel=async()=>({ok:true,content:'只完成了开头',finishReason:'length'});
  const partial=await translate.translate({paperId:pid,field:'abstract'});
  check('模型截断不能保存成完整成功译文',()=>{assert.equal(partial.ok,false);assert.match(partial.error,/未生成完整译文/);assert.equal(translate.getSaved(pid,'abstract').status,'failed');});
  config.updateSettings({aiBaseUrl:'https://api.deepseek.com',aiModel:'deepseek-flash'});config.setSecret('deepseekApiKey','test-fixture');
  const originalFetch=global.fetch;let sent;
  global.fetch=async(url,opts)=>{sent=JSON.parse(opts.body);return {ok:true,json:async()=>({choices:[{message:{content:'隔离模拟回复'},finish_reason:'stop'}]})};};
  try {
    await realCallModel([{role:'user',content:'fixture'}],{thinking:false});
    check('翻译请求明确使用DeepSeek直接输出参数',()=>assert.equal(sent.thinking.type,'disabled'));
    await realCallModel([{role:'user',content:'fixture'}]);
    check('深入解读调用不被翻译设置改变',()=>assert.equal(sent.thinking,undefined));
  } finally {global.fetch=originalFetch;}
  console.log(passed+' reading speed checks passed');store.db.close();fs.rmSync(dir,{recursive:true,force:true});
})().catch(e=>{console.error(e);process.exitCode=1;});
