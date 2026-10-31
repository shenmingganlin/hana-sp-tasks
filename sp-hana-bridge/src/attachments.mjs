import { ATTACHMENT_BYTES_LIMIT, ATTACHMENT_COUNT_LIMIT, ATTACHMENT_TITLE_LIMIT, attachmentExactId, normalizeAttachmentUrl, validateAttachmentCommand } from "../../sp-tasks/lib/attachments-contract.js";

const attachmentObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const attachmentTypes = new Set(["FILE", "LINK", "IMG", "COMMAND", "NOTE"]);

function attachmentJson(value, fail) {
  const seen = new Set();
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 20000 || depth > 32) return fail("SP_ATTACHMENT_LIMIT", "Attachment metadata exceeds the supported snapshot limit.");
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "string") {
      if (item.length > ATTACHMENT_BYTES_LIMIT) return fail("SP_ATTACHMENT_LIMIT", "Attachment metadata exceeds the supported snapshot limit.");
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (item === undefined) return undefined;
    if (typeof item !== "object" || seen.has(item)) return fail("SP_ATTACHMENT_BAD_STATE", "SP returned non-serializable attachment metadata.");
    seen.add(item);
    let result;
    if (Array.isArray(item)) result = `[${Array.from(item, (row) => visit(row, depth + 1) ?? "null").join(",")}]`;
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) return fail("SP_ATTACHMENT_BAD_STATE", "SP returned unsupported attachment metadata.");
      result = `{${Object.keys(item).sort().flatMap((key) => { const entry = visit(item[key], depth + 1); return entry === undefined ? [] : [`${JSON.stringify(key)}:${entry}`]; }).join(",")}}`;
    }
    seen.delete(item);
    if (result.length > ATTACHMENT_BYTES_LIMIT) return fail("SP_ATTACHMENT_LIMIT", "Attachment metadata exceeds the supported snapshot limit.");
    return result;
  }
  const json = visit(value, 0);
  if (typeof json !== "string" || new TextEncoder().encode(json).length > ATTACHMENT_BYTES_LIMIT) return fail("SP_ATTACHMENT_LIMIT", "Attachment metadata exceeds the supported snapshot limit.");
  return json;
}

function attachmentRaw(raw, fail) {
  if (!Array.isArray(raw)) return fail("SP_ATTACHMENT_BAD_STATE", "SP did not return the task's complete attachment array.");
  if (raw.length > ATTACHMENT_COUNT_LIMIT) return fail("SP_ATTACHMENT_LIMIT", "This task has too many attachments for a verified update.");
  for (const row of raw) {
    if (!attachmentObject(row) || !(row.id === null || typeof row.id === "string") || !attachmentTypes.has(row.type) || ["path", "title", "icon", "originalImgPath"].some((key) => row[key] !== undefined && typeof row[key] !== "string")) return fail("SP_ATTACHMENT_BAD_STATE", "SP returned an attachment outside its supported model.");
  }
  return [...raw];
}

function attachmentLinks(raw) {
  const counts = new Map();
  for (const row of raw) if (typeof row.id === "string") counts.set(row.id, (counts.get(row.id) || 0) + 1);
  return raw.flatMap((row) => {
    if (row.type !== "LINK" || !attachmentExactId(row.id) || counts.get(row.id) !== 1 || row.title !== undefined && (row.title.length > ATTACHMENT_TITLE_LIMIT || /[\u0000-\u001f\u007f]/.test(row.title))) return [];
    let url;
    try { url = normalizeAttachmentUrl(row.path); }
    catch { return []; }
    return [{ id: row.id, type: "LINK", url, ...(row.title !== undefined ? { title: row.title } : {}) }];
  });
}

async function attachmentDigest(json, fail) {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") return fail("SP_ATTACHMENT_UNSUPPORTED", "Secure SHA-256 snapshots are unavailable in this SP runtime.");
  let digest;
  try { digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)); }
  catch { return fail("SP_ATTACHMENT_READ_FAILED", "SP could not compute a secure attachment revision."); }
  if (!(digest instanceof ArrayBuffer) || digest.byteLength !== 32) return fail("SP_ATTACHMENT_BAD_STATE", "The attachment revision provider returned an invalid digest.");
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function attachmentNewId(raw, fail) {
  let suffix;
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") suffix = globalThis.crypto.randomUUID();
    else if (typeof globalThis.crypto?.getRandomValues === "function") suffix = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch { return fail("SP_ATTACHMENT_UNSUPPORTED", "Secure attachment ID generation is unavailable."); }
  if (typeof suffix !== "string" || !/^[a-fA-F0-9-]{32,36}$/.test(suffix)) return fail("SP_ATTACHMENT_UNSUPPORTED", "Secure attachment ID generation is unavailable.");
  const id = `hana-link-${suffix}`;
  if (raw.some((row) => row.id === id)) return fail("SP_ATTACHMENT_ID_COLLISION", "The generated attachment ID already exists. No attachment was added.");
  return id;
}

export async function executeAttachments(api, op, args, { write, fail }) {
  let input;
  try { input = validateAttachmentCommand(op, args); }
  catch (error) { return fail("SP_BAD_INPUT", error.message); }
  if (typeof api.getAppState !== "function") return fail("SP_ATTACHMENT_UNSUPPORTED", "SP does not provide its public active-task snapshot.");
  const read = async () => {
    let state;
    try { state = await api.getAppState(); }
    catch { return fail("SP_ATTACHMENT_READ_FAILED", "SP could not return the active task's attachments."); }
    if (!attachmentObject(state?.tasks)) return fail("SP_ATTACHMENT_BAD_STATE", "SP did not return its active task store.");
    if (!Object.hasOwn(state.tasks, input.taskId)) return fail("SP_NO_TASK", "The exact task is not in SP's active task store. Archived snapshots are not editable.");
    const task = state.tasks[input.taskId];
    if (!attachmentObject(task) || task.id !== input.taskId) return fail("SP_ATTACHMENT_BAD_STATE", "SP returned a different or invalid task identity.");
    const raw = attachmentRaw(task.attachments, fail);
    return { raw, json: attachmentJson(raw, fail) };
  };
  const project = async (snapshot) => {
    const attachments = attachmentLinks(snapshot.raw);
    return { taskId: input.taskId, attachments, revision: await attachmentDigest(snapshot.json, fail), totalCount: snapshot.raw.length, otherCount: snapshot.raw.length - attachments.length };
  };
  const before = await read(), current = await project(before);
  if (op === "attachments.list") return current;
  if (current.revision !== input.expectedRevision) return fail("SP_ATTACHMENT_CONFLICT", "Attachments changed after they were read. List them again before deciding whether to retry.");
  let attachmentId, desired;
  if (op === "attachments.add") {
    const duplicates = before.raw.filter((row) => { if (row.type !== "LINK") return false; try { return normalizeAttachmentUrl(row.path) === input.url; } catch { return false; } });
    if (duplicates.length) return fail("SP_ATTACHMENT_DUPLICATE", "A link with the same normalized URL already exists. List attachments to identify it; no duplicate was added.");
    attachmentId = attachmentNewId(before.raw, fail);
    desired = [...before.raw, { id: attachmentId, type: "LINK", path: input.url, ...(Object.hasOwn(input, "title") ? { title: input.title } : {}), icon: "bookmark" }];
    attachmentRaw(desired, fail);
  } else {
    attachmentId = input.attachmentId;
    const matched = before.raw.filter((row) => row.id === attachmentId);
    if (matched.length === 0) return { ...current, attachmentId, unchanged: true, verification: "applied-state" };
    if (matched.length !== 1 || !current.attachments.some((row) => row.id === attachmentId)) return fail("SP_ATTACHMENT_UNSUPPORTED", "Only an unambiguous HTTP or HTTPS LINK attachment can be removed. Other attachment types are preserved.");
    desired = before.raw.filter((row) => row.id !== attachmentId);
  }
  const desiredJson = attachmentJson(desired, fail);
  if (typeof api.updateTask !== "function") return fail("SP_ATTACHMENT_UNSUPPORTED", "SP does not provide its public task update method.");
  // Re-read after asynchronous hashing. SP exposes no atomic compare-and-swap;
  // the unchanged raw objects preserve every unrelated attachment field.
  const latest = await read();
  if (latest.json !== before.json) return fail("SP_ATTACHMENT_CONFLICT", "Attachments changed during validation. List them again; no update was sent.");
  await write(async () => {
    try { await api.updateTask(input.taskId, { attachments: desired }); }
    catch { return fail("SP_ATTACHMENT_WRITE_FAILED", "SP could not confirm the attachment update. List attachments before retrying."); }
  });
  const after = await read();
  if (after.json !== desiredJson) return fail("SP_VERIFY_FAILED", "SP did not confirm the complete attachment array. List attachments before retrying; no update was repeated.");
  return { ...await project(after), attachmentId, unchanged: false, verification: "applied-state" };
}
