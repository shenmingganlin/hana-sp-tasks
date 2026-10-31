import { validateUiControlCommand } from "../../sp-tasks/lib/ui-control-contract.js";

const uiControlActions = Object.freeze({
  "focus.show": "[FocusMode] Show Overlay",
  "focus.hide": "[FocusMode] Hide Overlay",
  "addTask.show": "[Layout] Show AddTaskBar",
  "addTask.hide": "[Layout] Hide AddTaskBar",
  "notes.toggle": "[Layout] ToggleShow Notes",
  "sidePanel.hide": "[Layout] Hide Non-Task Side Panel",
  "issues.toggle": "[Layout] Toggle IssuePanel",
  "pluginPanel.hide": "[Layout] Hide PluginPanel",
});

export async function executeUiControl(api, op, args, { write, fail }) {
  let input;
  try { input = validateUiControlCommand(op, args); }
  catch (error) { return fail(error.code || "SP_BAD_INPUT", error.message); }
  if (typeof api.dispatchAction !== "function") return fail("SP_UI_CONTROL_UNSUPPORTED", "SP does not provide the public action dispatcher.");
  await write(() => api.dispatchAction({ type: uiControlActions[input.command] }));
  // Public snapshots omit layout and overlay visibility; dispatch is not a render acknowledgement.
  return { command: input.command, submitted: true, verification: "submitted" };
}
