/* 个人阅读体验：页面偏好、分类、显式浏览、恢复位置、项目标签与撤销。 */
'use strict';
const readerUI = { prefs: {}, data: null, overview: null, update: null, since: null, category: '', browse: '', sinceOnly: false,
  lastList: null, restore: false, lastDiscovery: null, libraryTag: '' };
async function installReader() {
  const rawApi = api;
  try { readerUI.prefs = JSON.parse(localStorage.getItem('litdesk.reader.preferences') || '{}'); } catch {}
  const [visit,data,overview,update] = await Promise.all([
    rawApi('/api/reader/visit',{method:'POST'}), rawApi('/api/reader'),
    Promise.resolve(null),rawApi('/api/reader/update-status')]);
  readerUI.since = visit.previous;
  readerUI.data = data.ok ? data : {papers:{},tags:[],undo:[]};
  readerUI.overview = overview; readerUI.update = update;
  // 同一标签页刷新沿用本次会话的“上次访问”，不会刷新一次就把未看的新增清零。
  let session;
  try { session = JSON.parse(sessionStorage.getItem('litdesk.reader.session') || 'null'); } catch {}
  if (session) readerUI.since = session.since;
  else sessionStorage.setItem('litdesk.reader.session',JSON.stringify({since:readerUI.since}));
  applyReaderPrefs();
  // 所有原有收藏/已读/判断按钮接入可撤销的持久化操作，不改变其原有意义。
  api = async function(path,opts={}) {
    if (path.startsWith('/api/desk/discovery?')) {
      const u = new URL(path,location.origin);
      if (readerUI.category) u.searchParams.set('category',readerUI.category);
      if (readerUI.browse) u.searchParams.set('browse',readerUI.browse);
      if (readerUI.sinceOnly && readerUI.since) u.searchParams.set('since',readerUI.since);
      const result = await rawApi(u.pathname+u.search,opts); readerUI.lastDiscovery=result; return result;
    }
    if (path.startsWith('/api/library?')) {
      const u = new URL(path,location.origin);
      if(readerUI.libraryTag) u.searchParams.set('tag',readerUI.libraryTag);
      const r=await rawApi(u.pathname+u.search,opts);
      if(r.ok && state.view==='library') updateReaderLibraryStats(r.stats);
      return r;
    }
    const star=path.match(/^\/api\/library\/star\/(\d+)$/), read=path.match(/^\/api\/library\/read\/(\d+)$/), judge=path.match(/^\/api\/judgments\/(\d+)$/);
    if (opts.method==='POST' && (star || read || judge)) {
      const id=Number((star || read || judge)[1]); let value=opts.body?.value;
      if (star && value===undefined) { const p=await rawApi('/api/papers/'+id); value=!p.paper?.library?.starred; }
      const kind=star?'starred':read?'read_state':'judgment';
      if (read) value=opts.body.read_state; if (judge) value=opts.body.decision;
      const r=await rawApi('/api/reader/action',{method:'POST',body:{kind,ids:[id],value}});
      if (r.ok) { await refreshReaderData(); showReaderUndo(r.undoId); syncCachedLists(id,kind,value); }
      return {...r,starred:kind==='starred'?value:undefined,read_state:kind==='read_state'?value:undefined,decision:kind==='judgment'?value:undefined};
    }
    return rawApi(path,opts);
  };
  const shell=discoveryShell;
  discoveryShell = d => {
    if(!readerUI.category && !readerUI.browse && !readerUI.sinceOnly && !hasActiveFilter()) readerUI.overview=d;
    const c=readerUI.overview?.categories || d.categories || [];
    const total=readerUI.overview?.total ?? d.total;
    const tiles=`<div class="category-grid" aria-label="研究分类"><button class="category-tile all ${!readerUI.category?'selected':''}" aria-pressed="${!readerUI.category}" onclick="chooseReaderCategory('')"><strong>全部文献</strong><span>${total} 篇 · 全部去重</span></button>`+
      c.map(x=>`<button class="category-tile ${esc(x.color)} ${readerUI.category===x.id?'selected':''}" aria-pressed="${readerUI.category===x.id}" onclick="chooseReaderCategory('${attr(x.id)}')"><strong>${esc(x.name)}</strong><span>${x.total} 篇 · 今日新增 ${x.new}</span></button>`).join('')+'</div>';
    const bar=`<div class="reader-discovery-bar"><button class="btn ${readerUI.sinceOnly?'primary':''}" onclick="toggleSinceReader()" ${readerUI.since?'':'disabled'}>自上次访问以来新增</button>
      <label>浏览范围 <select aria-label="浏览范围" onchange="chooseReaderBrowse(this.value)"><option value="" ${!readerUI.browse?'selected':''}>全部 · 未浏览优先</option><option value="unseen" ${readerUI.browse==='unseen'?'selected':''}>尚未浏览</option><option value="seen" ${readerUI.browse==='seen'?'selected':''}>已经浏览</option></select></label>
      <button class="btn" onclick="markReaderBatch()">这批已浏览</button><span class="muted small">${readerUI.sinceOnly?'新增起点：'+esc(fmtBeijing(readerUI.since)):'分类可交叉，浏览标记由你主动设置'}</span></div>`;
    return readerUpdateHtml()+tiles+bar+shell(d);
  };
  const card=discoveryCardHtml, briefCard=briefCardHtml;
  discoveryCardHtml = it => addReaderCard(card(it),it);
  briefCardHtml = it => addReaderCard(briefCard(it),it);
  const view=viewDiscovery;
  viewDiscovery = async function(reset=true) {
    const saved=readerUI.lastList;
    if (readerUI.restore && reset && saved?.view==='discovery') {
      readerUI.restore=false;
      Object.assign(discoveryState,saved.discovery);
      Object.assign(readerUI,saved.filters);
      $('#main').innerHTML=saved.html; restoreReaderControls(saved);
      readerUI.lastDiscovery=saved.result;
      indexTrItems(discoveryState.items); observeTranslationLazy();
      requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo(0,saved.scroll)));
      renderReaderToolbar(); return;
    }
    await view(reset); renderReaderToolbar();
  };
  const more=loadMoreDiscovery;
  loadMoreDiscovery = async function(btn) {
    const oldPage=discoveryState.page;
    try { await more(btn); } catch(e) { discoveryState.page=oldPage; discoveryState.loading=false; toast('加载失败，可重试',true); }
  };
  const goToPaper=goPaper;
  goPaper = id => { saveReaderList(); return goToPaper(id); };
  const paper=viewPaper;
  viewPaper = async function(id,opts) {
    const saved=readerUI.lastList;
    readerUI.restore=Boolean(saved);
    await paper(id,opts);
    if (state.currentPaper?.id!==id) return;
    // 只记继续阅读位置；打开详情不自动标记浏览、在读或已读。
    const r=await api('/api/reader/resume',{method:'POST',body:{id}});
    if (r.ok) readerUI.data.lastReading={id,title:state.currentPaper.title};
    const row=document.createElement('div'); row.className='reader-paper-actions';
    row.innerHTML=`<button class="btn" onclick="returnReaderList()">← 返回原列表</button>${readerPaperActions(id)}`;
    $('#main').prepend(row); renderReaderToolbar();
  };
  const lib=viewLibrary;
  viewLibrary = async function() { await lib(); addReaderLibraryFilter(); await loadLibraryList(); };
  const list=loadLibraryList;
  loadLibraryList = async function() {
    await list(); addReaderLibraryFilter();
    $$('#libList .card').forEach(card=> {
      const a=card.querySelector('a[href^="#/paper/"]'); const id=Number(a?.getAttribute('href')?.split('/').pop());
      if (id && !card.querySelector('.reader-paper-actions')) {
        const row=document.createElement('div'); row.className='reader-paper-actions'; row.innerHTML=readerPaperActions(id); card.append(row);
      }
    });
  };
  // 其余列表也保存位置；返回时使用 DOM 副本，避免丢失当前筛选和长列表。
  for (const [name,fn] of [['brief',viewBrief],['library',viewLibrary],['qualified',viewQualified],['search',viewSearch],['judgments',viewJudgments]]) {
    const wrapper=async (...args)=> {
      const saved=readerUI.lastList;
      if (readerUI.restore && saved?.view===name) {
        readerUI.restore=false; $('#main').innerHTML=saved.html; restoreReaderControls(saved);
        if(name==='library') {const r=await rawApi('/api/library');if(r.ok)updateReaderLibraryStats(r.stats);}
        requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo(0,saved.scroll)));
        renderReaderToolbar(); return;
      }
      readerUI.restore=false; await fn(...args); renderReaderToolbar();
    };
    if(name==='brief') viewBrief=wrapper;
    else if(name==='library') viewLibrary=wrapper;
    else if(name==='qualified') viewQualified=wrapper;
    else if(name==='search') viewSearch=wrapper;
    else viewJudgments=wrapper;
  }
  renderReaderToolbar();
}
function applyReaderPrefs() {
  const p=readerUI.prefs;
  p.zoom=Math.max(80,Math.min(150,Number(p.zoom)||100)); p.font=Math.max(14,Math.min(22,Number(p.font)||16));
  p.mode=p.mode==='scan'?'scan':'full';
  document.documentElement.style.zoom=p.zoom/100;
  document.documentElement.style.setProperty('--reader-font',p.font+'px');
  document.body.classList.toggle('reader-scan',p.mode==='scan');
  document.body.classList.toggle('sidebar-collapsed',Boolean(p.collapsed));
  const toggle=$('#drawerToggle');toggle.textContent=p.collapsed?'☰':'‹';toggle.setAttribute('aria-label',p.collapsed?'展开侧栏':'收起侧栏');toggle.setAttribute('aria-expanded',String(!p.collapsed));
  const side=$('#readerSidebar');side.inert=Boolean(p.collapsed);side.setAttribute('aria-hidden',String(Boolean(p.collapsed)));
}
function setReaderPref(key,value) {
  readerUI.prefs[key]=value; applyReaderPrefs();
  localStorage.setItem('litdesk.reader.preferences',JSON.stringify(readerUI.prefs)); renderReaderToolbar();
}
function renderReaderToolbar() {
  const p=readerUI.prefs, resume=readerUI.data?.lastReading;
  $('#readerToolbar').innerHTML=`<div class="reader-controls-title">阅读设置</div>
    <div class="reader-zoom"><button class="btn small" aria-label="缩小页面" onclick="setReaderPref('zoom',readerUI.prefs.zoom-10)">−</button><output aria-label="页面缩放比例">${p.zoom}%</output><button class="btn small" aria-label="放大页面" onclick="setReaderPref('zoom',readerUI.prefs.zoom+10)">＋</button><button class="btn ghost small" onclick="setReaderPref('zoom',100)">重置</button></div>
    <label>字号 <select aria-label="阅读字号" onchange="setReaderPref('font',Number(this.value))">${[14,16,18,20,22].map(n=>`<option value="${n}" ${n===p.font?'selected':''}>${n}</option>`).join('')}</select></label>
    <label>模式 <select aria-label="阅读模式" onchange="setReaderPref('mode',this.value)"><option value="scan" ${p.mode==='scan'?'selected':''}>紧凑（全文）</option><option value="full" ${p.mode==='full'?'selected':''}>舒展（全文）</option></select></label>
    ${resume?`<button class="btn small" title="${attr(resume.title)}" onclick="goPaper(${resume.id})">继续上次阅读</button>`:''}
    <button class="btn small" onclick="showReaderHistory()">撤销与浏览记录</button>`;
}
function readerUpdateHtml() {
  const u=readerUI.update;
  if (!u?.at) return '<div class="reader-update">尚未生成更新记录</div>';
  const reason={scheduled:'定时更新',catchup:'打开后补做',manual:'手动更新','first-run':'首次更新'}[u.reason]||u.reason||'未知方式';
  return `<div class="reader-update"><span>最近更新：${esc(fmtBeijing(u.at))} · ${esc(reason)} · ${esc(u.label)} · ${u.newCount===null?'新增数量未记录':'新增 '+u.newCount+' 篇'} · 推荐 ${u.recommended || 0} 篇${u.reused?' · 使用已有文献推荐':''}${u.historyIncomplete?' · 历史采集记录不完整':''}</span>
    ${u.failures?.length?`<details><summary>来源异常 ${u.failures.length} 项</summary>${u.failures.map(x=>`<p>${esc(x.source)}：${esc(x.message)}</p>`).join('')}</details>`:''}</div>`;
}
function addReaderCard(html,it) {
  const r=readerUI.data?.papers?.[it.id]||{}, tags=r.tags||[];
  const actions=`<div class="reader-card-meta"><span class="reader-status">${r.browsedAt?'已浏览':'未浏览'} · ${{read:'已读',reading:'在读',unread:'待读',none:'未设置阅读状态'}[it.read_state]||'未设置阅读状态'}</span>${tags.map(t=>`<span class="tag project">${esc(t)}</span>`).join('')}</div>`;
  return html.replace('</article>',actions+`<div class="reader-paper-actions">${readerPaperActions(it.id)}</div></article>`);
}
function readerPaperActions(id) {
  const r=readerUI.data?.papers?.[id]||{};
  return `${(r.tags||[]).map(t=>`<span class="tag project">${esc(t)}</span>`).join('')}<button class="btn small" onclick="markReaderPaper(${id},${!r.browsedAt})">${r.browsedAt?'恢复未浏览':'标记已浏览'}</button><button class="btn small" onclick="editReaderTags(${id})">研究项目 / 标签</button>`;
}
function toggleReaderAbstract(btn) {
  const box=btn.closest('.reader-abstract'); box.classList.toggle('expanded'); btn.textContent=box.classList.contains('expanded')?'收起摘要':'展开完整摘要';
}
async function chooseReaderCategory(id) { readerUI.restore=false; readerUI.category=id; await viewDiscovery(true); window.scrollTo(0,0); }
async function chooseReaderBrowse(value) { readerUI.restore=false; readerUI.browse=value; await viewDiscovery(true); }
async function toggleSinceReader() {
  if (!readerUI.since) { toast('首次访问已记录，下次打开可查看新增'); return; }
  readerUI.restore=false; readerUI.sinceOnly=!readerUI.sinceOnly;
  if (readerUI.sinceOnly) discoveryState.days=String(Math.max(60,Math.ceil((Date.now()-new Date(readerUI.since))/86400000)+1));
  await viewDiscovery(true);
}
async function refreshReaderData() { const d=await api('/api/reader'); if(d.ok) readerUI.data=d; renderReaderToolbar(); }
function showReaderUndo(id) {
  let box=$('#readerUndo'); if(!box) { box=document.createElement('div');box.id='readerUndo';box.className='reader-undo';document.body.append(box); }
  box.innerHTML=`操作已保存 <button class="btn small" onclick="undoReaderAction(${id})">撤销</button><button class="btn ghost small" aria-label="关闭撤销提示" onclick="document.getElementById('readerUndo').remove()">×</button>`;
}
function syncCachedLists(id,kind,value) {
  for (const arr of [discoveryState.items,readerUI.lastList?.discovery?.items]) {
    if(!arr) continue; const p=arr.find(p=>p.id===id); if(!p) continue;
    if(kind==='starred') p.starred=value; if(kind==='read_state') p.read_state=value; if(kind==='judgment') p.judgment=value==='cleared'?null:value;
  }
  if (readerUI.lastList) {
    // 状态变化后重新渲染原发现列表，保留过滤器、已加载页数与滚动位置。
    if (readerUI.lastList.view==='discovery') {
      const dom=document.createElement('div'); dom.innerHTML=readerUI.lastList.html;
      const card=dom.querySelector(`[data-paper-id="${id}"]`), p=readerUI.lastList.discovery.items.find(x=>x.id===id);
      if(card && p) { card.outerHTML=discoveryCardHtml(p); readerUI.lastList.html=dom.innerHTML; }
    } else {
      const dom=document.createElement('div'); dom.innerHTML=readerUI.lastList.html;
      // 其他列表也保留筛选、页数和位置；只同步这一篇的操作状态。
      const link=dom.querySelector(`a[href="#/paper/${id}"]`);
      const card=link?.closest('.card,article');
      if(card) {
        if(kind==='starred') card.querySelectorAll('button[onclick^="toggleStar("]').forEach(btn=>{
          btn.textContent=value?'★ 已收藏':'☆ 收藏';btn.classList.toggle('primary',value);
          btn.setAttribute('onclick',`toggleStar(${id}, ${!value}, this)`);
        });
        if(kind==='read_state') {
          const label={read:'已读',reading:'在读',unread:'待读'}[value];
          const status=card.querySelector('.reader-status');
          if(status) status.textContent=status.textContent.split(' · ')[0]+' · '+label;
          card.querySelectorAll('.tag').forEach(tag=>{if(['已读','在读','待读'].includes(tag.textContent.trim()))tag.textContent=label;});
        }
        if(kind==='read_state') card.querySelectorAll('button[onclick^="setRead("]').forEach(btn=>{
          btn.textContent=value==='read'?'标为待读':'标记已读';
          btn.setAttribute('onclick',`setRead(${id}, '${value==='read'?'unread':'read'}', this)`);
        });
        const actions=card.querySelector('.reader-paper-actions');
        if(actions) actions.innerHTML=readerPaperActions(id);
        readerUI.lastList.html=dom.innerHTML;
      }
    }
  }
}
async function readerAction(kind,ids,value) {
  const r=await api('/api/reader/action',{method:'POST',body:{kind,ids,value}});
  if(!r.ok) { toast(r.error,true);return; }
  await refreshReaderData(); showReaderUndo(r.undoId);
  ids.forEach(id=>syncCachedLists(id,kind,value));
  if(state.view==='discovery') {
    if(readerUI.browse) await viewDiscovery(true); else renderDiscoveryList(readerUI.lastDiscovery);
  } else if(state.view==='library') await loadLibraryList();
  else if(state.view==='paper') await viewPaper(state.currentPaper.id);
  return r;
}
async function markReaderPaper(id,value) { await readerAction('browsed',[id],value); }
async function markReaderBatch() { await readerAction('browsed',discoveryState.items.map(p=>p.id),true); }
async function undoReaderAction(id) {
  const r=await api('/api/reader/undo/'+id,{method:'POST'});
  if(!r.ok) { toast(r.error,true);return; }
  readerUI.lastList=null; readerUI.restore=false; await refreshReaderData(); $('#readerUndo')?.remove(); closeModal();
  await render(); toast('已撤销');
}
function showReaderHistory() {
  const history=readerUI.data?.undo||[];
  const labels={browsed:'浏览标记',tags:'项目标签',starred:'收藏操作',read_state:'阅读状态',judgment:'阅读判断'};
  openModal(`<h2>撤销与浏览记录</h2><p class="muted">浏览、收藏和已读分别记录；你可以撤销最近操作，也可查看并恢复已浏览文献。</p><div class="btn-row"><button class="btn" onclick="closeModal();chooseReaderBrowse('seen');go('discovery')">查看已浏览文献</button><button class="btn" onclick="closeModal();chooseReaderBrowse('unseen');go('discovery')">查看未浏览文献</button></div><div class="sep"></div>${history.map(x=>`<div class="reader-history-row"><span>${esc(labels[x.kind]||x.kind)} · ${esc(fmtBeijing(x.at))}</span><button class="btn small" onclick="undoReaderAction(${x.id})">撤销</button></div>`).join('')||'<p>还没有可撤销的操作</p>'}`);
}
function editReaderTags(id) {
  const current=readerUI.data?.papers?.[id]?.tags||[];
  openModal(`<h2>研究项目 / 标签</h2><p>一篇文献可属于多个研究项目。每行一个名称，不改变你的收藏和备注。</p><textarea id="readerTags" aria-label="研究项目标签" rows="5">${esc(current.join('\n'))}</textarea><p class="small muted">已有标签：${esc((readerUI.data?.tags||[]).join('、')||'暂无')}</p><div class="btn-row"><button class="btn primary" onclick="saveReaderTags(${id})">保存标签</button><button class="btn" onclick="closeModal()">取消</button></div>`);
}
async function saveReaderTags(id) { const tags=$('#readerTags').value.split(/\n|,|，/).map(t=>t.trim()).filter(Boolean);closeModal();await readerAction('tags',[id],tags); }
function addReaderLibraryFilter() {
  $('#readerProjectFilter')?.remove();
  const row=document.createElement('div');row.id='readerProjectFilter';row.className='reader-discovery-bar';
  row.innerHTML=`<label>研究项目 <select aria-label="收藏研究项目" onchange="readerUI.libraryTag=this.value;loadLibraryList()"><option value="">全部项目</option>${(readerUI.data?.tags||[]).map(t=>`<option value="${attr(t)}" ${t===readerUI.libraryTag?'selected':''}>${esc(t)}</option>`).join('')}</select></label><span class="muted small">同一文献可放进多个项目，个人备注照常保留</span>`;
  $('#main').insertBefore(row,$('#libList'));
}
function saveReaderList() {
  if(state.view==='paper') return;
  const filters={category:readerUI.category,browse:readerUI.browse,sinceOnly:readerUI.sinceOnly};
  readerUI.lastList={view:state.view,html:$('#main').innerHTML,scroll:window.scrollY,
    discovery:structuredClone(discoveryState),filters,result:readerUI.lastDiscovery,
    controls:$$('#main input[id],#main select[id],#main textarea[id]').map(el=>({id:el.id,value:el.value,checked:el.checked}))};
}
function returnReaderList() { go(readerUI.lastList?.view || 'discovery'); }

function restoreReaderControls(saved) {
  for(const c of saved.controls||[]) {const el=document.getElementById(c.id);if(el){el.value=c.value;if(typeof c.checked==='boolean')el.checked=c.checked;}}
}

function updateReaderLibraryStats(stats) {
  if(!stats)return;
  const keys=['starred','unread','reading','read','interpretations','eligiblePapers','referencePapers'];
  $$('#main .stat-row .stat b').forEach((el,i)=>{if(keys[i])el.textContent=stats[keys[i]]||0;});
}

document.addEventListener('keydown',event=>{if(event.key==='Escape' && !readerUI.prefs.collapsed)setReaderPref('collapsed',true);});
