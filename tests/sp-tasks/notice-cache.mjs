import assert from "node:assert/strict";
import test from "node:test";
import { readNotice, resetNoticeCache, invalidateNotice } from "../../sp-tasks/lib/notice.js";
import { localDay, dayRange, shiftDay } from "../../sp-tasks/lib/date.js";

const response = (data) => ({ ok: true, json: async () => ({ ok: true, data }) });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function fixture({ getAll, fetchImpl } = {}) {
  return {
    config: { getAll: getAll ?? (async () => ({ baseUrl: "http://sp.invalid", accessToken: "test-token" })) },
    resources: { read: async () => { throw new Error("no real token access"); } },
    network: { fetch: fetchImpl ?? (async (rawUrl) => response(new URL(rawUrl).pathname === "/tasks" ? [{ id: "x", isDone: false }] : null)) },
  };
}

test("config invalidation switches both address and token on the next notice", async () => {
  resetNoticeCache();
  let config = { baseUrl: "http://old.invalid", accessToken: "old-token" };
  const calls = [];
  const sdk = fixture({
    getAll: async () => ({ ...config }),
    fetchImpl: async (rawUrl, init) => {
      calls.push([new URL(rawUrl).origin, init.headers.Authorization]);
      return response(new URL(rawUrl).pathname === "/tasks" ? [{ id: "x" }] : null);
    },
  });
  await readNotice(sdk);
  config = { baseUrl: "http://new.invalid", accessToken: "new-token" };
  invalidateNotice();
  await readNotice(sdk);
  assert.deepEqual(calls.slice(2), [["http://new.invalid", "Bearer new-token"], ["http://new.invalid", "Bearer new-token"]]);
});

test("a request started before invalidation cannot restore the stale notice cache", async () => {
  resetNoticeCache();
  const oldResponse = deferred();
  const started = deferred();
  let first = true;
  const sdk = fixture({ fetchImpl: async (rawUrl) => {
    if (new URL(rawUrl).pathname !== "/tasks") return response(null);
    if (first) { first = false; started.resolve(); return oldResponse.promise; }
    return response([{ id: "new-1" }, { id: "new-2" }]);
  } });
  const old = readNotice(sdk);
  await started.promise;
  invalidateNotice();
  assert.match(await readNotice(sdk), /待办共 2 件/);
  oldResponse.resolve(response([{ id: "old" }]));
  assert.equal(await old, "");
  assert.match(await readNotice(sdk), /待办共 2 件/);
});

test("a pending config read cannot replace the config written after invalidation", async () => {
  resetNoticeCache();
  const oldConfig = deferred();
  const started = deferred();
  let first = true;
  const origins = [];
  const sdk = fixture({
    getAll: async () => {
      if (first) { first = false; started.resolve(); return oldConfig.promise; }
      return { baseUrl: "http://new.invalid", accessToken: "new-token" };
    },
    fetchImpl: async (rawUrl) => {
      origins.push(new URL(rawUrl).origin);
      return response(new URL(rawUrl).pathname === "/tasks" ? [{ id: "new" }] : null);
    },
  });
  const old = readNotice(sdk);
  await started.promise;
  invalidateNotice();
  await readNotice(sdk);
  oldConfig.resolve({ baseUrl: "http://old.invalid", accessToken: "old-token" });
  assert.equal(await old, "");
  assert.ok(origins.every((origin) => origin === "http://new.invalid"));
});

test("simultaneous notice readers share the same snapshot request", async () => {
  resetNoticeCache();
  let calls = 0;
  const sdk = fixture({ fetchImpl: async (rawUrl) => {
    calls += 1;
    return response(new URL(rawUrl).pathname === "/tasks" ? [{ id: "x" }] : null);
  } });
  const results = await Promise.all([readNotice(sdk), readNotice(sdk), readNotice(sdk)]);
  assert.equal(calls, 2);
  assert.ok(results.every((text) => text === results[0]));
});

test("the notice counts SP schedule dates, true deadlines, and duplicate ids once", async () => {
  resetNoticeCache();
  const today = localDay();
  const yesterday = shiftDay(today, -1);
  const [start, end] = dayRange(today);
  const scheduled = { id: "planned", dueDay: today, deadlineDay: yesterday };
  const tasks = [scheduled, scheduled, { id: "timed", dueWithTime: start + 1 },
    { id: "future", dueDay: today, dueWithTime: end }, { id: "legacy", plannedAt: start },
    { id: "done", isDone: true, dueDay: today }, null, "garbage"];
  const sdk = fixture({ fetchImpl: async (rawUrl) => response(new URL(rawUrl).pathname === "/tasks" ? tasks : null) });
  const text = await readNotice(sdk);
  assert.match(text, /今天 2 件/);
  assert.match(text, /1 件已过期/);
});

test("04:00 invalidates the prior logical day's snapshot even within its TTL", async () => {
  resetNoticeCache();
  const RealDate = globalThis.Date;
  let clock = new RealDate(2026, 9, 31, 3, 59, 50).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  try {
    const sdk = fixture({ fetchImpl: async (rawUrl) => response(new URL(rawUrl).pathname === "/tasks" ? [{ id: "x", dueDay: "2026-10-30" }] : null) });
    assert.match(await readNotice(sdk), /今天 1 件/);
    clock += 20000;
    const text = await readNotice(sdk);
    assert.match(text, /今天没安排/);
    assert.match(text, /1 件已过期/);
  } finally {
    globalThis.Date = RealDate;
    resetNoticeCache();
  }
});

for (const phase of ["config", "network", "json"]) {
  test(`the entire notice returns within its budget when ${phase} never resolves`, async () => {
    resetNoticeCache();
    const never = new Promise(() => {});
    const sdk = fixture({
      getAll: phase === "config" ? () => never : undefined,
      fetchImpl: phase === "network" ? () => never
        : phase === "json" ? async () => ({ ok: true, json: () => never }) : undefined,
    });
    const started = performance.now();
    assert.equal(await readNotice(sdk), "");
    assert.ok(performance.now() - started < 1800, "stuck host operations must not block a conversation");
  });
}

test("a late response after the budget expires cannot refill the cache", async () => {
  resetNoticeCache();
  const delayed = deferred();
  let first = true;
  const sdk = fixture({ fetchImpl: async (rawUrl) => {
    if (new URL(rawUrl).pathname !== "/tasks") return response(null);
    if (first) { first = false; return delayed.promise; }
    return response([{ id: "new-1" }, { id: "new-2" }]);
  } });
  assert.equal(await readNotice(sdk), "");
  delayed.resolve(response([{ id: "old" }]));
  await Promise.resolve();
  assert.match(await readNotice(sdk), /待办共 2 件/);
});
