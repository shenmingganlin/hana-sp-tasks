// Fixed public SP actions. This contract never accepts action names or payloads.
export const UI_CONTROL_COMMANDS = Object.freeze([
  "focus.show", "focus.hide", "addTask.show", "addTask.hide",
  "notes.toggle", "sidePanel.hide", "issues.toggle", "pluginPanel.hide",
]);
const uiControlRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function uiControlError(message) {
  throw Object.assign(new Error(message), { code: "SP_BAD_INPUT" });
}

export function validateUiControlCommand(op, args) {
  if (op !== "ui.command") uiControlError("Unsupported UI operation; only fixed ui.command requests are accepted.");
  if (!uiControlRecord(args)) uiControlError("UI command arguments must be an object.");
  const unknown = Object.keys(args).filter((key) => key !== "command");
  if (unknown.length) uiControlError(`Unexpected UI command argument: ${unknown.join(", ")}.`);
  if (!Object.hasOwn(args, "command") || !UI_CONTROL_COMMANDS.includes(args.command)) uiControlError(`command must be one of: ${UI_CONTROL_COMMANDS.join(", ")}.`);
  return { command: args.command };
}
