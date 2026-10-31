import { WORK_CONTEXT_ACTION, validateWorkContextCommand, workContextTargetIdentity, projectWorkContext } from "../../sp-tasks/lib/work-context-contract.js";

export async function executeWorkContext(api, op, args, { write, fail }) {
  let input;
  try { input = validateWorkContextCommand(op, args); }
  catch (error) { return fail("SP_BAD_INPUT", error.message); }
  if (typeof api.getActiveWorkContext !== "function") return fail("SP_CONTEXT_UNSUPPORTED", "SP does not provide its public active-context snapshot.");
  const read = async () => {
    let value;
    try { value = await api.getActiveWorkContext(); }
    catch { return fail("SP_CONTEXT_READ_FAILED", "SP could not return its active work context."); }
    try { return projectWorkContext(value); }
    catch { return fail("SP_CONTEXT_BAD_STATE", "SP did not return a valid active work context."); }
  };
  if (op === "workContext.list") return { context: await read() };
  if (typeof api.getAppState !== "function") return fail("SP_CONTEXT_UNSUPPORTED", "SP does not provide a project and tag snapshot for validating the destination.");
  let state;
  try { state = await api.getAppState(); }
  catch { return fail("SP_CONTEXT_READ_FAILED", "SP could not validate the destination context."); }
  const isProject = input.contextType === "project", entities = state?.[isProject ? "projects" : "tags"];
  if (!entities || typeof entities !== "object" || Array.isArray(entities)) return fail("SP_CONTEXT_BAD_STATE", "SP did not return the destination context store.");
  const target = Object.hasOwn(entities, input.contextId) ? entities[input.contextId] : null;
  if (!target || typeof target !== "object" || Array.isArray(target) || target.id !== input.contextId) return fail(isProject ? "SP_NO_PROJECT" : "SP_NO_TAG", "The exact destination context does not exist.");
  if (isProject && target.isArchived === true) return fail("SP_ARCHIVED_PROJECT", "Restore the project in SP before switching to it.");
  // Check the expected context after the asynchronous destination lookup, as
  // close to dispatch as the public API permits. SP provides no atomic CAS.
  const context = await read();
  if (context === null) return fail("SP_CONTEXT_NOT_READY", "SP's current context is unavailable. Wait for SP to finish loading and read it again.");
  if (context.id !== input.expected.id || context.type !== input.expected.type) return fail("SP_CONTEXT_CONFLICT", "The active context changed after it was read. Read it again before switching.");
  const desired = workContextTargetIdentity(input.contextType, input.contextId);
  if (context.id === desired.id && context.type === desired.type) return { context, unchanged: true, verification: "applied-state" };
  if (typeof api.dispatchAction !== "function") return fail("SP_CONTEXT_UNSUPPORTED", "SP does not provide the public work-context action.");
  // SP 19.3.1 clears task selection and refreshes context integrations. This
  // action changes local context state; it neither navigates nor stops tracking.
  await write(() => api.dispatchAction({ type: WORK_CONTEXT_ACTION, activeId: input.contextId, activeType: isProject ? "PROJECT" : "TAG" }));
  const after = await read();
  if (after === null || after.id !== desired.id || after.type !== desired.type) return fail("SP_VERIFY_FAILED", "SP did not confirm the requested active context. Read the current context before retrying.");
  return { context: after, unchanged: false, verification: "applied-state" };
}
