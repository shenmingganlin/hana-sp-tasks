// The structure tool adapter is exercised without an SP process or bridge server.
import assert from "node:assert/strict";
import test from "node:test";
import { registerStructureTools } from "../../sp-tasks/lib/structure-tools.js";
import { SpError } from "../../sp-tasks/lib/sp.js";
import { readNotice, resetNoticeCache } from "../../sp-tasks/lib/notice.js";
import { registerExtendedTools, EXTENDED_CAPABILITIES } from "../../sp-tasks/lib/extended-tools.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in structure tool tests"); };
const failure = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
const project = (id, title, fields = {}) => ({
  id, title, icon: "folder", color: "#123456", isArchived: false,
  isEnableBacklog: true, isHiddenFromMenu: false, taskCount: 0, backlogTaskCount: 0, noteCount: 0, ...fields,
});
const tag = (id, title, fields = {}) => ({ id, title, icon: "label", color: null, taskCount: 0, ...fields });
const titleKey = (title) => title.trim().normalize("NFKC").toLowerCase();
const cleared = (kind, changes) => ({
  ...changes,
  ...(changes.icon === "" ? { icon: null } : {}),
  ...(changes.color === "" ? { color: kind === "projects" ? "#29a1aa" : null } : {}),
});
const json = (data) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });

async function setup() {
  resetNoticeCache();
  const tools = new Map();
  const state = {
    projects: [project("INBOX_PROJECT", "Inbox"), project("project-1", "Work"), project("archived-project", "Old work", { isArchived: true })],
    tags: [tag("TODAY", "Today"), tag("tag-1", "Focus")],
    calls: [], statusCalls: 0, errors: [], noticeRequests: 0,
    noticeTasks: [{ id: "task-1", title: "Memory task", isDone: false }],
    status: { enabled: true, paired: true, connected: true, protocolVersion: 1 },
    beforeErrors: new Map(), afterErrors: new Map(), overrides: new Map(), nextId: 1, statusError: null,
  };

  const bridge = {
    status: async () => {
      state.statusCalls += 1;
      if (state.statusError) throw state.statusError;
      return structuredClone(state.status);
    },
    execute: async (operation, args) => {
      state.calls.push({ operation, args: structuredClone(args) });
      if (state.beforeErrors.has(operation)) throw state.beforeErrors.get(operation);
      const [kind, action] = operation.split(".");
      const singular = kind === "projects" ? "project" : "tag";
      assert.ok(kind === "projects" || kind === "tags", `Unexpected kind ${kind}`);
      const rows = state[kind];
      let result;
      if (action === "list") {
        assert.deepEqual(args, {}, "Paging and archived filtering are local to the adapter");
        result = { [kind]: structuredClone(rows) };
      } else if (action === "create") {
        const matches = rows.filter((row) => titleKey(row.title) === titleKey(args.title));
        if (matches.length) throw failure("SP_DUPLICATE_TITLE", `Duplicate title; existing IDs: ${matches.map((row) => row.id).join(",")}`);
        const row = (kind === "projects" ? project : tag)(`${singular}-new-${state.nextId++}`, args.title, cleared(kind, args));
        rows.push(row);
        result = { [singular]: structuredClone(row) };
      } else {
        const targetId = args[`${singular}Id`];
        const row = rows.find((item) => item.id === targetId);
        if (!row) throw failure(kind === "projects" ? "SP_NO_PROJECT" : "SP_NO_TAG", `Unknown ID: ${targetId}`);
        if (action === "update") {
          if (args.title !== undefined) {
            const matches = rows.filter((item) => item.id !== targetId && titleKey(item.title) === titleKey(args.title));
            if (matches.length) throw failure("SP_DUPLICATE_TITLE", `Duplicate title; existing IDs: ${matches.map((item) => item.id).join(",")}`);
          }
          const { projectId, tagId, ...changes } = args;
          Object.assign(row, cleared(kind, changes));
          result = { [singular]: structuredClone(row) };
        } else if (action === "delete" && kind === "projects") {
          if (args.confirmTitle !== row.title) throw failure("SP_BRIDGE_CONFIRM_TITLE", "Confirm the exact current project title");
          const impact = { taskCount: row.taskCount, backlogTaskCount: row.backlogTaskCount, noteCount: row.noteCount };
          assert.equal(args.allowCascade, true, "Every project deletion needs explicit cascade authorization");
          rows.splice(rows.indexOf(row), 1);
          result = { id: targetId, deleted: true, impact };
        } else assert.fail(`Unexpected operation ${operation}`);
      }
      if (state.afterErrors.has(operation)) throw state.afterErrors.get(operation);
      return state.overrides.has(operation) ? state.overrides.get(operation)() : result;
    },
  };
  const sdk = {
    tools: { register: async (definition) => { tools.set(definition.name, definition); } },
    config: { getAll: async () => ({ baseUrl: "http://sp.invalid", accessToken: "test-token" }) },
    resources: { read: async () => { throw new Error("Production files and credentials are forbidden"); } },
    network: { fetch: async (rawUrl, init) => {
      const url = new URL(rawUrl);
      assert.equal(url.origin, "http://sp.invalid");
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, "Bearer test-token");
      state.noticeRequests += 1;
      if (url.pathname === "/tasks") return json(state.noticeTasks);
      if (url.pathname === "/task-control/current") return json(null);
      assert.fail(`Unexpected REST endpoint ${url.pathname}`);
    } },
  };
  const guard = (work) => async (args) => {
    try { return await work(args); }
    catch (error) {
      state.errors.push(error);
      return { ok: false, code: error.code, message: error.message, outcomeUnknown: error.outcomeUnknown === true };
    }
  };
  await registerStructureTools(sdk, { bridge, guard, ok: (payload) => ({ ok: true, ...payload }) });
  const call = (name, args) => {
    assert.ok(tools.has(name), `Missing tool ${name}`);
    return tools.get(name).execute(args);
  };
  return { state, tools, sdk, bridge, call };
}

test("registers exactly three closed-schema tools and does not expose tag deletion", async () => {
  const fixture = await setup();
  assert.deepEqual([...fixture.tools.keys()], ["sp_tasks_bridge", "sp_tasks_projects", "sp_tasks_tags"]);
  for (const tool of fixture.tools.values()) assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(fixture.tools.get("sp_tasks_bridge").parameters.properties, {});
  assert.deepEqual(fixture.tools.get("sp_tasks_projects").parameters.required, ["action"]);
  assert.deepEqual(fixture.tools.get("sp_tasks_tags").parameters.properties.action.enum, ["list", "get", "create", "update"]);
  assert.equal(fixture.state.calls.length, 0);
  assert.equal(fixture.state.statusCalls, 0);
});

test("bridge status is read-only and does not invoke an operation or start pairing", async () => {
  const fixture = await setup();
  const result = await fixture.call("sp_tasks_bridge", {});
  assert.deepEqual(result, { ok: true, bridge: fixture.state.status });
  assert.equal(fixture.state.statusCalls, 1);
  assert.equal(fixture.state.calls.length, 0);
  assert.equal(JSON.stringify(result).includes("test-token"), false);
});

test("projects paginate after archived filtering and get can inspect a precise archived ID", async () => {
  const fixture = await setup();
  const first = await fixture.call("sp_tasks_projects", { action: "list", limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.count, 1);
  assert.equal(first.projects[0].id, "INBOX_PROJECT");
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 1);
  const second = await fixture.call("sp_tasks_projects", { action: "list", limit: 1, offset: first.nextOffset });
  assert.equal(second.projects[0].id, "project-1");
  assert.equal(second.hasMore, false);
  assert.equal(second.nextOffset, null);
  const all = await fixture.call("sp_tasks_projects", { action: "list", includeArchived: true });
  assert.equal(all.total, 3);
  const archived = await fixture.call("sp_tasks_projects", { action: "get", projectId: " archived-project " });
  assert.equal(archived.project.id, "archived-project");
  assert.equal(archived.project.isArchived, true);
  const beyond = await fixture.call("sp_tasks_projects", { action: "list", offset: 100 });
  assert.equal(beyond.count, 0);
  assert.equal(beyond.total, 2);
  assert.equal(beyond.nextOffset, null);
  assert.ok(fixture.state.calls.every(({ operation, args }) => operation === "projects.list" && Object.keys(args).length === 0));
});

test("tags paginate without losing built-in TODAY and get resolves only the exact ID", async () => {
  const fixture = await setup();
  const list = await fixture.call("sp_tasks_tags", { action: "list", limit: 1, offset: 1 });
  assert.equal(list.total, 2);
  assert.deepEqual(list.tags.map((row) => row.id), ["tag-1"]);
  assert.equal(list.hasMore, false);
  const found = await fixture.call("sp_tasks_tags", { action: "get", tagId: "TODAY" });
  assert.equal(found.tag.title, "Today");
  const unknown = await fixture.call("sp_tasks_tags", { action: "get", tagId: "Today" });
  assert.equal(unknown.code, "SP_NO_TAG");
  const unknownProject = await fixture.call("sp_tasks_projects", { action: "get", projectId: "missing" });
  assert.equal(unknownProject.code, "SP_NO_PROJECT");
  assert.ok(fixture.state.calls.every(({ operation }) => operation.endsWith(".list")));
});

test("list and entity projections expose only approved structure fields", async () => {
  const fixture = await setup();
  fixture.state.projects[1].internalToken = "must-not-leak";
  fixture.state.projects[1].notes = ["private note"];
  const result = await fixture.call("sp_tasks_projects", { action: "get", projectId: "project-1" });
  assert.equal(result.ok, true);
  assert.equal("internalToken" in result.project, false);
  assert.equal("notes" in result.project, false);
  assert.equal(result.project.taskCount, 0);
  assert.equal(result.project.isHiddenFromMenu, false);
});

test("create and update use normalized inputs, exact IDs, and preserve false and clear values", async () => {
  const fixture = await setup();
  const created = await fixture.call("sp_tasks_projects", {
    action: "create", title: "  New project  ", icon: "work_outline", color: "#aAbB01", isEnableBacklog: false, isHiddenFromMenu: false,
  });
  assert.equal(created.ok, true);
  assert.match(created.project.id, /^project-new-/);
  assert.deepEqual(fixture.state.calls[0], { operation: "projects.create", args: {
    title: "New project", icon: "work_outline", color: "#aAbB01", isEnableBacklog: false, isHiddenFromMenu: false,
  } });
  const updated = await fixture.call("sp_tasks_projects", { action: "update", projectId: ` ${created.project.id} `, icon: "", color: "", isEnableBacklog: true, isHiddenFromMenu: false });
  assert.equal(updated.project.icon, null);
  assert.equal(updated.project.color, "#29a1aa");
  assert.equal(updated.project.isHiddenFromMenu, false);
  assert.deepEqual(fixture.state.calls[1].args, { projectId: created.project.id, icon: "", color: "", isEnableBacklog: true, isHiddenFromMenu: false });
  const createdTag = await fixture.call("sp_tasks_tags", { action: "create", title: "  New tag ", color: "#000000" });
  assert.equal(createdTag.tag.title, "New tag");
  const updatedTag = await fixture.call("sp_tasks_tags", { action: "update", tagId: createdTag.tag.id, title: "  Renamed tag  ", icon: "", color: "" });
  assert.equal(updatedTag.tag.id, createdTag.tag.id);
  assert.equal(updatedTag.tag.title, "Renamed tag");
  assert.equal(updatedTag.tag.icon, null);
  assert.equal(updatedTag.tag.color, null);
  assert.deepEqual(fixture.state.calls.map(({ operation }) => operation), ["projects.create", "projects.update", "tags.create", "tags.update"]);
});

test("rgb() colors read back from SP are converted to #rrggbb before writing", async () => {
  const fixture = await setup();
  await fixture.call("sp_tasks_projects", { action: "update", projectId: "project-1", color: "rgb(144, 187, 165)" });
  await fixture.call("sp_tasks_tags", { action: "update", tagId: "tag-1", color: " RGB(0,10,255) " });
  assert.deepEqual(fixture.state.calls.map(({ args }) => args.color), ["#90bba5", "#000aff"]);
});

test("duplicate-name errors identify existing IDs and do not become a reused success", async () => {
  const fixture = await setup();
  const duplicateProject = await fixture.call("sp_tasks_projects", { action: "create", title: " work " });
  assert.equal(duplicateProject.ok, false);
  assert.equal(duplicateProject.code, "SP_DUPLICATE_TITLE");
  assert.match(duplicateProject.message, /project-1/);
  const duplicateTag = await fixture.call("sp_tasks_tags", { action: "create", title: "FOCUS" });
  assert.equal(duplicateTag.code, "SP_DUPLICATE_TITLE");
  assert.match(duplicateTag.message, /tag-1/);
  assert.equal(fixture.state.projects.length, 3);
  assert.equal(fixture.state.tags.length, 2);
  assert.equal(fixture.state.calls.length, 2, "Duplicate requests are not automatically retried");
});

test("rename collisions preserve the existing entity ID and leave both objects unchanged", async () => {
  const fixture = await setup();
  fixture.state.projects.push(project("project-2", "Other project"));
  fixture.state.tags.push(tag("tag-2", "Other tag"));
  for (const [kind, targetId, title, conflictId] of [
    ["projects", "project-2", " Work ", "project-1"],
    ["tags", "tag-2", "FOCUS", "tag-1"],
  ]) {
    const before = structuredClone(fixture.state[kind]);
    const result = await fixture.call(`sp_tasks_${kind}`, { action: "update", [kind === "projects" ? "projectId" : "tagId"]: targetId, title });
    assert.equal(result.code, "SP_DUPLICATE_TITLE");
    assert.equal(result.outcomeUnknown, false);
    assert.ok(result.message.includes(conflictId));
    assert.deepEqual(fixture.state[kind], before);
  }
  assert.equal(fixture.state.calls.length, 2);
});

const invalidCases = [
  ["bridge", { action: "status" }], ["bridge", []], ["bridge", null],
  ["projects", {}], ["projects", null], ["projects", []], ["projects", { action: "archive" }],
  ["tags", { action: "delete", tagId: "tag-1" }],
  ["projects", { action: "create" }], ["tags", { action: "create", title: " " }],
  ["projects", { action: "create", title: 5 }], ["projects", { action: "create", title: "x".repeat(241) }],
  ["tags", { action: "create", title: "a\nb" }], ["tags", { action: "create", title: "bad\u0000title" }],
  ["projects", { action: "create", title: "New", projectId: "injected" }],
  ["projects", { action: "create", title: "New", isArchived: true }],
  ["tags", { action: "create", title: "New", isEnableBacklog: true }],
  ["projects", { action: "update", projectId: "project-1" }],
  ["tags", { action: "update", tagId: "tag-1" }],
  ["projects", { action: "update", projectId: "project-1", isHiddenFromMenu: "false" }],
  ["projects", { action: "update", projectId: "project-1", isEnableBacklog: 0 }],
  ["tags", { action: "update", tagId: "tag-1", icon: "folder-open" }],
  ["tags", { action: "update", tagId: "tag-1", icon: "x".repeat(81) }],
  ["tags", { action: "update", tagId: "tag-1", color: "red" }],
  ["tags", { action: "update", tagId: "tag-1", color: "#abc" }],
  ["tags", { action: "update", tagId: "tag-1", color: "#12345678" }],
  ["tags", { action: "update", tagId: "tag-1", color: null }],
  ["tags", { action: "update", tagId: "tag-1", color: "rgb(256, 0, 0)" }],
  ["tags", { action: "update", tagId: "tag-1", color: "rgba(1, 2, 3, 0.5)" }],
  ["projects", { action: "update", projectId: "project-1", color: "rgb(1, 2)" }],
  ["projects", { action: "list", includeArchived: "true" }],
  ["projects", { action: "list", title: "Work" }],
  ["tags", { action: "list", includeArchived: true }],
  ["projects", { action: "list", limit: 0 }], ["projects", { action: "list", limit: 201 }],
  ["tags", { action: "list", limit: 1.5 }], ["tags", { action: "list", offset: -1 }],
  ["tags", { action: "list", offset: 0.1 }], ["tags", { action: "list", offset: Number.MAX_SAFE_INTEGER + 1 }],
  ["projects", { action: "get", projectId: "project-1", includeArchived: true }],
  ["tags", { action: "get", tagId: "tag-1", limit: 1 }],
  ["projects", { action: "delete", projectId: "project-1" }],
  ["projects", { action: "delete", projectId: "project-1", confirmTitle: " " }],
  ["projects", { action: "delete", projectId: "project-1", confirmTitle: "Work" }],
  ["projects", { action: "delete", projectId: "project-1", confirmTitle: "Work", allowCascade: false }],
  ["projects", { action: "delete", projectId: "project-1", confirmTitle: "Work", allowCascade: "true" }],
  ["projects", { action: "delete", projectId: "project-1", confirmTitle: "Work", title: "Ignored" }],
];

test("invalid action fields, values and empty updates fail before bridge access", async (t) => {
  for (const [kind, args] of invalidCases) {
    await t.test(`${kind} ${JSON.stringify(args)}`, async () => {
      const fixture = await setup();
      const result = await fixture.call(`sp_tasks_${kind}`, args);
      assert.equal(result.ok, false);
      assert.equal(result.code, "SP_BAD_INPUT");
      assert.equal(fixture.state.calls.length, 0);
      assert.equal(fixture.state.statusCalls, 0);
    });
  }
});

test("path-shaped, blank, control-character and non-string IDs are rejected locally", async (t) => {
  for (const badId of ["", " ", ".", "..", "../child", "part/child", "part\\child", "a\nb", null, 1, [], "x".repeat(241)]) {
    for (const kind of ["projects", "tags"]) {
      await t.test(`${kind} ${JSON.stringify(badId)}`, async () => {
        const fixture = await setup();
        const idKey = kind === "projects" ? "projectId" : "tagId";
        const result = await fixture.call(`sp_tasks_${kind}`, { action: "get", [idKey]: badId });
        assert.equal(result.code, "SP_BAD_INPUT");
        assert.equal(fixture.state.calls.length, 0);
      });
    }
  }
});

test("Inbox and TODAY are readable but protected from structure mutations", async (t) => {
  for (const protectedId of ["INBOX_PROJECT", "TODAY"]) {
    for (const [kind, action] of [["projects", "update"], ["projects", "delete"], ["tags", "update"]]) {
      await t.test(`${kind}.${action} ${protectedId}`, async () => {
        const fixture = await setup();
        const result = await fixture.call(`sp_tasks_${kind}`, { action, [kind === "projects" ? "projectId" : "tagId"]: protectedId,
          ...(action === "delete" ? { confirmTitle: "Inbox", allowCascade: true } : { title: "Renamed" }) });
        assert.equal(result.code, "SP_BAD_INPUT");
        assert.equal(fixture.state.calls.length, 0);
      });
    }
  }
});

test("project deletion requires cascade authorization and forwards the exact confirmation", async () => {
  const fixture = await setup();
  for (const extra of [{}, { allowCascade: false }]) {
    const refused = await fixture.call("sp_tasks_projects", { action: "delete", projectId: "project-1", confirmTitle: "Work", ...extra });
    assert.equal(refused.code, "SP_BAD_INPUT");
    assert.equal(fixture.state.calls.length, 0, "Even a visibly empty project cannot bypass cascade authorization");
  }
  const wrongTitle = await fixture.call("sp_tasks_projects", { action: "delete", projectId: "project-1", confirmTitle: " Work ", allowCascade: true });
  assert.equal(wrongTitle.ok, false);
  assert.equal(wrongTitle.code, "SP_BRIDGE_CONFIRM_TITLE");
  assert.deepEqual(fixture.state.calls[0], { operation: "projects.delete", args: { projectId: "project-1", confirmTitle: " Work ", allowCascade: true } });
  assert.ok(fixture.state.projects.some((row) => row.id === "project-1"));
  const removed = await fixture.call("sp_tasks_projects", { action: "delete", projectId: "project-1", confirmTitle: "Work", allowCascade: true });
  assert.equal(removed.ok, true);
  assert.equal(removed.result.id, "project-1");
  assert.equal(removed.result.deleted, true);
  assert.deepEqual(removed.result.impact, { taskCount: 0, backlogTaskCount: 0, noteCount: 0 });
});

test("nonempty projects require explicit cascade permission before bridge access", async () => {
  const fixture = await setup();
  Object.assign(fixture.state.projects[1], { taskCount: 2, noteCount: 1 });
  const refused = await fixture.call("sp_tasks_projects", { action: "delete", projectId: "project-1", confirmTitle: "Work" });
  assert.equal(refused.code, "SP_BAD_INPUT");
  assert.equal(refused.outcomeUnknown, false);
  assert.equal(fixture.state.calls.length, 0);
  assert.equal(fixture.state.projects.length, 3);
  const allowed = await fixture.call("sp_tasks_projects", { action: "delete", projectId: "project-1", confirmTitle: "Work", allowCascade: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.result.impact.taskCount, 2);
  assert.equal(fixture.state.calls[0].args.allowCascade, true);
});

test("legacy project names with outer spaces need a verbatim confirmation", async () => {
  const fixture = await setup();
  fixture.state.projects[1].title = " Work ";
  const result = await fixture.call("sp_tasks_projects", { action: "delete", projectId: "project-1", confirmTitle: " Work ", allowCascade: true });
  assert.equal(result.ok, true);
  assert.equal(fixture.state.calls[0].args.confirmTitle, " Work ");
});

test("lists reject malformed envelopes, entities, optional fields and duplicate IDs", async (t) => {
  const cases = [
    null, {}, { projects: null }, { projects: {} }, { projects: [null] },
    { projects: [{ id: "", title: "Empty id" }] }, { projects: [{ id: "p" }] },
    { projects: [{ id: "p", title: "Wrong type", isArchived: "true" }] },
    { projects: [{ id: "p", title: "Wrong count", taskCount: -1 }] },
    { projects: [{ id: "p", title: "Fractional count", noteCount: 0.5 }] },
    { projects: [{ id: "p", title: "Wrong icon", icon: {} }] },
    { projects: [project("p", "One"), project("p", "Two")] },
  ];
  for (const value of cases) {
    await t.test(JSON.stringify(value), async () => {
      const fixture = await setup();
      fixture.state.overrides.set("projects.list", () => value);
      const result = await fixture.call("sp_tasks_projects", { action: "list" });
      assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE");
      assert.equal(result.outcomeUnknown, false);
      assert.equal(fixture.state.calls.length, 1);
    });
  }
  const tags = await setup();
  tags.state.overrides.set("tags.list", () => ({ tags: [tag("t", "One"), tag("t", "Two")] }));
  assert.equal((await tags.call("sp_tasks_tags", { action: "list" })).code, "SP_BRIDGE_BAD_RESPONSE");
});

test("malformed write results and wrong update IDs are unconfirmed, not successes", async (t) => {
  for (const [kind, action, value] of [
    ["projects", "create", {}], ["projects", "create", { project: { id: "p", title: 1 } }],
    ["projects", "create", { project: { id: "p", title: "New", taskCount: -1 } }],
    ["projects", "update", { project: project("wrong-id", "New") }],
    ["tags", "create", { tag: null }], ["tags", "create", { tag: tag("t", "New", { color: 5 }) }],
    ["tags", "update", { tag: tag("wrong-id", "New") }],
  ]) {
    await t.test(`${kind}.${action} ${JSON.stringify(value)}`, async () => {
      const fixture = await setup();
      fixture.state.overrides.set(`${kind}.${action}`, () => value);
      const args = { action, title: "New title", ...(action === "update" ? { [kind === "projects" ? "projectId" : "tagId"]: kind === "projects" ? "project-1" : "tag-1" } : {}) };
      const result = await fixture.call(`sp_tasks_${kind}`, args);
      assert.equal(result.ok, false);
      assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE");
      assert.equal(result.outcomeUnknown, true);
      assert.equal(fixture.state.calls.length, 1);
    });
  }
});

test("project deletion requires an acknowledgement for the exact requested ID", async (t) => {
  for (const value of [null, {}, { id: "project-1" }, { id: "project-1", deleted: false }, { id: "project-1", deleted: "true" }, { id: "wrong", deleted: true }]) {
    await t.test(JSON.stringify(value), async () => {
      const fixture = await setup();
      fixture.state.overrides.set("projects.delete", () => value);
      const result = await fixture.call("sp_tasks_projects", { action: "delete", projectId: "project-1", confirmTitle: "Work", allowCascade: true });
      assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE");
      assert.equal(result.outcomeUnknown, true);
      assert.equal(fixture.state.calls.length, 1);
    });
  }
});

test("bridge failures become SpError while preserving codes and uncertainty without retries", async () => {
  const fixture = await setup();
  fixture.state.beforeErrors.set("projects.list", failure("SP_BRIDGE_NOT_PAIRED", "Pair the plugin first"));
  const notPaired = await fixture.call("sp_tasks_projects", { action: "list" });
  assert.equal(notPaired.code, "SP_BRIDGE_NOT_PAIRED");
  assert.equal(notPaired.outcomeUnknown, false);
  assert.ok(fixture.state.errors.at(-1) instanceof SpError);
  fixture.state.afterErrors.set("tags.create", failure("SP_BRIDGE_TIMEOUT", "Response lost after commit", { outcomeUnknown: true }));
  const unknown = await fixture.call("sp_tasks_tags", { action: "create", title: "Committed tag" });
  assert.equal(unknown.code, "SP_BRIDGE_TIMEOUT");
  assert.equal(unknown.outcomeUnknown, true);
  assert.ok(fixture.state.errors.at(-1) instanceof SpError);
  assert.equal(fixture.state.tags.filter((row) => row.title === "Committed tag").length, 1);
  assert.equal(fixture.state.calls.filter((row) => row.operation === "tags.create").length, 1);
  fixture.state.beforeErrors.set("tags.list", new Error("Bridge unavailable"));
  const generic = await fixture.call("sp_tasks_tags", { action: "list" });
  assert.equal(generic.code, "SP_BRIDGE_ERROR");
  assert.equal(generic.message, "Bridge unavailable");
});

test("an existing SpError passes through unchanged and status errors are typed", async () => {
  const fixture = await setup();
  const existing = new SpError("CUSTOM_SP_ERROR", "Original SP failure");
  existing.outcomeUnknown = true;
  fixture.state.beforeErrors.set("projects.update", existing);
  const result = await fixture.call("sp_tasks_projects", { action: "update", projectId: "project-1", title: "New" });
  assert.equal(result.outcomeUnknown, true);
  assert.equal(fixture.state.errors.at(-1), existing);
  fixture.state.statusError = failure("SP_BRIDGE_DISABLED", "Disabled");
  const status = await fixture.call("sp_tasks_bridge", {});
  assert.equal(status.code, "SP_BRIDGE_DISABLED");
  assert.ok(fixture.state.errors.at(-1) instanceof SpError);
});

test("every valid write attempt invalidates the task notice, including rejected and unknown outcomes", async (t) => {
  for (const [kind, args] of [
    ["projects", { action: "create", title: "New project" }],
    ["projects", { action: "update", projectId: "project-1", title: "Changed" }],
    ["projects", { action: "delete", projectId: "project-1", confirmTitle: "Work", allowCascade: true }],
    ["tags", { action: "create", title: "New tag" }],
    ["tags", { action: "update", tagId: "tag-1", title: "Changed" }],
  ]) {
    for (const mode of ["success", "rejected", "lost-response", "malformed-result"]) {
      await t.test(`${kind}.${args.action} ${mode}`, async () => {
        const fixture = await setup();
        assert.match(await readNotice(fixture.sdk), /待办共 1 件/);
        const reads = fixture.state.noticeRequests;
        fixture.state.noticeTasks.push({ id: "task-2", title: "Fresh task", isDone: false });
        const operation = `${kind}.${args.action}`;
        if (mode === "rejected") fixture.state.beforeErrors.set(operation, failure("REJECTED", "Definite rejection"));
        if (mode === "lost-response") fixture.state.afterErrors.set(operation, failure("TIMEOUT", "Outcome unknown", { outcomeUnknown: true }));
        if (mode === "malformed-result") fixture.state.overrides.set(operation, () => ({}));
        const result = await fixture.call(`sp_tasks_${kind}`, args);
        assert.equal(result.ok, mode === "success");
        assert.match(await readNotice(fixture.sdk), /待办共 2 件/);
        assert.ok(fixture.state.noticeRequests > reads);
        assert.equal(fixture.state.calls.filter((row) => row.operation === operation).length, 1);
      });
    }
  }
});

test("read-only operations and locally invalid writes do not invalidate the notice", async () => {
  const fixture = await setup();
  assert.match(await readNotice(fixture.sdk), /待办共 1 件/);
  const reads = fixture.state.noticeRequests;
  fixture.state.noticeTasks.push({ id: "task-2", title: "Not yet refreshed", isDone: false });
  await fixture.call("sp_tasks_bridge", {});
  await fixture.call("sp_tasks_projects", { action: "list" });
  await fixture.call("sp_tasks_tags", { action: "get", tagId: "tag-1" });
  const invalid = await fixture.call("sp_tasks_projects", { action: "create", title: "" });
  assert.equal(invalid.code, "SP_BAD_INPUT");
  assert.match(await readNotice(fixture.sdk), /待办共 1 件/);
  assert.equal(fixture.state.noticeRequests, reads);
  assert.ok(fixture.state.calls.every((row) => row.operation.endsWith(".list")));
});

const counterRow = (id = "water", extra = {}) => ({ id, title: "Water", type: "ClickCounter", icon: null, isEnabled: true, isHideButton: false, isOn: false, trackedDays: 2, ...extra });
async function extendedSetup() {
  const tools = new Map();
  const state = { calls: [], statusCalls: 0, status: { enabled: true, running: true, accepting: true, connected: true, protocol: 1, pluginVersion: "0.3.0" }, reply: null, error: null };
  const bridge = {
    status: async () => { state.statusCalls++; return state.status; },
    execute: async (op, args) => { state.calls.push({ op, args: structuredClone(args) }); if (state.error) throw state.error; return typeof state.reply === "function" ? state.reply(op, args) : structuredClone(state.reply); },
  };
  await registerExtendedTools({ tools: { register: async (tool) => { tools.set(tool.name, tool); } } }, {
    bridge, ok: (data) => ({ ok: true, ...data }),
    guard: (work) => async (args) => { try { return await work(args); } catch (error) { return { ok: false, code: error.code, message: error.message, outcomeUnknown: error.outcomeUnknown, createdId: error.createdId }; } },
  });
  return { state, tools, call: (name, args) => tools.get(name).execute(args) };
}

test("extended tools register separate closed schemas and publish truthful capability descriptors", async () => {
  const f = await extendedSetup();
  assert.deepEqual([...f.tools.keys()], ["sp_tasks_counter_config", "sp_tasks_workspace"]);
  assert.deepEqual(EXTENDED_CAPABILITIES.map((item) => item.minimumPluginVersion), ["0.3.0", "0.3.0", "0.3.0"]);
  for (const item of EXTENDED_CAPABILITIES) { assert.equal(item.requires, "bridge"); assert.ok(item.tools.every((name) => f.tools.has(name))); }
  for (const tool of f.tools.values()) assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(f.state.statusCalls, 0);
});
test("extended operations gate old, disconnected and unrecognized plugins before sending commands", async () => {
  const f = await extendedSetup(); f.state.reply = { counters: [] };
  for (const pluginVersion of ["0.1.0", "0.2.0", "0.3.0-beta.1", "test", null, "03.0.0"]) {
    f.state.status.pluginVersion = pluginVersion;
    assert.equal((await f.call("sp_tasks_counter_config", { action: "list" })).code, "SP_BRIDGE_UPGRADE_REQUIRED");
  }
  assert.equal(f.state.calls.length, 0);
  f.state.status = { enabled: true, running: true, connected: false, protocol: 1, pluginVersion: "0.3.0" };
  assert.equal((await f.call("sp_tasks_workspace", { action: "get_selection" })).code, "SP_BRIDGE_NOT_CONNECTED");
  for (const pluginVersion of ["0.3.0", "0.4.0", "1.0.0", "0.3.0+build.1"]) {
    f.state.status = { enabled: true, running: true, connected: true, protocol: 1, pluginVersion };
    assert.equal((await f.call("sp_tasks_counter_config", { action: "list" })).ok, true);
  }
  for (const extra of [{ enabled: false }, { running: false }, { available: false }, { stopping: true }, { accepting: false }, { error: { code: "STOPPING" } }]) {
    f.state.status = { enabled: true, running: true, connected: true, protocol: 1, pluginVersion: "0.3.0", ...extra };
    const before = f.state.calls.length;
    assert.equal((await f.call("sp_tasks_counter_config", { action: "list" })).code, "SP_BRIDGE_NOT_CONNECTED");
    assert.equal(f.state.calls.length, before);
  }
});
test("counter config list paginates and excludes unapproved data from plugin responses", async () => {
  const f = await extendedSetup(); f.state.reply = { counters: [counterRow(), counterRow("second", { title: "Second", private: "hidden" })] };
  const first = await f.call("sp_tasks_counter_config", { action: "list", limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
  const second = await f.call("sp_tasks_counter_config", { action: "list", offset: 1 });
  assert.equal(second.hasMore, false); assert.equal(second.counters[0].private, undefined);
  assert.equal((await f.call("sp_tasks_counter_config", { action: "get", counterId: "second" })).counter.id, "second");
  assert.equal((await f.call("sp_tasks_counter_config", { action: "get", counterId: "missing" })).code, "SP_NO_COUNTER");
});
test("counter creation is absent from the schema and refuses before bridge access", async () => {
  const f = await extendedSetup();
  assert.equal(f.tools.get("sp_tasks_counter_config").parameters.properties.action.enum.includes("create"), false);
  const result = await f.call("sp_tasks_counter_config", { action: "create", title: "Unreliable create" });
  assert.equal(result.ok, false); assert.equal(result.code, "SP_BAD_INPUT"); assert.equal(f.state.calls.length, 0); assert.equal(f.state.statusCalls, 0);
});
test("extended invalid fields and destructive confirmations fail before status or execute", async () => {
  const f = await extendedSetup();
  for (const [tool, args] of [
    ["sp_tasks_counter_config", { action: "create", title: "Title", type: "StopWatch" }],
    ["sp_tasks_counter_config", { action: "update", counterId: "x", countOnDay: {} }],
    ["sp_tasks_counter_config", { action: "delete", counterId: "x", confirmTitle: "X" }],
    ["sp_tasks_counter_config", { action: "list", limit: 0 }],
    ["sp_tasks_workspace", { action: "select", taskId: "x", startTimer: true }],
    ["sp_tasks_workspace", { action: "reorder", contextType: "task", contextId: "p", expectedTaskIds: ["a", "b"], taskIds: ["a"] }],
  ]) assert.equal((await f.call(tool, args)).code, "SP_BAD_INPUT");
  assert.equal(f.state.statusCalls, 0); assert.equal(f.state.calls.length, 0);
});
test("extended writes reject wrong acknowledgements instead of silently reporting success", async () => {
  const f = await extendedSetup();
  const cases = [
    ["sp_tasks_counter_config", { action: "update", counterId: "water", title: "New" }, { updated: true, counter: counterRow() }],
    ["sp_tasks_counter_config", { action: "delete", counterId: "water", confirmTitle: "Water", allowHistoryDelete: true }, { id: "other", deleted: true, removedTrackedDays: 2 }],
    ["sp_tasks_workspace", { action: "select", taskId: "a" }, { selectedTask: { id: "b", title: "Wrong", isDone: false }, unchanged: false }],
    ["sp_tasks_workspace", { action: "reorder", contextType: "project", contextId: "p", expectedTaskIds: ["a", "b"], taskIds: ["b", "a"] }, { contextType: "project", contextId: "p", taskIds: ["a", "b"], backlogTaskIds: [], unchanged: false }],
  ];
  for (const [tool, args, reply] of cases) {
    f.state.reply = reply;
    const result = await f.call(tool, args);
    assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(result.outcomeUnknown, true);
  }
});
test("workspace forwards explicit order snapshots and distinguishes selection from tracking", async () => {
  const f = await extendedSetup();
  f.state.reply = { contextType: "task", contextId: "p", taskIds: ["b", "a"], backlogTaskIds: [], unchanged: false };
  const args = { action: "reorder", contextType: "task", contextId: "p", expectedTaskIds: ["a", "b"], taskIds: ["b", "a"] };
  assert.equal((await f.call("sp_tasks_workspace", args)).ok, true);
  assert.deepEqual(f.state.calls[0], { op: "taskOrder.update", args: { contextType: "task", contextId: "p", expectedTaskIds: ["a", "b"], taskIds: ["b", "a"] } });
  f.state.reply = { selectedTask: null };
  assert.equal((await f.call("sp_tasks_workspace", { action: "get_selection" })).selectedTask, null);
  f.state.reply = { selectedTask: { id: "a", title: "A", isDone: false, private: "hidden" }, unchanged: false };
  assert.deepEqual((await f.call("sp_tasks_workspace", { action: "select", taskId: "a" })).selectedTask, { id: "a", title: "A", isDone: false });
  assert.equal(f.state.calls.at(-1).op, "selection.select");
});

test("workspace reparent sends only a fixed parent change and validates the exact acknowledgement", async () => {
  const f = await extendedSetup();
  const args = { action: "reparent", taskId: "child", parentId: "new-parent", expectedParentId: "old-parent" };
  f.state.reply = { id: "child", parentId: "new-parent", previousParentId: "old-parent", projectId: "p", unchanged: false, notes: "private" };
  assert.deepEqual((await f.call("sp_tasks_workspace", args)).task, { id: "child", parentId: "new-parent", previousParentId: "old-parent", projectId: "p", unchanged: false });
  assert.deepEqual(f.state.calls[0], { op: "tasks.reparent", args: { taskId: "child", parentId: "new-parent", expectedParentId: "old-parent" } });
  f.state.reply.parentId = "wrong";
  const wrong = await f.call("sp_tasks_workspace", args);
  assert.equal(wrong.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(wrong.outcomeUnknown, true);
  const before = f.state.calls.length;
  const unknown = await f.call("sp_tasks_workspace", { ...args, foo: true });
  assert.match(unknown.message, /foo/); assert.equal(f.state.calls.length, before);
});
