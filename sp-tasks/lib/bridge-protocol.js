import { validatePreferenceCommand } from "./preferences-contract.js";
import { validateCounterControlCommand } from "./counter-control-contract.js";
import { validateWorkContextCommand } from "./work-context-contract.js";
import { validateUiControlCommand } from "./ui-control-contract.js";
import { validateAttachmentCommand } from "./attachments-contract.js";
import { validateKeyboardCommand } from "./keyboard-contract.js";

export const BRIDGE_PORT = 3877;
export const BRIDGE_PROTOCOL = 1;
export const BRIDGE_READY = "SP_BRIDGE_READY";
export const BRIDGE_AUTH_FILE = "bridge/runtime-auth.json";
const OPS = new Set(["projects.list", "projects.create", "projects.update", "projects.delete", "tags.list", "tags.create", "tags.update", "tasks.repairCompletion", "tasks.reparent", "counters.list", "counters.update", "counters.delete", "taskOrder.list", "taskOrder.update", "selection.list", "selection.select", "preferences.list", "preferences.update", "counterControl.list", "counterControl.start", "counterControl.stop", "workContext.list", "workContext.switch", "ui.command", "attachments.list", "attachments.add", "attachments.remove", "keyboard.list", "keyboard.update"]);
export const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function bad(message) { throw new HttpError(400, "SP_BRIDGE_BAD_INPUT", message); }
export function keys(value, allowed) {
  if (!record(value)) bad("Expected a JSON object.");
  if (Object.keys(value).some((key) => !allowed.includes(key))) bad("Unexpected request field.");
}
export function text(value, max, allowEmpty = false) {
  return typeof value === "string" && value.length <= max && (allowEmpty || !!value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);
}
function completion(value) {
  const fields = ["isDone", "doneOn", "wontDoOn"];
  keys(value, fields);
  if (fields.some((key) => !Object.hasOwn(value, key)) || typeof value.isDone !== "boolean") bad("A complete completion state is required.");
  for (const key of ["doneOn", "wontDoOn"]) {
    if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 8640000000000000)) bad("Invalid completion timestamp.");
  }
}
function exactId(value) {
  if (!text(value, 240) || value !== value.trim() || [".", ".."].includes(value) || /[\\/]/.test(value)) bad("An exact object ID is required.");
}
function taskIds(value) {
  if (!Array.isArray(value) || value.length > 200 || new Set(value).size !== value.length) bad("Task order must contain at most 200 unique IDs.");
  value.forEach(exactId);
}
export function validateCommand(op, args) {
  if (!OPS.has(op)) bad("Unsupported bridge operation.");
  if (op === "ui.command" || op.startsWith("attachments.") || op.startsWith("keyboard.")) {
    try {
      if (op === "ui.command") validateUiControlCommand(op, args);
      else if (op.startsWith("attachments.")) validateAttachmentCommand(op, args);
      else validateKeyboardCommand(op, args);
    } catch (error) { bad(error.message); }
    return { op, args };
  }
  if (op.startsWith("counterControl.") || op.startsWith("workContext.")) {
    try {
      if (op.startsWith("counterControl.")) validateCounterControlCommand(op, args);
      else validateWorkContextCommand(op, args);
    } catch (error) { bad(error.message); }
    return { op, args };
  }
  if (op.startsWith("preferences.")) {
    try { validatePreferenceCommand(op, args); } catch (error) { bad(error.message); }
    return { op, args };
  }
  if (op === "tasks.reparent") {
    keys(args, ["taskId", "parentId", "expectedParentId"]);
    exactId(args.taskId);
    for (const key of ["parentId", "expectedParentId"]) {
      if (!Object.hasOwn(args, key)) bad("Both current and desired parent IDs are required; use null for no parent.");
      if (args[key] !== null) exactId(args[key]);
      if (args[key] === args.taskId) bad("A task cannot be its own parent.");
    }
    return { op, args };
  }
  if (op.startsWith("counters.")) {
    const action = op.split(".")[1], edits = ["title", "icon", "isEnabled", "isHideButton"];
    keys(args, action === "list" ? [] : action === "delete" ? ["counterId", "confirmTitle", "allowHistoryDelete"] : ["counterId", ...edits]);
    if (action !== "list") exactId(args.counterId);
    if (Object.hasOwn(args, "title") && !text(args.title, 240)) bad("Invalid counter title.");
    if (Object.hasOwn(args, "icon") && (typeof args.icon !== "string" || args.icon !== "" && !/^[a-z0-9_]{1,80}$/i.test(args.icon))) bad("Invalid counter icon.");
    for (const key of ["isEnabled", "isHideButton"]) if (Object.hasOwn(args, key) && typeof args[key] !== "boolean") bad("Invalid counter setting.");
    if (action === "update" && !edits.some((key) => Object.hasOwn(args, key))) bad("No counter setting was supplied.");
    if (action === "delete" && (args.allowHistoryDelete !== true || !text(args.confirmTitle, 240))) bad("Deleting a counter requires its exact title and confirmation to remove its history.");
    return { op, args };
  }
  if (op.startsWith("taskOrder.")) {
    keys(args, op === "taskOrder.list" ? ["contextType", "contextId"] : ["contextType", "contextId", "taskIds", "expectedTaskIds"]);
    if (!["project", "task"].includes(args.contextType)) bad("Task order requires a project or parent-task context.");
    exactId(args.contextId);
    if (op === "taskOrder.update") {
      taskIds(args.taskIds); taskIds(args.expectedTaskIds);
      if (args.taskIds.length !== args.expectedTaskIds.length || args.taskIds.some((id) => !args.expectedTaskIds.includes(id))) bad("Task reordering must preserve the complete task set.");
    }
    return { op, args };
  }
  if (op.startsWith("selection.")) {
    keys(args, op === "selection.list" ? [] : ["taskId"]);
    if (op === "selection.select") exactId(args.taskId);
    return { op, args };
  }
  if (op === "tasks.repairCompletion") {
    keys(args, ["taskId", "expected", "desired"]);
    if (!text(args.taskId, 240) || args.taskId !== args.taskId.trim() || [".", ".."].includes(args.taskId) || /[\\/]/.test(args.taskId)) bad("An exact task ID is required.");
    completion(args.expected);
    completion(args.desired);
    return { op, args };
  }
  const [kind, action] = op.split(".");
  const idKey = kind === "projects" ? "projectId" : "tagId";
  const edits = ["title", "icon", "color", ...(kind === "projects" ? ["isEnableBacklog", "isHiddenFromMenu"] : [])];
  keys(args, action === "list" ? [] : action === "delete" ? [idKey, "allowCascade", "confirmTitle"] : [...(action === "update" ? [idKey] : []), ...edits]);
  if (["update", "delete"].includes(action)) {
    const id = args[idKey];
    if (!text(id, 240) || id !== id.trim() || id === "." || id === ".." || /[\\/]/.test(id)) bad("An exact object ID is required.");
    if (["TODAY", "INBOX_PROJECT"].includes(id)) bad("Built-in objects cannot be changed.");
  }
  if (action === "delete" && (args.allowCascade !== true || !text(args.confirmTitle, 240))) bad("Project deletion requires explicit cascade confirmation and its exact title.");
  if (action === "create" && !text(args.title, 240)) bad("A nonempty title is required.");
  if (Object.hasOwn(args, "title") && !text(args.title, 240)) bad("Invalid title.");
  if (Object.hasOwn(args, "icon") && (typeof args.icon !== "string" || args.icon !== "" && !/^[a-z0-9_]{1,80}$/i.test(args.icon))) bad("Invalid icon.");
  if (Object.hasOwn(args, "color") && (typeof args.color !== "string" || args.color !== "" && !/^#[a-f0-9]{6}$/i.test(args.color))) bad("Invalid color.");
  for (const key of ["isEnableBacklog", "isHiddenFromMenu"]) if (Object.hasOwn(args, key) && typeof args[key] !== "boolean") bad("Invalid project setting.");
  if (action === "update" && !edits.some((key) => Object.hasOwn(args, key))) bad("An update needs at least one changed field.");
  return { op, args };
}
export function validateResult(value) {
  if (!record(value)) bad("Invalid command result.");
  if (value.ok === true) {
    keys(value, ["ok", "data"]);
    if (!Object.hasOwn(value, "data")) bad("A successful result requires data.");
  } else if (value.ok === false) {
    keys(value, ["ok", "error", "outcomeUnknown", "createdId"]);
    keys(value.error, ["code", "message"]);
    if (!text(value.error.code, 100) || !text(value.error.message, 1000)) bad("Invalid result error.");
    if (Object.hasOwn(value, "outcomeUnknown") && typeof value.outcomeUnknown !== "boolean") bad("Invalid outcomeUnknown.");
    if (Object.hasOwn(value, "createdId") && (!text(value.createdId, 240) || value.createdId !== value.createdId.trim() || [".", ".."].includes(value.createdId) || /[\\/]/.test(value.createdId))) bad("Invalid createdId.");
  } else bad("Result must contain an explicit ok flag.");
  return value;
}
