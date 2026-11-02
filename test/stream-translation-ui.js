'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('stream cards show translations finishing after the first status check without submitting twice',async()=>{
 const timers=[],el={isConnected:true,textContent:'',getBoundingClientRect:()=>({top:0,bottom:10})};
 let reads=0,submitted=0;
 const ctx=vm.createContext({document:{addEventListener(){},querySelector:s=>s.includes('data-stream-translation')?el:null},innerHeight:100,setTimeout:fn=>timers.push(fn)});
 vm.runInContext(fs.readFileSync(require.resolve('../public/customize.js'),'utf8'),ctx);
 ctx.api=async()=>({ok:true,subject:{abstract:'Original abstract'},translations:{title:{text:''},abstract:{text:++reads>=3?'迟到的译文':''}},reading:{}});
 ctx.noop=()=>{};ctx.submit=async()=>{submitted++;return {ok:true};};
 vm.runInContext('dpaAutoAgents=noop;dpaTranslate=submit',ctx);
 await vm.runInContext("dpaLoadStreamTranslation('science:1')",ctx);
 for(let n=0;n<4&&timers.length;n++)await timers.shift()();
 assert.equal(el.textContent,'迟到的译文');assert.equal(submitted,1);
});
