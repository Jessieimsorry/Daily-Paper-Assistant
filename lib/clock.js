'use strict';
/**
 * 可控时钟（单例）。
 *
 * 为什么需要它：调度补做（「08:00 关机、09:00 开机」）这类行为如果只能靠
 * 改系统时钟或等真实时间，就既不可测、又容易污染正式数据。
 * 这里提供一个进程级的时钟注入点，让调度与简报生成共享同一个「现在」。
 *
 * 使用约束：
 *   · 只影响时间读数，不改变任何持久化数据；
 *   · 默认不注入，取系统真实时间；
 *   · 仅供测试与本地调试使用（进程重启即失效）。
 *
 * 时间语义（UTC 存储 / 北京时间显示）见 lib/time.js，本模块只负责「现在」。
 */

const time = require('./time');

let _clock = null;

/** 当前时间：默认系统时间，注入后返回注入时间 */
function now() {
  return _clock ? new Date(_clock()) : new Date();
}

/** 当前时间的 ISO 字符串（一定带 Z，数据库与 API 的统一格式） */
function nowIso() {
  return time.toIsoUtc(now());
}

/** 当前时间的毫秒时间戳 */
function nowMs() {
  return now().getTime();
}

/**
 * 注入时钟。
 * @param {null|(() => number|Date|string)} fn 返回毫秒时间戳 / Date / ISO 字符串
 */
function setClock(fn) {
  _clock = typeof fn === 'function' ? fn : null;
  return { ok: true, injected: Boolean(_clock) };
}

function isInjected() {
  return Boolean(_clock);
}

module.exports = { now, nowIso, nowMs, setClock, isInjected, time };
