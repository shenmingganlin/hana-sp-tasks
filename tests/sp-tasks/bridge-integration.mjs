import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createBridgeServer } from "../../sp-tasks/runtime/bridge.mjs";
import { createBridgeClient, BRIDGE_URL } from "../../sp-hana-bridge/src/companion.mjs";
import { registerStructureTools } from "../../sp-tasks/lib/structure-tools.js";
import { registerPreferenceTools } from "../../sp-tasks/lib/preference-tools.js";
import { registerExtendedTools } from "../../sp-tasks/lib/extended-tools.js";
import { SpError } from "../../sp-tasks/lib/sp.js";

const networkFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async () => { throw new Error("Only the explicitly guarded temporary loopback transport is allowed"); };
const clone = (value) => structuredClone(value);
const defaultTheme = {
  primary: "#29a1aa", accent: "#ff4081", warn: "#e11826", isAutoContrast: true,
  huePrimary: "500", hueAccent: "500", hueWarn: "500", backgroundImageDark: null,
  backgroundImageLight: null, isDisableBackgroundTint: false, backgroundOverlayOpacity: 20,
  backgroundImageBlur: 0,
};
const project = (id, title, extra = {}) => ({
  id, title, theme: clone(defaultTheme), taskIds: [], backlogTaskIds: [], noteIds: [],
  icon: null, isArchived: false, isEnableBacklog: false, isHiddenFromMenu: false,
  privateField: "not-for-model-output", ...extra,
});
const tag = (id, title, extra = {}) => ({ id, title, icon: null, color: null, taskIds: [], ...extra });
const completion = (isDone = false, doneOn = null, wontDoOn = null) => ({ isDone, doneOn, wontDoOn });
const completionOf = (task) => completion(task.isDone, task.doneOn ?? null, task.wontDoOn ?? null);
const isWontDo = (task) => task.isDone && task.wontDoOn != null && task.wontDoOn === task.doneOn;

async function until(predicate, message) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(5);
  }
}

async function fixture(t) {
  const controlToken = randomBytes(32).toString("base64url");
  const pluginToken = randomBytes(32).toString("base64url");
  const options = { controlToken, pluginToken, port: 0, executeTimeoutMs: 2500, leaseMs: 5000 };
  let service = await createBridgeServer(options);
  const origin = `http://127.0.0.1:${service.port}`;
  const temporaryPort = service.port;
  const lifetime = new AbortController();
  const timers = new Set();
  let plugin;
  t.after(async () => {
    plugin?.unload();
    lifetime.abort();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await Promise.all([service.close(), plugin?.finished()]);
  });
  assert.notEqual(temporaryPort, 3876, "The SP REST port is never used");
  assert.notEqual(temporaryPort, 3877, "The production bridge port is never used");

  const state = {
    projects: {
      INBOX_PROJECT: project("INBOX_PROJECT", "Inbox"),
      existing: project("existing", "Existing", { taskIds: ["keep-task"], noteIds: ["keep-note"] }),
    },
    tags: { TODAY: tag("TODAY", "Today"), focus: tag("focus", "Focus") },
    tasks: { "keep-task": { id: "keep-task", projectId: "existing", subTaskIds: [] } },
    notes: { "keep-note": { id: "keep-note", projectId: "existing" } },
    taskRepeatCfgs: { "keep-repeat": { id: "keep-repeat", projectId: "existing" } },
    globalConfig: {
      sound: { volume: 75, isIncreaseDoneSoundPitch: true, doneSound: "ding-small-bell.mp3", breakReminderSound: null, trackTimeSound: null, privateField: "fixture-config-secret" },
      focusMode: { focusModeSound: "off", focusModeSoundVolume: 50, autoStartFocusOnPlay: false },
      schedule: { isWorkStartEndEnabled: true, workStart: "9:00", workEnd: "17:00", isLunchBreakEnabled: false, lunchBreakStart: "13:00", lunchBreakEnd: "14:00" },
      sync: { accessToken: "fixture-config-secret" }, misc: { startOfNextDayTime: "04:00", unsplashApiKey: "fixture-config-secret" },
    },
    simpleCounters: { "keep-counter": { id: "keep-counter", title: "Fixture habit", type: "ClickCounter", isEnabled: true, isHideButton: false, isOn: false, icon: "check", countOnDay: { "2026-10-30": 3 } } },
    selectedTaskId: null,
    currentTaskId: "existing-timer-must-stay",
  };
  const writes = [], secrets = new Map(), snacks = [], reports = [], requests = [], controls = [];
  const faults = { nextThemeUpdate: false, nextReport: null };
  const helperDate = { now: () => 9000 };
  let nextId = 0;
  const api = {
    getAppState: async () => clone(state),
    getArchivedTasks: async () => [],
    dispatchAction: async (action) => {
      assert.deepEqual(Object.keys(action).sort(), ["isSkipSnack", "meta", "sectionCfg", "sectionKey", "type"]);
      assert.equal(action.type, "[Global Config] Update Global Config Section");
      assert.equal(action.isSkipSnack, true);
      assert.deepEqual(action.meta, { isPersistent: true, entityType: "GLOBAL_CONFIG", entityId: action.sectionKey, opType: "UPD" });
      const fields = {
        sound: ["volume", "isIncreaseDoneSoundPitch", "doneSound", "breakReminderSound", "trackTimeSound"],
        focusMode: ["focusModeSound", "focusModeSoundVolume"],
        schedule: ["isWorkStartEndEnabled", "workStart", "workEnd", "isLunchBreakEnabled", "lunchBreakStart", "lunchBreakEnd"],
      }[action.sectionKey];
      assert.ok(fields && Object.keys(action.sectionCfg).every((key) => fields.includes(key)), "Only fixed public preference fields may reach SP");
      writes.push({ op: "dispatchAction", data: clone(action) });
      Object.assign(state.globalConfig[action.sectionKey], clone(action.sectionCfg));
    },
    getAllSimpleCounters: async () => clone(Object.values(state.simpleCounters)),
    updateSimpleCounter: async (id, data) => {
      assert.ok(state.simpleCounters[id]);
      assert.ok(Object.keys(data).every((key) => ["title", "icon", "isEnabled", "isHideButton"].includes(key)));
      writes.push({ op: "updateSimpleCounter", id, data: clone(data) });
      Object.assign(state.simpleCounters[id], clone(data));
    },
    getSelectedTask: async () => clone(state.tasks[state.selectedTaskId] ?? null),
    selectTask: async (id) => {
      assert.ok(state.tasks[id]);
      writes.push({ op: "selectTask", id });
      state.selectedTaskId = id;
    },
    addProject: async (data) => {
      assert.equal(Object.hasOwn(data, "theme"), false, "SP must construct its complete default theme first");
      assert.equal(Object.hasOwn(data, "color"), false, "Project color is not an addProject field");
      const id = `project-${++nextId}`;
      writes.push({ op: "addProject", id, data: clone(data) });
      state.projects[id] = project(id, data.title, clone(data));
      return id;
    },
    updateProject: async (id, data) => {
      writes.push({ op: "updateProject", id, data: clone(data) });
      assert.ok(state.projects[id]);
      if (data.theme) {
        assert.deepEqual(Object.keys(data.theme).sort(), Object.keys(defaultTheme).sort());
        if (faults.nextThemeUpdate) {
          faults.nextThemeUpdate = false;
          throw new Error("Injected failure after addProject committed");
        }
      }
      Object.assign(state.projects[id], clone(data));
      if (data.isEnableBacklog === false) {
        state.projects[id].taskIds.push(...state.projects[id].backlogTaskIds);
        state.projects[id].backlogTaskIds = [];
      }
    },
    deleteProject: async (id) => {
      writes.push({ op: "deleteProject", id });
      const current = state.projects[id];
      assert.ok(current);
      const taskIds = new Set([...current.taskIds, ...current.backlogTaskIds]);
      let previousSize;
      do {
        previousSize = taskIds.size;
        for (const task of Object.values(state.tasks)) {
          if (task.projectId === id || taskIds.has(task.id) || taskIds.has(task.parentId)) {
            taskIds.add(task.id);
            for (const child of task.subTaskIds ?? []) taskIds.add(child);
          }
        }
      } while (taskIds.size !== previousSize);
      for (const taskId of taskIds) delete state.tasks[taskId];
      for (const kind of ["notes", "taskRepeatCfgs"]) {
        for (const row of Object.values(state[kind])) {
          if (row.projectId === id || kind === "notes" && current.noteIds.includes(row.id)) delete state[kind][row.id];
        }
      }
      delete state.projects[id];
    },
    addTag: async (data) => {
      const id = `tag-${++nextId}`;
      writes.push({ op: "addTag", id, data: clone(data) });
      state.tags[id] = tag(id, data.title, { ...clone(data), color: data.color || "#123456" });
      return id;
    },
    updateTag: async (id, data) => {
      writes.push({ op: "updateTag", id, data: clone(data) });
      assert.ok(state.tags[id]);
      Object.assign(state.tags[id], clone(data));
    },
    updateTask: async (id, data) => {
      assert.ok(state.tasks[id]);
      assert.deepEqual(Object.keys(data).sort(), ["doneOn", "isDone"], "Only public plugin completion fields may reach updateTask");
      writes.push({ op: "updateTask", id, data: clone(data) });
      // SP 19.3.1 maps null to an own undefined property, then overlays it after its doneOn helper.
      const changes = { ...clone(data), doneOn: data.doneOn === null ? undefined : data.doneOn };
      const automatic = changes.isDone ? { doneOn: typeof changes.doneOn === "number" ? changes.doneOn : helperDate.now() } : { doneOn: undefined };
      state.tasks[id] = { ...state.tasks[id], ...automatic, ...changes, modified: helperDate.now() };
    },
    getSecret: async (key) => secrets.get(key) ?? null,
    setSecret: async (key, value) => { secrets.set(key, value); },
    deleteSecret: async (key) => { secrets.delete(key); },
    showSnack: (notice) => { snacks.push(clone(notice)); },
  };

  async function localFetch(url, init = {}) {
    const target = new URL(url);
    assert.equal(target.origin, origin, "Network access must stay on this test's ephemeral loopback port");
    assert.equal(target.username, "");
    assert.equal(target.password, "");
    assert.equal(target.hash, "");
    const signals = [lifetime.signal, AbortSignal.timeout(3500), ...(init.signal ? [init.signal] : [])];
    return networkFetch(target, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
  }

  const pluginFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    assert.equal(url.origin, BRIDGE_URL);
    assert.ok(["/plugin/poll", "/plugin/result"].includes(url.pathname));
    assert.equal(init.headers.Authorization, `Bearer ${pluginToken}`);
    const body = JSON.parse(init.body);
    requests.push({ path: url.pathname, body: clone(body) });
    let fault;
    if (url.pathname === "/plugin/result") {
      fault = faults.nextReport;
      faults.nextReport = null;
      if (fault === "forget-receipt") {
        await service.close();
        service = await createBridgeServer({ ...options, port: temporaryPort });
      }
    }
    const response = await localFetch(`${origin}${url.pathname}`, init);
    if (url.pathname !== "/plugin/result") return response;
    const accepted = await response.clone().json();
    reports.push({ body: clone(body), status: response.status, reply: accepted, fault });
    // The real runtime has accepted the result; only its acknowledgement is damaged.
    if (fault === "missing-ack-id") return new Response(JSON.stringify({ ok: true, data: { accepted: true } }), { status: 200 });
    if (fault === "lost-ack") throw new TypeError("Injected lost acknowledgement after the real HTTP commit");
    return response;
  };
  plugin = createBridgeClient(api, {
    fetch: pluginFetch,
    clientId: "integration-sp-client",
    random: () => 0,
    setTimeout: (callback, milliseconds) => {
      const duration = milliseconds < 30000 ? Math.min(milliseconds, 10) : milliseconds;
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, duration);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => { timers.delete(timer); clearTimeout(timer); },
  });

  async function control(route, body) {
    let response, envelope;
    try {
      response = await localFetch(`${origin}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${controlToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      envelope = await response.json();
    } catch (cause) {
      throw Object.assign(new Error("Test control transport did not confirm the response", { cause }), {
        code: "SP_BRIDGE_CONNECTION_LOST", outcomeUnknown: !!body && !body.op.endsWith(".list"),
      });
    }
    if (body) controls.push({ ...clone(body), response: clone(envelope) });
    if (!response.ok || envelope.ok !== true) {
      throw Object.assign(new Error(envelope.error?.message || "Bridge rejected the command"), {
        code: envelope.error?.code || "SP_BRIDGE_BAD_RESPONSE",
        ...(envelope.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
        ...(typeof envelope.createdId === "string" ? { createdId: envelope.createdId } : {}),
      });
    }
    return envelope.data;
  }
  const tools = new Map();
  const toolSdk = { tools: { register: async (definition) => { tools.set(definition.name, definition); } } };
  const toolOptions = {
    bridge: { status: async () => ({ available: true, enabled: true, running: true, ...await control("/internal/status") }), execute: (op, args) => control("/internal/execute", { op, args }) },
    ok: (value) => ({ ok: true, ...value }),
    guard: (work) => async (args) => {
      try { return await work(args); }
      catch (error) {
        assert.ok(error instanceof SpError, "Tool adapters must translate bridge failures");
        return { ok: false, code: error.code, message: error.message,
          ...(error.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
          ...(typeof error.createdId === "string" ? { createdId: error.createdId } : {}) };
      }
    },
  };
  await registerStructureTools(toolSdk, toolOptions);
  await registerPreferenceTools(toolSdk, toolOptions);
  await registerExtendedTools(toolSdk, toolOptions);
  const pairing = `HANA-SP1.${Buffer.from(JSON.stringify({ protocol: 1, url: BRIDGE_URL, token: pluginToken })).toString("base64url")}`;
  await plugin.pair(pairing);
  await until(() => service.status().connected, "The actual SP client must poll the actual test bridge");
  const call = (kind, args = {}) => tools.get(`sp_tasks_${kind}`).execute(args);
  const repair = (args) => control("/internal/execute", { op: "tasks.repairCompletion", args });
  const idle = () => until(() => !plugin.status().pending, "The plugin must finish acknowledging the previous command");
  return { state, writes, faults, reports, controls, requests, snacks, plugin, call, repair, idle };
}

test("structure tools, loopback runtime and real SP client interoperate", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);

  await t.test("read-only status reaches the live bridge without an SP mutation", async () => {
    const status = await f.call("bridge");
    assert.equal(status.ok, true);
    assert.equal(status.bridge.connected, true);
    assert.equal(status.bridge.protocol, 1);
    assert.equal(f.writes.length, 0);
    assert.equal(f.controls.length, 0);
  });

  await t.test("preferences cross the actual HTTP chain with scoped reads, persistent writes and no secret projection", async () => {
    const before = clone(f.state);
    const controlsBefore = f.controls.length;
    for (const [section, updates] of [
      ["sound", { volume: 30, doneSound: null }],
      ["focusMode", { focusModeSound: "whiteNoise" }],
      ["schedule", { workStart: "08:30", isLunchBreakEnabled: true }],
    ]) {
      const start = f.writes.length;
      const read = await f.call("preferences", { action: "get", section, context: { callToken: "fixture-host-secret" } });
      assert.equal(read.ok, true, JSON.stringify(read));
      assert.equal(read.section, section);
      assert.equal(f.writes.length, start, "Reading preferences must not modify SP");
      assert.doesNotMatch(JSON.stringify(read), /fixture-config-secret|privateField|sync|unsplashApiKey|autoStartFocusOnPlay/);
      const updated = await f.call("preferences", { action: "update", section, expected: read.settings, updates });
      assert.equal(updated.ok, true, JSON.stringify(updated));
      assert.equal(updated.verification, "applied-state");
      assert.equal(updated.unchanged, false);
      assert.deepEqual(updated.settings, { ...read.settings, ...updates });
      assert.deepEqual(f.writes.slice(start), [{ op: "dispatchAction", data: {
        type: "[Global Config] Update Global Config Section", sectionKey: section, sectionCfg: updates, isSkipSnack: true,
        meta: { isPersistent: true, entityType: "GLOBAL_CONFIG", entityId: section, opType: "UPD" },
      } }]);
      const verified = await f.call("preferences", { action: "get", section });
      assert.deepEqual(verified.settings, updated.settings);
    }
    assert.deepEqual(f.state.globalConfig.sync, before.globalConfig.sync);
    assert.deepEqual(f.state.globalConfig.misc, before.globalConfig.misc);
    assert.equal(f.state.globalConfig.sound.privateField, before.globalConfig.sound.privateField);
    assert.equal(f.state.globalConfig.focusMode.autoStartFocusOnPlay, before.globalConfig.focusMode.autoStartFocusOnPlay);
    assert.deepEqual(f.state.tasks, before.tasks);
    assert.equal(f.state.currentTaskId, before.currentTaskId);
    await f.idle();
    assert.doesNotMatch(JSON.stringify(f.controls.slice(controlsBefore)) + JSON.stringify(f.requests) + JSON.stringify(f.reports) + JSON.stringify(f.snacks), /fixture-config-secret|fixture-host-secret/);
  });

  await t.test("a preference conflict crosses HTTP without a write and a fresh read remains usable", async () => {
    const read = await f.call("preferences", { action: "get", section: "sound" });
    assert.equal(read.ok, true);
    f.state.globalConfig.sound.breakReminderSound = "done1.mp3";
    const before = clone(f.state.globalConfig), writesBefore = f.writes.length;
    const result = await f.call("preferences", { action: "update", section: "sound", expected: read.settings, updates: { volume: 10 } });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SP_PREFERENCES_CONFLICT");
    assert.equal(result.outcomeUnknown, undefined);
    assert.equal(f.writes.length, writesBefore);
    assert.deepEqual(f.state.globalConfig, before);
    const fresh = await f.call("preferences", { action: "get", section: "sound" });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.settings.breakReminderSound, "done1.mp3");
    assert.equal(fresh.settings.volume, before.sound.volume);
  });

  await t.test("a lost preference acknowledgement retries the receipt without dispatching another config write", async () => {
    const read = await f.call("preferences", { action: "get", section: "sound" });
    assert.equal(read.ok, true);
    await f.idle();
    const writesBefore = f.writes.length, reportsBefore = f.reports.length;
    f.faults.nextReport = "lost-ack";
    const updated = await f.call("preferences", { action: "update", section: "sound", expected: read.settings, updates: { volume: 20 } });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.settings.volume, 20);
    const verified = await f.call("preferences", { action: "get", section: "sound" });
    assert.equal(verified.ok, true);
    assert.equal(verified.settings.volume, 20);
    await f.idle();
    const reports = f.reports.slice(reportsBefore), first = reports.find((entry) => entry.fault === "lost-ack");
    assert.ok(first);
    const retries = reports.filter((entry) => entry.body.id === first.body.id);
    assert.equal(retries.length, 2, "Only the failed acknowledgement should be retried");
    assert.deepEqual(retries[0].body, retries[1].body);
    assert.equal(retries[1].reply.data.duplicate, true);
    assert.equal(retries[1].reply.data.id, first.body.id);
    assert.deepEqual(f.writes.slice(writesBefore).map((entry) => entry.op), ["dispatchAction"]);
    assert.deepEqual(f.writes[writesBefore].data.sectionCfg, { volume: 20 });
  });

  await t.test("existing counter settings cross the bridge without touching history or running timers", async () => {
    const before = clone(f.state.simpleCounters["keep-counter"]), timerBefore = f.state.currentTaskId, writesBefore = f.writes.length;
    const result = await f.call("counter_config", { action: "update", counterId: "keep-counter", title: "Renamed fixture habit", icon: "", isHideButton: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.counter.title, "Renamed fixture habit");
    assert.equal(result.counter.icon, null);
    assert.equal(result.counter.isHideButton, true);
    assert.equal(result.counter.trackedDays, 1);
    assert.deepEqual(f.state.simpleCounters["keep-counter"].countOnDay, before.countOnDay);
    assert.equal(f.state.simpleCounters["keep-counter"].type, before.type);
    assert.equal(f.state.simpleCounters["keep-counter"].isOn, before.isOn);
    assert.equal(f.state.currentTaskId, timerBefore);
    assert.deepEqual(f.writes.slice(writesBefore), [{ op: "updateSimpleCounter", id: "keep-counter", data: { title: "Renamed fixture habit", icon: null, isHideButton: true } }]);
  });

  await t.test("workspace selection opens a task without changing task data or current tracking", async () => {
    const taskId = "selection-only";
    f.state.tasks[taskId] = { id: taskId, title: "Selection fixture", isDone: false, projectId: "INBOX_PROJECT", subTaskIds: [], privateField: "not-for-model-output" };
    const before = clone(f.state.tasks), timerBefore = f.state.currentTaskId, writesBefore = f.writes.length;
    const result = await f.call("workspace", { action: "select", taskId });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.selectedTask, { id: taskId, title: "Selection fixture", isDone: false });
    const read = await f.call("workspace", { action: "get_selection" });
    assert.deepEqual(read.selectedTask, result.selectedTask);
    assert.deepEqual(f.state.tasks, before);
    assert.equal(f.state.currentTaskId, timerBefore);
    assert.deepEqual(f.writes.slice(writesBefore), [{ op: "selectTask", id: taskId }]);
  });

  await t.test("project color follows creation, retains the complete theme and reads back", async () => {
    const start = f.writes.length;
    const created = await f.call("projects", { action: "create", title: "  Color project  ", color: "#aAbB01", icon: "folder", isEnableBacklog: true });
    assert.equal(created.ok, true);
    assert.equal(created.project.title, "Color project");
    assert.equal(created.project.color, "#aAbB01");
    const id = created.project.id;
    assert.deepEqual(f.writes.slice(start).map((entry) => entry.op), ["addProject", "updateProject"]);
    assert.deepEqual(f.state.projects[id].theme, { ...defaultTheme, primary: "#aAbB01" });
    const found = await f.call("projects", { action: "get", projectId: id });
    assert.deepEqual(found.project, created.project);
    assert.equal(Object.hasOwn(found.project, "privateField"), false);
    const renamed = await f.call("projects", { action: "update", projectId: id, title: "  Renamed project  ", isHiddenFromMenu: true });
    assert.equal(renamed.project.title, "Renamed project");
    assert.equal(renamed.project.isHiddenFromMenu, true);
    const beforeDuplicate = f.writes.length;
    const duplicate = await f.call("projects", { action: "create", title: "RENAMED PROJECT" });
    assert.equal(duplicate.code, "SP_DUPLICATE_TITLE");
    assert.equal(duplicate.outcomeUnknown, undefined);
    assert.ok(duplicate.message.includes(id), "The real companion must return the existing exact ID");
    assert.equal(f.writes.length, beforeDuplicate);
  });

  await t.test("tag color creation and clearing use the official add and update sequence", async () => {
    const start = f.writes.length;
    const created = await f.call("tags", { action: "create", title: "Clear on creation", color: "", icon: "" });
    assert.equal(created.ok, true);
    assert.equal(created.tag.color, null);
    assert.equal(created.tag.icon, null);
    assert.deepEqual(f.writes.slice(start).map((entry) => entry.op), ["addTag", "updateTag"]);
    assert.equal(Object.hasOwn(f.writes[start].data, "color"), false, "SP's random default must be cleared after addTag");
    const colored = await f.call("tags", { action: "update", tagId: created.tag.id, title: "Renamed tag", color: "#123abc" });
    assert.equal(colored.tag.color, "#123abc");
    const cleared = await f.call("tags", { action: "update", tagId: created.tag.id, color: "" });
    assert.equal(cleared.tag.color, null);
    const found = await f.call("tags", { action: "get", tagId: created.tag.id });
    assert.deepEqual(found.tag, cleared.tag);
    const writesBefore = f.writes.length;
    const duplicate = await f.call("tags", { action: "create", title: "  RENAMED TAG  " });
    assert.equal(duplicate.code, "SP_DUPLICATE_TITLE");
    assert.ok(duplicate.message.includes(created.tag.id));
    assert.equal(f.writes.length, writesBefore);
  });

  await t.test("deletion requires exact title and cascade permission and preserves unrelated data", async () => {
    const created = await f.call("projects", { action: "create", title: "Delete only this fixture" });
    const projectId = created.project.id;
    const preserve = clone({ project: f.state.projects.existing, task: f.state.tasks["keep-task"], note: f.state.notes["keep-note"], repeat: f.state.taskRepeatCfgs["keep-repeat"] });
    Object.assign(f.state.projects[projectId], { taskIds: ["delete-task"], backlogTaskIds: ["delete-backlog"], noteIds: ["delete-note"] });
    Object.assign(f.state.tasks, {
      "delete-task": { id: "delete-task", projectId, subTaskIds: ["delete-child"] },
      "delete-child": { id: "delete-child", parentId: "delete-task", subTaskIds: [] },
      "delete-backlog": { id: "delete-backlog", projectId, subTaskIds: [] },
    });
    f.state.notes["delete-note"] = { id: "delete-note", projectId };
    f.state.taskRepeatCfgs["delete-repeat"] = { id: "delete-repeat", projectId };
    const before = f.controls.length;
    for (const args of [
      { action: "delete", projectId, confirmTitle: created.project.title },
      { action: "delete", projectId, confirmTitle: created.project.title, allowCascade: false },
      { action: "delete", projectId: "INBOX_PROJECT", confirmTitle: "Inbox", allowCascade: true },
    ]) assert.equal((await f.call("projects", args)).code, "SP_BAD_INPUT");
    assert.equal(f.controls.length, before, "Locally rejected writes never reach the runtime");
    const wrongTitle = await f.call("projects", { action: "delete", projectId, confirmTitle: ` ${created.project.title} `, allowCascade: true });
    assert.equal(wrongTitle.code, "SP_BAD_INPUT");
    assert.equal(wrongTitle.outcomeUnknown, undefined);
    assert.equal(f.writes.some((entry) => entry.op === "deleteProject"), false);
    const deleted = await f.call("projects", { action: "delete", projectId, confirmTitle: created.project.title, allowCascade: true });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.result.id, projectId);
    assert.equal(deleted.result.deleted, true);
    assert.equal(deleted.result.impact.liveTaskCount, 3);
    assert.equal(deleted.result.impact.subtaskCount, 1);
    assert.equal(deleted.result.impact.noteCount, 1);
    assert.equal(deleted.result.impact.repeatCfgCount, 1);
    assert.equal(deleted.result.impact.archiveCleanupVerified, false);
    assert.equal(f.state.projects[projectId], undefined);
    for (const id of ["delete-task", "delete-child", "delete-backlog"]) assert.equal(f.state.tasks[id], undefined);
    assert.equal(f.state.notes["delete-note"], undefined);
    assert.equal(f.state.taskRepeatCfgs["delete-repeat"], undefined);
    assert.deepEqual({ project: f.state.projects.existing, task: f.state.tasks["keep-task"], note: f.state.notes["keep-note"], repeat: f.state.taskRepeatCfgs["keep-repeat"] }, preserve);
  });

  await t.test("partial creation returns createdId and outcomeUnknown through HTTP, then accepts list", async () => {
    await f.idle();
    const writesBefore = f.writes.length;
    const reportsBefore = f.reports.length;
    f.faults.nextThemeUpdate = true;
    const result = await f.call("projects", { action: "create", title: "Partially created project", color: "#abcdef" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SP_PLUGIN_ERROR");
    assert.equal(result.outcomeUnknown, true);
    assert.match(result.createdId, /^project-\d+$/);
    assert.equal(f.state.projects[result.createdId].title, "Partially created project");
    assert.equal(f.state.projects[result.createdId].theme.primary, defaultTheme.primary);
    const listed = await f.call("projects", { action: "list" });
    assert.equal(listed.ok, true, "The failure report must not block the plugin's next command");
    assert.equal(listed.projects.filter((row) => row.id === result.createdId).length, 1);
    assert.deepEqual(f.writes.slice(writesBefore).map((entry) => entry.op), ["addProject", "updateProject"]);
    await f.idle();
    const failureReport = f.reports.slice(reportsBefore).find((entry) => entry.body.result.createdId === result.createdId);
    assert.ok(failureReport);
    assert.equal(failureReport.status, 200, "The actual runtime must accept the createdId error envelope");
    assert.equal(failureReport.reply.data.accepted, true);
    assert.equal(failureReport.body.result.outcomeUnknown, true);
  });

  for (const fault of ["missing-ack-id", "lost-ack"]) {
    await t.test(`${fault}: retry the same result acknowledgement without repeating the write`, async () => {
      await f.idle();
      const reportsBefore = f.reports.length;
      const writesBefore = f.writes.length;
      f.faults.nextReport = fault;
      const created = await f.call("tags", { action: "create", title: `Recover ${fault}` });
      assert.equal(created.ok, true);
      const listed = await f.call("tags", { action: "list" });
      assert.equal(listed.ok, true);
      await f.idle();
      const reports = f.reports.slice(reportsBefore);
      const first = reports.find((entry) => entry.fault === fault);
      assert.ok(first);
      const retries = reports.filter((entry) => entry.body.id === first.body.id);
      assert.equal(retries.length, 2, "The invalid/lost acknowledgement must be retried exactly once");
      assert.deepEqual(retries[1].body, retries[0].body);
      assert.equal(retries[1].reply.data.duplicate, true);
      assert.equal(retries[1].reply.data.id, first.body.id);
      assert.deepEqual(f.writes.slice(writesBefore).map((entry) => entry.op), ["addTag"]);
      assert.equal(listed.tags.filter((row) => row.id === created.tag.id).length, 1);
    });
  }

  await t.test("completion repair preserves timestamp and wont-do meaning across the real HTTP transport", async () => {
    await f.idle();
    const scenarios = [
      { name: "done", expected: completion(), desired: completion(true, 500), wontDo: false },
      { name: "wont-do", expected: completion(false, null, 125), desired: completion(true, 125, 125), wontDo: true },
      { name: "reopen", expected: completion(true, 800, 125), desired: completion(false, null, 125), wontDo: false },
      { name: "legacy-no-date", expected: completion(false, null, 125), desired: completion(true, null, 125), wontDo: false },
    ];
    for (const { name, expected, desired, wontDo } of scenarios) {
      const taskId = `repair-${name}`, start = f.writes.length;
      f.state.tasks[taskId] = { id: taskId, ...expected, title: "Synthetic completion fixture", timeSpent: 1234, tagIds: ["focus"] };
      const result = await f.repair({ taskId, expected, desired });
      assert.deepEqual(result, { id: taskId, completion: desired, unchanged: false });
      assert.deepEqual(completionOf(f.state.tasks[taskId]), desired);
      assert.equal(isWontDo(f.state.tasks[taskId]), wontDo);
      assert.deepEqual(f.writes.slice(start), [{ op: "updateTask", id: taskId, data: { isDone: desired.isDone, doneOn: desired.doneOn } }]);
      assert.equal(f.state.tasks[taskId].title, "Synthetic completion fixture");
      assert.equal(f.state.tasks[taskId].timeSpent, 1234);
      assert.deepEqual(f.state.tasks[taskId].tagIds, ["focus"]);
      if (desired.doneOn === null) {
        assert.equal(Object.hasOwn(f.state.tasks[taskId], "doneOn"), true);
        assert.equal(f.state.tasks[taskId].doneOn, undefined, "The mapper's explicit clear must override the automatic timestamp");
      }
      const again = await f.repair({ taskId, expected, desired });
      assert.deepEqual(again, { id: taskId, completion: desired, unchanged: true });
      assert.equal(f.writes.length, start + 1, "An already applied completion must not be rewritten");
    }
  });

  await t.test("completion conflicts and unsupported marker changes cross HTTP without any mutation", async () => {
    await f.idle();
    const taskId = "repair-conflict", current = completion(true, 900, 125);
    f.state.tasks[taskId] = { id: taskId, ...current, title: "Preserve the newer state" };
    const before = clone(f.state.tasks[taskId]), start = f.writes.length;
    for (const [expected, desired, code] of [
      [completion(true, 800, 125), completion(true, 125, 125), "SP_COMPLETION_CONFLICT"],
      [current, completion(true, 900, null), "SP_COMPLETION_UNSUPPORTED"],
    ]) {
      await assert.rejects(f.repair({ taskId, expected, desired }), (error) => error.code === code && error.outcomeUnknown !== true);
      assert.deepEqual(f.state.tasks[taskId], before);
      assert.equal(f.writes.length, start);
    }
    const listed = await f.call("tags", { action: "list" });
    assert.equal(listed.ok, true, "An explicit repair refusal must not block later commands");
  });

  await t.test("a lost completion result acknowledgement never repeats updateTask", async () => {
    await f.idle();
    const taskId = "repair-lost-ack", expected = completion(false, null, 321), desired = completion(true, 321, 321);
    f.state.tasks[taskId] = { id: taskId, ...expected };
    const reportsBefore = f.reports.length, writesBefore = f.writes.length;
    f.faults.nextReport = "lost-ack";
    assert.deepEqual(await f.repair({ taskId, expected, desired }), { id: taskId, completion: desired, unchanged: false });
    const secondCommand = await f.repair({ taskId, expected, desired });
    assert.deepEqual(secondCommand, { id: taskId, completion: desired, unchanged: true });
    await f.idle();
    const reports = f.reports.slice(reportsBefore), first = reports.find((entry) => entry.fault === "lost-ack");
    assert.ok(first);
    const retries = reports.filter((entry) => entry.body.id === first.body.id);
    assert.equal(retries.length, 2);
    assert.deepEqual(retries[0].body, retries[1].body);
    assert.equal(retries[1].reply.data.duplicate, true);
    assert.deepEqual(f.writes.slice(writesBefore), [{ op: "updateTask", id: taskId, data: { isDone: true, doneOn: 321 } }]);
    assert.deepEqual(completionOf(f.state.tasks[taskId]), desired);
    assert.equal(isWontDo(f.state.tasks[taskId]), true);
  });

  await t.test("runtime receipt loss returns uncertainty and the same SP client resumes polling", async () => {
    await f.idle();
    const reportsBefore = f.reports.length;
    const writesBefore = f.writes.length;
    f.faults.nextReport = "forget-receipt";
    const created = await f.call("tags", { action: "create", title: "Survives runtime restart" });
    assert.equal(created.ok, false);
    assert.equal(created.outcomeUnknown, true);
    await until(() => f.reports.slice(reportsBefore).some((entry) => entry.fault === "forget-receipt"), "The restarted runtime must reject its lost receipt");
    const rejected = f.reports.slice(reportsBefore).find((entry) => entry.fault === "forget-receipt");
    assert.equal(rejected.status, 409);
    assert.equal(rejected.reply.error.code, "SP_BRIDGE_RESULT_MISMATCH");
    const listed = await f.call("tags", { action: "list" });
    assert.equal(listed.ok, true, "A rejected old receipt must not wedge the polling loop");
    assert.equal(listed.tags.filter((row) => row.title === "Survives runtime restart").length, 1);
    assert.deepEqual(f.writes.slice(writesBefore).map((entry) => entry.op), ["addTag"]);
    assert.ok(f.snacks.some((notice) => notice.type === "WARNING"));
    await f.idle();
    assert.equal(f.plugin.status().active, true);
    assert.equal(f.plugin.status().lastErrorCode, null);
  });
});
