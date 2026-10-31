// Only temporary loopback servers and temporary App data are used here.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../../sp-tasks/runtime/bridge.mjs";
import { createBridgeClient, BridgeError } from "../../sp-tasks/lib/bridge-client.js";
import { BRIDGE_AUTH_FILE, validateCommand } from "../../sp-tasks/lib/bridge-protocol.js";

const controlToken = "c".repeat(43), pluginToken = "p".repeat(43);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t, options = {}) {
  const service = await createBridgeServer({ controlToken, pluginToken, port: 0, executeTimeoutMs: 700, ...options });
  t.after(() => service.close());
  return { service, base: `http://127.0.0.1:${service.port}`, controlToken, pluginToken };
}
async function call(f, route, body, { token = f.controlToken, method = body === undefined ? "GET" : "POST", headers = {}, signal } = {}) {
  const response = await fetch(f.base + route, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal || AbortSignal.timeout(5000) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
function poll(f, clientId = "test-client") { return call(f, "/plugin/poll", { clientId, protocol: 1, version: "test-1.0" }, { token: f.pluginToken }); }
async function next(f, clientId = "test-client") {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await poll(f, clientId);
    assert.equal(response.status, 200);
    if (response.body.data.command) return response.body.data.command;
    await sleep(2);
  }
  assert.fail("Fake plugin did not receive a command.");
}
function execute(f, op = "projects.create", args = { title: "Synthetic project" }, extra = {}) { return call(f, "/internal/execute", { op, args }, extra); }
function report(f, command, result, clientId = "test-client") { return call(f, "/plugin/result", { clientId, id: command.id, result }, { token: f.pluginToken }); }

test("HTTP transport enforces loopback Host, role-specific credentials, methods, paths and preflight", async (t) => {
  const f = await fixture(t);
  assert.equal(f.service.server.address().address, "127.0.0.1");
  for (const [route, options, expected] of [
    ["/internal/status", { token: pluginToken }, 401],
    ["/plugin/poll", { token: controlToken }, 401],
    ["/internal/status", { token: "wrong" }, 401],
    ["/internal/status", { method: "DELETE" }, 405],
    ["/unknown", {}, 404],
    ["/internal/status?secret=bad", {}, 400],
  ]) assert.equal((await call(f, route, undefined, options)).status, expected);
  const hostRejected = await new Promise((resolve, reject) => {
    const request = http.get(f.base + "/internal/status", { headers: { Host: "rebind.invalid", Authorization: `Bearer ${controlToken}` } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
  });
  assert.equal(hostRejected, 403);
  assert.equal((await call(f, "/plugin/poll", undefined, { method: "OPTIONS", token: "none" })).status, 204);
  const status = await call(f, "/internal/status");
  assert.deepEqual(status.body, { ok: true, data: { connected: false, accepting: true, pluginVersion: null, lastSeen: null, protocol: 1 } });
  assert.equal(JSON.stringify(status).includes(controlToken), false);
  assert.equal(JSON.stringify(status).includes(pluginToken), false);
});

test("unsupported operations, fields, identifiers and unconfirmed cascade deletes never enter the queue", async (t) => {
  const f = await fixture(t);
  const invalid = [
    ["tasks.delete", {}], ["tags.delete", { tagId: "x" }],
    ["projects.list", { includeArchived: true }],
    ["projects.create", { title: "x", isArchived: true }],
    ["projects.create", { title: " " }], ["tags.create", { title: "x", icon: "../bad" }],
    ["tags.update", { tagId: "../x", title: "x" }], ["tags.update", { tagId: "TODAY", title: "x" }],
    ["projects.update", { projectId: "x" }], ["projects.update", { projectId: "x", isEnableBacklog: "yes" }],
    ["projects.delete", { projectId: "x", confirmTitle: "x", allowCascade: false }],
  ];
  for (const [op, args] of invalid) assert.equal((await execute(f, op, args)).status, 400, op);
  assert.equal((await poll(f)).body.data.command, null);
  assert.doesNotThrow(() => validateCommand("projects.update", { projectId: "legacy.id", isHiddenFromMenu: false, title: "Valid", color: "", icon: "Folder" }));
});

test("result acknowledgements are idempotent and delivered writes are never reissued", async (t) => {
  const f = await fixture(t);
  const pending = execute(f);
  const command = await next(f);
  assert.equal(command.op, "projects.create");
  assert.ok(Number.isSafeInteger(command.expiresAt) && command.expiresAt > Date.now());
  assert.equal((await poll(f)).body.data.command, null);
  const result = { ok: true, data: { project: { id: "synthetic", title: "Synthetic project" }, created: true } };
  assert.deepEqual((await report(f, command, result)).body.data, { accepted: true, id: command.id });
  assert.deepEqual((await pending).body, result);
  assert.equal((await report(f, command, result)).body.data.duplicate, true);
  assert.equal((await report(f, command, { ok: true, data: null })).body.error.code, "SP_BRIDGE_RESULT_CONFLICT");
  assert.equal((await poll(f)).body.data.command, null);
});

test("lease and command ownership prevent two SP instances from consuming each other's work", async (t) => {
  const f = await fixture(t);
  await poll(f, "first");
  assert.equal((await poll(f, "second")).body.error.code, "SP_BRIDGE_CLIENT_BUSY");
  const pending = execute(f, "tags.list", {});
  const command = await next(f, "first");
  assert.equal((await report(f, command, { ok: true, data: { tags: [] } }, "second")).body.error.code, "SP_BRIDGE_RESULT_MISMATCH");
  await report(f, command, { ok: true, data: { tags: [] } }, "first");
  assert.equal((await pending).body.ok, true);
  const status = (await call(f, "/internal/status")).body.data;
  assert.equal(status.connected, true);
  assert.equal(status.pluginVersion, "test-1.0");
});

test("uncollected expired commands cannot run, while collected write timeouts are explicitly unknown", async (t) => {
  const f = await fixture(t, { executeTimeoutMs: 180 });
  const notCollected = await execute(f);
  assert.equal(notCollected.body.error.code, "SP_BRIDGE_NOT_CONNECTED");
  assert.notEqual(notCollected.body.outcomeUnknown, true);
  assert.equal((await poll(f)).body.data.command, null);
  const pending = execute(f);
  const command = await next(f);
  const expired = await pending;
  assert.equal(expired.body.outcomeUnknown, true);
  assert.equal((await poll(f)).body.data.command, null);
  const late = await report(f, command, { ok: true, data: { project: { id: "late", title: "Synthetic project" } } });
  assert.equal(late.body.data.late, true);
  assert.equal(late.body.data.accepted, true);
});

test("lost read replies are timeouts without asserting a possibly-applied write", async (t) => {
  const f = await fixture(t, { executeTimeoutMs: 180 });
  const pending = execute(f, "projects.list", {});
  await next(f);
  assert.notEqual((await pending).body.outcomeUnknown, true);
});

test("partial creation errors preserve createdId, and invalid results may be replaced by an explicit failure", async (t) => {
  const f = await fixture(t);
  const pending = execute(f);
  const command = await next(f);
  assert.equal((await report(f, command, { ok: false, error: { code: "PARTIAL", message: "Partial creation" }, createdId: "../bad" })).status, 400);
  const result = { ok: false, error: { code: "SP_VERIFY_FAILED", message: "A created object could not be confirmed." }, outcomeUnknown: true, createdId: "new-id" };
  assert.equal((await report(f, command, result)).body.ok, true);
  assert.deepEqual((await pending).body, result);
});

test("queue pressure and body/result caps fail explicitly without extra deliveries", async (t) => {
  const f = await fixture(t, { maxPending: 1, responseMaxBytes: 512, requestMaxBytes: 256 });
  const pending = execute(f);
  const command = await next(f);
  assert.equal((await execute(f)).status, 429);
  assert.equal((await report(f, command, { ok: true, data: "x".repeat(600) })).status, 413);
  const result = { ok: false, error: { code: "SP_BRIDGE_RESULT_TOO_LARGE", message: "Result too large." }, outcomeUnknown: true };
  await report(f, command, result);
  assert.deepEqual((await pending).body, result);
  assert.equal((await execute(f, "projects.create", { title: "x".repeat(300) })).status, 413);
});

test("disable cancels the queue before process stop and rejects further plugin work", async (t) => {
  const f = await fixture(t);
  const pending = execute(f);
  await next(f);
  assert.equal((await call(f, "/internal/disable", {})).body.data.disabled, true);
  assert.equal((await pending).body.outcomeUnknown, true);
  assert.equal((await poll(f)).body.error.code, "SP_BRIDGE_STOPPING");
  assert.equal((await call(f, "/internal/status")).body.data.connected, false);
});

function waitPoll(f, clientId = "test-client", extra = {}) { return call(f, "/plugin/poll", { clientId, protocol: 1, version: "test-1.0", wait: true }, { token: f.pluginToken, ...extra }); }

test("a held poll is answered as soon as a command is queued, without a second poll", async (t) => {
  const f = await fixture(t, { holdMs: 2000 });
  const started = Date.now(), held = waitPoll(f);
  await sleep(40);
  const pending = execute(f, "tags.list", {});
  const reply = await held;
  assert.ok(Date.now() - started < 1000, "The command must not wait for the hold to expire");
  assert.equal(reply.body.data.longPoll, true);
  assert.equal(reply.body.data.command.op, "tags.list");
  await report(f, reply.body.data.command, { ok: true, data: { tags: [] } });
  assert.equal((await pending).body.ok, true);
});

test("an empty hold ends with no command, keeps the plugin connected, and plain polls stay immediate", async (t) => {
  const f = await fixture(t, { holdMs: 120 });
  const started = Date.now(), reply = await waitPoll(f);
  assert.ok(Date.now() - started >= 100);
  assert.deepEqual(reply.body.data, { command: null, longPoll: true });
  assert.equal((await call(f, "/internal/status")).body.data.connected, true);
  const plain = Date.now(); await poll(f);
  assert.ok(Date.now() - plain < 100, "A poll without wait is never held");
  assert.equal((await call(f, "/plugin/poll", { clientId: "test-client", protocol: 1, version: "x", wait: "yes" }, { token: f.pluginToken })).status, 400);
});

test("a held poll waits out a delivered command and disable releases it", async (t) => {
  const f = await fixture(t, { holdMs: 2000 });
  const first = execute(f, "tags.list", {}), command = await next(f);
  const second = execute(f, "projects.list", {});
  const held = waitPoll(f);
  await sleep(40);
  await report(f, command, { ok: true, data: { tags: [] } });
  assert.equal((await held).body.data.command.op, "projects.list", "Settling the first command frees the second one");
  await first;
  const parked = waitPoll(f);
  await sleep(40);
  assert.equal((await call(f, "/internal/disable", {})).body.data.disabled, true);
  assert.equal((await parked).body.error.code, "SP_BRIDGE_STOPPING");
  await second;
});

test("a port collision fails without adopting or stopping the existing service", async (t) => {
  const f = await fixture(t);
  await assert.rejects(createBridgeServer({ controlToken, pluginToken, port: f.service.port }), { code: "EADDRINUSE" });
  assert.equal((await call(f, "/internal/status")).status, 200);
});

async function sdkFixture(t, options = {}) {
  const reserved = await createBridgeServer({ controlToken, pluginToken, port: 0 });
  const port = reserved.port; await reserved.close();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hana-sp-bridge-test-"));
  const data = new Map(), calls = [];
  let current = null, service = null, count = 0;
  const sdk = {
    dataDir,
    storage: { global: { get: async (key, fallback) => structuredClone(data.get(key) ?? fallback), set: async (key, value) => { data.set(key, structuredClone(value)); } } },
    runtime: {
      list: async () => current ? [structuredClone(current)] : [],
      get: async () => current && structuredClone(current),
      start: async (input) => {
        calls.push({ type: "start", input });
        const auth = JSON.parse(await readFile(path.join(dataDir, BRIDGE_AUTH_FILE), "utf8"));
        assert.equal(JSON.stringify(input).includes(auth.controlToken), false);
        assert.equal(JSON.stringify(input).includes(auth.pluginToken), false);
        service = await createBridgeServer({ ...auth, port, executeTimeoutMs: 500 });
        current = { runtimeId: `fake-${++count}`, state: "ready", service: { ...input.service, state: "ready" } };
        return structuredClone(current);
      },
      fetch: async (id, route, init) => {
        calls.push({ type: "fetch", route });
        assert.equal(id, current.runtimeId);
        if (options.reply && route === "/internal/execute") return options.reply();
        if (options.badDisable && route === "/internal/disable") return new Response(JSON.stringify({ ok: true, data: {} }));
        return fetch(`http://127.0.0.1:${port}${route}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs) });
      },
      stop: async () => {
        calls.push({ type: "stop" });
        if (options.stopError) throw new Error("synthetic stop failure");
        if (options.keepStopping) { current.state = "stopping"; return structuredClone(current); }
        await service?.close(); if (current) current.state = "stopped"; return structuredClone(current);
      },
    },
  };
  t.after(async () => {
    await service?.close();
    const absolute = path.resolve(dataDir), allowed = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(absolute.startsWith(allowed) && path.basename(absolute).startsWith("hana-sp-bridge-test-"));
    await rm(absolute, { recursive: true, force: true });
  });
  return { sdk, data, calls, port, dataDir, client: createBridgeClient(sdk, { port }), async plugin() {
    const auth = JSON.parse(await readFile(path.join(dataDir, BRIDGE_AUTH_FILE), "utf8"));
    return { ...auth, base: `http://127.0.0.1:${port}` };
  } };
}

test("REST-only SDK construction and restore have no bridge side effects", async () => {
  const bridge = createBridgeClient({});
  assert.equal((await bridge.status()).enabled, false);
  assert.equal((await bridge.restore()).running, false);
  await assert.rejects(bridge.pair(), { code: "SP_BRIDGE_UNSUPPORTED" });
});

test("native identity startup failures remain visible without credentials and clear after a successful retry", async (t) => {
  const f = await sdkFixture(t);
  const start = f.sdk.runtime.start;
  let starts = 0;
  f.sdk.runtime.start = async () => {
    starts++;
    throw Object.assign(new Error("private-native-error-sentinel"), { code: "APP_RUNTIME_NATIVE_IDENTITY_NOT_READY" });
  };
  await assert.rejects(f.client.pair(), { code: "APP_RUNTIME_NATIVE_IDENTITY_NOT_READY" });
  const status = await f.client.status();
  assert.equal(status.enabled, true);
  assert.equal(status.running, false);
  assert.equal(status.error.code, "APP_RUNTIME_NATIVE_IDENTITY_NOT_READY");
  assert.match(status.error.message, /native sandbox/);
  assert.equal(JSON.stringify(status).includes("private-native-error-sentinel"), false);
  assert.equal(starts, 1, "Reading status never retries startup");
  f.sdk.runtime.start = start;
  await f.client.pair();
  assert.equal((await f.client.status()).error, undefined);
});

// Holds a started runtime in "starting" until ready() is called, like a slow native cold start.
function delayedReady(f) {
  const { start, list, get, stop } = f.sdk.runtime;
  const control = { pending: null, age: 0, stops: 0, ready() { this.pending = null; } };
  f.sdk.runtime.start = async (input) => {
    const runtime = await start(input);
    control.pending = { ...runtime, state: "starting", startedAt: new Date(Date.now() - control.age).toISOString(), service: { ...runtime.service, state: "pending" } };
    return structuredClone(control.pending);
  };
  f.sdk.runtime.list = async () => control.pending ? [structuredClone(control.pending)] : list();
  f.sdk.runtime.get = async (id) => control.pending ? structuredClone(control.pending) : get(id);
  f.sdk.runtime.stop = async (id) => { control.stops++; control.pending = null; return stop(id); };
  return control;
}

test("a cold start slower than one wait window keeps running and the next call adopts it", async (t) => {
  const f = await sdkFixture(t);
  const slow = delayedReady(f);
  const client = createBridgeClient(f.sdk, { port: f.port, readyTimeoutMs: 50, startLimitMs: 5000 });
  await assert.rejects(client.pair(), { code: "SP_BRIDGE_STARTING" });
  assert.equal(slow.stops, 0, "A still-starting runtime is not stopped");
  const status = await client.status();
  assert.equal(status.runtimeState, "starting");
  assert.equal(status.error.code, "SP_BRIDGE_STARTING");
  slow.ready();
  assert.equal((await client.restore()).running, true);
  assert.equal(f.calls.filter((entry) => entry.type === "start").length, 1, "The pending runtime is reused, not respawned");
  assert.equal((await client.status()).error, undefined);
});

test("a start still pending past the hard limit is stopped and reported as failed", async (t) => {
  const f = await sdkFixture(t);
  await assert.rejects(createBridgeClient(f.sdk, { port: f.port, readyTimeoutMs: 15000, startLimitMs: 1000 }).pair(), { code: "SP_BRIDGE_BAD_CONFIG" });
  const slow = delayedReady(f); slow.age = 60000;
  const client = createBridgeClient(f.sdk, { port: f.port, readyTimeoutMs: 50, startLimitMs: 1000 });
  await assert.rejects(client.pair(), { code: "SP_BRIDGE_START_FAILED" });
  assert.equal(slow.stops, 1);
});

test("a bridge process that exits before ready reports its exit code", async (t) => {
  const f = await sdkFixture(t);
  f.sdk.runtime.start = async () => ({ runtimeId: "fake-exit", state: "failed", exitCode: 1, service: { state: "pending" } });
  await assert.rejects(f.client.pair(), (error) => error.code === "SP_BRIDGE_START_FAILED" && /退出码 1/.test(error.message));
});

test("disabling a failed startup clears its transient diagnosis and does not start a runtime", async (t) => {
  const f = await sdkFixture(t);
  f.sdk.runtime.start = async () => { throw Object.assign(new Error("private-error"), { code: "APP_CAPABILITY_DENIED" }); };
  await assert.rejects(f.client.pair());
  assert.ok((await f.client.status()).error);
  const disabled = await f.client.disable();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.error, undefined);
  assert.equal(f.calls.length, 0);
});

test("pairing exposes only plugin credentials and explicitly starts one managed service", async (t) => {
  const f = await sdkFixture(t);
  assert.equal((await f.client.status()).configured, false);
  await f.client.restore();
  assert.equal(f.calls.length, 0);
  const paired = await f.client.pair();
  const code = JSON.parse(Buffer.from(paired.pairingCode.slice("HANA-SP1.".length), "base64url"));
  assert.equal(code.protocol, 1); assert.equal(code.url, `http://127.0.0.1:${f.port}`);
  const auth = await f.plugin();
  assert.equal(code.token, auth.pluginToken); assert.notEqual(code.token, auth.controlToken);
  assert.equal(JSON.stringify(paired).includes(auth.controlToken), false);
  assert.equal(JSON.stringify(paired.status).includes(auth.pluginToken), false);
  const input = f.calls.find((entry) => entry.type === "start").input;
  assert.equal(input.profile, "native"); assert.equal(input.network, "external");
  assert.deepEqual(input.args, [String(f.port)]);
  assert.equal(Object.hasOwn(input, "env"), false); assert.equal(Object.hasOwn(input, "stdin"), false);
  assert.deepEqual(await readdir(path.join(f.dataDir, "bridge")), ["runtime-auth.json"]);
  await poll(auth);
  assert.equal((await f.client.status()).connected, true);
  await f.client.pair();
  assert.equal(f.calls.filter((entry) => entry.type === "start").length, 1);
});

test("client preserves unknown outcomes and created IDs without automatic replay", async (t) => {
  const f = await sdkFixture(t);
  await f.client.pair(); const plugin = await f.plugin();
  const pending = f.client.execute("projects.create", { title: "Synthetic" });
  const rejection = assert.rejects(pending, (error) => error instanceof BridgeError && error.code === "SP_VERIFY_FAILED" && error.createdId === "created-once" && error.outcomeUnknown === true);
  const command = await next(plugin);
  await report(plugin, command, { ok: false, error: { code: "SP_VERIFY_FAILED", message: "Query the new object before retrying." }, createdId: "created-once", outcomeUnknown: true });
  await rejection;
  assert.equal(f.calls.filter((entry) => entry.route === "/internal/execute").length, 1);
});

test("enabled recovery atomically replaces an existing credentials file without rotating or leaking tokens", async (t) => {
  const f = await sdkFixture(t);
  await f.client.pair();
  const before = JSON.parse(await readFile(path.join(f.dataDir, BRIDGE_AUTH_FILE), "utf8"));
  await f.sdk.runtime.stop("fake-1");
  const restarted = createBridgeClient(f.sdk, { port: f.port });
  assert.equal((await restarted.status()).running, false);
  assert.equal(f.calls.filter((entry) => entry.type === "start").length, 1);
  assert.equal((await restarted.restore()).running, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dataDir, BRIDGE_AUTH_FILE), "utf8")), before);
  assert.deepEqual(await readdir(path.join(f.dataDir, "bridge")), ["runtime-auth.json"]);
  assert.equal(f.calls.filter((entry) => entry.type === "start").length, 2);
});

test("a restart leaves current credentials untouched and rewrites stale ones", async (t) => {
  const f = await sdkFixture(t);
  await f.client.pair();
  const file = path.join(f.dataDir, BRIDGE_AUTH_FILE), before = (await stat(file)).mtimeMs;
  await f.sdk.runtime.stop("fake-1");
  await sleep(20);
  assert.equal((await createBridgeClient(f.sdk, { port: f.port }).restore()).running, true);
  assert.equal((await stat(file)).mtimeMs, before, "An up-to-date file is not replaced while a sandbox may hold it");
  await writeFile(file, "{}");
  await f.sdk.runtime.stop("fake-2");
  assert.equal((await createBridgeClient(f.sdk, { port: f.port }).restore()).running, true);
  assert.equal(JSON.parse(await readFile(file, "utf8")).protocol, 1);
  assert.deepEqual(await readdir(path.join(f.dataDir, "bridge")), ["runtime-auth.json"]);
});

test("a quiesced service cannot be silently reused if the host could not stop it", async (t) => {
  const f = await sdkFixture(t, { stopError: true });
  await f.client.pair();
  await assert.rejects(f.client.disable());
  await assert.rejects(f.client.pair(), { code: "SP_BRIDGE_STOPPING" });
  assert.equal(f.calls.filter((entry) => entry.type === "start").length, 1);
});

test("after a verified start each command is a single runtime fetch", async (t) => {
  const f = await sdkFixture(t);
  await f.client.pair(); const plugin = await f.plugin();
  for (let round = 0; round < 2; round++) {
    const before = f.calls.length;
    const pending = f.client.execute("tags.list", {});
    await report(plugin, await next(plugin), { ok: true, data: { tags: [] } });
    assert.deepEqual(await pending, { tags: [] });
    assert.deepEqual(f.calls.slice(before).map((entry) => entry.route), ["/internal/execute"]);
  }
});

test("a read whose runtime vanished re-checks the host once; writes are not resent", async (t) => {
  const f = await sdkFixture(t);
  await f.client.pair(); const plugin = await f.plugin();
  await f.sdk.runtime.stop("fake-1");
  await assert.rejects(f.client.execute("tags.create", { title: "Synthetic" }), (error) => error.outcomeUnknown === true);
  assert.equal(f.calls.filter((entry) => entry.type === "start").length, 1, "A lost write never triggers a restart and resend");
  const pending = f.client.execute("tags.list", {});
  while (f.calls.filter((entry) => entry.type === "start").length < 2) await sleep(5);
  await report(plugin, await next(plugin), { ok: true, data: { tags: [] } });
  assert.deepEqual(await pending, { tags: [] });
  assert.equal(f.calls.filter((entry) => entry.type === "start").length, 2);
});

test("client treats missing or malformed write replies as unknown and never retries", async (t) => {
  for (const reply of [() => { throw new Error("Lost response"); }, () => new Response("<html>bad</html>"), () => new Response(JSON.stringify({ data: {} }))]) {
    const f = await sdkFixture(t, { reply });
    await f.client.pair();
    await assert.rejects(f.client.execute("tags.create", { title: "Synthetic" }), (error) => error.outcomeUnknown === true);
    assert.equal(f.calls.filter((entry) => entry.route === "/internal/execute").length, 1);
  }
});

test("disable drains delivered work and restore respects persisted opt-out", async (t) => {
  const f = await sdkFixture(t);
  await f.client.pair(); const plugin = await f.plugin();
  const pending = f.client.execute("tags.create", { title: "Synthetic" });
  const rejected = assert.rejects(pending, (error) => error.outcomeUnknown === true);
  await next(plugin);
  const disabled = await f.client.disable();
  await rejected;
  assert.equal(disabled.enabled, false); assert.equal(disabled.running, false);
  const replacement = createBridgeClient(f.sdk, { port: f.port });
  await replacement.restore();
  assert.equal(f.calls.filter((entry) => entry.type === "start").length, 1);
  await assert.rejects(replacement.execute("tags.list", {}), { code: "SP_BRIDGE_NOT_PAIRED" });
});

test("failed process stop reports failure after safely disabling command delivery", async (t) => {
  const f = await sdkFixture(t, { stopError: true });
  await f.client.pair(); const plugin = await f.plugin();
  await assert.rejects(f.client.disable());
  assert.equal((await poll(plugin)).body.error.code, "SP_BRIDGE_STOPPING");
  const state = await f.client.status(); assert.equal(state.enabled, false); assert.equal(state.stopping, true);
});

test("invalid quiesce acknowledgement plus an unfinished stop is not reported as success", async (t) => {
  const f = await sdkFixture(t, { badDisable: true, keepStopping: true });
  await f.client.pair();
  await assert.rejects(f.client.disable(), { code: "SP_BRIDGE_STOP_UNCONFIRMED" });
});
