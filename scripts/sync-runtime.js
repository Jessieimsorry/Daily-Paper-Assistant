'use strict';
// 将可执行文件同步到应用支持目录；正式数据库只保留一个活动位置。
// 不复制密钥到代码目录，不覆盖既有备份，不需要扩大全盘访问权限。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..');
const home=require('../lib/platform').home();
const runtime=path.join(home,'runtime'),data=path.join(home,'data');
fs.mkdirSync(home,{recursive:true,mode:0o700});fs.mkdirSync(runtime,{recursive:true,mode:0o700});
const sourceData=path.join(root,'data');
if (!fs.lstatSync(sourceData).isSymbolicLink()) {
  if (fs.existsSync(data)) throw new Error('应用支持目录已有数据。请先核对，不能自动覆盖。');
  fs.cpSync(sourceData,data,{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const preserved=path.join(root,'data-before-runtime-'+stamp);
  fs.renameSync(sourceData,preserved);fs.symlinkSync(data,sourceData,'dir');
  fs.writeFileSync(path.join(home,'data-migration.json'),JSON.stringify({root,data,preserved,at:new Date().toISOString()},null,2),{mode:0o600});
  console.log('已保留迁移前数据副本：'+preserved);
} else if (fs.realpathSync(sourceData)!==fs.realpathSync(data)) {
  throw new Error('项目数据链接指向其他位置，请人工核对后同步。');
}
for (const name of ['lib','public','catalogs','server.js','package.json','package-lock.json']) fs.cpSync(path.join(root,name),path.join(runtime,name),{recursive:true,force:true});
if(fs.existsSync(path.join(root,'node_modules'))&&!fs.existsSync(path.join(runtime,'node_modules','exceljs')))fs.cpSync(path.join(root,'node_modules'),path.join(runtime,'node_modules'),{recursive:true});
fs.writeFileSync(path.join(home,'runtime-version.json'),JSON.stringify({source:root,at:new Date().toISOString()},null,2));
console.log('后台运行文件已同步：'+runtime);
console.log('活动数据：'+data);
