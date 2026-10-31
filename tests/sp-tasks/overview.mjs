import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { localDay, dayRange, shiftDay } from "../../sp-tasks/lib/date.js";
import {
  buildOverview, normalizeTaskInput, resolveNamedEntity, summarizeTask,
  taskIsPlannedForDay, taskIsOverdue,
} from "../../sp-tasks/lib/view.js";

const cfg = { baseUrl: "http://sp.invalid", accessToken: "test-token", defaultProjectId: "" };
const today = localDay();
const yesterday = shiftDay(today, -1);
const tomorrow = shiftDay(today, 1);
const task = (id, fields = {}) => ({
  id, title: id, projectId: "INBOX_PROJECT", isDone: false,
  tagIds: [], subTaskIds: [], ...fields,
});

test("task reads preserve the completion metadata needed to distinguish done from won't-do", () => {
  for (const fields of [
    { isDone: false },
    { isDone: true, doneOn: 1600000000000 },
    { isDone: true, doneOn: 1600000000000, wontDoOn: 1600000000000 },
    { isDone: true, doneOn: 0, wontDoOn: 0 },
  ]) {
    const row = task("completion", fields);
    const projected = summarizeTask(row);
    assert.equal(projected.doneOn, fields.doneOn ?? null);
    assert.equal(projected.wontDoOn, fields.wontDoOn ?? null);
    assert.equal(projected.isDone, fields.isDone);
    assert.equal(row.doneOn, fields.doneOn, "reading must not create a new completion timestamp");
  }
});

function fixture(tasks, { projects = [], tags = [] } = {}) {
  const requests = [];
  const sdk = { network: { fetch: async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    assert.equal(url.origin, "http://sp.invalid");
    assert.equal(init.method, "GET", "overview and name resolution must remain read-only");
    requests.push(url);
    const data = url.pathname === "/tasks"
      ? (url.searchParams.get("includeDone") === "true" ? tasks : tasks.filter((row) => row?.isDone !== true))
      : url.pathname === "/projects" ? projects
        : url.pathname === "/tags" ? tags : null;
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  } } };
  return { sdk, requests };
}

test("includeDone returns completed tasks without inflating open or overdue counts", async () => {
  const rows = [
    task("open", { dueDay: today }),
    task("done-today", { dueDay: today, deadlineDay: yesterday, isDone: true }),
    task("done-unscheduled", { isDone: true }),
  ];
  const { sdk, requests } = fixture(rows);
  const active = await buildOverview(sdk, cfg);
  assert.deepEqual(active.today.map((row) => row.id), ["open"]);
  assert.equal(active.completed, undefined);
  const all = await buildOverview(sdk, cfg, { includeDone: true });
  assert.deepEqual(all.today.map((row) => row.id), ["open", "done-today"]);
  assert.deepEqual(all.completed.map((row) => row.id), ["done-today", "done-unscheduled"]);
  assert.equal(all.counts.open, 1);
  assert.equal(all.counts.today, 2);
  assert.equal(all.counts.overdue, 0);
  assert.equal(all.counts.inbox, 3);
  assert.equal(requests.filter((url) => url.pathname === "/tasks")[1].searchParams.get("includeDone"), "true");
});

test("Today follows SP dueWithTime precedence and ignores legacy plannedAt", async () => {
  const [start, end] = dayRange(today);
  const rows = [
    task("day", { dueDay: today }),
    task("moment", { dueWithTime: start + 60000 }),
    task("next-day-moment", { dueDay: today, dueWithTime: end }),
    task("legacy-only", { plannedAt: start }),
    task("deadline-overdue-today", { dueDay: today, deadlineDay: yesterday }),
    task("stale-plan", { dueDay: yesterday }),
  ];
  const { sdk } = fixture(rows);
  const overview = await buildOverview(sdk, cfg);
  assert.deepEqual(overview.today.map((row) => row.id), ["day", "moment", "deadline-overdue-today"]);
  assert.deepEqual(new Set(overview.overdue.map((row) => row.id)), new Set(["deadline-overdue-today", "stale-plan"]));
  assert.equal(overview.today.find((row) => row.id === "deadline-overdue-today").plannedToday, true);
  assert.equal(taskIsPlannedForDay(task("x", { dueWithTime: end - 1 }), today), true);
  assert.equal(taskIsPlannedForDay(task("x", { dueWithTime: start - 1 }), today), false);
  assert.equal(taskIsPlannedForDay(task("x", { dueDay: today, dueWithTime: Infinity }), today), true);
});

test("deadline timestamps and old plan days have separate overdue rules", () => {
  const [start] = dayRange(today);
  const at = start + 3600000;
  assert.equal(taskIsOverdue(task("x", { deadlineWithTime: at - 1 }), today, at), true);
  assert.equal(taskIsOverdue(task("x", { deadlineWithTime: at + 1 }), today, at), false);
  assert.equal(taskIsOverdue(task("x", { dueWithTime: start + 1 }), today, at), false);
  assert.equal(taskIsOverdue(task("x", { dueWithTime: start - 1, dueDay: today }), today, at), true);
  assert.equal(taskIsOverdue(task("x", { deadlineDay: yesterday, isDone: true }), today, at), false);
  assert.equal(taskIsOverdue(task("x", { deadlineDay: yesterday, deadlineWithTime: at + 1 }), today, at), false);
});

test("effort uses today's daily time and counts a selected parent only once", async () => {
  const parent = task("parent", {
    dueDay: today, subTaskIds: ["child"], timeEstimate: 3600000,
    timeSpent: 7200000, timeSpentOnDay: { [today]: 600000, [yesterday]: 6600000 },
  });
  const child = task("child", {
    dueDay: today, parentId: "parent", timeEstimate: 3600000,
    timeSpent: 7200000, timeSpentOnDay: { [today]: 600000, [yesterday]: 6600000 },
  });
  const rows = [parent, child, child, task("other", {
    dueDay: today, timeEstimate: 1800000, timeSpent: 9000000, timeSpentOnDay: { [today]: 300000 },
  })];
  const { sdk } = fixture(rows);
  const overview = await buildOverview(sdk, cfg);
  assert.equal(overview.counts.today, 3);
  assert.equal(overview.counts.open, 3);
  assert.deepEqual(overview.effort, { todayEstimateMs: 5400000, todaySpentMs: 900000 });
});

test("a child scheduled alone contributes its own time; selected ancestors cover descendants", async () => {
  const rows = [
    task("parent", { dueDay: tomorrow, subTaskIds: ["middle"], timeEstimate: 999999 }),
    task("middle", { parentId: "parent", subTaskIds: ["child"] }),
    task("child", { dueDay: today, parentId: "middle", timeEstimate: 600000, timeSpentOnDay: { [today]: 300000 } }),
  ];
  let overview = await buildOverview(fixture(rows).sdk, cfg);
  assert.deepEqual(overview.effort, { todayEstimateMs: 600000, todaySpentMs: 300000 });
  rows[0].dueDay = today;
  rows[0].timeSpentOnDay = { [today]: 900000 };
  overview = await buildOverview(fixture(rows).sdk, cfg);
  assert.deepEqual(overview.effort, { todayEstimateMs: 999999, todaySpentMs: 900000 });
});

test("task projection preserves full notes, hierarchy, deadlines, repeat reference and daily time", () => {
  const notes = "  " + "long note ".repeat(100) + "\n";
  const row = task("child", {
    notes, parentId: "parent", subTaskIds: ["nested"], repeatCfgId: "repeat",
    deadlineDay: tomorrow, deadlineWithTime: dayRange(tomorrow)[0],
    deadlineRemindAt: dayRange(today)[0], timeSpentOnDay: { [today]: 1234 },
  });
  const result = summarizeTask(row);
  assert.equal(result.notes, notes);
  assert.equal(result.notesTruncated, false);
  for (const key of ["parentId", "subTaskIds", "repeatCfgId", "deadlineDay", "deadlineWithTime", "deadlineRemindAt", "timeSpentOnDay"]) {
    assert.deepEqual(result[key], row[key]);
  }
  assert.notEqual(result.timeSpentOnDay, row.timeSpentOnDay);
});

test("named entities require one exact normalized name; partial, unknown and duplicate names fail", () => {
  const projects = [{ id: "a", title: "Customer A" }, { id: "b", title: "Customer B" }];
  assert.equal(resolveNamedEntity(projects, " customer a ").id, "a");
  assert.throws(() => resolveNamedEntity(projects, "Customer"), { code: "SP_NO_PROJECT" });
  assert.throws(() => resolveNamedEntity(projects, "Unknown"), { code: "SP_NO_PROJECT" });
  assert.throws(() => resolveNamedEntity([...projects, { id: "other", title: "customer a" }], "Customer A"), { code: "SP_AMBIGUOUS_PROJECT" });
  assert.throws(() => resolveNamedEntity([{ id: "a", title: "urgent" }, { id: "b", title: "URGENT" }], "urgent", "tag"), { code: "SP_AMBIGUOUS_TAG" });
});

test("explicit unknown project or tag never falls back to the default project", async () => {
  const { sdk } = fixture([], { projects: [{ id: "p", title: "Work" }, { id: "default", title: "Default" }], tags: [{ id: "t", title: "Urgent" }] });
  const defaultCfg = { ...cfg, defaultProjectId: "default" };
  await assert.rejects(normalizeTaskInput(sdk, defaultCfg, { title: "x", projectTitle: "Unknown" }), { code: "SP_NO_PROJECT" });
  await assert.rejects(normalizeTaskInput(sdk, defaultCfg, { title: "x", tags: ["Unknown"] }), { code: "SP_NO_TAG" });
  assert.equal((await normalizeTaskInput(sdk, defaultCfg, { title: "x" })).projectId, "default");
  assert.deepEqual((await normalizeTaskInput(sdk, cfg, { title: "x", tags: ["Urgent", "urgent"] })).tagIds, ["t"]);
});

test("04:00 day ranges follow local calendar days across daylight-saving transitions", () => {
  const code = `
    import assert from 'node:assert/strict';
    import { dayRange, dayStartMs, shiftDay } from './sp-tasks/lib/date.js';
    for (const [day, hours] of [['2026-03-07', 23], ['2026-10-31', 25]]) {
      const [start, end] = dayRange(day);
      assert.equal(new Date(start).getHours(), 4);
      assert.equal(new Date(end).getHours(), 4);
      assert.equal(end, dayStartMs(shiftDay(day, 1)));
      assert.equal((end - start) / 3600000, hours);
    }
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, TZ: "America/New_York" },
    stdio: "pipe",
  });
});
