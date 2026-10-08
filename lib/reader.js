'use strict';
// 显式浏览与阅读状态互相独立；新增表不修改题录、来源、上传及原有收藏。
const store = require('./store');
store.db.exec(`CREATE TABLE IF NOT EXISTS reader_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS reader_papers (paper_id INTEGER PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
    browsed_at TEXT, tags TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS reader_undo (id INTEGER PRIMARY KEY, at TEXT, kind TEXT, snapshot TEXT, undone INTEGER DEFAULT 0);`);
function getState(key, fallback = null) { return store.parseJson(store.get('SELECT value FROM reader_state WHERE key=?',[key])?.value,fallback); }
function setState(key, value) { store.run('INSERT INTO reader_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,JSON.stringify(value)]); }
function states() { return Object.fromEntries(store.all('SELECT * FROM reader_papers').map(r => [r.paper_id,{browsedAt:r.browsed_at,tags:store.parseJson(r.tags,[])}])); }
function snapshot(id) { return { id, reader:store.get('SELECT * FROM reader_papers WHERE paper_id=?',[id]) || null,
  library:store.get('SELECT * FROM library WHERE paper_id=?',[id]) || null, judgment:store.get('SELECT * FROM judgments WHERE paper_id=?',[id]) || null }; }
function action(kind, ids, value) {
  ids = [...new Set((ids || []).map(Number))];
  if (!ids.length || ids.length > 1000 || ids.some(id => !Number.isInteger(id) || !store.get('SELECT id FROM papers WHERE id=?',[id]))) return {ok:false,error:'请提供有效论文编号（最多1000篇）'};
  if (!['browsed','tags','starred','read_state','judgment'].includes(kind)) return {ok:false,error:'未知操作'};
  if (kind==='tags' && (!Array.isArray(value) || value.length > 30 || value.some(t => typeof t !== 'string' || !t.trim() || t.length > 80))) return {ok:false,error:'标签需为不超过30个、每个80字以内的名称'};
  if (kind==='read_state' && !['unread','reading','read'].includes(value)) return {ok:false,error:'无效阅读状态'};
  if (kind==='judgment' && !['interested','muted','cleared'].includes(value)) return {ok:false,error:'无效阅读判断'};
  if (['browsed','starred'].includes(kind) && typeof value !== 'boolean') return {ok:false,error:'操作值必须为布尔值'};
  return store.tx(() => {
    const before = ids.map(snapshot);
    for (const id of ids) {
      if (kind==='browsed' || kind==='tags') {
        store.run('INSERT OR IGNORE INTO reader_papers(paper_id) VALUES(?)',[id]);
        if (kind==='browsed') store.run('UPDATE reader_papers SET browsed_at=? WHERE paper_id=?',[value ? store.nowIso() : null,id]);
        else store.run('UPDATE reader_papers SET tags=? WHERE paper_id=?',[JSON.stringify([...new Set(value.map(t=>t.trim()))]),id]);
      } else if (kind==='starred') require('./library').toggleStar(id,value);
      else if (kind==='read_state') require('./library').setReadState(id,value);
      else require('./judgments').setJudgment(id,value);
    }
    store.run('INSERT INTO reader_undo(at,kind,snapshot) VALUES(?,?,?)',[store.nowIso(),kind,JSON.stringify(before)]);
    const undoId = store.get('SELECT last_insert_rowid() id').id;
    return {ok:true,undoId,kind,ids,value};
  });
}
function undo(id) {
  const row = store.get('SELECT * FROM reader_undo WHERE id=? AND undone=0',[Number(id)]);
  if (!row) return {ok:false,error:'这项操作已撤销或不存在'};
  const oldIds = store.parseJson(row.snapshot,[]).map(r=>r.id);
  const later = store.all('SELECT snapshot FROM reader_undo WHERE id>? AND kind=? AND undone=0',[row.id,row.kind]);
  if (later.some(r=>store.parseJson(r.snapshot,[]).some(s=>oldIds.includes(s.id)))) return {ok:false,error:'这些论文后来还有同类操作，请先撤销较新的操作'};
  return store.tx(() => {
    // 只还原对应字段，撤销收藏不覆盖稍后写下的备注或阅读状态。
    for (const old of store.parseJson(row.snapshot,[])) {
      if (['browsed','tags'].includes(row.kind)) {
        store.run('INSERT OR IGNORE INTO reader_papers(paper_id) VALUES(?)',[old.id]);
        const field = row.kind==='browsed' ? 'browsed_at' : 'tags';
        store.run(`UPDATE reader_papers SET ${field}=? WHERE paper_id=?`,[old.reader?.[field] || (field==='tags'?'[]':null),old.id]);
      } else if (row.kind==='judgment') {
        if (old.judgment) require('./judgments').setJudgment(old.id,old.judgment.decision,{note:old.judgment.note,source:old.judgment.source});
        else require('./judgments').setJudgment(old.id,'cleared');
      } else {
        if (row.kind==='starred') require('./library').toggleStar(old.id,Boolean(old.library?.starred));
        else require('./library').setReadState(old.id,old.library?.read_state || 'unread');
      }
    }
    store.run('UPDATE reader_undo SET undone=1 WHERE id=?',[row.id]);
    return {ok:true,kind:row.kind};
  });
}
function visit() {
  const previous = getState('lastVisit');
  setState('lastVisit',store.nowIso());
  return {ok:true,previous,at:getState('lastVisit')};
}
function summary() {
  return {ok:true,papers:states(),lastReading:getState('lastReading'),lastVisit:getState('lastVisit'),
    tags:[...new Set(store.all('SELECT tags FROM reader_papers').flatMap(r=>store.parseJson(r.tags,[])))].sort(),
    undo:store.all('SELECT id,at,kind FROM reader_undo WHERE undone=0 ORDER BY id DESC LIMIT 10')};
}
function updateStatus() {
  const sch = require('./scheduler').status();
  const latest = store.get('SELECT * FROM brief_runs ORDER BY COALESCE(finished_at,started_at) DESC LIMIT 1');
  const last = sch.lastResult;
  if (last?.error && (!latest || new Date(last.at).getTime() >= new Date(latest.finished_at || latest.started_at).getTime())) {
    return {at:last.at,reason:last.reason,status:'failed',label:'更新失败',newCount:null,recommended:latest?.selected_count || 0,
      failures:[{source:'更新流程',message:last.error}],sourceCounts:0,reused:Boolean(latest),historyIncomplete:false,
      scheduledDone:sch.scheduledDone,nextAt:sch.nextAt};
  }
  if (!latest) return {at:null,status:'none',label:'尚未更新',reason:null,newCount:null,failures:[],scheduledDone:sch.scheduledDone};
  const at = latest.finished_at || latest.started_at;
  const start = require('./time').toIsoUtc(latest.started_at);
  const matched = last && last.at && new Date(last.at).getTime() >= new Date(start).getTime()
    && new Date(last.at).getTime() - new Date(at).getTime() < 60000;
  const failures = matched ? (last.collected?.failures || []) : [];
  const collectionStart = matched ? last.startedAt || sch.lastAttemptAt || start : start;
  const sourceCounts = store.get('SELECT COUNT(*) n FROM ingest_log WHERE at>=? AND at<=?',[collectionStart,require('./time').toIsoUtc(at)]).n;
  return {at,reason:latest.reason,status:latest.status,label:matched && last.collected?.sourcesFailed?'来源全部失败':failures.length?'部分来源失败':({ok:'已完成',partial:'部分完成',failed:'更新失败',running:'正在更新'}[latest.status] || latest.status),
    recommended:latest.selected_count,newCount:matched ? last.collected?.inserted ?? null : null,
    failures,sourceCounts, reused:Boolean(matched && (!last.collected || last.collected.sourcesFailed)), historyIncomplete:!matched,
    scheduledDone:sch.scheduledDone,nextAt:sch.nextAt};
}
module.exports = { getState,setState,states,action,undo,visit,summary,updateStatus };
