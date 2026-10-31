import assert from "node:assert/strict";
import test from "node:test";
import { validateCounterControlCommand, projectCounterControl } from "../../sp-tasks/lib/counter-control-contract.js";
import { registerCounterControlTools, COUNTER_CONTROL_CAPABILITIES } from "../../sp-tasks/lib/counter-control-tools.js";
import { executeCounterControl } from "../../sp-hana-bridge/src/counter-control.mjs";
import { SpError } from "../../sp-tasks/lib/sp.js";
import { readNotice, resetNoticeCache } from "../../sp-tasks/lib/notice.js";

globalThis.fetch = async () => { throw new Error("Live network is forbidden in counter control tests"); };
const clone = (value) => structuredClone(value);
const counter = (extra = {}) => ({ id: "counter-1", type: "StopWatch", isEnabled: true, isOn: false, ...extra });
const argsFor = (expected = counter()) => ({ counterId: expected.id, expected: clone(expected) });

function fixture(extra = {}) {
  const state = {
    counter: { ...counter(extra), title: "private title", notes: "private notes", countOnDay: { "2026-10-30": 1234 } },
    reads: 0, calls: [], attempted: 0, cancelled: false, onRead: null, afterToggle: null, readOverride: null, ignored: false, toggleError: null,
    countdownCache: { remaining: 12000, hasStarted: true }, completionBanner: true,
  };
  const api = {
    getSimpleCounter: async (id) => {
      state.reads++;
      assert.equal(id, "counter-1");
      state.onRead?.(state.reads);
      return state.readOverride ? state.readOverride(state.reads) : clone(state.counter);
    },
    toggleSimpleCounter: async (id) => {
      state.calls.push(["toggleSimpleCounter", id]);
      if (!state.ignored) state.counter.isOn = !state.counter.isOn;
      state.afterToggle?.();
      if (state.toggleError) throw state.toggleError;
      // Public SP toggleSimpleCounter returns Promise<void>; readback is the acknowledgement.
    },
    setSimpleCounterEnabled: async () => { throw new Error("Control must never enable a counter implicitly"); },
    updateSimpleCounter: async () => { throw new Error("Control must never patch configuration or history"); },
    dispatchAction: () => { throw new Error("Control must use the public counter method"); },
  };
  const run = async (op, args) => {
    let attempted = false;
    try {
      const data = await executeCounterControl(api, op, args, {
        write: async (work) => {
          if (state.cancelled) throw Object.assign(new Error("Cancelled before mutation"), { code: "SP_COMMAND_CANCELLED" });
          attempted = true; state.attempted++;
          return await work();
        },
        fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
      });
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: { code: error.code || "SP_PLUGIN_ERROR", message: error.message }, outcomeUnknown: attempted };
    }
  };
  return { state, api, run, status: () => run("counterControl.list", { counterId: "counter-1" }) };
}

test("shared contract copies exact scalar state and strips private counter fields", () => {
  const expected = Object.freeze(counter()), args = Object.freeze({ counterId: expected.id, expected });
  const result = validateCounterControlCommand("counterControl.start", args);
  assert.deepEqual(result, args);
  assert.notEqual(result, args); assert.notEqual(result.expected, expected);
  assert.deepEqual(projectCounterControl({ ...expected, countOnDay: { private: 1 }, title: "private" }), expected);
  assert.deepEqual(validateCounterControlCommand("counterControl.list", { counterId: "counter-1" }), { counterId: "counter-1" });
});

for (const [label, op, args] of [
  ["toggle", "counterControl.toggle", argsFor()],
  ["old read name", "counterControl.status", { counterId: "counter-1" }],
  ["null", "counterControl.list", null],
  ["array", "counterControl.list", []],
  ["missing ID", "counterControl.list", {}],
  ["path ID", "counterControl.list", { counterId: "a/b" }],
  ["whitespace ID", "counterControl.list", { counterId: " counter-1" }],
  ["control character ID", "counterControl.list", { counterId: "counter\n" }],
  ["long ID", "counterControl.list", { counterId: "x".repeat(241) }],
  ["read expected", "counterControl.list", argsFor()],
  ["unknown argument", "counterControl.start", { ...argsFor(), foo: "private-value" }],
  ["missing expected", "counterControl.start", { counterId: "counter-1" }],
  ["partial expected", "counterControl.stop", { counterId: "counter-1", expected: { isOn: true } }],
  ["unknown expected field", "counterControl.start", { counterId: "counter-1", expected: { ...counter(), foo: "private-value" } }],
  ["mismatched expected ID", "counterControl.start", { counterId: "counter-1", expected: counter({ id: "counter-2" }) }],
  ["click counter expected", "counterControl.start", argsFor(counter({ type: "ClickCounter" }))],
  ["string switch", "counterControl.start", argsFor(counter({ isOn: "false" }))],
  ["numeric enabled", "counterControl.start", argsFor(counter({ isEnabled: 1 }))],
]) {
  test(`invalid ${label} is rejected before reading SP`, async () => {
    const f = fixture();
    const result = await f.run(op, args);
    assert.equal(result.error.code, "SP_BAD_INPUT");
    assert.equal(result.outcomeUnknown, false);
    assert.equal(f.state.reads, 0); assert.equal(f.state.calls.length, 0);
    assert.doesNotMatch(result.error.message, /private-value/);
  });
}

for (const type of ["StopWatch", "RepeatedCountdownReminder"]) {
  test(`status returns only ${type} switch state and does not mutate`, async () => {
    const f = fixture({ type }), before = clone(f.state.counter);
    assert.deepEqual(await f.status(), { ok: true, data: { counter: counter({ type }), localOnly: true } });
    assert.deepEqual(f.state.counter, before);
    assert.equal(f.state.calls.length, 0);
    assert.doesNotMatch(JSON.stringify((await f.status()).data), /private|countOnDay|countdownCache/);
  });
}

test("stopwatch start and stop use one public toggle each and preserve configuration and history", async () => {
  const f = fixture(), before = clone(f.state.counter);
  const started = await f.run("counterControl.start", argsFor(counter()));
  assert.deepEqual(started, { ok: true, data: { counter: counter({ isOn: true }), localOnly: true, unchanged: false, verification: "applied-state" } });
  const stopped = await f.run("counterControl.stop", argsFor(started.data.counter));
  assert.deepEqual(stopped.data, { counter: counter(), localOnly: true, unchanged: false, verification: "applied-state" });
  assert.deepEqual(f.state.calls, [["toggleSimpleCounter", "counter-1"], ["toggleSimpleCounter", "counter-1"]]);
  assert.deepEqual(f.state.counter, before); assert.equal(f.state.reads, 4);
});

for (const [op, isOn] of [["counterControl.start", true], ["counterControl.stop", false]]) {
  test(`${op} is idempotent when the target is already reached, including after a lost reply`, async () => {
    const f = fixture({ isOn });
    delete f.api.toggleSimpleCounter;
    const result = await f.run(op, argsFor(counter({ isOn: !isOn })));
    assert.equal(result.ok, true);
    assert.equal(result.data.unchanged, true);
    assert.equal(result.data.counter.isOn, isOn);
    assert.equal(f.state.calls.length, 0); assert.equal(f.state.attempted, 0);
  });
}

test("starting a disabled stopwatch never enables it or claims it is running", async () => {
  for (const isOn of [false, true]) {
    const f = fixture({ isEnabled: false, isOn }), before = clone(f.state.counter);
    const result = await f.run("counterControl.start", argsFor(counter({ isEnabled: false, isOn })));
    assert.equal(result.error.code, "SP_COUNTER_DISABLED");
    assert.equal(result.outcomeUnknown, false); assert.equal(f.state.calls.length, 0);
    assert.deepEqual(f.state.counter, before);
  }
});

test("stopping a disabled but toggled stopwatch clears isOn without changing enabled", async () => {
  const f = fixture({ isEnabled: false, isOn: true });
  const result = await f.run("counterControl.stop", argsFor(counter({ isEnabled: false, isOn: true })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.counter, counter({ isEnabled: false, isOn: false }));
  assert.equal(f.state.calls.length, 1);
});

test("repeated countdown can be paused without clearing cached progress or a completion banner", async () => {
  for (const isEnabled of [true, false]) {
    const f = fixture({ type: "RepeatedCountdownReminder", isOn: true, isEnabled });
    const cache = clone(f.state.countdownCache);
    const result = await f.run("counterControl.stop", argsFor(counter({ type: "RepeatedCountdownReminder", isOn: true, isEnabled })));
    assert.equal(result.ok, true); assert.equal(result.data.counter.isOn, false);
    assert.deepEqual(f.state.countdownCache, cache); assert.equal(f.state.completionBanner, true);
    assert.equal(f.state.calls.length, 1);
  }
});

test("repeated countdown start is refused even if isOn is true because public toggle does not initialize its UI state", async () => {
  for (const isOn of [false, true]) {
    const f = fixture({ type: "RepeatedCountdownReminder", isOn });
    const result = await f.run("counterControl.start", argsFor(counter({ type: "RepeatedCountdownReminder", isOn })));
    assert.equal(result.error.code, "SP_COUNTER_CONTROL_UNSUPPORTED");
    assert.match(result.error.message, /does not initialize/);
    assert.equal(result.outcomeUnknown, false); assert.equal(f.state.calls.length, 0);
  }
});

test("click counters never receive a switch mutation", async () => {
  const f = fixture({ type: "ClickCounter", isOn: true });
  const status = await f.status();
  assert.equal(status.error.code, "SP_COUNTER_CONTROL_UNSUPPORTED");
  const result = await f.run("counterControl.stop", argsFor(counter({ isOn: true })));
  assert.equal(result.error.code, "SP_COUNTER_CONTROL_UNSUPPORTED");
  assert.equal(f.state.calls.length, 0);
});

for (const [name, extra, op, expected] of [
  ["switch before start", {}, "counterControl.start", counter({ isOn: true })],
  ["switch before stop", { isOn: true }, "counterControl.stop", counter()],
  ["enabled", { isEnabled: false }, "counterControl.stop", counter()],
  ["type", { type: "RepeatedCountdownReminder" }, "counterControl.stop", counter()],
]) {
  test(`stale expected ${name} refuses to overwrite changed state`, async () => {
    const f = fixture(extra), before = clone(f.state.counter);
    const result = await f.run(op, argsFor(expected));
    assert.equal(result.error.code, "SP_COUNTER_CONTROL_CONFLICT");
    assert.equal(result.outcomeUnknown, false); assert.equal(f.state.calls.length, 0);
    assert.deepEqual(f.state.counter, before);
  });
}

test("a cancellation after preflight reaches the write gate before the public switch", async () => {
  const f = fixture();
  f.state.onRead = () => { f.state.cancelled = true; };
  const result = await f.run("counterControl.start", argsFor());
  assert.equal(result.error.code, "SP_COMMAND_CANCELLED");
  assert.equal(result.outcomeUnknown, false); assert.equal(f.state.calls.length, 0);
});

test("missing public APIs fail before a mutation attempt", async () => {
  const f = fixture(); delete f.api.toggleSimpleCounter;
  assert.equal((await f.status()).ok, true);
  const result = await f.run("counterControl.start", argsFor());
  assert.equal(result.error.code, "SP_COUNTER_CONTROL_UNSUPPORTED"); assert.equal(result.outcomeUnknown, false);
  delete f.api.getSimpleCounter;
  assert.equal((await f.status()).error.code, "SP_COUNTER_CONTROL_UNSUPPORTED");
  assert.equal(f.state.attempted, 0);
});

test("ignored toggles and successful-looking return values cannot substitute for state readback", async () => {
  const f = fixture(); f.state.ignored = true;
  const toggle = f.api.toggleSimpleCounter;
  f.api.toggleSimpleCounter = async (id) => { await toggle(id); return { success: true }; };
  const result = await f.run("counterControl.start", argsFor());
  assert.equal(result.error.code, "SP_VERIFY_FAILED"); assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.counter.isOn, false);
});

for (const [name, raw] of [
  ["missing entity", undefined], ["null", null], ["missing state", {}], ["wrong ID", counter({ id: "another" })],
  ["missing enabled", { id: "counter-1", type: "StopWatch", isOn: true }], ["string state", counter({ isOn: "true" })],
]) {
  test(`${name} after a toggle is unknown and never succeeds`, async () => {
    const f = fixture();
    f.state.readOverride = (read) => read === 1 ? clone(f.state.counter) : clone(raw);
    const result = await f.run("counterControl.start", argsFor());
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true);
    assert.equal(f.state.calls.length, 1);
  });
}

test("a missing counter before writing is a certain failure", async () => {
  const f = fixture(); f.state.readOverride = () => undefined;
  const result = await f.run("counterControl.start", argsFor());
  assert.equal(result.error.code, "SP_NO_COUNTER"); assert.equal(result.outcomeUnknown, false);
  assert.equal(f.state.calls.length, 0);
});

test("postwrite type and enabled changes are not accepted as a successful switch", async () => {
  for (const patch of [{ type: "RepeatedCountdownReminder" }, { isEnabled: false }]) {
    const f = fixture(); f.state.afterToggle = () => Object.assign(f.state.counter, patch);
    const result = await f.run("counterControl.start", argsFor());
    assert.equal(result.error.code, "SP_VERIFY_FAILED"); assert.equal(result.outcomeUnknown, true);
    assert.equal(f.state.calls.length, 1);
  }
});

test("normal stopwatch ticks may change accumulated time while a switch is verified", async () => {
  const f = fixture();
  f.state.afterToggle = () => { f.state.counter.countOnDay["2026-10-31"] = 1000; };
  const result = await f.run("counterControl.start", argsFor());
  assert.equal(result.ok, true); assert.equal(f.state.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /countOnDay|1000|private/);
});

test("a lost switch reply is not retried; status reconciles the actual target without a second toggle", async () => {
  const f = fixture(); f.state.toggleError = new Error("Reply lost after local state changed");
  const result = await f.run("counterControl.start", argsFor());
  assert.equal(result.outcomeUnknown, true); assert.equal(f.state.calls.length, 1);
  assert.equal((await f.status()).data.counter.isOn, true);
  f.state.toggleError = null;
  const confirmed = await f.run("counterControl.start", argsFor());
  assert.equal(confirmed.data.unchanged, true); assert.equal(f.state.calls.length, 1);
});

test("prewrite read errors are certain and postwrite read errors retain outcomeUnknown", async () => {
  for (const failedRead of [1, 2]) {
    const f = fixture(); f.state.onRead = (read) => { if (read === failedRead) throw new Error("Snapshot unavailable"); };
    const result = await f.run("counterControl.start", argsFor());
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, failedRead === 2);
    assert.equal(f.state.calls.length, failedRead - 1);
  }
});

async function toolFixture() {
  const tools = new Map(), plugin = fixture();
  const state = { status: { enabled: true, running: true, connected: true, protocol: 1, pluginVersion: "0.4.0" }, statusError: null, statusReads: 0, calls: [], override: null, error: null, errors: [], noticeReads: 0 };
  const sdk = {
    tools: { register: async (tool) => { tools.set(tool.name, tool); } },
    config: { getAll: async () => ({ baseUrl: "http://sp.invalid", accessToken: "fixture" }) },
    network: { fetch: async (url) => {
      assert.equal(new URL(url).origin, "http://sp.invalid"); state.noticeReads++;
      return new Response(JSON.stringify({ ok: true, data: url.endsWith("/tasks") ? [{ id: "fixture", isDone: false, title: "Fixture" }] : null }));
    } },
  };
  const bridge = {
    status: async () => { state.statusReads++; if (state.statusError) throw state.statusError; return clone(state.status); },
    execute: async (op, args) => {
      state.calls.push({ op, args: clone(args) });
      if (state.error) throw state.error;
      if (state.override) return state.override(op, args);
      const result = await plugin.run(op, args);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, outcomeUnknown: result.outcomeUnknown });
      return result.data;
    },
  };
  const guard = (work) => async (args) => {
    try { return await work(args); }
    catch (error) { state.errors.push(error); return { ok: false, code: error.code, outcomeUnknown: error.outcomeUnknown === true }; }
  };
  await registerCounterControlTools(sdk, { bridge, guard, ok: (data) => ({ ok: true, ...data }) });
  return { state, plugin, sdk, tools, call: (args) => tools.get("sp_tasks_counter_control").execute(args) };
}

test("registers one closed-schema tool and the 0.4.0 capability", async () => {
  const f = await toolFixture();
  assert.deepEqual([...f.tools.keys()], ["sp_tasks_counter_control"]);
  const schema = f.tools.get("sp_tasks_counter_control").parameters;
  assert.deepEqual(schema.properties.action.enum, ["status", "start", "stop"]);
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.expected.additionalProperties, false);
  assert.deepEqual(schema.properties.expected.required, ["id", "type", "isEnabled", "isOn"]);
  assert.deepEqual(COUNTER_CONTROL_CAPABILITIES[0].tools, ["sp_tasks_counter_control"]);
  assert.equal(COUNTER_CONTROL_CAPABILITIES[0].minimumPluginVersion, "0.4.0");
});

test("tool status strips host context and can feed its complete counter into explicit start and stop", async () => {
  const f = await toolFixture();
  const args = Object.freeze({ action: "status", counterId: "counter-1", context: { callToken: "private-context" } });
  const before = await f.call(args);
  assert.deepEqual(before, { ok: true, counter: counter(), localOnly: true });
  const started = await f.call({ action: "start", counterId: "counter-1", expected: before.counter });
  const stopped = await f.call({ action: "stop", counterId: "counter-1", expected: started.counter });
  assert.equal(started.counter.isOn, true); assert.equal(stopped.counter.isOn, false);
  assert.deepEqual(f.state.calls.map((call) => call.op), ["counterControl.list", "counterControl.start", "counterControl.stop"]);
  assert.doesNotMatch(JSON.stringify(f.state.calls) + JSON.stringify(before), /private-context|countOnDay|notes/);
  assert.equal(args.context.callToken, "private-context");
});

for (const args of [null, {}, { action: "toggle", counterId: "counter-1" }, { action: "status", counterId: "counter-1", foo: true }, { action: "start", counterId: "counter-1" }, { action: "stop", ...argsFor(), enabled: true }]) {
  test(`tool rejects invalid arguments before bridge access: ${JSON.stringify(args)}`, async () => {
    const f = await toolFixture();
    assert.equal((await f.call(args)).code, "SP_BAD_INPUT");
    assert.equal(f.state.statusReads, 0); assert.equal(f.state.calls.length, 0);
  });
}

for (const status of [{ enabled: false }, { running: false }, { connected: false }, { available: false }, { accepting: false }, { stopping: true }, { error: { code: "FAIL" } }, { protocol: 2 }, { pluginVersion: "0.3.0" }, { pluginVersion: "0.4.0-beta" }, { pluginVersion: "garbage" }]) {
  test(`tool prevents calls through an unavailable or old bridge: ${JSON.stringify(status)}`, async () => {
    const f = await toolFixture(); Object.assign(f.state.status, status);
    const result = await f.call({ action: "status", counterId: "counter-1" });
    assert.match(result.code, /^SP_BRIDGE_(?:NOT_CONNECTED|UPGRADE_REQUIRED)$/);
    assert.equal(f.state.calls.length, 0); assert.equal(result.outcomeUnknown, false);
  });
}

test("tool converts status and command failures into SpError without retrying", async () => {
  const f = await toolFixture(); f.state.statusError = new Error("No bridge");
  assert.equal((await f.call({ action: "status", counterId: "counter-1" })).code, "SP_BRIDGE_UNAVAILABLE");
  f.state.statusError = null; f.state.error = Object.assign(new Error("Changed"), { code: "SP_COUNTER_CONTROL_CONFLICT" });
  assert.equal((await f.call({ action: "start", ...argsFor() })).code, "SP_COUNTER_CONTROL_CONFLICT");
  assert.equal(f.state.calls.length, 1); assert.ok(f.state.errors.every((error) => error instanceof SpError));
});

for (const [name, data] of [
  ["null", null], ["empty", {}], ["wrong ID", { counter: counter({ id: "wrong" }), localOnly: true }],
  ["unsupported type", { counter: counter({ type: "ClickCounter" }), localOnly: true }],
  ["missing local-only scope", { counter: counter() }], ["wrong state type", { counter: counter({ isOn: "true" }), localOnly: true }],
]) {
  for (const action of ["status", "start"]) {
    test(`tool never accepts malformed ${action} reply: ${name}`, async () => {
      const f = await toolFixture(); f.state.override = () => data;
      const result = await f.call(action === "status" ? { action, counterId: "counter-1" } : { action, ...argsFor() });
      assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(result.outcomeUnknown, action !== "status");
    });
  }
}

for (const extra of [{ unchanged: undefined }, { unchanged: "true" }, { verification: undefined }, { counter: counter() }, { counter: counter({ isOn: true, isEnabled: false }) }, { counter: counter({ isOn: true, type: "RepeatedCountdownReminder" }) }]) {
  test(`tool requires a confirmed desired state and unchanged configuration: ${JSON.stringify(extra)}`, async () => {
    const f = await toolFixture();
    f.state.override = () => ({ counter: counter({ isOn: true }), localOnly: true, unchanged: false, verification: "applied-state", ...extra });
    const result = await f.call({ action: "start", ...argsFor() });
    assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(result.outcomeUnknown, true);
  });
}

test("tool propagates an unknown write once and invalidates the cached notice", async () => {
  resetNoticeCache();
  const f = await toolFixture(); await readNotice(f.sdk);
  const reads = f.state.noticeReads; await readNotice(f.sdk); assert.equal(f.state.noticeReads, reads);
  f.state.error = Object.assign(new Error("Response lost"), { code: "SP_BRIDGE_TIMEOUT", outcomeUnknown: true });
  const result = await f.call({ action: "start", ...argsFor() });
  assert.equal(result.code, "SP_BRIDGE_TIMEOUT"); assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.calls.length, 1);
  await readNotice(f.sdk); assert.ok(f.state.noticeReads > reads);
  resetNoticeCache();
});
