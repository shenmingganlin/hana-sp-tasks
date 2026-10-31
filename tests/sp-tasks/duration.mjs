// 时长解析须消费整个输入；人类输入的裸数字始终是分钟，不按大小猜单位。
import assert from "node:assert/strict";
import test from "node:test";
import { resolveDuration } from "../../sp-tasks/lib/date.js";

const valid = [
  ["0", 0], [0, 0], ["0m", 0], ["0h", 0],
  ["0.5", 30000], [0.5, 30000], [".5h", 1800000],
  ["1.25h", 4500000], ["1h30m", 5400000], ["1.5h 15m", 6300000],
  ["2 hours 5 minutes", 7500000], ["1小时30分钟", 5400000],
  ["1 hour", 3600000], ["2 hours", 7200000],
  ["1 min", 60000], ["2 mins", 120000], ["1 minute", 60000], ["2 minutes", 120000],
  ["1小时", 3600000], ["1分", 60000], ["2分钟", 120000],
  [" 1H 30M ", 5400000],
  ["1440", 86400000], ["1441", 86460000], [1440, 86400000], [1441, 86460000],
  ["0.00001m", 1], [0.00001, 1],
];
for (const [input, ms] of valid) {
  test(`完整合法时长 ${JSON.stringify(input)} (${typeof input}) → ${ms}ms`, () => {
    assert.deepEqual(resolveDuration(input), { ok: true, ms });
  });
}

for (const input of [undefined, null, "", "  ", "\t\n"]) {
  test(`空时长 ${JSON.stringify(input)} 表示未提供`, () => {
    assert.deepEqual(resolveDuration(input), { ok: true, ms: null });
  });
}

for (const input of [
  "-30m", "-1h30m", "1h-30m", "1h -30m", "-30", -30,
  "1h junk", "junk 1h", "1hourglass", "30minuteslater", "1小时垃圾",
  "1h 30", "1.2.3h", "1h,30m", "abc", "+30m", "0x10", "1e3",
  "NaN", "Infinity", NaN, Infinity, -Infinity, Number.MAX_VALUE,
  "9".repeat(400), "9".repeat(400) + "h", true, false, [], [30], {},
]) {
  test(`拒绝不完整或非法时长 ${String(input)} (${typeof input})`, () => {
    const result = resolveDuration(input);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
  });
}
