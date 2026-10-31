import assert from "node:assert/strict";
import test from "node:test";
import { registerFeatureTools } from "../../sp-tasks/lib/features.js";
import { localDay, resolveDay } from "../../sp-tasks/lib/date.js";
import { readNotice, resetNoticeCache } from "../../sp-tasks/lib/notice.js";

globalThis.fetch = async () => { throw new Error("Live network is disabled in feature tests"); };
const json = (status, payload) => new Response(JSON.stringify(payload), { status });
const success = (data, status = 200) => json(status, { ok: true, data });
const failure = (code, message, status = 400) => json(status, { ok: false, error: { code, message } });

async function setup() {
  resetNoticeCache();
  const cfg = { baseUrl: "http://sp.invalid", accessToken: "test-token" };
  const tools = new Map();
  const state = {
    requests: [], tasks: [{ id: "task-1", title: "task", isDone: false }],
    repeats: [{ id: "repeat-1", projectId: "project-1", quickSetting: "DAILY", isPaused: false }],
    notes: [{ id: "note-1", projectId: "project-1", content: "x".repeat(1200), isPinnedToToday: false }],
    counters: [{ id: "counter-1", type: "ClickCounter", countOnDay: {} }, { id: "watch-1", type: "StopWatch", countOnDay: {} }],
    failWrite: false, loseResponse: false, badEntity: false, wrongId: false, deletionOverride: null,
  };
  const sdk = {
    config: { getAll: async () => cfg },
    resources: { read: async () => { throw new Error("Real file reads are forbidden"); } },
    tools: { register: async (tool) => { tools.set(tool.name, tool); } },
    network: { fetch: async (rawUrl, init) => {
      const url = new URL(rawUrl);
      assert.equal(url.origin, cfg.baseUrl);
      assert.equal(init.headers.Authorization, "Bearer test-token");
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      const method = init.method;
      const path = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      state.requests.push({ method, path, body, query });
      if (method === "GET" && path === "/tasks") return success(state.tasks);
      if (method === "GET" && path === "/task-control/current") return success(null);
      if (method !== "GET" && state.failWrite) return failure("NOT_ALLOWED", "fixture rejected write", 403);
      const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
      const key = { "task-repeat-cfgs": "repeats", notes: "notes", "simple-counters": "counters" }[parts[0]];
      assert.ok(key, `Unexpected endpoint ${path}`);
      const rows = state[key];
      if (method === "GET") {
        if (parts.length === 1) return success(rows.filter((row) => !query.projectId || row.projectId === query.projectId));
        const row = rows.find((item) => item.id === parts[1]);
        return row ? success(state.wrongId ? { ...row, id: "different-id" } : row) : failure("NOT_FOUND", "not found", 404);
      }
      let result;
      if (parts.length === 1 && method === "POST") {
        result = { id: `${key}-new`, ...body };
        rows.push(result);
      } else {
        const row = rows.find((item) => item.id === parts[1]);
        assert.ok(row, "The fixture only writes known ids");
        if (method === "PATCH") { Object.assign(row, body); result = row; }
        else if (method === "DELETE") { rows.splice(rows.indexOf(row), 1); result = { deleted: true, id: row.id }; }
        else if (parts[2] === "value" && method === "PUT") {
          if (body.date && body.date > localDay()) return failure("INVALID_INPUT", "date must not be after today");
          row.countOnDay[body.date ?? localDay()] = body.value;
          result = row;
        } else if (parts[2] === "increment" && method === "POST") {
          if (row.type === "StopWatch") return failure("INVALID_INPUT", "A stopwatch cannot be incremented");
          row.countOnDay[localDay()] = (row.countOnDay[localDay()] ?? 0) + body.by;
          result = row;
        } else assert.fail(`Unexpected write ${method} ${path}`);
      }
      if (state.loseResponse) throw new Error("fetch failed: response lost after write");
      if (method === "DELETE" && state.deletionOverride !== null) return success(state.deletionOverride);
      if (state.wrongId) return success({ ...result, id: "different-id" });
      return success(state.badEntity ? {} : result);
    } },
  };
  const guard = (work) => async (args) => {
    try { return await work(args, cfg); }
    catch (error) { return { ok: false, code: error.code, message: error.message, outcomeUnknown: error.outcomeUnknown === true }; }
  };
  await registerFeatureTools(sdk, { guard, ok: (value) => ({ ok: true, ...value }) });
  return { sdk, state, tools, call: (name, args) => tools.get(name).execute(args) };
}

test("Registers the three supported feature tools with closed schemas", async () => {
  const { tools } = await setup();
  assert.deepEqual([...tools.keys()], ["sp_tasks_repeat", "sp_tasks_notes", "sp_tasks_counters"]);
  for (const tool of tools.values()) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, ["action"]);
  }
});

test("Lists support pagination without mutating SP and preserve project filters", async () => {
  const { state, call } = await setup();
  state.repeats.push({ id: "repeat-2", projectId: "project-1" }, { id: "repeat-3", projectId: "project-2" });
  const first = await call("sp_tasks_repeat", { action: "list", projectId: "project-1", limit: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.total, 2);
  assert.equal(first.repeatConfigs[0].id, "repeat-1");
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 1);
  const second = await call("sp_tasks_repeat", { action: "list", projectId: "project-1", limit: 1, offset: first.nextOffset });
  assert.equal(second.repeatConfigs[0].id, "repeat-2");
  assert.equal(second.nextOffset, null);
  const notes = await call("sp_tasks_notes", { action: "list", projectId: "project-1" });
  assert.equal(notes.notes.length, 1);
  const counters = await call("sp_tasks_counters", { action: "list", limit: 1, offset: 1 });
  assert.equal(counters.counters[0].id, "watch-1");
  assert.ok(state.requests.every((request) => request.method === "GET"));
  assert.deepEqual(state.requests[0].query, { projectId: "project-1" });
});

test("Repeat creation resolves natural dates and uses the verified route", async () => {
  const { state, call } = await setup();
  const result = await call("sp_tasks_repeat", {
    action: "create", taskId: "task-1", quickSetting: "WEEKLY_CURRENT_WEEKDAY", startDate: "下周三", skipOverdue: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(state.requests, [{
    method: "POST", path: "/task-repeat-cfgs", query: {},
    body: { taskId: "task-1", quickSetting: "WEEKLY_CURRENT_WEEKDAY", startDate: resolveDay("下周三").day, skipOverdue: false },
  }]);
});

test("Repeat update supports pause, resume and explicit custom weekdays without losing false values", async () => {
  const { state, call } = await setup();
  assert.equal((await call("sp_tasks_repeat", { action: "update", repeatCfgId: "repeat-1", isPaused: true })).repeatConfig.isPaused, true);
  const resumed = await call("sp_tasks_repeat", { action: "update", repeatCfgId: "repeat-1", isPaused: false, skipOverdue: false });
  assert.equal(resumed.repeatConfig.isPaused, false);
  const custom = await call("sp_tasks_repeat", {
    action: "update", repeatCfgId: "repeat-1", quickSetting: "CUSTOM", repeatCycle: "WEEKLY", repeatEvery: 2,
    monday: false, tuesday: false, wednesday: true, thursday: false, friday: false, saturday: false, sunday: false,
  });
  assert.equal(custom.ok, true);
  assert.equal(state.requests[2].body.monday, false);
  assert.equal(state.requests[2].body.wednesday, true);
  assert.equal(state.requests[2].body.repeatEvery, 2);
});

test("Get returns full note content and encodes URL delimiters in ids", async () => {
  const { state, call } = await setup();
  state.notes[0].id = "one?two#three";
  const result = await call("sp_tasks_notes", { action: "get", noteId: state.notes[0].id });
  assert.equal(result.ok, true);
  assert.equal(result.note.content.length, 1200);
  assert.equal(state.requests[0].path, "/notes/one%3Ftwo%23three");
});

test("Notes can be created in Today or a project, edited, moved separately and deleted", async () => {
  const { state, call } = await setup();
  const created = await call("sp_tasks_notes", { action: "create", content: "one", projectId: null, isPinnedToToday: true });
  assert.equal(created.ok, true);
  assert.equal(created.note.isPinnedToToday, true);
  const moved = await call("sp_tasks_notes", { action: "update", noteId: created.note.id, projectId: "project-1" });
  assert.equal(moved.note.projectId, "project-1");
  const changed = await call("sp_tasks_notes", { action: "update", noteId: created.note.id, content: "", isPinnedToToday: false });
  assert.equal(changed.note.content, "");
  assert.equal(changed.note.isPinnedToToday, false);
  const deleted = await call("sp_tasks_notes", { action: "delete", noteId: created.note.id });
  assert.equal(deleted.result.deleted, true);
  assert.deepEqual(state.requests.map((r) => r.method), ["POST", "PATCH", "PATCH", "DELETE"]);
});

test("Deleting a repeat rule only targets the rule, not its existing task", async () => {
  const { state, call } = await setup();
  const deleted = await call("sp_tasks_repeat", { action: "delete", repeatCfgId: "repeat-1" });
  assert.equal(deleted.result.deleted, true);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.requests[0].path, "/task-repeat-cfgs/repeat-1");
  assert.equal(state.requests[0].method, "DELETE");
});

test("Counter set preserves zero, resolves dates, and increments only once", async () => {
  const { state, call } = await setup();
  const set = await call("sp_tasks_counters", { action: "set", counterId: "counter-1", day: "昨天", value: 0 });
  assert.equal(set.ok, true);
  assert.deepEqual(state.requests[0].body, { date: resolveDay("昨天").day, value: 0 });
  const incremented = await call("sp_tasks_counters", { action: "increment", counterId: "counter-1" });
  assert.equal(incremented.counter.countOnDay[localDay()], 1);
  assert.deepEqual(state.requests[1].body, { by: 1 });
  const watch = await call("sp_tasks_counters", { action: "set", counterId: "watch-1", value: 60000 });
  assert.equal(watch.counter.countOnDay[localDay()], 60000);
  assert.equal("date" in state.requests[2].body, false, "Omitted day uses SP's configured day boundary");
});

test("SP business-rule failures remain failures and are never retried", async () => {
  const { state, call } = await setup();
  const future = await call("sp_tasks_counters", { action: "set", counterId: "counter-1", day: "明天", value: 1 });
  assert.equal(future.ok, false);
  assert.equal(future.code, "INVALID_INPUT");
  const stopwatch = await call("sp_tasks_counters", { action: "increment", counterId: "watch-1" });
  assert.equal(stopwatch.ok, false);
  assert.equal(stopwatch.code, "INVALID_INPUT");
  assert.equal(state.requests.length, 2);
});

test("Invalid and unsupported parameters fail before any request", async (t) => {
  const cases = [
    ["repeat", { action: "create" }],
    ["repeat", { action: "create", taskId: "task-1", quickSetting: "weekly" }],
    ["repeat", { action: "create", taskId: "task-1", quickSetting: "DAILY", repeatEvery: 2 }],
    ["repeat", { action: "create", taskId: "task-1", quickSetting: "CUSTOM", repeatEvery: 0 }],
    ["repeat", { action: "create", taskId: "task-1", quickSetting: "CUSTOM", repeatEvery: 1001 }],
    ["repeat", { action: "create", taskId: "task-1", startDate: "2026-02-30" }],
    ["repeat", { action: "create", taskId: "task-1", repeatUntilDay: "2027-01-01" }],
    ["repeat", { action: "update", repeatCfgId: "repeat-1", startDate: "明天" }],
    ["repeat", { action: "update", repeatCfgId: "repeat-1", isPaused: "false" }],
    ["repeat", { action: "update", repeatCfgId: "repeat-1" }],
    ["repeat", { action: "delete", repeatCfgId: "repeat-1", taskId: "task-1" }],
    ["repeat", { action: "list", limit: 201 }],
    ["repeat", { action: "list", offset: -1 }],
    ["notes", { action: "create", content: "one" }],
    ["notes", { action: "create", content: " ", isPinnedToToday: true }],
    ["notes", { action: "create", content: "one", projectId: " " }],
    ["notes", { action: "update", noteId: "note-1", projectId: "project-2", content: "two" }],
    ["notes", { action: "update", noteId: "note-1", projectId: null }],
    ["notes", { action: "update", noteId: "note-1" }],
    ["notes", { action: "get", noteId: "note-1", content: "ignored?" }],
    ["notes", { action: "list", projectId: null }],
    ["counters", { action: "create" }],
    ["counters", { action: "set", counterId: "counter-1", value: -1 }],
    ["counters", { action: "set", counterId: "counter-1", value: 1.5 }],
    ["counters", { action: "set", counterId: "counter-1", value: Number.MAX_SAFE_INTEGER + 1 }],
    ["counters", { action: "set", counterId: "counter-1", value: 1, day: "2026-02-30" }],
    ["counters", { action: "increment", counterId: "counter-1", by: 0 }],
    ["counters", { action: "increment", counterId: "counter-1", by: 1, day: "昨天" }],
    ["counters", { action: "get", counterId: "" }],
    ["counters", { action: "list", offset: 0.5 }],
  ];
  for (const [feature, args] of cases) {
    await t.test(`${feature} ${JSON.stringify(args)}`, async () => {
      const { state, call } = await setup();
      const result = await call(`sp_tasks_${feature}`, args);
      assert.equal(result.ok, false);
      assert.ok(["SP_BAD_INPUT", "SP_BAD_DATE"].includes(result.code), result.message);
      assert.equal(state.requests.length, 0);
    });
  }
});

test("Write rejection and missing responses never become success or trigger a second write", async () => {
  const { state, call } = await setup();
  state.failWrite = true;
  const rejected = await call("sp_tasks_notes", { action: "create", content: "one", isPinnedToToday: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "NOT_ALLOWED");
  assert.equal(state.notes.length, 1);
  state.failWrite = false;
  state.loseResponse = true;
  const lost = await call("sp_tasks_counters", { action: "increment", counterId: "counter-1", by: 2 });
  assert.equal(lost.ok, false);
  assert.equal(lost.outcomeUnknown, true);
  assert.equal(state.counters[0].countOnDay[localDay()], 2);
  assert.equal(state.requests.length, 2);
});

test("Path-shaped ids are rejected before URL normalization or any request", async (t) => {
  const targets = [
    ["repeat", "repeatCfgId", { action: "delete" }],
    ["notes", "noteId", { action: "get" }],
    ["notes", "noteId", { action: "update", content: "changed" }],
    ["counters", "counterId", { action: "increment" }],
    ["repeat", "taskId", { action: "create" }],
    ["notes", "projectId", { action: "create", content: "new note" }],
  ];
  for (const badId of [".", "..", "../other", "part/child", "part\\child"]) {
    for (const [feature, key, args] of targets) {
      await t.test(`${feature} ${key}=${JSON.stringify(badId)}`, async () => {
        const { state, call } = await setup();
        const result = await call(`sp_tasks_${feature}`, { ...args, [key]: badId });
        assert.equal(result.ok, false);
        assert.equal(result.code, "SP_BAD_INPUT");
        assert.equal(state.requests.length, 0);
      });
    }
  }
});

test("Entity responses must refer to the requested object for reads and all updates", async (t) => {
  const cases = [
    ["repeat", { action: "get", repeatCfgId: "repeat-1" }],
    ["repeat", { action: "update", repeatCfgId: "repeat-1", isPaused: true }],
    ["notes", { action: "get", noteId: "note-1" }],
    ["notes", { action: "update", noteId: "note-1", content: "changed" }],
    ["counters", { action: "get", counterId: "counter-1" }],
    ["counters", { action: "set", counterId: "counter-1", value: 2 }],
    ["counters", { action: "increment", counterId: "counter-1" }],
  ];
  for (const [feature, args] of cases) {
    await t.test(`${feature} ${args.action}`, async () => {
      const { state, call } = await setup();
      state.wrongId = true;
      const result = await call(`sp_tasks_${feature}`, args);
      assert.equal(result.ok, false);
      assert.equal(result.code, "SP_BAD_RESPONSE");
      assert.equal(result.outcomeUnknown, args.action !== "get");
      assert.equal(state.requests.length, 1, "A mismatched response must not trigger another write");
    });
  }
});

test("Deletion requires an explicit acknowledgement for the exact requested id", async (t) => {
  for (const [feature, key, targetId] of [["repeat", "repeatCfgId", "repeat-1"], ["notes", "noteId", "note-1"]]) {
    const replies = [{}, { deleted: false, id: targetId }, { deleted: "true", id: targetId }, { deleted: true }, { deleted: true, id: "different-id" }];
    for (const reply of replies) {
      await t.test(`${feature} ${JSON.stringify(reply)}`, async () => {
        const { state, call } = await setup();
        state.deletionOverride = reply;
        const result = await call(`sp_tasks_${feature}`, { action: "delete", [key]: targetId });
        assert.equal(result.ok, false);
        assert.equal(result.code, "SP_BAD_RESPONSE");
        assert.equal(result.outcomeUnknown, true);
        assert.equal(result.result, undefined);
        assert.equal(state.requests.length, 1);
      });
    }
  }
});

test("A malformed entity after a write is reported as unconfirmed, not created successfully", async () => {
  const { state, call } = await setup();
  state.badEntity = true;
  const result = await call("sp_tasks_notes", { action: "create", content: "one", projectId: "project-1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SP_BAD_RESPONSE");
  assert.equal(result.outcomeUnknown, true);
  assert.equal(state.notes.length, 2);
  assert.equal(state.requests.length, 1);
});

test("Even an uncertain write invalidates the cached task notice", async () => {
  const { state, sdk, call } = await setup();
  const first = await readNotice(sdk);
  assert.match(first, /待办共 1 件/);
  state.tasks.push({ id: "task-2", title: "second", isDone: false });
  assert.equal(await readNotice(sdk), first);
  state.loseResponse = true;
  await call("sp_tasks_repeat", { action: "create", taskId: "task-1" });
  assert.match(await readNotice(sdk), /待办共 2 件/);
});
