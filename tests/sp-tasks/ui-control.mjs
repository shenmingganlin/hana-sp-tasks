import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { UI_CONTROL_COMMANDS, validateUiControlCommand } from "../../sp-tasks/lib/ui-control-contract.js";
import { registerUiControlTools, UI_CONTROL_CAPABILITIES } from "../../sp-tasks/lib/ui-control-tools.js";
import { executeUiControl } from "../../sp-hana-bridge/src/ui-control.mjs";
import { createCommandExecutor } from "../../sp-hana-bridge/src/companion.mjs";
import { createPluginCode, loadPluginSources } from "../../sp-hana-bridge/scripts/build.mjs";
import { validateCommand } from "../../sp-tasks/lib/bridge-protocol.js";
import { SpError } from "../../sp-tasks/lib/sp.js";

globalThis.fetch = async () => { throw new Error("Live network is forbidden in UI control tests"); };
const clone = (value) => structuredClone(value);
const actions = {
  "focus.show": "[FocusMode] Show Overlay", "focus.hide": "[FocusMode] Hide Overlay",
  "addTask.show": "[Layout] Show AddTaskBar", "addTask.hide": "[Layout] Hide AddTaskBar",
  "notes.toggle": "[Layout] ToggleShow Notes", "sidePanel.hide": "[Layout] Hide Non-Task Side Panel",
  "issues.toggle": "[Layout] Toggle IssuePanel", "pluginPanel.hide": "[Layout] Hide PluginPanel",
};
const receipt = (command) => ({ command, submitted: true, verification: "submitted" });

function fixture() {
  const state = { calls: [], attempted: 0, cancelled: false, error: null, result: undefined };
  const api = {
    dispatchAction: async (action) => {
      state.calls.push(clone(action));
      if (state.error) throw state.error;
      return state.result;
    },
    getAppState: () => { throw new Error("Layout is not in the public snapshot"); },
    openDialog: () => { throw new Error("An unrelated dialog cannot confirm a panel"); },
  };
  const run = async (op, args) => {
    let attempted = false;
    try {
      const data = await executeUiControl(api, op, args, {
        write: async (work) => {
          if (state.cancelled) throw Object.assign(new Error("Cancelled"), { code: "SP_COMMAND_CANCELLED" });
          attempted = true; state.attempted++;
          return await work();
        },
        fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
      });
      return { ok: true, data };
    } catch (error) { return { ok: false, error: { code: error.code || "SP_PLUGIN_ERROR", message: error.message }, outcomeUnknown: attempted }; }
  };
  return { state, api, run };
}

test("the contract is a closed command set and returns a fresh object", () => {
  assert.deepEqual(UI_CONTROL_COMMANDS, Object.keys(actions));
  const input = Object.freeze({ command: "focus.show" });
  const output = validateUiControlCommand("ui.command", input);
  assert.deepEqual(output, input); assert.notEqual(output, input);
});

for (const [command, type] of Object.entries(actions)) {
  test(`${command} submits exactly one official action and no user-supplied payload`, async () => {
    const f = fixture();
    const result = await f.run("ui.command", Object.freeze({ command }));
    assert.deepEqual(f.state.calls, [{ type }]);
    assert.deepEqual(result, { ok: true, data: receipt(command) });
    assert.equal(f.state.attempted, 1);
    assert.doesNotMatch(JSON.stringify(result), /isOverlayShown|isShowNotes|rendered|applied-state/);
  });
}

for (const [op, args] of [
  ["ui.status", {}], ["ui.focus.show", {}], ["ui.command", null], ["ui.command", []], ["ui.command", {}],
  ["ui.command", { command: "[FocusMode] Start Session" }], ["ui.command", { command: "focus.start" }],
  ["ui.command", { command: "notes.show" }], ["ui.command", { command: "constructor" }],
  ["ui.command", { command: "focus.show", action: { type: "private-action" } }],
  ["ui.command", { command: "focus.show", meta: { isPersistent: true } }],
  ["ui.command", { command: "focus.show", html: "private-html" }],
  ["ui.command", { command: "focus.show", script: "private-script" }],
]) {
  test(`invalid command input is rejected before any mutation: ${JSON.stringify([op, args])}`, async () => {
    const f = fixture(); const result = await f.run(op, args);
    assert.equal(result.error.code, "SP_BAD_INPUT"); assert.equal(result.outcomeUnknown, false);
    assert.equal(f.state.calls.length, 0); assert.equal(f.state.attempted, 0);
    assert.doesNotMatch(result.error.message, /private-action|private-html|private-script/);
  });
}

test("missing public dispatcher fails before the write gate", async () => {
  const f = fixture(); delete f.api.dispatchAction;
  const result = await f.run("ui.command", { command: "focus.show" });
  assert.equal(result.error.code, "SP_UI_CONTROL_UNSUPPORTED"); assert.equal(result.outcomeUnknown, false);
  assert.equal(f.state.attempted, 0);
});

test("cancellation is checked by the write gate without dispatching", async () => {
  const f = fixture(); f.state.cancelled = true;
  const result = await f.run("ui.command", { command: "notes.toggle" });
  assert.equal(result.error.code, "SP_COMMAND_CANCELLED"); assert.equal(result.outcomeUnknown, false);
  assert.equal(f.state.calls.length, 0);
});

test("a lost dispatcher reply is unknown and never automatically re-sends a toggle", async () => {
  const f = fixture(); f.state.error = new Error("Reply lost");
  const result = await f.run("ui.command", { command: "notes.toggle" });
  assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.calls.length, 1);
});

test("a void dispatcher returns submitted without pretending to observe visual state", async () => {
  const f = fixture();
  const first = await f.run("ui.command", { command: "focus.show" });
  assert.deepEqual(first.data, receipt("focus.show"));
  f.state.result = { rendered: true, layout: { private: true } };
  const second = await f.run("ui.command", { command: "focus.hide" });
  assert.deepEqual(second.data, receipt("focus.hide"));
});

async function toolFixture() {
  const tools = new Map(), plugin = fixture();
  const state = { status: { enabled: true, running: true, connected: true, protocol: 1, pluginVersion: "0.5.0" }, reads: 0, calls: [], statusError: null, error: null, override: null, errors: [] };
  const sdk = { tools: { register: async (tool) => { tools.set(tool.name, tool); } } };
  const bridge = {
    status: async () => { state.reads++; if (state.statusError) throw state.statusError; return clone(state.status); },
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
  await registerUiControlTools(sdk, { bridge, guard, ok: (data) => ({ ok: true, ...data }) });
  return { state, plugin, tools, call: (args) => tools.get("sp_tasks_ui").execute(args) };
}

test("registers one tool with a closed schema and the 0.5.0 capability", async () => {
  const f = await toolFixture();
  assert.deepEqual([...f.tools.keys()], ["sp_tasks_ui"]);
  const schema = f.tools.get("sp_tasks_ui").parameters;
  assert.deepEqual(schema.required, ["command"]); assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), ["command"]);
  assert.deepEqual(schema.properties.command.enum, UI_CONTROL_COMMANDS);
  assert.deepEqual(UI_CONTROL_CAPABILITIES[0].tools, ["sp_tasks_ui"]);
  assert.equal(UI_CONTROL_CAPABILITIES[0].minimumPluginVersion, "0.5.0");
});

test("tool strips host context and sends only a fixed command through the real executor module", async () => {
  const f = await toolFixture();
  const args = Object.freeze({ command: "notes.toggle", context: { callToken: "private-context" } });
  assert.deepEqual(await f.call(args), { ok: true, ...receipt("notes.toggle") });
  assert.deepEqual(f.state.calls, [{ op: "ui.command", args: { command: "notes.toggle" } }]);
  assert.equal(args.context.callToken, "private-context");
  assert.doesNotMatch(JSON.stringify(f.state.calls), /private-context/);
});

for (const args of [null, [], {}, { command: "focus.start" }, { command: "focus.show", foo: "private-value" }, { command: "notes.toggle", action: {} }]) {
  test(`tool rejects invalid input before bridge status: ${JSON.stringify(args)}`, async () => {
    const f = await toolFixture(); const result = await f.call(args);
    assert.equal(result.code, "SP_BAD_INPUT"); assert.equal(f.state.reads, 0); assert.equal(f.state.calls.length, 0);
    assert.doesNotMatch(f.state.errors[0].message, /private-value/);
  });
}

for (const status of [{ enabled: false }, { running: false }, { connected: false }, { available: false }, { accepting: false }, { stopping: true }, { error: { code: "FAIL" } }, { protocol: 2 }, { pluginVersion: "0.4.0" }, { pluginVersion: "0.5.0-beta" }, { pluginVersion: "bad" }]) {
  test(`tool blocks unavailable or incompatible bridge: ${JSON.stringify(status)}`, async () => {
    const f = await toolFixture(); Object.assign(f.state.status, status);
    const result = await f.call({ command: "focus.show" });
    assert.match(result.code, /^SP_BRIDGE_(?:NOT_CONNECTED|UPGRADE_REQUIRED)$/);
    assert.equal(f.state.calls.length, 0); assert.equal(result.outcomeUnknown, false);
  });
}

test("status and command errors retain code and uncertainty without a retry", async () => {
  const f = await toolFixture(); f.state.statusError = new Error("No runtime");
  assert.equal((await f.call({ command: "focus.show" })).code, "SP_BRIDGE_UNAVAILABLE");
  f.state.statusError = null; f.state.error = Object.assign(new Error("Reply lost"), { code: "SP_BRIDGE_TIMEOUT", outcomeUnknown: true });
  const result = await f.call({ command: "notes.toggle" });
  assert.equal(result.code, "SP_BRIDGE_TIMEOUT"); assert.equal(result.outcomeUnknown, true);
  assert.equal(f.state.calls.length, 1); assert.ok(f.state.errors.every((error) => error instanceof SpError));
});

test("tool errors never reflect raw bridge messages or malformed codes", async () => {
  const secret = "private-token-sentinel";
  for (const code of ["SP_BRIDGE_TIMEOUT", secret, `SP_BAD\n${secret}`, "SP_" + "X".repeat(81), undefined]) {
    const f = await toolFixture();
    f.state.error = Object.assign(new Error(`Raw request Authorization: Bearer ${secret}`), { code, outcomeUnknown: true });
    const result = await f.call({ command: "notes.toggle" });
    assert.equal(result.code, code === "SP_BRIDGE_TIMEOUT" ? code : "SP_BRIDGE_ERROR");
    assert.equal(result.outcomeUnknown, true);
    assert.doesNotMatch(JSON.stringify(result) + f.state.errors[0].message + f.state.errors[0].code, /private-token-sentinel|Authorization|Bearer/);
    assert.equal(f.state.calls.length, 1);
  }
});

for (const [name, data] of [
  ["null", null], ["empty", {}], ["wrong command", receipt("focus.hide")],
  ["missing submitted", { command: "focus.show", verification: "submitted" }],
  ["string submitted", { command: "focus.show", submitted: "true", verification: "submitted" }],
  ["missing verification", { command: "focus.show", submitted: true }],
  ["false applied claim", { command: "focus.show", submitted: true, verification: "applied-state" }],
]) {
  test(`tool rejects an unconfirmed submission as unknown: ${name}`, async () => {
    const f = await toolFixture(); f.state.override = () => data;
    const result = await f.call({ command: "focus.show" });
    assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(result.outcomeUnknown, true);
    assert.equal(f.state.calls.length, 1);
  });
}

test("tool projects only the submission receipt and never forwards claimed UI state", async () => {
  const f = await toolFixture();
  f.state.override = () => ({ ...receipt("focus.show"), rendered: true, layout: { notes: "private" } });
  assert.deepEqual(await f.call({ command: "focus.show" }), { ok: true, ...receipt("focus.show") });
});

test("real bridge validation and companion routing preserve the closed UI contract and write uncertainty", async () => {
  const f = fixture(), execute = createCommandExecutor(f.api);
  for (const command of UI_CONTROL_COMMANDS) {
    const request = validateCommand("ui.command", Object.freeze({ command }));
    assert.equal(request.op, "ui.command");
    assert.deepEqual(await execute(request.op, request.args), { ok: true, data: receipt(command) });
  }
  assert.deepEqual(f.state.calls, Object.values(actions).map((type) => ({ type })));
  for (const args of [{ command: "focus.start" }, { command: "notes.toggle", foo: "private-value" }]) {
    assert.throws(() => validateCommand("ui.command", args), (error) => error.code === "SP_BRIDGE_BAD_INPUT" && !/private-value/.test(error.message));
    const rejected = await execute("ui.command", args);
    assert.equal(rejected.error.code, "SP_BAD_INPUT"); assert.notEqual(rejected.outcomeUnknown, true);
  }
  const cancelled = await execute("ui.command", { command: "notes.toggle" }, () => true);
  assert.equal(cancelled.error.code, "SP_COMMAND_CANCELLED"); assert.notEqual(cancelled.outcomeUnknown, true);
  assert.equal(f.state.calls.length, UI_CONTROL_COMMANDS.length);
  f.state.error = new Error("Lost public API reply: private-dispatch-token");
  const failed = await execute("ui.command", { command: "notes.toggle" });
  assert.equal(failed.ok, false); assert.equal(failed.outcomeUnknown, true);
  assert.equal(f.state.calls.length, UI_CONTROL_COMMANDS.length + 1);
  assert.doesNotMatch(JSON.stringify(failed), /private-dispatch-token/);
});

async function bundledUiFixture(t, { lostDispatchReply = false, lostResultAck = false } = {}) {
  const code = createPluginCode(await loadPluginSources());
  assert.doesNotMatch(code, /^\s*(?:import|export)\b/m);
  const command = { id: "ui-toggle-delivered", ...validateCommand("ui.command", { command: "notes.toggle" }), expiresAt: Date.now() + 120000 };
  const token = "ui-pairing-fixture-token-".repeat(3);
  const pairing = "HANA-SP1." + Buffer.from(JSON.stringify({ protocol: 1, url: "http://127.0.0.1:3877", token })).toString("base64url");
  const state = { calls: [], reports: [], polls: 0, notesShown: false, ready: [], unload: [], configs: [], menus: [], notices: [] };
  const timers = new Map(), complete = Promise.withResolvers();
  let timerId = 0;
  const expectedReports = lostResultAck ? 3 : 2;
  const response = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data }) });
  const stop = () => state.unload.forEach((handler) => handler());
  t.after(stop);
  const api = {
    registerConfigHandler: (handler) => state.configs.push(handler),
    registerMenuEntry: (entry) => state.menus.push(entry),
    onReady: (handler) => state.ready.push(handler),
    onUnload: (handler) => state.unload.push(handler),
    getSecret: async () => pairing,
    showSnack: (notice) => state.notices.push(clone(notice)),
    dispatchAction: async (action) => {
      state.calls.push(clone(action)); state.notesShown = !state.notesShown;
      if (lostDispatchReply) throw new Error("Lost API response: private-dispatch-token");
    },
    getAppState: () => { throw new Error("UI commands cannot read layout from the public snapshot"); },
    openDialog: () => { throw new Error("Stored pairing must not open a dialog"); },
  };
  const sandbox = {
    PluginAPI: api, AbortController, TextEncoder, TextDecoder, atob,
    crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    setTimeout: (callback, milliseconds) => {
      const id = ++timerId;
      timers.set(id, callback);
      // Backoff runs on the next microtask; request deadlines stay armed until
      // the fake response or the actual unload hook clears them.
      if (milliseconds < 30000) queueMicrotask(() => { if (timers.delete(id)) callback(); });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => {
      try {
        const target = new URL(url);
        assert.equal(target.origin, "http://127.0.0.1:3877");
        assert.equal(options.method, "POST"); assert.equal(options.headers.Authorization, `Bearer ${token}`);
        assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
        const body = JSON.parse(options.body);
        if (target.pathname === "/plugin/poll") {
          state.polls++;
          assert.equal(body.protocol, 1); assert.equal(body.version, "0.6.0");
          if (state.polls <= 2) return response({ command: clone(command) });
          return new Promise((_resolve, reject) => {
            const abort = () => reject(new Error("Fixture poll aborted"));
            if (options.signal.aborted) abort();
            else options.signal.addEventListener("abort", abort, { once: true });
          });
        }
        assert.equal(target.pathname, "/plugin/result"); assert.equal(body.id, command.id);
        state.reports.push(body);
        if (lostResultAck && state.reports.length === 1) throw new TypeError("Fixture lost acknowledgement");
        if (state.reports.length === expectedReports) complete.resolve();
        return response({ accepted: true, id: body.id });
      } catch (error) {
        if (lostResultAck && state.reports.length === 1 && error.message === "Fixture lost acknowledgement") throw error;
        complete.reject(error); stop(); throw error;
      }
    },
  };
  const context = createContext(sandbox);
  const globalKeys = () => runInContext("JSON.stringify(Reflect.ownKeys(globalThis).map(String).sort())", context);
  const beforeKeys = globalKeys();
  runInContext(code, context, { timeout: 1000 });
  assert.equal(state.ready.length, 1); assert.equal(state.unload.length, 1);
  assert.equal(state.configs.length, 1); assert.equal(state.menus.length, 1);
  assert.equal(state.calls.length, 0); assert.equal(state.polls, 0);
  await Promise.all([state.ready[0](), complete.promise]);
  stop();
  await new Promise(setImmediate);
  assert.equal(timers.size, 0);
  assert.equal(globalKeys(), beforeKeys, "The generated IIFE must not publish module variables");
  for (const name of ["module", "exports", "require", "installCompanion", "createBridgeClient", "createCommandExecutor", "executeUiControl", "UI_CONTROL_COMMANDS", "validateUiControlCommand"]) {
    assert.equal(runInContext(`typeof ${name}`, context), "undefined", `${name} must remain private to the bundle`);
  }
  assert.deepEqual(state.calls, [{ type: actions["notes.toggle"] }]);
  assert.equal(state.notesShown, true, "A retry or repeated command ID must not toggle the panel back");
  assert.equal(state.reports.length, expectedReports);
  for (const report of state.reports) assert.deepEqual(report, state.reports[0], "Receipt retry and command redelivery must return the cached result");
  assert.doesNotMatch(JSON.stringify(state.reports) + JSON.stringify(state.notices), /private-dispatch-token|ui-pairing-fixture-token/);
  return state;
}

test("the unmodified production IIFE starts through onReady and deduplicates a delivered UI toggle", { timeout: 5000 }, async (t) => {
  const state = await bundledUiFixture(t);
  assert.deepEqual(state.reports[0].result, { ok: true, data: receipt("notes.toggle") });
});

test("a bundled UI toggle retries a lost result acknowledgement without another dispatch", { timeout: 5000 }, async (t) => {
  const state = await bundledUiFixture(t, { lostResultAck: true });
  assert.deepEqual(state.reports[0].result, { ok: true, data: receipt("notes.toggle") });
});

test("a bundled toggle with a lost API reply keeps its unknown receipt across ACK loss and redelivery", { timeout: 5000 }, async (t) => {
  const state = await bundledUiFixture(t, { lostDispatchReply: true, lostResultAck: true });
  assert.equal(state.reports[0].result.ok, false);
  assert.equal(state.reports[0].result.outcomeUnknown, true);
});
