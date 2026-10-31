import assert from "node:assert/strict";
import test from "node:test";
import { WORK_CONTEXT_ACTION, WORK_CONTEXT_OPS, validateWorkContextCommand, projectWorkContext } from "../../sp-tasks/lib/work-context-contract.js";
import { executeWorkContext } from "../../sp-hana-bridge/src/work-context.mjs";
import { createCommandExecutor } from "../../sp-hana-bridge/src/companion.mjs";
import { createPluginCode, loadPluginSources } from "../../sp-hana-bridge/scripts/build.mjs";
import { validateCommand } from "../../sp-tasks/lib/bridge-protocol.js";
import { registerWorkContextTools, WORK_CONTEXT_CAPABILITIES } from "../../sp-tasks/lib/work-context-tools.js";
import { readNotice, resetNoticeCache } from "../../sp-tasks/lib/notice.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in work-context tests"); };
const clone = (value) => structuredClone(value);
const identity = (id = "p1", type = "PROJECT") => ({ id, type });
const request = (contextId = "p2", contextType = "project", expected = identity()) => ({ contextId, contextType, expected });

function fixture() {
  const state = {
    projects: {
      p1: { id: "p1", title: "Alpha", taskIds: ["a"], isArchived: false },
      p2: { id: "p2", title: "Beta", taskIds: ["b"], isArchived: false, privateSetting: "secret-value" },
      archived: { id: "archived", title: "Archived", taskIds: [], isArchived: true },
      INBOX_PROJECT: { id: "INBOX_PROJECT", title: "Inbox", taskIds: [], isArchived: false },
    },
    tags: { t1: { id: "t1", title: "Tag", taskIds: ["a", "c"] }, TODAY: { id: "TODAY", title: "Today", taskIds: ["legacy-order"] } },
    active: { activeId: "p1", activeType: "PROJECT" }, todayTaskIds: ["scheduled", "a"],
    currentTaskId: "tracking-in-another-project", selectedTaskId: "a", route: "/planner", banner: true,
    contextReads: 0, stateReads: 0, attempts: 0, writes: [], ignoreWrite: false,
    contextErrorAt: 0, stateError: false, dispatchError: false, readOverride: null, onSnapshot: null, onDispatch: null,
  };
  const api = {
    getActiveWorkContext: async () => {
      state.contextReads++;
      if (state.contextReads === state.contextErrorAt) throw new Error("secret-value: read exception");
      if (state.readOverride) return state.readOverride();
      const row = (state.active.activeType === "PROJECT" ? state.projects : state.tags)[state.active.activeId];
      if (!row) return null;
      // SP 19.3.1 toActiveWorkContext uses TODAY rather than the store's TAG.
      return clone({ ...row, type: row.id === "TODAY" ? "TODAY" : state.active.activeType, taskIds: row.id === "TODAY" ? state.todayTaskIds : row.taskIds, privateSetting: "secret-value" });
    },
    getAppState: async () => {
      state.stateReads++;
      if (state.stateError) throw new Error("secret-value: snapshot exception");
      state.onSnapshot?.();
      return clone({ projects: state.projects, tags: state.tags, globalConfig: { sync: { token: "secret-value" } } });
    },
    dispatchAction: (action) => {
      assert.deepEqual(Object.keys(action).sort(), ["activeId", "activeType", "type"]);
      assert.equal(action.type, "[WorkContext] Set Active Work Context");
      assert.ok(["PROJECT", "TAG"].includes(action.activeType));
      state.writes.push(clone(action));
      if (!state.ignoreWrite) {
        // WorkContext reducer plus WorkContextEffects.unselectSelectedTask$.
        state.active = { activeId: action.activeId, activeType: action.activeType };
        state.selectedTaskId = null;
        state.banner = false;
      }
      state.onDispatch?.();
      if (state.dispatchError) throw new Error("secret-value: dispatch exception");
    },
  };
  const run = async (op, args) => {
    let attempted = false;
    try {
      const data = await executeWorkContext(api, op, args, {
        write: async (work) => { attempted = true; state.attempts++; return await work(); },
        fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
      });
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: { code: error.code || "SP_PLUGIN_ERROR", message: error.code ? error.message : "Public API failed." }, ...(attempted ? { outcomeUnknown: true } : {}) };
    }
  };
  return { state, api, run };
}

test("closed contract clones caller input and exposes only two fixed operations", () => {
  assert.deepEqual(WORK_CONTEXT_OPS, ["workContext.list", "workContext.switch"]);
  const args = Object.freeze({ ...request(), expected: Object.freeze(identity()) });
  assert.deepEqual(validateWorkContextCommand("workContext.switch", args), args);
  assert.notEqual(validateWorkContextCommand("workContext.switch", args).expected, args.expected);
  assert.deepEqual(validateWorkContextCommand("workContext.list", Object.freeze({})), {});
});

const invalid = [
  ["workContext.list", null], ["workContext.list", []], ["workContext.get", {}],
  ["workContext.list", { contextId: "p1" }], ["workContext.list", { foo: "secret-value" }],
  ["workContext.switch", {}], ["workContext.switch", { ...request(), expected: null }],
  ["workContext.switch", { ...request(), expected: { id: "p1" } }],
  ["workContext.switch", { ...request(), expected: { ...identity(), title: "Alpha" } }],
  ["workContext.switch", { ...request(), expected: identity("TODAY", "TAG") }],
  ["workContext.switch", { ...request(), expected: identity("t1", "TODAY") }],
  ["workContext.switch", { ...request(), expected: identity("p1", "project") }],
  ["workContext.switch", { ...request(), contextType: "PROJECT" }],
  ["workContext.switch", request("TODAY", "project")],
  ["workContext.switch", request("INBOX_PROJECT", "tag")],
  ["workContext.switch", { ...request(), action: WORK_CONTEXT_ACTION }],
  ["workContext.switch", { ...request(), meta: { isPersistent: true } }],
  ...["", " ", " p2", "p2 ", ".", "..", "a/b", "a\\b", "a\nb", "x".repeat(241), 1].map((contextId) => ["workContext.switch", request(contextId)]),
];
for (const [index, [op, args]] of invalid.entries()) {
  test(`invalid command ${index + 1} is rejected before any SP read or write`, async () => {
    const f = fixture(), result = await f.run(op, args);
    assert.equal(result.error.code, "SP_BAD_INPUT");
    assert.equal(f.state.contextReads + f.state.stateReads + f.state.attempts, 0);
    assert.notEqual(result.outcomeUnknown, true);
    assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  });
}

test("unknown business field errors name the keys without reflecting their values", () => {
  assert.throws(() => validateWorkContextCommand("workContext.list", { foo: "secret-value", callToken: "secret-token" }), (error) => {
    assert.match(error.message, /foo/); assert.match(error.message, /callToken/);
    assert.doesNotMatch(error.message, /secret-value|secret-token/); return true;
  });
});

test("get projects only local identity and current task order, with no configuration or mutation", async () => {
  const f = fixture();
  const result = await f.run("workContext.list", {});
  assert.deepEqual(result, { ok: true, data: { context: { id: "p1", type: "PROJECT", title: "Alpha", taskIds: ["a"], localOnly: true } } });
  assert.equal(f.state.stateReads, 0); assert.equal(f.state.attempts, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret|globalConfig|currentTask|selectedTask/);
  result.data.context.taskIds.push("external-change");
  assert.deepEqual(f.state.projects.p1.taskIds, ["a"]);
});

test("unready get is explicit null and unready switch does not guess the previous context", async () => {
  const f = fixture(); f.state.readOverride = () => null;
  assert.deepEqual(await f.run("workContext.list", {}), { ok: true, data: { context: null } });
  assert.equal((await f.run("workContext.switch", request())).error.code, "SP_CONTEXT_NOT_READY");
  assert.equal(f.state.attempts, 0);
});

for (const [contextId, contextType, type, taskIds] of [
  ["p2", "project", "PROJECT", ["b"]], ["t1", "tag", "TAG", ["a", "c"]],
  ["TODAY", "tag", "TODAY", ["scheduled", "a"]], ["INBOX_PROJECT", "project", "PROJECT", []],
]) {
  test(`switch to ${contextId} uses the exact local action and reads its public context`, async () => {
    const f = fixture(), beforeProjects = clone(f.state.projects), beforeTags = clone(f.state.tags);
    const result = await f.run("workContext.switch", request(contextId, contextType));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.state.writes, [{ type: WORK_CONTEXT_ACTION, activeId: contextId, activeType: contextType === "project" ? "PROJECT" : "TAG" }]);
    assert.deepEqual(result.data.context, { id: contextId, type, title: (contextType === "project" ? f.state.projects : f.state.tags)[contextId].title, taskIds, localOnly: true });
    assert.equal(result.data.unchanged, false); assert.equal(result.data.verification, "applied-state");
    assert.equal(f.state.selectedTaskId, null); assert.equal(f.state.banner, false);
    assert.equal(f.state.currentTaskId, "tracking-in-another-project"); assert.equal(f.state.route, "/planner");
    assert.deepEqual(f.state.projects, beforeProjects); assert.deepEqual(f.state.tags, beforeTags);
    assert.equal(f.state.contextReads, 2); assert.equal(f.state.attempts, 1);
  });
}

test("TODAY's public identity can be used as expected when switching away", async () => {
  const f = fixture(); f.state.active = { activeId: "TODAY", activeType: "TAG" };
  assert.equal((await f.run("workContext.list", {})).data.context.type, "TODAY");
  const result = await f.run("workContext.switch", request("p2", "project", identity("TODAY", "TODAY")));
  assert.equal(result.ok, true); assert.equal(f.state.writes.length, 1);
});

test("switch readback returns fresh task IDs including large contexts, not the preflight list", async () => {
  const f = fixture(), ids = Array.from({ length: 350 }, (_, i) => `task-${i}`);
  f.state.onDispatch = () => { f.state.projects.p2.taskIds = ids; f.state.projects.p2.title = "Renamed"; };
  const result = await f.run("workContext.switch", request());
  assert.equal(result.ok, true); assert.deepEqual(result.data.context.taskIds, ids);
  assert.equal(result.data.context.title, "Renamed");
});

test("same target is a no-op that does not clear selected details or require dispatch", async () => {
  const f = fixture(); delete f.api.dispatchAction;
  const result = await f.run("workContext.switch", request("p1"));
  assert.equal(result.ok, true); assert.equal(result.data.unchanged, true);
  assert.equal(f.state.attempts, 0); assert.equal(f.state.selectedTaskId, "a");
});

test("a stale context or a user switch during destination lookup conflicts without writing", async () => {
  for (const duringSnapshot of [false, true]) {
    const f = fixture(), change = () => { f.state.active = { activeId: "t1", activeType: "TAG" }; };
    if (duringSnapshot) f.state.onSnapshot = change; else change();
    const result = await f.run("workContext.switch", request());
    assert.equal(result.error.code, "SP_CONTEXT_CONFLICT"); assert.equal(f.state.attempts, 0);
    assert.equal(f.state.active.activeId, "t1"); assert.notEqual(result.outcomeUnknown, true);
  }
});

for (const [args, code] of [[request("missing"), "SP_NO_PROJECT"], [request("missing", "tag"), "SP_NO_TAG"], [request("toString"), "SP_NO_PROJECT"], [request("archived"), "SP_ARCHIVED_PROJECT"]]) {
  test(`destination ${args.contextType}/${args.contextId} is refused before dispatch`, async () => {
    const f = fixture(), result = await f.run("workContext.switch", args);
    assert.equal(result.error.code, code); assert.equal(f.state.attempts, 0);
  });
}

test("archived current project is not accepted through the unchanged fast path", async () => {
  const f = fixture(); f.state.projects.p1.isArchived = true;
  assert.equal((await f.run("workContext.switch", request("p1"))).error.code, "SP_ARCHIVED_PROJECT");
  assert.equal(f.state.attempts, 0);
});

for (const method of ["getActiveWorkContext", "getAppState", "dispatchAction"]) {
  test(`missing public ${method} rejects a changed switch before attempting mutation`, async () => {
    const f = fixture(); delete f.api[method];
    const result = await f.run("workContext.switch", request());
    assert.equal(result.error.code, "SP_CONTEXT_UNSUPPORTED"); assert.equal(f.state.attempts, 0);
  });
}

test("missing or inconsistent target snapshots are not interpreted as valid destinations", async () => {
  for (const projects of [undefined, [], { p2: { id: "someone-else" } }]) {
    const f = fixture(); f.api.getAppState = async () => ({ projects });
    const result = await f.run("workContext.switch", request());
    assert.equal(result.ok, false); assert.equal(f.state.attempts, 0);
  }
});

for (const bad of [undefined, {}, { id: "TODAY", type: "TAG", title: "Today", taskIds: [] }, { id: "p1", type: "PROJECT", title: "A", taskIds: ["a", "a"] }, { id: "p1", type: "PROJECT", title: "A", taskIds: ["../a"] }]) {
  test(`invalid public snapshot ${JSON.stringify(bad)} is never defaulted`, async () => {
    const f = fixture(); f.state.readOverride = () => bad;
    assert.equal((await f.run("workContext.list", {})).error.code, "SP_CONTEXT_BAD_STATE");
    assert.equal(f.state.attempts, 0);
  });
}

test("a swallowed dispatch, lost reply or failed readback never reports success or retries", async () => {
  for (const failure of ["ignored", "dispatch", "read", "null", "malformed"]) {
    const f = fixture();
    if (failure === "ignored") f.state.ignoreWrite = true;
    if (failure === "dispatch") f.state.dispatchError = true;
    if (failure === "read") f.state.contextErrorAt = 2;
    if (failure === "null") f.state.onDispatch = () => { f.state.readOverride = () => null; };
    if (failure === "malformed") f.state.onDispatch = () => { f.state.readOverride = () => ({ token: "secret-value" }); };
    const result = await f.run("workContext.switch", request());
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true);
    assert.equal(f.state.attempts, 1); assert.equal(f.state.writes.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  }
});

test("pre-write API errors are sanitized and do not imply an uncertain write", async () => {
  for (const stateFailure of [false, true]) {
    const f = fixture();
    if (stateFailure) f.state.stateError = true; else f.state.contextErrorAt = 1;
    const result = await f.run("workContext.switch", request());
    assert.equal(result.error.code, "SP_CONTEXT_READ_FAILED"); assert.equal(f.state.attempts, 0);
    assert.notEqual(result.outcomeUnknown, true); assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  }
});

async function toolFixture() {
  const f = fixture(), tools = new Map([["sp_tasks_context", { sentinel: true }]]);
  Object.assign(f.state, { status: { enabled: true, running: true, connected: true, protocol: 1, pluginVersion: "0.4.0" }, statusReads: 0, bridgeCalls: [], bridgeResult: null, bridgeError: null, statusError: false, noticeReads: 0 });
  const sdk = {
    tools: { register: async (tool) => { tools.set(tool.name, tool); } },
    config: { getAll: async () => ({ baseUrl: "http://sp.invalid", accessToken: "fixture-token" }) },
    network: { fetch: async (url) => { assert.equal(new URL(url).origin, "http://sp.invalid"); f.state.noticeReads++; return new Response(JSON.stringify({ ok: true, data: url.endsWith("/tasks") ? [{ id: "a", title: "Task", isDone: false }] : null })); } },
  };
  const bridge = {
    status: async () => { f.state.statusReads++; if (f.state.statusError) throw new Error("secret-value"); return clone(f.state.status); },
    execute: async (op, args) => {
      f.state.bridgeCalls.push({ op, args: clone(args) });
      if (f.state.bridgeError) throw f.state.bridgeError;
      if (f.state.bridgeResult) return f.state.bridgeResult(op, args);
      const result = await f.run(op, args);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, outcomeUnknown: result.outcomeUnknown });
      return result.data;
    },
  };
  const guard = (work) => async (args) => {
    try { return await work(args); }
    catch (error) { return { ok: false, code: error.code, message: error.message, outcomeUnknown: error.outcomeUnknown === true }; }
  };
  await registerWorkContextTools(sdk, { bridge, guard, ok: (data) => ({ ok: true, ...data }) });
  return { ...f, tools, sdk, call: (args) => tools.get("sp_tasks_work_context").execute(args) };
}

test("registers a distinct closed-schema tool with plugin 0.4.0 capability", async () => {
  const f = await toolFixture();
  assert.deepEqual([...f.tools.keys()], ["sp_tasks_context", "sp_tasks_work_context"]);
  assert.equal(f.tools.get("sp_tasks_context").sentinel, true);
  const schema = f.tools.get("sp_tasks_work_context").parameters;
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.expected.additionalProperties, false);
  assert.deepEqual(schema.properties.action.enum, ["get", "switch"]);
  assert.deepEqual(WORK_CONTEXT_CAPABILITIES[0].tools, ["sp_tasks_work_context"]);
  assert.equal(WORK_CONTEXT_CAPABILITIES[0].minimumPluginVersion, "0.4.0");
});

test("host context is stripped and caller input is preserved through the real module chain", async () => {
  const f = await toolFixture(), args = Object.freeze({ action: "switch", ...request("TODAY", "tag"), context: Object.freeze({ callToken: "secret-value" }) });
  const result = await f.call(args);
  assert.equal(result.ok, true); assert.equal(result.context.type, "TODAY");
  assert.deepEqual(result.context.taskIds, ["scheduled", "a"]); assert.equal(result.context.localOnly, true);
  assert.deepEqual(f.state.bridgeCalls, [{ op: "workContext.switch", args: request("TODAY", "tag") }]);
  assert.equal(args.context.callToken, "secret-value"); assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(f.state.bridgeCalls), /secret-value/);
});

for (const args of [null, [], {}, { action: "delete" }, { action: "get", foo: "secret-value" }, { action: "get", callToken: "secret-value" }, { action: "get", ...request() }, { action: "switch", ...request(), expected: null }]) {
  test(`tool rejects invalid arguments ${JSON.stringify(args)} before checking bridge status`, async () => {
    const f = await toolFixture(), result = await f.call(args);
    assert.equal(result.code, "SP_BAD_INPUT"); assert.equal(f.state.statusReads, 0);
    assert.equal(f.state.bridgeCalls.length, 0); assert.doesNotMatch(JSON.stringify(result), /secret-value/);
    if (args?.foo) assert.match(result.message, /foo/);
    if (args?.callToken) assert.match(result.message, /callToken/);
  });
}

for (const status of [{ enabled: false }, { running: false }, { connected: false }, { available: false }, { accepting: false }, { stopping: true }, { protocol: 2 }, { error: { token: "secret-value" } }, { pluginVersion: "0.1.0" }, { pluginVersion: "0.2.0" }, { pluginVersion: "0.3.0" }, { pluginVersion: "0.4.0-beta" }, { pluginVersion: "unknown" }]) {
  test(`unavailable or old bridge ${JSON.stringify(status)} is gated before execution`, async () => {
    const f = await toolFixture(); Object.assign(f.state.status, status);
    const result = await f.call({ action: "switch", ...request() });
    assert.match(result.code, /^SP_BRIDGE_(?:NOT_CONNECTED|UPGRADE_REQUIRED)$/);
    assert.equal(result.outcomeUnknown, false); assert.equal(f.state.bridgeCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  });
}

test("future stable plugin version and read-only null context are supported", async () => {
  const f = await toolFixture(); f.state.status.pluginVersion = "1.0.0+build.1"; f.state.readOverride = () => null;
  assert.deepEqual(await f.call({ action: "get" }), { ok: true, context: null });
});

test("tool response projection strips extras and never accepts unverified local status", async () => {
  const f = await toolFixture();
  f.state.bridgeResult = () => ({ context: { ...projectWorkContext({ id: "p1", type: "PROJECT", title: "A", taskIds: [] }), token: "secret-value" }, secret: "secret-value" });
  const result = await f.call({ action: "get" });
  assert.equal(result.ok, true); assert.doesNotMatch(JSON.stringify(result), /secret-value|token/);
});

const malformedReplies = [null, {}, { context: undefined }, { context: { id: "p2", type: "PROJECT", title: "B", taskIds: [] } }, { context: { id: "p2", type: "PROJECT", title: "B", taskIds: [], localOnly: false } }];
for (const [index, reply] of malformedReplies.entries()) for (const action of ["get", "switch"]) {
  test(`malformed ${action} response ${index + 1} is not successful`, async () => {
    const f = await toolFixture(); f.state.bridgeResult = () => reply;
    const result = await f.call(action === "get" ? { action } : { action, ...request() });
    assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(result.outcomeUnknown, action === "switch");
  });
}

test("switch response must confirm target identity, unchanged boolean and applied-state verification", async () => {
  const context = projectWorkContext({ id: "p2", type: "PROJECT", title: "B", taskIds: ["b"] });
  for (const data of [{ context: null }, { context: { ...context, id: "p1" }, unchanged: false, verification: "applied-state" }, { context, unchanged: "false", verification: "applied-state" }, { context, unchanged: false }]) {
    const f = await toolFixture(); f.state.bridgeResult = () => data;
    const result = await f.call({ action: "switch", ...request() });
    assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(result.outcomeUnknown, true);
  }
});

test("status and transport error messages never reflect credentials and lost writes are not retried", async () => {
  const f = await toolFixture(); f.state.statusError = true;
  const status = await f.call({ action: "get" });
  assert.equal(status.code, "SP_BRIDGE_UNAVAILABLE"); assert.doesNotMatch(JSON.stringify(status), /secret-value/);
  f.state.statusError = false; f.state.bridgeError = Object.assign(new Error("secret-value"), { code: "SP_BRIDGE_TIMEOUT", outcomeUnknown: true });
  const failed = await f.call({ action: "switch", ...request() });
  assert.equal(failed.code, "SP_BRIDGE_TIMEOUT"); assert.equal(failed.outcomeUnknown, true);
  assert.equal(f.state.bridgeCalls.length, 1); assert.doesNotMatch(JSON.stringify(failed), /secret-value/);
});

test("every attempted switch invalidates the notice cache, including failed replies", async () => {
  resetNoticeCache();
  try {
    const f = await toolFixture(); await readNotice(f.sdk); const reads = f.state.noticeReads;
    await readNotice(f.sdk); assert.equal(f.state.noticeReads, reads);
    f.state.bridgeError = Object.assign(new Error("lost reply"), { code: "SP_BRIDGE_TIMEOUT", outcomeUnknown: true });
    assert.equal((await f.call({ action: "switch", ...request() })).outcomeUnknown, true);
    await readNotice(f.sdk); assert.ok(f.state.noticeReads > reads);
  } finally { resetNoticeCache(); }
});

test("actual protocol and companion envelope use the shared contract and preserve write uncertainty", async () => {
  const f = fixture(), execute = createCommandExecutor(f.api);
  assert.equal(validateCommand("workContext.list", {}).op, "workContext.list");
  const current = await execute("workContext.list", {});
  assert.equal(current.ok, true); assert.equal(current.data.context.localOnly, true);
  const args = request("TODAY", "tag");
  assert.equal(validateCommand("workContext.switch", args).op, "workContext.switch");
  assert.equal((await execute("workContext.switch", args)).data.context.type, "TODAY");
  const conflict = await execute("workContext.switch", request());
  assert.equal(conflict.error.code, "SP_CONTEXT_CONFLICT"); assert.notEqual(conflict.outcomeUnknown, true);
  assert.throws(() => validateCommand("workContext.list", { foo: "secret-value" }), (error) => error.code === "SP_BRIDGE_BAD_INPUT" && /foo/.test(error.message) && !/secret-value/.test(error.message));
  f.state.ignoreWrite = true;
  const failed = await execute("workContext.switch", request("p2", "project", identity("TODAY", "TODAY")));
  assert.equal(failed.error.code, "SP_VERIFY_FAILED"); assert.equal(failed.outcomeUnknown, true);
  assert.equal(f.state.writes.length, 2);
});

test("current bundler resolves work-context imports and runs the fixed action entirely in memory", async () => {
  const sources = await loadPluginSources();
  const companion = 'import { executeWorkContext } from "./work-context.mjs";\nexport function installCompanion(api) { api.capture(executeWorkContext); }';
  const code = createPluginCode({ ...sources, companion });
  assert.doesNotMatch(code, /^\s*(?:import|export)\b/m);
  let execute;
  new Function("PluginAPI", code)({ capture: (value) => { execute = value; } });
  const f = fixture();
  const result = await execute(f.api, "workContext.switch", request("TODAY", "tag"), { write: (work) => work(), fail: (code, message) => { throw Object.assign(new Error(message), { code }); } });
  assert.equal(result.context.type, "TODAY"); assert.equal(result.context.localOnly, true);
  assert.deepEqual(f.state.writes, [{ type: WORK_CONTEXT_ACTION, activeId: "TODAY", activeType: "TAG" }]);
});
