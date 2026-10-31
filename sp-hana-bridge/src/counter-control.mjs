import { validateCounterControlCommand, projectCounterControl } from "../../sp-tasks/lib/counter-control-contract.js";

export async function executeCounterControl(api, op, args, { write, fail }) {
  let input;
  try { input = validateCounterControlCommand(op, args); }
  catch (error) { return fail(error.code || "SP_BAD_INPUT", error.message); }
  const read = async () => {
    if (typeof api.getSimpleCounter !== "function") return fail("SP_COUNTER_CONTROL_UNSUPPORTED", "SP does not provide the public counter snapshot method.");
    const raw = await api.getSimpleCounter(input.counterId);
    if (raw === null || raw === undefined) return fail("SP_NO_COUNTER", "The exact counter ID does not exist.");
    let counter;
    try { counter = projectCounterControl(raw); }
    catch (error) { return fail(error.code || "SP_COUNTER_CONTROL_UNSUPPORTED", error.message); }
    if (counter.id !== input.counterId) return fail("SP_BAD_STATE", "SP returned a different counter ID.");
    return counter;
  };
  const counter = await read();
  if (op === "counterControl.list") return { counter, localOnly: true };
  const desired = op === "counterControl.start";
  if (counter.type !== input.expected.type || counter.isEnabled !== input.expected.isEnabled) return fail("SP_COUNTER_CONTROL_CONFLICT", "Counter type or enabled state changed. Read status before deciding whether to retry.");
  if (desired && counter.type === "RepeatedCountdownReminder") return fail("SP_COUNTER_CONTROL_UNSUPPORTED", "SP's public toggle does not initialize a repeated countdown. Start or resume it in SP; this tool can only inspect or pause it without clearing its cached countdown or completion banner.");
  if (desired && !counter.isEnabled) return fail("SP_COUNTER_DISABLED", "This stopwatch is disabled. Enable it explicitly before starting; this operation does not change its enabled setting.");
  // An already-achieved target is safe after an unknown reply; never toggle it back.
  if (counter.isOn === desired) return { counter, localOnly: true, unchanged: true, verification: "applied-state" };
  if (counter.isOn !== input.expected.isOn) return fail("SP_COUNTER_CONTROL_CONFLICT", "Counter switch state changed. Read status before deciding whether to retry.");
  if (typeof api.toggleSimpleCounter !== "function") return fail("SP_COUNTER_CONTROL_UNSUPPORTED", "SP does not provide the public counter switch method.");
  await write(() => api.toggleSimpleCounter(input.counterId));
  const after = await read();
  if (after.type !== counter.type || after.isEnabled !== counter.isEnabled || after.isOn !== desired) return fail("SP_VERIFY_FAILED", "SP did not confirm the requested counter switch state. Read status before retrying; no second toggle was sent.");
  return { counter: after, localOnly: true, unchanged: false, verification: "applied-state" };
}
