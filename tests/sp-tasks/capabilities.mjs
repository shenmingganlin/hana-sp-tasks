// Pure catalog/tool tests: no app startup, production settings, or SP requests.
import assert from "node:assert/strict";
import test from "node:test";
import { bridgeCompatibility, capabilityCatalog, registerCapabilityTool, versionAtLeast, RECOMMENDED_PLUGIN_VERSION } from "../../sp-tasks/lib/capabilities.js";
import { PREFERENCE_CAPABILITIES } from "../../sp-tasks/lib/preference-tools.js";
import { UI_CONTROL_CAPABILITIES } from "../../sp-tasks/lib/ui-control-tools.js";
import { ATTACHMENT_CAPABILITIES } from "../../sp-tasks/lib/attachments-tools.js";
import { KEYBOARD_CAPABILITIES } from "../../sp-tasks/lib/keyboard-tools.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in capability tests"); };
const ready = (pluginVersion = "0.5.0", extra = {}) => ({ available: true, configured: true, enabled: true, running: true, connected: true, accepting: true, stopping: false, runtimeState: "ready", protocol: 1, pluginVersion, ...extra });
const additions = [{ id: "fixture_extension", label: "Fixture extension", requires: "bridge", minimumPluginVersion: "0.3.0", tools: ["fixture_tool"], description: "A newer capability." }];
const byId = (catalog) => Object.fromEntries(catalog.map((item) => [item.id, item]));

test("stable version comparisons use numeric components and accept valid build metadata", () => {
  assert.equal(RECOMMENDED_PLUGIN_VERSION, "0.5.0");
  for (const [actual, required, expected] of [
    ["0.1.0", "0.1.0", true], ["0.1.9", "0.2.0", false], ["0.2.0", "0.1.0", true],
    ["0.2.9", "0.3.0", false], ["0.3.0", "0.3.0", true], ["0.3.1", "0.3.0", true],
    ["0.10.0", "0.3.0", true], ["0.3.0", "0.10.0", false], ["1.0.0", "0.99.99", true],
    ["0.3.0+build.12-ab", "0.3.0", true], ["0.3.0", "0.3.0+build.1", true],
  ]) assert.equal(versionAtLeast(actual, required), expected, `${actual} >= ${required}`);
});

test("prerelease, unknown, malformed and unsafe versions cannot pass a capability gate", () => {
  const invalid = [undefined, null, 3, {}, "", "unknown", "memory", "0.3", "v0.3.0", " 0.3.0", "0.3.0 ", "0.3.0\n", "00.3.0", "0.03.0", "0.3.00", "0.3.0-beta.1", "1.0.0-rc.1", "0.3.0+", "0.3.0+.", "0.3.0+build..1", "0.3.0+build.", "0.3.0+build_1", "9007199254740992.0.0", "0.9007199254740992.0"];
  for (const version of invalid) {
    assert.equal(versionAtLeast(version, "0.3.0"), false, `actual ${String(version)}`);
    assert.equal(versionAtLeast("1.0.0", version), false, `minimum ${String(version)}`);
  }
});

test("compatibility and individual capabilities distinguish old and current plugins without disabling older features", () => {
  for (const [version, compatibility, projectReady, completionReady, extensionReady] of [
    ["0.1.0", "outdated", true, false, false], ["0.2.0", "outdated", true, true, false],
    ["0.3.0", "outdated", true, true, true], ["0.3.0+local.1", "outdated", true, true, true],
    ["0.4.0", "outdated", true, true, true], ["0.4.0+local.1", "outdated", true, true, true],
    ["0.5.0", "compatible", true, true, true], ["0.5.0+local.1", "compatible", true, true, true],
    ["1.0.0", "compatible", true, true, true], ["0.3.0-rc.1", "unknown", false, false, false],
    ["unknown", "unknown", false, false, false], [null, "unknown", false, false, false],
  ]) {
    const bridge = ready(version), catalog = byId(capabilityCatalog(bridge, additions));
    assert.equal(bridgeCompatibility(bridge).state, compatibility, String(version));
    assert.equal(bridgeCompatibility(bridge).requiredVersion, "0.5.0");
    assert.equal(bridgeCompatibility(bridge).latestVersion, "0.6.0");
    assert.equal(bridgeCompatibility(bridge).updateAvailable, compatibility === "compatible" && /^0\.5\.0/.test(version), String(version));
    assert.equal(catalog.projects.available, projectReady, String(version));
    assert.equal(catalog.tags.available, projectReady, String(version));
    assert.equal(catalog.completion.available, completionReady, String(version));
    assert.equal(catalog.fixture_extension.available, extensionReady, String(version));
    assert.equal(catalog.fixture_extension.status, extensionReady ? "ready" : "needs_upgrade");
  }
});

test("unimplemented work is distinguished from public API gaps and upstream persistence defects", () => {
  const catalog = byId(capabilityCatalog(ready()));
  for (const id of ["global_settings", "file_attachments", "additional_order"]) {
    assert.equal(catalog[id].requires, "not_implemented");
    assert.equal(catalog[id].status, "not_implemented");
    assert.equal(catalog[id].available, false);
    assert.equal(catalog[id].blocker, undefined);
  }
  for (const id of ["project_archive", "tag_delete", "advanced_repeat", "focus_session", "countdown_start", "boards", "ui_state"]) {
    assert.equal(catalog[id].status, "unsupported");
    assert.equal(catalog[id].blocker, "public_api");
    assert.equal(catalog[id].available, false);
  }
  assert.equal(catalog.counter_create.blocker, "upstream_bug");
});

test("all seven new capability groups require 0.5.0 while older preference groups retain their gates", () => {
  const extensions = [...PREFERENCE_CAPABILITIES, ...UI_CONTROL_CAPABILITIES, ...ATTACHMENT_CAPABILITIES, ...KEYBOARD_CAPABILITIES];
  const old = byId(capabilityCatalog(ready("0.4.0"), extensions));
  const current = byId(capabilityCatalog(ready(), extensions));
  const newIds = ["display_preferences", "task_behavior_preferences", "tracking_preferences", "reminder_preferences", "ui_control", "task_attachments", "keyboard_preferences"];
  for (const id of newIds) {
    assert.equal(old[id].status, "needs_upgrade", id);
    assert.equal(current[id].status, "ready", id);
    assert.equal(current[id].minimumPluginVersion, "0.5.0", id);
  }
  for (const id of ["preferences", "focus_preferences", "break_preferences"]) assert.equal(old[id].status, "ready", id);
  assert.equal(new Set(Object.values(current).map((item) => item.id)).size, capabilityCatalog(ready(), extensions).length);
  assert.equal(current.file_attachments.status, "not_implemented");
  assert.equal(current.ui_state.status, "unsupported");
});

test("a current plugin never makes an unavailable or unhealthy bridge usable", () => {
  for (const bridge of [undefined, null, {}, ready("0.3.0", { available: false }), ready("0.3.0", { enabled: false }), ready("0.3.0", { running: false, runtimeState: "starting" }), ready("0.3.0", { connected: false }), ready("0.3.0", { accepting: false }), ready("0.3.0", { stopping: true }), ready("0.3.0", { error: { code: "SP_BRIDGE_ERROR", message: "Synthetic failure" } }), ready("0.3.0", { protocol: 2 }), ready("0.3.0", { protocol: "1" }), ready("0.3.0", { protocol: undefined })]) {
    const catalog = capabilityCatalog(bridge, additions);
    assert.ok(catalog.filter((item) => item.requires === "bridge").every((item) => !item.available && item.status === "needs_pairing"));
    assert.notEqual(bridgeCompatibility(bridge).state, "compatible");
  }
});

test("REST availability describes implemented features without claiming a tested connection", () => {
  for (const bridge of [undefined, ready("0.1.0"), ready("0.3.0", { error: { code: "SP_BRIDGE_ERROR" } })]) {
    const catalog = capabilityCatalog(bridge), rest = catalog.filter((item) => item.requires === "rest");
    assert.deepEqual(rest.map((item) => item.id), ["tasks", "time", "archive", "repeat", "notes", "counter_values"]);
    for (const item of rest) {
      assert.equal(item.available, true); assert.equal(item.status, "rest");
      assert.match(item.reason, /实际连接/);
    }
    for (const item of catalog.filter((item) => item.requires === "unsupported")) {
      assert.equal(item.available, false); assert.equal(item.status, "unsupported"); assert.ok(item.reason);
    }
  }
});

async function toolFixture() {
  const tools = new Map(), calls = [];
  const sdk = {
    tools: { register: async (definition) => { tools.set(definition.name, definition); } },
    network: { fetch: async () => { assert.fail("Capability discovery must not contact SP"); } },
    runtime: { start: async () => { assert.fail("Capability discovery must not start a runtime"); } },
    config: { getAll: async () => { assert.fail("Tool registration must not inspect credentials"); } },
  };
  const guard = (work) => async (args) => {
    try { return await work(args); }
    catch (error) { return { ok: false, code: error.code, message: error.message }; }
  };
  await registerCapabilityTool(sdk, {
    setup: async function () { assert.equal(arguments.length, 0); calls.push("read-setup"); return { app: { version: "fixture" }, capabilities: capabilityCatalog(undefined) }; },
    guard, ok: (data) => ({ ok: true, ...data }),
  });
  return { tools, calls, call: (args) => tools.get("sp_tasks_capabilities").execute(args) };
}

test("the read-only capability tool has a closed schema and strips Hana context without mutation or disclosure", async () => {
  const f = await toolFixture();
  assert.deepEqual([...f.tools.keys()], ["sp_tasks_capabilities"]);
  assert.deepEqual(f.tools.get("sp_tasks_capabilities").parameters, { type: "object", additionalProperties: false, properties: {} });
  assert.equal(f.calls.length, 0);
  const marker = "PRIVATE_CONTEXT_TOKEN_SENTINEL";
  const contexts = [null, Object.freeze({ sessionPath: marker, callToken: marker }), Object.freeze({ document: { access: { token: marker } }, messageText: marker })];
  for (const context of contexts) {
    const input = Object.freeze({ context });
    const result = await f.call(input);
    assert.equal(result.ok, true); assert.equal(input.context, context);
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
  assert.equal(f.calls.length, contexts.length);
});

test("unknown business arguments are rejected before setup even alongside host context", async () => {
  const f = await toolFixture();
  for (const args of [undefined, null, [], "all", 1, { action: "list" }, { context: { callToken: "SECRET" }, token: "SECRET" }, { bogus: undefined }]) {
    const result = await f.call(args);
    assert.equal(result.ok, false); assert.equal(result.code, "SP_BAD_INPUT");
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call({})).ok, true);
  assert.equal(f.calls.length, 1);
});
