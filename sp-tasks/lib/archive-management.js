import { SpError, sp } from "./sp.js";
import { taskIds } from "./task-input.js";
import { archiveScope, createArchiveJournal, completionOf, sameCompletion, scheduleOf, sameSchedule, estimate } from "./archive-snapshot.js";
import { invalidateNotice } from "./notice.js";

const operations = new Map();
const pending = (item) => ["restoring", "pending"].includes(item.phase);
const parentId = (task) => task.parentId || null;
const fail = (code, message, unknown = false) => {
  const error = new SpError(code, message);
  if (unknown) error.outcomeUnknown = true;
  throw error;
};
const detail = (error) => ({
  code: error?.code || "SP_RECOVERY_ERROR",
  message: String(error?.message || error).slice(0, 2000),
  outcomeUnknown: error?.outcomeUnknown === true,
});

function exclusive(scope, work) {
  const result = (operations.get(scope) || Promise.resolve()).then(work, work);
  const settled = result.then(() => {}, () => {});
  operations.set(scope, settled);
  void settled.then(() => { if (operations.get(scope) === settled) operations.delete(scope); });
  return result;
}

function graph(rows) {
  const tasks = new Map(), parents = new Map();
  // REST task lists are flat. A parent's subTasks can retain an old archive
  // snapshot after the real child has left that store; it is not membership.
  for (const row of rows) {
    if (!row || typeof row.id !== "string") fail("SP_BAD_RESPONSE", "SP returned an invalid task tree.");
    if (!tasks.has(row.id)) tasks.set(row.id, row);
    const link = (child, parent) => {
      if (!child || !parent) return;
      if (typeof child !== "string" || typeof parent !== "string" || parents.has(child) && parents.get(child) !== parent) {
        fail("SP_BAD_RESPONSE", "SP returned contradictory task ancestry.");
      }
      parents.set(child, parent);
    };
    link(row.id, row.parentId);
    for (const child of row.subTaskIds || []) link(child, row.id);
  }
  for (const id of parents.keys()) {
    let cursor = id;
    const seen = new Set();
    while (cursor) {
      if (seen.has(cursor)) fail("SP_BAD_RESPONSE", "SP returned cyclic task ancestry.");
      seen.add(cursor);
      cursor = parents.get(cursor);
    }
  }
  return { tasks, parents };
}

function subtree(tree, id) {
  const selected = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of tree.parents) if (selected.has(parent) && !selected.has(child)) {
      selected.add(child); grew = true;
    }
  }
  return [...selected];
}

function rootsOf(ids, tree) {
  const selected = new Set(ids);
  return new Map(ids.map((id) => {
    let root = id, cursor = tree.parents.get(id);
    while (cursor) {
      if (selected.has(cursor)) root = cursor;
      cursor = tree.parents.get(cursor);
    }
    return [id, root];
  }));
}

function needsPlugin(original, expected) {
  if (sameCompletion(original, expected)) return false;
  return original.isDone !== false || original.doneOn !== null || original.wontDoOn !== expected.wontDoOn;
}

export function createTaskManager(sdk, { bridge } = {}) {
  async function read(cfg, source) {
    return graph(await sp.tasks(sdk, cfg, { source, includeDone: "true" }));
  }
  async function state(cfg, inspectIds = []) {
    // source=active hides tasks whose project is archived. Exact GETs also
    // detect tasks temporarily present in both stores during archive cleanup.
    const [all, archived] = await Promise.all([read(cfg, "all"), read(cfg, "archived")]);
    const activeRows = new Map([...all.tasks].filter(([id]) => !archived.tasks.has(id)));
    for (const id of new Set(inspectIds)) {
      try { activeRows.set(id, await sp.task(sdk, cfg, id)); }
      catch (error) {
        if (error.status !== 404) throw error;
        activeRows.delete(id);
      }
    }
    return { active: graph([...activeRows.values()]), archived };
  }
  async function requirePlugin() {
    let status;
    try { status = await bridge?.status(); } catch { /* The preflight error below is actionable. */ }
    const version = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(status?.pluginVersion || "");
    if (!status?.connected || !version || Number(version[1]) === 0 && Number(version[2]) < 2) {
      fail("SP_COMPLETION_BRIDGE_REQUIRED", "Preserving completion dates and won't-do state requires a connected Hana SP bridge 0.2.0 or newer. Pair the plugin before continuing completion recovery.");
    }
  }

  async function safeCompletion(cfg, task, desired, expected, active) {
    if (!desired.isDone || expected.isDone) return;
    const parent = active.tasks.get(task.parentId);
    if ([task, parent].some((row) => row && ["issueId", "issueProviderId", "issueType"].some((key) => row[key] != null && row[key] !== ""))) {
      fail("SP_COMPLETION_ISSUE_UNSUPPORTED", "Restoring completion on a linked issue may trigger external status or worklog updates. SP does not provide an API that suppresses these effects.");
    }
    if (task.parentId && parent?.isDone !== true) {
      fail("SP_COMPLETION_PARENT_UNSUPPORTED", "Completing this restored child could modify its parent or access a parent still in the archive. Preserve-mode restore requires an already completed active parent.");
    }
    const repeatId = task.repeatCfgId;
    if (repeatId) {
      let repeat;
      try { repeat = await sp.request(sdk, cfg, "GET", `/task-repeat-cfgs/${encodeURIComponent(repeatId)}`); }
      catch { fail("SP_COMPLETION_REPEAT_UNSUPPORTED", "The task's repeat rule cannot be checked before restoring completion."); }
      if (repeat?.id !== repeatId || ["waitForCompletion", "repeatFromCompletionDate"].some((key) => repeat[key] !== undefined && typeof repeat[key] !== "boolean")) {
        fail("SP_COMPLETION_REPEAT_UNSUPPORTED", "SP did not return a valid matching repeat rule.");
      }
      if (repeat.waitForCompletion || repeat.repeatFromCompletionDate) {
        fail("SP_COMPLETION_REPEAT_UNSUPPORTED", "Restoring completion would reschedule this repeat rule or create a new occurrence. SP does not provide an API that suppresses these side effects.");
      }
    }
  }

  // SP's archive clears dueDay/dueWithTime. Write the saved values back only while
  // the restored task is still unscheduled, so a schedule set after restore is kept.
  async function restoreSchedule(cfg, item, sync) {
    if (!item.schedule || scheduleOf(await sp.task(sdk, cfg, item.taskId)) !== null) return;
    const body = Object.fromEntries(Object.entries(item.schedule).filter(([, value]) => value !== null));
    try { await sp.updateTask(sdk, cfg, item.taskId, body); }
    finally { invalidateNotice(); }
    if (!sameSchedule(scheduleOf(await sp.task(sdk, cfg, item.taskId)), item.schedule)) {
      fail("SP_SCHEDULE_VERIFY_FAILED", "SP did not retain the task's pre-archive schedule. Recovery data was kept.", true);
    }
    sync.rescheduled++;
  }

  // Repairing a child's completion makes SP recompute its parent's timeEstimate as the
  // subtasks' remaining time. Put the pre-archive value back only while the parent
  // still holds exactly that recomputed value, so an estimate the user set is kept.
  async function restoreEstimate(cfg, item, sync) {
    const parent = await sp.task(sdk, cfg, item.taskId);
    if (parent.timeEstimate === item.estimate) return;
    const children = [];
    for (const id of parent.subTaskIds || []) {
      try { children.push(await sp.task(sdk, cfg, id)); }
      catch (error) { if (error.status === 404) return; throw error; }
    }
    const derived = children.reduce((sum, child) => sum + (child.isDone ? 0 : Math.max(0, (child.timeEstimate || 0) - (child.timeSpent || 0))), 0);
    if (parent.timeEstimate !== derived) return;
    try { await sp.updateTask(sdk, cfg, item.taskId, { timeEstimate: item.estimate }); }
    finally { invalidateNotice(); }
    if ((await sp.task(sdk, cfg, item.taskId)).timeEstimate !== item.estimate) {
      fail("SP_ESTIMATE_VERIFY_FAILED", "SP did not retain the parent's pre-archive estimate. Recovery data was kept.", true);
    }
    sync.estimatesRestored++;
  }

  async function repairEntries(cfg, journal, entries, sync, { keepCurrent = false } = {}) {
    const failures = [], deferred = [];
    const failed = async (ref, item, error) => {
      const failure = { id: item.taskId, ...detail(error) };
      failures.push(failure);
      sync.failed.push(failure);
      try { await journal.mark(ref, [item.taskId], "pending", { stage: "completion", error: detail(error) }); }
      catch { /* The durable restoring record still permits recovery. */ }
    };
    const locations = await state(cfg, entries.map(({ item }) => item.taskId));
    for (const entry of entries) {
      const { ref, item } = entry;
      sync.checked++;
      try {
        if (locations.archived.tasks.has(item.taskId) || !locations.active.tasks.has(item.taskId)) {
          fail("SP_RESTORE_PENDING", "The task has not fully left the archive. Query its state before continuing recovery.");
        }
        const current = await sp.task(sdk, cfg, item.taskId), actual = completionOf(current);
        if (!keepCurrent && !sameCompletion(actual, item.original)) {
          if (!item.expected || !sameCompletion(actual, item.expected) || parentId(current) !== item.restoredParentId) {
            fail("SP_COMPLETION_CONFLICT", "The task changed after restore. Its current completion was preserved; inspect it before choosing to keep the current state.");
          }
          await safeCompletion(cfg, current, item.original, actual, locations.active);
          if (needsPlugin(item.original, item.expected)) {
            await requirePlugin();
            try {
              const result = await bridge.execute("tasks.repairCompletion", {
                taskId: item.taskId, expected: actual, desired: item.original,
              });
              if (result?.id !== item.taskId || !result.completion || !sameCompletion(result.completion, item.original)) {
                fail("SP_COMPLETION_VERIFY_FAILED", "The plugin did not confirm the requested completion metadata.", true);
              }
            } finally { invalidateNotice(); }
          } else {
            // REST can clear a completion stamp; it cannot restore a historical stamp.
            await sp.updateTask(sdk, cfg, item.taskId, { isDone: false });
          }
          const verified = await sp.task(sdk, cfg, item.taskId);
          if (!sameCompletion(completionOf(verified), item.original)) {
            fail("SP_COMPLETION_VERIFY_FAILED", "SP did not retain the requested completion metadata. Recovery data was kept.", true);
          }
          sync.fixed++;
        }
        if (!keepCurrent) await restoreSchedule(cfg, item, sync);
        if (!keepCurrent && item.estimate !== undefined) { deferred.push(entry); continue; }
        await journal.mark(ref, [item.taskId], "complete", { stage: "completion" });
      } catch (error) { await failed(ref, item, error); }
    }
    // Parents last: their estimate settles only after every child repair has run.
    for (const { ref, item } of deferred) {
      try {
        if (failures.some((failure) => entries.some((other) => other.item.taskId === failure.id && other.item.parentId === item.taskId))) {
          fail("SP_ESTIMATE_PENDING", "A subtask repair is unfinished; the parent's pre-archive estimate is restored once it completes.");
        }
        await restoreEstimate(cfg, item, sync);
        await journal.mark(ref, [item.taskId], "complete", { stage: "completion" });
      } catch (error) { await failed(ref, item, error); }
    }
    return failures;
  }

  return async (args, cfg) => {
    try {
      if (!args || !["archive", "restore", "delete", "repair", "recovery"].includes(args.action)) fail("SP_BAD_INPUT", "Unknown task management action.");
      const ids = taskIds(args.taskIds);
      for (const key of Object.keys(args)) if (!["action", "taskIds", "allowCompletionLoss", "keepCurrentCompletion"].includes(key)) fail("SP_BAD_INPUT", `Unsupported task management argument: ${key}.`);
      for (const key of ["allowCompletionLoss", "keepCurrentCompletion"]) if (args[key] !== undefined && typeof args[key] !== "boolean") fail("SP_BAD_INPUT", `${key} must be boolean.`);
      if (args.allowCompletionLoss !== undefined && args.action !== "restore" || args.keepCurrentCompletion !== undefined && args.action !== "repair") fail("SP_BAD_INPUT", "Completion options are only valid for their respective restore/repair action.");
      return await exclusive(archiveScope(cfg), async () => {
        const journal = createArchiveJournal(sdk, cfg);
        if (args.action === "recovery") {
          const recoveries = [];
          for (const id of ids) recoveries.push({ id, record: await journal.find(id), legacy: await journal.legacy(id) });
          return { action: args.action, recoveries };
        }
        const initial = await state(cfg, ids);
        const tree = graph([...initial.active.tasks.values(), ...initial.archived.tasks.values()]);
        const rootOf = rootsOf(ids, tree), rootResults = new Map();
        const sync = { checked: 0, fixed: 0, rescheduled: 0, estimatesRestored: 0, failed: [], restoredFromSnapshot: [], degradedRoots: [] };
        for (const id of new Set(rootOf.values())) {
          let restored = false;
          try {
            if (args.action === "delete") {
              // SP's REST DELETE only searches active tasks and reports archived ones as TASK_NOT_FOUND.
              if (!initial.active.tasks.has(id) && initial.archived.tasks.has(id)) fail("SP_TASK_ARCHIVED", "The task is archived; SP cannot delete archived tasks through its API. Restore it first, then delete it.");
              await sp.deleteTask(sdk, cfg, id);
              rootResults.set(id, { id, ok: true });
              continue;
            }
            if (args.action === "archive") {
              const before = (await state(cfg, [id])).active, existing = await journal.find(id);
              if (!before.tasks.has(id) && existing && existing.items.every((item) => item.phase === "prepared" || item.phase === "archived")) {
                const after = await state(cfg, existing.items.map((item) => item.taskId));
                if (existing.items.every((item) => after.archived.tasks.has(item.taskId) && !after.active.tasks.has(item.taskId))) {
                  await journal.mark(existing, existing.items.map((item) => item.taskId), "archived", { stage: "archive" });
                  rootResults.set(id, { id, ok: true });
                  continue;
                }
              }
              if (!before.tasks.has(id)) fail("SP_TASK_NOT_FOUND", "The active task does not exist.");
              if (before.parents.has(id)) fail("SP_SUBTASK_ARCHIVE_UNSUPPORTED", "SP cannot reliably archive a subtask alone. Explicitly select its parent if the entire family should be archived.");
              const family = subtree(before, id);
              const originals = family.map((taskId) => {
                const task = before.tasks.get(taskId);
                if (!task) fail("SP_INCOMPLETE_TASK_TREE", "A referenced subtask is missing; no archive was started.");
                const hasChildren = family.some((other) => before.parents.get(other) === taskId);
                return { taskId, original: completionOf(task), schedule: scheduleOf(task), ...(hasChildren && estimate(task.timeEstimate) ? { estimate: task.timeEstimate } : {}), parentId: parentId(task) };
              });
              let ref;
              if (existing?.items.every((item) => item.phase === "prepared") && existing.items.length === originals.length && originals.every((task) => existing.items.some((item) => item.taskId === task.taskId && item.parentId === task.parentId && sameCompletion(item.original, task.original) && sameSchedule(item.schedule, task.schedule) && item.estimate === task.estimate))) ref = existing;
              else ref = await journal.prepare(id, originals);
              try { await sp.archiveTask(sdk, cfg, id); }
              catch (error) {
                if (!error.outcomeUnknown) await journal.discard(ref);
                throw error;
              }
              try {
                const after = await state(cfg, family);
                if (!family.every((taskId) => after.archived.tasks.has(taskId) && !after.active.tasks.has(taskId))) fail("SP_ARCHIVE_VERIFY_FAILED", "SP acknowledged archive but the complete task family was not found exclusively in the archive.", true);
                await journal.mark(ref, family, "archived", { stage: "archive" });
              } catch (error) { error.outcomeUnknown = true; throw error; }
              rootResults.set(id, { id, ok: true });
              continue;
            }

            const before = await state(cfg, [id]), record = await journal.find(id);
            if (args.action === "repair" || !before.archived.tasks.has(id)) {
              if (!record) fail("SP_NO_PENDING_RESTORE", "No saved recovery exists for this task on the current SP connection.");
              const selected = new Set(id === record.rootId ? record.items.map((item) => item.taskId) : subtree(graph(record.items.map((item) => ({ id: item.taskId, parentId: item.parentId }))), id));
              const entries = record.items.filter((item) => selected.has(item.taskId) && item.phase !== "complete" && (pending(item) || args.keepCurrentCompletion === true)).map((item) => ({ ref: record, item }));
              if (!entries.length) {
                if (record.items.filter((item) => selected.has(item.taskId)).every((item) => item.phase === "complete") && before.active.tasks.has(id)) {
                  rootResults.set(id, { id, ok: true });
                  continue;
                }
                fail("SP_NO_PENDING_RESTORE", "The task was not restored by this recovery operation. Existing active tasks are not overwritten.");
              }
              restored = entries.some(({ item }) => before.active.tasks.has(item.taskId));
              const failed = await repairEntries(cfg, journal, entries, sync, { keepCurrent: args.keepCurrentCompletion === true });
              if (failed.length) fail(failed[0].code, failed[0].message, failed.some((item) => item.outcomeUnknown));
              rootResults.set(id, { id, ok: true });
              continue;
            }

            // Persist the exact expected native result before REST can move anything.
            // Only tasks currently archived are eligible; previously restored children are untouched.
            const family = subtree(before.archived, id).filter((taskId) => before.archived.tasks.has(taskId) && !before.active.tasks.has(taskId));
            if (!family.includes(id)) fail("SP_RESTORE_PENDING", "This task is still present in both stores; wait for SP archive cleanup.");
            const entries = [], missing = [];
            for (const taskId of family) {
              const ref = await journal.find(taskId), item = ref?.items.find((entry) => entry.taskId === taskId && entry.phase !== "complete");
              if (!item) { missing.push({ id: taskId, legacy: !!await journal.legacy(taskId) }); continue; }
              const archivedTask = before.archived.tasks.get(taskId);
              if (item.parentId !== parentId(archivedTask) || taskId !== id && parentId(archivedTask) !== before.archived.parents.get(taskId)) {
                fail("SP_COMPLETION_CONFLICT", "The archived task hierarchy changed since its snapshot. Restore was not started.");
              }
              const archivedCompletion = completionOf(archivedTask);
              const expected = taskId === id ? { ...archivedCompletion, isDone: false, doneOn: null } : archivedCompletion;
              if (args.allowCompletionLoss !== true && item.original.wontDoOn !== expected.wontDoOn) fail("SP_COMPLETION_CONFLICT", "The archived won't-do marker changed. The saved completion cannot be applied safely.");
              if (args.allowCompletionLoss !== true) await safeCompletion(cfg, archivedTask, item.original, expected, before.active);
              entries.push({ ref, item: { ...item, expected, restoredParentId: parentId(archivedTask) } });
            }
            if (missing.length && args.allowCompletionLoss !== true) {
              fail(missing.some((item) => item.legacy) ? "SP_COMPLETION_SNAPSHOT_LEGACY" : "SP_COMPLETION_SNAPSHOT_MISSING", "The original completion metadata is unavailable on this connection. This task was not restored. Use allowCompletionLoss only when the user accepts SP's native completion changes.");
            }
            if (entries.some(({ item }) => needsPlugin(item.original, item.expected)) && args.allowCompletionLoss !== true) await requirePlugin();
            for (const entry of entries) await journal.mark(entry.ref, [entry.item.taskId], "restoring", { expected: entry.item.expected, restoredParentId: entry.item.restoredParentId, stage: "restore" });
            try { await sp.restoreTask(sdk, cfg, id); restored = true; }
            catch (error) {
              for (const entry of entries) {
                try { await journal.mark(entry.ref, [entry.item.taskId], "pending", { stage: "restore", error: detail(error) }); } catch { /* Restoring remains durable. */ }
              }
              throw error;
            }
            const after = await state(cfg, family);
            if (!family.every((taskId) => after.active.tasks.has(taskId) && !after.archived.tasks.has(taskId))) fail("SP_RESTORE_PENDING", "SP did not confirm that the complete selected family left the archive. Recovery data was kept.", true);
            if (args.allowCompletionLoss === true) {
              const pendingIds = [];
              for (const entry of entries) {
                let matches = sameCompletion(completionOf(after.active.tasks.get(entry.item.taskId)), entry.item.original);
                if (matches) {
                  try { await restoreSchedule(cfg, entry.item, sync); }
                  catch (error) { matches = false; sync.failed.push({ id: entry.item.taskId, ...detail(error) }); }
                }
                await journal.mark(entry.ref, [entry.item.taskId], matches ? "complete" : "pending", { stage: "completion" });
                if (!matches) pendingIds.push(entry.item.taskId);
              }
              sync.degradedRoots.push(id);
              rootResults.set(id, { id, ok: true, degraded: true, completionPreserved: false, missingCompletionIds: missing.map((item) => item.id), pendingCompletionIds: pendingIds });
              continue;
            }
            if (entries.length) sync.restoredFromSnapshot.push(id);
            const failed = await repairEntries(cfg, journal, entries, sync);
            if (failed.length) fail(failed[0].code, failed[0].message, failed.some((item) => item.outcomeUnknown));
            rootResults.set(id, { id, ok: true, ...(missing.length ? { degraded: true, missingCompletionIds: missing.map((item) => item.id) } : {}) });
          } catch (error) {
            rootResults.set(id, { id, ok: false, ...detail(error), ...(restored ? { restored: true } : {}), ...(["restore", "repair"].includes(args.action) ? { retry: { tool: "sp_tasks_manage", args: { action: "recovery", taskIds: [id] } } } : {}) });
          }
        }
        const results = ids.map((id) => {
          const root = rootOf.get(id), result = rootResults.get(root);
          return id === root ? result : { ...result, id, coveredBy: root };
        });
        const changed = results.filter((result) => result.ok).length, failed = results.length - changed;
        return {
          action: args.action, changed, failed, results,
          ...(changed && failed || results.some((result) => result.restored || result.outcomeUnknown) || sync.degradedRoots.length ? { partial: true } : {}),
          ...(results.some((result) => result.outcomeUnknown) ? { outcomeUnknown: true } : {}),
          ...(["restore", "repair"].includes(args.action) ? { completionSync: sync } : {}),
        };
      });
    } catch (error) {
      if (error instanceof SpError) throw error;
      const translated = new SpError(error?.code || "SP_RECOVERY_ERROR", String(error?.message || error));
      if (error?.outcomeUnknown) translated.outcomeUnknown = true;
      throw translated;
    }
  };
}
