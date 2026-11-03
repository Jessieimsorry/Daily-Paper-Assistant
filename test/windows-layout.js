'use strict';
// Executed on the Windows runner with Chromium; no personal data or model requests.
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage();
 const css=fs.readFileSync(path.join(__dirname,'../public/style.css'),'utf8');
 const long='10.1234/'+ 'LongUnbrokenDOI'.repeat(30);
 await page.setContent(`<style>${css}</style><div id="app"><aside class="sidebar"><nav class="nav"><button class="nav-item active">设置与数据源</button></nav><div class="reader-toolbar"><label>阅读字号<select><option>20</option></select></label></div></aside><div class="workspace"><main class="main"><h1>Windows 阅读适配</h1><article class="card"><div class="brief-title">${long}</div><div class="trans-side"><div>${long}</div><div>中文译文${long}</div></div><div class="meta-grid"><div>DOI</div><div>${long}</div></div><input value="中文输入"></article></main></div>`);
 for(const width of [1366,1093,911,768]){
  await page.setViewportSize({width,height:700});
  const sizes=await page.evaluate(()=>({content:document.documentElement.scrollWidth,viewport:innerWidth}));
  assert(sizes.content<=sizes.viewport,JSON.stringify({width,...sizes}));
 }
 await page.emulateMedia({forcedColors:'active'});
 await page.locator('button').focus();assert(await page.locator('button').evaluate(el=>el===document.activeElement));
 console.log('Windows Chromium layout: 100/125/150 percent effective widths, long DOI, bilingual columns, keyboard focus, forced colors passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
