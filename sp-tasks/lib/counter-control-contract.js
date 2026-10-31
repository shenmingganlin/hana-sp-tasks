// Shared by Hana and the SP plugin; all values are copied before execution.
export const COUNTER_CONTROL_TYPES = Object.freeze(["StopWatch", "RepeatedCountdownReminder"]);
export const COUNTER_CONTROL_FIELDS = Object.freeze(["id", "type", "isEnabled", "isOn"]);
export const COUNTER_CONTROL_PROPERTIES = Object.freeze({
  id: { type: "string", minLength: 1, maxLength: 240 },
  type: { type: "string", enum: COUNTER_CONTROL_TYPES },
  isEnabled: { type: "boolean" },
  isOn: { type: "boolean" },
});
const counterControlRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const counterControlId = (value) => typeof value === "string" && value.length > 0 && value.length <= 240 && value.trim() === value && value !== "." && value !== ".." && !/[\u0000-\u001f\u007f/\\]/.test(value);
function counterControlError(code, message) {
  throw Object.assign(new Error(message), { code });
}
function counterControlState(value, code) {
  if (!counterControlRecord(value) || COUNTER_CONTROL_FIELDS.some((key) => !Object.hasOwn(value, key)) ||
      !counterControlId(value.id) || !COUNTER_CONTROL_TYPES.includes(value.type) ||
      typeof value.isEnabled !== "boolean" || typeof value.isOn !== "boolean") {
    counterControlError(code, "A complete StopWatch or RepeatedCountdownReminder state is required; click counters have no supported start/stop control.");
  }
  return Object.fromEntries(COUNTER_CONTROL_FIELDS.map((key) => [key, value[key]]));
}

export function validateCounterControlCommand(op, args) {
  if (!["counterControl.list", "counterControl.start", "counterControl.stop"].includes(op)) counterControlError("SP_BAD_INPUT", "Unsupported counter control operation; use status, start or stop, never toggle.");
  const writing = op !== "counterControl.list";
  const allowed = writing ? ["counterId", "expected"] : ["counterId"];
  if (!counterControlRecord(args)) counterControlError("SP_BAD_INPUT", "Counter control arguments must be an object.");
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) counterControlError("SP_BAD_INPUT", `Unexpected counter control argument: ${unknown.join(", ")}.`);
  if (!Object.hasOwn(args, "counterId") || !counterControlId(args.counterId)) counterControlError("SP_BAD_INPUT", "counterId must be an exact existing counter ID, not a path.");
  if (!writing) return { counterId: args.counterId };
  if (!Object.hasOwn(args, "expected") || !counterControlRecord(args.expected)) counterControlError("SP_BAD_INPUT", "expected must be the complete counter object just returned by status.");
  const extraExpected = Object.keys(args.expected).filter((key) => !COUNTER_CONTROL_FIELDS.includes(key));
  if (extraExpected.length) counterControlError("SP_BAD_INPUT", `Unexpected expected counter field: ${extraExpected.join(", ")}.`);
  const expected = counterControlState(args.expected, "SP_BAD_INPUT");
  if (expected.id !== args.counterId) counterControlError("SP_BAD_INPUT", "expected.id must match counterId exactly.");
  return { counterId: args.counterId, expected };
}

export function projectCounterControl(value) {
  return counterControlState(value, "SP_COUNTER_CONTROL_UNSUPPORTED");
}
