// Exercise actual registered tools against an in-memory SP 19.3.1 contract.
// No real token, files, server, or user tasks are used.
import assert from "node:assert/strict";
import test from "node:test";
import app from "../../sp-tasks/index.js";
import { dayRange, localDay, shiftDay } from "../../sp-tasks/lib/date.js";
import { readNotice, resetNoticeCache } from "../../sp-tasks/lib/notice.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in expanded-tools tests"); };

const receipt = () => ({ ready: Promise.resolve(), disposeAsync: async () => {} });
const response = (data, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status });
const rejected = (code, message, status = 400) => new Response(JSON.stringify({ ok: false, error: { code, message } }), { status });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const writable = new Set([
  "title", "notes", "isDone", "timeEstimate", "timeSpent", "projectId", "tagIds",
  "dueDay", "dueWithTime", "plannedAt", "deadlineDay", "deadlineWithTime", "deadlineRemindAt",
]);
const task = (id, fields = {}) => ({
  id, title: `Task ${id}`, projectId: "INBOX_PROJECT", tagIds: [], subTaskIds: [],
  isDone: false, dueDay: null, dueWithTime: null, plannedAt: 0,
  deadlineDay: null, deadlineWithTime: null, deadlineRemindAt: null,
  timeEstimate: 0, timeSpent: 0, timeSpentOnDay: {}, ...fields,
});

function scheduleDay(row) {
  return typeof row.dueWithTime === "number" && row.dueWithTime > 0
    ? localDay(new Date(row.dueWithTime)) : row.dueDay;
}

function applyFields(row, body, state) {
  const changes = Object.fromEntries(Object.entries(body).filter(([key]) => writable.has(key)));
  Object.assign(row, changes);
  if (own(changes, "isDone")) {
    if (changes.isDone) row.doneOn = Date.now();
    else delete row.doneOn;
  }
  // SP's schedule reducer stores an all-day plan or a timestamp, never both.
  if (typeof changes.dueWithTime === "number" && changes.dueWithTime > 0) row.dueDay = null;
  else if (typeof changes.dueDay === "string" && changes.dueDay) row.dueWithTime = null;
  // The deadline reducer makes day/time exclusive and auto-plans today's
  // deadline only when an explicit future plan or a Today parent does not exist.
  if (changes.deadlineDay) row.deadlineWithTime = null;
  if (changes.deadlineWithTime) row.deadlineDay = null;
  if (own(changes, "deadlineDay") || own(changes, "deadlineWithTime")) {
    if (!own(changes, "deadlineRemindAt")) row.deadlineRemindAt = null;
    const deadline = row.deadlineWithTime ? localDay(new Date(row.deadlineWithTime)) : row.deadlineDay;
    const parent = state.tasks.find((candidate) => candidate.id === row.parentId);
    const planned = scheduleDay(row);
    if (!row.isDone && deadline === localDay() && scheduleDay(parent ?? {}) !== localDay() && (!planned || planned < localDay())) {
      row.dueDay = localDay();
      if (row.dueWithTime) {
        row.dueWithTime = null;
        row.remindAt = null;
      }
    }
  }
}

async function setup({ tasks = [], archived = [], projects, tags, defaultProjectId = "" } = {}) {
  resetNoticeCache();
  const tools = new Map();
  const hooks = new Map();
  const state = {
    tasks: structuredClone(tasks), archived: structuredClone(archived), currentTaskId: null,
    projects: projects ?? [{ id: "p1", title: "Work" }, { id: "INBOX_PROJECT", title: "Inbox" }, { id: "UI-project", title: "Current UI project" }],
    tags: tags ?? [{ id: "tag1", title: "Focus" }, { id: "tag2", title: "Errands" }, { id: "UI-tag", title: "Current UI tag" }],
    uiProjectId: "UI-project", uiTagIds: ["UI-tag"],
    requests: [], loseResponse: new Set(), replyOverrides: new Map(), rejectBefore: new Map(), nextId: 1, store: new Map(),
  };

  async function route(url, method, body) {
    const path = url.pathname;
    if (method === "GET" && path === "/health") return response({ server: "up", rendererReady: true });
    if (method === "GET" && path === "/projects") return response(state.projects);
    if (method === "GET" && path === "/tags") return response(state.tags);
    if (method === "GET" && path === "/focus") return response({ mode: "Countdown", timer: null });
    if (method === "GET" && path === "/task-control/current") return response(state.tasks.find((row) => row.id === state.currentTaskId) ?? null);
    if (method === "POST" && path === "/task-control/stop") {
      state.currentTaskId = null;
      return response({ currentTaskId: null });
    }
    if (method === "GET" && path === "/tasks") {
      const source = url.searchParams.get("source") ?? "active";
      const archivedProjects = new Set(state.projects.filter((row) => row.isArchived).map((row) => row.id));
      let rows = source === "archived" ? state.archived : source === "all"
        ? [...state.tasks, ...state.archived] : state.tasks.filter((row) => !archivedProjects.has(row.projectId));
      if (url.searchParams.get("includeDone") !== "true") rows = rows.filter((row) => !row.isDone);
      const query = url.searchParams.get("query");
      if (query) rows = rows.filter((row) => row.title.toLowerCase().includes(query.toLowerCase()));
      const projectId = url.searchParams.get("projectId");
      if (projectId) rows = rows.filter((row) => row.projectId === projectId);
      const tagId = url.searchParams.get("tagId");
      if (tagId) rows = rows.filter((row) => tagId === "TODAY" ? scheduleDay(row) === localDay() : row.tagIds.includes(tagId));
      return response(rows);
    }
    if (method === "POST" && path === "/tasks") {
      const parent = body.parentId ? state.tasks.find((row) => row.id === body.parentId) : null;
      if (body.parentId && !parent) return rejected("PARENT_NOT_FOUND", "Parent not found", 404);
      if (parent && (own(body, "projectId") || own(body, "tagIds"))) return rejected("UNSUPPORTED_FIELD", "Subtasks inherit project and tags");
      // TaskService defaults omitted project/tag fields from the open UI context.
      const row = task(`new-${state.nextId++}`, {
        projectId: state.uiProjectId, tagIds: [...state.uiTagIds],
        dueDay: own(body, "dueDay") ? null : localDay(),
      });
      if (parent) {
        row.parentId = parent.id;
        row.projectId = parent.projectId;
        row.tagIds = [];
        parent.subTaskIds.push(row.id);
      }
      applyFields(row, body, state);
      state.tasks.push(row);
      return response(row, 201);
    }
    const match = path.match(/^\/tasks\/([^/]+)(?:\/(start|time|archive|restore))?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const action = match[2];
      const row = state.tasks.find((candidate) => candidate.id === id);
      if (action === "restore" && method === "POST") {
        const archivedRow = state.archived.find((candidate) => candidate.id === id);
        if (!archivedRow) return rejected("TASK_NOT_FOUND", "Task not found in archive", 404);
        const ids = new Set([id, ...archivedRow.subTaskIds]);
        archivedRow.isDone = false;
        delete archivedRow.doneOn;
        state.tasks.push(...state.archived.filter((candidate) => ids.has(candidate.id)));
        state.archived = state.archived.filter((candidate) => !ids.has(candidate.id));
        return response(archivedRow);
      }
      if (!row) return rejected("TASK_NOT_FOUND", "Task not found", 404);
      if (!action && method === "GET") return response(row);
      if (!action && method === "PATCH") {
        if (own(body, "parentId") || own(body, "subTaskIds")) return rejected("UNSUPPORTED_FIELD", "Re-parenting is unsupported");
        if (body.projectId && body.projectId !== row.projectId) {
          if (row.parentId) return rejected("UNSUPPORTED_FIELD", "Move the parent task");
          if (!state.projects.some((project) => project.id === body.projectId && !project.isArchived)) return rejected("PROJECT_NOT_FOUND", "Destination project missing", 404);
        }
        applyFields(row, body, state);
        return response(row);
      }
      if ((!action && method === "DELETE") || (action === "archive" && method === "POST")) {
        const ids = new Set([id, ...row.subTaskIds]);
        if (action === "archive") {
          const now = Date.now();
          for (const candidate of state.tasks.filter((item) => ids.has(item.id))) {
            if (!candidate.isDone || !candidate.doneOn) candidate.doneOn = now;
            candidate.isDone = true;
            state.archived.push(candidate);
          }
        }
        state.tasks = state.tasks.filter((candidate) => !ids.has(candidate.id));
        if (ids.has(state.currentTaskId)) state.currentTaskId = null;
        return response({ id, [action === "archive" ? "archived" : "deleted"]: true });
      }
      if (action === "start" && method === "POST") {
        state.currentTaskId = id;
        return response({ currentTaskId: id });
      }
      if (action === "time" && ["POST", "PUT"].includes(method)) {
        if (row.subTaskIds.length) return rejected("INVALID_INPUT", "Log time on a subtask");
        const before = method === "POST" ? row.timeSpentOnDay[body.date] ?? 0 : 0;
        if (!Number.isFinite(body.duration) || body.duration < 0 || before + body.duration > 86_400_000) return rejected("INVALID_INPUT", "Time spent on one day cannot exceed 24h");
        if (before + body.duration === 0) delete row.timeSpentOnDay[body.date];
        else row.timeSpentOnDay[body.date] = before + body.duration;
        row.timeSpent = Object.values(row.timeSpentOnDay).reduce((sum, value) => sum + value, 0);
        return response(row);
      }
    }
    throw new Error(`Unmodelled SP route: ${method} ${path}`);
  }

  const sdk = {
    dataDir: "test-memory", bus: { request: async () => { throw new Error("Host bus is forbidden"); } },
    storage: { global: {
      get: async (key) => structuredClone(state.store.get(key) ?? null),
      set: async (key, value) => { state.store.set(key, structuredClone(value)); },
      delete: async (key) => { state.store.delete(key); },
      keys: async () => [...state.store.keys()],
    }, agent: () => ({}) }, models: {}, media: {}, providers: {},
    logger: { info: async () => {}, warn: async () => {} },
    config: { getAll: async () => ({ baseUrl: "http://sp.invalid", accessToken: "test-token", defaultProjectId }) },
    resources: { read: async () => { throw new Error("Production files and tokens are forbidden"); } },
    tools: { register: (definition) => { tools.set(definition.name, definition); return receipt(); } },
    hooks: { onDecision: (name, handler) => { hooks.set(name, handler); return receipt(); } },
    routes: { register: () => receipt() },
    network: { fetch: async (rawUrl, init = {}) => {
      const url = new URL(rawUrl);
      assert.equal(url.origin, "http://sp.invalid");
      assert.equal(init.headers.Authorization, "Bearer test-token");
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      state.requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      const key = `${method} ${url.pathname}`;
      if (state.rejectBefore.has(key)) return state.rejectBefore.get(key)();
      const result = await route(url, method, body);
      if (state.loseResponse.has(key)) throw new Error("fetch failed after server committed the write");
      return state.replyOverrides.has(key) ? state.replyOverrides.get(key)({ url, method, body }) : result;
    } },
  };
  await app.apply(sdk);
  const call = async (name, args) => {
    assert.ok(tools.has(name), `${name} must be registered`);
    const result = await tools.get(name).execute(args);
    return { ...JSON.parse(result.content[0].text), isError: result.isError === true };
  };
  return { state, sdk, hooks, tools, call, writes: () => state.requests.filter((row) => row.method !== "GET") };
}

for (const operation of ["create", "update"]) {
  for (const [field, value, projects, tags, code] of [
    ["project", "Missing", undefined, undefined, "SP_NO_PROJECT"],
    ["project", "Work", [{ id: "p1", title: "Work" }, { id: "p2", title: " work " }], undefined, "SP_AMBIGUOUS_PROJECT"],
    ["tags", ["Missing"], undefined, undefined, "SP_NO_TAG"],
    ["tags", ["Focus"], undefined, [{ id: "tag1", title: "Focus" }, { id: "tag2", title: " focus " }], "SP_AMBIGUOUS_TAG"],
  ]) {
    test(`${operation}: ${code} is rejected before any write`, async () => {
      const fixture = await setup({ tasks: [task("t1")], projects, tags, defaultProjectId: "INBOX_PROJECT" });
      const result = await fixture.call(`sp_tasks_${operation}`, { ...(operation === "create" ? { title: "New task" } : { taskIds: ["t1"] }), [field]: value });
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      assert.equal(fixture.writes().length, 0);
      assert.equal(fixture.state.tasks.length, 1);
    });
  }
}

test("update trims and deduplicates task ids; changed counts distinct tasks", async () => {
  const fixture = await setup({ tasks: [task("t1"), task("t2")] });
  const result = await fixture.call("sp_tasks_update", { taskIds: ["t1", " t1 ", "t2", "t1"], isDone: true });
  assert.equal(result.changed, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(fixture.writes().map((row) => row.path), ["/tasks/t1", "/tasks/t2"]);
});

test("explicit ids disambiguate identically named projects and tags", async () => {
  const fixture = await setup({
    projects: [{ id: "p1", title: "Work" }, { id: "p2", title: "Work" }],
    tags: [{ id: "tag1", title: "Focus" }, { id: "tag2", title: "Focus" }],
  });
  const created = await fixture.call("sp_tasks_create", { title: "Unambiguous target", projectId: "p2", tagIds: ["tag2", "tag2"] });
  assert.equal(created.ok, true);
  assert.equal(created.task.projectId, "p2");
  assert.deepEqual(created.task.tagIds, ["tag2"]);
  const updated = await fixture.call("sp_tasks_update", { taskIds: [created.task.id], projectId: "p1", tagIds: ["tag1"] });
  assert.equal(updated.changed, 1);
  assert.equal(fixture.state.tasks[0].projectId, "p1");
  assert.deepEqual(fixture.state.tasks[0].tagIds, ["tag1"]);
});

test("archived projects are excluded from write-target name resolution", async () => {
  const fixture = await setup({
    projects: [{ id: "archived", title: "Work", isArchived: true }, { id: "active", title: "Work" }],
  });
  const created = await fixture.call("sp_tasks_create", { title: "Active project only", project: "Work" });
  assert.equal(created.ok, true);
  assert.equal(created.task.projectId, "active");
  const rejectedTarget = await fixture.call("sp_tasks_update", { taskIds: [created.task.id], projectId: "archived" });
  assert.equal(rejectedTarget.ok, false);
  assert.equal(rejectedTarget.code, "SP_NO_PROJECT");
  assert.equal(fixture.writes().length, 1);
});

test("explicit blank project names cannot silently fall back or partially update", async () => {
  const fixture = await setup({ tasks: [task("t1")], defaultProjectId: "p1" });
  for (const project of ["", "   ", "\n\t"]) {
    const created = await fixture.call("sp_tasks_create", { title: "Wrong destination", project });
    assert.equal(created.ok, false);
    assert.equal(created.code, "SP_BAD_INPUT");
    const updated = await fixture.call("sp_tasks_update", { taskIds: ["t1"], title: "Should stay unchanged", project });
    assert.equal(updated.ok, false);
    assert.equal(updated.code, "SP_BAD_INPUT");
  }
  assert.equal(fixture.writes().length, 0);
  assert.equal(fixture.state.tasks[0].title, "Task t1");
});

test("unknown or archived configured default projects are rejected before creation", async () => {
  for (const projects of [[], [{ id: "default-project", title: "Old work", isArchived: true }]]) {
    const fixture = await setup({ projects, defaultProjectId: "default-project" });
    const result = await fixture.call("sp_tasks_create", { title: "Do not lose this task" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SP_NO_PROJECT");
    assert.equal(fixture.writes().length, 0);
    assert.equal(fixture.state.tasks.length, 0);
  }
});

test("a valid configured default project is used only when no explicit project was supplied", async () => {
  const fixture = await setup({ defaultProjectId: "p1" });
  const defaulted = await fixture.call("sp_tasks_create", { title: "Default work" });
  assert.equal(defaulted.ok, true);
  assert.equal(defaulted.task.projectId, "p1");
  const explicit = await fixture.call("sp_tasks_create", { title: "Inbox item", projectId: "INBOX_PROJECT" });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.task.projectId, "INBOX_PROJECT");
});

test("create preserves note whitespace, indentation, blank lines, and long content", async () => {
  const fixture = await setup();
  const notes = `  indented opening\n\n    code block\n${"long evidence\n".repeat(80)}\n  `;
  const result = await fixture.call("sp_tasks_create", { title: "Keep original notes", notes });
  assert.equal(result.ok, true);
  assert.equal(fixture.writes()[0].body.notes, notes);
  assert.equal(fixture.state.tasks[0].notes, notes);
  assert.equal(result.task.notes, notes);
});

test("unspecified task project and tags cannot inherit the current SP UI context", async () => {
  const fixture = await setup();
  const result = await fixture.call("sp_tasks_create", { title: "Capture to inbox" });
  assert.equal(result.ok, true);
  assert.equal(result.task.projectId, "INBOX_PROJECT");
  assert.deepEqual(result.task.tagIds, []);
  assert.equal(fixture.writes()[0].body.projectId, "INBOX_PROJECT");
  assert.deepEqual(fixture.writes()[0].body.tagIds, []);
});

test("an explicit project does not inherit tags from the current SP UI context", async () => {
  const fixture = await setup();
  const result = await fixture.call("sp_tasks_create", { title: "Project task", project: "Work" });
  assert.equal(result.ok, true);
  assert.equal(result.task.projectId, "p1");
  assert.deepEqual(result.task.tagIds, []);
  assert.deepEqual(fixture.writes()[0].body.tagIds, []);
});

test("subtask creation sends neither top-level project defaults nor tag defaults", async () => {
  const fixture = await setup({
    tasks: [task("parent", { projectId: "p1", tagIds: ["tag1"] })],
    defaultProjectId: "INBOX_PROJECT",
  });
  const result = await fixture.call("sp_tasks_create", { title: "Child", parentId: "parent" });
  assert.equal(result.ok, true);
  assert.equal(result.task.parentId, "parent");
  assert.equal(result.task.projectId, "p1");
  assert.equal(own(fixture.writes()[0].body, "projectId"), false);
  assert.equal(own(fixture.writes()[0].body, "tagIds"), false);
});

test("unsupported relation and recurrence fields are rejected rather than silently discarded", async () => {
  const fixture = await setup({ tasks: [task("t1"), task("parent")] });
  const created = await fixture.call("sp_tasks_create", { title: "Unsupported repeat", repeatCfgId: "cfg-1" });
  assert.equal(created.ok, false);
  assert.equal(created.code, "SP_BAD_INPUT");
  const updated = await fixture.call("sp_tasks_update", { taskIds: ["t1"], title: "Should not change", parentId: "parent" });
  assert.equal(updated.ok, false);
  assert.equal(updated.code, "SP_BAD_INPUT");
  assert.equal(fixture.writes().length, 0);
  assert.equal(fixture.state.tasks[0].title, "Task t1");
});

test("subtask project and tag overrides are rejected before creation", async () => {
  const fixture = await setup({ tasks: [task("parent")] });
  for (const fields of [{ project: "Work" }, { projectId: "p1" }, { tags: ["Focus"] }, { tagIds: ["tag1"] }]) {
    const result = await fixture.call("sp_tasks_create", { title: "Child", parentId: "parent", ...fields });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SP_BAD_INPUT");
  }
  assert.equal(fixture.writes().length, 0);
});

test("updating tags replaces the previous selection and an empty list clears it", async () => {
  const fixture = await setup({ tasks: [task("t1", { tagIds: ["tag2"] })] });
  const replacement = await fixture.call("sp_tasks_update", { taskIds: ["t1"], tags: ["Focus", "Focus"] });
  assert.equal(replacement.changed, 1);
  assert.deepEqual(fixture.state.tasks[0].tagIds, ["tag1"]);
  const cleared = await fixture.call("sp_tasks_update", { taskIds: ["t1"], tags: [] });
  assert.equal(cleared.changed, 1);
  assert.deepEqual(fixture.state.tasks[0].tagIds, []);
});

test("search returns every matching task across tag-filtered pages", async () => {
  const rows = Array.from({ length: 205 }, (_, index) => task(`t${index}`, { title: "Matching task", tagIds: ["tag1"] }));
  rows.splice(80, 0, task("excluded-tag", { title: "Matching task", tagIds: ["tag2"] }));
  rows.push(task("excluded-title", { title: "Different", tagIds: ["tag1"] }));
  const fixture = await setup({ tasks: rows });
  const first = await fixture.call("sp_tasks_search", { query: "Matching", tag: "Focus", limit: 200 });
  const second = await fixture.call("sp_tasks_search", { query: "Matching", tag: "Focus", limit: 200, offset: first.nextOffset });
  assert.equal(first.total, 205);
  assert.equal(first.count, 200);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 200);
  assert.equal(second.count, 5);
  assert.equal(second.total, 205);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextOffset, null);
  assert.deepEqual([...first.tasks, ...second.tasks].map((row) => row.id), Array.from({ length: 205 }, (_, index) => `t${index}`));
  assert.equal(fixture.writes().length, 0);
});

test("search projectId and tagId select exact entities despite duplicate names", async () => {
  const fixture = await setup({
    projects: [{ id: "p1", title: "Work" }, { id: "p2", title: "Work" }],
    tags: [{ id: "tag1", title: "Focus" }, { id: "tag2", title: "Focus" }],
    tasks: [
      task("p1-tag1", { projectId: "p1", tagIds: ["tag1"] }),
      task("p1-tag2", { projectId: "p1", tagIds: ["tag2"] }),
      task("p2-tag1", { projectId: "p2", tagIds: ["tag1"] }),
      task("p2-tag2", { projectId: "p2", tagIds: ["tag2"] }),
    ],
  });
  const result = await fixture.call("sp_tasks_search", { projectId: "p2", tagId: "tag2" });
  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.deepEqual(result.tasks.map((row) => row.id), ["p2-tag2"]);
  for (const args of [{ project: "Work", projectId: "p2" }, { tag: "Focus", tagId: "tag2" }]) {
    const conflict = await fixture.call("sp_tasks_search", args);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "SP_BAD_INPUT");
  }
  assert.equal(fixture.writes().length, 0);
});

test("TODAY search follows actual schedules and the 04:00 boundary, not stored tag ids or plannedAt", async () => {
  const today = localDay();
  const [start, end] = dayRange(today);
  const fixture = await setup({
    tags: [{ id: "TODAY", title: "Today" }],
    tasks: [
      task("all-day", { dueDay: today }),
      task("timed", { dueWithTime: start + 3_600_000 }),
      task("next-civil-day-02am", { dueWithTime: end - 2 * 3_600_000 }),
      task("next-day-04am", { dueWithTime: end }),
      task("stale-today-tag", { dueDay: shiftDay(today, 2), tagIds: ["TODAY"] }),
      task("legacy-only", { plannedAt: start }),
      task("done-today", { dueDay: today, isDone: true }),
    ],
  });
  for (const selector of [{ tagId: "TODAY" }, { tag: "Today" }]) {
    const result = await fixture.call("sp_tasks_search", selector);
    assert.equal(result.ok, true);
    assert.deepEqual(result.tasks.map((row) => row.id), ["all-day", "timed", "next-civil-day-02am"]);
  }
  const includingDone = await fixture.call("sp_tasks_search", { tagId: "TODAY", includeDone: true });
  assert.deepEqual(includingDone.tasks.map((row) => row.id), ["all-day", "timed", "next-civil-day-02am", "done-today"]);
  assert.equal(fixture.writes().length, 0);
});

test("future plan and actual deadline are sent to distinct SP fields", async () => {
  const fixture = await setup();
  const plan = shiftDay(localDay(), 3);
  const deadline = shiftDay(localDay(), 7);
  const result = await fixture.call("sp_tasks_create", { title: "Plan versus deadline", dueDay: plan, deadlineDay: deadline });
  assert.equal(result.ok, true);
  assert.equal(result.task.dueDay, plan);
  assert.equal(result.task.deadlineDay, deadline);
  const body = fixture.writes()[0].body;
  assert.equal(body.dueDay, plan);
  assert.equal(body.deadlineDay, deadline);
  assert.equal(body.dueWithTime, null);
  assert.equal(own(body, "plannedAt"), false);
});

test("timed plans clear dueDay and leave SP to determine the logical day of an early-morning timestamp", async () => {
  const fixture = await setup();
  const earlyMorning = new Date(2030, 4, 20, 2, 30, 0, 0).getTime();
  const created = await fixture.call("sp_tasks_create", { title: "Late-night plan", dueWithTime: "2030-05-20 02:30" });
  assert.equal(created.ok, true);
  assert.equal(created.task.dueDay, null);
  assert.equal(created.task.dueWithTime, earlyMorning);
  assert.equal(scheduleDay(fixture.state.tasks[0]), "2030-05-19");
  assert.equal(fixture.writes()[0].body.dueDay, null);
  assert.equal(own(fixture.writes()[0].body, "plannedAt"), false);
  const updated = await fixture.call("sp_tasks_update", { taskIds: [created.task.id], dueWithTime: "2030-05-21 09:30" });
  assert.equal(updated.changed, 1);
  const patch = fixture.writes()[1].body;
  assert.equal(patch.dueDay, null);
  assert.equal(patch.dueWithTime, new Date(2030, 4, 21, 9, 30, 0, 0).getTime());
  assert.equal(own(patch, "plannedAt"), false);
});

test("planForToday uses dueDay and replaces an old time, so SP Today includes the task", async () => {
  const future = shiftDay(localDay(), 5);
  const fixture = await setup({ tasks: [task("t1", { dueDay: future, dueWithTime: dayRange(future)[0] + 3_600_000 })] });
  const result = await fixture.call("sp_tasks_update", { taskIds: ["t1"], planForToday: true });
  assert.equal(result.changed, 1);
  assert.equal(fixture.writes()[0].body.dueDay, localDay());
  assert.equal(fixture.writes()[0].body.dueWithTime, null);
  assert.equal(own(fixture.writes()[0].body, "plannedAt"), false);
  assert.equal(scheduleDay(fixture.state.tasks[0]), localDay());
  const overview = await fixture.call("sp_tasks_overview", {});
  assert.deepEqual(overview.today.map((row) => row.id), ["t1"]);
});

test("planToday creation keeps one task and uses a confirmed plan update", async () => {
  const fixture = await setup();
  const result = await fixture.call("sp_tasks_create", { title: "Do today", planToday: true });
  assert.equal(result.plannedToday, true);
  assert.equal(fixture.state.tasks.length, 1);
  assert.equal(scheduleDay(fixture.state.tasks[0]), localDay());
  assert.deepEqual(fixture.writes().map(({ method }) => method), ["POST", "PATCH"]);
  assert.equal(fixture.writes()[1].body.dueDay, localDay());
  assert.ok(fixture.writes().every(({ body }) => !own(body, "plannedAt")));
});

test("clearing a plan removes dueWithTime but preserves a separate deadline", async () => {
  const deadline = shiftDay(localDay(), 8);
  const legacyPlannedAt = dayRange(shiftDay(localDay(), -5))[0];
  const fixture = await setup({ tasks: [task("t1", { dueDay: null, dueWithTime: dayRange(localDay())[0] + 3_600_000, plannedAt: legacyPlannedAt, deadlineDay: deadline })] });
  const result = await fixture.call("sp_tasks_update", { taskIds: ["t1"], dueDay: "none" });
  assert.equal(result.changed, 1);
  assert.equal(fixture.state.tasks[0].dueDay, null);
  assert.equal(fixture.state.tasks[0].dueWithTime, null);
  assert.equal(fixture.state.tasks[0].plannedAt, legacyPlannedAt);
  assert.equal(own(fixture.writes()[0].body, "plannedAt"), false);
  assert.equal(fixture.state.tasks[0].deadlineDay, deadline);
});

test("conflicting date inputs are rejected without writing", async () => {
  const fixture = await setup({ tasks: [task("t1")] });
  for (const args of [
    { dueDay: "today", dueWithTime: "tomorrow 09:30" },
    { planForToday: true, dueDay: "tomorrow" },
    { deadlineDay: "today", deadlineWithTime: "tomorrow 09:30" },
  ]) {
    const result = await fixture.call("sp_tasks_update", { taskIds: ["t1"], ...args });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SP_BAD_INPUT");
  }
  assert.equal(fixture.writes().length, 0);
});

test("literal titles request the SP short-syntax escape on create and rename", async () => {
  const fixture = await setup();
  const title = "Review #Focus +Work 1h";
  const created = await fixture.call("sp_tasks_create", { title });
  const updated = await fixture.call("sp_tasks_update", { taskIds: [created.task.id], title: `${title} again` });
  assert.equal(created.task.title, title);
  assert.equal(updated.changed, 1);
  assert.ok(fixture.writes().every((row) => row.body.isIgnoreShortSyntax === true));
  assert.equal(fixture.state.tasks[0].title, `${title} again`);
});

test("create losing its response reports unknown outcome and expires the cached summary", async () => {
  const fixture = await setup({ tasks: [task("t1")] });
  assert.match(await readNotice(fixture.sdk), /待办共 1 件/);
  fixture.state.loseResponse.add("POST /tasks");
  const result = await fixture.call("sp_tasks_create", { title: "Committed before disconnect" });
  assert.equal(result.ok, false);
  assert.equal(result.outcomeUnknown, true);
  assert.match(result.note, /先查询|不能直接重试/);
  assert.equal(fixture.state.tasks.length, 2);
  assert.equal(fixture.writes().length, 1);
  assert.match(await readNotice(fixture.sdk), /待办共 2 件/);
});

test("update losing its response expires the summary even when no write is confirmed", async () => {
  const fixture = await setup({ tasks: [task("t1"), task("t2")] });
  assert.match(await readNotice(fixture.sdk), /待办共 2 件/);
  fixture.state.loseResponse.add("PATCH /tasks/t1");
  const result = await fixture.call("sp_tasks_update", { taskIds: ["t1"], isDone: true });
  assert.equal(result.changed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].outcomeUnknown, true);
  assert.equal(fixture.state.tasks[0].isDone, true);
  assert.match(await readNotice(fixture.sdk), /待办共 1 件/);
});

test("lost additive time response is never silently retried", async () => {
  const fixture = await setup({ tasks: [task("t1")] });
  fixture.state.loseResponse.add("POST /tasks/t1/time");
  const result = await fixture.call("sp_tasks_log_time", { taskId: "t1", duration: "30m" });
  assert.equal(result.ok, false);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(fixture.state.tasks[0].timeSpentOnDay[localDay()], 1_800_000);
  assert.equal(fixture.writes().length, 1);
});

for (const [label, makeResponse] of [
  ["HTML", () => new Response("<html>wrong service</html>")],
  ["missing success envelope", () => new Response(JSON.stringify({ id: "invented", title: "Wrong shape" }))],
  ["missing data", () => new Response(JSON.stringify({ ok: true }))],
  ["null data", () => response(null)],
  ["missing task id", () => response({ title: "Missing identity" })],
]) {
  test(`create rejects malformed success: ${label}`, async () => {
    const fixture = await setup();
    fixture.state.replyOverrides.set("POST /tasks", makeResponse);
    const result = await fixture.call("sp_tasks_create", { title: "A real task" });
    assert.equal(result.ok, false);
    assert.equal(result.isError, true);
    assert.equal(result.code, "SP_BAD_RESPONSE");
    assert.equal(result.outcomeUnknown, true);
    assert.equal(fixture.writes().length, 1);
  });
}

test("search rejects malformed success lists instead of reporting no tasks", async () => {
  const fixture = await setup();
  fixture.state.replyOverrides.set("GET /tasks", () => response([null]));
  const result = await fixture.call("sp_tasks_search", {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "SP_BAD_RESPONSE");
});

test("empty hook summary removes only its previous injected part", async () => {
  const fixture = await setup({ tasks: [task("t1")] });
  const handler = fixture.hooks.get("agent/pre-step");
  const userPart = { type: "text", text: "[任务台] This prefix is my own input" };
  const first = await handler({ messages: [{ role: "user", content: [userPart] }] });
  assert.equal(first.messages[0].content[1], userPart);
  await fixture.call("sp_tasks_update", { taskIds: ["t1"], isDone: true });
  const cleared = await handler({ messages: first.messages });
  assert.deepEqual(cleared.messages, [{ role: "user", content: [userPart] }]);
  assert.equal(cleared.messages[0].content[0], userPart);
  assert.equal(await handler({ messages: cleared.messages }), undefined);
});

test("a single day's logged time is capped at 24h before writing, while estimates may exceed it", async () => {
  const fixture = await setup({ tasks: [task("t1")] });
  const rejectedTime = await fixture.call("sp_tasks_log_time", { taskId: "t1", duration: "1441" });
  assert.equal(rejectedTime.ok, false);
  assert.equal(fixture.writes().length, 0);
  const estimate = await fixture.call("sp_tasks_update", { taskIds: ["t1"], timeEstimate: "1441" });
  assert.equal(estimate.changed, 1);
  assert.equal(fixture.state.tasks[0].timeEstimate, 86_460_000);
});

test("get preserves long notes and relationships needed to edit a task safely", async () => {
  const notes = `  ${"Long notes\n".repeat(100)}  `;
  const fixture = await setup({ tasks: [task("parent", { notes, subTaskIds: ["child"] }), task("child", { parentId: "parent" })] });
  const result = await fixture.call("sp_tasks_get", { taskId: "parent" });
  assert.equal(result.ok, true);
  assert.equal(result.task.notes, notes);
  assert.deepEqual(result.task.subTaskIds, ["child"]);
  assert.equal(fixture.writes().length, 0);
});

test("get can inspect a completed archived task without restoring it", async () => {
  const fixture = await setup({ archived: [task("old", { isDone: true, notes: "Archived evidence" })] });
  const result = await fixture.call("sp_tasks_get", { taskId: "old", source: "archived" });
  assert.equal(result.ok, true);
  assert.equal(result.source, "archived");
  assert.equal(result.task.notes, "Archived evidence");
  assert.equal(fixture.state.tasks.length, 0);
  assert.equal(fixture.writes().length, 0);
  const read = fixture.state.requests.find((row) => row.path === "/tasks");
  assert.equal(read.query.source, "archived");
  assert.equal(read.query.includeDone, "true");
});

test("manage archives and restores a parent with its children, then deletes the active family", async () => {
  const fixture = await setup({ tasks: [task("parent", { subTaskIds: ["child"] }), task("child", { parentId: "parent" })] });
  const archived = await fixture.call("sp_tasks_manage", { action: "archive", taskIds: ["parent"] });
  assert.equal(archived.changed, 1);
  assert.equal(archived.failed, 0);
  assert.deepEqual(fixture.state.archived.map((row) => row.id), ["parent", "child"]);
  assert.equal(fixture.state.tasks.length, 0);
  const restored = await fixture.call("sp_tasks_manage", { action: "restore", taskIds: ["parent"] });
  assert.equal(restored.changed, 1);
  assert.equal(restored.failed, 0);
  assert.deepEqual(fixture.state.tasks.map((row) => row.id), ["parent", "child"]);
  assert.ok(fixture.state.tasks.every((row) => row.isDone === false && row.doneOn === undefined));
  assert.equal(fixture.state.archived.length, 0);
  const deleted = await fixture.call("sp_tasks_manage", { action: "delete", taskIds: ["parent"] });
  assert.equal(deleted.changed, 1);
  assert.equal(deleted.failed, 0);
  assert.equal(fixture.state.tasks.length, 0);
  assert.deepEqual(fixture.writes().map(({ method, path }) => `${method} ${path}`), [
    "POST /tasks/parent/archive", "POST /tasks/parent/restore", "PATCH /tasks/child", "DELETE /tasks/parent",
  ]);
});

for (const action of ["archive", "restore", "delete"]) {
  test(`manage ${action} sends one cascade request when both child and parent were selected`, async () => {
    const rows = [task("parent", { subTaskIds: ["child"] }), task("child", { parentId: "parent" })];
    const fixture = await setup(action === "restore" ? { archived: rows } : { tasks: rows });
    const result = await fixture.call("sp_tasks_manage", { action, taskIds: ["child", "parent", "child"], ...(action === "restore" ? { allowCompletionLoss: true } : {}) });
    assert.equal(result.changed, 2);
    assert.equal(result.failed, 0);
    const degraded = action === "restore" ? { degraded: true, completionPreserved: false, missingCompletionIds: ["parent", "child"], pendingCompletionIds: [] } : {};
    assert.deepEqual(result.results, [
      { id: "child", ok: true, ...degraded, coveredBy: "parent" },
      { id: "parent", ok: true, ...degraded },
    ]);
    assert.deepEqual(fixture.writes().map(({ method, path }) => `${method} ${path}`), [
      action === "delete" ? "DELETE /tasks/parent" : `POST /tasks/parent/${action}`,
    ]);
    const preflight = fixture.state.requests.find((row) => row.path === "/tasks" && row.query.source === "all");
    assert.deepEqual(preflight.query, { source: "all", includeDone: "true" });
    assert.ok(fixture.state.requests.some((row) => row.path === "/tasks" && row.query.source === "archived" && row.query.includeDone === "true"));
    assert.equal(action === "restore" ? fixture.state.archived.length : fixture.state.tasks.length, 0);
  });
}

for (const relation of ["parentId", "subTaskIds"]) {
  test(`manage can identify selected cascades from ${relation} metadata`, async () => {
    const fixture = await setup({ tasks: [task("parent", { subTaskIds: ["child"] }), task("child", { parentId: "parent" })] });
    fixture.state.replyOverrides.set("GET /tasks", ({ url }) => response((url.searchParams.get("source") === "archived" ? fixture.state.archived : fixture.state.tasks).map((row) => {
      const projected = { ...row };
      if (relation === "parentId") delete projected.subTaskIds;
      else delete projected.parentId;
      return projected;
    })));
    const result = await fixture.call("sp_tasks_manage", { action: "archive", taskIds: ["child", "parent"] });
    assert.equal(result.changed, 2);
    assert.equal(result.results[0].coveredBy, "parent");
    assert.deepEqual(fixture.writes().map((row) => row.path), ["/tasks/parent/archive"]);
  });
}

test("a failed parent cascade does not report its child as successful or stop an independent root", async () => {
  const fixture = await setup({ tasks: [task("parent", { subTaskIds: ["child"] }), task("child", { parentId: "parent" }), task("other")] });
  fixture.state.rejectBefore.set("POST /tasks/parent/archive", () => rejected("FORBIDDEN", "Parent operation rejected", 403));
  const result = await fixture.call("sp_tasks_manage", { action: "archive", taskIds: ["child", "parent", "other"] });
  assert.equal(result.changed, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].coveredBy, "parent");
  assert.equal(result.results[0].code, "FORBIDDEN");
  assert.equal(result.results[0].outcomeUnknown, false);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[2].ok, true);
  assert.deepEqual(fixture.state.tasks.map((row) => row.id), ["parent", "child"]);
  assert.deepEqual(fixture.state.archived.map((row) => row.id), ["other"]);
  assert.deepEqual(fixture.writes().map((row) => row.path), ["/tasks/parent/archive", "/tasks/other/archive"]);
});

test("an unknown parent cascade outcome remains unknown for the child and does not stop another root", async () => {
  const fixture = await setup({ tasks: [task("parent", { subTaskIds: ["child"] }), task("child", { parentId: "parent" }), task("other")] });
  fixture.state.loseResponse.add("POST /tasks/parent/archive");
  const result = await fixture.call("sp_tasks_manage", { action: "archive", taskIds: ["parent", "child", "other"] });
  assert.equal(result.changed, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].outcomeUnknown, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].coveredBy, "parent");
  assert.equal(result.results[1].outcomeUnknown, true);
  assert.equal(result.results[2].ok, true);
  assert.equal(fixture.state.tasks.length, 0);
  assert.deepEqual(fixture.state.archived.map((row) => row.id), ["parent", "child", "other"]);
  assert.deepEqual(fixture.writes().map((row) => row.path), ["/tasks/parent/archive", "/tasks/other/archive"]);
});

test("manage rejects contradictory or cyclic ancestry before a destructive request", async () => {
  for (const rows of [
    [task("parent", { subTaskIds: ["child"] }), task("other", { subTaskIds: ["child"] }), task("child", { parentId: "parent" })],
    [task("parent", { parentId: "child", subTaskIds: ["child"] }), task("child", { parentId: "parent", subTaskIds: ["parent"] })],
  ]) {
    const fixture = await setup({ tasks: rows });
    const result = await fixture.call("sp_tasks_manage", { action: "delete", taskIds: ["parent", "child"] });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SP_BAD_RESPONSE");
    assert.equal(fixture.writes().length, 0);
  }
});

test("completion and rescheduling are rejected together before SP can silently discard the plan", async () => {
  const fixture = await setup({ tasks: [task("target", { dueDay: "2026-10-30" })] });
  for (const plan of [{ dueDay: "明天" }, { dueWithTime: "明天 09:00" }, { planForToday: true }]) {
    const result = await fixture.call("sp_tasks_update", { taskIds: ["target"], isDone: true, ...plan });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SP_BAD_INPUT");
  }
  assert.equal(fixture.writes().length, 0);
});

test("registered tools retain their own SDK when another app instance is initialized", async () => {
  const first = await setup();
  const second = await setup();
  const result = await first.call("sp_tasks_create", { title: "First instance only" });
  assert.equal(result.ok, true);
  assert.equal(first.writes().length, 1);
  assert.equal(second.writes().length, 0);
});
