// lib/date.js — 日期与「一天从 04:00 起算」的单一来源
//
// 为什么时间都在这儿算，不让模型自己算：
// 模型算「下周三」很爱错，而且它不知道本机时区、也不知道我把 04:00 当一天的界。
// 所以对外只收人话（今天/明天/下周三/+3d/2026-11-15），在这里一次换算成 SP 认的值。

const DAY_START_HOUR = 4;

export const pad2 = (n) => String(n).padStart(2, "0");

/** 用户的一天从 04:00 起算：凌晨一点还在做的事算前一天。 */
export function localDay(at = new Date()) {
  const d = new Date(at.getTime());
  d.setHours(d.getHours() - DAY_START_HOUR);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 某个工作日标签对应的毫秒区间 [起, 止)。 */
export function dayRange(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  const start = new Date(y, m - 1, d, DAY_START_HOUR, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, DAY_START_HOUR, 0, 0, 0).getTime();
  return [start, end];
}

/** 工作日的本地起点；plannedAt 等旧数据需要时间戳时也使用同一日界。 */
export function dayStartMs(day) {
  return dayRange(day)[0];
}

export function shiftDay(day, days) {
  const [y, m, d] = String(day).split("-").map(Number);
  const base = new Date(y, m - 1, d, DAY_START_HOUR, 0, 0, 0);
  base.setDate(base.getDate() + days);
  return localDay(base);
}

/** 是否是合法且真实存在的日期（排除 2026-02-30 这种）。 */
function isRealDay(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

const CN_WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 七: 0 };
const EN_WEEKDAY = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };

/** 该日期所在这一周的周一（中文习惯：周一是第一天）。 */
function weekMonday(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  const date = new Date(y, m - 1, d, 12);
  const dow = date.getDay(); // 0=周日
  const back = dow === 0 ? 6 : dow - 1;
  date.setDate(date.getDate() - back);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 把人话日期解析成 YYYY-MM-DD。
 * 认：今天/明天/后天/大后天/昨天/前天、周一…周日（含本周/下周/星期写法）、
 *     英文 today/tomorrow/monday…、+3d/+3 天、2026-11-15、11-15、11/15。
 * 认不出返回 { ok: false, error } —— 不猜，让调用方知道要换个说法。
 */
export function resolveDay(expr, base = localDay()) {
  if (expr === undefined || expr === null) return { ok: false, error: "日期为空" };
  const raw = String(expr).trim();
  if (!raw) return { ok: false, error: "日期为空" };

  const lower = raw.toLowerCase();

  // 绝对日期
  let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!isRealDay(y, mo, d)) return { ok: false, error: `${raw} 不是真实存在的日期` };
    return { ok: true, day: `${y}-${pad2(mo)}-${pad2(d)}` };
  }
  // 省略年份：按今年的同类日期
  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const year = Number(base.slice(0, 4));
    const [mo, d] = [Number(m[1]), Number(m[2])];
    if (!isRealDay(year, mo, d)) return { ok: false, error: `${raw} 不是真实存在的日期` };
    return { ok: true, day: `${year}-${pad2(mo)}-${pad2(d)}` };
  }

  // 相对天数
  const rel = lower.match(/^([+-]?\d+)\s*(d|day|days|天|日)?$/);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || Math.abs(n) > 3650) return { ok: false, error: `天数超出范围：${raw}` };
    return { ok: true, day: shiftDay(base, n) };
  }

  // 中文相对词
  const CN_REL = {
    今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3,
    昨天: -1, 昨日: -1, 前天: -2,
  };
  if (Object.hasOwn(CN_REL, raw)) return { ok: true, day: shiftDay(base, CN_REL[raw]) };

  const EN_REL = { today: 0, tomorrow: 1, yesterday: -1, "day after tomorrow": 2 };
  if (Object.hasOwn(EN_REL, lower)) return { ok: true, day: shiftDay(base, EN_REL[lower]) };

  // 周一 / 星期一 / 本周三 / 下周五 / next monday / monday
  m = raw.match(/^(下|下个|本|这|这个)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天七])$/);
  if (m) {
    const scope = m[1] || "";
    const target = CN_WEEKDAY[m[2]];
    return weekdayTarget(scope, target, base, raw);
  }
  m = lower.match(/^(next\s+|this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (m) {
    const scope = (m[1] || "").trim();
    const target = EN_WEEKDAY[m[2].slice(0, 3)];
    return weekdayTarget(scope === "next" ? "下" : scope === "this" ? "本" : "", target, base, raw);
  }

  // 下个月同日。月末要注意：10-31 的「下个月」是 11-31，不存在。
  // new Date 会静默进位成 12-01，那样「下个月」就跳过了一整个月。
  if (raw === "下个月" || raw === "下月") {
    const [y, mo, d] = base.split("-").map(Number);
    // mo 是 1-based，正好当下个月的 0-based 索引。
    // 第 0 天 = 上个月最后一天，所以 (mo + 1, 0) 是下个月最后一天。
    const lastDay = new Date(y, mo + 1, 0).getDate();
    const day = Math.min(d, lastDay);
    const target = new Date(y, mo, day);
    return { ok: true, day: `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}` };
  }

  return { ok: false, error: `认不出这个日期：${raw}（可用：今天/明天/下周三/2026-11-15/+3d）` };
}

function weekdayTarget(scope, target, base, raw) {
  if (target === undefined) return { ok: false, error: `认不出星期：${raw}` };
  const baseDow = new Date(`${base}T12:00:00`).getDay();
  const offset = target === 0 ? 6 : target - 1; // 周一=0 … 周日=6

  if (scope === "下" || scope === "下个") {
    // 下周 = 本周一 + 7 起的那一周
    return { ok: true, day: shiftDay(weekMonday(base), 7 + offset) };
  }
  if (scope === "本" || scope === "这" || scope === "这个") {
    // 说了「本」就是这一周那一天，可以落在过去。
    // 今天周六说「本周五」得到的是昨天，不静默改成下周五——那等于篡改用户的话。
    return { ok: true, day: shiftDay(weekMonday(base), offset) };
  }
  // 无范围：取「下一个该星期几」，今天算数
  return { ok: true, day: shiftDay(base, (target - baseDow + 7) % 7) };
}

/**
 * 解析人类输入的时长。收 "30m" / "1h" / "1h30m" / "90"；裸数字（含 number）始终是分钟。
 * 返回整数毫秒，或 null 表示没给。不用于解析 SP 已有的毫秒字段。
 */
export function resolveDuration(value) {
  if (value === undefined || value === null || value === "") return { ok: true, ms: null };
  const invalid = () => ({ ok: false, error: `时长不合法：${value}（可用 30m / 1h30m / 90，不能为负数）` });
  const result = (ms) => ms >= 0 && Number.isSafeInteger(Math.round(ms))
    ? { ok: true, ms: Math.round(ms) }
    : invalid();
  if (typeof value === "number") return result(value * 60000);
  if (typeof value !== "string") return invalid();

  const raw = value.trim().toLowerCase();
  if (!raw) return { ok: true, ms: null };
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) return result(Number(raw) * 60000);

  let total = 0;
  let consumed = 0;
  // sticky 匹配不允许跳过负号、前后垃圾或两段之间的非法字符；长单位优先。
  const re = /(\d+(?:\.\d+)?|\.\d+)\s*(hours?|h|小时|minutes?|mins?|m|分钟|分)\s*/y;
  while (consumed < raw.length) {
    const part = re.exec(raw);
    if (!part) return invalid();
    const n = Number(part[1]);
    total += /^(h|hours?|小时)$/.test(part[2]) ? n * 3600000 : n * 60000;
    consumed = re.lastIndex;
  }
  return result(total);
}

/** 带时刻的日期：「2026-11-15 14:00」或「明天 9:30」。返回 epoch 毫秒。 */
export function resolveMoment(expr, base = localDay()) {
  const raw = String(expr ?? "").trim();
  if (!raw) return { ok: false, error: "时间为空" };

  const m = raw.match(/^(.*?)\s*(\d{1,2})[:：](\d{2})$/);
  if (!m) return { ok: false, error: `带时刻的时间要写成「日期 时:分」，例如 2026-11-15 14:00` };

  const dayResult = resolveDay(m[1] || "今天", base);
  if (!dayResult.ok) return dayResult;

  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return { ok: false, error: `时刻不合法：${m[2]}:${m[3]}` };

  const [y, mo, d] = dayResult.day.split("-").map(Number);
  const at = new Date(y, mo - 1, d, hour, minute, 0, 0).getTime();
  return { ok: true, day: dayResult.day, ms: at };
}
