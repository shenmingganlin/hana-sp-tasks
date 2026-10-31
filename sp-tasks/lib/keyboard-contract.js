// Shared by Hana and the SP plugin. Only built-in application bindings are editable.
export const KEYBOARD_APP_KEYS = Object.freeze([
  "toggleBacklog", "goToFocusMode", "goToWorkView", "goToTimeline", "goToScheduledView", "goToPlanner", "goToSettings",
  "addNewTask", "addNewProject", "showHelp", "showSearchBar", "addNewNote", "focusSideNav", "toggleSideNavMode",
  "openProjectNotes", "toggleTaskViewCustomizerPanel", "toggleIssuePanel", "zoomIn", "zoomOut", "zoomDefault", "triggerSync",
  "taskEditTitle", "taskToggleDetailPanelOpen", "taskOpenNotesPanel", "taskOpenNotesFullscreen", "taskOpenEstimationDialog",
  "taskToggleDone", "taskAddSubTask", "taskDuplicate", "taskAddAttachment", "taskMoveToProject", "taskOpenContextMenu",
  "taskDelete", "taskSchedule", "taskScheduleToday", "taskScheduleTomorrow", "taskScheduleNextWeek", "taskScheduleNextMonth",
  "taskScheduleDeadline", "taskUnschedule", "selectPreviousTask", "selectNextTask", "moveTaskUp", "moveTaskDown",
  "moveTaskToTop", "moveTaskToBottom", "moveToBacklog", "expandSubTasks", "collapseSubTasks", "togglePlay", "taskEditTags", "taskToggleSelect",
]);
export const KEYBOARD_GLOBAL_KEYS = Object.freeze(["globalShowHide", "globalToggleTaskStart", "globalAddNote", "globalAddTask", "globalToggleTaskWidget"]);
export const KEYBOARD_UPDATE_PROPERTIES = Object.freeze(Object.fromEntries(KEYBOARD_APP_KEYS.map((key) => [key, { type: ["string", "null"], maxLength: 100 }])));
const keyboardRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keyboardModifiers = ["Ctrl", "Alt", "Shift", "Meta"];
const keyboardNamedKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Space", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Escape", "ContextMenu", "CapsLock", "NumLock", "ScrollLock", "Pause", "PrintScreen", ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`)];
function keyboardError(code, message) { throw Object.assign(new Error(message), { code }); }
function keyboardParts(value) {
  if (value === "+") return { modifiers: [], key: "+" };
  if (value.endsWith("++")) return { modifiers: value.slice(0, -2).split("+"), key: "+" };
  const tokens = value.split("+");
  return { modifiers: tokens.slice(0, -1), key: tokens.at(-1) };
}

export function normalizeKeyboardShortcut(field, value) {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 100 || /\s|[\u0000-\u001f\u007f]/.test(value)) keyboardError("SP_BAD_INPUT", `Invalid shortcut for ${field}; use a supported chord or null to unbind.`);
  if (field === "showHelp" && value === "?") return value;
  const parts = keyboardParts(value), modifiers = parts.modifiers.map((part) => keyboardModifiers.find((item) => item.toLowerCase() === part.toLowerCase()));
  if (modifiers.some((part) => !part) || new Set(modifiers).size !== modifiers.length) keyboardError("SP_BAD_INPUT", `Invalid modifiers for ${field}; use Ctrl, Alt, Shift and Meta at most once each.`);
  const key = /^[a-z0-9]$/i.test(parts.key) ? parts.key.toUpperCase() : ["+", "-"].includes(parts.key) ? parts.key : keyboardNamedKeys.find((item) => item.toLowerCase() === parts.key.toLowerCase());
  if (!key) keyboardError("SP_BAD_INPUT", `Unsupported key for ${field}; use a letter, digit, function/navigation key, + or -. Only showHelp accepts ?.`);
  return [...keyboardModifiers.filter((item) => modifiers.includes(item)), key].join("+");
}

export function validateKeyboardCommand(op, args) {
  if (!["keyboard.list", "keyboard.update"].includes(op) || !keyboardRecord(args)) keyboardError("SP_BAD_INPUT", "Unsupported keyboard operation or arguments.");
  const allowed = op === "keyboard.list" ? [] : ["expectedRevision", "updates", "allowConflicts"];
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) keyboardError("SP_BAD_INPUT", `Unexpected keyboard argument: ${unknown.join(", ")}.`);
  if (op === "keyboard.list") return {};
  if (typeof args.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(args.expectedRevision)) keyboardError("SP_BAD_INPUT", "expectedRevision must be the complete revision just returned by get.");
  if (!keyboardRecord(args.updates) || !Object.keys(args.updates).length) keyboardError("SP_BAD_INPUT", "updates must contain at least one supported application shortcut.");
  const unknownKeys = Object.keys(args.updates).filter((key) => !KEYBOARD_APP_KEYS.includes(key));
  if (unknownKeys.length) keyboardError("SP_BAD_INPUT", `Unsupported keyboard fields: ${unknownKeys.join(", ")}; global and plugin bindings cannot be changed.`);
  if (Object.hasOwn(args, "allowConflicts") && typeof args.allowConflicts !== "boolean") keyboardError("SP_BAD_INPUT", "allowConflicts must be a boolean.");
  return { expectedRevision: args.expectedRevision, updates: Object.fromEntries(Object.entries(args.updates).map(([key, value]) => [key, normalizeKeyboardShortcut(key, value)])), ...(Object.hasOwn(args, "allowConflicts") ? { allowConflicts: args.allowConflicts } : {}) };
}

export function snapshotKeyboard(value) {
  if (!keyboardRecord(value)) keyboardError("SP_KEYBOARD_UNSUPPORTED", "SP did not return a keyboard configuration object.");
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.some(([, item]) => item !== null && typeof item !== "string")) keyboardError("SP_KEYBOARD_UNSUPPORTED", "SP returned a keyboard value that cannot be safely preserved.");
  return Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export function projectKeyboardSettings(raw, requireComplete = false) {
  if (!keyboardRecord(raw) || KEYBOARD_APP_KEYS.some((key) => requireComplete && !Object.hasOwn(raw, key) || Object.hasOwn(raw, key) && raw[key] !== null && raw[key] !== undefined && typeof raw[key] !== "string" || requireComplete && raw[key] === undefined)) keyboardError("SP_KEYBOARD_UNSUPPORTED", "SP did not return valid application keyboard settings.");
  return Object.fromEntries(KEYBOARD_APP_KEYS.map((key) => [key, Object.hasOwn(raw, key) ? raw[key] ?? null : null]));
}

function existingKeyboardChords(field, value) {
  if (typeof value !== "string" || !value) return [];
  if (field === "showHelp" && value === "?") return ["help:?"];
  if (!KEYBOARD_GLOBAL_KEYS.includes(field)) {
    // Match SP's existing-value parser, including malformed legacy Ctrl++K:
    // any embedded ++ means the plus key; empty tokens and unknown modifiers
    // are ignored. New input still uses the stricter normalizer above.
    const lower = value.toLowerCase(), tokens = lower.split("+").filter(Boolean);
    const plus = lower.includes("++"), key = lower === "+" || plus ? "+" : tokens.at(-1);
    if (!key) return [];
    const modifiers = plus ? tokens : tokens.slice(0, -1);
    return [[...keyboardModifiers.filter((item) => modifiers.includes(item.toLowerCase())), key].join("+").toLowerCase()];
  }
  const parts = keyboardParts(value.toLowerCase());
  if (!parts.key) return [];
  const aliases = { control: "ctrl", command: "meta", cmd: "meta", super: "meta", option: "alt" };
  const modifiers = parts.modifiers.map((item) => aliases[item] || item);
  const crossPlatform = modifiers.includes("commandorcontrol") || modifiers.includes("cmdorctrl");
  const variants = crossPlatform ? ["ctrl", "meta"] : [null];
  const keyAliases = { plus: "+", return: "enter", esc: "escape", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright" };
  return variants.map((variant) => [...keyboardModifiers.filter((item) => modifiers.includes(item.toLowerCase()) || item.toLowerCase() === variant), keyAliases[parts.key] || parts.key].join("+").toLowerCase());
}

export function findKeyboardConflicts(before, after, updates) {
  const conflicts = [], seen = new Set();
  for (const changed of Object.keys(updates)) {
    if (after[changed] === before[changed]) continue;
    const chords = existingKeyboardChords(changed, after[changed]);
    for (const other of Object.keys(after)) {
      if (other === changed) continue;
      const shared = chords.filter((chord) => existingKeyboardChords(other, after[other]).includes(chord));
      const introduced = shared.some((chord) => !existingKeyboardChords(changed, before[changed]).includes(chord) || !existingKeyboardChords(other, before[other]).includes(chord));
      if (!introduced) continue;
      const keys = [changed, other].sort(), pair = JSON.stringify(keys);
      if (!seen.has(pair)) { seen.add(pair); conflicts.push({ keys }); }
    }
  }
  return conflicts;
}
