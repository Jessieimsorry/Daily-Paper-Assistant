'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function page(){
  const node={addEventListener(){}};
  const ctx=vm.createContext({document:{querySelector:()=>node,querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},setTimeout,clearTimeout,URLSearchParams,Uint8Array});
  vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'),'utf8').split('(async function boot()')[0],ctx);
  return ctx;
}
test('one-click translation publishes title before a pending abstract and restores button',async()=>{
  const ctx=page(), updates=[];let finish;
  ctx.button={disabled:false,textContent:'',innerHTML:''};
  ctx.mockApi=async(path,opts)=>{
    if(opts.body.all || opts.body.field==='abstract')await new Promise(r=>finish=r);
    return {ok:true,translated:'译文'};
  };
  ctx.update=async(id)=>updates.push(id);ctx.notify=()=>{};
  vm.runInContext('api=mockApi;reloadTranslations=update;toast=notify',ctx);
  const work=vm.runInContext('translateAll(7,false,button)',ctx);
  await new Promise(setImmediate);
  try{assert.ok(updates.length>0,'short fields should be visible while abstract is pending');assert.equal(ctx.button.disabled,true);}
  finally{finish?.();await work;}
  assert.equal(ctx.button.disabled,false);
});
test('network failure restores the single-field button and reports failure',async()=>{
  const ctx=page(),notices=[];
  ctx.button={disabled:false,textContent:'',innerHTML:''};ctx.fail=async()=>{throw Error('fixture offline');};ctx.notify=(m)=>notices.push(m);ctx.update=async()=>{};
  vm.runInContext('api=fail;toast=notify;reloadTranslations=update',ctx);
  await vm.runInContext("translateField(7,'title',false,button)",ctx);
  assert.equal(ctx.button.disabled,false);
  assert.ok(notices.some(m=>m.includes('fixture offline')));
});
