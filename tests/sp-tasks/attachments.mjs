import assert from "node:assert/strict";
import test from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { ATTACHMENT_OPS, validateAttachmentCommand, normalizeAttachmentUrl, projectAttachmentSnapshot } from "../../sp-tasks/lib/attachments-contract.js";
import { executeAttachments } from "../../sp-hana-bridge/src/attachments.mjs";
import { registerAttachmentTools, ATTACHMENT_CAPABILITIES } from "../../sp-tasks/lib/attachments-tools.js";
import { readNotice, resetNoticeCache } from "../../sp-tasks/lib/notice.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in attachment tests"); };
const clone = (value) => structuredClone(value);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const listArgs = { taskId: "a" };
const zeroRevision = "0".repeat(64);
const addArgs = (expectedRevision = zeroRevision) => ({ taskId: "a", url: "https://new.invalid/resource", title: "New link", expectedRevision });
const removeArgs = (expectedRevision = zeroRevision, attachmentId = "l1") => ({ taskId: "a", attachmentId, expectedRevision });

function fixture() {
  const state = {
    tasks: {
      a: { id: "a", title: "Active", isDone: true, doneOn: 12345, wontDoOn: 44, notes: "secret-value", projectId: "p1", attachments: [
        { id: "l1", type: "LINK", path: "https://example.invalid/docs", title: "Docs", icon: "bookmark", custom: { revision: 3, labels: ["retained", "verbatim"] } },
        { id: "f1", type: "FILE", path: "C:\\private\\document.txt", title: "File", custom: { flags: [true, false], value: "non-link-metadata" } },
        { id: "img1", type: "IMG", path: "https://image.invalid/a.png", originalImgPath: "C:\\private\\original.png", extra: "image-metadata" },
        { id: null, type: "LINK", path: "https://legacy.invalid/" },
        { id: "mail", type: "LINK", path: "mailto:user@example.invalid" },
        { id: "cmd1", type: "COMMAND", path: "inert legacy command", retained: { nested: [{ key: "value" }] } },
      ] },
      parent: { id: "parent", attachments: [], subTasks: [{ id: "archived-child", attachments: [] }] },
    },
    reads: 0, attempts: 0, writes: [], cancelled: false, ignoreWrite: false,
    errorAtRead: 0, updateError: false, updateErrorAfter: false, onRead: null, afterWrite: null,
  };
  const api = {
    getAppState: async () => {
      state.reads++;
      state.onRead?.(state.reads);
      if (state.errorAtRead === state.reads) throw new Error("secret-value: snapshot failed");
      return clone({ tasks: state.tasks, globalConfig: { privateSetting: "secret-value" } });
    },
    updateTask: async (taskId, updates) => {
      state.writes.push({ taskId, updates: clone(updates) });
      assert.deepEqual(Object.keys(updates), ["attachments"]);
      // Actual SP 19.3.1 partialTask assertion accepts these attachment fields;
      // TaskService.update persists this array and only stamps task.modified.
      for (const row of updates.attachments) {
        assert.ok(row.id === null || typeof row.id === "string");
        assert.ok(["FILE", "LINK", "IMG", "COMMAND", "NOTE"].includes(row.type));
        for (const key of ["title", "icon", "path", "originalImgPath"]) assert.ok(row[key] === undefined || typeof row[key] === "string");
      }
      if (state.updateError) throw new Error("secret-value: public update rejected");
      if (!state.ignoreWrite) state.tasks[taskId] = { ...state.tasks[taskId], ...clone(updates), modified: 99999 };
      state.afterWrite?.();
      if (state.updateErrorAfter) throw new Error("secret-value: public update reply lost");
    },
  };
  const run = async (op, args) => {
    let attempted = false;
    try {
      if (state.cancelled) throw Object.assign(new Error("Command cancelled."), { code: "SP_COMMAND_CANCELLED" });
      const data = await executeAttachments(api, op, args, {
        write: async (work) => {
          if (state.cancelled) throw Object.assign(new Error("Command cancelled."), { code: "SP_COMMAND_CANCELLED" });
          attempted = true; state.attempts++; return await work();
        },
        fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
      });
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: { code: error.code || "SP_PLUGIN_ERROR", message: error.code ? error.message : "Public API failed." }, ...(attempted ? { outcomeUnknown: true } : {}) };
    }
  };
  return { state, api, run, list: async () => { const result = await run("attachments.list", listArgs); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; } };
}

async function withCrypto(value, work) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
  try { return await work(); }
  finally { if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor); else delete globalThis.crypto; }
}

test("the closed contract clones input and normalizes only the new URL", () => {
  assert.deepEqual(ATTACHMENT_OPS, ["attachments.list", "attachments.add", "attachments.remove"]);
  const input = Object.freeze({ ...addArgs(), url: "HTTPS://Example.INVALID:443" });
  const output = validateAttachmentCommand("attachments.add", input);
  assert.notEqual(output, input); assert.equal(output.url, "https://example.invalid/");
  assert.equal(input.url, "HTTPS://Example.INVALID:443");
  assert.deepEqual(validateAttachmentCommand("attachments.list", Object.freeze(listArgs)), listArgs);
  assert.deepEqual(validateAttachmentCommand("attachments.remove", removeArgs()), removeArgs());
});

const invalid = [
  ["attachments.list", null], ["attachments.list", []], ["attachments.open", listArgs], ["attachments.list", {}],
  ["attachments.list", { ...listArgs, expectedRevision: zeroRevision }],
  ["attachments.add", { ...addArgs(), path: "https://hidden.invalid/" }],
  ["attachments.add", { ...addArgs(), type: "FILE" }],
  ["attachments.add", { ...addArgs(), attachmentId: "supplied-id" }],
  ["attachments.add", { ...addArgs(), title: null }],
  ["attachments.add", { ...addArgs(), title: "line\nbreak" }],
  ["attachments.add", { ...addArgs(), title: "a".repeat(1001) }],
  ["attachments.remove", { ...removeArgs(), url: "https://extra.invalid/" }],
  ...["", " ", ".", "..", "x/y", "x\\y", " x", "x ", "x\ny", "a".repeat(241), 42].map((taskId) => ["attachments.list", { taskId }]),
  ...[undefined, null, "", "f".repeat(63), "F".repeat(64), "g".repeat(64)].map((expectedRevision) => ["attachments.add", { ...addArgs(), expectedRevision }]),
  ...[undefined, null, "", ".", "..", "x/y", "x\\y"].map((attachmentId) => ["attachments.remove", { ...removeArgs(), attachmentId }]),
  ...[undefined, "example.invalid", "//example.invalid", "ftp://example.invalid", "file:///private/file", "javascript:alert(1)", "https://u:p@example.invalid/", "https://example.invalid/ with-space", "https:\\example.invalid", " https://example.invalid", "https://example.invalid/\n", "https://example.invalid/" + "x".repeat(4096)].map((url) => ["attachments.add", { ...addArgs(), url }]),
];
for (const [index, [op, args]] of invalid.entries()) {
  test(`invalid attachment command ${index + 1} is rejected before accessing SP`, async () => {
    const f = fixture(), result = await f.run(op, args);
    assert.equal(result.error.code, "SP_BAD_INPUT"); assert.equal(f.state.reads + f.state.attempts, 0);
    assert.notEqual(result.outcomeUnknown, true);
  });
}

test("unknown field errors expose only keys and never their values", () => {
  assert.throws(() => validateAttachmentCommand("attachments.list", { ...listArgs, foo: "secret-value", callToken: "secret-token" }), (error) => {
    assert.match(error.message, /foo/); assert.match(error.message, /callToken/);
    assert.doesNotMatch(error.message, /secret-value|secret-token/); return true;
  });
});

test("list exposes only editable links and an opaque full-array revision", async () => {
  const f = fixture(), result = await f.list();
  assert.deepEqual(result.attachments, [{ id: "l1", type: "LINK", url: "https://example.invalid/docs", title: "Docs" }]);
  assert.equal(result.taskId, "a"); assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.totalCount, 6); assert.equal(result.otherCount, 5);
  assert.equal(f.state.reads, 1); assert.equal(f.state.attempts, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret-value|private|image-metadata|retained|custom|inert legacy/);
  result.attachments[0].title = "external mutation";
  assert.equal(f.state.tasks.a.attachments[0].title, "Docs");
});

test("empty attachment array uses real SHA-256 and ignores unrelated task fields", async () => {
  const f = fixture(); f.state.tasks.a.attachments = [];
  const first = await f.list(); assert.equal(first.revision, hash("[]"));
  f.state.tasks.a.title = "User changed title"; f.state.tasks.a.timeSpent = 77;
  assert.equal((await f.list()).revision, first.revision);
});

test("revision includes every hidden non-link field and is independent of object key order", async () => {
  const f = fixture(), first = await f.list();
  f.state.tasks.a.attachments = f.state.tasks.a.attachments.map((row) => Object.fromEntries(Object.entries(row).reverse()));
  assert.equal((await f.list()).revision, first.revision);
  f.state.tasks.a.attachments[1].custom.value = "updated hidden field";
  assert.notEqual((await f.list()).revision, first.revision);
  const result = await f.run("attachments.add", addArgs(first.revision));
  assert.equal(result.error.code, "SP_ATTACHMENT_CONFLICT"); assert.equal(f.state.attempts, 0);
});

test("add stores one LINK via only attachments and preserves all original fields", async () => {
  const f = fixture(), before = clone(f.state.tasks.a), snapshot = await f.list();
  const result = await f.run("attachments.add", addArgs(snapshot.revision));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.state.attempts, 1); assert.equal(f.state.writes.length, 1);
  const added = f.state.tasks.a.attachments.at(-1);
  assert.deepEqual(added, { id: result.data.attachmentId, type: "LINK", path: "https://new.invalid/resource", title: "New link", icon: "bookmark" });
  assert.match(added.id, /^hana-link-[a-f0-9-]+$/);
  assert.deepEqual(f.state.tasks.a.attachments.slice(0, -1), before.attachments);
  assert.equal(JSON.stringify(f.state.tasks.a.attachments.slice(0, -1)), JSON.stringify(before.attachments));
  for (const key of ["id", "title", "isDone", "doneOn", "wontDoOn", "notes", "projectId"]) assert.deepEqual(f.state.tasks.a[key], before[key]);
  assert.notEqual(result.data.revision, snapshot.revision);
  assert.equal(result.data.unchanged, false); assert.equal(result.data.verification, "applied-state");
  assert.equal(result.data.otherCount, 5); assert.equal(result.data.totalCount, 7);
});

test("an omitted title remains omitted and an explicit empty title is retained", async () => {
  for (const title of [undefined, ""]) {
    const f = fixture(), snapshot = await f.list(), args = addArgs(snapshot.revision);
    if (title === undefined) delete args.title; else args.title = title;
    const result = await f.run("attachments.add", args), added = f.state.tasks.a.attachments.at(-1);
    assert.equal(result.ok, true); assert.equal(Object.hasOwn(added, "title"), title !== undefined);
  }
});

test("duplicate canonical URLs are refused even if their existing attachment is not editable", async () => {
  for (const legacy of [false, true]) {
    const f = fixture(); if (legacy) f.state.tasks.a.attachments[0].id = null;
    const snapshot = await f.list();
    const result = await f.run("attachments.add", { ...addArgs(snapshot.revision), url: "HTTPS://EXAMPLE.INVALID:443/docs" });
    assert.equal(result.error.code, "SP_ATTACHMENT_DUPLICATE"); assert.equal(f.state.attempts, 0);
    assert.doesNotMatch(result.error.message, /https:|secret-value/);
  }
});

test("remove deletes exactly one link and preserves other links, file paths and unknown metadata", async () => {
  const f = fixture(), before = clone(f.state.tasks.a.attachments), snapshot = await f.list();
  const result = await f.run("attachments.remove", removeArgs(snapshot.revision));
  assert.equal(result.ok, true); assert.equal(result.data.attachmentId, "l1"); assert.equal(result.data.unchanged, false);
  assert.deepEqual(f.state.tasks.a.attachments, before.slice(1));
  assert.equal(JSON.stringify(f.state.tasks.a.attachments), JSON.stringify(before.slice(1)));
  assert.equal(result.data.attachments.length, 0); assert.equal(result.data.otherCount, 5); assert.equal(f.state.attempts, 1);
  const unchanged = await f.run("attachments.remove", removeArgs(result.data.revision));
  assert.equal(unchanged.ok, true); assert.equal(unchanged.data.unchanged, true); assert.equal(f.state.attempts, 1);
  const stale = await f.run("attachments.remove", removeArgs(snapshot.revision));
  assert.equal(stale.error.code, "SP_ATTACHMENT_CONFLICT"); assert.equal(f.state.attempts, 1);
});

test("non-LINK, unsupported URL and duplicate ID targets are never removed", async () => {
  for (const attachmentId of ["f1", "img1", "mail", "cmd1", "duplicate"]) {
    const f = fixture();
    f.state.tasks.a.attachments.push({ id: "duplicate", type: "LINK", path: "https://duplicate.invalid/1" }, { id: "duplicate", type: "LINK", path: "https://duplicate.invalid/2" });
    const snapshot = await f.list(), before = clone(f.state.tasks.a.attachments);
    assert.ok(!snapshot.attachments.some((row) => row.id === "duplicate"));
    const result = await f.run("attachments.remove", removeArgs(snapshot.revision, attachmentId));
    assert.equal(result.error.code, "SP_ATTACHMENT_UNSUPPORTED"); assert.equal(f.state.attempts, 0);
    assert.deepEqual(f.state.tasks.a.attachments, before);
  }
});

test("missing exact active task never falls back to nested or archived snapshots", async () => {
  for (const taskId of ["missing", "archived-child", "toString"]) {
    const f = fixture(); f.api.getArchivedTasks = async () => { throw new Error("Archive reads are forbidden"); };
    const result = await f.run("attachments.list", { taskId });
    assert.equal(result.error.code, "SP_NO_TASK"); assert.equal(f.state.attempts, 0);
  }
});

test("malformed task identity and missing complete arrays fail closed", async () => {
  for (const mutate of [
    (f) => { f.state.tasks.a.id = "other"; },
    (f) => { delete f.state.tasks.a.attachments; },
    (f) => { f.state.tasks.a.attachments = null; },
    (f) => { f.state.tasks.a.attachments = [{ id: "x", type: "URL", path: "https://example.invalid" }]; },
    (f) => { f.state.tasks.a.attachments = [{ id: "x", type: "LINK", path: 42 }]; },
    (f) => { f.api.getAppState = async () => ({ tasks: [] }); },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal((await f.run("attachments.list", listArgs)).error.code, "SP_ATTACHMENT_BAD_STATE");
    assert.equal(f.state.attempts, 0);
  }
});

test("an edit while hashing or during final validation conflicts before writing", async () => {
  const f = fixture(), snapshot = await f.list();
  f.state.onRead = (n) => { if (n === 3) f.state.tasks.a.attachments[1].custom.value = "user-edit"; };
  const result = await f.run("attachments.add", addArgs(snapshot.revision));
  assert.equal(result.error.code, "SP_ATTACHMENT_CONFLICT"); assert.equal(f.state.attempts, 0);
  assert.equal(f.state.tasks.a.attachments[1].custom.value, "user-edit");
});

test("task disappearing during final validation prevents a write", async () => {
  const f = fixture(), snapshot = await f.list();
  f.state.onRead = (n) => { if (n === 3) delete f.state.tasks.a; };
  const result = await f.run("attachments.remove", removeArgs(snapshot.revision));
  assert.equal(result.error.code, "SP_NO_TASK"); assert.equal(f.state.attempts, 0);
});

test("cancellation after asynchronous preflight does not attempt a mutation", async () => {
  const f = fixture(), snapshot = await f.list();
  f.state.onRead = (n) => { if (n === 3) f.state.cancelled = true; };
  const result = await f.run("attachments.add", addArgs(snapshot.revision));
  assert.equal(result.error.code, "SP_COMMAND_CANCELLED"); assert.notEqual(result.outcomeUnknown, true);
  assert.equal(f.state.attempts, 0); assert.equal(f.state.writes.length, 0);
});

test("ignored write, API failure and failed or incomplete readback stay unknown and are not retried", async () => {
  for (const failure of ["ignored", "throw-before", "throw-after", "read", "missing", "foreign-field", "new-id", "duplicate-new"]) {
    const f = fixture(), snapshot = await f.list();
    if (failure === "ignored") f.state.ignoreWrite = true;
    if (failure === "throw-before") f.state.updateError = true;
    if (failure === "throw-after") f.state.updateErrorAfter = true;
    if (failure === "read") f.state.errorAtRead = 4;
    if (failure === "missing") f.state.afterWrite = () => { delete f.state.tasks.a.attachments; };
    if (failure === "foreign-field") f.state.afterWrite = () => { f.state.tasks.a.attachments[1].custom.value = "lost-original-metadata"; };
    if (failure === "new-id") f.state.afterWrite = () => { f.state.tasks.a.attachments.at(-1).id = "wrong-id"; };
    if (failure === "duplicate-new") f.state.afterWrite = () => { f.state.tasks.a.attachments.push(clone(f.state.tasks.a.attachments.at(-1))); };
    const result = await f.run("attachments.add", addArgs(snapshot.revision));
    assert.equal(result.ok, false, failure); assert.equal(result.outcomeUnknown, true, failure);
    assert.equal(f.state.attempts, 1); assert.equal(f.state.writes.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret-value|private/);
  }
});

test("an applied update with a lost reply is visible through list and is never duplicated", async () => {
  const f = fixture(), snapshot = await f.list(); f.state.updateErrorAfter = true;
  const failed = await f.run("attachments.add", addArgs(snapshot.revision));
  assert.equal(failed.outcomeUnknown, true); f.state.updateErrorAfter = false;
  const after = await f.list(); assert.equal(after.attachments.filter((row) => row.url === addArgs().url).length, 1);
  const again = await f.run("attachments.add", addArgs(after.revision));
  assert.equal(again.error.code, "SP_ATTACHMENT_DUPLICATE"); assert.equal(f.state.writes.length, 1);
});

test("preflight errors are sanitized without write uncertainty", async () => {
  const f = fixture(); f.state.errorAtRead = 1;
  const result = await f.run("attachments.list", listArgs);
  assert.equal(result.error.code, "SP_ATTACHMENT_READ_FAILED"); assert.notEqual(result.outcomeUnknown, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test("missing SHA-256 support refuses both reads and edits without weakening revision checks", async () => {
  for (const crypto of [undefined, {}, { subtle: {} }]) await withCrypto(crypto, async () => {
    const f = fixture();
    for (const op of ["attachments.list", "attachments.add"]) {
      const result = await f.run(op, op.endsWith("list") ? listArgs : addArgs());
      assert.equal(result.error.code, "SP_ATTACHMENT_UNSUPPORTED"); assert.equal(f.state.attempts, 0);
    }
  });
});

test("secure ID generation collisions are detected before updateTask", async () => {
  const suffix = "00000000-0000-4000-8000-000000000000";
  await withCrypto({ subtle: webcrypto.subtle, randomUUID: () => suffix }, async () => {
    const f = fixture(); f.state.tasks.a.attachments.push({ id: `hana-link-${suffix}`, type: "NOTE", path: "old" });
    const snapshot = await f.list(), result = await f.run("attachments.add", addArgs(snapshot.revision));
    assert.equal(result.error.code, "SP_ATTACHMENT_ID_COLLISION"); assert.equal(f.state.attempts, 0);
  });
});

test("getRandomValues fallback creates a secure bounded ID; missing randomness does not write", async () => {
  for (const random of [true, false]) await withCrypto({ subtle: webcrypto.subtle, ...(random ? { getRandomValues: (value) => webcrypto.getRandomValues(value) } : {}) }, async () => {
    const f = fixture(), snapshot = await f.list(), result = await f.run("attachments.add", addArgs(snapshot.revision));
    assert.equal(result.ok, random);
    if (random) assert.match(result.data.attachmentId, /^hana-link-[a-f0-9]{32}$/);
    else { assert.equal(result.error.code, "SP_ATTACHMENT_UNSUPPORTED"); assert.equal(f.state.attempts, 0); }
  });
});

test("bounded full-array snapshots reject huge or non-serializable metadata before any mutation", async () => {
  for (const kind of ["count", "bytes", "cycle"]) {
    const f = fixture();
    if (kind === "count") f.state.tasks.a.attachments = Array.from({ length: 1001 }, (_, i) => ({ id: `l${i}`, type: "LINK", path: "https://example.invalid/" }));
    if (kind === "bytes") f.state.tasks.a.attachments[1].custom.value = "x".repeat(256 * 1024);
    if (kind === "cycle") f.state.tasks.a.attachments[1].custom.self = f.state.tasks.a.attachments[1].custom;
    const result = await f.run("attachments.add", addArgs());
    assert.equal(result.ok, false); assert.match(result.error.code, /^SP_ATTACHMENT_(?:LIMIT|BAD_STATE)$/);
    assert.equal(f.state.attempts, 0);
  }
});

test("missing public APIs reject without invoking an alternative raw dispatch", async () => {
  for (const method of ["getAppState", "updateTask"]) {
    const f = fixture(), snapshot = await f.list(); delete f.api[method];
    f.api.dispatchAction = () => { throw new Error("Raw dispatch is forbidden"); };
    const result = await f.run("attachments.add", addArgs(snapshot.revision));
    assert.equal(result.error.code, "SP_ATTACHMENT_UNSUPPORTED"); assert.equal(f.state.attempts, 0);
  }
});

async function toolFixture() {
  const f = fixture(), tools = new Map();
  Object.assign(f.state, { status: { enabled: true, running: true, connected: true, protocol: 1, pluginVersion: "0.5.0" }, statusReads: 0, bridgeCalls: [], bridgeResult: null, bridgeError: null, statusError: false, noticeReads: 0 });
  const sdk = {
    tools: { register: async (tool) => { tools.set(tool.name, tool); } },
    config: { getAll: async () => ({ baseUrl: "http://sp.invalid", accessToken: "fixture-token" }) },
    network: { fetch: async (url) => { assert.equal(new URL(url).origin, "http://sp.invalid"); f.state.noticeReads++; return new Response(JSON.stringify({ ok: true, data: url.endsWith("/tasks") ? [{ id: "a", title: "Active", isDone: false }] : null })); } },
  };
  const bridge = {
    status: async () => { f.state.statusReads++; if (f.state.statusError) throw new Error("secret-value"); return clone(f.state.status); },
    execute: async (op, args) => {
      f.state.bridgeCalls.push({ op, args: clone(args) });
      if (f.state.bridgeError) throw f.state.bridgeError;
      if (f.state.bridgeResult) return f.state.bridgeResult(op, args);
      const result = await f.run(op, args);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, outcomeUnknown: result.outcomeUnknown });
      return result.data;
    },
  };
  const guard = (work) => async (args) => {
    try { return await work(args); }
    catch (error) { return { ok: false, code: error.code, message: error.message, outcomeUnknown: error.outcomeUnknown === true }; }
  };
  await registerAttachmentTools(sdk, { bridge, guard, ok: (data) => ({ ok: true, ...data }) });
  return { ...f, tools, sdk, call: (args) => tools.get("sp_tasks_attachments").execute(args) };
}

test("registers one closed-schema attachment tool with minimum plugin 0.5.0", async () => {
  const f = await toolFixture(), tool = f.tools.get("sp_tasks_attachments");
  assert.deepEqual([...f.tools.keys()], ["sp_tasks_attachments"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.action.enum, ["list", "add", "remove"]);
  assert.deepEqual(ATTACHMENT_CAPABILITIES[0].tools, ["sp_tasks_attachments"]);
  assert.equal(ATTACHMENT_CAPABILITIES[0].minimumPluginVersion, "0.5.0");
});

test("tool runs list/add/remove and strips host context without mutating caller input", async () => {
  const f = await toolFixture(), snapshot = await f.call({ action: "list", ...listArgs });
  const args = Object.freeze({ action: "add", ...addArgs(snapshot.revision), context: Object.freeze({ callToken: "secret-value" }) });
  const added = await f.call(args); assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(args.context.callToken, "secret-value");
  assert.deepEqual(f.state.bridgeCalls[1], { op: "attachments.add", args: addArgs(snapshot.revision) });
  assert.doesNotMatch(JSON.stringify(added) + JSON.stringify(f.state.bridgeCalls), /secret-value/);
  const removed = await f.call({ action: "remove", ...removeArgs(added.revision, added.attachmentId) });
  assert.equal(removed.ok, true); assert.equal(removed.attachmentId, added.attachmentId); assert.equal(removed.unchanged, false);
});

for (const args of [null, [], {}, { action: "open", ...listArgs }, { action: "list", ...listArgs, foo: "secret-value" }, { action: "list", ...listArgs, callToken: "secret-value" }, { action: "add", ...addArgs(), type: "FILE" }]) {
  test(`tool rejects invalid input ${JSON.stringify(args)} before bridge access`, async () => {
    const f = await toolFixture(), result = await f.call(args);
    assert.equal(result.code, "SP_BAD_INPUT"); assert.equal(f.state.statusReads, 0); assert.equal(f.state.bridgeCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /secret-value/);
    if (args?.foo) assert.match(result.message, /foo/);
    if (args?.callToken) assert.match(result.message, /callToken/);
  });
}

for (const status of [{ enabled: false }, { running: false }, { connected: false }, { available: false }, { accepting: false }, { stopping: true }, { protocol: 2 }, { error: { token: "secret-value" } }, { pluginVersion: "0.1.0" }, { pluginVersion: "0.4.0" }, { pluginVersion: "0.5.0-beta.1" }, { pluginVersion: "unknown" }]) {
  test(`bridge ${JSON.stringify(status)} is gated before any command`, async () => {
    const f = await toolFixture(); Object.assign(f.state.status, status);
    const result = await f.call({ action: "list", ...listArgs });
    assert.match(result.code, /^SP_BRIDGE_(?:NOT_CONNECTED|UPGRADE_REQUIRED)$/);
    assert.equal(f.state.bridgeCalls.length, 0); assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  });
}

test("future stable plugin versions remain compatible", async () => {
  const f = await toolFixture(); f.state.status.pluginVersion = "1.0.0+build.1";
  assert.equal((await f.call({ action: "list", ...listArgs })).ok, true);
});

test("response projection strips unrelated data and verifies identity, counts and revision", async () => {
  const f = await toolFixture(), snapshot = await f.list();
  f.state.bridgeResult = () => ({ ...snapshot, secret: "secret-value", attachments: snapshot.attachments.map((row) => ({ ...row, privateSetting: "secret-value" })) });
  const result = await f.call({ action: "list", ...listArgs });
  assert.equal(result.ok, true); assert.doesNotMatch(JSON.stringify(result), /secret-value|privateSetting/);
  for (const corrupt of [null, {}, { ...snapshot, taskId: "other" }, { ...snapshot, totalCount: 1001 }, { ...snapshot, otherCount: 0 }, { ...snapshot, revision: "bad" }, { ...snapshot, attachments: [{ ...snapshot.attachments[0], url: "javascript:alert(1)" }] }, { ...snapshot, attachments: [snapshot.attachments[0], snapshot.attachments[0]], otherCount: 4 }]) {
    f.state.bridgeResult = () => corrupt;
    const bad = await f.call({ action: "list", ...listArgs });
    assert.equal(bad.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(bad.outcomeUnknown, false);
  }
});

test("write replies must confirm full target fields and correct mutation revision", async () => {
  const f = await toolFixture(), before = await f.list();
  const added = await f.run("attachments.add", addArgs(before.revision)); assert.equal(added.ok, true);
  const good = added.data;
  for (const corrupt of [{ ...good, attachmentId: "wrong-id" }, { ...good, unchanged: true }, { ...good, verification: undefined }, { ...good, revision: before.revision }, { ...good, attachments: good.attachments.map((row) => row.id === good.attachmentId ? { ...row, title: "Wrong title" } : row) }]) {
    f.state.bridgeResult = () => corrupt;
    const result = await f.call({ action: "add", ...addArgs(before.revision) });
    assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(result.outcomeUnknown, true);
  }
  for (const corrupt of [{ ...good, attachmentId: "l1", unchanged: false }, { ...good, attachmentId: "missing", unchanged: true }, { ...good, attachmentId: "wrong-id", unchanged: false }]) {
    f.state.bridgeResult = () => corrupt;
    const result = await f.call({ action: "remove", ...removeArgs(before.revision) });
    assert.equal(result.code, "SP_BRIDGE_BAD_RESPONSE"); assert.equal(result.outcomeUnknown, true);
  }
});

test("status, transport and operation failures never reflect raw errors or credentials", async () => {
  const f = await toolFixture(); f.state.statusError = true;
  const unavailable = await f.call({ action: "list", ...listArgs });
  assert.equal(unavailable.code, "SP_BRIDGE_UNAVAILABLE"); assert.doesNotMatch(JSON.stringify(unavailable), /secret-value/);
  f.state.statusError = false;
  for (const code of ["SP_BRIDGE_TIMEOUT", "SP_ATTACHMENT_CONFLICT", "secret-value"]) {
    f.state.bridgeError = Object.assign(new Error("secret-value"), { code, outcomeUnknown: true });
    const result = await f.call({ action: "add", ...addArgs() });
    assert.equal(result.outcomeUnknown, true); assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  }
  assert.equal(f.state.bridgeCalls.length, 3); assert.equal(f.state.writes.length, 0);
});

test("attempted attachment writes invalidate notice cache even when the reply is lost", async () => {
  resetNoticeCache();
  try {
    const f = await toolFixture(); await readNotice(f.sdk); const reads = f.state.noticeReads;
    await readNotice(f.sdk); assert.equal(f.state.noticeReads, reads);
    f.state.bridgeError = Object.assign(new Error("lost reply"), { code: "SP_BRIDGE_TIMEOUT", outcomeUnknown: true });
    assert.equal((await f.call({ action: "remove", ...removeArgs() })).outcomeUnknown, true);
    await readNotice(f.sdk); assert.ok(f.state.noticeReads > reads);
  } finally { resetNoticeCache(); }
});

test("shared snapshot projection returns fresh whitelisted data only", () => {
  const source = { taskId: "a", revision: zeroRevision, totalCount: 1, otherCount: 0, attachments: [{ id: "l1", type: "LINK", url: normalizeAttachmentUrl("https://EXAMPLE.invalid"), title: "A", extra: "secret-value" }], hidden: "secret-value" };
  const projected = projectAttachmentSnapshot(source);
  assert.notEqual(projected.attachments, source.attachments);
  assert.notEqual(projected.attachments[0], source.attachments[0]);
  assert.doesNotMatch(JSON.stringify(projected), /secret-value/);
});

test("real protocol and serialized companion preserve attachment validation, conflict and cancellation", async () => {
  const { validateCommand } = await import("../../sp-tasks/lib/bridge-protocol.js");
  const { createCommandExecutor } = await import("../../sp-hana-bridge/src/companion.mjs");
  const f = fixture(), execute = createCommandExecutor(f.api);
  assert.equal(validateCommand("attachments.list", listArgs).op, "attachments.list");
  assert.throws(() => validateCommand("attachments.list", { ...listArgs, callToken: "secret-value" }), (error) => error.code === "SP_BRIDGE_BAD_INPUT" && /callToken/.test(error.message) && !/secret-value/.test(error.message));
  const listed = await execute("attachments.list", listArgs);
  assert.equal(listed.ok, true); const args = addArgs(listed.data.revision);
  assert.equal(validateCommand("attachments.add", args).op, "attachments.add");
  // Both callers observed the same revision. The real executor serializes them,
  // so the second command sees the first mutation and cannot add a duplicate.
  const [added, conflict] = await Promise.all([execute("attachments.add", args), execute("attachments.add", args)]);
  assert.equal(added.ok, true); assert.equal(conflict.error.code, "SP_ATTACHMENT_CONFLICT");
  assert.notEqual(conflict.outcomeUnknown, true); assert.equal(f.state.writes.length, 1);
  const removal = removeArgs(added.data.revision, added.data.attachmentId);
  assert.equal(validateCommand("attachments.remove", removal).op, "attachments.remove");
  const cancelled = await execute("attachments.remove", removal, () => true);
  assert.equal(cancelled.error.code, "SP_COMMAND_CANCELLED"); assert.notEqual(cancelled.outcomeUnknown, true);
  assert.equal(f.state.writes.length, 1);
  f.state.ignoreWrite = true;
  const unknown = await execute("attachments.remove", removal);
  assert.equal(unknown.error.code, "SP_VERIFY_FAILED"); assert.equal(unknown.outcomeUnknown, true);
  assert.equal(f.state.writes.length, 2);
});

test("production source loader and bundler execute attachment routing entirely in memory", async () => {
  const { loadPluginSources, createPluginCode } = await import("../../sp-hana-bridge/scripts/build.mjs");
  const sources = await loadPluginSources();
  assert.equal(typeof sources.attachmentsContract, "string"); assert.equal(typeof sources.attachments, "string");
  const code = createPluginCode(sources);
  assert.doesNotMatch(code, /^\s*(?:import|export)\b/m);
  assert.equal(code.split("installCompanion(PluginAPI);").length, 2);
  // Capture the actual bundled executor without starting plugin timers, pairing
  // or HTTP. No source module is stubbed and no generated file is written.
  let execute;
  const f = fixture();
  new Function("PluginAPI", code.replace("installCompanion(PluginAPI);", "PluginAPI.capture(createCommandExecutor(PluginAPI));"))({ ...f.api, capture: (value) => { execute = value; } });
  assert.equal(typeof execute, "function");
  const listed = await execute("attachments.list", listArgs);
  assert.equal(listed.ok, true); assert.equal(listed.data.otherCount, 5);
  const added = await execute("attachments.add", addArgs(listed.data.revision));
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(f.state.writes.length, 1); assert.equal(f.state.writes[0].updates.attachments.at(-1).type, "LINK");
  const removed = await execute("attachments.remove", removeArgs(added.data.revision, added.data.attachmentId));
  assert.equal(removed.ok, true); assert.equal(removed.data.revision, listed.data.revision);
  assert.equal(f.state.writes.length, 2);
});
