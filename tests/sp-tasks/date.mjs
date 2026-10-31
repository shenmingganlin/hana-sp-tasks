// 日期/时长解析的回归测试。这些是人话→SP 值的唯一换算点，错一天就全盘皆错。
// 跑法：node tests/sp-tasks/date.mjs
import assert from "node:assert/strict";
import { resolveDay, resolveDuration, resolveMoment, localDay, shiftDay, dayRange } from "../../sp-tasks/lib/date.js";

const BASE = "2026-10-30"; // 周五

// 固定一个基准日，避免"今天"随运行时间漂移
const D = (expr, base = BASE) => resolveDay(expr, base);

// 1. 绝对日期
assert.equal(D("2026-11-15").day, "2026-11-15");
assert.equal(D("2026/11/15").day, "2026-11-15");
assert.equal(D("11-15").day, "2026-11-15", "省略年份按今年");
assert.equal(D("11/15").day, "2026-11-15");
assert.equal(D("2026-02-30").ok, false, "2月30日不存在要拒绝");
assert.equal(D("2026-13-01").ok, false, "13月要拒绝");

// 2. 相对天数
assert.equal(D("+3d").day, "2026-11-02");
assert.equal(D("+3").day, "2026-11-02");
assert.equal(D("+3天").day, "2026-11-02");
assert.equal(D("-2").day, "2026-10-28");
assert.equal(D("+0").day, BASE, "+0 就是今天");

// 3. 中文相对词
assert.equal(D("今天").day, BASE);
assert.equal(D("明天").day, "2026-10-31");
assert.equal(D("后天").day, "2026-11-01");
assert.equal(D("大后天").day, "2026-11-02");
assert.equal(D("昨天").day, "2026-10-29");
assert.equal(D("前天").day, "2026-10-28");

// 4. 英文相对词
assert.equal(D("today").day, BASE);
assert.equal(D("tomorrow").day, "2026-10-31");
assert.equal(D("yesterday").day, "2026-10-29");

// 5. 星期：基准 2026-10-30 是周五，所在周 周一=10-26、周日=11-01
assert.equal(D("周一").day, "2026-11-02", "本周一已过，取下一个周一");
assert.equal(D("周五").day, BASE, "今天就是周五，算今天");
assert.equal(D("周六").day, "2026-10-31");
assert.equal(D("周日").day, "2026-11-01");
assert.equal(D("本周五").day, BASE, "本周五就是今天");
assert.equal(D("下周一").day, "2026-11-02", "下周一 = 本周一 + 7");
assert.equal(D("下周三").day, "2026-11-04");
assert.equal(D("下周日").day, "2026-11-08");
assert.equal(D("星期日").day, "2026-11-01");
assert.equal(D("礼拜三").day, "2026-11-04");

// 5b. 说了「本」就是这一周那一天，可以落在过去。
// 基准是周五，本周一已过，不能静默改成下周一。
assert.equal(D("本周一").day, "2026-10-26", "本周一是本周的，不是下一个");
assert.equal(D("本周三").day, "2026-10-28", "本周三已过也要如实返回");
assert.equal(D("这周三").day, "2026-10-28", "这周和本周同义");
assert.equal(D("本周日").day, "2026-11-01", "周日是本周最后一天");
assert.equal(D("this friday").day, BASE);
assert.equal(D("this monday").day, "2026-10-26", "英文 this 也走本周");

// 6. 英文星期
assert.equal(D("monday").day, "2026-11-02");
assert.equal(D("next monday").day, "2026-11-02");
assert.equal(D("this friday").day, BASE);

// 7. 下个月
assert.equal(D("下个月").day, "2026-11-30", "10-30 的下个月同日");

// 7b. 月末：目标月没有那天时顺延到月末，不能滚到下下个月。
// 10-31 加一个月是 11-31，11 月只有 30 天；用 Date 自动进位会变成 12-01，
// 那样「下个月」就跳过了一整个月。
assert.equal(D("下个月", "2026-10-31").day, "2026-11-30", "月末顺延，不能跳到 12-01");
assert.equal(D("下个月", "2026-01-31").day, "2026-02-28", "非闰年 2 月只有 28 天");
assert.equal(D("下个月", "2028-01-31").day, "2028-02-29", "闰年 2 月有 29 天");
assert.equal(D("下个月", "2026-03-31").day, "2026-04-30", "4 月只有 30 天");
assert.equal(D("下个月", "2026-01-15").day, "2026-02-15", "不需要顺延的原样保留");
assert.equal(D("下个月", "2026-12-31").day, "2027-01-31", "跨年也要对");
assert.equal(D("下月", "2026-10-31").day, "2026-11-30", "下月是下个月的简称");

// 8. 认不出的要明确失败，不能瞎猜
assert.equal(D("随便什么时候").ok, false);
assert.equal(D("").ok, false);
assert.equal(D(undefined).ok, false);

// 9. 时长
const H = 3600000;
const M = 60000;
assert.equal(resolveDuration("30m").ms, 30 * M);
assert.equal(resolveDuration("1h").ms, H);
assert.equal(resolveDuration("1h30m").ms, H + 30 * M);
assert.equal(resolveDuration("90").ms, 90 * M, "纯数字按分钟");
assert.equal(resolveDuration(45).ms, 45 * M, "数字按分钟");
assert.equal(resolveDuration("45分钟").ms, 45 * M);
assert.equal(resolveDuration("2小时").ms, 2 * H);
assert.equal(resolveDuration("").ms, null, "空值表示没给");
assert.equal(resolveDuration(undefined).ms, null);
assert.equal(resolveDuration("abc").ok, false);

// 10. 带时刻
const moment = resolveMoment("明天 9:30", BASE);
assert.equal(moment.ok, true);
assert.equal(moment.day, "2026-10-31");
const at = new Date(moment.ms);
assert.equal(at.getHours(), 9);
assert.equal(at.getMinutes(), 30);
assert.equal(at.getDate(), 31);

const exact = resolveMoment("2026-11-15 14:00", BASE);
assert.equal(new Date(exact.ms).getHours(), 14);
assert.equal(resolveMoment("明天", BASE).ok, false, "没时刻要拒绝，转去用 dueDay");
assert.equal(resolveMoment("明天 25:00", BASE).ok, false, "25 点不合法");

// 11. 日界：04:00 起算
assert.equal(localDay(new Date(2026, 9, 30, 3, 59)), "2026-10-29", "凌晨 3:59 算前一天");
assert.equal(localDay(new Date(2026, 9, 30, 4, 0)), "2026-10-30", "04:00 算今天");
assert.equal(localDay(new Date(2026, 9, 30, 23, 30)), "2026-10-30");

// 12. 区间
const [start, end] = dayRange("2026-10-30");
assert.equal(new Date(start).getHours(), 4, "区间从 04:00 起");
assert.equal(end - start, 86400000);

// 13. shiftDay 跨月跨年
assert.equal(shiftDay("2026-10-31", 1), "2026-11-01");
assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
assert.equal(shiftDay("2028-02-28", 1), "2028-02-29", "闰年");

console.log("PASS date assertions");
