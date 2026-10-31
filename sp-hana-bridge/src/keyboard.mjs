import { validateKeyboardCommand, snapshotKeyboard, projectKeyboardSettings, findKeyboardConflicts } from "../../sp-tasks/lib/keyboard-contract.js";

export async function executeKeyboard(api, op, args, { write, fail }) {
  let input;
  try { input = validateKeyboardCommand(op, args); }
  catch (error) { return fail("SP_BAD_INPUT", error.message); }
  if (typeof api.getAppState !== "function" || typeof globalThis.crypto?.subtle?.digest !== "function" || typeof TextEncoder !== "function") return fail("SP_KEYBOARD_UNSUPPORTED", "SP does not provide the snapshot and SHA-256 support required for keyboard updates.");
  const read = async () => {
    let state;
    try { state = await api.getAppState(); }
    catch { return fail("SP_KEYBOARD_READ_FAILED", "SP could not return its keyboard configuration."); }
    let raw;
    try { raw = snapshotKeyboard(state?.globalConfig?.keyboard); }
    catch (error) { return fail(error.code, error.message); }
    const serialized = JSON.stringify(Object.entries(raw));
    let bytes;
    try { bytes = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized))); }
    catch { return fail("SP_KEYBOARD_UNSUPPORTED", "SP could not calculate the keyboard configuration revision."); }
    if (bytes.length !== 32) return fail("SP_KEYBOARD_UNSUPPORTED", "SP returned an invalid keyboard configuration revision.");
    return { raw, serialized, revision: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") };
  };
  const before = await read();
  if (op === "keyboard.list") return { settings: projectKeyboardSettings(before.raw), revision: before.revision };
  if (before.revision !== input.expectedRevision) return fail("SP_KEYBOARD_CONFLICT", "Keyboard configuration changed after get. Read it again before updating.");
  const changed = Object.entries(input.updates).some(([key, value]) => (before.raw[key] ?? null) !== value);
  if (!changed) return { settings: projectKeyboardSettings(before.raw), revision: before.revision, unchanged: true, verification: "applied-state", conflicts: [] };
  // getAppState does not expose the keyboard layout. The help handler matches
  // event.key and AltGr, so its overlap cannot be proved by chord text alone.
  const helpLayoutDependent = input.updates.showHelp === "?" && before.raw.showHelp !== "?";
  if (helpLayoutDependent && input.allowConflicts !== true) return fail("SP_KEYBOARD_BINDING_CONFLICT", "The ? help binding is keyboard-layout-dependent. Use allowConflicts:true only after the user accepts possible layout-dependent conflicts.");
  const desired = snapshotKeyboard({ ...before.raw, ...input.updates });
  const conflicts = findKeyboardConflicts(before.raw, desired, input.updates);
  if (conflicts.length && input.allowConflicts !== true) return fail("SP_KEYBOARD_BINDING_CONFLICT", `Shortcut conflicts between fields: ${[...new Set(conflicts.flatMap((item) => item.keys))].join(", ")}. Use allowConflicts:true only to accept these conflicts.`);
  if (typeof api.dispatchAction !== "function") return fail("SP_KEYBOARD_UNSUPPORTED", "SP does not provide the public configuration action.");
  const latest = await read();
  if (latest.revision !== input.expectedRevision) return fail("SP_KEYBOARD_CONFLICT", "Keyboard configuration changed before the write. Read it again before updating.");
  // SP's keyboard effect unregisters all global shortcuts, then registers only
  // this payload. Preserve the complete latest dictionary, including plugin keys.
  const sectionCfg = snapshotKeyboard({ ...latest.raw, ...input.updates });
  const desiredSerialized = JSON.stringify(Object.entries(sectionCfg));
  await write(() => api.dispatchAction({
    type: "[Global Config] Update Global Config Section", sectionKey: "keyboard", sectionCfg, isSkipSnack: true,
    meta: { isPersistent: true, entityType: "GLOBAL_CONFIG", entityId: "keyboard", opType: "UPD" },
  }));
  const after = await read();
  if (after.serialized !== desiredSerialized) return fail("SP_VERIFY_FAILED", "SP did not retain the complete requested keyboard configuration. Read it again; do not automatically retry.");
  return { settings: projectKeyboardSettings(after.raw), revision: after.revision, unchanged: false, verification: "applied-state", conflicts, ...(helpLayoutDependent ? { warnings: ["help-layout-dependent"] } : {}) };
}
