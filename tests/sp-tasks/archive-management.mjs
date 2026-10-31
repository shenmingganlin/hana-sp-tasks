import assert from "node:assert/strict";
import test from "node:test";
import { createTaskManager } from "../../sp-tasks/lib/archive-management.js";
import { createArchiveJournal, completionOf, sameCompletion } from "../../sp-tasks/lib/archive-snapshot.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in archive management tests"); };
const clone = (value) => structuredClone(value);
const cfg = { baseUrl: "http://sp.invalid", accessToken: "memory-only-token" };
const ok = (data) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
const reject = (code, status = 403) => new Response(JSON.stringify({ ok: false, error: { code, message: `Fixture ${code}` } }), { status });
const originalDoneOn = 1600000000000;
const archiveTime = 1700000000000;
const task = (id, extra = {}) => ({
  id, title: `Fixture ${id}`, isDone: false, parentId: null, subTaskIds: [],
  projectId: "INBOX_PROJECT", tagIds: [], ...extra,
});
const family = (parentDone = false, childDone = false) => [
  task("parent", { isDone: parentDone, ...(parentDone ? { doneOn: originalDoneOn } : {}), subTaskIds: ["child"] }),
  task("child", { parentId: "parent", isDone: childDone, ...(childDone ? { doneOn: originalDoneOn + 1 } : {}) }),
];
const resultFor = (payload, id) => payload.results?.find((row) => row.id === id);
const errorCodes = (payload) => [payload.fatal?.code, ...(payload.results ?? []).map((row) => row.code), ...(payload.completionSync?.failed ?? []).map((row) => row.code)].filter(Boolean);
function failedWith(payload, code) {
  const codes = errorCodes(payload);
  assert.ok(codes.some((value) => typeof code === "string" ? value === code : code.test(value)), `Expected ${code}; got ${JSON.stringify(payload)}`);
}
function successful(payload, changed) {
  assert.equal(payload.fatal, undefined, payload.fatal?.message);
  assert.equal(payload.failed, 0, JSON.stringify(payload));
  if (changed !== undefined) assert.equal(payload.changed, changed, JSON.stringify(payload));
  assert.ok(payload.results.every((row) => row.ok === true), JSON.stringify(payload));
}

function setup({ tasks = family(), archived = [], bridgeStatus } = {}) {
  const state = {
    tasks: clone(tasks), archived: clone(archived), store: new Map(), requests: [], events: [], bridgeCalls: [],
    rejectBefore: new Map(), loseAfter: new Set(), dishonestPatch: new Set(),
    hiddenProjectIds: new Set(), repeats: [], schedulePatches: [],
    failStorageSet: null, bridgeStatus: bridgeStatus ?? { connected: true, pluginVersion: "0.2.0" },
    bridgeReject: new Set(), bridgeIgnoreWrite: false,
  };
  const active = (id) => state.tasks.find((row) => row.id === id);
  // updateTimeEstimateForTask: a child's isDone change recomputes its parent's estimate.
  const recalcParent = (row) => {
    const parent = row.parentId && active(row.parentId);
    if (!parent || typeof parent.timeEstimate !== "number") return;
    parent.timeEstimate = parent.subTaskIds.map(active).filter(Boolean).reduce((sum, child) => sum + (child.isDone ? 0 : Math.max(0, (child.timeEstimate || 0) - (child.timeSpent || 0))), 0);
  };
  function subtree(rows, id) {
    const selected = new Set([id]);
    let previous;
    do {
      previous = selected.size;
      for (const row of rows) if (selected.has(row.id) || selected.has(row.parentId)) {
        selected.add(row.id);
        for (const child of row.subTaskIds ?? []) selected.add(child);
      }
    } while (previous !== selected.size);
    return selected;
  }
  const sdk = {
    storage: { global: {
      get: async (key) => clone(state.store.get(key) ?? null),
      set: async (key, value) => {
        state.events.push({ type: "storage", key, value: clone(value) });
        if (state.failStorageSet?.(value)) throw new Error("Injected persistence failure");
        state.store.set(key, clone(value));
      },
      delete: async (key) => { state.events.push({ type: "storage-delete", key }); state.store.delete(key); },
      keys: async () => [...state.store.keys()],
    } },
    network: { fetch: async (rawUrl, init) => {
      const url = new URL(rawUrl);
      assert.equal(url.origin, cfg.baseUrl);
      assert.equal(init.headers.Authorization, `Bearer ${cfg.accessToken}`);
      const method = init.method;
      const path = url.pathname;
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      const request = { method, path, body, query: Object.fromEntries(url.searchParams) };
      state.requests.push(request);
      state.events.push({ type: "request", ...clone(request) });
      const key = `${method} ${path}`;
      if (state.rejectBefore.has(key)) return reject(state.rejectBefore.get(key));
      let response;
      if (method === "GET" && path === "/tasks") {
        const source = url.searchParams.get("source") ?? "active";
        let rows = source === "archived" ? state.archived : source === "all" ? [...state.tasks, ...state.archived] : state.tasks;
        if (source === "active") rows = rows.filter((row) => !state.hiddenProjectIds.has(row.projectId));
        if (url.searchParams.get("includeDone") !== "true") rows = rows.filter((row) => !row.isDone);
        response = ok(rows);
      } else if (method === "GET" && path === "/task-repeat-cfgs") {
        response = ok(state.repeats);
      } else if (method === "GET" && path.startsWith("/task-repeat-cfgs/")) {
        const config = state.repeats.find((row) => row.id === decodeURIComponent(path.slice("/task-repeat-cfgs/".length)));
        response = config ? ok(config) : reject("NOT_FOUND", 404);
      } else {
        const match = path.match(/^\/tasks\/([^/]+)(?:\/(archive|restore))?$/);
        assert.ok(match, `Unexpected archive route ${method} ${path}`);
        const id = decodeURIComponent(match[1]), action = match[2];
        if (action === "restore" && method === "POST") {
          const root = state.archived.find((row) => row.id === id);
          if (!root) return reject("TASK_NOT_FOUND", 404);
          const ids = subtree(state.archived, id);
          const restored = state.archived.filter((row) => ids.has(row.id));
          state.archived = state.archived.filter((row) => !ids.has(row.id));
          // SP deletes flat archive entities and surviving parent.subTaskIds,
          // but leaves the parent's historical subTasks array untouched.
          for (const row of state.archived) row.subTaskIds = row.subTaskIds.filter((child) => !ids.has(child));
          root.isDone = false;
          delete root.doneOn;
          for (const row of restored) if (!active(row.id)) state.tasks.push(row);
          // SP adopts an already restored child when its archived parent returns.
          const children = state.tasks.filter((row) => row.parentId === id).map((row) => row.id);
          root.subTaskIds = [...new Set([...root.subTaskIds, ...children])];
          response = ok(root);
        } else {
          const row = active(id);
          if (!row) return reject("TASK_NOT_FOUND", 404);
          if (method === "GET" && !action) response = ok(row);
          else if (method === "PATCH" && !action && !Object.hasOwn(body, "isDone")) {
            assert.ok(Object.keys(body).length && (Object.keys(body).every((key) => ["dueDay", "dueWithTime"].includes(key)) || Object.keys(body).join() === "timeEstimate"), "Repair only writes dueDay/dueWithTime or a parent timeEstimate");
            state.schedulePatches.push({ id, body: clone(body) });
            if (!state.dishonestPatch.has(id)) Object.assign(row, body);
            response = ok(row);
          } else if (method === "PATCH" && !action) {
            assert.deepEqual(Object.keys(body), ["isDone"], "REST cannot write arbitrary completion timestamps");
            assert.equal(typeof body.isDone, "boolean");
            const applied = { ...row, isDone: body.isDone };
            if (body.isDone) applied.doneOn = archiveTime + 100;
            else delete applied.doneOn;
            if (!state.dishonestPatch.has(id)) {
              Object.assign(row, applied);
              if (!body.isDone) delete row.doneOn;
              recalcParent(row);
            }
            response = ok(applied);
          } else if (method === "DELETE" && !action || method === "POST" && action === "archive") {
            const ids = subtree(state.tasks, id);
            const moved = state.tasks.filter((item) => ids.has(item.id));
            if (action === "archive") {
              // flattenTasks preserves the root's pre-archive subTasks snapshot
              // alongside separately stored, completion-stamped child entities.
              for (const item of moved) item.subTasks = clone(moved.filter((child) => item.subTaskIds.includes(child.id)));
              for (const item of moved) {
                if (!item.isDone || !item.doneOn) item.doneOn = archiveTime;
                item.isDone = true;
                // mapTasksToArchiveFormat clears scheduling fields but keeps deadlines.
                delete item.dueDay;
                delete item.dueWithTime;
              }
              state.archived.push(...moved);
            }
            state.tasks = state.tasks.filter((item) => !ids.has(item.id));
            response = ok({ id, [action === "archive" ? "archived" : "deleted"]: true });
          } else assert.fail(`Unexpected archive operation ${method} ${path}`);
        }
      }
      if (state.loseAfter.delete(key)) throw new Error("fetch failed after the fixture committed its write");
      return response;
    } },
  };
  const bridge = {
    status: async () => clone(state.bridgeStatus),
    execute: async (operation, args) => {
      state.bridgeCalls.push({ operation, args: clone(args) });
      state.events.push({ type: "bridge", operation, args: clone(args) });
      assert.equal(operation, "tasks.repairCompletion");
      assert.deepEqual(Object.keys(args).sort(), ["desired", "expected", "taskId"]);
      for (const completion of [args.expected, args.desired]) assert.deepEqual(Object.keys(completion).sort(), ["doneOn", "isDone", "wontDoOn"]);
      const row = active(args.taskId);
      assert.ok(row, "Completion repair only accepts active tasks");
      if (sameCompletion(row, args.desired)) return { id: row.id, completion: completionOf(row), unchanged: true };
      if (!sameCompletion(row, args.expected)) throw Object.assign(new Error("Completion state changed"), { code: "SP_COMPLETION_CONFLICT" });
      if ((row.wontDoOn ?? null) !== args.desired.wontDoOn) throw Object.assign(new Error("SP cannot write wontDoOn"), { code: "SP_COMPLETION_UNSUPPORTED" });
      if (state.bridgeReject.has(row.id)) throw Object.assign(new Error("Repair failed"), { code: "SP_PLUGIN_ERROR", outcomeUnknown: true });
      if (!state.bridgeIgnoreWrite) {
        row.isDone = args.desired.isDone;
        if (args.desired.doneOn === null) delete row.doneOn;
        else row.doneOn = args.desired.doneOn;
        recalcParent(row);
      }
      return { id: row.id, completion: clone(args.desired), unchanged: false };
    },
  };
  const manager = createTaskManager(sdk, { bridge });
  const run = async (args) => {
    try { return await manager(args, cfg); }
    catch (error) { return { fatal: { code: error.code, message: error.message, outcomeUnknown: error.outcomeUnknown } }; }
  };
  return { state, sdk, bridge, active, run, journal: createArchiveJournal(sdk, cfg), writes: () => state.requests.filter((row) => row.method !== "GET") };
}

test("archive persists full metadata for the whole subtree before its single root write", async () => {
  const f = setup({ tasks: family(true, false) });
  const original = Object.fromEntries(f.state.tasks.map((row) => [row.id, completionOf(row)]));
  const result = await f.run({ action: "archive", taskIds: ["parent", "child", "parent"] });
  successful(result, 2);
  assert.equal(resultFor(result, "child").coveredBy, "parent");
  assert.deepEqual(f.writes().map((row) => `${row.method} ${row.path}`), ["POST /tasks/parent/archive"]);
  const journal = await f.journal.find("parent");
  assert.deepEqual(Object.fromEntries(journal.items.map((row) => [row.taskId, row.original])), original);
  assert.equal(journal.items.find((row) => row.taskId === "child").parentId, "parent");
  const saved = f.state.events.findIndex((event) => event.type === "storage");
  const sent = f.state.events.findIndex((event) => event.type === "request" && event.method === "POST");
  assert.ok(saved >= 0 && saved < sent);
  assert.equal(f.state.archived.find((row) => row.id === "parent").doneOn, originalDoneOn);
  assert.equal(f.state.archived.find((row) => row.id === "child").doneOn, archiveTime);
});

test("failed durable journal write prevents archive and leaves tasks untouched", async () => {
  const f = setup();
  const before = clone(f.state.tasks);
  f.state.failStorageSet = () => true;
  const result = await f.run({ action: "archive", taskIds: ["parent"] });
  failedWith(result, "SP_ARCHIVE_STORAGE");
  assert.equal(f.writes().length, 0);
  assert.deepEqual(f.state.tasks, before);
});

test("archiving a child without its parent is rejected before any SP write", async () => {
  const f = setup();
  const result = await f.run({ action: "archive", taskIds: ["child"] });
  assert.ok(errorCodes(result).length, JSON.stringify(result));
  assert.equal(f.writes().length, 0);
  assert.equal(f.state.tasks.length, 2);
});

test("restore requires complete scoped metadata and will not guess from legacy booleans", async (t) => {
  for (const legacy of [false, true]) {
    await t.test(legacy ? "legacy snapshot" : "no snapshot", async () => {
      const f = setup({ tasks: [], archived: [task("old", { isDone: true, doneOn: archiveTime })] });
      if (legacy) f.state.store.set("sp-tasks:archive-snapshot:old", { at: Date.now(), isDoneById: { old: true } });
      const result = await f.run({ action: "restore", taskIds: ["old"] });
      failedWith(result, legacy ? /LEGACY/ : "SP_COMPLETION_SNAPSHOT_MISSING");
      assert.equal(f.writes().length, 0);
      assert.equal(f.state.archived.length, 1);
    });
  }
});

test("explicit completion loss returns native behavior with an honest degraded result", async () => {
  const f = setup({ tasks: [], archived: family(true, true) });
  const result = await f.run({ action: "restore", taskIds: ["parent"], allowCompletionLoss: true });
  assert.equal(result.failed, 0, JSON.stringify(result));
  assert.equal(result.partial, true);
  assert.ok(result.completionSync.degradedRoots.length > 0);
  assert.equal(f.active("parent").isDone, false);
  assert.equal(f.active("child").isDone, true);
  assert.equal(f.state.bridgeCalls.length, 0);
});

test("historical completion requires a connected companion at least version 0.2.0 before restore", async (t) => {
  for (const bridgeStatus of [{ connected: false, pluginVersion: "0.2.0" }, { connected: true, pluginVersion: "0.1.0" }]) {
    await t.test(JSON.stringify(bridgeStatus), async () => {
      const f = setup({ tasks: [task("done", { isDone: true, doneOn: originalDoneOn })], bridgeStatus });
      successful(await f.run({ action: "archive", taskIds: ["done"] }), 1);
      const before = f.writes().length;
      const result = await f.run({ action: "restore", taskIds: ["done"] });
      assert.ok(errorCodes(result).length, JSON.stringify(result));
      assert.equal(f.writes().length, before);
      assert.equal(f.state.archived[0].id, "done");
    });
  }
});

test("explicit completion loss can restore a saved completed task without a companion", async () => {
  const f = setup({ tasks: [task("done", { isDone: true, doneOn: originalDoneOn })], bridgeStatus: { connected: false, pluginVersion: "0.2.0" } });
  successful(await f.run({ action: "archive", taskIds: ["done"] }), 1);
  const result = await f.run({ action: "restore", taskIds: ["done"], allowCompletionLoss: true });
  assert.equal(result.failed, 0, JSON.stringify(result));
  assert.equal(result.partial, true);
  assert.ok(result.completionSync.degradedRoots.length > 0);
  assert.equal(f.active("done").isDone, false);
  assert.equal(f.active("done").doneOn, undefined);
  assert.equal(f.state.bridgeCalls.length, 0);
  const journal = await f.journal.find("done");
  assert.equal(journal.items.find((item) => item.taskId === "done").phase, "pending");
  f.state.bridgeStatus.connected = true;
  successful(await f.run({ action: "repair", taskIds: ["done"] }), 1);
  assert.equal(f.active("done").doneOn, originalDoneOn);
  assert.equal(f.writes().filter((row) => row.path.endsWith("/restore")).length, 1);
});

test("explicit native completion never automatically patches a known child and can keep the resulting state", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  const result = await f.run({ action: "restore", taskIds: ["parent"], allowCompletionLoss: true });
  assert.equal(result.failed, 0, JSON.stringify(result));
  assert.equal(result.partial, true);
  assert.ok(result.completionSync.degradedRoots.length > 0);
  assert.equal(f.active("parent").isDone, false);
  assert.equal(f.active("child").isDone, true);
  assert.equal(f.writes().filter((row) => row.method === "PATCH").length, 0);
  assert.equal(f.state.bridgeCalls.length, 0);
  const before = f.writes().length;
  successful(await f.run({ action: "repair", taskIds: ["parent"], keepCurrentCompletion: true }), 1);
  assert.equal(f.writes().length, before);
  assert.equal(f.active("child").isDone, true);
});

test("archive and restore preserve the original three completion fields across the four acceptance cases", async (t) => {
  for (const [name, tasks, rootId] of [
    ["completed standalone", [task("one", { isDone: true, doneOn: originalDoneOn, wontDoOn: originalDoneOn - 1 })], "one"],
    ["open standalone", [task("one")], "one"],
    ["open parent and child", family(false, false), "parent"],
    ["completed parent and child", family(true, true), "parent"],
  ]) {
    await t.test(name, async () => {
      const f = setup({ tasks });
      const original = tasks.map((row) => ({ id: row.id, completion: completionOf(row) }));
      successful(await f.run({ action: "archive", taskIds: [rootId] }), 1);
      successful(await f.run({ action: "restore", taskIds: [rootId] }), 1);
      for (const row of original) assert.deepEqual(completionOf(f.active(row.id)), row.completion);
      const journal = await f.journal.find(rootId);
      assert.ok(!journal || journal.items.every((item) => item.phase === "complete"));
      assert.ok(f.writes().filter((row) => row.method === "PATCH").every((row) => row.body.isDone === false));
    });
  }
});

test("pending completion repair is durable and repair never repeats POST restore", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.rejectBefore.set("PATCH /tasks/child", "PATCH_REJECTED");
  const result = await f.run({ action: "restore", taskIds: ["parent"] });
  assert.equal(result.changed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.partial, true);
  assert.equal(resultFor(result, "parent").restored, true);
  assert.ok(result.completionSync.failed.length > 0);
  const pending = await f.journal.find("child");
  const child = pending.items.find((item) => item.taskId === "child");
  assert.equal(child.phase, "pending");
  assert.deepEqual(child.expected, { isDone: true, doneOn: archiveTime, wontDoOn: null });
  const restoreEvent = f.state.events.findIndex((event) => event.type === "request" && event.path.endsWith("/restore"));
  assert.ok(f.state.events.slice(0, restoreEvent).some((event) => event.type === "storage" && event.value.roots.some((root) => root.items.some((item) => item.phase === "restoring" && item.expected))));
  f.state.rejectBefore.clear();
  successful(await f.run({ action: "repair", taskIds: ["parent"] }), 1);
  assert.deepEqual(completionOf(f.active("child")), { isDone: false, doneOn: null, wontDoOn: null });
  assert.equal(f.writes().filter((row) => row.path.endsWith("/restore")).length, 1);
});

test("repair detects user edits, then explicit keep-current consumes pending state without writes", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.rejectBefore.set("PATCH /tasks/child", "PATCH_REJECTED");
  await f.run({ action: "restore", taskIds: ["parent"] });
  f.state.rejectBefore.clear();
  f.active("child").doneOn = archiveTime + 500;
  const before = f.writes().length;
  const conflict = await f.run({ action: "repair", taskIds: ["parent"] });
  failedWith(conflict, "SP_COMPLETION_CONFLICT");
  assert.equal(f.writes().length, before);
  const current = completionOf(f.active("child"));
  successful(await f.run({ action: "repair", taskIds: ["parent"], keepCurrentCompletion: true }), 1);
  assert.equal(f.writes().length, before);
  assert.deepEqual(completionOf(f.active("child")), current);
  const journal = await f.journal.find("parent");
  assert.ok(!journal || journal.items.every((item) => item.phase === "complete"));
});

test("a lost restore response is repaired from observed live state with no second restore request", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.loseAfter.add("POST /tasks/parent/restore");
  const result = await f.run({ action: "restore", taskIds: ["parent"] });
  assert.equal(resultFor(result, "parent")?.outcomeUnknown ?? result.fatal?.outcomeUnknown, true, JSON.stringify(result));
  assert.ok(f.active("parent"));
  const before = f.state.requests.length;
  successful(await f.run({ action: "repair", taskIds: ["parent"] }), 1);
  assert.equal(f.state.requests[before].method, "GET");
  assert.equal(f.writes().filter((row) => row.path.endsWith("/restore")).length, 1);
  assert.equal(f.active("child").isDone, false);
});

test("a lost completion PATCH response is confirmed by reading, never by repeating that PATCH", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.loseAfter.add("PATCH /tasks/child");
  await f.run({ action: "restore", taskIds: ["parent"] });
  const patches = f.writes().filter((row) => row.method === "PATCH").length;
  successful(await f.run({ action: "repair", taskIds: ["parent"] }), 1);
  assert.equal(f.writes().filter((row) => row.method === "PATCH").length, patches);
  assert.equal(f.active("child").isDone, false);
});

test("successful-looking PATCH acknowledgements cannot replace post-write readback verification", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.dishonestPatch.add("child");
  const result = await f.run({ action: "restore", taskIds: ["parent"] });
  assert.equal(result.failed, 1, JSON.stringify(result));
  assert.equal(result.partial, true);
  assert.equal(f.active("child").isDone, true);
  const pending = await f.journal.find("child");
  assert.equal(pending.items.find((row) => row.taskId === "child").phase, "pending");
});

test("restoring a child consumes only that snapshot item and later parent restoration preserves its new state", async () => {
  const f = setup({ tasks: family(false, false) });
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  const archivedParent = f.state.archived.find((row) => row.id === "parent");
  assert.equal(archivedParent.subTasks[0].isDone, false);
  assert.equal(f.state.archived.find((row) => row.id === "child").isDone, true);
  successful(await f.run({ action: "restore", taskIds: ["child"] }), 1);
  assert.deepEqual(f.state.archived.map((row) => row.id), ["parent"]);
  assert.deepEqual(archivedParent.subTaskIds, []);
  assert.equal(archivedParent.subTasks[0].id, "child", "The SP archive still embeds the old child snapshot");
  assert.equal(f.active("child").parentId, "parent");
  assert.deepEqual(completionOf(f.active("child")), { isDone: false, doneOn: null, wontDoOn: null });
  const journal = await f.journal.find("parent");
  assert.equal(journal.items.find((row) => row.taskId === "child").phase, "complete");
  assert.notEqual(journal.items.find((row) => row.taskId === "parent").phase, "complete");
  f.active("child").isDone = true;
  f.active("child").doneOn = archiveTime + 900;
  const before = f.state.bridgeCalls.length, writesBefore = f.writes().length;
  const restoredParent = await f.run({ action: "restore", taskIds: ["parent"] });
  successful(restoredParent, 1);
  assert.equal(restoredParent.completionSync.checked, 1, "Only the newly restored parent needs verification");
  assert.equal(f.active("child").isDone, true, "Consumed child metadata must not be replayed over a later user edit");
  assert.equal(f.active("child").doneOn, archiveTime + 900);
  assert.ok(f.state.bridgeCalls.slice(before).every((call) => call.args.taskId !== "child"));
  assert.deepEqual(f.writes().slice(writesBefore).map((row) => `${row.method} ${row.path}`), ["POST /tasks/parent/restore"]);
  assert.deepEqual(f.active("parent").subTaskIds, ["child"]);
  assert.equal((await f.journal.find("parent")).phase, "complete");
});

test("archive membership and completion come from flat entities, never stale nested snapshots", async () => {
  const f = setup({ tasks: family(false, true) });
  f.active("parent").subTasks = [
    task("child", { parentId: "old-parent", isDone: false, doneOn: archiveTime }),
    task("ghost", { parentId: "parent", subTaskIds: ["parent"] }),
  ];
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  const record = await f.journal.find("parent");
  assert.deepEqual(record.items.map((item) => item.taskId).sort(), ["child", "parent"]);
  assert.deepEqual(record.items.find((item) => item.taskId === "child").original, { isDone: true, doneOn: originalDoneOn + 1, wontDoOn: null });
  assert.deepEqual(f.state.archived.map((row) => row.id).sort(), ["child", "parent"]);
});

test("a nested snapshot cannot fill a missing flat child referenced by subTaskIds", async () => {
  const rows = family(); rows[0].subTasks = [clone(rows[1])];
  const f = setup({ tasks: [rows[0]] });
  const result = await f.run({ action: "archive", taskIds: ["parent"] });
  failedWith(result, "SP_INCOMPLETE_TASK_TREE");
  assert.equal(f.writes().length, 0);
  assert.equal((await f.journal.list()).length, 0);
});

test("old pending child recovery reads the active entity despite its archived parent's nested snapshot", async (t) => {
  for (const changedByUser of [false, true]) {
    await t.test(changedByUser ? "new current state remains protected" : "native restore already matches original", async () => {
      const f = setup();
      successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
      const ref = await f.journal.find("child");
      const original = { isDone: false, doneOn: null, wontDoOn: null };
      await f.journal.mark(ref, ["child"], "restoring", { expected: original, restoredParentId: "parent", stage: "restore" });
      // Reproduce an older build's unfinished journal after SP committed the restore.
      await f.sdk.network.fetch(`${cfg.baseUrl}/tasks/child/restore`, { method: "POST", headers: { Authorization: `Bearer ${cfg.accessToken}` } });
      assert.deepEqual(f.state.archived.map((row) => row.id), ["parent"]);
      assert.equal(f.state.archived[0].subTasks[0].id, "child");
      if (changedByUser) {
        Object.assign(f.active("child"), { isDone: true, doneOn: archiveTime + 900 });
        const fetch = f.sdk.network.fetch;
        f.sdk.network.fetch = async (url, init) => {
          const response = await fetch(url, init), parsed = new URL(url);
          if (init.method === "GET" && parsed.pathname === "/tasks" && parsed.searchParams.get("source") === "all") {
            const payload = await response.json();
            return ok(payload.data.map((row) => row.id === "child" ? { ...row, ...original } : row));
          }
          return response;
        };
      }
      const before = f.writes().length, actual = completionOf(f.active("child"));
      const result = await f.run({ action: "repair", taskIds: ["child"] });
      if (changedByUser) {
        failedWith(result, "SP_COMPLETION_CONFLICT");
        assert.equal(result.completionSync.failed[0].code, "SP_COMPLETION_CONFLICT", "Exact GET must override stale list and nested values");
        assert.equal((await f.journal.find("child")).items.find((item) => item.taskId === "child").phase, "pending");
        successful(await f.run({ action: "repair", taskIds: ["child"], keepCurrentCompletion: true }), 1);
      } else successful(result, 1);
      assert.equal(f.writes().length, before, "Recovery must neither restore again nor overwrite current completion");
      assert.deepEqual(completionOf(f.active("child")), actual);
      const recovered = await f.journal.find("child");
      assert.equal(recovered.items.find((item) => item.taskId === "child").phase, "complete");
      assert.equal(recovered.items.find((item) => item.taskId === "parent").phase, "archived");
    });
  }
});

test("a real flat archived entity still prevents repair even when an active entity exists", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  const ref = await f.journal.find("child"), archivedChild = clone(f.state.archived.find((row) => row.id === "child"));
  const original = { isDone: false, doneOn: null, wontDoOn: null };
  await f.journal.mark(ref, ["child"], "restoring", { expected: original, restoredParentId: "parent", stage: "restore" });
  await f.sdk.network.fetch(`${cfg.baseUrl}/tasks/child/restore`, { method: "POST", headers: { Authorization: `Bearer ${cfg.accessToken}` } });
  f.state.archived.push(archivedChild);
  const before = f.writes().length;
  const result = await f.run({ action: "repair", taskIds: ["child"] });
  failedWith(result, "SP_RESTORE_PENDING");
  assert.equal(f.writes().length, before);
  assert.notEqual((await f.journal.find("child")).items.find((item) => item.taskId === "child").phase, "complete");
});

test("tasks hidden from active lists by an archived project still support archive and restore", async () => {
  const f = setup({ tasks: [task("hidden", { projectId: "archived-project" })] });
  f.state.hiddenProjectIds.add("archived-project");
  successful(await f.run({ action: "archive", taskIds: ["hidden"] }), 1);
  assert.equal(f.state.archived[0].id, "hidden");
  successful(await f.run({ action: "restore", taskIds: ["hidden"] }), 1);
  assert.deepEqual(completionOf(f.active("hidden")), { isDone: false, doneOn: null, wontDoOn: null });
  assert.equal(f.active("hidden").projectId, "archived-project");
  assert.ok(f.state.requests.some((row) => row.query.source === "all" || row.path === "/tasks/hidden"));
});

test("restoring a completed child cannot complete a missing or unfinished parent as a side effect", async (t) => {
  for (const parentActive of [false, true]) {
    await t.test(parentActive ? "active unfinished parent" : "parent still archived", async () => {
      const f = setup({ tasks: family(true, true) });
      successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
      if (parentActive) {
        const parent = f.state.archived.find((row) => row.id === "parent");
        f.state.archived = f.state.archived.filter((row) => row.id !== "parent");
        parent.isDone = false;
        delete parent.doneOn;
        f.state.tasks.push(parent);
      }
      const before = f.writes().length;
      const result = await f.run({ action: "restore", taskIds: ["child"] });
      failedWith(result, "SP_COMPLETION_PARENT_UNSUPPORTED");
      assert.equal(f.writes().length, before);
      assert.equal(f.state.bridgeCalls.length, 0);
      assert.ok(f.state.archived.some((row) => row.id === "child"));
    });
  }
});

test("linked issues block completion transitions before restore for every association field", async (t) => {
  for (const field of ["issueId", "issueProviderId", "issueType"]) {
    await t.test(field, async () => {
      const f = setup({ tasks: [task("linked", { isDone: true, doneOn: originalDoneOn, [field]: "external-issue" })] });
      successful(await f.run({ action: "archive", taskIds: ["linked"] }), 1);
      const before = f.writes().length;
      const result = await f.run({ action: "restore", taskIds: ["linked"] });
      failedWith(result, "SP_COMPLETION_ISSUE_UNSUPPORTED");
      assert.equal(f.writes().length, before);
      assert.equal(f.state.bridgeCalls.length, 0);
      assert.equal(f.state.archived[0].id, "linked");
      assert.equal(f.active("linked"), undefined);
    });
  }
});

test("a completed active parent linked to an issue blocks child completion before restore", async (t) => {
  for (const field of ["issueId", "issueProviderId", "issueType"]) {
    await t.test(field, async () => {
      const f = setup({ tasks: family(true, true) });
      f.active("parent")[field] = "parent-external-issue";
      successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
      const parent = f.state.archived.find((row) => row.id === "parent");
      f.state.archived = f.state.archived.filter((row) => row.id !== "parent");
      f.state.tasks.push(parent);
      const before = f.writes().length;
      const parentBefore = clone(parent);
      const result = await f.run({ action: "restore", taskIds: ["child"] });
      failedWith(result, "SP_COMPLETION_ISSUE_UNSUPPORTED");
      assert.equal(f.writes().length, before);
      assert.equal(f.state.bridgeCalls.length, 0);
      assert.deepEqual(f.active("parent"), parentBefore);
      assert.ok(f.state.archived.some((row) => row.id === "child"));
      assert.equal(f.active("child"), undefined);
    });
  }
});

test("linked issues permit historical doneOn repair when isDone stays unchanged", async () => {
  const f = setup({ tasks: family(false, true) });
  Object.assign(f.active("child"), { issueId: "external-issue", issueProviderId: "jira-provider", issueType: "JIRA" });
  f.active("parent").issueProviderId = "parent-provider";
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.archived.find((row) => row.id === "child").doneOn = archiveTime;
  successful(await f.run({ action: "restore", taskIds: ["parent"] }), 1);
  assert.deepEqual(completionOf(f.active("child")), { isDone: true, doneOn: originalDoneOn + 1, wontDoOn: null });
  assert.equal(f.state.bridgeCalls.length, 1);
  assert.deepEqual(f.state.bridgeCalls[0].args, {
    taskId: "child",
    expected: { isDone: true, doneOn: archiveTime, wontDoOn: null },
    desired: { isDone: true, doneOn: originalDoneOn + 1, wontDoOn: null },
  });
  assert.deepEqual(f.writes().map((row) => `${row.method} ${row.path}`), ["POST /tasks/parent/archive", "POST /tasks/parent/restore"]);
});

test("completion-triggered repeat rules prevent preservation before REST restore can generate another instance", async (t) => {
  for (const [flag, isPaused] of [["waitForCompletion", false], ["repeatFromCompletionDate", false], ["waitForCompletion", true], ["repeatFromCompletionDate", true]]) {
    await t.test(`${flag}, paused=${isPaused}`, async () => {
      const f = setup({ tasks: [task("repeat-source", { isDone: true, doneOn: originalDoneOn, repeatCfgId: "repeat-1" })] });
      f.state.repeats.push({ id: "repeat-1", repeatCycle: "DAILY", isPaused, [flag]: true });
      successful(await f.run({ action: "archive", taskIds: ["repeat-source"] }), 1);
      const before = f.writes().length;
      const result = await f.run({ action: "restore", taskIds: ["repeat-source"] });
      failedWith(result, /REPEAT/);
      assert.equal(f.writes().length, before);
      assert.equal(f.state.bridgeCalls.length, 0);
    });
  }
});

test("failed durable restoring state prevents the native restore from starting", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.failStorageSet = (document) => document.roots?.some((root) => root.items.some((item) => item.phase === "restoring"));
  const before = f.writes().length;
  const result = await f.run({ action: "restore", taskIds: ["parent"] });
  failedWith(result, "SP_ARCHIVE_STORAGE");
  assert.equal(f.writes().length, before);
  assert.equal(f.state.tasks.length, 0);
  assert.equal(f.state.archived.length, 2);
});

test("a completion acknowledgement storage failure is recovered by reading without another PATCH", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.failStorageSet = (document) => document.roots?.some((root) => root.items.some((item) => item.taskId === "child" && item.phase === "complete"));
  const result = await f.run({ action: "restore", taskIds: ["parent"] });
  failedWith(result, "SP_ARCHIVE_STORAGE");
  assert.equal(result.partial, true);
  assert.equal(f.active("child").isDone, false);
  const before = f.writes().length;
  f.state.failStorageSet = null;
  successful(await f.run({ action: "repair", taskIds: ["parent"] }), 1);
  assert.equal(f.writes().length, before);
  const journal = await f.journal.find("parent");
  assert.ok(!journal || journal.items.every((item) => item.phase === "complete"));
});

test("archive recovery records older than 30 days remain usable", async () => {
  const f = setup({ tasks: [task("old", { isDone: true, doneOn: originalDoneOn })] });
  successful(await f.run({ action: "archive", taskIds: ["old"] }), 1);
  for (const document of f.state.store.values()) {
    for (const root of document.roots ?? []) root.createdAt = root.updatedAt = Date.now() - 45 * 86400000;
  }
  successful(await f.run({ action: "restore", taskIds: ["old"] }), 1);
  assert.equal(f.active("old").doneOn, originalDoneOn);
});

test("an independent root failure does not prevent another root from being archived", async () => {
  const f = setup({ tasks: [task("failed"), task("independent")] });
  f.state.rejectBefore.set("POST /tasks/failed/archive", "ARCHIVE_REJECTED");
  const result = await f.run({ action: "archive", taskIds: ["failed", "independent"] });
  assert.equal(result.changed, 1);
  assert.equal(result.failed, 1);
  assert.equal(resultFor(result, "failed").ok, false);
  assert.equal(resultFor(result, "independent").ok, true);
  assert.ok(f.active("failed"));
  assert.equal(f.active("independent"), undefined);
});

test("delete keeps root cascade semantics without issuing completion repairs", async () => {
  const f = setup();
  const result = await f.run({ action: "delete", taskIds: ["parent", "child"] });
  successful(result, 2);
  assert.equal(resultFor(result, "child").coveredBy, "parent");
  assert.deepEqual(f.writes().map((row) => `${row.method} ${row.path}`), ["DELETE /tasks/parent"]);
  assert.equal(f.state.bridgeCalls.length, 0);
});

test("recovery is read-only and reports an unfinished completion repair", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.rejectBefore.set("PATCH /tasks/child", "PATCH_REJECTED");
  await f.run({ action: "restore", taskIds: ["parent"] });
  const before = f.writes().length;
  const result = await f.run({ action: "recovery", taskIds: ["parent"] });
  assert.equal(result.fatal, undefined, JSON.stringify(result));
  assert.equal(result.action, "recovery");
  assert.match(JSON.stringify(result), /child/);
  assert.match(JSON.stringify(result), /pending/);
  assert.equal(f.writes().length, before);
});

test("a child rearchived independently is not adopted through a nested snapshot on its old parent", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  successful(await f.run({ action: "restore", taskIds: ["child"] }), 1);
  f.active("child").parentId = null;
  successful(await f.run({ action: "archive", taskIds: ["child"] }), 1);
  const before = f.writes().length;
  const result = await f.run({ action: "restore", taskIds: ["parent"] });
  successful(result, 1);
  assert.deepEqual(f.writes().slice(before).map((row) => `${row.method} ${row.path}`), ["POST /tasks/parent/restore"]);
  assert.deepEqual(f.active("parent").subTaskIds, []);
  assert.equal(f.active("child"), undefined);
  assert.equal((await f.journal.find("child")).phase, "archived");
  assert.equal(f.state.archived.find((row) => row.id === "child").parentId, null);
});

test("a contradictory flat subTaskIds reference still refuses to adopt a rearchived independent child", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  successful(await f.run({ action: "restore", taskIds: ["child"] }), 1);
  f.active("child").parentId = null;
  successful(await f.run({ action: "archive", taskIds: ["child"] }), 1);
  f.state.archived.find((row) => row.id === "parent").subTaskIds = ["child"];
  const before = f.writes().length;
  failedWith(await f.run({ action: "restore", taskIds: ["parent"] }), "SP_COMPLETION_CONFLICT");
  assert.equal(f.writes().length, before);
});

test("deleting an archived task explains that it must be restored first", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  const before = f.writes().length;
  const result = await f.run({ action: "delete", taskIds: ["parent"] });
  failedWith(result, "SP_TASK_ARCHIVED");
  assert.match(resultFor(result, "parent").message, /Restore it first/);
  assert.equal(f.writes().length, before);
  assert.equal(f.state.archived.length, 2);
});

test("archive records the schedule SP clears and restore writes it back", async () => {
  const f = setup({ tasks: [
    task("parent", { subTaskIds: ["child"], dueDay: "2026-11-02", deadlineDay: "2026-11-03" }),
    task("child", { parentId: "parent", dueWithTime: 1790000000000 }),
  ] });
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  const record = await f.journal.find("parent");
  assert.deepEqual(record.items.find((item) => item.taskId === "parent").schedule, { dueDay: "2026-11-02", dueWithTime: null });
  assert.deepEqual(record.items.find((item) => item.taskId === "child").schedule, { dueDay: null, dueWithTime: 1790000000000 });
  assert.equal(f.state.archived.find((row) => row.id === "parent").dueDay, undefined);
  const result = await f.run({ action: "restore", taskIds: ["parent"] });
  successful(result, 1);
  assert.equal(result.completionSync.rescheduled, 2);
  assert.equal(f.active("parent").dueDay, "2026-11-02");
  assert.equal(f.active("parent").deadlineDay, "2026-11-03");
  assert.equal(f.active("child").dueWithTime, 1790000000000);
  assert.deepEqual(f.state.schedulePatches, [{ id: "parent", body: { dueDay: "2026-11-02" } }, { id: "child", body: { dueWithTime: 1790000000000 } }]);
  assert.equal((await f.journal.find("parent")).phase, "complete");
});

test("unscheduled tasks keep their journal shape and need no schedule write", async () => {
  const f = setup();
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  assert.ok((await f.journal.find("parent")).items.every((item) => !Object.hasOwn(item, "schedule")));
  const result = await f.run({ action: "restore", taskIds: ["parent"] });
  successful(result, 1);
  assert.equal(result.completionSync.rescheduled, 0);
  assert.equal(f.state.schedulePatches.length, 0);
});

test("a schedule set after restore is not overwritten", async () => {
  const f = setup({ tasks: [task("solo", { dueDay: "2026-11-02" })] });
  successful(await f.run({ action: "archive", taskIds: ["solo"] }), 1);
  f.state.dishonestPatch.add("solo");
  failedWith(await f.run({ action: "restore", taskIds: ["solo"] }), "SP_SCHEDULE_VERIFY_FAILED");
  f.state.dishonestPatch.delete("solo");
  f.active("solo").dueDay = "2026-12-01";
  successful(await f.run({ action: "repair", taskIds: ["solo"] }), 1);
  assert.equal(f.active("solo").dueDay, "2026-12-01");
  assert.equal(f.state.schedulePatches.length, 1);
  assert.equal((await f.journal.find("solo")).phase, "complete");
});

test("an unverified schedule write keeps the recovery item pending for repair", async () => {
  const f = setup({ tasks: [task("solo", { dueDay: "2026-11-02" })] });
  successful(await f.run({ action: "archive", taskIds: ["solo"] }), 1);
  f.state.dishonestPatch.add("solo");
  const result = await f.run({ action: "restore", taskIds: ["solo"] });
  failedWith(result, "SP_SCHEDULE_VERIFY_FAILED");
  assert.equal((await f.journal.find("solo")).items[0].phase, "pending");
  f.state.dishonestPatch.delete("solo");
  successful(await f.run({ action: "repair", taskIds: ["solo"] }), 1);
  assert.equal(f.active("solo").dueDay, "2026-11-02");
  assert.equal((await f.journal.find("solo")).phase, "complete");
});

const estimateFamily = () => [
  task("parent", { subTaskIds: ["child"], timeEstimate: 5400000, timeSpent: 1800000 }),
  task("child", { parentId: "parent", timeEstimate: 5400000, timeSpent: 1800000 }),
];

test("restore puts back a parent estimate that SP recomputed during child repair", async () => {
  const f = setup({ tasks: estimateFamily() });
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  const record = await f.journal.find("parent");
  assert.equal(record.items.find((item) => item.taskId === "parent").estimate, 5400000);
  assert.equal(Object.hasOwn(record.items.find((item) => item.taskId === "child"), "estimate"), false);
  const result = await f.run({ action: "restore", taskIds: ["parent"] });
  successful(result, 1);
  assert.equal(result.completionSync.fixed, 1);
  assert.equal(result.completionSync.estimatesRestored, 1);
  assert.equal(f.active("parent").timeEstimate, 5400000);
  assert.equal(f.active("child").isDone, false);
  assert.deepEqual(f.state.schedulePatches, [{ id: "parent", body: { timeEstimate: 5400000 } }]);
  assert.equal((await f.journal.find("parent")).phase, "complete");
});

test("single tasks record no estimate and keep theirs untouched", async () => {
  const f = setup({ tasks: [task("solo", { timeEstimate: 2700000, timeSpent: 900000 })] });
  successful(await f.run({ action: "archive", taskIds: ["solo"] }), 1);
  assert.equal(Object.hasOwn((await f.journal.find("solo")).items[0], "estimate"), false);
  const result = await f.run({ action: "restore", taskIds: ["solo"] });
  successful(result, 1);
  assert.equal(result.completionSync.estimatesRestored, 0);
  assert.equal(f.active("solo").timeEstimate, 2700000);
});

test("a parent estimate changed by the user after restore is not overwritten", async () => {
  const f = setup({ tasks: estimateFamily() });
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.dishonestPatch.add("parent");
  failedWith(await f.run({ action: "restore", taskIds: ["parent"] }), "SP_ESTIMATE_VERIFY_FAILED");
  assert.equal((await f.journal.find("parent")).items.find((item) => item.taskId === "child").phase, "complete");
  f.state.dishonestPatch.delete("parent");
  f.active("parent").timeEstimate = 600000;
  successful(await f.run({ action: "repair", taskIds: ["parent"] }), 1);
  assert.equal(f.active("parent").timeEstimate, 600000);
  assert.equal(f.state.schedulePatches.length, 1);
  assert.equal((await f.journal.find("parent")).phase, "complete");
});

test("a parent waits for its failed child repair, then restores its estimate on repair", async () => {
  const f = setup({ tasks: estimateFamily() });
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.rejectBefore.set("PATCH /tasks/child", "PATCH_REJECTED");
  failedWith(await f.run({ action: "restore", taskIds: ["parent"] }), "SP_ESTIMATE_PENDING");
  assert.equal(f.state.schedulePatches.length, 0);
  f.state.rejectBefore.delete("PATCH /tasks/child");
  const repaired = await f.run({ action: "repair", taskIds: ["parent"] });
  successful(repaired, 1);
  assert.equal(repaired.completionSync.estimatesRestored, 1);
  assert.equal(f.active("parent").timeEstimate, 5400000);
});

test("an unverified estimate write keeps the parent pending", async () => {
  const f = setup({ tasks: estimateFamily() });
  successful(await f.run({ action: "archive", taskIds: ["parent"] }), 1);
  f.state.dishonestPatch.add("parent");
  const result = await f.run({ action: "restore", taskIds: ["parent"] });
  failedWith(result, "SP_ESTIMATE_VERIFY_FAILED");
  assert.equal((await f.journal.find("parent")).items.find((item) => item.taskId === "parent").phase, "pending");
  assert.equal((await f.journal.find("parent")).items.find((item) => item.taskId === "child").phase, "complete");
});
