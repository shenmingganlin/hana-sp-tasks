// 测感知摘要：能拿到就压成一句，拿不到就闭嘴，且不能拖慢对话。
// 所有请求都走内存替身；不读取 SP_TOKEN，也不因本机开着 SP 而改变测试行为。
import assert from "node:assert/strict";
import { readNotice, resetNoticeCache, invalidateNotice } from "../../sp-tasks/lib/notice.js";
import { localDay, dayRange, shiftDay } from "../../sp-tasks/lib/date.js";

const makeSdk = ({ baseUrl = "http://sp.invalid", accessToken = "testtoken", fetchImpl } = {}) => ({
  network: {
    fetch: fetchImpl ?? (async () => { throw new Error("测试未提供网络替身"); }),
  },
  config: {
    getAll: async () => ({ baseUrl, accessToken, defaultProjectId: "" }),
  },
  resources: { read: async () => { throw new Error("测试环境没有 token 文件"); } },
  logger: { info: async () => {}, warn: async () => {} },
});

// 1. SP 连不上：必须快速返回空字符串，不能抛错、不能挂住
{
  resetNoticeCache();
  const sdk = makeSdk({ fetchImpl: async () => { throw new Error("fetch failed: ECONNREFUSED"); } });
  const started = Date.now();
  const text = await readNotice(sdk);
  const elapsed = Date.now() - started;
  assert.equal(text, "", "连不上时必须闭嘴");
  assert.ok(elapsed < 2000, `连不上时太慢了：${elapsed}ms`);
}

// 2. 没有 token：立刻返回空，不打网络
{
  resetNoticeCache();
  let called = false;
  const sdk = makeSdk({
    accessToken: "",
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ data: [] }) }; },
  });
  const text = await readNotice(sdk);
  assert.equal(text, "", "没 token 时应闭嘴");
  assert.equal(called, false, "没 token 时不该发请求");
}

// 3. 接口回垃圾：闭嘴，不当成「今天没事」
{
  resetNoticeCache();
  const sdk = makeSdk({
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false }) }),
  });
  assert.equal(await readNotice(sdk), "", "接口没给 data 时应闭嘴");
}

// 4. 快照规则：单测一遍计数逻辑（注入一个假接口，形状照真实 SP）
//    日期必须用产品自己的 localDay / dayRange 构造：它以 04:00 为日界，
//    凌晨 0-4 点算前一天，用 new Date() 算「今天」会差一天。
{
  resetNoticeCache();
  const day = localDay();
  const yday = shiftDay(day, -1);
  const [dayStart] = dayRange(day);

  const tasks = [
    { id: "a", title: "今天到期的", isDone: false, dueDay: day },
    { id: "b", title: "计划今天的", isDone: false, dueDay: day, plannedAt: dayStart + 3600000 },
    { id: "c", title: "过期的", isDone: false, dueDay: yday },
    { id: "d", title: "已做完", isDone: true, dueDay: day },
    { id: "e", title: "没日期的", isDone: false },
  ];

  const sdk = makeSdk({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/tasks")) {
        return { ok: true, json: async () => ({ ok: true, data: tasks }) };
      }
      if (String(url).endsWith("/task-control/current")) {
        return { ok: true, json: async () => ({ ok: true, data: { id: "a", title: "今天到期的" } }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });

  const text = await readNotice(sdk);
  assert.ok(text.includes("今天 2 件"), `今天计数不对：${text}`);
  assert.ok(text.includes("1 件已过期"), `过期计数不对：${text}`);
  assert.ok(text.includes("正在计时「今天到期的」"), `当前任务没带上：${text}`);
  assert.ok(text.startsWith("[任务台]"), "标记必须在最前");
  assert.ok(text.includes("不是用户说的话"), "必须声明这不是用户说的");
  console.log(`      摘要 = ${text}`);
}

// 5. 缓存：TTL 内不重打接口
{
  resetNoticeCache();
  let calls = 0;
  const sdk = makeSdk({
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).endsWith("/tasks")) return { ok: true, json: async () => ({ ok: true, data: [{ id: "x", isDone: false, dueDay: "2000-01-01" }] }) };
      return { ok: true, json: async () => ({ ok: true, data: null }) };
    },
  });
  await readNotice(sdk);
  const afterFirst = calls;
  await readNotice(sdk);
  await readNotice(sdk);
  assert.equal(calls, afterFirst, "TTL 内重复打了接口");
  assert.ok(afterFirst >= 2, "首次应打两次（tasks + current）");
}

// 6. 今天没事、也没在计时：闭嘴（不注入一行「今天 0 件」的废话）
{
  resetNoticeCache();
  const sdk = makeSdk({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/tasks")) return { ok: true, json: async () => ({ ok: true, data: [] }) };
      return { ok: true, json: async () => ({ ok: true, data: null }) };
    },
  });
  assert.equal(await readNotice(sdk), "", "空列表时不该说话");
}

// 7. 写操作后缓存要失效：变了内容必须马上能读到
//    只靠 60 秒 TTL 会自动给一个「确定但错」的答案，比不注入更糟。
{
  resetNoticeCache();
  let count = 1;
  const sdk = makeSdk({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/tasks")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: Array.from({ length: count }, (_, i) => ({ id: `x${i}`, title: `任务${i}`, isDone: false })),
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, data: null }) };
    },
  });

  const first = await readNotice(sdk);
  assert.ok(first.includes("待办共 1 件"), `首次不对：${first}`);

  count = 3;
  const stale = await readNotice(sdk);
  assert.ok(stale.includes("待办共 1 件"), "TTL 内本应命中缓存");

  invalidateNotice();
  const fresh = await readNotice(sdk);
  assert.ok(fresh.includes("待办共 3 件"), `失效后应读到新数字：${fresh}`);
}

console.log("Notice assertions passed: quiet on unreachable/no-token/garbage, correct counts, marked, cached, invalidated after writes, silent when nothing to say.");
