import { executePreferences } from "./preferences.mjs";
import { executeCounterControl } from "./counter-control.mjs";
import { executeWorkContext } from "./work-context.mjs";
import { executeUiControl } from "./ui-control.mjs";
import { executeAttachments } from "./attachments.mjs";
import { executeKeyboard } from "./keyboard.mjs";

export const VERSION = "0.6.0";
export const PROTOCOL = 1;
export const BRIDGE_URL = "http://127.0.0.1:3877";
const SECRET_KEY = "hana.local-pairing.v1";
const DEFAULT_PROJECT_COLOR = "#29a1aa";
const MAX_RESULT_BYTES = 1048576;
const MAX_RECEIPTS = 1024;
const MAX_CACHE_BYTES = 8 * 1048576;
const COMPLETION_KEYS = ["isDone", "doneOn", "wontDoOn"];
const MAX_TIMESTAMP = 8640000000000000;
const PROTECTED = new Set(["INBOX_PROJECT", "TODAY"]);
const OPS = new Set(["projects.list", "projects.create", "projects.update", "projects.delete", "tags.list", "tags.create", "tags.update", "tasks.repairCompletion", "tasks.reparent", "counters.list", "counters.update", "counters.delete", "taskOrder.list", "taskOrder.update", "selection.list", "selection.select", "preferences.list", "preferences.update", "counterControl.list", "counterControl.start", "counterControl.stop", "workContext.list", "workContext.switch", "ui.command", "attachments.list", "attachments.add", "attachments.remove", "keyboard.list", "keyboard.update"]);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

export class BridgeError extends Error {
  constructor(code, message, outcomeUnknown = false) {
    super(message);
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}
const fail = (code, message) => { throw new BridgeError(code, message); };
const bad = (message) => fail("SP_BAD_INPUT", message);

function only(value, keys) {
  if (!record(value)) bad("Arguments must be an object.");
  if (Object.keys(value).some((key) => !keys.includes(key))) bad("Unsupported argument.");
}
function text(value, key, empty = false, max = 240) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (!empty && !value.trim())) bad(`${key} must be a single-line string of at most ${max} characters.`);
  return value.trim();
}
function id(value) {
  const v = text(value, "id");
  if (v !== value || v === "." || v === ".." || /[\/\\]/.test(v)) bad("An exact entity ID, not a path, is required.");
  return v;
}
function changes(args, project, creating) {
  const result = {};
  if (own(args, "title")) result.title = text(args.title, "title");
  if (creating && !result.title) bad("title is required when creating.");
  if (own(args, "icon")) {
    result.icon = text(args.icon, "icon", true, 80);
    if (result.icon && !/^[a-z0-9_]+$/i.test(result.icon)) bad("icon must be a Material icon name, or empty to clear.");
  }
  if (own(args, "color")) {
    result.color = text(args.color, "color", true, 7);
    if (result.color && !/^#[a-f0-9]{6}$/i.test(result.color)) bad("color must be #RRGGBB, or empty to reset.");
  }
  if (project) for (const key of ["isEnableBacklog", "isHiddenFromMenu"]) {
    if (own(args, key)) {
      if (typeof args[key] !== "boolean") bad(`${key} must be boolean.`);
      result[key] = args[key];
    }
  }
  if (!creating && !Object.keys(result).length) bad("No editable field was supplied.");
  return result;
}
function values(dictionary, field) {
  if (!record(dictionary)) fail("SP_BAD_STATE", `SP did not return its ${field} snapshot.`);
  const rows = Object.values(dictionary).filter((row) => row != null);
  for (const [key, row] of Object.entries(dictionary)) if (row != null && (!record(row) || row.id !== key)) fail("SP_BAD_STATE", `SP returned inconsistent ${field} IDs.`);
  return rows;
}
function ids(value, field) {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !x)) fail("SP_BAD_STATE", `SP returned invalid ${field}.`);
  return [...new Set(value)];
}
function projection(row, project) {
  if (!record(row) || typeof row.id !== "string" || !row.id || typeof row.title !== "string") fail("SP_BAD_STATE", "SP returned an invalid entity.");
  const out = { id: row.id, title: row.title, color: project ? row.theme?.primary ?? null : row.color ?? null, icon: row.icon ?? null, taskCount: ids(row.taskIds, "taskIds").length };
  if (![out.color, out.icon].every((v) => v === null || typeof v === "string")) fail("SP_BAD_STATE", "SP returned invalid presentation fields.");
  if (project) Object.assign(out, { isArchived: row.isArchived === true, isEnableBacklog: row.isEnableBacklog === true, isHiddenFromMenu: row.isHiddenFromMenu === true, backlogTaskCount: ids(row.backlogTaskIds, "backlogTaskIds").length, noteCount: ids(row.noteIds, "noteIds").length });
  return out;
}
const nameKey = (value) => value.trim().normalize("NFKC").toLowerCase();
function duplicate(rows, title, exceptId) {
  if (title === undefined) return;
  const matches = rows.filter((row) => row.id !== exceptId && typeof row.title === "string" && nameKey(row.title) === nameKey(title));
  if (matches.length) {
    const matchingIds = matches.slice(0, 3).map((row) => id(row.id));
    fail("SP_DUPLICATE_TITLE", `That title already exists. Exact IDs: ${JSON.stringify(matchingIds)}.${matches.length > 3 ? " Additional matches omitted; list entities to inspect them." : ""} No existing entity was reused.`);
  }
}
function find(rows, target, project) {
  const row = rows.find((x) => x.id === target);
  if (!row) fail(project ? "SP_NO_PROJECT" : "SP_NO_TAG", "The exact entity ID does not exist.");
  return row;
}
function patchFor(edit, project, current) {
  const patch = {};
  for (const key of ["title", "isEnableBacklog", "isHiddenFromMenu"]) if (own(edit, key)) patch[key] = edit[key];
  if (own(edit, "icon")) patch.icon = edit.icon || null;
  if (own(edit, "color")) {
    if (project) {
      if (!record(current.theme)) fail("SP_BAD_STATE", "SP project theme is missing; color was not modified.");
      patch.theme = { ...current.theme, primary: edit.color || DEFAULT_PROJECT_COLOR };
    } else patch.color = edit.color || null;
  }
  return patch;
}
function verify(row, edit, project) {
  for (const [key, value] of Object.entries(edit)) {
    const actual = key === "color" && project ? row.theme?.primary : row[key];
    const expected = key === "icon" ? value || null : key === "color" ? value || (project ? DEFAULT_PROJECT_COLOR : null) : value;
    if (actual !== expected) fail("SP_VERIFY_FAILED", "SP did not confirm every requested field. Read the entity before making another change.");
  }
}

const validTimestamp = (value) => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP);
function completionInput(value) {
  only(value, COMPLETION_KEYS);
  if (COMPLETION_KEYS.some((key) => !own(value, key)) || typeof value.isDone !== "boolean" || !validTimestamp(value.doneOn) || !validTimestamp(value.wontDoOn)) bad("Completion requires isDone:boolean and doneOn/wontDoOn as null or integer timestamps from 0 through 8640000000000000.");
  return { isDone: value.isDone, doneOn: value.doneOn, wontDoOn: value.wontDoOn };
}
function activeCompletion(state, taskId) {
  const task = values(state?.tasks, "tasks").find((row) => row.id === taskId);
  if (!task) fail("SP_NO_TASK", "The exact task ID is not in SP's active task store. Archived tasks cannot be repaired here.");
  const completion = { isDone: task.isDone, doneOn: task.doneOn ?? null, wontDoOn: task.wontDoOn ?? null };
  if (typeof completion.isDone !== "boolean" || !validTimestamp(completion.doneOn) || !validTimestamp(completion.wontDoOn)) fail("SP_BAD_STATE", "SP returned invalid task completion metadata.");
  return completion;
}
const sameCompletion = (a, b) => COMPLETION_KEYS.every((key) => a[key] === b[key]);
function guardIssueCompletion(task) {
  if (["issueId", "issueProviderId", "issueType"].some((key) => task[key] != null && task[key] !== "")) {
    fail("SP_COMPLETION_ISSUE_UNSUPPORTED", "Completing this task may trigger linked issue status or worklog actions. Completion repair was not written.");
  }
}
function guardCompletionEffects(state, taskId) {
  const tasks = new Map(values(state?.tasks, "tasks").map((task) => [task.id, task]));
  const task = tasks.get(taskId);
  guardIssueCompletion(task);
  if (task.repeatCfgId) {
    const cfg = typeof task.repeatCfgId === "string" && record(state.taskRepeatCfgs) && own(state.taskRepeatCfgs, task.repeatCfgId) ? state.taskRepeatCfgs[task.repeatCfgId] : null;
    if (!record(cfg) || cfg.id !== task.repeatCfgId || ["waitForCompletion", "repeatFromCompletionDate"].some((key) => cfg[key] !== undefined && typeof cfg[key] !== "boolean") || cfg.waitForCompletion === true || cfg.repeatFromCompletionDate === true) {
      fail("SP_COMPLETION_REPEAT_UNSUPPORTED", "Completing this task may advance a recurring series, or its repeat configuration is unavailable. Completion repair was not written.");
    }
  }
  if (task.parentId) {
    const parent = tasks.get(task.parentId);
    if (!parent || parent.isDone !== true) fail("SP_COMPLETION_PARENT_UNSUPPORTED", "The task's parent is missing or unfinished. Completion repair could alter the parent; no repair was written.");
    guardIssueCompletion(parent);
  }
}
async function repairCompletion(api, args, write) {
  only(args, ["taskId", "expected", "desired"]);
  const taskId = id(args.taskId);
  const expected = completionInput(args.expected);
  const desired = completionInput(args.desired);
  const state = await api.getAppState();
  const current = activeCompletion(state, taskId);
  if (sameCompletion(current, desired)) return { ok: true, data: { id: taskId, completion: current, unchanged: true } };
  if (!sameCompletion(current, expected)) fail("SP_COMPLETION_CONFLICT", "Task completion changed after the expected snapshot. No repair was written; inspect the current task before retrying.");
  if (desired.wontDoOn !== current.wontDoOn || typeof api.updateTask !== "function") fail("SP_COMPLETION_UNSUPPORTED", "SP's public plugin API cannot change wontDoOn or does not provide updateTask. The repair was not written.");
  const patch = { doneOn: desired.doneOn };
  if (current.isDone !== desired.isDone) {
    if (desired.isDone) guardCompletionEffects(state, taskId);
    patch.isDone = desired.isDone;
  }
  // Explicit null becomes an own undefined field in SP's mapper, overriding its automatic timestamp.
  await write(() => api.updateTask(taskId, patch));
  const completion = activeCompletion(await api.getAppState(), taskId);
  if (!sameCompletion(completion, desired)) fail("SP_VERIFY_FAILED", "SP did not confirm all requested completion metadata. Inspect the task before retrying.");
  return { ok: true, data: { id: taskId, completion, unchanged: false } };
}

function deletionImpact(state, project, archived) {
  const tasks = values(state.tasks, "tasks");
  const notes = values(state.notes, "notes");
  const repeats = values(state.taskRepeatCfgs, "taskRepeatCfgs");
  const listed = new Set([...ids(project.taskIds, "taskIds"), ...ids(project.backlogTaskIds, "backlogTaskIds")]);
  const selected = new Set([...listed, ...tasks.filter((t) => t.projectId === project.id).map((t) => t.id)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) if (selected.has(task.id) || selected.has(task.parentId)) {
      if (!selected.has(task.id)) { selected.add(task.id); grew = true; }
      for (const child of ids(task.subTaskIds ?? [], "subTaskIds")) if (!selected.has(child)) { selected.add(child); grew = true; }
    }
  }
  const noteIds = new Set([...ids(project.noteIds, "noteIds"), ...notes.filter((n) => n.projectId === project.id).map((n) => n.id)]);
  const repeatIds = repeats.filter((r) => r.projectId === project.id).map((r) => r.id);
  const observedArchive = new Set(archived.filter((t) => t?.projectId === project.id).map((t) => t.id));
  return {
    summary: {
      liveTaskCount: selected.size, taskCount: ids(project.taskIds, "taskIds").length, backlogTaskCount: ids(project.backlogTaskIds, "backlogTaskIds").length,
      subtaskCount: tasks.filter((t) => selected.has(t.id) && t.parentId).length, noteCount: noteIds.size, repeatCfgCount: repeatIds.length,
      observedArchivedTaskCount: observedArchive.size, archiveVerification: "best-effort", archiveCleanupVerified: false,
      otherEffects: ["project time tracking and task time-sync cleanup", "default project/start-page fallback when applicable"],
      warning: "Archive reads may hide failures. Counts are not a complete dry run; SP also deletes archived project data asynchronously.",
    }, taskIds: [...selected], noteIds: [...noteIds], repeatIds,
  };
}

function requireApi(api, methods) {
  if (methods.some((method) => typeof api[method] !== "function")) fail("SP_PLUGIN_UNSUPPORTED", "This SP version does not provide the required public plugin methods.");
}
function counterProjection(row) {
  if (!record(row) || typeof row.id !== "string" || !row.id || typeof row.title !== "string" || !["ClickCounter", "StopWatch", "RepeatedCountdownReminder"].includes(row.type) || typeof row.isEnabled !== "boolean" || row.isHideButton !== undefined && typeof row.isHideButton !== "boolean" || row.isOn !== undefined && typeof row.isOn !== "boolean" || row.icon != null && typeof row.icon !== "string" || !record(row.countOnDay) || Object.values(row.countOnDay).some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) fail("SP_BAD_STATE", "SP returned an invalid counter.");
  return { id: row.id, title: row.title, type: row.type, icon: row.icon ?? null, isEnabled: row.isEnabled, isHideButton: row.isHideButton ?? false, isOn: row.isOn ?? false, trackedDays: Object.keys(row.countOnDay).length };
}
async function counterRows(api) {
  requireApi(api, ["getAllSimpleCounters"]);
  const rows = await api.getAllSimpleCounters();
  if (!Array.isArray(rows)) fail("SP_BAD_STATE", "SP did not return its counters.");
  const projected = rows.map(counterProjection);
  if (new Set(projected.map((row) => row.id)).size !== projected.length) fail("SP_BAD_STATE", "SP returned duplicate counter IDs.");
  return projected;
}
function counterChanges(args) {
  const patch = {};
  if (own(args, "title")) patch.title = text(args.title, "title");
  if (own(args, "icon")) {
    if (typeof args.icon !== "string" || args.icon !== "" && !/^[a-z0-9_]{1,80}$/i.test(args.icon)) bad("Invalid counter icon.");
    patch.icon = args.icon || null;
  }
  for (const key of ["isEnabled", "isHideButton"]) if (own(args, key)) {
    if (typeof args[key] !== "boolean") bad("Counter settings must be boolean.");
    patch[key] = args[key];
  }
  if (!Object.keys(patch).length) bad("No counter setting was supplied.");
  return patch;
}
async function manageCounters(api, action, args, write) {
  only(args, action === "list" ? [] : action === "delete" ? ["counterId", "confirmTitle", "allowHistoryDelete"] : ["counterId", "title", "icon", "isEnabled", "isHideButton"]);
  const target = action === "list" ? null : id(args.counterId);
  let patch;
  if (action === "update") patch = counterChanges(args);
  if (action === "delete" && (args.allowHistoryDelete !== true || typeof args.confirmTitle !== "string")) bad("Counter deletion requires its exact title and confirmation to remove all recorded history.");
  const rows = await counterRows(api), current = rows.find((row) => row.id === target);
  if (action === "list") return { ok: true, data: { counters: rows } };
  if (!current) fail("SP_NO_COUNTER", "The exact counter ID does not exist.");
  if (patch?.title) duplicate(rows, patch.title, target);
  if (action === "delete") {
    requireApi(api, ["deleteSimpleCounter"]);
    if (args.confirmTitle !== current.title) fail("SP_CONFIRMATION_STALE", "Counter title does not match; confirm the current title before deleting its history.");
    if (current.isOn) fail("SP_COUNTER_RUNNING", "Stop the counter before deleting it.");
    await write(() => api.deleteSimpleCounter(target));
    if ((await counterRows(api)).some((row) => row.id === target)) fail("SP_VERIFY_FAILED", "SP did not confirm counter deletion.");
    return { ok: true, data: { id: target, deleted: true, removedTrackedDays: current.trackedDays } };
  }
  requireApi(api, ["updateSimpleCounter"]);
  const changed = Object.entries(patch).some(([key, value]) => current[key] !== value);
  if (changed) await write(() => api.updateSimpleCounter(target, patch));
  const after = (await counterRows(api)).find((row) => row.id === target);
  if (!after || Object.entries(patch).some(([key, value]) => after[key] !== value) || after.type !== current.type || after.trackedDays !== current.trackedDays) fail("SP_VERIFY_FAILED", "SP did not confirm the requested counter configuration.");
  return { ok: true, data: { counter: after, updated: true, unchanged: !changed } };
}
function exactOrder(value) {
  if (!Array.isArray(value) || value.length > 200 || new Set(value).size !== value.length) bad("Task order requires at most 200 unique task IDs.");
  return value.map(id);
}
function readOrder(state, contextType, contextId) {
  const tasks = values(state?.tasks, "tasks"), taskById = new Map(tasks.map((task) => [task.id, task]));
  const parent = contextType === "project" ? values(state?.projects, "projects").find((row) => row.id === contextId) : taskById.get(contextId);
  if (!parent) fail(contextType === "project" ? "SP_NO_PROJECT" : "SP_NO_TASK", "The task-order context does not exist.");
  if (contextType === "project" && parent.isArchived === true) fail("SP_ARCHIVED_PROJECT", "Restore this project in SP before reordering it.");
  const ordered = exactOrder(contextType === "project" ? parent.taskIds : parent.subTaskIds);
  const backlogTaskIds = contextType === "project" ? exactOrder(parent.backlogTaskIds) : [];
  if (ordered.some((taskId) => backlogTaskIds.includes(taskId))) fail("SP_BAD_STATE", "SP has overlapping task and backlog lists.");
  for (const taskId of [...ordered, ...backlogTaskIds]) {
    const task = taskById.get(taskId);
    if (!task || contextType === "project" && (task.projectId !== contextId || task.parentId != null && task.parentId !== "") || contextType === "task" && task.parentId !== contextId) fail("SP_BAD_STATE", "Task order and task ownership disagree.");
  }
  const listed = new Set([...ordered, ...backlogTaskIds]);
  if (tasks.some((task) => (contextType === "project" ? task.projectId === contextId && !task.parentId : task.parentId === contextId) && !listed.has(task.id))) fail("SP_BAD_STATE", "The task-order list omits an existing task.");
  return { contextType, contextId, taskIds: ordered, backlogTaskIds };
}
async function manageOrder(api, action, args, write) {
  only(args, action === "list" ? ["contextType", "contextId"] : ["contextType", "contextId", "taskIds", "expectedTaskIds"]);
  if (!["project", "task"].includes(args.contextType)) bad("The order context must be project or task.");
  const contextId = id(args.contextId);
  let desired, expected;
  if (action === "update") {
    desired = exactOrder(args.taskIds); expected = exactOrder(args.expectedTaskIds);
    if (desired.length !== expected.length || desired.some((taskId) => !expected.includes(taskId))) bad("Reordering must retain every task exactly once.");
  }
  requireApi(api, action === "update" ? ["getAppState", "reorderTasks"] : ["getAppState"]);
  const current = readOrder(await api.getAppState(), args.contextType, contextId);
  if (action === "list") return { ok: true, data: current };
  if (JSON.stringify(current.taskIds) === JSON.stringify(desired)) return { ok: true, data: { ...current, unchanged: true } };
  if (JSON.stringify(current.taskIds) !== JSON.stringify(expected)) fail("SP_ORDER_CONFLICT", "Task order changed. Read it again before retrying; no reorder was written.");
  await write(() => api.reorderTasks(desired, contextId, args.contextType));
  const after = readOrder(await api.getAppState(), args.contextType, contextId);
  if (JSON.stringify(after.taskIds) !== JSON.stringify(desired) || JSON.stringify(after.backlogTaskIds) !== JSON.stringify(current.backlogTaskIds)) fail("SP_VERIFY_FAILED", "SP did not confirm the complete task order and unchanged backlog.");
  return { ok: true, data: { ...after, unchanged: false } };
}
function selectionProjection(task) {
  if (task === null) return null;
  if (!record(task) || typeof task.id !== "string" || !task.id || typeof task.title !== "string" || typeof task.isDone !== "boolean") fail("SP_BAD_STATE", "SP returned an invalid selected task.");
  return { id: task.id, title: task.title, isDone: task.isDone };
}
function relationIds(value) {
  if (!Array.isArray(value) || new Set(value).size !== value.length) fail("SP_REPARENT_UNSUPPORTED", "SP has an invalid relationship list; no restructuring was attempted.");
  value.forEach(id);
  return [...value];
}
function relationshipState(state) {
  const rows = values(state?.tasks, "tasks"), tasks = new Map(rows.map((task) => [task.id, task]));
  const tags = values(state?.tags, "tags"), tagById = new Map(tags.map((tag) => [tag.id, tag]));
  for (const tag of tags) {
    relationIds(tag.taskIds);
    if (tag.taskIds.some((taskId) => !tasks.has(taskId))) fail("SP_REPARENT_UNSUPPORTED", "SP has stale tag references; restructuring would clean unrelated data.");
  }
  const facts = rows.map((task) => {
    const parentId = task.parentId ?? null, projectId = task.projectId === "" ? null : task.projectId ?? null;
    if (parentId !== null) id(parentId);
    if (projectId !== null) id(projectId);
    const subTaskIds = relationIds(task.subTaskIds), tagIds = relationIds(task.tagIds);
    if (parentId !== null && (!tasks.has(parentId) || !Array.isArray(tasks.get(parentId).subTaskIds) || !tasks.get(parentId).subTaskIds.includes(task.id)) || subTaskIds.some((childId) => !tasks.has(childId) || tasks.get(childId).parentId !== task.id)) fail("SP_REPARENT_UNSUPPORTED", "SP parent and child references disagree; restructuring would repair unrelated data.");
    if (tagIds.some((tagId) => !tagById.has(tagId) || !tagById.get(tagId).taskIds.includes(task.id))) fail("SP_REPARENT_UNSUPPORTED", "SP task and tag references disagree; restructuring would repair unrelated data.");
    const visited = new Set([task.id]);
    let ancestor = parentId;
    while (ancestor !== null) {
      if (visited.has(ancestor)) fail("SP_REPARENT_UNSUPPORTED", "SP contains a cyclic task hierarchy.");
      visited.add(ancestor);
      const parent = tasks.get(ancestor);
      if (!parent) fail("SP_REPARENT_UNSUPPORTED", "SP contains an orphan task.");
      ancestor = parent.parentId ?? null;
    }
    const doneOn = task.doneOn ?? null, wontDoOn = task.wontDoOn ?? null;
    if (typeof task.isDone !== "boolean" || !validTimestamp(doneOn) || !validTimestamp(wontDoOn)) fail("SP_BAD_STATE", "SP returned invalid task completion metadata.");
    return { id: task.id, parentId, projectId, subTaskIds, tagIds, isDone: task.isDone, doneOn, wontDoOn };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { facts, tags: tags.map((tag) => ({ id: tag.id, taskIds: [...tag.taskIds] })).sort((a, b) => a.id.localeCompare(b.id)), tasks };
}
function reparentTimeState(tasks, taskIds, code = "SP_REPARENT_UNSUPPORTED") {
  return taskIds.map((taskId) => {
    const task = tasks.get(taskId), days = task?.timeSpentOnDay;
    if (!task || task.timeSpent !== 0 || task.timeEstimate !== 0 || days !== undefined && (!record(days) || Object.values(days).some((value) => value !== 0))) fail(code, "The moved task, both parents and their descendants must have zero recorded time and estimates; SP's batch API does not recalculate parent totals.");
    return { id: taskId, timeSpent: task.timeSpent, timeEstimate: task.timeEstimate, timeSpentOnDay: days === undefined ? null : Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b))) };
  });
}
async function reparentTask(api, args, write) {
  only(args, ["taskId", "parentId", "expectedParentId"]);
  const taskId = id(args.taskId);
  for (const key of ["parentId", "expectedParentId"]) {
    if (!own(args, key)) bad("Both current and desired parent IDs are required; use null for no parent.");
    if (args[key] !== null) id(args[key]);
    if (args[key] === taskId) bad("A task cannot be its own parent.");
  }
  requireApi(api, ["getAppState", "batchUpdateForProject"]);
  const state = await api.getAppState(), before = relationshipState(state), task = before.tasks.get(taskId);
  if (!task) fail("SP_NO_TASK", "Only an active task can be reparented.");
  const originalParentId = task.parentId ?? null;
  if (originalParentId !== args.expectedParentId) fail("SP_PARENT_CONFLICT", "The task parent changed; read it again before restructuring.");
  const related = [task, ...(originalParentId ? [before.tasks.get(originalParentId)] : []), ...(args.parentId ? [before.tasks.get(args.parentId)] : [])];
  if (task.subTaskIds.length || typeof task.projectId !== "string" || !task.projectId || related.some((row) => !row || row.projectId !== task.projectId || row !== task && row.parentId != null || row.repeatCfgId != null && row.repeatCfgId !== "")) fail("SP_REPARENT_UNSUPPORTED", "Only a leaf task and root-level parents in the same project without repeat rules can be restructured.");
  const project = values(state.projects, "projects").find((row) => row.id === task.projectId);
  if (!project || project.isArchived === true || relationIds(project.backlogTaskIds).length) fail("SP_REPARENT_UNSUPPORTED", "The project must be active and its backlog empty; SP's batch API otherwise merges backlog into its main list.");
  const order = readOrder(state, "project", task.projectId);
  const projection = (parentId, unchanged) => ({ id: taskId, parentId, previousParentId: originalParentId, projectId: task.projectId, unchanged });
  if (originalParentId === args.parentId) return { ok: true, data: projection(originalParentId, true) };
  if (args.parentId && before.tasks.get(args.parentId).isDone !== task.isDone) fail("SP_REPARENT_UNSUPPORTED", "The destination parent and child must have the same completion state; this operation does not change completion.");
  const timeIds = [...new Set(related.map((row) => row.id))], seenTimeIds = new Set(timeIds);
  for (let index = 0; index < timeIds.length; index++) for (const childId of before.tasks.get(timeIds[index]).subTaskIds) {
    if (!seenTimeIds.has(childId)) { seenTimeIds.add(childId); timeIds.push(childId); }
  }
  // Batch reparenting leaves parent time totals untouched, so only zero-time families are safe.
  const beforeTimes = reparentTimeState(before.tasks, timeIds);
  const expected = structuredClone(before.facts), changed = expected.find((row) => row.id === taskId);
  changed.parentId = args.parentId;
  if (originalParentId) {
    const oldParent = expected.find((row) => row.id === originalParentId);
    oldParent.subTaskIds = oldParent.subTaskIds.filter((childId) => childId !== taskId);
  }
  if (args.parentId) expected.find((row) => row.id === args.parentId).subTaskIds.push(taskId);
  const taskIds = order.taskIds.filter((rowId) => rowId !== taskId);
  if (args.parentId === null) taskIds.push(taskId);
  exactOrder(taskIds);
  // The official batch validator rebuilds the main list. An explicit full order preserves it.
  const result = await write(() => api.batchUpdateForProject({ projectId: task.projectId, operations: [
    { type: "update", taskId, updates: { parentId: args.parentId } },
    { type: "reorder", taskIds },
  ] }));
  if (!record(result) || result.success !== true || !record(result.createdTaskIds) || Object.keys(result.createdTaskIds).length || result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length)) fail("SP_VERIFY_FAILED", "SP did not confirm the parent-change batch.");
  const afterState = await api.getAppState(), after = relationshipState(afterState), afterOrder = readOrder(afterState, "project", task.projectId);
  if (JSON.stringify(after.facts) !== JSON.stringify(expected) || JSON.stringify(after.tags) !== JSON.stringify(before.tags) || JSON.stringify(afterOrder.taskIds) !== JSON.stringify(taskIds) || afterOrder.backlogTaskIds.length || JSON.stringify(reparentTimeState(after.tasks, timeIds, "SP_VERIFY_FAILED")) !== JSON.stringify(beforeTimes)) fail("SP_VERIFY_FAILED", "SP did not confirm the parent links, task set, completion states, tag links, project order and unchanged time data.");
  return { ok: true, data: projection(args.parentId, false) };
}
async function manageSelection(api, action, args, write) {
  only(args, action === "list" ? [] : ["taskId"]);
  const target = action === "select" ? id(args.taskId) : null;
  requireApi(api, action === "select" ? ["getSelectedTask", "getAppState", "selectTask"] : ["getSelectedTask"]);
  const current = selectionProjection(await api.getSelectedTask());
  if (action === "list") return { ok: true, data: { selectedTask: current } };
  if (!values((await api.getAppState())?.tasks, "tasks").some((task) => task.id === target)) fail("SP_NO_TASK", "Only an active task can be selected.");
  if (current?.id === target) return { ok: true, data: { selectedTask: current, unchanged: true } };
  await write(() => api.selectTask(target));
  const selectedTask = selectionProjection(await api.getSelectedTask());
  if (selectedTask?.id !== target) fail("SP_VERIFY_FAILED", "SP did not confirm the selected task.");
  return { ok: true, data: { selectedTask, unchanged: false } };
}

export function createCommandExecutor(api) {
  let tail = Promise.resolve();
  async function execute(op, args, isCancelled) {
    let attempted = false;
    let createdId;
    const check = () => { if (isCancelled()) fail("SP_COMMAND_CANCELLED", "Command cancelled or expired before the next mutation."); };
    const write = async (fn) => { check(); attempted = true; return await fn(); };
    try {
      check();
      if (!OPS.has(op)) bad("Unsupported operation.");
      if (op.startsWith("preferences.")) return { ok: true, data: await executePreferences(api, op, args, { write, fail }) };
      if (op.startsWith("counterControl.")) return { ok: true, data: await executeCounterControl(api, op, args, { write, fail }) };
      if (op.startsWith("workContext.")) return { ok: true, data: await executeWorkContext(api, op, args, { write, fail }) };
      if (op === "ui.command") return { ok: true, data: await executeUiControl(api, op, args, { write, fail }) };
      if (op.startsWith("attachments.")) return { ok: true, data: await executeAttachments(api, op, args, { write, fail }) };
      if (op.startsWith("keyboard.")) return { ok: true, data: await executeKeyboard(api, op, args, { write, fail }) };
      if (op === "tasks.repairCompletion") return await repairCompletion(api, args, write);
      if (op === "tasks.reparent") return await reparentTask(api, args, write);
      if (op.startsWith("counters.")) return await manageCounters(api, op.split(".")[1], args, write);
      if (op.startsWith("taskOrder.")) return await manageOrder(api, op.split(".")[1], args, write);
      if (op.startsWith("selection.")) return await manageSelection(api, op.split(".")[1], args, write);
      const [kind, action] = op.split(".");
      const project = kind === "projects";
      const singular = project ? "project" : "tag";
      const idKey = `${singular}Id`;
      const editKeys = ["title", "icon", "color", ...(project ? ["isEnableBacklog", "isHiddenFromMenu"] : [])];
      only(args, action === "list" ? [] : action === "delete" ? [idKey, "allowCascade", "confirmTitle"] : [...(action === "update" ? [idKey] : []), ...editKeys]);
      let state = await api.getAppState();
      let rows = values(state?.[kind], kind);
      if (action === "list") return { ok: true, data: { [kind]: rows.map((row) => projection(row, project)) } };
      let target;
      let current;
      if (action !== "create") {
        target = id(args[idKey]);
        if (PROTECTED.has(target)) fail("SP_PROTECTED_ENTITY", "Inbox and TODAY cannot be modified or deleted.");
        current = find(rows, target, project);
      }
      if (action === "delete") {
        if (args.allowCascade !== true || typeof args.confirmTitle !== "string" || args.confirmTitle !== current.title) bad("Deletion requires allowCascade:true and confirmTitle matching the current title exactly, even for apparently empty projects.");
        let archived = [];
        try { const result = await api.getArchivedTasks(); if (Array.isArray(result)) archived = result; } catch { /* Archive verification is explicitly best-effort. */ }
        state = await api.getAppState();
        rows = values(state?.projects, "projects");
        current = find(rows, target, true);
        if (current.title !== args.confirmTitle) fail("SP_CONFIRMATION_STALE", "The project title changed; confirm again before deleting.");
        const impact = deletionImpact(state, current, archived);
        await write(() => api.deleteProject(target));
        const after = await api.getAppState();
        const afterProjectIds = new Set(values(after?.projects, "projects").map((row) => row.id));
        const afterTaskIds = new Set(values(after?.tasks, "tasks").map((row) => row.id));
        const afterNoteIds = new Set(values(after?.notes, "notes").map((row) => row.id));
        const afterRepeatIds = new Set(values(after?.taskRepeatCfgs, "taskRepeatCfgs").map((row) => row.id));
        if (afterProjectIds.has(target) || impact.taskIds.some((i) => afterTaskIds.has(i)) || impact.noteIds.some((i) => afterNoteIds.has(i)) || impact.repeatIds.some((i) => afterRepeatIds.has(i))) fail("SP_VERIFY_FAILED", "SP did not confirm deletion of the project and its observed live contents.");
        return { ok: true, data: { deleted: true, id: target, impact: impact.summary, verification: "applied-state; archive cleanup and disk/sync completion not confirmed" } };
      }
      const edit = changes(args, project, action === "create");
      duplicate(rows, edit.title, target);
      if (action === "create") {
        const initial = { ...edit };
        if (own(initial, "icon")) initial.icon = initial.icon || null;
        if (project || initial.color === "") delete initial.color;
        target = await write(() => project ? api.addProject(initial) : api.addTag(initial));
        createdId = id(target);
        state = await api.getAppState();
        current = find(values(state?.[kind], kind), target, project);
        // A partial nested theme replaces defaults; update only after SP creates them.
        if (own(edit, "color") && (project || edit.color === "")) await write(() => project ? api.updateProject(target, patchFor({ color: edit.color }, true, current)) : api.updateTag(target, { color: null }));
      } else {
        const patch = patchFor(edit, project, current);
        await write(() => project ? api.updateProject(target, patch) : api.updateTag(target, patch));
      }
      state = await api.getAppState();
      current = find(values(state?.[kind], kind), target, project);
      verify(current, edit, project);
      return { ok: true, data: { [singular]: projection(current, project), [action === "create" ? "created" : "updated"]: true, verification: "applied-state" } };
    } catch (error) {
      const safe = error instanceof BridgeError;
      const message = (safe ? error.message : "SP rejected the operation or could not return a valid snapshot. Inspect SP before retrying.").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1000);
      return { ok: false, error: { code: safe ? error.code : "SP_PLUGIN_ERROR", message }, ...(attempted ? { outcomeUnknown: true } : {}), ...(createdId ? { createdId } : {}) };
    }
  }
  return (op, args, isCancelled = () => false) => {
    const run = tail.then(() => execute(op, args, isCancelled));
    tail = run.catch(() => undefined);
    return run;
  };
}

export function parsePairingCode(code) {
  if (typeof code !== "string" || code.length > 4096 || !code.trim().startsWith("HANA-SP1.")) bad("Paste the HANA-SP1 pairing code from Hana.");
  const encoded = code.trim().slice(9);
  if (!/^[a-zA-Z0-9_-]+$/.test(encoded)) bad("Invalid pairing code encoding.");
  let parsed;
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (x) => x.charCodeAt(0))));
  } catch { bad("Invalid pairing code."); }
  only(parsed, ["protocol", "url", "token"]);
  if (parsed.protocol !== PROTOCOL || parsed.url !== BRIDGE_URL || typeof parsed.token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(parsed.token)) bad("Pairing requires protocol 1, http://127.0.0.1:3877 and a valid local token.");
  return { protocol: PROTOCOL, url: BRIDGE_URL, token: parsed.token };
}

export function createBridgeClient(api, env = {}) {
  const fetcher = env.fetch ?? globalThis.fetch.bind(globalThis);
  const setTimer = env.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = env.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const now = env.now ?? Date.now;
  const random = env.random ?? Math.random;
  const clientId = env.clientId ?? globalThis.crypto.randomUUID();
  const execute = createCommandExecutor(api);
  const cache = new Map();
  let cacheBytes = 0;
  const controllers = new Set();
  const requestTimers = new Set();
  const waits = new Map();
  let generation = 0;
  let active = false;
  let disposed = false;
  let paired = false;
  let pending = false;
  let lastErrorCode = null;
  let loopPromise = Promise.resolve();
  let dialogOpen = false;
  let changingPairing = false;
  const notice = (msg, type = "INFO") => { try { api.showSnack({ msg, type }); } catch { /* No diagnostic includes credentials. */ } };
  function abortWork() {
    for (const controller of controllers) controller.abort();
    controllers.clear();
    for (const timer of requestTimers) clearTimer(timer);
    requestTimers.clear();
    for (const [timer, resolve] of waits) { clearTimer(timer); resolve(); }
    waits.clear();
  }
  function stop() { active = false; generation++; abortWork(); }
  function unload() { disposed = true; stop(); }
  function sleep(ms) {
    return new Promise((resolve) => { const timer = setTimer(() => { waits.delete(timer); resolve(); }, ms); waits.set(timer, resolve); });
  }
  async function post(pairing, route, body) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimer(() => controller.abort(), 30000);
    requestTimers.add(timer);
    try {
      const response = await fetcher(`${pairing.url}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${pairing.token}` }, body: JSON.stringify(body), signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store" });
      const raw = await response.text();
      if (raw.length > 1048576) fail("SP_BRIDGE_BAD_RESPONSE", "Local bridge response is too large.");
      let value;
      try { value = JSON.parse(raw); } catch { fail(response.ok ? "SP_BRIDGE_BAD_RESPONSE" : "SP_BRIDGE_HTTP_ERROR", "Local bridge returned invalid JSON."); }
      if (!response.ok) {
        const reportedCode = value?.ok === false && record(value.error) ? value.error.code : null;
        const trustedCodes = ["SP_BRIDGE_RESULT_MISMATCH", "SP_BRIDGE_RESULT_GONE", "SP_BRIDGE_CLIENT_BUSY"];
        const error = new BridgeError(trustedCodes.includes(reportedCode) ? reportedCode : response.status === 401 || response.status === 403 ? "SP_BRIDGE_UNAUTHORIZED" : "SP_BRIDGE_HTTP_ERROR", "Local bridge refused the request.");
        error.httpStatus = response.status;
        throw error;
      }
      if (!record(value) || value.ok !== true || !record(value.data)) fail("SP_BRIDGE_BAD_RESPONSE", "Local bridge did not acknowledge the request.");
      return value.data;
    } finally { clearTimer(timer); requestTimers.delete(timer); controllers.delete(controller); }
  }
  function commandCheck(command) {
    only(command, ["id", "op", "args", "expiresAt"]);
    id(command.id);
    if (!OPS.has(command.op) || !record(command.args) || !Number.isSafeInteger(command.expiresAt) || command.expiresAt <= 0) bad("Invalid command envelope.");
  }
  async function consume(command, isCancelled) {
    const fingerprint = JSON.stringify([command.op, command.args, command.expiresAt]);
    const prior = cache.get(command.id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return { ok: false, error: { code: "SP_COMMAND_ID_REUSED", message: "A command ID cannot be reused with another payload." }, outcomeUnknown: true };
      return prior.result;
    }
    const fingerprintBytes = new TextEncoder().encode(fingerprint).length;
    if (fingerprintBytes > 16384) return { ok: false, error: { code: "SP_COMMAND_TOO_LARGE", message: "Command arguments exceed the supported size; no operation was executed." } };
    // Reserve the maximum result before executing: receipts for writes are never evicted.
    if (cache.size >= MAX_RECEIPTS || cacheBytes + fingerprintBytes + MAX_RESULT_BYTES + 1024 > MAX_CACHE_BYTES) return { ok: false, error: { code: "SP_SESSION_LIMIT", message: "Reload the plugin after checking pending commands; the session deduplication limit was reached. No operation was executed." } };
    let result = command.expiresAt <= now() ? { ok: false, error: { code: "SP_COMMAND_EXPIRED", message: "Command expired without being executed." } } : await execute(command.op, command.args, () => isCancelled() || command.expiresAt <= now());
    if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_RESULT_BYTES) result = { ok: false, error: { code: "SP_BRIDGE_RESULT_TOO_LARGE", message: "The result exceeds the bridge limit. No operation was repeated; inspect SP before retrying." }, ...(!command.op.endsWith(".list") ? { outcomeUnknown: true } : {}), ...(result.createdId ? { createdId: result.createdId } : {}) };
    const cachedResult = command.op.endsWith(".list") ? { ok: false, error: { code: "SP_READ_RESULT_UNAVAILABLE", message: "This read command already finished. Submit a new read command to get current data." } } : result;
    cache.set(command.id, { fingerprint, result: cachedResult });
    cacheBytes += fingerprintBytes + new TextEncoder().encode(JSON.stringify(cachedResult)).length + command.id.length * 2 + 128;
    return result;
  }
  async function loop(pairing, epoch) {
    let backoff = 1000, longPoll = false;
    let report = null;
    let reportIsWrite = false;
    let reportRejected = false;
    const alive = () => active && !disposed && epoch === generation;
    while (alive()) {
      try {
        if (report) {
          const ack = await post(pairing, "/plugin/result", report);
          if (ack.id !== report.id || ack.accepted !== true) fail("SP_BRIDGE_BAD_RESPONSE", "Local bridge did not explicitly acknowledge this command.");
          report = null; pending = false; reportRejected = false;
        } else {
          // A bridge that answered with longPoll holds an empty poll until work arrives;
          // older bridges reject the extra field, so it is only sent after that signal.
          const waited = longPoll, sentAt = now();
          const data = await post(pairing, "/plugin/poll", { clientId, version: VERSION, protocol: PROTOCOL, ...(waited ? { wait: true } : {}) });
          if (!alive()) break;
          if (!own(data, "command")) fail("SP_BRIDGE_BAD_RESPONSE", "Local bridge omitted command.");
          longPoll = data.longPoll === true;
          if (data.command === null) {
            lastErrorCode = null; backoff = 1000;
            // A held poll that returns at once (e.g. another command still in flight) must not spin.
            if (!waited || now() - sentAt < 250) await sleep(750);
            continue;
          }
          const command = data.command;
          commandCheck(command);
          pending = true;
          const result = await consume(command, () => !alive());
          reportIsWrite = !command.op.endsWith(".list");
          reportRejected = false;
          report = { clientId, id: command.id, result };
        }
        lastErrorCode = null; backoff = 1000;
      } catch (error) {
        if (!alive()) break;
        lastErrorCode = error instanceof BridgeError ? error.code : "SP_BRIDGE_OFFLINE";
        if (report && ["SP_BRIDGE_RESULT_MISMATCH", "SP_BRIDGE_RESULT_GONE"].includes(lastErrorCode)) {
          // The runtime can lose receipts on restart. Keep the executed-ID cache.
          report = null; pending = false;
          notice("Hana 已遗失这条操作的回执，插件没有重复写入。请先查询 SP 确认结果，再决定是否重试。", "WARNING");
          await sleep(750);
          continue;
        }
        if (report && error instanceof BridgeError && [400, 413].includes(error.httpStatus)) {
          if (!reportRejected) {
            reportRejected = true;
            report.result = { ok: false, error: { code: "SP_BRIDGE_RESULT_REJECTED", message: "Hana rejected the result format. The operation was not repeated; inspect SP before retrying." }, ...(reportIsWrite ? { outcomeUnknown: true } : {}), ...(report.result.createdId ? { createdId: report.result.createdId } : {}) };
            continue;
          }
          active = false;
          notice("Hana 连续拒绝操作回执，连接已停止。请先查询 SP，然后断开配对并重新配对。", "ERROR");
          break;
        }
        await sleep(Math.min(30000, backoff) + Math.floor(random() * 250));
        backoff = Math.min(30000, backoff * 2);
      }
    }
  }
  async function start() {
    if (disposed || active) return;
    const oldEpoch = generation;
    let saved;
    try { saved = await api.getSecret(SECRET_KEY); } catch { lastErrorCode = "SP_SECRET_UNAVAILABLE"; return; }
    if (disposed || active || oldEpoch !== generation || !saved) return;
    let pairing;
    try { pairing = parsePairingCode(saved); } catch { lastErrorCode = "SP_PAIRING_INVALID"; return; }
    paired = true; active = true;
    const epoch = ++generation;
    loopPromise = loop(pairing, epoch).catch(() => { if (epoch === generation) { active = false; lastErrorCode = "SP_BRIDGE_STOPPED"; } });
  }
  async function pair(code) {
    parsePairingCode(code);
    if (disposed) fail("SP_PLUGIN_UNLOADED", "Plugin has been unloaded.");
    if (changingPairing) fail("SP_BRIDGE_PAIRING_BUSY", "A pairing change is already in progress.");
    if (pending) fail("SP_BRIDGE_PENDING", "A command or result is pending. Do not replace pairing until Hana resolves it.");
    changingPairing = true;
    try {
      stop(); await loopPromise;
      if (disposed) fail("SP_PLUGIN_UNLOADED", "Plugin has been unloaded.");
      await api.setSecret(SECRET_KEY, code.trim());
      paired = true; lastErrorCode = null;
      await start();
      notice("配对信息已保存在本机。请到 Hana 任务台检查连接状态。", "SUCCESS");
    } finally { changingPairing = false; }
  }
  async function disconnect() {
    if (changingPairing) fail("SP_BRIDGE_PAIRING_BUSY", "A pairing change is already in progress.");
    changingPairing = true;
    const hadPending = pending;
    try {
      stop();
      // An SP API call cannot be aborted; wait for it before permitting a new pair.
      await loopPromise;
      await api.deleteSecret(SECRET_KEY);
      paired = false; pending = false;
      notice(hadPending ? "已断开配对。进行中的操作可能已修改 SP，请先查询确认，再决定是否重试。" : "已移除本机配对信息。");
    } finally { changingPairing = false; }
  }
  async function openPairing() {
    if (dialogOpen || disposed) return;
    dialogOpen = true;
    const inputId = `hana-sp-pair-${clientId.replace(/[^a-z0-9]/gi, "")}`;
    const status = active ? "已配对；请在 Hana 任务台查看连接状态。" : paired ? "已配对，当前连接已停止。" : "尚未配对。";
    try {
      await api.openDialog({
        title: "配对 Hana 任务台",
        htmlContent: `<p>${status}</p><p>粘贴 Hana 任务台生成的配对码。配对后助手可以管理项目和标签，修复归档任务的历史完成状态与时间；配置已有计数器、启停秒表及暂停重复倒计时，切换活动项目或标签，重排任务、打开任务详情，调整声音、工作时段、番茄钟默认参数、专注行为和休息提醒，并在条件满足时更换同项目叶任务的父任务。更换父任务要求项目积压区为空、相关任务无重复规则且关系完整，新父任务与子任务完成状态相同；被移动任务、原新父任务及其全部后代的工时和估时必须为零，不迁移计时历史。</p><p>明确确认后可删除计数器及全部历史，或级联删除项目及其任务、笔记、重复规则和归档内容。完成状态修复会先核对当前值，并保留原有放弃标记。禁用计数器会暂停计数，重新启用可能继续；秒表开关与活动工作上下文仅作用于本机。偏好设置可能同步到其他设备；开启或缩短休息提醒阈值可能在当前计时期间触发已配置的锁屏、全屏遮罩或窗口前置。切换上下文会清除任务详情选择，不导航页面或停止计时。</p><p>0.5.0 还可管理任务 HTTP/HTTPS 链接附件，提交八个固定面板动作，修改显示、任务行为、默认估时、计时与排期提醒，以及内置应用快捷键。链接只保存元数据，不访问网页或删除文件；面板仅确认动作已提交，不确认画面。关闭专注覆盖层会取消未开始的准备倒计时，切换笔记或问题面板会隐藏其他非任务面板，不等于控制专注会话。自动加入今天可影响正在计时的未排期任务，自动父任务完成或自动下一项会影响后续完成事件。快捷键保留系统和插件配置，但配置读回不能证明系统热键注册成功；新冲突默认拒绝。所有这些能力不接受任意动作或脚本。</p><p>仅允许连接 http://127.0.0.1:3877。令牌保存在 SP 本机密钥存储，不参与同步。这是基于 SP 官方 API 开发的配套插件。</p><label for="${inputId}">配对码</label><textarea id="${inputId}" rows="4" autocomplete="off" spellcheck="false" style="width:100%"></textarea>`,
        buttons: [
          { label: "取消" },
          { label: "断开配对", onClick: async () => { try { await disconnect(); } catch { notice("未能移除本机配对信息。", "ERROR"); } } },
          { label: "配对", color: "primary", raised: true, onClick: async () => {
            const input = (env.document ?? globalThis.document)?.getElementById(inputId);
            const value = input?.value;
            if (input) input.value = "";
            try { await pair(value); } catch (error) { notice(error instanceof BridgeError ? error.message : "未能保存配对信息。", "ERROR"); }
          } },
        ],
      });
    } finally { dialogOpen = false; }
  }
  return { start, unload, pair, disconnect, openPairing, status: () => ({ paired, active, pending, lastErrorCode, clientId }), finished: () => loopPromise };
}

export function installCompanion(api, env) {
  const client = createBridgeClient(api, env);
  api.registerConfigHandler(() => { void client.openPairing().catch(() => undefined); });
  api.registerMenuEntry({ label: "配对 Hana 任务台", icon: "link", onClick: () => { void client.openPairing().catch(() => undefined); } });
  api.onUnload(() => client.unload());
  api.onReady(() => client.start());
  return client;
}
