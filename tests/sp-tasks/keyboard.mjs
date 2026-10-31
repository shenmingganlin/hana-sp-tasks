import assert from "node:assert/strict";
import test from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { KEYBOARD_APP_KEYS, KEYBOARD_GLOBAL_KEYS, normalizeKeyboardShortcut, validateKeyboardCommand, snapshotKeyboard, projectKeyboardSettings, findKeyboardConflicts } from "../../sp-tasks/lib/keyboard-contract.js";
import { registerKeyboardTools, KEYBOARD_CAPABILITIES } from "../../sp-tasks/lib/keyboard-tools.js";
import { executeKeyboard } from "../../sp-hana-bridge/src/keyboard.mjs";
import { readNotice, resetNoticeCache } from "../../sp-tasks/lib/notice.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in keyboard tests"); };
const clone = (value) => structuredClone(value);
const marker = "PRIVATE_KEYBOARD_SENTINEL";
const zeroRevision = "0".repeat(64);
const hash = (raw) => createHash("sha256").update(JSON.stringify(Object.entries(snapshotKeyboard(raw)))).digest("hex");
const updateArgs = (expectedRevision = zeroRevision, updates = { addNewTask: "Ctrl+Alt+F12" }) => ({ expectedRevision, updates });

function fixture() {
  const state = {
    keyboard: {
      addNewTask: "A", showHelp: "?", showSearchBar: "Ctrl+F", taskToggleDone: "D",
      goToTimeline: "Shift+T", taskScheduleToday: "Shift+T",
      globalShowHide: "Ctrl+Shift+X", globalToggleTaskStart: "Ctrl+Shift+S",
      globalAddNote: "Ctrl+Shift+N", globalAddTask: "Ctrl+Shift+A", globalToggleTaskWidget: null,
      plugin_example_toggle: "Alt+F10", unknownLegacy: "legacy malformed value", hiddenUnbound: null,
      missingLegacy: undefined,
    },
    reads: 0, attempts: 0, writes: [], registeredGlobals: {},
    cancelled: false, errorAtRead: 0, ignoreWrite: false, dispatchError: false, replyLost: false, onRead: null, afterWrite: null,
  };
  const api = {
    getAppState: async () => {
      state.reads++; state.onRead?.(state.reads);
      if (state.errorAtRead === state.reads) throw new Error(marker);
      return clone({ globalConfig: { keyboard: state.keyboard, privateToken: marker }, tasks: { privateTask: marker } });
    },
    dispatchAction: async (action) => {
      state.writes.push(clone(action));
      assert.deepEqual(Object.keys(action).sort(), ["type", "sectionKey", "sectionCfg", "isSkipSnack", "meta"].sort());
      assert.equal(action.type, "[Global Config] Update Global Config Section");
      assert.equal(action.sectionKey, "keyboard"); assert.equal(action.isSkipSnack, true);
      assert.deepEqual(action.meta, { isPersistent: true, entityType: "GLOBAL_CONFIG", entityId: "keyboard", opType: "UPD" });
      if (state.dispatchError) throw new Error(marker);
      if (!state.ignoreWrite) state.keyboard = { ...state.keyboard, ...clone(action.sectionCfg) };
      // SP's effect unregisters all OS shortcuts before registering the action
      // payload. A patch here would erase every omitted global binding.
      state.registeredGlobals = Object.fromEntries(KEYBOARD_GLOBAL_KEYS.filter((key) => Object.hasOwn(action.sectionCfg, key)).map((key) => [key, action.sectionCfg[key]]));
      state.afterWrite?.();
      if (state.replyLost) throw new Error(marker);
    },
  };
  const run = async (op, args) => {
    let attempted = false;
    try {
      const data = await executeKeyboard(api, op, args, {
        write: async (work) => {
          if (state.cancelled) throw Object.assign(new Error("Command cancelled."), { code: "SP_COMMAND_CANCELLED" });
          attempted = true; state.attempts++; return await work();
        },
        fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
      });
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: { code: error.code || "SP_PLUGIN_ERROR", message: error.code ? error.message : "Public API failed." }, ...(attempted ? { outcomeUnknown: true } : {}) };
    }
  };
  return { state, api, run, list: async () => { const result = await run("keyboard.list", {}); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; } };
}

async function withCrypto(value, work) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
  try { return await work(); }
  finally { if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor); else delete globalThis.crypto; }
}

test("keyboard contract exposes exactly 52 editable built-in keys and five immutable global keys", () => {
  assert.equal(KEYBOARD_APP_KEYS.length, 52); assert.equal(new Set(KEYBOARD_APP_KEYS).size, 52);
  assert.equal(KEYBOARD_GLOBAL_KEYS.length, 5);
  assert.ok(KEYBOARD_APP_KEYS.every((key) => !key.startsWith("global") && !key.startsWith("plugin_")));
  assert.deepEqual(validateKeyboardCommand("keyboard.list", {}), {});
  const args = Object.freeze({ expectedRevision: zeroRevision, updates: Object.freeze({ addNewTask: "shift+CTRL+a", showHelp: "?", zoomIn: null }) });
  assert.deepEqual(validateKeyboardCommand("keyboard.update", args), { expectedRevision: zeroRevision, updates: { addNewTask: "Ctrl+Shift+A", showHelp: "?", zoomIn: null } });
  assert.equal(args.updates.addNewTask, "shift+CTRL+a");
});

for (const [input, normalized] of [["a", "A"], ["0", "0"], ["+", "+"], ["-", "-"], ["ctrl++", "Ctrl++"], ["meta+shift+-", "Shift+Meta+-"], ["alt+arrowup", "Alt+ArrowUp"], ["Ctrl+F24", "Ctrl+F24"], ["ctrl+space", "Ctrl+Space"], ["shift+Meta+ALT+Ctrl+Delete", "Ctrl+Alt+Shift+Meta+Delete"], [null, null]]) {
  test(`normalizes supported shortcut ${JSON.stringify(input)}`, () => { assert.equal(normalizeKeyboardShortcut("addNewTask", input), normalized); });
}

const invalid = [
  ["keyboard.list", null], ["keyboard.list", []], ["keyboard.press", {}], ["keyboard.list", { expectedRevision: zeroRevision }],
  ["keyboard.update", {}], ["keyboard.update", { ...updateArgs(), updates: {} }], ["keyboard.update", { ...updateArgs(), updates: [] }],
  ["keyboard.update", { ...updateArgs(), allowConflicts: "true" }], ["keyboard.update", { ...updateArgs(), section: "keyboard" }],
  ...[undefined, null, "", "a".repeat(63), "A".repeat(64), "g".repeat(64)].map((expectedRevision) => ["keyboard.update", { ...updateArgs(), expectedRevision }]),
  ...["globalShowHide", "globalAddTask", "plugin_example_toggle", "unknownLegacy", "__proto__"].map((key) => ["keyboard.update", updateArgs(zeroRevision, Object.fromEntries([[key, "A"]]))]),
  ...[undefined, 1, true, "", " ", "A B", "A\n", "A".repeat(101), "Ctrl+", "++", "Ctrl+Ctrl+A", "ctrl+CTRL+A", "Cmd+A", "Mod+A", "Control+A", "AltGr+A", "Shift+?", "?", "F25", "Ctrl+KeyA", "Ctrl+Shift"].map((value) => ["keyboard.update", updateArgs(zeroRevision, { addNewTask: value })]),
];
for (const [index, [op, args]] of invalid.entries()) {
  test(`invalid keyboard command ${index + 1} is rejected before SP access`, async () => {
    const f = fixture(), result = await f.run(op, args);
    assert.equal(result.error.code, "SP_BAD_INPUT"); assert.equal(f.state.reads + f.state.attempts, 0); assert.notEqual(result.outcomeUnknown, true);
  });
}

test("unknown command fields expose their names but never supplied values", () => {
  assert.throws(() => validateKeyboardCommand("keyboard.list", { foo: marker, callToken: marker }), (error) => {
    assert.match(error.message, /foo/); assert.match(error.message, /callToken/); assert.doesNotMatch(error.message, /PRIVATE_KEYBOARD_SENTINEL/); return true;
  });
});

test("get projects all app keys, missing nulls and legacy values without exposing hidden values", async () => {
  const f = fixture(); f.state.keyboard.taskEditTags = "legacy invalid chord"; f.state.keyboard.plugin_secret = marker;
  const result = await f.list();
  assert.deepEqual(Object.keys(result.settings), KEYBOARD_APP_KEYS); assert.equal(result.settings.zoomIn, null);
  assert.equal(result.settings.taskEditTags, "legacy invalid chord"); assert.equal(result.revision, hash(f.state.keyboard));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEYBOARD_SENTINEL|globalShowHide|plugin_secret|unknownLegacy|privateToken/);
  result.settings.addNewTask = "external mutation"; assert.equal(f.state.keyboard.addNewTask, "A");
  assert.equal(f.state.reads, 1); assert.equal(f.state.attempts, 0);
});

test("revision is a sorted full-raw SHA256, stable for undefined and property order", async () => {
  const f = fixture(), first = await f.list();
  f.state.keyboard = Object.fromEntries(Object.entries(f.state.keyboard).reverse()); f.state.keyboard.anotherUndefined = undefined;
  assert.equal((await f.list()).revision, first.revision);
  f.state.keyboard.globalShowHide = "Ctrl+Shift+Z"; assert.notEqual((await f.list()).revision, first.revision);
  f.state.keyboard.globalShowHide = "Ctrl+Shift+X"; assert.equal((await f.list()).revision, first.revision);
  f.state.keyboard.plugin_example_toggle = "Alt+F11"; assert.notEqual((await f.list()).revision, first.revision);
});

test("update writes fixed persistent meta and preserves the complete global/plugin/unknown dictionary", async () => {
  const f = fixture(), before = clone(f.state.keyboard), snapshot = await f.list();
  const result = await f.run("keyboard.update", updateArgs(snapshot.revision, { addNewTask: "alt+ctrl+f12", taskToggleDone: null }));
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.state.writes.length, 1); assert.equal(f.state.attempts, 1);
  assert.deepEqual(f.state.writes[0].sectionCfg, snapshotKeyboard({ ...before, addNewTask: "Ctrl+Alt+F12", taskToggleDone: null }));
  assert.deepEqual(f.state.registeredGlobals, Object.fromEntries(KEYBOARD_GLOBAL_KEYS.map((key) => [key, before[key]])));
  assert.equal(f.state.keyboard.plugin_example_toggle, before.plugin_example_toggle); assert.equal(f.state.keyboard.unknownLegacy, before.unknownLegacy);
  assert.equal(Object.hasOwn(f.state.writes[0].sectionCfg, "missingLegacy"), false);
  assert.equal(Object.hasOwn(f.state.writes[0].sectionCfg, "zoomIn"), false);
  assert.equal(result.data.settings.addNewTask, "Ctrl+Alt+F12"); assert.equal(result.data.settings.taskToggleDone, null);
  assert.equal(result.data.unchanged, false); assert.equal(result.data.verification, "applied-state"); assert.deepEqual(result.data.conflicts, []);
  assert.equal(result.data.revision, hash(f.state.keyboard)); assert.notEqual(result.data.revision, snapshot.revision);
});

test("unchanged requests avoid dispatch, including absent app fields unbound with null", async () => {
  const f = fixture(), before = clone(f.state.keyboard), snapshot = await f.list();
  for (const updates of [{ addNewTask: "a" }, { zoomIn: null }, { showHelp: "?", zoomIn: null }]) {
    const result = await f.run("keyboard.update", updateArgs(snapshot.revision, updates));
    assert.equal(result.ok, true); assert.equal(result.data.unchanged, true); assert.equal(result.data.revision, snapshot.revision);
  }
  assert.equal(f.state.attempts, 0); assert.deepEqual(f.state.keyboard, before);
});

test("a stale full-raw revision or second-read concurrent hidden change blocks the write", async () => {
  for (const secondRead of [false, true]) {
    const f = fixture(), snapshot = await f.list();
    const mutate = () => { f.state.keyboard.plugin_example_toggle = "Alt+F11"; };
    if (secondRead) f.state.onRead = (count) => { if (count === 3) mutate(); }; else mutate();
    const result = await f.run("keyboard.update", updateArgs(snapshot.revision));
    assert.equal(result.error.code, "SP_KEYBOARD_CONFLICT"); assert.equal(f.state.attempts, 0); assert.notEqual(result.outcomeUnknown, true);
  }
});

for (const [name, binding] of [["application", "ctrl+f"], ["task", "D"], ["global", "Ctrl+Shift+X"], ["plugin", "Alt+F10"]]) {
  test(`new ${name} shortcut collision requires explicit consent`, async () => {
    const f = fixture(), snapshot = await f.list(), result = await f.run("keyboard.update", updateArgs(snapshot.revision, { addNewTask: binding }));
    assert.equal(result.error.code, "SP_KEYBOARD_BINDING_CONFLICT"); assert.equal(f.state.attempts, 0); assert.notEqual(result.outcomeUnknown, true);
  });
}

test("global Electron aliases and legacy ignored app modifiers are conservatively detected", () => {
  for (const [field, legacy, next] of [["globalShowHide", "Control+X", "Ctrl+X"], ["globalShowHide", "CmdOrCtrl+X", "Meta+X"], ["globalShowHide", "CommandOrControl+X", "Ctrl+X"], ["globalShowHide", "Command+Option+Plus", "Alt+Meta++"], ["taskToggleDone", "Cmd+X", "X"], ["plugin_legacy", "Mod+X", "X"]]) {
    const before = { addNewTask: "A", [field]: legacy }, updates = { addNewTask: next };
    assert.equal(findKeyboardConflicts(before, { ...before, ...updates }, updates).length, 1, `${field}:${legacy}`);
  }
});

test("legacy embedded ++ and trailing separators follow the actual SP parser without loosening new inputs", async () => {
  for (const [legacy, next] of [["Ctrl++K", "Ctrl++"], ["ctrl++shift+k", "Ctrl+Shift++"], ["Ctrl+K+", "Ctrl+K"], ["++", "+"]]) {
    const f = fixture(); f.state.keyboard.plugin_example_toggle = legacy; const snapshot = await f.list();
    const result = await f.run("keyboard.update", updateArgs(snapshot.revision, { addNewTask: next }));
    assert.equal(result.error.code, "SP_KEYBOARD_BINDING_CONFLICT", legacy); assert.equal(f.state.attempts, 0);
    assert.throws(() => normalizeKeyboardShortcut("addNewTask", legacy), { code: "SP_BAD_INPUT" });
  }
});

test("introducing ? Help requires explicit layout-risk consent and returns a fixed warning, not an invented conflict", async () => {
  for (const existing of [null, "Ctrl+H", undefined]) {
    const f = fixture(); f.state.keyboard.showHelp = existing; f.state.keyboard.plugin_example_toggle = "Shift+/";
    const snapshot = await f.list(), args = updateArgs(snapshot.revision, { showHelp: "?" });
    const rejected = await f.run("keyboard.update", args);
    assert.equal(rejected.error.code, "SP_KEYBOARD_BINDING_CONFLICT"); assert.match(rejected.error.message, /keyboard-layout-dependent/);
    assert.equal(f.state.attempts, 0); assert.notEqual(rejected.outcomeUnknown, true);
    const accepted = await f.run("keyboard.update", { ...args, allowConflicts: true });
    assert.equal(accepted.ok, true, JSON.stringify(accepted)); assert.equal(accepted.data.settings.showHelp, "?");
    assert.deepEqual(accepted.data.warnings, ["help-layout-dependent"]); assert.deepEqual(accepted.data.conflicts, []);
    assert.equal(f.state.keyboard.plugin_example_toggle, "Shift+/"); assert.equal(f.state.attempts, 1);
  }
});

test("preserving existing ? never requires new consent for no-op or unrelated changes", async () => {
  const f = fixture(), first = await f.list();
  const unchanged = await f.run("keyboard.update", updateArgs(first.revision, { showHelp: "?" }));
  assert.equal(unchanged.ok, true); assert.equal(unchanged.data.unchanged, true); assert.equal(unchanged.data.warnings, undefined);
  const changed = await f.run("keyboard.update", updateArgs(first.revision, { showHelp: "?", addNewTask: "Ctrl+Alt+F12" }));
  assert.equal(changed.ok, true); assert.equal(changed.data.warnings, undefined); assert.equal(f.state.attempts, 1);
});

test("preexisting duplicate pairs survive unrelated or case-only changes, not a new common chord", async () => {
  const f = fixture(), snapshot = await f.list();
  const result = await f.run("keyboard.update", updateArgs(snapshot.revision));
  assert.equal(result.ok, true); assert.deepEqual(result.data.conflicts, []);
  assert.equal(f.state.keyboard.goToTimeline, "Shift+T"); assert.equal(f.state.keyboard.taskScheduleToday, "Shift+T");
  const before = { goToTimeline: "shift+t", taskScheduleToday: "Shift+T" }, updates = { goToTimeline: "Shift+T" };
  assert.deepEqual(findKeyboardConflicts(before, { ...before, ...updates }, updates), []);
  const newUpdates = { goToTimeline: "Ctrl+F8", taskScheduleToday: "Ctrl+F8" };
  assert.equal(findKeyboardConflicts(before, { ...before, ...newUpdates }, newUpdates).length, 1);
});

test("explicit allowConflicts accepts a duplicate without relocating other shortcuts or returning values", async () => {
  const f = fixture(), snapshot = await f.list(), before = clone(f.state.keyboard);
  const result = await f.run("keyboard.update", { ...updateArgs(snapshot.revision, { addNewTask: "Alt+F10" }), allowConflicts: true });
  assert.equal(result.ok, true); assert.deepEqual(result.data.conflicts, [{ keys: ["addNewTask", "plugin_example_toggle"] }]);
  assert.equal(f.state.keyboard.plugin_example_toggle, before.plugin_example_toggle);
  for (const key of Object.keys(before).filter((key) => key !== "addNewTask")) assert.equal(f.state.keyboard[key], before[key]);
});

test("invalid snapshots and absent public methods fail before attempted mutation", async () => {
  for (const value of [null, [], "bad", { addNewTask: 1 }, { plugin_x: {} }, { hidden: false }]) {
    const f = fixture(); f.state.keyboard = value;
    const result = await f.run("keyboard.list", {}); assert.equal(result.error.code, "SP_KEYBOARD_UNSUPPORTED"); assert.equal(f.state.attempts, 0);
  }
  for (const method of ["getAppState", "dispatchAction"]) {
    const f = fixture(), snapshot = await f.list(); delete f.api[method];
    const result = await f.run("keyboard.update", updateArgs(snapshot.revision));
    assert.equal(result.error.code, "SP_KEYBOARD_UNSUPPORTED"); assert.equal(f.state.attempts, 0);
  }
});

test("missing or broken SHA-256 fails closed without using a weak fallback", async () => {
  for (const crypto of [undefined, {}, { subtle: { digest: async () => { throw new Error(marker); } } }, { subtle: { digest: async () => new Uint8Array(31) } }]) await withCrypto(crypto, async () => {
    const f = fixture(), result = await f.run("keyboard.update", updateArgs());
    assert.equal(result.error.code, "SP_KEYBOARD_UNSUPPORTED"); assert.equal(f.state.attempts, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEYBOARD_SENTINEL/);
  });
  await withCrypto(webcrypto, async () => { assert.equal((await fixture().list()).revision.length, 64); });
});

test("read failures are unknown only after attempted write", async () => {
  for (const read of [2, 3, 4]) {
    const f = fixture(), snapshot = await f.list(); f.state.errorAtRead = read;
    const result = await f.run("keyboard.update", updateArgs(snapshot.revision));
    assert.equal(result.error.code, "SP_KEYBOARD_READ_FAILED"); assert.equal(result.outcomeUnknown === true, read === 4);
    assert.equal(f.state.attempts, read === 4 ? 1 : 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEYBOARD_SENTINEL/);
  }
});

test("a lost write reply is not retried; subsequent get discovers applied configuration", async () => {
  const f = fixture(), snapshot = await f.list(); f.state.replyLost = true;
  const result = await f.run("keyboard.update", updateArgs(snapshot.revision));
  assert.equal(result.error.code, "SP_PLUGIN_ERROR"); assert.equal(result.outcomeUnknown, true); assert.equal(f.state.writes.length, 1);
  assert.equal((await f.list()).settings.addNewTask, "Ctrl+Alt+F12"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEYBOARD_SENTINEL/);
});

test("readback detects ignored writes and hidden global/plugin/unknown corruption, with no repair retry", async () => {
  for (const kind of ["ignored", "global", "plugin", "unknown"]) {
    const f = fixture(), snapshot = await f.list();
    if (kind === "ignored") f.state.ignoreWrite = true;
    else f.state.afterWrite = () => { f.state.keyboard[kind === "global" ? "globalShowHide" : kind === "plugin" ? "plugin_example_toggle" : "unknownLegacy"] = null; };
    const result = await f.run("keyboard.update", updateArgs(snapshot.revision));
    assert.equal(result.error.code, "SP_VERIFY_FAILED"); assert.equal(result.outcomeUnknown, true); assert.equal(f.state.writes.length, 1);
  }
});

test("cancellation immediately before dispatch never mutates settings", async () => {
  const f = fixture(), snapshot = await f.list(); f.state.onRead = (read) => { if (read === 3) f.state.cancelled = true; };
  const result = await f.run("keyboard.update", updateArgs(snapshot.revision));
  assert.equal(result.error.code, "SP_COMMAND_CANCELLED"); assert.notEqual(result.outcomeUnknown, true); assert.equal(f.state.writes.length, 0);
});

async function toolFixture() {
  const f = fixture(), tools = new Map();
  Object.assign(f.state, { status: { available: true, enabled: true, running: true, connected: true, protocol: 1, pluginVersion: "0.5.0" }, statusReads: 0, bridgeCalls: [], bridgeResult: null, bridgeError: null, statusError: false, noticeReads: 0 });
  const sdk = {
    tools: { register: async (definition) => { tools.set(definition.name, definition); } },
    config: { getAll: async () => ({ baseUrl: "http://sp.invalid", accessToken: "fixture-token" }) },
    network: { fetch: async (url) => { assert.equal(new URL(url).origin, "http://sp.invalid"); f.state.noticeReads++; return new Response(JSON.stringify({ ok: true, data: url.endsWith("/tasks") ? [{ id: "a", title: "Active", isDone: false }] : null })); } },
  };
  const bridge = {
    status: async () => { f.state.statusReads++; if (f.state.statusError) throw new Error(marker); return clone(f.state.status); },
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
  await registerKeyboardTools(sdk, { bridge, guard, ok: (data) => ({ ok: true, ...data }) });
  return { ...f, sdk, tools, call: (args) => tools.get("sp_tasks_keyboard").execute(args) };
}

test("registers one closed-schema app-only keyboard tool gated to plugin 0.5.0", async () => {
  const f = await toolFixture(), definition = f.tools.get("sp_tasks_keyboard");
  assert.deepEqual([...f.tools.keys()], ["sp_tasks_keyboard"]); assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(definition.parameters.properties.action.enum, ["get", "update"]);
  assert.equal(definition.parameters.properties.updates.additionalProperties, false);
  assert.deepEqual(Object.keys(definition.parameters.properties.updates.properties), KEYBOARD_APP_KEYS);
  assert.equal(KEYBOARD_CAPABILITIES[0].minimumPluginVersion, "0.5.0");
});

test("real registered handler strips host context, normalizes updates and never forwards credentials", async () => {
  const f = await toolFixture();
  const snapshot = await f.call(Object.freeze({ action: "get", context: Object.freeze({ callToken: marker }) }));
  const input = Object.freeze({ action: "update", expectedRevision: snapshot.revision, updates: Object.freeze({ addNewTask: "alt+ctrl+f12" }), context: Object.freeze({ sessionPath: marker, callToken: marker }) });
  const result = await f.call(input); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.settings.addNewTask, "Ctrl+Alt+F12");
  assert.deepEqual(f.state.bridgeCalls[1], { op: "keyboard.update", args: updateArgs(snapshot.revision) });
  assert.equal(input.context.callToken, marker); assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(f.state.bridgeCalls), /PRIVATE_KEYBOARD_SENTINEL/);
});

for (const args of [null, [], {}, { action: "press" }, { action: "get", foo: marker }, { action: "get", callToken: marker }, { action: "get", updates: { addNewTask: "A" } }, { action: "update", ...updateArgs(), updates: { globalAddTask: null } }]) {
  test(`tool rejects bad input ${JSON.stringify(args)} before bridge access`, async () => {
    const f = await toolFixture(), result = await f.call(args);
    assert.equal(result.code, "SP_BAD_INPUT"); assert.equal(f.state.statusReads, 0); assert.equal(f.state.bridgeCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEYBOARD_SENTINEL/);
    if (args?.foo) assert.match(result.message, /foo/); if (args?.callToken) assert.match(result.message, /callToken/);
  });
}

for (const status of [{ enabled: false }, { running: false }, { connected: false }, { available: false }, { accepting: false }, { stopping: true }, { protocol: 2 }, { error: { token: marker } }, { pluginVersion: "0.4.0" }, { pluginVersion: "0.5.0-beta.1" }, { pluginVersion: "unknown" }]) {
  test(`tool gates unusable bridge ${JSON.stringify(status)}`, async () => {
    const f = await toolFixture(); Object.assign(f.state.status, status);
    const result = await f.call({ action: "get" }); assert.match(result.code, /^SP_BRIDGE_(?:NOT_CONNECTED|UPGRADE_REQUIRED)$/);
    assert.equal(f.state.bridgeCalls.length, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEYBOARD_SENTINEL/);
  });
}

test("future stable plugin versions remain supported and status exceptions are sanitized", async () => {
  const f = await toolFixture(); f.state.status.pluginVersion = "1.0.0+build.1";
  assert.equal((await f.call({ action: "get" })).ok, true);
  f.state.statusError = true; const error = await f.call({ action: "get" });
  assert.equal(error.code, "SP_BRIDGE_UNAVAILABLE"); assert.doesNotMatch(JSON.stringify(error), /PRIVATE_KEYBOARD_SENTINEL/);
});

test("tool verifies complete read settings and strips unrelated bridge payload fields", async () => {
  const f = await toolFixture(), snapshot = await f.list();
  f.state.bridgeResult = () => ({ ...snapshot, privateToken: marker, settings: { ...snapshot.settings, globalShowHide: marker, plugin_secret: marker } });
  const result = await f.call({ action: "get" }); assert.equal(result.ok, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEYBOARD_SENTINEL|globalShowHide|plugin_secret/);
  for (const corrupt of [null, {}, { ...snapshot, revision: "invalid" }, { ...snapshot, settings: {} }, { ...snapshot, settings: { ...snapshot.settings, addNewTask: 1 } }, { ...snapshot, settings: { ...snapshot.settings, addNewTask: undefined } }]) {
    f.state.bridgeResult = () => corrupt; const bad = await f.call({ action: "get" });
    assert.equal(bad.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(bad.outcomeUnknown, false);
  }
});

test("tool rejects incomplete, inconsistent, wrong-target and unaccepted-conflict write acknowledgements", async () => {
  const f = await toolFixture(), before = await f.list(), applied = await f.run("keyboard.update", updateArgs(before.revision)), good = applied.data;
  for (const corrupt of [null, {}, { ...good, unchanged: true }, { ...good, unchanged: undefined }, { ...good, verification: undefined }, { ...good, revision: before.revision }, { ...good, settings: { ...good.settings, addNewTask: "Wrong" } }, { ...good, conflicts: undefined }, { ...good, conflicts: [{}] }, { ...good, conflicts: [{ keys: ["addNewTask", "addNewTask"] }] }, { ...good, conflicts: [{ keys: ["unknown1", "unknown2"] }] }, { ...good, conflicts: [{ keys: ["addNewTask", "globalShowHide"] }] }]) {
    f.state.bridgeResult = () => corrupt; const result = await f.call({ action: "update", ...updateArgs(before.revision) });
    assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE", JSON.stringify(corrupt)); assert.equal(result.outcomeUnknown, true);
  }
});

test("conflict errors never echo arbitrary bridge messages or dynamic names, even in a forged envelope", async () => {
  const f = await toolFixture();
  for (const message of [marker, `Shortcut conflicts between fields: addNewTask, ${marker}, plugin_${marker}, globalShowHide. Use allowConflicts:true only to accept these conflicts.`, `Shortcut conflicts between fields: addNewTask. Use allowConflicts:true only to accept these conflicts. ${marker}`]) {
    f.state.bridgeError = Object.assign(new Error(message), { code: "SP_KEYBOARD_BINDING_CONFLICT" });
    const result = await f.call({ action: "update", ...updateArgs() });
    assert.equal(result.code, "SP_KEYBOARD_BINDING_CONFLICT"); assert.equal(result.outcomeUnknown, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEYBOARD_SENTINEL|plugin_/);
    if (message.includes(`addNewTask, ${marker}`)) { assert.match(result.message, /addNewTask/); assert.match(result.message, /globalShowHide/); }
  }
});

test("successful conflict projections expose static field names but never external binding names or metadata", async () => {
  const f = await toolFixture(); f.state.keyboard[`plugin_${marker}`] = "Alt+F12";
  const before = await f.call({ action: "get" });
  const result = await f.call({ action: "update", ...updateArgs(before.revision, { addNewTask: "Alt+F12" }), allowConflicts: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.conflicts, [{ keys: ["addNewTask", "external-binding"] }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEYBOARD_SENTINEL|plugin_/);
  const good = { settings: result.settings, revision: result.revision, unchanged: false, verification: "applied-state", conflicts: [{ keys: ["addNewTask", marker], private: marker }, { keys: ["globalShowHide", "addNewTask"] }] };
  f.state.bridgeResult = () => good;
  const forged = await f.call({ action: "update", ...updateArgs(before.revision, { addNewTask: "Alt+F12" }), allowConflicts: true });
  assert.equal(forged.ok, true);
  assert.deepEqual(forged.conflicts, [{ keys: ["addNewTask", "external-binding"] }, { keys: ["globalShowHide", "addNewTask"] }]);
  assert.doesNotMatch(JSON.stringify(forged), /PRIVATE_KEYBOARD_SENTINEL|private/);
});

test("tool exposes fixed Help-layout guidance and warnings, rejects arbitrary warning payloads", async () => {
  const f = await toolFixture(); f.state.keyboard.showHelp = null; const snapshot = await f.call({ action: "get" });
  const args = { action: "update", ...updateArgs(snapshot.revision, { showHelp: "?" }) };
  const rejected = await f.call(args);
  assert.equal(rejected.code, "SP_KEYBOARD_BINDING_CONFLICT"); assert.match(rejected.message, /AltGr/); assert.equal(f.state.attempts, 0);
  const accepted = await f.call({ ...args, allowConflicts: true });
  assert.equal(accepted.ok, true); assert.deepEqual(accepted.warnings, ["help-layout-dependent"]); assert.deepEqual(accepted.conflicts, []);
  for (const warnings of [[marker], ["help-layout-dependent", marker], marker, [], { message: marker }]) {
    f.state.bridgeResult = () => ({ ...accepted, warnings });
    const bad = await f.call({ ...args, allowConflicts: true });
    assert.equal(bad.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(bad.outcomeUnknown, true); assert.doesNotMatch(JSON.stringify(bad), /PRIVATE_KEYBOARD_SENTINEL/);
  }
});

test("transport failures keep certainty and code but sanitize message and invalid error codes", async () => {
  const f = await toolFixture();
  for (const code of ["SP_BRIDGE_TIMEOUT", "SP_KEYBOARD_CONFLICT", marker]) {
    f.state.bridgeError = Object.assign(new Error(marker), { code, outcomeUnknown: true });
    const result = await f.call({ action: "update", ...updateArgs() });
    assert.equal(result.outcomeUnknown, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEYBOARD_SENTINEL/);
  }
  assert.equal(f.state.bridgeCalls.length, 3); assert.equal(f.state.writes.length, 0);
});

test("attempted updates invalidate notice cache even after transport failure; reads do not", async () => {
  resetNoticeCache();
  try {
    const f = await toolFixture(); await readNotice(f.sdk); const reads = f.state.noticeReads;
    await f.call({ action: "get" }); await readNotice(f.sdk); assert.equal(f.state.noticeReads, reads);
    f.state.bridgeError = Object.assign(new Error(marker), { code: "SP_BRIDGE_TIMEOUT", outcomeUnknown: true });
    await f.call({ action: "update", ...updateArgs() }); await readNotice(f.sdk); assert.ok(f.state.noticeReads > reads);
  } finally { resetNoticeCache(); }
});

test("real protocol and serialized executor retain validation, conflict, cancellation and unknown outcomes", async () => {
  const { validateCommand } = await import("../../sp-tasks/lib/bridge-protocol.js");
  const { createCommandExecutor } = await import("../../sp-hana-bridge/src/companion.mjs");
  const f = fixture(), execute = createCommandExecutor(f.api);
  assert.equal(validateCommand("keyboard.list", {}).op, "keyboard.list");
  assert.throws(() => validateCommand("keyboard.list", { callToken: marker }), (error) => error.code === "SP_BRIDGE_BAD_INPUT" && /callToken/.test(error.message) && !error.message.includes(marker));
  const listed = await execute("keyboard.list", {}), args = updateArgs(listed.data.revision);
  assert.equal(validateCommand("keyboard.update", args).op, "keyboard.update");
  const [updated, stale] = await Promise.all([execute("keyboard.update", args), execute("keyboard.update", args)]);
  assert.equal(updated.ok, true); assert.equal(stale.error.code, "SP_KEYBOARD_CONFLICT"); assert.notEqual(stale.outcomeUnknown, true); assert.equal(f.state.writes.length, 1);
  const next = updateArgs(updated.data.revision, { addNewTask: "Ctrl+Alt+F11" });
  const cancelled = await execute("keyboard.update", next, () => true);
  assert.equal(cancelled.error.code, "SP_COMMAND_CANCELLED"); assert.notEqual(cancelled.outcomeUnknown, true); assert.equal(f.state.writes.length, 1);
  f.state.onRead = (read) => { if (read === f.state.cancelAt) f.state.cancelled = true; }; f.state.cancelAt = f.state.reads + 2;
  const beforeMutation = await execute("keyboard.update", next, () => f.state.cancelled);
  assert.equal(beforeMutation.error.code, "SP_COMMAND_CANCELLED"); assert.equal(f.state.writes.length, 1);
  f.state.cancelled = false; f.state.onRead = null; f.state.ignoreWrite = true;
  const unknown = await execute("keyboard.update", next);
  assert.equal(unknown.error.code, "SP_VERIFY_FAILED"); assert.equal(unknown.outcomeUnknown, true); assert.equal(f.state.writes.length, 2);
});

test("actual loadPluginSources bundle executes keyboard get/update in memory without global pollution", async () => {
  const { loadPluginSources, createPluginCode } = await import("../../sp-hana-bridge/scripts/build.mjs");
  const sources = await loadPluginSources(), code = createPluginCode(sources);
  assert.equal(typeof sources.keyboardContract, "string"); assert.equal(typeof sources.keyboard, "string");
  assert.doesNotMatch(code, /^\s*(?:import|export)\b/m); assert.doesNotMatch(code, /node:|require\s*\(/);
  assert.equal(code.split("installCompanion(PluginAPI);").length, 2);
  const globalsBefore = Object.getOwnPropertyNames(globalThis), f = fixture(); let execute;
  // Capture the real bundled executor instead of starting timers or HTTP.
  new Function("PluginAPI", code.replace("installCompanion(PluginAPI);", "PluginAPI.capture(createCommandExecutor(PluginAPI));"))({ ...f.api, capture: (value) => { execute = value; } });
  const listed = await execute("keyboard.list", {}); assert.equal(listed.ok, true);
  const updated = await execute("keyboard.update", updateArgs(listed.data.revision));
  assert.equal(updated.ok, true, JSON.stringify(updated)); assert.equal(updated.data.settings.addNewTask, "Ctrl+Alt+F12");
  assert.equal(f.state.writes.length, 1); assert.equal(f.state.writes[0].sectionCfg.globalShowHide, "Ctrl+Shift+X");
  assert.deepEqual(Object.getOwnPropertyNames(globalThis), globalsBefore);
});

test("normalized bindings match real SP 19.3.1 checkKeyCombo and help handlers when source fixture exists", async (t) => {
  const root = new URL("../../_probe/sp-api-19.3.1/", import.meta.url);
  let source, shortcutSource, model;
  try {
    [source, shortcutSource, model] = await Promise.all([
      readFile(new URL("src__app__util__check-key-combo.ts", root), "utf8"),
      readFile(new URL("src__app__core-ui__shortcut__shortcut.service.ts", root), "utf8"),
      readFile(new URL("electron__shared-with-frontend__keyboard-config.model.ts", root), "utf8"),
    ]);
  } catch (error) { if (error.code === "ENOENT") { t.skip("Optional extracted SP 19.3.1 source fixture not present"); return; } throw error; }
  const publicKeys = [...model.matchAll(/^  ([A-Za-z]+)\?: string \| null;/gm)].map((match) => match[1]);
  assert.deepEqual(publicKeys.filter((key) => !KEYBOARD_GLOBAL_KEYS.includes(key)).sort(), [...KEYBOARD_APP_KEYS].sort());
  const help = shortcutSource.slice(shortcutSource.indexOf("export const isHelpKeyCombo"), shortcutSource.indexOf("@Injectable"));
  const combined = source.replace(/^import \{[\s\S]*?\} from '[^']+';\r?\n/, "").replace(/^export type \{[^}]+\};\r?\n/m, "") + "\n" + help;
  const js = stripTypeScriptTypes(combined);
  const upstream = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  const bindings = [["a", "KeyA"], ["Ctrl+A", "KeyA"], ["shift+ctrl+1", "Digit1"], ["+", "Equal"], ["Ctrl++", "Equal"], ["Meta+Shift+-", "Minus"], ["Alt+ArrowUp", "ArrowUp"], ["Ctrl+F24", "F24"], ["Ctrl+Space", "Space"], ["Enter", "Enter"], ["Alt+Shift+Meta+Ctrl+Delete", "Delete"]];
  for (const [value, code] of bindings) {
    const normalized = normalizeKeyboardShortcut("addNewTask", value);
    const event = { code, ctrlKey: normalized.includes("Ctrl+"), altKey: normalized.includes("Alt+"), shiftKey: normalized.includes("Shift+"), metaKey: normalized.includes("Meta+") };
    assert.equal(upstream.checkKeyCombo(event, normalized), true, normalized);
    assert.equal(upstream.checkKeyCombo({ ...event, ctrlKey: !event.ctrlKey }, normalized), false, normalized);
  }
  assert.equal(upstream.isHelpKeyCombo({ key: "?", code: "Slash", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, getModifierState: () => false }, "?"), true);
  assert.equal(upstream.isHelpKeyCombo({ key: "?", code: "KeyQ", shiftKey: false, ctrlKey: true, metaKey: false, altKey: true, getModifierState: () => true }, "?"), true);
  const plusEvent = { code: "Equal", ctrlKey: true, shiftKey: false, metaKey: false, altKey: false };
  assert.equal(upstream.checkKeyCombo(plusEvent, "Ctrl++K"), true);
  const legacyBefore = { plugin_example: "Ctrl++K", addNewTask: "A" }, plusUpdate = { addNewTask: "Ctrl++" };
  assert.equal(findKeyboardConflicts(legacyBefore, { ...legacyBefore, ...plusUpdate }, plusUpdate).length, 1);
  upstream.userKbLayout.set("Slash", "/");
  const question = { key: "?", code: "Slash", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, getModifierState: () => false };
  assert.equal(upstream.isHelpKeyCombo(question, "?"), true); assert.equal(upstream.checkKeyCombo(question, "Shift+/"), true);
});
