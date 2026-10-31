import { PREFERENCE_FIELDS, PREFERENCE_CONFIG_SECTIONS, validatePreferenceCommand, projectPreferences } from "../../sp-tasks/lib/preferences-contract.js";

export async function executePreferences(api, op, args, { write, fail }) {
  let input;
  try { input = validatePreferenceCommand(op, args); }
  catch (error) { return fail(error.code || "SP_BAD_INPUT", error.message); }
  const configSection = PREFERENCE_CONFIG_SECTIONS[input.section];
  const read = async () => {
    if (typeof api.getAppState !== "function") return fail("SP_PREFERENCES_UNSUPPORTED", "SP does not provide a preferences snapshot.");
    const state = await api.getAppState();
    try { return projectPreferences(input.section, state?.globalConfig?.[configSection]); }
    catch (error) { return fail(error.code || "SP_PREFERENCES_UNSUPPORTED", error.message); }
  };
  const settings = await read();
  if (op === "preferences.list") return { section: input.section, settings };
  if (PREFERENCE_FIELDS[input.section].some((key) => settings[key] !== input.expected[key])) {
    return fail("SP_PREFERENCES_CONFLICT", "Preferences changed after they were read. Read the current settings before updating them.");
  }
  const changed = Object.keys(input.updates).some((key) => input.updates[key] !== settings[key]);
  if (!changed) return { section: input.section, settings, unchanged: true, verification: "applied-state" };
  if (typeof api.dispatchAction !== "function") return fail("SP_PREFERENCES_UNSUPPORTED", "SP does not provide the public preferences action.");
  // Mirrors SP 19.3.1's action creator; without this metadata no op is persisted.
  const action = {
    type: "[Global Config] Update Global Config Section",
    sectionKey: configSection,
    sectionCfg: input.updates,
    isSkipSnack: true,
    meta: { isPersistent: true, entityType: "GLOBAL_CONFIG", entityId: configSection, opType: "UPD" },
  };
  await write(() => api.dispatchAction(action));
  const after = await read();
  const desired = { ...settings, ...input.updates };
  if (PREFERENCE_FIELDS[input.section].some((key) => after[key] !== desired[key])) {
    return fail("SP_VERIFY_FAILED", "SP did not retain the requested preferences or another supported field changed. Read current settings before retrying.");
  }
  return { section: input.section, settings: after, unchanged: false, verification: "applied-state" };
}
