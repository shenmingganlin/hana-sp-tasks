import { createHash, randomUUID } from "node:crypto";

const VERSION = 2;
const PREFIX = "sp-tasks:archive-journal:v2:";
const LEGACY_PREFIX = "sp-tasks:archive-snapshot:";
const PHASES = new Set(["prepared", "archived", "restoring", "pending", "complete"]);
const STAGES = new Set(["archive", "restore", "completion"]);
const queues = new Map();
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const identifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 240 && value === value.trim() && !/[\u0000-\u001f\u007f\\/]/.test(value) && value !== "." && value !== "..";

export class ArchiveJournalError extends Error {
  constructor(code, message) { super(message); this.name = "ArchiveJournalError"; this.code = code; }
}
function fail(code, message) { throw new ArchiveJournalError(code, message); }
function input(message) { fail("SP_ARCHIVE_BAD_INPUT", message); }

export function completionOf(task) {
  if (!record(task) || typeof task.isDone !== "boolean") input("A boolean completion state is required.");
  const result = { isDone: task.isDone, doneOn: task.doneOn ?? null, wontDoOn: task.wontDoOn ?? null };
  for (const key of ["doneOn", "wontDoOn"]) if (result[key] !== null && !timestamp(result[key])) input("Invalid completion timestamp.");
  return result;
}
/** SP's archive clears dueDay/dueWithTime; returns them for the journal, or null when the task is unscheduled. */
export function scheduleOf(task) {
  const dueDay = typeof task?.dueDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDay) ? task.dueDay : null;
  const dueWithTime = timestamp(task?.dueWithTime) && task.dueWithTime > 0 ? task.dueWithTime : null;
  return dueDay === null && dueWithTime === null ? null : { dueDay, dueWithTime };
}
export function sameSchedule(left, right) {
  return (left?.dueDay ?? null) === (right?.dueDay ?? null) && (left?.dueWithTime ?? null) === (right?.dueWithTime ?? null);
}
function checkSchedule(value) {
  if (!record(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "dueDay") || !Object.hasOwn(value, "dueWithTime") || !sameSchedule(scheduleOf(value), value) || scheduleOf(value) === null) throw new Error("Invalid schedule.");
}
/** A parent's timeEstimate is derived by SP from its subtasks; the journal keeps the pre-archive value. */
export const estimate = (value) => Number.isSafeInteger(value) && value >= 0;
export function sameCompletion(left, right) {
  const a = completionOf(left), b = completionOf(right);
  return a.isDone === b.isDone && a.doneOn === b.doneOn && a.wontDoOn === b.wontDoOn;
}

export function archiveScope(cfg) {
  let url;
  try { url = new URL(cfg?.baseUrl); } catch { fail("SP_ARCHIVE_SCOPE", "A valid SP connection is required for archive recovery."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || typeof cfg?.accessToken !== "string" || !cfg.accessToken.trim()) fail("SP_ARCHIVE_SCOPE", "A valid SP connection is required for archive recovery.");
  return createHash("sha256").update(JSON.stringify([url.href.replace(/\/+$/, ""), cfg.accessToken.trim()])).digest("hex");
}

function phaseOf(items) {
  if (items.every((item) => item.phase === "complete")) return "complete";
  return ["pending", "restoring", "archived", "prepared"].find((phase) => items.some((item) => item.phase === phase));
}
function checkCompletion(value) {
  if (!record(value) || Object.keys(value).length !== 3 || !["isDone", "doneOn", "wontDoOn"].every((key) => Object.hasOwn(value, key))) throw new Error("Invalid completion state.");
  if (value.doneOn === undefined || value.wontDoOn === undefined) throw new Error("Completion timestamps must use null for absent values.");
  completionOf(value);
}
function checkError(value) {
  if (!record(value) || Object.keys(value).some((key) => !["code", "message", "outcomeUnknown"].includes(key)) || typeof value.code !== "string" || !value.code || value.code.length > 100 || typeof value.message !== "string" || value.message.length > 2000 || Object.hasOwn(value, "outcomeUnknown") && typeof value.outcomeUnknown !== "boolean") throw new Error("Invalid recovery error.");
}
function checkItem(item) {
  if (!record(item) || !identifier(item.taskId) || !PHASES.has(item.phase) || item.parentId !== null && !identifier(item.parentId)) throw new Error("Invalid journal item.");
  checkCompletion(item.original);
  if (Object.hasOwn(item, "schedule")) checkSchedule(item.schedule);
  if (Object.hasOwn(item, "estimate") && !estimate(item.estimate)) throw new Error("Invalid estimate.");
  if (Object.hasOwn(item, "expected")) checkCompletion(item.expected);
  if (Object.hasOwn(item, "restoredParentId") && item.restoredParentId !== null && !identifier(item.restoredParentId)) throw new Error("Invalid restored parent.");
  if (Object.hasOwn(item, "error")) checkError(item.error);
  if (Object.hasOwn(item, "stage") && !STAGES.has(item.stage)) throw new Error("Invalid recovery stage.");
}
function validateDocument(value, scope) {
  try {
    if (!record(value) || value.version !== VERSION || value.scope !== scope || !Array.isArray(value.roots)) throw new Error("Invalid journal document.");
    const generations = new Set(), liveTasks = new Set();
    for (const root of value.roots) {
      if (!record(root) || !identifier(root.rootId) || typeof root.generation !== "string" || !root.generation || generations.has(root.generation) || !timestamp(root.createdAt) || !timestamp(root.updatedAt) || !Array.isArray(root.items) || !root.items.length) throw new Error("Invalid journal root.");
      generations.add(root.generation);
      const ids = new Set();
      for (const item of root.items) {
        checkItem(item);
        if (ids.has(item.taskId) || item.phase !== "complete" && liveTasks.has(item.taskId)) throw new Error("Ambiguous recovery ownership.");
        ids.add(item.taskId);
        if (item.phase !== "complete") liveTasks.add(item.taskId);
      }
      if (!ids.has(root.rootId) || root.phase !== phaseOf(root.items)) throw new Error("Invalid journal phase.");
    }
  } catch { fail("SP_ARCHIVE_JOURNAL_CORRUPT", "Stored archive recovery data is invalid; it has not been overwritten."); }
  return value;
}

/** Callers also serialize the surrounding SP writes; this lock protects storage read/modify/write. */
function exclusive(scope, operation) {
  const previous = queues.get(scope) || Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => {}, () => {});
  queues.set(scope, settled);
  void settled.then(() => { if (queues.get(scope) === settled) queues.delete(scope); });
  return result;
}

export function createArchiveJournal(sdk, cfg) {
  const scope = archiveScope(cfg), key = PREFIX + scope, storage = sdk?.storage?.global;
  function supported() {
    if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") fail("SP_ARCHIVE_STORAGE", "Persistent archive recovery storage is unavailable.");
  }
  async function load() {
    supported();
    let value;
    try { value = await storage.get(key); } catch { fail("SP_ARCHIVE_STORAGE", "Could not read archive recovery data."); }
    return value == null ? { version: VERSION, scope, roots: [] } : validateDocument(clone(value), scope);
  }
  async function save(document) {
    validateDocument(document, scope);
    try { await storage.set(key, clone(document)); } catch { fail("SP_ARCHIVE_STORAGE", "Could not persist archive recovery data."); }
  }
  function locate(document, ref) {
    if (!record(ref) || !identifier(ref.rootId) || typeof ref.generation !== "string") input("A recovery generation is required.");
    const root = document.roots.find((item) => item.rootId === ref.rootId && item.generation === ref.generation);
    if (!root) fail("SP_ARCHIVE_STALE", "This recovery record was replaced or consumed.");
    return root;
  }
  return {
    scope,
    list: () => exclusive(scope, async () => clone((await load()).roots)),
    find(taskId) {
      return exclusive(scope, async () => {
        if (!identifier(taskId)) input("An exact task ID is required.");
        const matches = (await load()).roots.filter((root) => root.items.some((item) => item.taskId === taskId));
        const live = matches.find((root) => root.items.some((item) => item.taskId === taskId && item.phase !== "complete"));
        return clone(live || matches.at(-1) || null);
      });
    },
    prepare(rootId, tasks) {
      return exclusive(scope, async () => {
        if (!identifier(rootId) || !Array.isArray(tasks) || !tasks.length) input("An archive root and its task states are required.");
        const ids = new Set();
        const items = tasks.map((task) => {
          if (!record(task) || !identifier(task.taskId) || ids.has(task.taskId) || task.parentId !== null && !identifier(task.parentId)) input("Invalid or duplicate archive task.");
          ids.add(task.taskId);
          checkCompletionInput(task.original);
          if (task.schedule !== undefined && task.schedule !== null) { try { checkSchedule(task.schedule); } catch { input("Invalid archive schedule."); } }
          if (task.estimate !== undefined && !estimate(task.estimate)) input("Invalid archive estimate.");
          return { taskId: task.taskId, original: completionOf(task.original), ...(task.schedule ? { schedule: clone(task.schedule) } : {}), ...(task.estimate !== undefined ? { estimate: task.estimate } : {}), parentId: task.parentId, phase: "prepared" };
        });
        if (!ids.has(rootId)) input("The archive root must be included in its recovery record.");
        const document = await load();
        if (document.roots.some((root) => root.items.some((item) => ids.has(item.taskId) && item.phase !== "complete"))) fail("SP_ARCHIVE_PENDING", "A selected task already has unfinished archive recovery data.");
        document.roots = document.roots.filter((root) => root.phase !== "complete");
        const now = Date.now();
        const root = { rootId, generation: randomUUID(), createdAt: now, updatedAt: now, phase: "prepared", items };
        document.roots.push(root);
        await save(document);
        return clone(root);
      });
    },
    mark(ref, taskIds, phase, options = {}) {
      return exclusive(scope, async () => {
        if (!Array.isArray(taskIds) || !taskIds.length || new Set(taskIds).size !== taskIds.length || taskIds.some((id) => !identifier(id)) || !PHASES.has(phase) || !record(options) || Object.keys(options).some((field) => !["expected", "restoredParentId", "error", "stage"].includes(field))) input("Invalid recovery progress update.");
        if (Object.hasOwn(options, "expected")) checkCompletionInput(options.expected);
        if (Object.hasOwn(options, "restoredParentId") && options.restoredParentId !== null && !identifier(options.restoredParentId)) input("Invalid restored parent.");
        if (Object.hasOwn(options, "error")) { try { checkError(options.error); } catch { input("Invalid recovery error."); } }
        if (Object.hasOwn(options, "stage") && !STAGES.has(options.stage)) input("Invalid recovery stage.");
        const document = await load(), root = locate(document, ref);
        for (const taskId of taskIds) {
          const item = root.items.find((entry) => entry.taskId === taskId);
          if (!item) input("The task does not belong to this recovery record.");
          if (item.phase === "complete" && phase !== "complete") fail("SP_ARCHIVE_CONSUMED", "Completed recovery items cannot be replayed.");
          if (phase === "prepared" && item.phase !== "prepared") fail("SP_ARCHIVE_STATE", "Started recovery cannot return to its pre-archive state.");
          Object.assign(item, clone(options), { phase });
          if (!Object.hasOwn(options, "error")) delete item.error;
        }
        root.phase = phaseOf(root.items);
        root.updatedAt = Date.now();
        await save(document);
        return clone(root);
      });
    },
    discard(ref) {
      return exclusive(scope, async () => {
        const document = await load(), root = locate(document, ref);
        if (root.items.some((item) => item.phase !== "prepared")) fail("SP_ARCHIVE_PENDING", "Recovery data cannot be discarded after an archive may have run.");
        document.roots = document.roots.filter((item) => item !== root);
        await save(document);
      });
    },
    legacy(taskId) {
      return exclusive(scope, async () => {
        if (!identifier(taskId)) input("An exact task ID is required.");
        supported();
        if (typeof storage.keys !== "function") fail("SP_ARCHIVE_STORAGE", "Legacy archive recovery data cannot be inspected.");
        try {
          const keys = await storage.keys();
          if (!Array.isArray(keys)) throw new Error("Invalid storage keys.");
          const matches = [];
          for (const legacyKey of keys) {
            if (typeof legacyKey !== "string" || !legacyKey.startsWith(LEGACY_PREFIX)) continue;
            const value = await storage.get(legacyKey);
            const sourceRootId = legacyKey.slice(LEGACY_PREFIX.length);
            const contains = record(value?.isDoneById) && Object.hasOwn(value.isDoneById, taskId);
            if (!contains && sourceRootId !== taskId) continue;
            matches.push({ sourceRootId, originalIsDone: contains && typeof value.isDoneById[taskId] === "boolean" ? value.isDoneById[taskId] : null });
          }
          return matches.length ? { kind: "legacy", unscoped: true, incompleteMetadata: true, matches } : null;
        } catch { fail("SP_ARCHIVE_STORAGE", "Could not inspect legacy archive recovery data."); }
      });
    },
  };
}

function checkCompletionInput(value) {
  try { checkCompletion(value); } catch { input("A complete original completion state is required."); }
}
