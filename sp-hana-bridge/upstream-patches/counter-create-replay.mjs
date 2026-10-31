import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { stripTypeScriptTypes } from "node:module";

globalThis.fetch = async () => { throw new Error("Network is forbidden in the upstream replay test"); };
const clone = (value) => structuredClone(value);
const paths = {
  bridge: "src/app/plugins/plugin-bridge.service.ts",
  model: "src/app/features/simple-counter/simple-counter.model.ts",
  constants: "src/app/features/simple-counter/simple-counter.const.ts",
  actions: "src/app/features/simple-counter/store/simple-counter.actions.ts",
  reducer: "src/app/features/simple-counter/store/simple-counter.reducer.ts",
  persistent: "src/app/op-log/core/persistent-action.interface.ts",
  capture: "src/app/op-log/capture/operation-log.effects.ts",
  converter: "src/app/op-log/apply/operation-converter.util.ts",
  syncTypes: "packages/sync-core/src/operation.types.ts",
};

async function readSources() {
  if (process.env.SP_UPSTREAM_SOURCE_DIR) {
    const root = resolve(process.env.SP_UPSTREAM_SOURCE_DIR);
    const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => {
      const absolute = resolve(root, path);
      assert.ok(absolute.startsWith(root + sep));
      return [key, await readFile(absolute, "utf8")];
    }));
    return Object.fromEntries(entries);
  }
  if (!process.env.SP_UPSTREAM_ASAR) throw new Error("Set SP_UPSTREAM_SOURCE_DIR to an official SP checkout or SP_UPSTREAM_ASAR to a read-only installed ASAR with source maps.");
  const file = await open(resolve(process.env.SP_UPSTREAM_ASAR), "r");
  try {
    const prefix = Buffer.alloc(16);
    await file.read(prefix, 0, prefix.length, 0);
    const jsonLength = prefix.readUInt32LE(12), payloadOffset = 8 + prefix.readUInt32LE(4);
    assert.ok(jsonLength > 0 && jsonLength < 32 * 1048576, "Unexpected ASAR header size");
    const header = Buffer.alloc(jsonLength);
    await file.read(header, 0, header.length, 16);
    let browser = JSON.parse(header.toString("utf8"));
    for (const part of [".tmp", "angular-dist", "browser"]) browser = browser.files[part];
    const sources = {};
    for (const [name, entry] of Object.entries(browser.files)) {
      if (!name.endsWith(".js.map") || entry.unpacked) continue;
      assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size < 128 * 1048576);
      const offset = Number(entry.offset);
      assert.ok(Number.isSafeInteger(offset) && offset >= 0);
      const bytes = Buffer.alloc(entry.size);
      await file.read(bytes, 0, bytes.length, payloadOffset + offset);
      const map = JSON.parse(bytes.toString("utf8"));
      for (let index = 0; index < map.sources.length; index++) {
        for (const [key, path] of Object.entries(paths)) {
          if (map.sources[index].endsWith("/" + path)) {
            const source = map.sourcesContent?.[index];
            assert.equal(typeof source, "string", `Missing embedded source: ${path}`);
            if (sources[key] !== undefined) assert.equal(sources[key], source, `Inconsistent source-map copies: ${path}`);
            sources[key] = source;
          }
        }
      }
    }
    for (const key of Object.keys(paths)) assert.equal(typeof sources[key], "string", `Source not present: ${paths[key]}`);
    return sources;
  } finally { await file.close(); }
}

const sources = await readSources();
const patch = await readFile(new URL("./0001-persist-plugin-counter-creation.patch", import.meta.url), "utf8");

function applyPatchInMemory(source, diff) {
  const lines = source.replace(/\r\n/g, "\n").split("\n"), result = [], patchLines = diff.replace(/\r\n/g, "\n").split("\n");
  assert.equal(patchLines[0], `--- a/${paths.bridge}`);
  assert.equal(patchLines[1], `+++ b/${paths.bridge}`);
  let cursor = 0, hunks = 0;
  for (let index = 2; index < patchLines.length;) {
    if (!patchLines[index]) { index++; continue; }
    const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(patchLines[index++]);
    assert.ok(hunk, "Only exact single-file unified hunks are accepted");
    const start = Number(hunk[1]) - 1;
    assert.ok(start >= cursor);
    result.push(...lines.slice(cursor, start)); cursor = start;
    let removed = 0, added = 0;
    while (index < patchLines.length && !patchLines[index].startsWith("@@ ") && patchLines[index] !== "") {
      const line = patchLines[index++], kind = line[0], value = line.slice(1);
      assert.ok([" ", "+", "-"].includes(kind), "Unexpected patch content");
      if (kind !== "+") { assert.equal(lines[cursor++], value, "Patch context must match the official source"); removed++; }
      if (kind !== "-") { result.push(value); added++; }
    }
    assert.equal(removed, Number(hunk[2])); assert.equal(added, Number(hunk[4])); hunks++;
  }
  assert.equal(hunks, 2);
  result.push(...lines.slice(cursor));
  return result.join("\n");
}
const patchedBridge = applyPatchInMemory(sources.bridge, patch);

function evaluate(source, exported, dependencies = {}) {
  const clean = source.replace(/^import\s[\s\S]*?;\r?\n/gm, "")
    .replace(/^export type \{[\s\S]*?;\r?\n/gm, "")
    .replace(/^export \{[\s\S]*?;\r?\n/gm, "")
    .replace(/^export /gm, "");
  const js = stripTypeScriptTypes(clean, { mode: "transform" });
  return new Function(...Object.keys(dependencies), js + `\nreturn { ${exported.join(", ")} };`)(...Object.values(dependencies));
}
const { SimpleCounterType } = evaluate(sources.model, ["SimpleCounterType"]);
const { EMPTY_SIMPLE_COUNTER } = evaluate(sources.constants, ["EMPTY_SIMPLE_COUNTER"], { SimpleCounterType });
const syncTypes = evaluate(sources.syncTypes, ["OpType", "extractActionPayload", "isLwwUpdatePayload"]);
function createAction(type, creator) {
  const action = (args) => ({ ...(typeof creator === "function" ? creator(args) : args), type });
  action.type = type;
  return action;
}
const actionNames = [...sources.actions.matchAll(/^export const (\w+)/gm)].map((match) => match[1]);
const actions = evaluate(sources.actions, actionNames, { createAction, props: () => null, OpType: syncTypes.OpType });
const { isPersistentAction } = evaluate(sources.persistent, ["isPersistentAction"]);

function entityAdapter() {
  const adapter = {
    getInitialState: (extra = {}) => ({ ids: [], entities: {}, ...extra }),
    getSelectors: () => ({ selectIds: (state) => state.ids, selectEntities: (state) => state.entities, selectAll: (state) => state.ids.map((id) => state.entities[id]), selectTotal: (state) => state.ids.length }),
    addOne: (row, state) => Object.hasOwn(state.entities, row.id) ? state : { ...state, ids: [...state.ids, row.id], entities: { ...state.entities, [row.id]: clone(row) } },
    updateOne: ({ id, changes }, state) => Object.hasOwn(state.entities, id) ? { ...state, entities: { ...state.entities, [id]: { ...state.entities[id], ...clone(changes) } } } : state,
    removeOne: (id, state) => { const entities = { ...state.entities }; delete entities[id]; return { ...state, ids: state.ids.filter((value) => value !== id), entities }; },
  };
  adapter.upsertOne = (row, state) => Object.hasOwn(state.entities, row.id) ? adapter.updateOne({ id: row.id, changes: row }, state) : adapter.addOne(row, state);
  adapter.upsertMany = (rows, state) => rows.reduce((next, row) => adapter.upsertOne(row, next), state);
  adapter.updateMany = (rows, state) => rows.reduce((next, row) => adapter.updateOne(row, next), state);
  adapter.removeMany = (ids, state) => ids.reduce((next, id) => adapter.removeOne(id, next), state);
  return adapter;
}
const { simpleCounterReducer } = evaluate(sources.reducer, ["simpleCounterReducer"], {
  ...actions, SimpleCounterType, DEFAULT_SIMPLE_COUNTERS: [], createEntityAdapter: entityAdapter,
  arrayToDictionary: (rows) => Object.fromEntries(rows.map((row) => [row.id, row])),
  updateAllInDictionary: (rows, changes) => Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, { ...row, ...changes }])),
  loadAllData: createAction("[Fixture] Load All Data"),
  createFeatureSelector: (name) => (state) => state[name],
  createSelector: (...items) => (state) => items.at(-1)(...items.slice(0, -1).map((selector) => selector(state))),
  on: (...items) => ({ types: items.slice(0, -1).map((action) => action.type), reduce: items.at(-1) }),
  createReducer: (initial, ...handlers) => (state = initial, action) => handlers.reduce((current, handler) => handler.types.includes(action.type) ? handler.reduce(current, action) : current, state),
});

const unused = () => { throw new Error("An unrelated replay branch was unexpectedly reached"); };
const { convertOpToAction } = evaluate(sources.converter, ["convertOpToAction"], {
  ...syncTypes,
  ActionType: new Proxy({}, { get: (_target, key) => `unused:${String(key)}` }),
  FULL_STATE_OP_TYPES: new Set(["SYNC_IMPORT", "BACKUP_IMPORT", "REPAIR"]),
  getLwwEntityType: () => undefined, isLwwPayloadIdCanonical: () => false, getEntityConfig: unused,
  ENVELOPE_SHADOWED_KEYS: ["type", "meta"], SyncLog: { warn: unused }, isValidDBDateStr: unused, applyClearedFields: unused,
});

function methodSource(source, name) {
  const start = source.indexOf(`  async ${name}(`);
  assert.ok(start >= 0, `Missing actual bridge method: ${name}`);
  const end = source.indexOf("\n  }", start);
  assert.ok(end > start);
  return source.slice(start, end + 4);
}
function createBridge(source) {
  const methods = ["setCounter", "updateSimpleCounter", "getCounter", "incrementCounter", "decrementCounter"].map((name) => methodSource(source, name)).join("\n");
  const { CounterBridge } = evaluate(`class CounterBridge {\n${methods}\n}`, ["CounterBridge"], {
    ...actions, EMPTY_SIMPLE_COUNTER, SimpleCounterType,
    getDbDateStr: () => "2026-10-31",
    pluginAssert: { string: (value) => assert.equal(typeof value, "string"), number: (value) => assert.equal(typeof value, "number") },
  });
  return CounterBridge;
}
function fixture(source, initial = { ids: [], entities: {} }) {
  const state = { live: clone(initial), operations: [], dispatched: [] };
  const api = new (createBridge(source))();
  api.getSimpleCounter = async (id) => clone(state.live.entities[id]);
  api.getAllCounters = async () => Object.fromEntries(Object.entries(state.live.entities).map(([id, row]) => [id, row.countOnDay?.["2026-10-31"] ?? 0]));
  api._store = { dispatch: (action) => {
    state.dispatched.push(clone(action));
    state.live = simpleCounterReducer(state.live, action);
    if (!isPersistentAction(action) || action.meta.isRemote) return;
    // Matches OperationLogEffects' persisted action envelope; no actual disk is used.
    const { type, meta, ...actionPayload } = action;
    state.operations.push(clone({ id: `operation-${state.operations.length}`, actionType: type, opType: meta.opType, entityType: meta.entityType, entityId: meta.entityId, payload: { actionPayload, entityChanges: [] }, clientId: "fixture", vectorClock: { fixture: 1 }, timestamp: 1793404800000, schemaVersion: 1 }));
  } };
  const replay = (snapshot = initial) => state.operations.reduce((current, operation) => simpleCounterReducer(current, convertOpToAction(clone(operation))), clone(snapshot));
  return { api, state, replay };
}

test("patch matches the reviewed official baseline and only replaces the bridge creation action", () => {
  const normalized = sources.bridge.replace(/\r\n/g, "\n");
  assert.equal(createHash("sha256").update(normalized).digest("hex"), "71df894a5ed614819670c04c0e29d7334d0d2db2fcd30bcaec758b54aad9a496");
  const expected = normalized.replace("  deleteSimpleCounter,\n", "  addSimpleCounter,\n  deleteSimpleCounter,\n")
    .replace("  upsertSimpleCounter,\n", "")
    .replace("        upsertSimpleCounter({\n", "        addSimpleCounter({\n");
  assert.equal(patchedBridge, expected);
  assert.match(sources.capture, /isPersistentAction\(action\)/);
  assert.match(sources.capture, /const \{ type, meta, \.\.\.rawActionPayload \} = action;/);
  assert.match(sources.capture, /actionPayload: actionPayload as Record<string, unknown>,\s*entityChanges,/);
});

test("unpatched API reproduces the live-only counter and update replay loss", async () => {
  const f = fixture(sources.bridge);
  await f.api.setCounter("fixture-counter", 0);
  await f.api.updateSimpleCounter("fixture-counter", { title: "Fixture title" });
  assert.equal(f.state.live.entities["fixture-counter"].title, "Fixture title");
  assert.equal(f.state.operations.length, 1);
  assert.equal(f.state.operations[0].opType, "UPD");
  assert.equal(f.replay().entities["fixture-counter"], undefined);
});

test("patched API captures a complete CRT and replays creation plus later changes from an empty snapshot", async () => {
  const f = fixture(patchedBridge);
  await f.api.setCounter("fixture-counter", 3);
  await f.api.updateSimpleCounter("fixture-counter", { title: "Fixture title", icon: "check", isHideButton: true });
  assert.equal(f.state.operations.length, 2);
  const created = f.state.operations[0];
  assert.equal(created.actionType, actions.addSimpleCounter.type);
  assert.equal(created.opType, "CRT"); assert.equal(created.entityType, "SIMPLE_COUNTER"); assert.equal(created.entityId, "fixture-counter");
  assert.deepEqual(created.payload.actionPayload.simpleCounter, { ...EMPTY_SIMPLE_COUNTER, id: "fixture-counter", title: "fixture-counter", isEnabled: true, type: "ClickCounter", countOnDay: { "2026-10-31": 3 } });
  assert.deepEqual(f.replay(), f.state.live);
  assert.equal(convertOpToAction(created).meta.isRemote, true);
});

test("existing IDs remain updates and preserve other days, settings and unrelated entities", async () => {
  const existing = { ...EMPTY_SIMPLE_COUNTER, id: "existing", title: "Existing", icon: "coffee", countOnDay: { "2026-10-30": 7, "2026-10-31": 2 } };
  const other = { ...EMPTY_SIMPLE_COUNTER, id: "other", title: "Other" };
  const initial = { ids: ["existing", "other"], entities: { existing, other } };
  const f = fixture(patchedBridge, initial);
  await f.api.setCounter("existing", 10);
  assert.deepEqual(f.state.operations.map((operation) => operation.opType), ["UPD"]);
  assert.deepEqual(f.state.live.entities.existing.countOnDay, { "2026-10-30": 7, "2026-10-31": 10 });
  assert.equal(f.state.live.entities.existing.icon, "coffee"); assert.equal(f.state.live.entities.existing.title, "Existing");
  assert.deepEqual(f.state.live.entities.other, other); assert.deepEqual(f.replay(), f.state.live);
});

test("successive calls create once, then update without duplicate IDs", async () => {
  const f = fixture(patchedBridge);
  await f.api.setCounter("fixture-counter", 0);
  await f.api.setCounter("fixture-counter", 4);
  await f.api.setCounter("fixture-counter", 4);
  assert.deepEqual(f.state.operations.map((operation) => operation.opType), ["CRT", "UPD", "UPD"]);
  assert.deepEqual(f.state.live.ids, ["fixture-counter"]); assert.deepEqual(f.replay(), f.state.live);
});

test("public increment and decrement missing-ID paths inherit the persistent creation fix", async () => {
  const f = fixture(patchedBridge);
  assert.equal(await f.api.incrementCounter("inc", 3), 3);
  assert.equal(await f.api.decrementCounter("dec", 2), 0);
  assert.deepEqual(f.state.operations.map((operation) => operation.opType), ["CRT", "CRT"]);
  assert.deepEqual(f.replay(), f.state.live);
});

test("the existing validation still refuses invalid IDs and values before any dispatch", async () => {
  for (const [id, value] of [["../counter", 1], ["counter", -1], ["counter", Infinity], ["counter", NaN]]) {
    const f = fixture(patchedBridge);
    await assert.rejects(() => f.api.setCounter(id, value));
    assert.equal(f.state.dispatched.length, 0); assert.equal(f.state.operations.length, 0);
  }
});
