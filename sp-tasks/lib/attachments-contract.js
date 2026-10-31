// Shared by Hana and the SP plugin. URLs are attachment metadata, never fetched.
export const ATTACHMENT_OPS = Object.freeze(["attachments.list", "attachments.add", "attachments.remove"]);
export const ATTACHMENT_URL_LIMIT = 4096;
export const ATTACHMENT_TITLE_LIMIT = 1000;
export const ATTACHMENT_COUNT_LIMIT = 1000;
export const ATTACHMENT_BYTES_LIMIT = 256 * 1024;

const attachmentRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const attachmentExactId = (value) => typeof value === "string" && value.length > 0 && value.length <= 240 && value === value.trim() && !/[\u0000-\u001f\u007f\\/]/.test(value) && ![".", ".."].includes(value);
export const attachmentRevisionValid = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function attachmentError(code, message) { throw Object.assign(new Error(message), { code }); }

export function normalizeAttachmentUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > ATTACHMENT_URL_LIMIT || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value) || !/^https?:\/\//i.test(value)) attachmentError("SP_BAD_INPUT", "url must be an absolute HTTP or HTTPS URL without whitespace or backslashes.");
  let url;
  try { url = new URL(value); }
  catch { attachmentError("SP_BAD_INPUT", "url must be a valid absolute HTTP or HTTPS URL."); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.href.length > ATTACHMENT_URL_LIMIT) attachmentError("SP_BAD_INPUT", "url must use HTTP or HTTPS and must not contain embedded credentials.");
  return url.href;
}

export function validateAttachmentCommand(op, args) {
  if (!ATTACHMENT_OPS.includes(op) || !attachmentRecord(args)) attachmentError("SP_BAD_INPUT", "Unsupported attachment operation or arguments.");
  const allowed = op === "attachments.list" ? ["taskId"] : op === "attachments.add" ? ["taskId", "url", "title", "expectedRevision"] : ["taskId", "attachmentId", "expectedRevision"];
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) attachmentError("SP_BAD_INPUT", `Unexpected attachment argument: ${unknown.join(", ")}.`);
  if (!Object.hasOwn(args, "taskId") || !attachmentExactId(args.taskId)) attachmentError("SP_BAD_INPUT", "taskId must be an exact active task ID, not a path.");
  if (op === "attachments.list") return { taskId: args.taskId };
  if (!Object.hasOwn(args, "expectedRevision") || !attachmentRevisionValid(args.expectedRevision)) attachmentError("SP_BAD_INPUT", "expectedRevision must be the complete revision just returned by list.");
  if (op === "attachments.remove") {
    if (!Object.hasOwn(args, "attachmentId") || !attachmentExactId(args.attachmentId)) attachmentError("SP_BAD_INPUT", "attachmentId must be an exact link attachment ID.");
    return { taskId: args.taskId, attachmentId: args.attachmentId, expectedRevision: args.expectedRevision };
  }
  const url = normalizeAttachmentUrl(args.url);
  if (Object.hasOwn(args, "title") && (typeof args.title !== "string" || args.title.length > ATTACHMENT_TITLE_LIMIT || /[\u0000-\u001f\u007f]/.test(args.title))) attachmentError("SP_BAD_INPUT", "title must be a single-line string of at most 1000 characters.");
  return { taskId: args.taskId, url, ...(Object.hasOwn(args, "title") ? { title: args.title } : {}), expectedRevision: args.expectedRevision };
}

export function projectAttachmentSnapshot(value) {
  if (!attachmentRecord(value) || !attachmentExactId(value.taskId) || !attachmentRevisionValid(value.revision) || !Array.isArray(value.attachments) || !Number.isSafeInteger(value.totalCount) || value.totalCount < 0 || value.totalCount > ATTACHMENT_COUNT_LIMIT || !Number.isSafeInteger(value.otherCount) || value.otherCount < 0 || value.otherCount + value.attachments.length !== value.totalCount) attachmentError("SP_ATTACHMENT_BAD_STATE", "SP did not return a complete attachment snapshot.");
  const seen = new Set();
  const attachments = value.attachments.map((row) => {
    if (!attachmentRecord(row) || !attachmentExactId(row.id) || seen.has(row.id) || row.type !== "LINK" || Object.hasOwn(row, "title") && (typeof row.title !== "string" || row.title.length > ATTACHMENT_TITLE_LIMIT || /[\u0000-\u001f\u007f]/.test(row.title))) attachmentError("SP_ATTACHMENT_BAD_STATE", "SP did not return valid, unambiguous link attachments.");
    let url;
    try { url = normalizeAttachmentUrl(row.url); }
    catch { attachmentError("SP_ATTACHMENT_BAD_STATE", "SP returned an unsupported attachment URL."); }
    if (url !== row.url) attachmentError("SP_ATTACHMENT_BAD_STATE", "SP did not return a normalized attachment URL.");
    seen.add(row.id);
    return { id: row.id, type: "LINK", url, ...(Object.hasOwn(row, "title") ? { title: row.title } : {}) };
  });
  return { taskId: value.taskId, attachments, revision: value.revision, totalCount: value.totalCount, otherCount: value.otherCount };
}
