import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { createCommandExecutor, createBridgeClient, parsePairingCode, installCompanion, BRIDGE_URL, VERSION } from "../../sp-hana-bridge/src/companion.mjs";

globalThis.fetch = async () => { throw new Error("Live network is forbidden in companion tests"); };
const clone = (value) => structuredClone(value);
const token = "t".repeat(48);
const pairingCode = (override = {}) => "HANA-SP1." + Buffer.from(JSON.stringify({ protocol: 1, url: BRIDGE_URL, token, ...override })).toString("base64url");
const reply = (data, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status });
const theme = { primary: "#29a1aa", accent: "#ff4081", warn: "#e11826", isAutoContrast: true, huePrimary: "500", hueAccent: "500", hueWarn: "500", backgroundImageDark: null, backgroundImageLight: null, isDisableBackgroundTint: false, backgroundOverlayOpacity: 20, backgroundImageBlur: 0 };
const project = (id, title, extra = {}) => ({ id, title, theme: clone(theme), taskIds: [], backlogTaskIds: [], noteIds: [], icon: null, isArchived: false, isEnableBacklog: false, isHiddenFromMenu: false, advancedCfg: { secret: "not-for-output" }, ...extra });
const tag = (id, title, extra = {}) => ({ id, title, color: null, icon: null, taskIds: [], theme: clone(theme), advancedCfg: { secret: "not-for-output" }, ...extra });
const completion = (isDone = false, doneOn = null, wontDoOn = null) => ({ isDone, doneOn, wontDoOn });
const isWontDoTask = (task) => !!task.isDone && task.wontDoOn != null && task.wontDoOn === task.doneOn;
function applyCompletionUpdate(task, updates) {
  assert.deepEqual(Object.keys(updates).sort(), Object.hasOwn(updates, "isDone") ? ["doneOn", "isDone"] : ["doneOn"], "only the supported completion fields may reach SP");
  // SP 19.3.1 plugin-api-mapper.ts preserves an own doneOn:undefined for null.
  const changes = { ...clone(updates), doneOn: updates.doneOn === null ? undefined : updates.doneOn };
  // updateDoneOnForTask runs first; task-shared-crud.reducer.ts then overlays changes.
  const automatic = changes.isDone === true ? { doneOn: typeof changes.doneOn === "number" ? changes.doneOn : 9000 } : changes.isDone === false ? { doneOn: undefined } : {};
  return { ...task, ...automatic, ...changes, modified: 9000 };
}

function fixture() {
  const state = { projects: { p1: project("p1", "Alpha"), p2: project("p2", "Archived", { isArchived: true }), INBOX_PROJECT: project("INBOX_PROJECT", "Inbox") }, tags: { t1: tag("t1", "Work"), TODAY: tag("TODAY", "Today") }, tasks: {}, notes: {}, taskRepeatCfgs: {}, simpleCounters: {}, selectedTaskId: null, globalConfig: { secret: "not-for-output" } };
  const calls = [];
  const secrets = new Map();
  const hooks = {};
  let next = 0;
  const api = {
    getAppState: async () => clone(state),
    getArchivedTasks: async () => [],
    addProject: async (data) => { const id = `newp${++next}`; calls.push(["addProject", clone(data)]); state.projects[id] = project(id, data.title, clone(data)); return id; },
    updateProject: async (id, patch) => { calls.push(["updateProject", id, clone(patch)]); assert.ok(state.projects[id]); if (patch.theme) { assert.deepEqual(Object.keys(patch.theme).sort(), Object.keys(theme).sort(), "full SP theme must be preserved"); assert.equal(typeof patch.theme.primary, "string"); } Object.assign(state.projects[id], clone(patch)); if (patch.isEnableBacklog === false) { state.projects[id].taskIds.push(...state.projects[id].backlogTaskIds); state.projects[id].backlogTaskIds = []; } },
    deleteProject: async (id) => { calls.push(["deleteProject", id]); delete state.projects[id]; for (const kind of ["tasks", "notes", "taskRepeatCfgs"]) for (const [key, value] of Object.entries(state[kind])) if (value.projectId === id) delete state[kind][key]; },
    addTag: async (data) => { const id = `newt${++next}`; calls.push(["addTag", clone(data)]); state.tags[id] = tag(id, data.title, { ...clone(data), color: data.color || "#123456" }); return id; },
    updateTag: async (id, patch) => { calls.push(["updateTag", id, clone(patch)]); assert.ok(state.tags[id]); Object.assign(state.tags[id], clone(patch)); },
    updateTask: async (id, patch) => { calls.push(["updateTask", id, clone(patch)]); assert.ok(state.tasks[id]); state.tasks[id] = applyCompletionUpdate(state.tasks[id], patch); },
    getAllSimpleCounters: async () => clone(Object.values(state.simpleCounters)),
    setCounter: async (id, value) => {
      calls.push(["setCounter", id, value]);
      state.simpleCounters[id] ??= { id, title: id, type: "ClickCounter", icon: null, isEnabled: true, isOn: false, countOnDay: {} };
      state.simpleCounters[id].countOnDay["2026-10-31"] = value;
    },
    updateSimpleCounter: async (id, patch) => { calls.push(["updateSimpleCounter", id, clone(patch)]); assert.ok(state.simpleCounters[id]); Object.assign(state.simpleCounters[id], clone(patch)); },
    deleteSimpleCounter: async (id) => { calls.push(["deleteSimpleCounter", id]); delete state.simpleCounters[id]; },
    reorderTasks: async (ids, contextId, contextType) => {
      calls.push(["reorderTasks", clone(ids), contextId, contextType]);
      if (contextType === "project") state.projects[contextId].taskIds = clone(ids);
      else state.tasks[contextId].subTaskIds = clone(ids);
    },
    getSelectedTask: async () => state.selectedTaskId ? clone(state.tasks[state.selectedTaskId]) : null,
    selectTask: async (id) => { calls.push(["selectTask", id]); assert.ok(state.tasks[id]); state.selectedTaskId = id; },
    getSecret: async (key) => secrets.get(key) ?? null,
    setSecret: async (key, value) => secrets.set(key, value),
    deleteSecret: async (key) => secrets.delete(key),
    persistDataSynced: async () => { throw new Error("Secrets must not be synced"); },
    registerConfigHandler: (fn) => { hooks.config = fn; },
    registerMenuEntry: (menu) => { hooks.menu = menu; },
    onReady: (fn) => { hooks.ready = fn; },
    onUnload: (fn) => { hooks.unload = fn; },
    showSnack: (data) => { hooks.snacks ??= []; hooks.snacks.push(data); },
    openDialog: async (data) => { hooks.dialog = data; },
  };
  return { state, calls, secrets, hooks, api, execute: createCommandExecutor(api) };
}

test("pairing accepts only fixed loopback, protocol and long token", () => {
  assert.deepEqual(parsePairingCode(pairingCode()), { protocol: 1, url: BRIDGE_URL, token });
  for (const url of ["http://localhost:3877", "http://127.0.0.1:3877/", "http://127.0.0.1:9999", "http://127.0.0.1:3877@evil.invalid", "http://2130706433:3877", "https://127.0.0.1:3877", BRIDGE_URL + "?x=1", BRIDGE_URL + "#x", "http://[::1]:3877"]) assert.throws(() => parsePairingCode(pairingCode({ url })));
  for (const override of [{ protocol: 2 }, { token: "short" }, { token: token + "\n" }, { extra: true }, { url: null }]) assert.throws(() => parsePairingCode(pairingCode(override)));
  for (const code of [null, "", "HANA-SP1.!!!", "HANA-SP1.e30", "HANA-SP1." + "A".repeat(5000)]) assert.throws(() => parsePairingCode(code));
});

test("list includes archive flag but never private fields or task titles", async () => {
  const f = fixture(); f.state.projects.p1.issueIntegrationCfgs = { token: "hidden" };
  const result = await f.execute("projects.list", {});
  assert.equal(result.ok, true); assert.equal(result.data.projects.length, 3);
  assert.equal(result.data.projects.find((p) => p.id === "p2").isArchived, true);
  assert.doesNotMatch(JSON.stringify(result), /advancedCfg|theme|secret|issueIntegration|not-for-output|taskIds/);
  const tags = await f.execute("tags.list", {});
  assert.deepEqual(Object.keys(tags.data.tags[0]).sort(), ["id", "title", "color", "icon", "taskCount"].sort());
  assert.equal(f.calls.length, 0);
});

test("create project preserves default theme and reads back all changes", async () => {
  const f = fixture();
  const result = await f.execute("projects.create", { title: " New project ", color: "#ABCDEF", icon: "folder", isEnableBacklog: true, isHiddenFromMenu: true });
  assert.equal(result.ok, true); assert.equal(result.data.created, true);
  assert.deepEqual(result.data.project, { id: "newp1", title: "New project", color: "#ABCDEF", icon: "folder", taskCount: 0, isArchived: false, isEnableBacklog: true, isHiddenFromMenu: true, backlogTaskCount: 0, noteCount: 0 });
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0][1].theme, undefined); assert.equal(f.calls[0][1].color, undefined);
  assert.equal(f.state.projects.newp1.theme.accent, theme.accent);
});

test("project color reset is official default string, icon clear is null", async () => {
  const f = fixture(); f.state.projects.p1.theme.primary = "#888888";
  const result = await f.execute("projects.update", { projectId: "p1", color: "", icon: "" });
  assert.equal(result.ok, true); assert.equal(result.data.project.color, "#29a1aa"); assert.equal(result.data.project.icon, null);
  assert.equal(f.calls[0][2].theme.accent, theme.accent);
});

test("tag creation with explicit empty color clears SP randomized default once", async () => {
  const f = fixture(); const result = await f.execute("tags.create", { title: "Personal", color: "", icon: "" });
  assert.equal(result.ok, true); assert.equal(result.data.tag.color, null); assert.equal(result.data.tag.icon, null);
  assert.deepEqual(f.calls.map((c) => c[0]), ["addTag", "updateTag"]);
});

test("tag update uses tag color rather than project theme", async () => {
  const f = fixture(); const result = await f.execute("tags.update", { tagId: "t1", title: "Work renamed", color: "#abcdef" });
  assert.equal(result.ok, true); assert.deepEqual(f.calls[0][2], { title: "Work renamed", color: "#abcdef" });
});

test("backlog flag follows official move effect and returns resulting counts", async () => {
  const f = fixture(); f.state.projects.p1.backlogTaskIds = ["b1"];
  const result = await f.execute("projects.update", { projectId: "p1", isEnableBacklog: false });
  assert.equal(result.ok, true); assert.equal(result.data.project.taskCount, 1); assert.equal(result.data.project.backlogTaskCount, 0);
});

test("duplicate normalized names refuse create and rename, including archived projects", async () => {
  const f = fixture();
  for (const [op, args] of [["projects.create", { title: " alpha " }], ["projects.create", { title: "ARCHIVED" }], ["projects.update", { projectId: "p1", title: "Archived" }], ["tags.create", { title: "WORK" }]]) {
    const result = await f.execute(op, args); assert.equal(result.error.code, "SP_DUPLICATE_TITLE");
    assert.match(result.error.message, /Exact IDs:/); assert.ok(result.error.message.length <= 1000);
  }
  assert.equal(f.calls.length, 0);
});

test("serialized concurrent creates cannot silently create duplicate names", async () => {
  const f = fixture(); const results = await Promise.all([f.execute("projects.create", { title: "Concurrent" }), f.execute("projects.create", { title: "Concurrent" })]);
  assert.equal(results[0].ok, true); assert.equal(results[1].error.code, "SP_DUPLICATE_TITLE");
  assert.equal(f.calls.filter((c) => c[0] === "addProject").length, 1);
});

test("protected, nonexistent and path IDs never reach mutations", async () => {
  const f = fixture();
  for (const value of ["INBOX_PROJECT", "TODAY", "missing", ".", "..", "p1/x", "p1\\x", " p1"]) {
    const result = await f.execute("projects.update", { projectId: value, title: "x" }); assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, undefined);
  }
  assert.equal((await f.execute("tags.update", { tagId: "TODAY", title: "x" })).error.code, "SP_PROTECTED_ENTITY");
  assert.equal(f.calls.length, 0);
});

test("unsupported action, fields and bad types fail closed", async () => {
  const f = fixture();
  const bad = [["tags.delete", { tagId: "t1" }], ["dispatch", {}], ["projects.list", { query: "x" }], ["projects.update", { projectId: "p1" }], ["projects.update", { projectId: "p1", isArchived: true }], ["projects.update", { projectId: "p1", taskIds: [] }], ["projects.create", { title: "" }], ["projects.create", { title: "x".repeat(241) }], ["projects.create", { title: "x", icon: "<script>" }], ["projects.create", { title: "x", color: null }], ["projects.create", { title: "x", color: "red" }], ["projects.update", { projectId: "p1", isEnableBacklog: 1 }], ["tags.update", { tagId: "t1", isHiddenFromMenu: false }], ["projects.create", { title: "x\ny" }]];
  for (const [op, args] of bad) { const result = await f.execute(op, args); assert.equal(result.ok, false, `${op} ${JSON.stringify(args)}`); assert.equal(result.outcomeUnknown, undefined); }
  assert.equal(f.calls.length, 0);
});

test("delete always requires cascade and exact title, even empty", async () => {
  const f = fixture();
  for (const args of [{ projectId: "p1" }, { projectId: "p1", confirmTitle: "Alpha" }, { projectId: "p1", allowCascade: true, confirmTitle: "alpha" }, { projectId: "p1", allowCascade: true, confirmTitle: " Alpha " }]) {
    assert.equal((await f.execute("projects.delete", args)).ok, false);
  }
  assert.equal(f.calls.length, 0);
});

test("delete returns honest observed impact and verifies live cascade", async () => {
  const f = fixture(); Object.assign(f.state.projects.p1, { taskIds: ["a"], backlogTaskIds: ["b"], noteIds: ["n"] });
  f.state.tasks = { a: { id: "a", projectId: "p1", subTaskIds: ["s"] }, b: { id: "b", projectId: "p1", subTaskIds: [] }, s: { id: "s", projectId: "p1", parentId: "a", subTaskIds: [] } };
  f.state.notes.n = { id: "n", projectId: "p1" }; f.state.taskRepeatCfgs.r = { id: "r", projectId: "p1" };
  f.api.getArchivedTasks = async () => [{ id: "archived", projectId: "p1" }];
  const result = await f.execute("projects.delete", { projectId: "p1", allowCascade: true, confirmTitle: "Alpha" });
  assert.equal(result.ok, true); assert.equal(result.data.deleted, true); assert.equal(result.data.id, "p1");
  assert.equal(result.data.impact.liveTaskCount, 3); assert.equal(result.data.impact.subtaskCount, 1); assert.equal(result.data.impact.noteCount, 1); assert.equal(result.data.impact.repeatCfgCount, 1); assert.equal(result.data.impact.observedArchivedTaskCount, 1);
  assert.equal(result.data.impact.archiveCleanupVerified, false); assert.equal(result.data.impact.archiveVerification, "best-effort");
  assert.doesNotMatch(JSON.stringify(result), /taskIds|noteIds|repeatIds/);
});

test("delete rechecks title after archive read and refuses stale confirmation", async () => {
  const f = fixture(); f.api.getArchivedTasks = async () => { f.state.projects.p1.title = "Changed externally"; return []; };
  const result = await f.execute("projects.delete", { projectId: "p1", allowCascade: true, confirmTitle: "Alpha" });
  assert.equal(result.error.code, "SP_CONFIRMATION_STALE"); assert.equal(f.calls.length, 0);
});

test("write rejection and silent no-op are not reported successful", async () => {
  const f = fixture(); f.api.updateProject = async () => {};
  const first = await f.execute("projects.update", { projectId: "p1", title: "Changed" });
  assert.equal(first.error.code, "SP_VERIFY_FAILED"); assert.equal(first.outcomeUnknown, true);
  f.api.updateProject = async () => { throw new Error("private credential content"); };
  const second = await f.execute("projects.update", { projectId: "p1", title: "Changed" });
  assert.equal(second.error.code, "SP_PLUGIN_ERROR"); assert.equal(second.outcomeUnknown, true); assert.doesNotMatch(JSON.stringify(second), /credential/);
  f.api.deleteProject = async () => {};
  assert.equal((await f.execute("projects.delete", { projectId: "p1", allowCascade: true, confirmTitle: "Alpha" })).outcomeUnknown, true);
});

test("failed follow-up after create never retries creation and marks unknown", async () => {
  const f = fixture(); f.api.updateProject = async () => { throw new Error("failure"); };
  const result = await f.execute("projects.create", { title: "Partial", color: "#112233" });
  assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true); assert.equal(result.createdId, "newp1"); assert.equal(f.calls.filter((c) => c[0] === "addProject").length, 1);
  assert.equal(f.state.projects.newp1.title, "Partial");
});

test("missing deletion verification dictionaries cannot become a success", async () => {
  for (const missing of ["tasks", "notes", "taskRepeatCfgs"]) {
    const f = fixture();
    f.api.deleteProject = async (id) => { delete f.state.projects[id]; delete f.state[missing]; };
    const result = await f.execute("projects.delete", { projectId: "p1", allowCascade: true, confirmTitle: "Alpha" });
    assert.equal(result.ok, false); assert.equal(result.error.code, "SP_BAD_STATE"); assert.equal(result.outcomeUnknown, true);
  }
});

test("cancelled command performs no mutation", async () => {
  const f = fixture(); const result = await f.execute("projects.create", { title: "Cancelled" }, () => true);
  assert.equal(result.error.code, "SP_COMMAND_CANCELLED"); assert.equal(f.calls.length, 0);
});

test("invalid dictionary IDs fail closed before mutating", async () => {
  const f = fixture(); f.state.projects.p1.id = "wrong";
  const result = await f.execute("projects.update", { projectId: "p1", title: "Changed" });
  assert.equal(result.error.code, "SP_BAD_STATE"); assert.equal(f.calls.length, 0);
});

test("completion repair restores exact historical timestamps through SP mapper and reducer semantics", async () => {
  for (const desired of [completion(true, 123456789), completion(true, 0), completion(true, 8640000000000000), completion(false, 123456789)]) {
    const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false, title: "Private task", other: "untouched" };
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired });
    assert.deepEqual(result, { ok: true, data: { id: "task1", completion: desired, unchanged: false } });
    assert.equal(f.state.tasks.task1.doneOn, desired.doneOn); assert.equal(f.state.tasks.task1.other, "untouched");
    assert.deepEqual(f.calls, [["updateTask", "task1", { ...(desired.isDone ? { isDone: true } : {}), doneOn: desired.doneOn }]]);
    assert.doesNotMatch(JSON.stringify(result), /Private|untouched/);
  }
});

test("completion repair restores wont-do classification without writing the protected marker", async () => {
  for (const expected of [completion(false, null, 123), completion(true, 9000, 123)]) {
    const f = fixture(); f.state.tasks.task1 = { id: "task1", ...expected };
    const desired = completion(true, 123, 123);
    assert.equal(isWontDoTask(f.state.tasks.task1), false);
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected, desired });
    assert.deepEqual(result, { ok: true, data: { id: "task1", completion: desired, unchanged: false } });
    assert.equal(isWontDoTask(f.state.tasks.task1), true); assert.equal(f.state.tasks.task1.wontDoOn, 123);
    assert.deepEqual(f.calls[0][2], { ...(!expected.isDone ? { isDone: true } : {}), doneOn: 123 });
  }
});

test("explicit null clears doneOn even when SP first stamps or clears it automatically", async () => {
  for (const isDone of [false, true]) {
    const f = fixture(); const expected = completion(true, 321, 123); const desired = completion(isDone, null, 123);
    f.state.tasks.task1 = { id: "task1", ...expected };
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected, desired });
    assert.deepEqual(result.data.completion, desired); assert.equal(result.ok, true);
    assert.equal(f.calls[0][2].doneOn, null); assert.equal(f.state.tasks.task1.doneOn, undefined);
    assert.equal(Object.hasOwn(f.state.tasks.task1, "doneOn"), true); assert.equal(f.state.tasks.task1.wontDoOn, 123);
    assert.equal(isWontDoTask(f.state.tasks.task1), false);
  }
});

test("already desired active completion is idempotent before comparing a stale expected value", async () => {
  const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false };
  const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(true, 321, 123), desired: completion() });
  assert.deepEqual(result, { ok: true, data: { id: "task1", completion: completion(), unchanged: true } });
  assert.equal(f.calls.length, 0);
});

test("completion conflict protects new user changes and unsupported marker changes never write", async () => {
  const f = fixture(); f.state.tasks.task1 = { id: "task1", ...completion(true, 456, 123) };
  const conflict = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(false, null, 123), desired: completion(true, 123, 123) });
  assert.equal(conflict.error.code, "SP_COMPLETION_CONFLICT"); assert.equal(conflict.outcomeUnknown, undefined);
  for (const wontDoOn of [null, 456]) {
    const unsupported = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(true, 456, 123), desired: completion(true, 456, wontDoOn) });
    assert.equal(unsupported.error.code, "SP_COMPLETION_UNSUPPORTED"); assert.equal(unsupported.outcomeUnknown, undefined);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.state.tasks.task1.doneOn, 456);
});

test("metadata-only repair omits isDone and does not retrigger completion effects", async () => {
  for (const isDone of [false, true]) {
    const f = fixture(); const expected = completion(isDone, 9000, 123); const desired = completion(isDone, 123, 123);
    f.state.tasks.task1 = { id: "task1", ...expected, repeatCfgId: "repeat1", parentId: "missing-parent" };
    f.state.taskRepeatCfgs.repeat1 = { id: "repeat1", repeatFromCompletionDate: true, waitForCompletion: true };
    const update = f.api.updateTask; let completionEffects = 0;
    f.api.updateTask = async (id, patch) => { if (patch.isDone === true) completionEffects++; await update(id, patch); };
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected, desired });
    assert.equal(result.ok, true); assert.deepEqual(result.data.completion, desired);
    assert.deepEqual(f.calls[0][2], { doneOn: 123 }); assert.equal(completionEffects, 0);
  }
});

test("repair refuses completion-driven repeating tasks even when their rule is paused", async () => {
  for (const field of ["repeatFromCompletionDate", "waitForCompletion"]) for (const isPaused of [false, true]) {
    const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false, repeatCfgId: "repeat1" };
    f.state.taskRepeatCfgs.repeat1 = { id: "repeat1", [field]: true, isPaused };
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, 123) });
    assert.equal(result.error.code, "SP_COMPLETION_REPEAT_UNSUPPORTED"); assert.equal(result.outcomeUnknown, undefined);
    assert.equal(f.calls.length, 0); assert.equal(f.state.tasks.task1.isDone, false);
  }
});

test("completion repair fails closed when its referenced repeat rule is missing or invalid", async () => {
  for (const dictionary of [undefined, {}, { repeat1: null }, { repeat1: { id: "other" } }, { repeat1: { id: "repeat1", waitForCompletion: "true" } }]) {
    const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false, repeatCfgId: "repeat1" }; f.state.taskRepeatCfgs = dictionary;
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, 123) });
    assert.equal(result.error.code, "SP_COMPLETION_REPEAT_UNSUPPORTED"); assert.equal(result.outcomeUnknown, undefined); assert.equal(f.calls.length, 0);
  }
});

test("ordinary repeating tasks are allowed and reopening cannot advance a repeat rule", async () => {
  for (const rule of [{ id: "repeat1" }, { id: "repeat1", repeatFromCompletionDate: false, waitForCompletion: false }]) {
    const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false, repeatCfgId: "repeat1" }; f.state.taskRepeatCfgs.repeat1 = rule;
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, 123) });
    assert.equal(result.ok, true); assert.deepEqual(f.calls[0][2], { isDone: true, doneOn: 123 });
  }
  const f = fixture(); f.state.tasks.task1 = { id: "task1", ...completion(true, 123), repeatCfgId: "repeat1", parentId: "missing" };
  f.state.taskRepeatCfgs.repeat1 = { id: "repeat1", repeatFromCompletionDate: true, waitForCompletion: true };
  const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(true, 123), desired: completion() });
  assert.equal(result.ok, true); assert.deepEqual(f.calls[0][2], { isDone: false, doneOn: null });
});

test("completing a child refuses missing or unfinished parents without relying on global preferences", async () => {
  for (const parent of [undefined, { id: "parent1", isDone: false }, { id: "parent1" }]) for (const isAutoMarkParentAsDone of [false, true]) {
    const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false, parentId: "parent1" };
    if (parent) f.state.tasks.parent1 = parent;
    f.state.globalConfig.tasks = { isAutoMarkParentAsDone };
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, 123) });
    assert.equal(result.error.code, "SP_COMPLETION_PARENT_UNSUPPORTED"); assert.equal(result.outcomeUnknown, undefined); assert.equal(f.calls.length, 0);
  }
});

test("an already done parent short-circuits SP parent completion even with a completion-driven repeat rule", async () => {
  const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false, parentId: "parent1" };
  f.state.tasks.parent1 = { id: "parent1", ...completion(true, 321), repeatCfgId: "repeat1" };
  f.state.taskRepeatCfgs.repeat1 = { id: "repeat1", repeatFromCompletionDate: true, waitForCompletion: true };
  f.state.globalConfig.tasks = { isAutoMarkParentAsDone: true };
  const before = clone(f.state.tasks.parent1);
  const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, 123) });
  assert.equal(result.ok, true); assert.deepEqual(f.state.tasks.parent1, before); assert.equal(f.calls.length, 1);
});

test("completion repair refuses issue links on the task or its completed parent before writing", async () => {
  for (const field of ["issueId", "issueProviderId", "issueType"]) for (const onParent of [false, true]) {
    const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false };
    if (onParent) {
      f.state.tasks.task1.parentId = "parent1";
      f.state.tasks.parent1 = { id: "parent1", ...completion(true, 321), [field]: "linked-issue" };
    } else f.state.tasks.task1[field] = "linked-issue";
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, 123) });
    assert.equal(result.error.code, "SP_COMPLETION_ISSUE_UNSUPPORTED"); assert.equal(result.outcomeUnknown, undefined); assert.equal(f.calls.length, 0);
  }
});

test("empty issue associations and issue-linked date-only repairs remain supported", async () => {
  for (const empty of [null, undefined, ""]) {
    const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false, issueId: empty, issueProviderId: empty, issueType: empty };
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, 123) });
    assert.equal(result.ok, true); assert.equal(f.calls.length, 1);
  }
  const f = fixture(); f.state.tasks.task1 = { id: "task1", ...completion(true, 9000), issueId: "linked-issue", issueProviderId: "provider", issueType: "JIRA" };
  const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(true, 9000), desired: completion(true, 123) });
  assert.equal(result.ok, true); assert.deepEqual(f.calls[0][2], { doneOn: 123 });
});

test("completion repair requires an active exact task and the official updateTask method", async () => {
  const f = fixture(); f.api.getArchivedTasks = async () => { assert.fail("completion repair must not consult archive data"); };
  const args = { taskId: "archived-only", expected: completion(), desired: completion(true, 123) };
  const missing = await f.execute("tasks.repairCompletion", args);
  assert.equal(missing.error.code, "SP_NO_TASK"); assert.equal(missing.outcomeUnknown, undefined);
  f.state.tasks[args.taskId] = { id: args.taskId, isDone: false }; delete f.api.updateTask;
  const unsupported = await f.execute("tasks.repairCompletion", args);
  assert.equal(unsupported.error.code, "SP_COMPLETION_UNSUPPORTED"); assert.equal(unsupported.outcomeUnknown, undefined);
  assert.equal(f.calls.length, 0);
});

test("completion arguments strictly validate both required snapshots and timestamp bounds", async () => {
  const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false };
  const base = { taskId: "task1", expected: completion(), desired: completion(true, 123) };
  const bad = [];
  for (const key of ["taskId", "expected", "desired"]) { const value = clone(base); delete value[key]; bad.push(value); }
  for (const taskId of ["", " task1", ".", "..", "task1/a", "task1\\a", null, 42]) bad.push({ ...base, taskId });
  bad.push({ ...base, title: "forbidden" });
  for (const field of ["expected", "desired"]) {
    for (const value of [null, [], true, "snapshot"]) bad.push({ ...base, [field]: value });
    for (const key of ["isDone", "doneOn", "wontDoOn"]) { const value = clone(base); delete value[field][key]; bad.push(value); }
    for (const isDone of [0, 1, null, "true", undefined]) bad.push({ ...base, [field]: { ...base[field], isDone } });
    for (const key of ["doneOn", "wontDoOn"]) for (const value of [-1, 1.5, 8640000000000001, Number.MAX_SAFE_INTEGER, Infinity, NaN, "123", false, undefined]) bad.push({ ...base, [field]: { ...base[field], [key]: value } });
    bad.push({ ...base, [field]: { ...base[field], modified: 123 } });
  }
  for (const args of bad) {
    const result = await f.execute("tasks.repairCompletion", args);
    assert.equal(result.error.code, "SP_BAD_INPUT", JSON.stringify(args)); assert.equal(result.outcomeUnknown, undefined);
  }
  assert.equal(f.calls.length, 0);
});

test("invalid active completion state is rejected before mutation", async () => {
  for (const task of [{ id: "wrong", isDone: false }, { id: "task1" }, { id: "task1", isDone: 0 }, { id: "task1", isDone: false, doneOn: -1 }, { id: "task1", isDone: false, wontDoOn: "123" }]) {
    const f = fixture(); f.state.tasks.task1 = task;
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, 123) });
    assert.equal(result.error.code, "SP_BAD_STATE"); assert.equal(result.outcomeUnknown, undefined); assert.equal(f.calls.length, 0);
  }
});

test("completion writes require matching metadata readback and never claim success after failure", async () => {
  const mutations = [
    async () => {},
    async (f) => { f.state.tasks.task1 = { id: "task1", ...completion(true, 9000) }; },
    async (f) => { f.state.tasks.task1 = { id: "task1", ...completion(true, 123, 123) }; },
    async (f) => { delete f.state.tasks.task1; },
    async (f) => { delete f.state.tasks; },
    async () => { throw new Error("private task content"); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false }; let attempts = 0;
    f.api.updateTask = async () => { attempts++; await mutate(f); };
    const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, 123) });
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true); assert.equal(attempts, 1);
    assert.doesNotMatch(JSON.stringify(result), /private task content/);
  }
});

test("serialized completion repairs recheck expected state and never overwrite the first repair", async () => {
  const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false };
  const results = await Promise.all([123, 456].map((doneOn) => f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, doneOn) })));
  assert.equal(results[0].ok, true); assert.equal(results[1].error.code, "SP_COMPLETION_CONFLICT");
  assert.equal(results[1].outcomeUnknown, undefined); assert.equal(f.calls.length, 1); assert.equal(f.state.tasks.task1.doneOn, 123);
});

test("completion cancellation after snapshot still prevents entering updateTask", async () => {
  const f = fixture(); f.state.tasks.task1 = { id: "task1", isDone: false }; let cancelled = false;
  f.api.getAppState = async () => { cancelled = true; return clone(f.state); };
  const result = await f.execute("tasks.repairCompletion", { taskId: "task1", expected: completion(), desired: completion(true, 123) }, () => cancelled);
  assert.equal(result.error.code, "SP_COMMAND_CANCELLED"); assert.equal(result.outcomeUnknown, undefined); assert.equal(f.calls.length, 0);
});

function clock() {
  let next = 0; const timers = new Map();
  return { timers, setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id), advance: () => { for (const [id, timer] of timers) if (timer.ms < 30000) { timers.delete(id); timer.fn(); break; } } };
}
async function until(predicate, timers) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((resolve) => setImmediate(resolve)); timers?.advance(); }
  assert.fail("Expected asynchronous client condition did not occur");
}
function clientFixture(fetcher) {
  const f = fixture(); const c = clock();
  const client = createBridgeClient(f.api, { fetch: fetcher, ...c, now: () => 1000, random: () => 0, clientId: "fixture-client" });
  return { ...f, clock: c, client };
}

test("plugin long-polls only after the bridge offers it and never spins on a quick empty reply", async () => {
  let time = 1000, sleeps = 0; const polls = [];
  const f = fixture(), c = clock(), setTimer = c.setTimeout;
  c.setTimeout = (fn, ms) => { if (ms === 750) sleeps++; return setTimer(fn, ms); };
  const client = createBridgeClient(f.api, { ...c, fetch: async (url, init) => {
    polls.push({ wait: JSON.parse(init.body).wait, sleeps });
    if (polls.length === 2) time += 20000; // This held poll ran its full hold.
    return reply(polls.length === 4 ? { command: null } : { command: null, longPoll: true });
  }, now: () => time, random: () => 0, clientId: "fixture-client" });
  await client.pair(pairingCode());
  await until(() => polls.length >= 5, c);
  client.unload(); await client.finished();
  // An old bridge (poll 4, no longPoll) turns waiting off again.
  assert.deepEqual(polls.slice(0, 5).map((p) => p.wait), [undefined, true, true, true, undefined]);
  // After a full hold the next poll goes out at once; after a quick empty reply it sleeps.
  assert.deepEqual(polls.slice(0, 5).map((p) => p.sleeps), [0, 1, 1, 2, 3]);
});

test("network client retries result only and deduplicates repeated command IDs", async () => {
  const command = { id: "command1", op: "projects.create", args: { title: "Once" }, expiresAt: 10000 };
  const requests = []; let polls = 0; let reports = 0;
  const f = clientFixture(async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    assert.equal(init.headers.Authorization, `Bearer ${token}`); assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
    if (url.endsWith("/plugin/poll")) { polls++; return reply({ command: polls <= 2 ? command : null }); }
    reports++; if (reports === 1) throw new Error("Lost reply");
    return reply({ accepted: true, id: "command1" });
  });
  await f.client.pair(pairingCode());
  await until(() => reports >= 3 && polls >= 3, f.clock); f.client.unload(); await f.client.finished();
  assert.equal(f.calls.filter((c) => c[0] === "addProject").length, 1);
  assert.deepEqual(requests.slice(0, 4).map((r) => new URL(r.url).pathname), ["/plugin/poll", "/plugin/result", "/plugin/result", "/plugin/poll"]);
  assert.deepEqual(requests[1].body, requests[2].body);
  assert.equal(requests[0].body.version, VERSION); assert.equal(requests[0].body.protocol, 1);
  assert.equal(f.clock.timers.size, 0); assert.doesNotMatch(JSON.stringify(f.client.status()), new RegExp(token));
});

test("completion command delivery retries results without repeating the official API write", async () => {
  const desired = completion(true, 123, 123);
  const command = { id: "repair-once", op: "tasks.repairCompletion", args: { taskId: "task1", expected: completion(false, null, 123), desired }, expiresAt: 10000 };
  const reports = []; let polls = 0;
  const f = clientFixture(async (url, init) => {
    if (url.endsWith("/plugin/poll")) return reply({ command: ++polls <= 2 ? command : null });
    reports.push(JSON.parse(init.body)); if (reports.length === 1) throw new Error("Lost ACK");
    return reply({ accepted: true, id: command.id });
  });
  f.state.tasks.task1 = { id: "task1", ...completion(false, null, 123) };
  await f.client.pair(pairingCode()); await until(() => reports.length >= 3 && polls >= 3, f.clock); f.client.unload(); await f.client.finished();
  assert.equal(f.calls.filter((c) => c[0] === "updateTask").length, 1);
  assert.deepEqual(reports[0], reports[1]); assert.deepEqual(reports[1], reports[2]);
  assert.deepEqual(reports[0].result, { ok: true, data: { id: "task1", completion: desired, unchanged: false } });
});

test("expired commands report failure without executing", async () => {
  let result; let polls = 0;
  const f = clientFixture(async (url, init) => {
    if (url.endsWith("/plugin/poll")) return reply({ command: ++polls === 1 ? { id: "expired", op: "tags.create", args: { title: "No" }, expiresAt: 999 } : null });
    result = JSON.parse(init.body).result; return reply({ accepted: true, id: "expired" });
  });
  await f.client.pair(pairingCode()); await until(() => result, f.clock); f.client.unload(); await f.client.finished();
  assert.equal(result.error.code, "SP_COMMAND_EXPIRED"); assert.equal(f.calls.length, 0);
});

test("reused command ID with changed arguments never writes again", async () => {
  let polls = 0; const results = [];
  const f = clientFixture(async (url, init) => {
    if (url.endsWith("/plugin/poll")) { polls++; return reply({ command: polls <= 2 ? { id: "same", op: "tags.create", args: { title: polls === 1 ? "First" : "Second" }, expiresAt: 10000 } : null }); }
    results.push(JSON.parse(init.body).result); return reply({ accepted: true, id: "same" });
  });
  await f.client.pair(pairingCode()); await until(() => results.length === 2, f.clock); f.client.unload(); await f.client.finished();
  assert.equal(results[1].error.code, "SP_COMMAND_ID_REUSED"); assert.equal(f.calls.filter((c) => c[0] === "addTag").length, 1);
});

test("lost runtime receipt resumes polling without repeating a completed write", async () => {
  let polls = 0; let reports = 0; const reported = [];
  const f = clientFixture(async (url, init) => {
    if (url.endsWith("/plugin/poll")) {
      polls++;
      return reply({ command: polls === 1 ? { id: "before-restart", op: "projects.create", args: { title: "Survived" }, expiresAt: 10000 } : polls === 2 ? { id: "after-restart", op: "projects.list", args: {}, expiresAt: 10000 } : null });
    }
    reports++; reported.push(JSON.parse(init.body));
    if (reports === 1) return new Response(JSON.stringify({ ok: false, error: { code: "SP_BRIDGE_RESULT_MISMATCH", message: "lost receipt" } }), { status: 409 });
    return reply({ accepted: true, id: "after-restart" });
  });
  await f.client.pair(pairingCode()); await until(() => reports >= 2 && polls >= 3, f.clock); f.client.unload(); await f.client.finished();
  assert.equal(f.calls.filter((c) => c[0] === "addProject").length, 1);
  assert.equal(reported[1].result.ok, true); assert.ok(f.hooks.snacks.some((s) => s.type === "WARNING"));
});

test("malformed ACK cannot release pending result or start another command", async () => {
  let polls = 0; let reports = 0;
  const f = clientFixture(async (url) => {
    if (url.endsWith("/plugin/poll")) { polls++; return reply({ command: { id: "bad-ack", op: "tags.create", args: { title: "Once" }, expiresAt: 10000 } }); }
    reports++; return reply(reports === 1 ? { id: "bad-ack" } : { accepted: true });
  });
  await f.client.pair(pairingCode()); await until(() => reports >= 2, f.clock); f.client.unload(); await f.client.finished();
  assert.equal(polls, 1); assert.equal(f.calls.length, 1);
});

test("explicit disconnect waits for an in-flight API call then permits re-pair", async () => {
  let finish; let polls = 0;
  const f = clientFixture(async (url) => {
    if (url.endsWith("/plugin/poll")) return reply({ command: ++polls === 1 ? { id: "disconnect-write", op: "tags.create", args: { title: "In flight" }, expiresAt: 10000 } : null });
    return reply({ accepted: true, id: "disconnect-write" });
  });
  f.api.addTag = async (data) => new Promise((resolve) => { finish = () => { f.state.tags.newTag = tag("newTag", data.title); resolve("newTag"); }; });
  await f.client.pair(pairingCode()); await until(() => finish);
  let disconnected = false; const disconnecting = f.client.disconnect().then(() => { disconnected = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(disconnected, false);
  await assert.rejects(f.client.pair(pairingCode()), /progress/);
  finish(); await disconnecting;
  assert.equal(f.client.status().pending, false); assert.equal(f.secrets.size, 0);
  await f.client.pair(pairingCode()); await until(() => polls >= 2, f.clock);
  f.client.unload(); await f.client.finished(); assert.equal(f.clock.timers.size, 0);
});

test("oversized results become small explicit failures and next command still runs", async () => {
  let polls = 0; const results = [];
  const f = clientFixture(async (url, init) => {
    if (url.endsWith("/plugin/poll")) return reply({ command: ++polls <= 2 ? { id: `oversize-${polls}`, op: polls === 1 ? "projects.list" : "tags.list", args: {}, expiresAt: 10000 } : null });
    const body = JSON.parse(init.body); results.push(body.result); return reply({ accepted: true, id: body.id });
  });
  f.state.projects.p1.title = "x".repeat(1048576);
  await f.client.pair(pairingCode()); await until(() => results.length === 2, f.clock); f.client.unload(); await f.client.finished();
  assert.equal(results[0].error.code, "SP_BRIDGE_RESULT_TOO_LARGE"); assert.equal(results[0].outcomeUnknown, undefined); assert.equal(results[1].ok, true);
});

test("server result rejection is reduced once, then connection stops without rewriting", async () => {
  let polls = 0; const reports = [];
  const f = clientFixture(async (url, init) => {
    if (url.endsWith("/plugin/poll")) { polls++; return reply({ command: { id: "rejected", op: "tags.create", args: { title: "No repeat" }, expiresAt: 10000 } }); }
    reports.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: false, error: { code: "SP_BRIDGE_BAD_INPUT", message: "bad" } }), { status: 400 });
  });
  await f.client.pair(pairingCode()); await until(() => reports.length === 2 && !f.client.status().active, f.clock); await f.client.finished();
  assert.equal(reports[1].result.error.code, "SP_BRIDGE_RESULT_REJECTED"); assert.equal(reports[1].result.outcomeUnknown, true);
  assert.equal(polls, 1); assert.equal(f.calls.filter((c) => c[0] === "addTag").length, 1);
  await f.client.disconnect(); f.client.unload(); assert.equal(f.client.status().pending, false);
});

test("receipt entry limit refuses a new mutation before it starts", async () => {
  let polls = 0; let finalResult;
  const f = clientFixture(async (url, init) => {
    if (url.endsWith("/plugin/poll")) {
      polls++;
      return reply({ command: polls <= 1025 ? { id: `receipt-${polls}`, op: polls <= 1024 ? "tags.list" : "tags.create", args: polls <= 1024 ? {} : { title: "Must not exist" }, expiresAt: 10000 } : null });
    }
    const body = JSON.parse(init.body); if (body.id === "receipt-1025") finalResult = body.result;
    return reply({ accepted: true, id: body.id });
  });
  await f.client.pair(pairingCode()); await until(() => finalResult, f.clock); f.client.unload(); await f.client.finished();
  assert.equal(finalResult.error.code, "SP_SESSION_LIMIT"); assert.equal(finalResult.outcomeUnknown, undefined); assert.equal(f.calls.length, 0);
});

test("unload aborts fetch and synchronously clears every timer", async () => {
  let signal;
  const f = clientFixture(async (_url, init) => { signal = init.signal; return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); });
  await f.client.pair(pairingCode()); await until(() => signal);
  assert.equal(f.clock.timers.size, 1); f.client.unload();
  assert.equal(signal.aborted, true); assert.equal(f.clock.timers.size, 0); await f.client.finished();
});

test("pending write blocks re-pairing and cancellation stops subsequent write steps", async () => {
  let resolveAdd; let reports = 0;
  const f = clientFixture(async (url) => { if (url.endsWith("/plugin/poll")) return reply({ command: { id: "inflight", op: "projects.create", args: { title: "Inflight", color: "#123456" }, expiresAt: 10000 } }); reports++; return reply({ accepted: true, id: "inflight" }); });
  f.api.addProject = async (data) => new Promise((resolve) => { resolveAdd = () => { f.state.projects.added = project("added", data.title); resolve("added"); }; });
  await f.client.pair(pairingCode()); await until(() => resolveAdd);
  await assert.rejects(f.client.pair(pairingCode()), /pending/);
  f.client.unload(); resolveAdd(); await f.client.finished();
  assert.equal(f.calls.filter((c) => c[0] === "updateProject").length, 0); assert.equal(reports, 0);
});

test("pairing UI registers native dialog and stores only local secret", async () => {
  const f = fixture(); const c = clock(); const client = installCompanion(f.api, { fetch: async () => reply({ command: null }), ...c, clientId: "ui-client" });
  assert.equal(typeof f.hooks.config, "function"); assert.equal(f.hooks.menu.icon, "link");
  await f.hooks.ready(); assert.equal(client.status().active, false);
  await client.openPairing(); assert.match(f.hooks.dialog.htmlContent, /textarea/); assert.doesNotMatch(f.hooks.dialog.htmlContent, /<script|onclick=/);
  await client.pair(pairingCode()); assert.equal(f.secrets.size, 1); assert.equal([...f.secrets.values()][0], pairingCode());
  await client.disconnect(); assert.equal(f.secrets.size, 0); f.hooks.unload(); await client.finished(); assert.equal(c.timers.size, 0);
});

const fullCounter = (id, title, extra = {}) => ({ id, title, icon: "water_drop", type: "ClickCounter", isEnabled: true, isOn: false, countOnDay: { "2026-10-30": 5 }, ...extra });
test("counter creation is unavailable because the SP initializer does not record a persistent create", async () => {
  const f = fixture();
  const result = await f.execute("counters.create", { counterId: "water", title: "Water" });
  assert.equal(result.ok, false); assert.equal(result.error.code, "SP_BAD_INPUT"); assert.equal(result.outcomeUnknown, undefined);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.state.simpleCounters, {});
});
test("counter configuration preserves type and historical values and validates title uniqueness", async () => {
  const f = fixture();
  f.state.simpleCounters.water = fullCounter("water", "Water");
  f.state.simpleCounters.timer = fullCounter("timer", "Timer", { type: "StopWatch", privateField: "not-for-output" });
  const history = clone(f.state.simpleCounters.timer.countOnDay);
  const result = await f.execute("counters.update", { counterId: "timer", title: "Stopwatch", isEnabled: false, isHideButton: false });
  assert.equal(result.ok, true); assert.equal(result.data.counter.type, "StopWatch"); assert.deepEqual(f.state.simpleCounters.timer.countOnDay, history);
  const duplicate = await f.execute("counters.update", { counterId: "timer", title: " WATER " });
  assert.equal(duplicate.error.code, "SP_DUPLICATE_TITLE"); assert.equal(f.calls.length, 1);
  const same = await f.execute("counters.update", { counterId: "timer", title: "Stopwatch" });
  assert.equal(same.data.unchanged, true); assert.equal(f.calls.length, 1);
  const listed = await f.execute("counters.list", {});
  assert.doesNotMatch(JSON.stringify(listed), /privateField|countOnDay|not-for-output/);
});
test("counter deletion requires exact title and history authorization and protects running counters", async () => {
  const f = fixture(); f.state.simpleCounters.water = fullCounter("water", "Water");
  for (const args of [{ counterId: "water", confirmTitle: "Water" }, { counterId: "water", confirmTitle: "wrong", allowHistoryDelete: true }]) {
    assert.equal((await f.execute("counters.delete", args)).ok, false); assert.equal(f.calls.length, 0);
  }
  f.state.simpleCounters.water.isOn = true;
  assert.equal((await f.execute("counters.delete", { counterId: "water", confirmTitle: "Water", allowHistoryDelete: true })).error.code, "SP_COUNTER_RUNNING");
  f.state.simpleCounters.water.isOn = false;
  const deleted = await f.execute("counters.delete", { counterId: "water", confirmTitle: "Water", allowHistoryDelete: true });
  assert.deepEqual(deleted.data, { id: "water", deleted: true, removedTrackedDays: 1 }); assert.equal(f.state.simpleCounters.water, undefined);
});
test("counter configuration errors are unconfirmed and never retry public writes", async () => {
  const f = fixture(); f.api.updateSimpleCounter = async () => { throw new Error("Synthetic configuration failure"); };
  f.state.simpleCounters.water = fullCounter("water", "Water");
  const result = await f.execute("counters.update", { counterId: "water", title: "Renamed" });
  assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.simpleCounters.water.title, "Water"); assert.equal(f.calls.length, 0);
  f.api.deleteSimpleCounter = async () => {};
  const ignored = await f.execute("counters.delete", { counterId: "water", confirmTitle: "Water", allowHistoryDelete: true });
  assert.equal(ignored.error.code, "SP_VERIFY_FAILED"); assert.equal(ignored.outcomeUnknown, true);
});
test("counter arbitrary fields and invalid IDs are rejected before mutation", async () => {
  const f = fixture();
  for (const [op, args] of [
    ["counters.create", { counterId: "__proto__", title: "Bad" }], ["counters.create", { counterId: "new", title: "Bad", type: "StopWatch" }],
    ["counters.update", { counterId: "x", countOnDay: {} }], ["counters.update", { counterId: "x", isOn: true }],
    ["counters.update", { counterId: "x", isEnabled: "false" }], ["counters.update", { counterId: "x", icon: "../../bad" }],
  ]) { assert.equal((await f.execute(op, args)).ok, false); assert.equal(f.calls.length, 0); }
  f.state.simpleCounters.water = fullCounter("water", "Water");
  delete f.api.updateSimpleCounter;
  const unsupported = await f.execute("counters.update", { counterId: "water", title: "No write" });
  assert.equal(unsupported.error.code, "SP_PLUGIN_UNSUPPORTED"); assert.equal(f.calls.length, 0);
});
function orderedFixture() {
  const f = fixture();
  f.state.projects.p1.taskIds = ["a", "b"];
  f.state.projects.p1.backlogTaskIds = ["backlog"];
  for (const taskId of ["a", "b", "backlog"]) f.state.tasks[taskId] = { id: taskId, title: taskId, isDone: false, projectId: "p1", subTaskIds: [] };
  f.state.tasks.a.subTaskIds = ["c", "d"];
  for (const taskId of ["c", "d"]) f.state.tasks[taskId] = { id: taskId, title: taskId, isDone: false, parentId: "a", subTaskIds: [] };
  return f;
}
test("task order only permutes complete current lists and never touches backlog or ownership", async () => {
  const f = orderedFixture();
  const initial = await f.execute("taskOrder.list", { contextType: "project", contextId: "p1" });
  assert.deepEqual(initial.data, { contextType: "project", contextId: "p1", taskIds: ["a", "b"], backlogTaskIds: ["backlog"] });
  const result = await f.execute("taskOrder.update", { contextType: "project", contextId: "p1", expectedTaskIds: ["a", "b"], taskIds: ["b", "a"] });
  assert.equal(result.ok, true); assert.deepEqual(f.state.projects.p1.backlogTaskIds, ["backlog"]);
  const child = await f.execute("taskOrder.update", { contextType: "task", contextId: "a", expectedTaskIds: ["c", "d"], taskIds: ["d", "c"] });
  assert.equal(child.ok, true); assert.equal(f.state.tasks.c.parentId, "a");
  assert.deepEqual(f.calls.map((c) => c[0]), ["reorderTasks", "reorderTasks"]);
  const again = await f.execute("taskOrder.update", { contextType: "project", contextId: "p1", expectedTaskIds: ["a", "b"], taskIds: ["b", "a"] });
  assert.equal(again.data.unchanged, true); assert.equal(f.calls.length, 2);
});
test("stale order, omitted tasks, duplicates and backlog moves are refused without mutation", async () => {
  const f = orderedFixture();
  for (const [expectedTaskIds, taskIds] of [[["b", "a"], ["a", "b", "backlog"]], [["a", "b"], ["a"]], [["a", "b"], ["b", "b"]], [["a", "backlog"], ["backlog", "a"]]]) {
    const result = await f.execute("taskOrder.update", { contextType: "project", contextId: "p1", expectedTaskIds, taskIds });
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, undefined);
  }
  f.state.projects.p1.taskIds.push("new"); f.state.tasks.new = { id: "new", projectId: "p1" };
  const stale = await f.execute("taskOrder.update", { contextType: "project", contextId: "p1", expectedTaskIds: ["a", "b"], taskIds: ["b", "a"] });
  assert.equal(stale.error.code, "SP_ORDER_CONFLICT"); assert.equal(f.calls.length, 0);
});
test("order verifies SP's result and cancellation prevents the next write", async () => {
  const f = orderedFixture(); f.api.reorderTasks = async () => {};
  const args = { contextType: "project", contextId: "p1", expectedTaskIds: ["a", "b"], taskIds: ["b", "a"] };
  const failed = await f.execute("taskOrder.update", args);
  assert.equal(failed.error.code, "SP_VERIFY_FAILED"); assert.equal(failed.outcomeUnknown, true);
  let cancelled = false; const read = f.api.getAppState;
  f.api.getAppState = async () => { cancelled = true; return read(); };
  const result = await f.execute("taskOrder.update", args, () => cancelled);
  assert.equal(result.error.code, "SP_COMMAND_CANCELLED"); assert.equal(result.outcomeUnknown, undefined);
});
test("selection opens only an active exact task and confirms selection without starting tracking", async () => {
  const f = orderedFixture();
  assert.deepEqual((await f.execute("selection.list", {})).data, { selectedTask: null });
  const result = await f.execute("selection.select", { taskId: "c" });
  assert.deepEqual(result.data, { selectedTask: { id: "c", title: "c", isDone: false }, unchanged: false });
  assert.deepEqual(f.calls, [["selectTask", "c"]]);
  assert.equal((await f.execute("selection.select", { taskId: "c" })).data.unchanged, true);
  assert.equal((await f.execute("selection.select", { taskId: "archived" })).error.code, "SP_NO_TASK");
  f.api.selectTask = async () => {};
  const missingAck = await f.execute("selection.select", { taskId: "a" });
  assert.equal(missingAck.error.code, "SP_VERIFY_FAILED"); assert.equal(missingAck.outcomeUnknown, true);
});

function reparentFixture() {
  const f = fixture();
  f.state.projects.p1.taskIds = ["old", "new", "leaf"];
  for (const taskId of ["old", "new", "leaf", "child"]) f.state.tasks[taskId] = { id: taskId, projectId: "p1", title: taskId, isDone: false, subTaskIds: [], tagIds: [], notes: "unchanged", timeSpent: 0, timeEstimate: 0, timeSpentOnDay: {} };
  f.state.tasks.old.subTaskIds = ["child"]; f.state.tasks.child.parentId = "old";
  f.api.batchUpdateForProject = async (request) => {
    f.calls.push(["batchUpdateForProject", clone(request)]);
    assert.equal(request.operations.length, 2);
    const [update, reorder] = request.operations;
    assert.deepEqual(Object.keys(update.updates), ["parentId"]);
    assert.equal(update.type, "update"); assert.equal(reorder.type, "reorder");
    const task = f.state.tasks[update.taskId], old = task.parentId;
    if (old) f.state.tasks[old].subTaskIds = f.state.tasks[old].subTaskIds.filter((id) => id !== task.id);
    task.parentId = update.updates.parentId ?? undefined;
    if (task.parentId) f.state.tasks[task.parentId].subTaskIds.push(task.id);
    // The public batch reducer rebuilds the project's root list, including any backlog.
    const rootIds = Object.values(f.state.tasks).filter((row) => row.projectId === request.projectId && !row.parentId).map((row) => row.id);
    f.state.projects[request.projectId].taskIds = [...reorder.taskIds.filter((id) => rootIds.includes(id)), ...rootIds.filter((id) => !reorder.taskIds.includes(id))];
    return { success: true, createdTaskIds: {} };
  };
  return f;
}
test("reparent uses a narrow official batch and preserves list order, tags and completion metadata", async () => {
  const f = reparentFixture(), args = { taskId: "child", expectedParentId: "old", parentId: "new" };
  f.state.tasks.child.doneOn = 100; f.state.tasks.child.wontDoOn = 100;
  f.state.tasks.child.tagIds = ["t1"]; f.state.tags.t1.taskIds = ["child"];
  const result = await f.execute("tasks.reparent", args);
  assert.deepEqual(result.data, { id: "child", parentId: "new", previousParentId: "old", projectId: "p1", unchanged: false });
  assert.deepEqual(f.state.projects.p1.taskIds, ["old", "new", "leaf"]);
  assert.deepEqual(f.state.tasks.old.subTaskIds, []); assert.deepEqual(f.state.tasks.new.subTaskIds, ["child"]);
  assert.equal(f.state.tasks.child.doneOn, 100); assert.equal(f.state.tasks.child.wontDoOn, 100); assert.equal(f.state.tasks.child.notes, "unchanged");
  assert.deepEqual(f.state.tags.t1.taskIds, ["child"]);
  assert.deepEqual(f.calls[0][1].operations, [{ type: "update", taskId: "child", updates: { parentId: "new" } }, { type: "reorder", taskIds: ["old", "new", "leaf"] }]);
  assert.doesNotMatch(JSON.stringify(result), /notes|subTaskIds|tagIds|unchanged"\s*:\s*"/);
});
test("reparent can promote a leaf to the main list or move a root leaf below a root parent", async () => {
  const f = reparentFixture();
  assert.equal((await f.execute("tasks.reparent", { taskId: "child", expectedParentId: "old", parentId: null })).ok, true);
  assert.deepEqual(f.state.projects.p1.taskIds, ["old", "new", "leaf", "child"]);
  assert.equal(f.state.tasks.child.parentId, undefined);
  assert.equal((await f.execute("tasks.reparent", { taskId: "leaf", expectedParentId: null, parentId: "new" })).ok, true);
  assert.deepEqual(f.state.projects.p1.taskIds, ["old", "new", "child"]);
  const before = f.calls.length;
  assert.equal((await f.execute("tasks.reparent", { taskId: "leaf", expectedParentId: "new", parentId: "new" })).data.unchanged, true);
  assert.equal(f.calls.length, before);
});
test("reparent accepts unrelated tag-only tasks with an empty project ID and preserves their state", async () => {
  const f = reparentFixture();
  f.state.tasks["tag-only"] = { id: "tag-only", projectId: "", isDone: false, subTaskIds: [], tagIds: ["t1"], timeSpent: 60000, timeEstimate: 120000, timeSpentOnDay: { "2026-10-31": 60000 } };
  f.state.tags.t1.taskIds = ["tag-only"];
  const before = clone(f.state.tasks["tag-only"]);
  const result = await f.execute("tasks.reparent", { taskId: "child", expectedParentId: "old", parentId: "new" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.state.tasks["tag-only"], before);
  assert.deepEqual(f.state.tags.t1.taskIds, ["tag-only"]);
});
for (const target of ["child", "old", "new", "sibling", "existing", "descendant"]) {
  test(`reparent refuses recorded time or estimates on related ${target} before the batch can leave parent totals stale`, async () => {
    for (const patch of [{ timeSpent: 60000 }, { timeEstimate: 120000 }, { timeSpentOnDay: { "2026-10-31": 60000 } }]) {
      const f = reparentFixture();
      for (const [taskId, parentId] of [["sibling", "old"], ["existing", "new"], ["descendant", "sibling"]]) {
        f.state.tasks[taskId] = { id: taskId, parentId, projectId: "p1", isDone: false, subTaskIds: [], tagIds: [], timeSpent: 0, timeEstimate: 0, timeSpentOnDay: {} };
        f.state.tasks[parentId].subTaskIds.push(taskId);
      }
      Object.assign(f.state.tasks[target], patch);
      const before = clone(f.state);
      const result = await f.execute("tasks.reparent", { taskId: "child", expectedParentId: "old", parentId: "new" });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "SP_REPARENT_UNSUPPORTED");
      assert.equal(result.outcomeUnknown, undefined);
      assert.equal(f.calls.length, 0);
      assert.deepEqual(f.state, before);
    }
  });
}
test("reparent requires explicit zero totals and valid day values but accepts the optional absent day map", async () => {
  for (const patch of [{ timeSpent: undefined }, { timeEstimate: undefined }, { timeSpent: null }, { timeSpent: "0" }, { timeEstimate: NaN }, { timeSpentOnDay: null }, { timeSpentOnDay: [] }, { timeSpentOnDay: { "2026-10-31": "0" } }]) {
    const f = reparentFixture(); Object.assign(f.state.tasks.child, patch);
    const result = await f.execute("tasks.reparent", { taskId: "child", expectedParentId: "old", parentId: "new" });
    assert.equal(result.error.code, "SP_REPARENT_UNSUPPORTED"); assert.equal(f.calls.length, 0);
  }
  const f = reparentFixture(); delete f.state.tasks.child.timeSpentOnDay;
  f.state.tasks.old.timeSpentOnDay = { "2026-10-31": 0 };
  assert.equal((await f.execute("tasks.reparent", { taskId: "child", expectedParentId: "old", parentId: "new" })).ok, true);
  assert.equal(f.calls.length, 1);
});
test("zero-time restrictions also protect promotion and nesting a root while no-op confirmation does not mutate timed tasks", async () => {
  for (const args of [{ taskId: "child", expectedParentId: "old", parentId: null }, { taskId: "leaf", expectedParentId: null, parentId: "new" }]) {
    const f = reparentFixture(); f.state.tasks[args.taskId].timeEstimate = 60000;
    const result = await f.execute("tasks.reparent", args);
    assert.equal(result.error.code, "SP_REPARENT_UNSUPPORTED"); assert.equal(f.calls.length, 0);
  }
  const f = reparentFixture(); f.state.tasks.child.timeSpent = 60000;
  const result = await f.execute("tasks.reparent", { taskId: "child", expectedParentId: "old", parentId: "old" });
  assert.equal(result.ok, true); assert.equal(result.data.unchanged, true); assert.equal(f.calls.length, 0);
});
test("reparent readback detects changed related time but permits unrelated normal tracking ticks", async () => {
  for (const patch of [{ timeSpent: 1000 }, { timeEstimate: 1000 }, { timeSpentOnDay: { "2026-10-31": 1000 } }, { timeSpentOnDay: { "2026-10-31": 0 } }]) {
    const f = reparentFixture(), update = f.api.batchUpdateForProject;
    f.api.batchUpdateForProject = async (request) => { const result = await update(request); Object.assign(f.state.tasks.old, patch); return result; };
    const result = await f.execute("tasks.reparent", { taskId: "child", expectedParentId: "old", parentId: "new" });
    assert.equal(result.error.code, "SP_VERIFY_FAILED"); assert.equal(result.outcomeUnknown, true); assert.equal(f.calls.length, 1);
  }
  const f = reparentFixture(), update = f.api.batchUpdateForProject;
  f.state.tasks.leaf.timeSpent = 60000; f.state.tasks.leaf.timeSpentOnDay = { "2026-10-31": 60000 };
  f.api.batchUpdateForProject = async (request) => {
    const result = await update(request);
    f.state.tasks.leaf.timeSpent += 1000; f.state.tasks.leaf.timeSpentOnDay["2026-10-31"] += 1000;
    return result;
  };
  assert.equal((await f.execute("tasks.reparent", { taskId: "child", expectedParentId: "old", parentId: "new" })).ok, true);
  assert.equal(f.state.tasks.leaf.timeSpent, 61000); assert.equal(f.calls.length, 1);
});
test("reparent preflight blocks every batch-cleanup hazard and unsupported scope before writing", async () => {
  for (const change of [
    (f) => { f.state.projects.p1.taskIds = ["old", "new"]; f.state.projects.p1.backlogTaskIds = ["leaf"]; },
    (f) => { f.state.tasks.orphan = { id: "orphan", parentId: "missing", projectId: "p1", isDone: false, tagIds: [], subTaskIds: [] }; },
    (f) => { f.state.tags.t1.taskIds = ["missing"]; },
    (f) => { f.state.tasks.leaf.tagIds = ["t1"]; },
    (f) => { f.state.tasks.old.subTaskIds = []; },
    (f) => { f.state.tasks.child.repeatCfgId = "repeat"; },
    (f) => { f.state.tasks.new.repeatCfgId = "repeat"; },
    (f) => { f.state.tasks.old.repeatCfgId = "repeat"; },
    (f) => { f.state.tasks.new.projectId = "p2"; },
    (f) => { f.state.tasks.new.isDone = true; },
    (f) => { f.state.projects.p1.isArchived = true; },
    (f) => { f.state.tasks.child.subTaskIds = ["leaf"]; f.state.tasks.leaf.parentId = "child"; f.state.projects.p1.taskIds = ["old", "new"]; },
    (f) => { f.state.tasks.new.parentId = "leaf"; f.state.tasks.leaf.subTaskIds = ["new"]; f.state.projects.p1.taskIds = ["old", "leaf"]; },
  ]) {
    const f = reparentFixture(); change(f); const before = clone(f.state);
    const result = await f.execute("tasks.reparent", { taskId: "child", expectedParentId: "old", parentId: "new" });
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, undefined); assert.equal(f.calls.length, 0); assert.deepEqual(f.state, before);
  }
});
test("reparent refuses stale parents and malformed acknowledgements and detects unintended changes", async () => {
  const stale = reparentFixture();
  assert.equal((await stale.execute("tasks.reparent", { taskId: "child", expectedParentId: null, parentId: "new" })).error.code, "SP_PARENT_CONFLICT");
  assert.equal(stale.calls.length, 0);
  for (const fault of ["no-op", "missing-ack", "unrelated-change", "tag-change"]) {
    const f = reparentFixture(), update = f.api.batchUpdateForProject;
    f.api.batchUpdateForProject = async (request) => {
      if (fault === "no-op") return { success: true, createdTaskIds: {} };
      const result = await update(request);
      if (fault === "missing-ack") return { success: false };
      if (fault === "unrelated-change") f.state.tasks.leaf.isDone = true;
      if (fault === "tag-change") f.state.tags.t1.taskIds.push("leaf");
      return result;
    };
    const result = await f.execute("tasks.reparent", { taskId: "child", expectedParentId: "old", parentId: "new" });
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true); assert.ok(f.calls.length <= 1);
  }
});

test("generated plugin is import-free and initializes public hooks", async () => {
  const code = await readFile(new URL("../../sp-hana-bridge/plugin.js", import.meta.url), "utf8");
  assert.doesNotMatch(code, /^import |^export /m);
  const f = fixture(); new Function("PluginAPI", code)(f.api);
  assert.equal(typeof f.hooks.ready, "function"); assert.equal(typeof f.hooks.unload, "function");
  await f.hooks.ready(); f.hooks.unload();
});

test("ZIP has exact root manifest and plugin entries and no Node permission", async () => {
  const zip = await readFile(new URL("../../sp-hana-bridge/dist/hana-sp-bridge.zip", import.meta.url));
  const files = new Map(); let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18); const nameLength = zip.readUInt16LE(offset + 26); const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString(); const start = offset + 30 + nameLength + extraLength;
    files.set(name, inflateRawSync(zip.subarray(start, start + size)).toString()); offset = start + size;
  }
  assert.deepEqual([...files.keys()], ["manifest.json", "plugin.js", "README.md"]);
  const manifest = JSON.parse(files.get("manifest.json")); assert.equal(manifest.iFrame, false); assert.equal(manifest.minSupVersion, "19.3.1");
  const pkg = JSON.parse(await readFile(new URL("../../sp-hana-bridge/package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, "0.6.0"); assert.equal(manifest.version, VERSION); assert.equal(pkg.version, VERSION);
  assert.ok(manifest.permissions.includes("deleteProject")); assert.ok(!manifest.permissions.includes("nodeExecution"));
  assert.deepEqual(manifest.allowedHosts, ["127.0.0.1"]);
  assert.equal(files.get("plugin.js"), await readFile(new URL("../../sp-hana-bridge/plugin.js", import.meta.url), "utf8"));
});
