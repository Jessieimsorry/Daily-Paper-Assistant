'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('a slow previous page cannot overwrite the page selected afterwards',async()=>{
 const main={innerHTML:'',addEventListener(){}};
 const ctx=vm.createContext({document:{querySelector:()=>main,querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},location:{hash:'#/qualified'},setTimeout,clearTimeout,URLSearchParams,Uint8Array});
 vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'),'utf8').split('(async function boot()')[0],ctx);
 let resolve;ctx.pending=()=>new Promise(r=>resolve=r);
 vm.runInContext('api=pending',ctx);
 const old=vm.runInContext('viewQualified()',ctx);
 ctx.location.hash='#/search';main.innerHTML='搜索页面';
 resolve({ok:true,items:[],total:0});await old;
 assert.equal(main.innerHTML,'搜索页面');
});
test('restoring a saved discovery list does not duplicate region tabs and panel IDs',async()=>{
 const main={innerHTML:'papers',querySelector:()=>main.innerHTML.includes('id="dpaResearch"')?{}:null};
 const ctx=vm.createContext({document:{addEventListener(){}},state:{view:'discovery'}});
 ctx.$=()=>main;ctx.viewDiscovery=async()=>{};
 const source=fs.readFileSync(require.resolve('../public/customize.js'),'utf8');
 vm.runInContext(source,ctx);
 vm.runInContext(source.slice(source.indexOf('  const oldDiscovery ='),source.indexOf('  const oldPaper =')),ctx);
 await vm.runInContext('viewDiscovery()',ctx);
 await vm.runInContext('viewDiscovery()',ctx);
 assert.equal((main.innerHTML.match(/id="dpaResearch"/g)||[]).length,1);
});
