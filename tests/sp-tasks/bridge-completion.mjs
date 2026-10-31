// Only a temporary loopback bridge and a synthetic plugin are exercised here.
import assert from "node:assert/strict";
import test from "node:test";
import { validateCommand } from "../../sp-tasks/lib/bridge-protocol.js";
import { createBridgeServer } from "../../sp-tasks/runtime/bridge.mjs";

const state = (extra = {}) => ({ isDone: false, doneOn: null, wontDoOn: null, ...extra });
const valid = () => ({ taskId: "synthetic-task", expected: state({ isDone: true, doneOn: 50 }), desired: state({ doneOn: 0, wontDoOn: 8640000000000000 }) });

test("completion repair accepts only a fixed operation with complete compare-and-set states", () => {
  const args = valid();
  assert.deepEqual(validateCommand("tasks.repairCompletion", args), { op: "tasks.repairCompletion", args });
  const invalid = [
    { ...args, patch: { title: "Unrelated mutation" } }, { ...args, arbitrary: true },
    { ...args, taskId: "../task" }, { ...args, taskId: " task " }, { ...args, taskId: "" },
    { ...args, expected: { isDone: false, doneOn: null } },
    { ...args, desired: { ...args.desired, title: "Unrelated mutation" } },
    { ...args, expected: null }, { ...args, desired: [] },
    { ...args, desired: state({ isDone: 1 }) },
  ];
  for (const field of ["doneOn", "wontDoOn"]) for (const value of [undefined, "1", false, -1, 1.1, NaN, Infinity, 8640000000000001, Number.MAX_SAFE_INTEGER + 1]) invalid.push({ ...args, desired: state({ [field]: value }) });
  for (const bad of invalid) assert.throws(() => validateCommand("tasks.repairCompletion", bad), (error) => error.code === "SP_BRIDGE_BAD_INPUT");
  for (const op of ["tasks.update", "tasks.patch", "tasks.delete", "tasks.repairCompletion.extra"]) assert.throws(() => validateCommand(op, args), (error) => error.code === "SP_BRIDGE_BAD_INPUT");
});

test("extended bridge commands expose only bounded counter configuration, ordering and selection", () => {
  for (const [op, args] of [
    ["counters.list", {}], ["counters.update", { counterId: "water", title: "Water", icon: "", isEnabled: false, isHideButton: true }],
    ["counters.update", { counterId: "legacy.id", title: "New" }], ["counters.delete", { counterId: "water", confirmTitle: "Water", allowHistoryDelete: true }],
    ["taskOrder.list", { contextType: "project", contextId: "INBOX_PROJECT" }],
    ["taskOrder.update", { contextType: "task", contextId: "parent", expectedTaskIds: ["a", "b"], taskIds: ["b", "a"] }],
    ["selection.list", {}], ["selection.select", { taskId: "child" }],
    ["tasks.reparent", { taskId: "leaf", expectedParentId: null, parentId: "parent" }],
  ]) assert.deepEqual(validateCommand(op, args), { op, args });
  for (const [op, args] of [
    ["counters.create", { counterId: "constructor", title: "Bad" }], ["counters.create", { counterId: "ok", title: "No arbitrary type", type: "StopWatch" }],
    ["counters.update", { counterId: "ok", countOnDay: {} }], ["counters.update", { counterId: "ok", isOn: true }],
    ["counters.update", { counterId: "ok" }], ["counters.delete", { counterId: "ok", confirmTitle: "Title" }],
    ["counters.update", { counterId: "ok", isEnabled: "false" }], ["counters.create", { counterId: "legacy.id", title: "Bad ID" }],
    ["taskOrder.list", { contextType: "tag", contextId: "TODAY" }],
    ["taskOrder.update", { contextType: "task", contextId: "parent", expectedTaskIds: ["a", "b"], taskIds: ["a"] }],
    ["taskOrder.update", { contextType: "project", contextId: "p", expectedTaskIds: ["a", "b"], taskIds: ["a", "a"] }],
    ["taskOrder.list", { contextType: "project", contextId: "../p" }],
    ["selection.select", { taskId: "a", startTimer: true }], ["selection.list", { taskId: "a" }],
    ["tasks.reparent", { taskId: "a", parentId: null }],
    ["tasks.reparent", { taskId: "a", expectedParentId: null, parentId: "a" }],
    ["tasks.reparent", { taskId: "a", expectedParentId: null, parentId: "p", operations: [] }],
  ]) assert.throws(() => validateCommand(op, args), (error) => error.code === "SP_BRIDGE_BAD_INPUT");
  for (const op of ["projects.archive", "projects.restore", "tags.delete", "settings.update", "tasks.batch", "counters.patch", "counters.create"]) assert.throws(() => validateCommand(op, {}), (error) => error.code === "SP_BRIDGE_BAD_INPUT");
});

test("a narrowly validated repair crosses the bridge once and returns the confirmed completion", async (t) => {
  const service = await createBridgeServer({ controlToken: "c".repeat(43), pluginToken: "p".repeat(43), port: 0, executeTimeoutMs: 2000 });
  t.after(() => service.close());
  async function call(route, body, plugin = false) {
    const response = await fetch(`http://127.0.0.1:${service.port}${route}`, { method: "POST", headers: { Authorization: `Bearer ${plugin ? "p".repeat(43) : "c".repeat(43)}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  const poll = () => call("/plugin/poll", { clientId: "synthetic-plugin", protocol: 1, version: "0.2.0" }, true);
  const args = valid();
  assert.equal((await call("/internal/execute", { op: "tasks.repairCompletion", args: { ...args, desired: { ...args.desired, projectId: "x" } } })).status, 400);
  assert.equal((await poll()).body.data.command, null);
  const pending = call("/internal/execute", { op: "tasks.repairCompletion", args });
  let command;
  for (let attempt = 0; attempt < 100 && !command; attempt++) {
    command = (await poll()).body.data.command;
    if (!command) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(command);
  assert.equal(command.op, "tasks.repairCompletion");
  assert.deepEqual(command.args, args);
  const result = { ok: true, data: { id: args.taskId, completion: args.desired, unchanged: false } };
  const report = { clientId: "synthetic-plugin", id: command.id, result };
  assert.equal((await call("/plugin/result", report, true)).body.data.accepted, true);
  assert.deepEqual((await pending).body, result);
  assert.equal((await call("/plugin/result", report, true)).body.data.duplicate, true);
  assert.equal((await poll()).body.data.command, null);
});
