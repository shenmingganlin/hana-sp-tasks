import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import app from "../../sp-tasks/index.js";
import { KEYBOARD_APP_KEYS } from "../../sp-tasks/lib/keyboard-contract.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in host-context tests"); };
const clone = (value) => structuredClone(value);
const receipt = () => ({ ready: Promise.resolve(), disposeAsync: async () => {} });
const response = (data) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
const marker = "PRIVATE_HOST_CONTEXT_SENTINEL";
const contexts = {
  model: Object.freeze({ sessionPath: `${marker}/session`, messageId: null, messageText: null, callToken: `${marker}/token` }),
  button: Object.freeze({ sessionPath: `${marker}/session`, messageId: `${marker}/message`, messageText: marker, selectionText: marker }),
  document: Object.freeze({ sessionPath: `${marker}/session`, messageId: null, messageText: null, callToken: `${marker}/token`,
    document: { context: { documentId: marker }, access: { token: marker } } }),
};
const examples = {
  sp_tasks_overview: {},
  sp_tasks_create: { title: "Memory task" },
  sp_tasks_update: { taskIds: ["task-1"], title: "Memory rename" },
  sp_tasks_search: {},
  sp_tasks_timer: { action: "status" },
  sp_tasks_log_time: { taskId: "task-1", duration: "1m" },
  sp_tasks_context: {},
  sp_tasks_get: { taskId: "task-1" },
  sp_tasks_manage: { action: "delete", taskIds: ["task-1"] },
  sp_tasks_repeat: { action: "list" },
  sp_tasks_notes: { action: "list" },
  sp_tasks_counters: { action: "list" },
  sp_tasks_bridge: {},
  sp_tasks_projects: { action: "list" },
  sp_tasks_tags: { action: "list" },
  sp_tasks_counter_config: { action: "list" },
  sp_tasks_workspace: { action: "get_selection" },
  sp_tasks_capabilities: {},
  sp_tasks_preferences: { action: "get", section: "focusMode" },
  sp_tasks_counter_control: { action: "status", counterId: "stopwatch-1" },
  sp_tasks_work_context: { action: "get" },
  sp_tasks_ui: { command: "focus.show" },
  sp_tasks_attachments: { action: "list", taskId: "task-1" },
  sp_tasks_keyboard: { action: "get" },
};

async function setup() {
  const tools = new Map();
  const requests = [], runtimeRequests = [], logs = [], results = [];
  const state = {
    tasks: [{ id: "task-1", title: "Fixture task", isDone: false, projectId: "INBOX_PROJECT", tagIds: [], subTaskIds: [], timeSpent: 0, timeSpentOnDay: {} }],
    projects: [{ id: "INBOX_PROJECT", title: "Inbox" }, { id: "project-1", title: "Work" }],
    tags: [{ id: "TODAY", title: "Today" }, { id: "tag-1", title: "Focus" }],
    repeats: [{ id: "repeat-1", taskId: "task-1", isPaused: true }],
    notes: [{ id: "note-1", content: "Fixture note", projectId: "project-1" }],
    counters: [{ id: "counter-1", title: "Fixture counter", type: "ClickCounter", icon: null, isEnabled: true, isHideButton: false, isOn: false, trackedDays: 0, countOnDay: {} },
      { id: "stopwatch-1", title: "Fixture stopwatch", type: "StopWatch", icon: null, isEnabled: true, isHideButton: false, isOn: false, trackedDays: 0, countOnDay: {} }],
    preferences: { focusMode: { focusModeSound: "off", focusModeSoundVolume: 20 } },
    workContext: { id: "INBOX_PROJECT", type: "PROJECT", title: "Inbox", taskIds: ["task-1"], localOnly: true },
    attachments: { taskId: "task-1", attachments: [{ id: "attachment-1", type: "LINK", url: "https://example.org/existing" }], revision: "a".repeat(64), totalCount: 1, otherCount: 0 },
    keyboard: { settings: Object.fromEntries(KEYBOARD_APP_KEYS.map((key) => [key, key === "addNewTask" ? "A" : null])), revision: "a".repeat(64) },
  };
  const store = new Map([["sp-bridge-v1", { protocol: 1, enabled: true, controlToken: "c".repeat(43), pluginToken: "p".repeat(43) }]]);
  const currentRuntime = { runtimeId: "memory-runtime", state: "ready", service: { id: "sp-bridge", state: "ready", port: 3877 } };
  const sdk = {
    dataDir: "memory-host-context",
    bus: { request: async () => { throw new Error("Host bus access is forbidden"); } },
    storage: { global: {
      get: async (key) => clone(store.get(key) ?? null),
      set: async (key, value) => { store.set(key, clone(value)); },
      delete: async (key) => { store.delete(key); },
      keys: async () => [...store.keys()],
    }, agent: () => ({}) },
    models: {}, media: {}, providers: {},
    logger: { info: async (...args) => { logs.push(args); }, warn: async (...args) => { logs.push(args); } },
    config: { getAll: async () => ({ baseUrl: "http://sp.invalid", accessToken: "fixture-token" }) },
    resources: { read: async () => { throw new Error("Production resource and credential reads are forbidden"); } },
    tools: { register: (definition) => { tools.set(definition.name, definition); return receipt(); } },
    hooks: { onDecision: () => receipt() },
    routes: { register: () => receipt() },
    runtime: {
      start: async () => { throw new Error("No process may be started in this fixture"); },
      stop: async () => { throw new Error("No process may be stopped in this fixture"); },
      list: async () => [clone(currentRuntime)],
      get: async () => clone(currentRuntime),
      fetch: async (runtimeId, route, init) => {
        assert.equal(runtimeId, currentRuntime.runtimeId);
        assert.equal(init.headers.Authorization, `Bearer ${"c".repeat(43)}`);
        const body = init.body === undefined ? undefined : JSON.parse(init.body);
        runtimeRequests.push({ route, method: init.method, body });
        if (route === "/internal/status") return response({ connected: true, accepting: true, pluginVersion: "0.5.0", lastSeen: 0, protocol: 1 });
        assert.equal(route, "/internal/execute");
        if (body.op === "ui.command") return response({ command: body.args.command, submitted: true, verification: "submitted" });
        if (body.op === "attachments.list") return response(state.attachments);
        if (body.op.startsWith("attachments.")) {
          assert.equal(body.args.expectedRevision, state.attachments.revision);
          const attachmentId = body.op === "attachments.add" ? "attachment-new" : body.args.attachmentId;
          if (body.op === "attachments.add") state.attachments.attachments.push({ id: attachmentId, type: "LINK", url: body.args.url, ...(Object.hasOwn(body.args, "title") ? { title: body.args.title } : {}) });
          else state.attachments.attachments = state.attachments.attachments.filter((item) => item.id !== attachmentId);
          state.attachments.totalCount = state.attachments.attachments.length;
          state.attachments.revision = "b".repeat(64);
          return response({ ...state.attachments, attachmentId, unchanged: false, verification: "applied-state" });
        }
        if (body.op === "keyboard.list") return response(state.keyboard);
        if (body.op === "keyboard.update") {
          assert.equal(body.args.expectedRevision, state.keyboard.revision);
          Object.assign(state.keyboard.settings, body.args.updates);
          state.keyboard.revision = "b".repeat(64);
          return response({ ...state.keyboard, unchanged: false, verification: "applied-state", conflicts: [] });
        }
        if (body.op.startsWith("counterControl.")) {
          const current = state.counters.find((counter) => counter.id === body.args.counterId);
          if (body.op !== "counterControl.list") current.isOn = body.op === "counterControl.start";
          const counter = Object.fromEntries(["id", "type", "isEnabled", "isOn"].map((key) => [key, current[key]]));
          return response({ counter, localOnly: true, ...(body.op !== "counterControl.list" ? { unchanged: false, verification: "applied-state" } : {}) });
        }
        if (body.op === "workContext.list") return response({ context: state.workContext });
        if (body.op === "workContext.switch") {
          state.workContext = { id: body.args.contextId, type: "PROJECT", title: "Work", taskIds: [], localOnly: true };
          return response({ context: state.workContext, unchanged: false, verification: "applied-state" });
        }
        if (body.op === "selection.list") return response({ selectedTask: null });
        if (body.op === "preferences.list") return response({ section: body.args.section, settings: state.preferences[body.args.section] });
        if (body.op === "preferences.update") {
          Object.assign(state.preferences[body.args.section], body.args.updates);
          return response({ section: body.args.section, settings: state.preferences[body.args.section], unchanged: false, verification: "applied-state" });
        }
        if (body.op === "selection.select") return response({ selectedTask: state.tasks.find((task) => task.id === body.args.taskId), unchanged: false });
        if (body.op === "counters.list") return response({ counters: state.counters });
        if (body.op.startsWith("counters.")) {
          const { counterId, ...patch } = body.args;
          const counter = state.counters.find((row) => row.id === counterId);
          assert.ok(counter);
          if (body.op === "counters.delete") {
            state.counters.splice(state.counters.indexOf(counter), 1);
            return response({ id: counterId, deleted: true, removedTrackedDays: counter.trackedDays });
          }
          assert.equal(body.op, "counters.update");
          Object.assign(counter, patch);
          return response({ counter, updated: true });
        }
        const [kind, action] = body.op.split(".");
        assert.ok(kind === "projects" || kind === "tags");
        const rows = state[kind];
        const singular = kind === "projects" ? "project" : "tag";
        if (action === "list") return response({ [kind]: rows });
        if (action === "create") {
          const row = { id: `${singular}-new`, ...body.args };
          rows.push(row);
          return response({ [singular]: row });
        }
        const idKey = `${singular}Id`;
        const row = rows.find((item) => item.id === body.args[idKey]);
        assert.ok(row);
        if (action === "delete") {
          rows.splice(rows.indexOf(row), 1);
          return response({ id: row.id, deleted: true });
        }
        assert.equal(action, "update");
        const { [idKey]: ignored, ...patch } = body.args;
        Object.assign(row, patch);
        return response({ [singular]: row });
      },
    },
    network: { fetch: async (rawUrl, init) => {
      const url = new URL(rawUrl);
      assert.equal(url.origin, "http://sp.invalid");
      assert.equal(init.headers.Authorization, "Bearer fixture-token");
      const method = init.method;
      const path = url.pathname;
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      requests.push({ method, path, query: Object.fromEntries(url.searchParams), body });
      if (path === "/projects") return response(state.projects);
      if (path === "/tags") return response(state.tags);
      if (path === "/task-control/current") return response(null);
      if (path === "/tasks") {
        if (method === "GET") return response(state.tasks);
        assert.equal(method, "POST");
        const task = { ...clone(state.tasks[0]), id: "task-new", ...body };
        state.tasks.push(task);
        return response(task);
      }
      const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
      const kind = { tasks: "tasks", "task-repeat-cfgs": "repeats", notes: "notes", "simple-counters": "counters" }[parts[0]];
      assert.ok(kind, `Unexpected route ${method} ${path}`);
      const rows = state[kind];
      if (parts.length === 1) {
        if (method === "GET") return response(rows);
        assert.equal(method, "POST");
        const row = { id: `${kind}-new`, ...body };
        rows.push(row);
        return response(row);
      }
      const row = rows.find((item) => item.id === parts[1]);
      assert.ok(row, `The fixture must contain ${parts[1]}`);
      if (method === "DELETE") {
        rows.splice(rows.indexOf(row), 1);
        return response({ id: row.id, deleted: true });
      }
      if (method !== "GET") Object.assign(row, body);
      return response(row);
    } },
  };
  await app.apply(sdk);
  // Optional bridge restoration must finish before counting handler side effects.
  await setImmediate();
  runtimeRequests.length = 0;
  const call = async (name, input) => {
    const raw = await tools.get(name).execute(input);
    results.push(raw);
    return JSON.parse(raw.content[0].text);
  };
  const assertNoContextLeak = () => {
    for (const [label, value] of Object.entries({ requests, runtimeRequests, logs, results, storage: [...store], state })) {
      assert.equal(JSON.stringify(value).includes(marker), false, `Host context leaked through ${label}`);
    }
  };
  return { tools, state, requests, runtimeRequests, call, assertNoContextLeak };
}

test("all registered schemas remain closed and never advertise host context", async () => {
  const f = await setup();
  assert.deepEqual([...f.tools.keys()].sort(), Object.keys(examples).sort());
  for (const tool of f.tools.values()) {
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
    assert.equal(Object.hasOwn(tool.parameters.properties, "context"), false, tool.name);
    assert.equal(tool.parameters.required?.includes("context") ?? false, false, tool.name);
  }
});

test("every actual handler accepts model, button and document host invocation shapes", async (t) => {
  for (const [contextName, context] of Object.entries(contexts)) {
    for (const [name, businessArgs] of Object.entries(examples)) {
      await t.test(`${contextName}: ${name}`, async () => {
        const f = await setup();
        // The host owns this input; the adapter may not delete fields in place.
        const input = Object.freeze({ ...clone(businessArgs), context });
        const before = clone(input);
        const result = await f.call(name, input);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(input, before);
        assert.equal(input.context, context);
        assert.ok(f.requests.length + f.runtimeRequests.length > 0, "The handler must reach its backend, not report a fabricated success");
        f.assertNoContextLeak();
      });
    }
  }
});

test("unknown business fields still fail before all REST and bridge operations", async (t) => {
  for (const [name, args] of Object.entries(examples)) {
    await t.test(name, async () => {
      const f = await setup();
      const result = await f.call(name, Object.freeze({ ...args, context: contexts.model, foo: "unexpected" }));
      assert.equal(result.ok, false);
      assert.equal(result.code, "SP_BAD_INPUT");
      assert.match(result.message, /foo/);
      assert.equal(f.requests.length, 0);
      assert.equal(f.runtimeRequests.length, 0);
      f.assertNoContextLeak();
    });
  }
});

test("every feature and structure write action excludes context from bodies and results", async (t) => {
  for (const [kind, args] of [
    ["repeat", { action: "create", taskId: "task-1", isPaused: true }],
    ["repeat", { action: "update", repeatCfgId: "repeat-1", isPaused: true }],
    ["repeat", { action: "delete", repeatCfgId: "repeat-1" }],
    ["notes", { action: "create", content: "Memory note", projectId: "project-1" }],
    ["notes", { action: "update", noteId: "note-1", content: "Changed note" }],
    ["notes", { action: "delete", noteId: "note-1" }],
    ["counters", { action: "set", counterId: "counter-1", value: 0 }],
    ["counters", { action: "increment", counterId: "counter-1", by: 1 }],
    ["projects", { action: "create", title: "Memory project" }],
    ["projects", { action: "update", projectId: "project-1", title: "Changed project" }],
    ["projects", { action: "delete", projectId: "project-1", confirmTitle: "Work", allowCascade: true }],
    ["tags", { action: "create", title: "Memory tag" }],
    ["tags", { action: "update", tagId: "tag-1", title: "Changed tag" }],
    ["counter_config", { action: "update", counterId: "counter-1", title: "Changed counter" }],
    ["counter_config", { action: "delete", counterId: "counter-1", confirmTitle: "Fixture counter", allowHistoryDelete: true }],
    ["workspace", { action: "select", taskId: "task-1" }],
    ["preferences", { action: "update", section: "focusMode", expected: { focusModeSound: "off", focusModeSoundVolume: 20 }, updates: { focusModeSoundVolume: 25 } }],
    ["counter_control", { action: "start", counterId: "stopwatch-1", expected: { id: "stopwatch-1", type: "StopWatch", isEnabled: true, isOn: false } }],
    ["work_context", { action: "switch", contextType: "project", contextId: "project-1", expected: { id: "INBOX_PROJECT", type: "PROJECT" } }],
    ["ui", { command: "notes.toggle" }],
    ["attachments", { action: "add", taskId: "task-1", expectedRevision: "a".repeat(64), url: "https://example.org/new", title: "Fixture attachment" }],
    ["attachments", { action: "remove", taskId: "task-1", expectedRevision: "a".repeat(64), attachmentId: "attachment-1" }],
    ["keyboard", { action: "update", expectedRevision: "a".repeat(64), updates: { addNewTask: "Ctrl+Alt+N" } }],
  ]) {
    await t.test(`${kind}.${args.action ?? args.command}`, async () => {
      const f = await setup();
      const result = await f.call(`sp_tasks_${kind}`, Object.freeze({ ...args, context: contexts.document }));
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(f.requests.filter((request) => request.method !== "GET").length + f.runtimeRequests.filter((request) => request.route === "/internal/execute").length, 1);
      f.assertNoContextLeak();
    });
  }
});

test("invalid input shapes are preserved for existing validation across all registration paths", async (t) => {
  for (const name of ["sp_tasks_overview", "sp_tasks_repeat", "sp_tasks_bridge", "sp_tasks_counter_config", "sp_tasks_workspace", "sp_tasks_capabilities", "sp_tasks_preferences", "sp_tasks_counter_control", "sp_tasks_work_context", "sp_tasks_ui", "sp_tasks_attachments", "sp_tasks_keyboard"]) {
    for (const input of [null, [], "invalid", 42]) {
      await t.test(`${name}: ${JSON.stringify(input)}`, async () => {
        const f = await setup();
        const result = await f.call(name, input);
        assert.equal(result.code, "SP_BAD_INPUT");
        assert.equal(f.requests.length, 0);
        assert.equal(f.runtimeRequests.length, 0);
      });
    }
  }
});

test("context is never inspected and cannot supply missing business fields", async () => {
  const f = await setup();
  const input = { title: "Task without context inspection" };
  Object.defineProperty(input, "context", { enumerable: true, get() { throw new Error("Host context must not be read"); } });
  Object.freeze(input);
  assert.equal((await f.call("sp_tasks_create", input)).ok, true);
  const before = f.requests.length;
  const missingTitle = await f.call("sp_tasks_create", { context: { ...contexts.model, title: "Not a business title" } });
  assert.equal(missingTitle.code, "SP_BAD_INPUT");
  assert.equal(f.requests.length, before);
  for (const name of ["sp_tasks_overview", "sp_tasks_repeat", "sp_tasks_bridge", "sp_tasks_counter_config", "sp_tasks_workspace", "sp_tasks_capabilities", "sp_tasks_preferences", "sp_tasks_counter_control", "sp_tasks_work_context", "sp_tasks_ui", "sp_tasks_attachments", "sp_tasks_keyboard"]) {
    const result = await f.call(name, { ...examples[name], context: contexts.model, callToken: "not-a-reserved-top-level-field" });
    assert.equal(result.code, "SP_BAD_INPUT");
    assert.match(result.message, /callToken/);
  }
  f.assertNoContextLeak();
});
