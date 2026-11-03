'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'DPA 中文 & (启动) ')),root=path.join(dir,'程序'),data=path.join(dir,'个人 数据');
 fs.mkdirSync(root);for(const name of ['lib','public','scripts','catalogs','server.js','package.json','package-lock.json','启动工作台.cmd'])fs.cpSync(path.join(__dirname,'..',name),path.join(root,name),{recursive:true});
 // Excel is installed in CI; preserve a real dependency tree, avoiding network installation in this test.
 fs.cpSync(path.join(__dirname,'..','node_modules'),path.join(root,'node_modules'),{recursive:true});
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const env={...process.env,LITDESK_RUNTIME_DIR:root,LITDESK_DATA_DIR:data,LITDESK_PORT:String(port),LITDESK_NO_AUTORUN:'1',DPA_NO_BROWSER:'1'};
 const windows=process.platform==='win32';
 const child=spawn(windows?'cmd.exe':process.execPath,windows?['/d','/c','启动工作台.cmd']:['scripts/launch.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 try{
  let healthy=false;for(let i=0;i<160;i++){if(child.exitCode!==null)break;try{const h=await(await fetch('http://127.0.0.1:'+port+'/api/health')).json();assert.equal(h.dbFile,path.join(data,'litdesk.db'));healthy=h.ok;if(healthy)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(healthy,'real launcher must support in-place runtime and special-character paths: '+output);
  console.log('Real launcher passed: Chinese, spaces, ampersand, parentheses, in-place runtime, isolated data.');
 }finally{
  if(windows){const {spawnSync}=require('node:child_process');spawnSync('taskkill',['/pid',String(child.pid),'/t','/f']);}else child.kill('SIGTERM');
  if(child.exitCode===null)await new Promise(r=>child.once('exit',r));
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
