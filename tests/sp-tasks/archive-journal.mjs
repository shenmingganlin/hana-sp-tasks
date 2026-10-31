// This suite uses only synthetic records in a Map; it never opens SP or user storage.
import assert from "node:assert/strict";
import test from "node:test";
import { archiveScope, completionOf, createArchiveJournal, sameCompletion, scheduleOf, sameSchedule } from "../../sp-tasks/lib/archive-snapshot.js";

const cfg = { baseUrl: "http://sp.invalid:3876", accessToken: "synthetic-token" };
const completion = (extra = {}) => ({ isDone: false, doneOn: null, wontDoOn: null, ...extra });
const item = (taskId, parentId = null, original = completion()) => ({ taskId, parentId, original });
function fixture() {
  const entries = new Map(), failures = { get: false, set: false, keys: false };
  const storage = {
    get: async (key) => { await new Promise(setImmediate); if (failures.get) throw new Error("Synthetic read failure"); return structuredClone(entries.get(key)); },
    set: async (key, value) => { await new Promise(setImmediate); if (failures.set) throw new Error("Synthetic write failure"); entries.set(key, structuredClone(value)); },
    keys: async () => { if (failures.keys) throw new Error("Synthetic enumeration failure"); return [...entries.keys()]; },
  };
  const sdk = { storage: { global: storage } };
  return { entries, failures, sdk, journal: createArchiveJournal(sdk, cfg) };
}
const hasCode = (code) => (error) => error?.code === code;

test("completion capture preserves all three states and normalizes only absent metadata", () => {
  assert.deepEqual(completionOf({ isDone: true }), completion({ isDone: true }));
  const skipped = completion({ isDone: true, doneOn: 10, wontDoOn: 20 });
  assert.deepEqual(completionOf(skipped), skipped);
  assert.equal(sameCompletion(skipped, { ...skipped }), true);
  assert.equal(sameCompletion(skipped, { ...skipped, wontDoOn: null }), false);
  for (const value of [undefined, null, {}, { isDone: 1 }, { isDone: false, doneOn: "10" }, { isDone: false, doneOn: -1 }, { isDone: false, doneOn: 1.5 }, { isDone: false, wontDoOn: Infinity }, { isDone: false, doneOn: 8640000000000001 }]) assert.throws(() => completionOf(value), hasCode("SP_ARCHIVE_BAD_INPUT"));
  assert.deepEqual(completionOf(completion({ doneOn: 0, wontDoOn: 8640000000000000 })), completion({ doneOn: 0, wontDoOn: 8640000000000000 }));
});

test("connection scopes are canonical, separate tokens and servers, and never store credentials", async () => {
  const f = fixture();
  assert.equal(archiveScope(cfg), archiveScope({ ...cfg, baseUrl: "HTTP://SP.INVALID:3876/" }));
  assert.notEqual(archiveScope(cfg), archiveScope({ ...cfg, baseUrl: "http://other.invalid:3876" }));
  assert.notEqual(archiveScope(cfg), archiveScope({ ...cfg, accessToken: "other-synthetic-token" }));
  await f.journal.prepare("same-id", [item("same-id")]);
  const other = createArchiveJournal(f.sdk, { ...cfg, accessToken: "other-synthetic-token" });
  assert.equal(await other.find("same-id"), null);
  await other.prepare("same-id", [item("same-id", null, completion({ isDone: true, doneOn: 15 }))]);
  assert.equal((await f.journal.find("same-id")).items[0].original.isDone, false);
  const stored = JSON.stringify([...f.entries]);
  assert.equal(stored.includes(cfg.accessToken), false);
  assert.equal(stored.includes(cfg.baseUrl), false);
  for (const invalid of [{}, { ...cfg, accessToken: "" }, { ...cfg, baseUrl: "file:///tmp/sp" }, { ...cfg, baseUrl: "http://user:pass@sp.invalid" }, { ...cfg, baseUrl: "http://sp.invalid?profile=2" }]) assert.throws(() => archiveScope(invalid), hasCode("SP_ARCHIVE_SCOPE"));
});

test("a child locates its whole durable root and returned records cannot mutate storage", async () => {
  const f = fixture();
  const root = await f.journal.prepare("parent", [item("parent"), item("child", "parent", completion({ isDone: true, doneOn: 10, wontDoOn: 11 }))]);
  assert.equal(root.phase, "prepared");
  const found = await createArchiveJournal(f.sdk, cfg).find("child");
  assert.equal(found.rootId, "parent");
  assert.deepEqual(found.items[1].original, completion({ isDone: true, doneOn: 10, wontDoOn: 11 }));
  found.items[1].original.doneOn = 99;
  assert.equal((await f.journal.find("child")).items[1].original.doneOn, 10);
  assert.equal(await f.journal.find("missing"), null);
});

test("pending recovery retains expected metadata across reload and per-item consumption", async () => {
  const f = fixture(), tasks = [item("parent"), item("child", "parent")];
  const root = await f.journal.prepare("parent", tasks);
  await f.journal.mark(root, ["parent", "child"], "archived");
  const expected = completion({ isDone: true, doneOn: 50 });
  await f.journal.mark(root, ["child"], "restoring", { expected, restoredParentId: "parent", stage: "restore" });
  const error = { code: "SP_NETWORK_ERROR", message: "Synthetic response loss", outcomeUnknown: true };
  await f.journal.mark(root, ["child"], "pending", { error, stage: "completion" });
  const reloaded = createArchiveJournal(f.sdk, cfg), pending = await reloaded.find("child");
  assert.equal(pending.phase, "pending");
  assert.deepEqual(pending.items[1], { ...tasks[1], phase: "pending", expected, restoredParentId: "parent", stage: "completion", error });
  const completed = await reloaded.mark(root, ["child"], "complete");
  assert.equal(completed.items[0].phase, "archived");
  assert.equal(completed.items[1].phase, "complete");
  assert.deepEqual(completed.items[1].expected, expected);
  assert.equal(Object.hasOwn(completed.items[1], "error"), false);
  await assert.rejects(reloaded.mark(root, ["child"], "pending"), hasCode("SP_ARCHIVE_CONSUMED"));
});

test("unfinished snapshots never expire when old or when unrelated archives are prepared", async () => {
  const f = fixture(), root = await f.journal.prepare("old", [item("old")]);
  await f.journal.mark(root, ["old"], "archived");
  const [key, value] = [...f.entries][0];
  value.roots[0].createdAt = 1;
  value.roots[0].updatedAt = 1;
  f.entries.set(key, value);
  await f.journal.prepare("new", [item("new")]);
  const old = await f.journal.find("old");
  assert.equal(old.createdAt, 1);
  assert.equal(old.phase, "archived");
  assert.equal((await f.journal.list()).length, 2);
});

test("duplicate or overlapping archives cannot replace unfinished original metadata", async () => {
  const f = fixture(), root = await f.journal.prepare("parent", [item("parent"), item("child", "parent")]);
  for (const phase of ["prepared", "archived", "restoring", "pending"]) {
    await f.journal.mark(root, ["parent", "child"], phase);
    await assert.rejects(f.journal.prepare("child", [item("child", null, completion({ isDone: true }))]), hasCode("SP_ARCHIVE_PENDING"));
    assert.equal((await f.journal.find("child")).items[1].original.isDone, false);
  }
});

test("known failed archives can discard only pre-archive records", async () => {
  const f = fixture(), root = await f.journal.prepare("failed", [item("failed")]);
  await f.journal.discard(root);
  assert.equal(await f.journal.find("failed"), null);
  const uncertain = await f.journal.prepare("uncertain", [item("uncertain")]);
  await f.journal.mark(uncertain, ["uncertain"], "pending", { stage: "archive", error: { code: "SP_TIMEOUT", message: "Unknown archive result", outcomeUnknown: true } });
  await assert.rejects(f.journal.discard(uncertain), hasCode("SP_ARCHIVE_PENDING"));
  await assert.rejects(f.journal.mark(uncertain, ["uncertain"], "prepared"), hasCode("SP_ARCHIVE_STATE"));
  assert.equal((await f.journal.find("uncertain")).phase, "pending");
});

test("a new generation replaces only consumed records and stale callbacks cannot alter it", async () => {
  const f = fixture(), old = await f.journal.prepare("root", [item("root")]);
  await f.journal.mark(old, ["root"], "complete");
  const newer = await f.journal.prepare("root", [item("root", null, completion({ isDone: true, doneOn: 8 }))]);
  assert.notEqual(newer.generation, old.generation);
  await assert.rejects(f.journal.mark(old, ["root"], "complete"), hasCode("SP_ARCHIVE_STALE"));
  await assert.rejects(f.journal.discard(old), hasCode("SP_ARCHIVE_STALE"));
  assert.equal((await f.journal.find("root")).generation, newer.generation);
  assert.equal((await f.journal.list()).length, 1);
});

test("an individually consumed child can be rearchived while its old parent remains pending", async () => {
  const f = fixture(), old = await f.journal.prepare("parent", [item("parent"), item("child", "parent")]);
  await f.journal.mark(old, ["parent"], "pending");
  await f.journal.mark(old, ["child"], "complete");
  const newer = await f.journal.prepare("child", [item("child")]);
  assert.equal((await f.journal.find("child")).generation, newer.generation);
  assert.equal((await f.journal.find("parent")).items[1].phase, "complete");
});

test("concurrent journals serialize storage changes without losing roots or item progress", async () => {
  const f = fixture(), other = createArchiveJournal(f.sdk, cfg);
  const [a, b] = await Promise.all([f.journal.prepare("a", [item("a"), item("child-a", "a")]), other.prepare("b", [item("b")])]);
  assert.deepEqual((await f.journal.list()).map((root) => root.rootId).sort(), ["a", "b"]);
  await Promise.all([f.journal.mark(a, ["a"], "complete"), other.mark(a, ["child-a"], "pending", { error: { code: "SP_TIMEOUT", message: "Synthetic timeout", outcomeUnknown: true } }), other.mark(b, ["b"], "archived")]);
  const found = await f.journal.find("a");
  assert.deepEqual(found.items.map((task) => task.phase), ["complete", "pending"]);
  assert.equal((await f.journal.find("b")).phase, "archived");
});

test("storage failures stop preparation and failed progress writes preserve retry data", async () => {
  const f = fixture();
  f.failures.set = true;
  await assert.rejects(f.journal.prepare("root", [item("root")]), hasCode("SP_ARCHIVE_STORAGE"));
  assert.equal(f.entries.size, 0);
  f.failures.set = false;
  const root = await f.journal.prepare("root", [item("root")]);
  await f.journal.mark(root, ["root"], "pending");
  f.failures.set = true;
  await assert.rejects(f.journal.mark(root, ["root"], "complete"), hasCode("SP_ARCHIVE_STORAGE"));
  assert.equal((await f.journal.find("root")).phase, "pending");
  f.failures.set = false;
  await f.journal.mark(root, ["root"], "complete");
  assert.equal((await f.journal.find("root")).phase, "complete");
  f.failures.get = true;
  await assert.rejects(f.journal.list(), hasCode("SP_ARCHIVE_STORAGE"));
});

test("corrupt persisted metadata is reported instead of being overwritten or guessed", async () => {
  const f = fixture();
  await f.journal.prepare("root", [item("root")]);
  const [key, document] = [...f.entries][0];
  document.roots[0].items[0].original.doneOn = "not-a-timestamp";
  f.entries.set(key, document);
  await assert.rejects(f.journal.find("root"), hasCode("SP_ARCHIVE_JOURNAL_CORRUPT"));
  await assert.rejects(f.journal.prepare("other", [item("other")]), hasCode("SP_ARCHIVE_JOURNAL_CORRUPT"));
  assert.deepEqual(f.entries.get(key), document);
});

test("legacy snapshots are discovered through child IDs but remain unscoped and incomplete", async () => {
  const f = fixture();
  const legacyKey = "sp-tasks:archive-snapshot:parent";
  const original = { at: 1, isDoneById: { parent: true, child: false } };
  f.entries.set(legacyKey, original);
  const legacy = await f.journal.legacy("child");
  assert.deepEqual(legacy, { kind: "legacy", unscoped: true, incompleteMetadata: true, matches: [{ sourceRootId: "parent", originalIsDone: false }] });
  assert.equal(await f.journal.find("child"), null);
  assert.deepEqual(await createArchiveJournal(f.sdk, { ...cfg, accessToken: "different" }).legacy("child"), legacy);
  assert.deepEqual(f.entries.get(legacyKey), original);
  assert.equal(await f.journal.legacy("missing"), null);
  f.entries.set("sp-tasks:archive-snapshot:broken", { isDoneById: null });
  assert.equal((await f.journal.legacy("broken")).matches[0].originalIsDone, null);
  f.failures.keys = true;
  await assert.rejects(f.journal.legacy("child"), hasCode("SP_ARCHIVE_STORAGE"));
});

test("invalid item updates fail atomically, and missing persistence fails explicitly", async () => {
  const f = fixture(), root = await f.journal.prepare("root", [item("root")]);
  await assert.rejects(f.journal.mark(root, ["root", "missing"], "complete"), hasCode("SP_ARCHIVE_BAD_INPUT"));
  assert.equal((await f.journal.find("root")).phase, "prepared");
  for (const tasks of [[item("root"), item("root")], [item("other")], [{ taskId: "root", original: completion() }], [item("root", null, { isDone: false })]]) await assert.rejects(f.journal.prepare("root", tasks), hasCode("SP_ARCHIVE_BAD_INPUT"));
  await assert.rejects(createArchiveJournal({}, cfg).list(), hasCode("SP_ARCHIVE_STORAGE"));
});

test("schedules are optional, validated on prepare and on load", async () => {
  assert.equal(scheduleOf({ dueDay: null, dueWithTime: 0 }), null);
  assert.equal(scheduleOf({ dueDay: "" }), null);
  assert.deepEqual(scheduleOf({ dueDay: "2026-11-02", dueWithTime: undefined }), { dueDay: "2026-11-02", dueWithTime: null });
  assert.equal(sameSchedule(undefined, null), true);
  assert.equal(sameSchedule({ dueDay: "2026-11-02", dueWithTime: null }, null), false);
  const f = fixture(), schedule = { dueDay: "2026-11-02", dueWithTime: null };
  const root = await f.journal.prepare("root", [{ ...item("root"), schedule }, { ...item("child", "root"), schedule: null }]);
  assert.deepEqual(root.items[0].schedule, schedule);
  assert.equal(Object.hasOwn(root.items[1], "schedule"), false);
  for (const bad of [{ dueDay: "11/02" , dueWithTime: null }, { dueDay: null, dueWithTime: null }, { dueDay: "2026-11-02" }, { dueDay: "2026-11-02", dueWithTime: null, extra: 1 }]) {
    await assert.rejects(f.journal.prepare("other", [{ ...item("other"), schedule: bad }]), hasCode("SP_ARCHIVE_BAD_INPUT"));
  }
  const [key, document] = [...f.entries][0];
  document.roots[0].items[0].schedule = { dueDay: 5, dueWithTime: null };
  f.entries.set(key, document);
  await assert.rejects(f.journal.find("root"), hasCode("SP_ARCHIVE_JOURNAL_CORRUPT"));
});

test("parent estimates are optional non-negative integers", async () => {
  const f = fixture();
  const root = await f.journal.prepare("root", [{ ...item("root"), estimate: 0 }, item("child", "root")]);
  assert.equal(root.items[0].estimate, 0);
  assert.equal(Object.hasOwn(root.items[1], "estimate"), false);
  for (const bad of [-1, 1.5, "60", null]) await assert.rejects(f.journal.prepare("other", [{ ...item("other"), estimate: bad }]), hasCode("SP_ARCHIVE_BAD_INPUT"));
  const [key, document] = [...f.entries][0];
  document.roots[0].items[0].estimate = -5;
  f.entries.set(key, document);
  await assert.rejects(f.journal.find("root"), hasCode("SP_ARCHIVE_JOURNAL_CORRUPT"));
});
