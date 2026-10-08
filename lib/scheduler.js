'use strict';
/**
 * 每日更新调度。
 *  - 默认北京时间 08:00 生成当日简报（时间可改）。
 *  - 电脑在预定时间未运行时，下一次打开工作台会自动补做漏掉的更新。
 *  - 用 data/scheduler.json 记录上次尝试时间，补做逻辑可在重启后恢复。
 */
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const brief = require('./brief');
const discover = require('./discover');
const { getSettings, DATA_DIR } = require('./config');

const STATE_FILE = path.join(DATA_DIR, 'scheduler.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastAttemptDate: null, lastAttemptAt: null, lastSuccessDate: null, lastResult: null, misses: [] }; }
}
function writeState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

let timer = null;
let running = false;

/*
 * 可控时钟：与简报生成共用同一个 lib/clock 单例，
 * 这样「补做判定」和「写入的完成时间」落在同一时间轴上，
 * 测试才能真正模拟「08:00 关机、09:00 开机」。
 * 注入只影响时间读数，不改变任何持久化数据。
 */
const clock = require('./clock');

/*
 * 采集实现的接缝。
 * 默认就是真实的 discover.collect；测试通过 opts.collector 注入模拟实现。
 * 之所以做成可替换的，是为了让「补做链路」的测试不必联网——
 * 真实采集一次会发出上百个请求、消耗数据源额度，还会把数百篇论文写进测试库。
 */
let collectImpl = (opts) => require('./discover').collect(opts);
/** 替换采集实现（仅供测试与本地调试） */
function setCollector(fn) {
  collectImpl = typeof fn === 'function' ? fn : ((o) => require('./discover').collect(o));
  return { ok: true, replaced: typeof fn === 'function' };
}

/*
 * 前沿技术精选的生成器。与采集一样做成接缝：
 * 默认真实调用 lib/frontier.generate（会访问 ERIC / arXiv），
 * 测试可用 setFrontierGenerator 替换成不联网的实现。
 */
let frontierImpl = (opts) => require('./frontier').generate(opts);
function setFrontierGenerator(fn) {
  frontierImpl = typeof fn === 'function' ? fn : ((o) => require('./frontier').generate(o));
  return { ok: true, replaced: typeof fn === 'function' };
}

const now = () => clock.now();
const setClock = (fn) => clock.setClock(fn);
const getClockInjected = () => clock.isInjected();

/** 计算下一次预定时刻（毫秒时间戳） */
function nextScheduledAt(at = now()) {
  const nowDate = at instanceof Date ? at : new Date(at);
  const s = getSettings();
  const tz = s.timezone || 'Asia/Shanghai';
  // 取北京时间当前时间
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(nowDate).reduce((a, p) => (a[p.type] = p.value, a), {});
  const bjNow = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  const target = new Date(bjNow);
  target.setUTCHours(s.briefHour || 8, s.briefMinute || 0, 0, 0);
  if (target.getTime() <= bjNow.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  const delta = target.getTime() - bjNow.getTime();
  return nowDate.getTime() + delta;
}

/** 某一天在指定时区的「预定时刻」对应的 UTC 时间戳 */
function targetTimeFor(dateStr, at = now()) {
  const nowDate = at instanceof Date ? at : new Date(at);
  const s = getSettings();
  const tz = s.timezone || 'Asia/Shanghai';
  // 先求出该时区相对于 UTC 的偏移量，避免手写时区表
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(probe).reduce((a, p) => (a[p.type] = p.value, a), {});
  const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute));
  const offsetMs = localAsUtc - probe.getTime();
  void nowDate;
  return Date.UTC(
    Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)),
    s.briefHour || 8, s.briefMinute || 0) - offsetMs;
}

/**
 * 判断今天的定时更新是否需要补做。
 *
 * 关键区分（这是一个真实漏洞的修复）：
 *   · hasRunToday     今天任何时候生成过简报——包括凌晨的手动生成；
 *   · scheduledDone   今天**在预定时刻之后**成功完成过一次定时或补做更新。
 * 只有 scheduledDone 才说明「今天的定时任务已经完成」。
 *
 * 反面场景：凌晨 01:29 手动点了一次简报，08:00 电脑关机，09:00 才开机。
 * 旧逻辑只看 hasRunToday，于是认为今天已经跑过，跳过 08:00 的采集与简报，
 * 用户当天就看不到真正的定时更新。现在这种情况必须补做。
 */
function isMissed(state, at = now()) {
  const nowDate = at instanceof Date ? at : new Date(at);
  const s = getSettings();
  const today = brief.beijingDate(nowDate);
  const bjHour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: s.timezone || 'Asia/Shanghai', hour: '2-digit', hour12: false,
  }).format(nowDate));
  // 与 nextScheduledAt / targetTimeFor 使用同一个目标时刻（含分钟）
  const targetMs = targetTimeFor(today, nowDate);

  const todaysRuns = store.all(
    `SELECT id, run_date, reason, status, started_at, finished_at FROM brief_runs
      WHERE run_date = ? AND status IN ('ok','partial') ORDER BY id`, [today]);
  const hasRunToday = todaysRuns.length > 0;

  /*
   * 哪些运行算「定时任务性质的更新」。
   *
   * 必须包含 first-run：空数据库里，如果当天第一次启动就发生在预定时刻之后
   * （例如 09:00 才第一次打开），catchUpIfNeeded 会以 reason=first-run 执行；
   * 这次成功生成了当天的简报，就应当算作「今天的定时任务已完成」。
   * 否则同一天再次启动会重复补跑一次。
   *
   * 预定时刻**之前**的 first-run 依然不算——下面的 finished_at >= 目标时刻
   * 判断会把这种情形排除掉。手动生成（reason=manual）同样不算。
   */
  const SCHEDULED_REASONS = new Set(['scheduled', 'catchup', 'catchup-missed-day', 'first-run']);
  const scheduledRuns = todaysRuns.filter((r) => {
    if (!SCHEDULED_REASONS.has(r.reason) || r.status !== 'ok') return false;
    const doneAt = Date.parse(r.finished_at || r.started_at || '');
    if (!Number.isFinite(doneAt)) return false;
    return doneAt >= targetMs;
  });
  const scheduledDone = scheduledRuns.length > 0;

  /*
   * 是否已到（或已过）今天的预定时刻。
   * 必须比较完整的目标时刻，不能只比 bjHour：
   * 设为 08:30 时，08:01 还没到点不该补做，08:31 才应补做。
   * 早期写法是 bjHour >= briefHour，把 08:30 当成了 08:00。
   */
  const reachedTarget = nowDate.getTime() >= targetMs;
  const due = reachedTarget && !scheduledDone;
  return {
    today, bjHour, due, reachedTarget, hasRunToday, scheduledDone, targetMs,
    targetAt: new Date(targetMs).toISOString(),
    todayRunCount: todaysRuns.length,
    scheduledRunCount: scheduledRuns.length,
    // 供界面显示「今天已有简报，但那是预定时刻之前生成的」
    earlyOnly: hasRunToday && !scheduledDone,
  };
}

/**
 * 执行一次更新：采集 + 生成简报。
 * @param {{reason?:string, skipCollect?:boolean, force?:boolean}} opts
 */
async function runUpdate(opts = {}) {
  if (running) return { ok: false, error: '已有更新正在进行' };
  running = true;
  const state = readState();
  const startedAt = now();
  const today = brief.beijingDate(startedAt);
  state.lastAttemptDate = today;
  state.lastAttemptAt = startedAt.toISOString();

  try {
    let collectResult = null;
    if (!opts.skipCollect) {
      /*
       * 采集走一个可替换的接缝：测试可以注入「模拟采集结果」，
       * 既不必联网占用数据源额度，也不会把真实论文写进测试库。
       * 生产运行时它就是 discover.collect。
       */
      const collector = opts.collector || collectImpl;
      collectResult = await collector({});
    }
    const briefResult = require('./customize').get('streams',{}).research===false ? {ok:true,generated:false,skipped:true} : await brief.generateBrief({
      reason: opts.reason || 'scheduled',
      force: Boolean(opts.force),
    });
    /*
     * 成功口径：采集与简报流程本身是否跑通，**与「有多少篇官方目录合格」无关**。
     * 官方合格数为 0 只反映期刊目录尚未导入，不代表更新失败。
     * 只有真正生成了简报（没被 skip）才算这一次调度完成。
     */
    const sourceLog = collectResult?.log || [];
    const sourcesFailed = Boolean(collectResult && (collectResult.ok === false || (sourceLog.length && !sourceLog.some(r=>r.ok))));
    const succeeded = briefResult.ok !== false && !sourcesFailed;
    if (sourcesFailed && briefResult.runId) {
      store.run("UPDATE brief_runs SET status='partial', error=? WHERE id=?",['采集来源全部失败；本次仅沿用已有文献生成推荐',briefResult.runId]);
    }
    const didGenerate = succeeded && briefResult.skipped !== true;
    if (didGenerate) state.lastSuccessDate = today;

    /*
     * 前沿技术精选：与主简报**分开**生成，失败绝不影响主简报与调度判定。
     *
     * 为什么默认在注入了 collector 时跳过：collector 接缝是测试用的
     * （测试用模拟采集结果，不联网、不占额度）。既然采集是模拟的，
     * 前沿源也不应真的发网络请求，否则「隔离测试」就名不副实。
     * 测试若确实要覆盖前沿生成，显式传 frontierGenerator 即可。
     */
    let scienceResult=null;
    if(!opts.collector&&!opts.skipCollect&&require('./customize').get('streams',{}).science){try{scienceResult=await require('./science').collect();}catch(e){scienceResult={ok:false,error:e.message};}}
    let frontierResult = null;
    const frontierGen = opts.frontierGenerator
      || (opts.collector || opts.skipFrontier || opts.skipCollect ? null : frontierImpl);
    if (frontierGen && getSettings().frontierDaily !== false && require('./customize').get('streams',{}).frontier!==false) {
      try {
        frontierResult = await frontierGen({
          reason: opts.reason || 'scheduled',
          size: getSettings().frontierSize || 3,
        });
      } catch (e) {
        frontierResult = { ok: false, error: e.message };
        store.logEvent('warn', 'frontier', '前沿技术精选生成失败（不影响主简报）：' + e.message);
      }
    }

    state.lastResult = {
      at: clock.nowIso(), startedAt: startedAt.toISOString(), reason: opts.reason || 'scheduled',
      collected: collectResult ? {
        queries: collectResult.queries, rawCount: collectResult.rawCount,
        uniqueCandidates: collectResult.uniqueCandidates,
        inserted: collectResult.inserted, updated: collectResult.updatedExisting,
        eligible: collectResult.eligible, pending: collectResult.pending,
        failures: (collectResult.log || []).filter(r=>r.ok===false).map(r=>({source:r.source,message:r.message})),
        sourcesFailed,
      } : null,
      brief: briefResult,
      succeeded,
      frontier: frontierResult, science:scienceResult,
    };
    if(require('./customize').get('streams',{}).research===false)require('./customize').put('streamsCompletedDay',today);
    writeState(state);
    store.logEvent('info', 'scheduler', `更新完成（${opts.reason || 'scheduled'}）`, state.lastResult);
    return {
      ok: succeeded, generated: didGenerate,
      collectResult, briefResult, frontierResult, date: today,
      reason: opts.reason || 'scheduled',
    };
  } catch (e) {
    state.lastResult = { at: clock.nowIso(), startedAt:startedAt.toISOString(), reason: opts.reason || 'scheduled', error: e.message, stack: e.stack?.split('\n').slice(0, 4).join('\n') };
    writeState(state);
    // 把当天记录标成 failed，这样「今天是否已成功」有据可查，也允许下次重试
    try {
      const row = store.get('SELECT id, status FROM brief_runs WHERE run_date = ?', [today]);
      if (row && row.status !== 'ok') {
        store.run("UPDATE brief_runs SET status='failed', finished_at=?, error=? WHERE id=?", [clock.nowIso(), String(e.message).slice(0, 500), row.id]);
      }
    } catch { /* 记录失败本身不应掩盖原始错误 */ }
    store.logEvent('error', 'scheduler', '更新失败: ' + e.message, { stack: e.stack?.split('\n').slice(0, 5) });
    return { ok: false, error: e.message };
  } finally {
    running = false;
  }
}

/**
 * 启动时补做。
 *
 * 判定依据是 scheduledDone（今天在预定时刻之后成功完成过定时/补做更新），
 * 而不是 hasRunToday（今天任何时候生成过简报）。
 * 凌晨的手动生成不能算作「今天的定时任务已完成」。
 */
async function catchUpIfNeeded() {
  const nowDate = now();
  const miss = isMissed(null, nowDate);
  const { today, due, hasRunToday, scheduledDone, earlyOnly, targetAt } = miss;
  const state = readState();

  if(require('./customize').get('streams',{}).research===false&&require('./customize').get('streamsCompletedDay')===today)return {caught:false,reason:'今天所选区域的更新已完成',date:today};
  if (scheduledDone) return { caught: false, reason: '今天的定时更新已完成', date: today, targetAt };

  const s = getSettings();
  const hasAnyRun = Boolean(store.get('SELECT id FROM brief_runs LIMIT 1'));

  if (due) {
    /*
     * 关键：补做必须 force。
     *
     * 到点后的这次更新是「今天的定时更新」，必须重新生成当天的简报。
     * 不 force 的话 generateBrief 会看到同日已有一条 status='ok' 的记录
     * （例如凌晨那次成功的手动简报）直接 skipped，于是只采集、不重新生成，
     * 而 catchUpIfNeeded 还会报「已补做」——下次重启又重复一次。
     */
    const res = await runUpdate({ reason: hasAnyRun ? 'catchup' : 'first-run', force: true });
    const briefRes = res && res.briefResult;
    const failed = !res || res.ok === false;
    // skipped 说明这一次没有真正重新生成，不能算补做完成
    const skipped = Boolean(briefRes && briefRes.skipped);
    const completed = !failed && !skipped;
    return {
      caught: completed,
      kind: hasAnyRun ? 'catchup' : 'first-run',
      failed, skipped, completed,
      note: failed
        ? `补做失败（${res.error || '未知错误'}），下次打开工作台会重试。`
        : (skipped
            ? '补做时简报被判定为「今天已生成」而跳过，这次没有真正重新生成，因此不计为已完成定时更新，下次打开会重试。'
            : (earlyOnly
                ? `今天此前只在预定时刻（${new Date(targetAt).toISOString()}）之前生成过简报（例如凌晨的手动生成），这不满足定时更新，已重新执行一次真正的定时采集与简报。`
                : (hasAnyRun
                    ? '已过今天的预定更新时间但尚未完成定时更新，正在补做。'
                    : '这是首次运行，已按首次运行生成简报。'))),
      res,
    };
  }

  /*
   * 更新失败后允许重试。
   *
   * 判定基于今天的运行记录（而不是内存里的 state），因此重启后依然有效：
   * 今天有运行记录、但没有任何一次成功（status 全不是 ok），且距上次尝试
   * 已超过最小间隔（默认 60 秒，避免短时间内反复触发）⇒ 重试一次。
   */
  const todayRuns = store.all(
    `SELECT reason, status, finished_at, started_at FROM brief_runs WHERE run_date = ?`, [today]);
  const anyOkToday = todayRuns.some((r) => r.status === 'ok');
  const lastAt = todayRuns
    .map((r) => Date.parse(r.finished_at || r.started_at || ''))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  const minRetryMs = s.minRetryIntervalMs || 60000;
  const canRetry = todayRuns.length > 0 && !anyOkToday
    && (!Number.isFinite(lastAt) || (nowDate.getTime() - lastAt) >= minRetryMs);

  if (canRetry && !scheduledDone) {
    // 重试同样要 force：否则同样会被同日的 ok 记录跳过
    const res = await runUpdate({ reason: 'catchup', force: true });
    const skippedRetry = Boolean(res && res.briefResult && res.briefResult.skipped);
    return {
      caught: Boolean(res && res.ok !== false && !skippedRetry),
      kind: 'retry-after-failure',
      failed: !res || res.ok === false,
      skipped: skippedRetry,
      completed: Boolean(res && res.ok !== false && !skippedRetry),
      note: `今天的更新尚未成功（${
        todayRuns.map((r) => `${r.reason}/${r.status}`).join('、')
      }），已重试一次。若仍失败，下次打开工作台会再试。`,
      res,
    };
  }

  // 还没到今天的预定时刻：检查是否漏掉了更早的日子
  const lastRun = store.get('SELECT run_date, status FROM brief_runs ORDER BY run_date DESC LIMIT 1');
  if (!lastRun) {
    if (s.autoFirstRun !== false) {
      const res = await runUpdate({ reason: 'first-run' });
      return { caught: true, kind: 'first-run', note: '这是首次运行，已生成第一份简报。', res };
    }
    return { caught: false, reason: '首次运行但已关闭自动首跑', date: today };
  }
  const missedDays = Math.floor((new Date(today) - new Date(lastRun.run_date)) / 86400000);
  if (missedDays >= 1) {
    const res = await runUpdate({ reason: 'catchup' });
    return {
      caught: true, kind: 'catchup-missed-day', missedDays,
      note: `最后一次简报是 ${lastRun.run_date}，漏掉了 ${missedDays} 天，正在补做。`,
      res,
    };
  }
  return { caught: false, reason: '未到预定时刻且无漏做', date: today, nextAt: new Date(nextScheduledAt(nowDate)).toISOString() };
}

function schedule() {
  if (timer) clearTimeout(timer);
  const next = nextScheduledAt();
  const delay = Math.max(1000, next - Date.now());
  timer = setTimeout(async () => {
    await runUpdate({ reason: 'scheduled', force: true });
    schedule(); // 排下一次
  }, Math.min(delay, 2147483000));
  if (timer.unref) timer.unref();
  return { nextAt: new Date(next).toISOString(), delayMs: delay };
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function status() {
  const s = getSettings();
  const state = readState();
  const miss = isMissed(now());
  return {
    enabled: true,
    briefHour: s.briefHour, briefMinute: s.briefMinute, timezone: s.timezone,
    nextAt: new Date(nextScheduledAt(now())).toISOString(),
    clockInjected: getClockInjected(),
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessDate: state.lastSuccessDate,
    lastResult: state.lastResult,
    // 三个口径必须分清，界面据此说明「今天已有简报，但那是预定时刻之前的」
    todayDue: miss.due,
    hasRunToday: miss.hasRunToday,
    scheduledDone: miss.scheduledDone,
    todayRunCount: miss.todayRunCount,
    scheduledRunCount: miss.scheduledRunCount,
    earlyOnly: miss.earlyOnly,
    targetAt: miss.targetAt,
    running,
  };
}

module.exports = {
  runUpdate, catchUpIfNeeded, schedule, stop, status,
  nextScheduledAt, isMissed, targetTimeFor,
  // 可控时钟：仅供测试与本地调试注入，不改变任何持久化数据
  now, setClock, getClockInjected,
  setCollector, setFrontierGenerator,
};
