// Shared by Hana and the SP plugin; this is a local UI action, not a persisted edit.
export const WORK_CONTEXT_OPS = Object.freeze(["workContext.list", "workContext.switch"]);
export const WORK_CONTEXT_ACTION = "[WorkContext] Set Active Work Context";
export const WORK_CONTEXT_TYPES = Object.freeze(["PROJECT", "TAG", "TODAY"]);
export const WORK_CONTEXT_TARGET_TYPES = Object.freeze(["project", "tag"]);

const workContextRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const workContextExactId = (value) => typeof value === "string" && value.length > 0 && value.length <= 240 && value === value.trim() && !/[\u0000-\u001f\u007f\\/]/.test(value) && ![".", ".."].includes(value);
function workContextError(code, message) { throw Object.assign(new Error(message), { code }); }
function workContextIdentity(value) {
  return workContextRecord(value) && workContextExactId(value.id) && WORK_CONTEXT_TYPES.includes(value.type) && (value.type === "TODAY") === (value.id === "TODAY");
}

export function workContextTargetIdentity(contextType, contextId) {
  return { id: contextId, type: contextId === "TODAY" ? "TODAY" : contextType === "project" ? "PROJECT" : "TAG" };
}

export function validateWorkContextCommand(op, args) {
  if (!WORK_CONTEXT_OPS.includes(op) || !workContextRecord(args)) workContextError("SP_BAD_INPUT", "Unsupported work-context operation or arguments.");
  const allowed = op === "workContext.list" ? [] : ["contextType", "contextId", "expected"];
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) workContextError("SP_BAD_INPUT", `Unexpected work-context argument: ${unknown.join(", ")}.`);
  if (op === "workContext.list") return {};
  if (!WORK_CONTEXT_TARGET_TYPES.includes(args.contextType) || !workContextExactId(args.contextId)) workContextError("SP_BAD_INPUT", "An exact project or tag context is required.");
  if (args.contextId === "TODAY" && args.contextType !== "tag" || args.contextId === "INBOX_PROJECT" && args.contextType !== "project") workContextError("SP_BAD_INPUT", "TODAY is a tag context and INBOX_PROJECT is a project context.");
  if (!workContextIdentity(args.expected) || Object.keys(args.expected).length !== 2 || Object.keys(args.expected).some((key) => !["id", "type"].includes(key))) workContextError("SP_BAD_INPUT", "expected must contain only the id and type of the current context returned by get.");
  return { contextType: args.contextType, contextId: args.contextId, expected: { id: args.expected.id, type: args.expected.type } };
}

export function projectWorkContext(value) {
  if (value === null) return null;
  if (!workContextIdentity(value) || typeof value.title !== "string" || !Array.isArray(value.taskIds) || value.taskIds.some((id) => !workContextExactId(id)) || new Set(value.taskIds).size !== value.taskIds.length) workContextError("SP_CONTEXT_BAD_STATE", "SP did not return a valid active work context.");
  return { id: value.id, type: value.type, title: value.title, taskIds: [...value.taskIds], localOnly: true };
}
