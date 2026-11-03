// Download/setup tests use only synthetic ZIP bytes and injected in-memory reads.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { createBridgeSetup, readBundledInfo, readBundledPlugin, registerBridgeSetupRoutes, writeBundledPlugin } from "../../sp-tasks/lib/bridge-setup.js";
import { BUNDLED_PLUGIN_VERSION, RECOMMENDED_PLUGIN_VERSION, RUNTIME_PERMISSIONS } from "../../sp-tasks/lib/capabilities.js";
import { validateCompanionZip } from "../../sp-tasks/scripts/companion-zip.mjs";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in bridge setup tests"); };
const marker = "PRIVATE_TOKEN_AND_RAW_ERROR_SENTINEL";
const root = new URL("memory://fixture/companion/");
const ready = (extra = {}) => ({ available: true, configured: true, enabled: true, running: true, connected: true, accepting: true, stopping: false, runtimeState: "ready", protocol: 1, pluginVersion: RECOMMENDED_PLUGIN_VERSION, lastSeen: 123, ...extra });
const defaultManifest = () => ({ id: "hana-sp-bridge", name: "Fixture SP extension", version: BUNDLED_PLUGIN_VERSION, manifestVersion: 1, minSupVersion: "19.3.1", permissions: ["http", "deleteProject"], iFrame: false });

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, content] of files) {
    const bytes = Buffer.from(content), packed = deflateRawSync(bytes), filename = Buffer.from(name), crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, filename); offset += header.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function fixture({ manifest = defaultManifest(), files, bytes } = {}) {
  const fileRows = files ?? [["manifest.json", JSON.stringify(manifest)], ["plugin.js", "/* Synthetic plugin; never executed. */\n"], ["README.md", "Synthetic readme.\n"]];
  const state = { bytes: bytes ?? makeZip(fileRows), metadata: null, reads: [], readError: null, readErrorAt: null };
  const refreshMetadata = () => {
    state.metadata = { id: "hana-sp-bridge", name: "Fixture SP extension", version: BUNDLED_PLUGIN_VERSION, minSpVersion: "19.3.1", protocolVersion: 1, size: state.bytes.length, sha256: createHash("sha256").update(state.bytes).digest("hex") };
  };
  refreshMetadata();
  const read = async (url, encoding) => {
    state.reads.push([url.href, encoding]);
    if (state.readError && (!state.readErrorAt || url.pathname.endsWith(state.readErrorAt))) throw state.readError;
    if (url.href === new URL("package.json", root).href) { assert.equal(encoding, "utf8"); return typeof state.metadata === "string" ? state.metadata : JSON.stringify(state.metadata); }
    assert.equal(url.href, new URL("hana-sp-bridge.zip", root).href); assert.equal(encoding, undefined);
    return state.bytes;
  };
  return { state, refreshMetadata, load: () => readBundledPlugin({ read, root }), info: () => readBundledInfo({ read, root }) };
}
function routes({ setup = async () => ({}), loadPlugin }) {
  const handlers = new Map();
  registerBridgeSetupRoutes({ get: (path, handler) => { assert.equal(handlers.has(path), false); handlers.set(path, handler); } }, { setup, loadPlugin });
  const context = { json: (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }) };
  return { handlers, call: (path) => handlers.get(path)(context) };
}

test("bundled plugin is read from fixed names and returns only safe download metadata plus exact bytes", async () => {
  const f = fixture(); f.state.metadata.privateToken = marker;
  const result = await f.load();
  assert.deepEqual(result.bytes, f.state.bytes);
  assert.deepEqual(result.plugin, { available: true, id: "hana-sp-bridge", name: "Fixture SP extension", version: BUNDLED_PLUGIN_VERSION, minSpVersion: "19.3.1", protocolVersion: 1, minimumCompatibleVersion: RECOMMENDED_PLUGIN_VERSION, fileName: "hana-sp-bridge.zip", downloadPath: "/bridge/plugin.zip", size: f.state.bytes.length, sha256: f.state.metadata.sha256 });
  assert.deepEqual(f.state.reads, [[new URL("package.json", root).href, "utf8"], [new URL("hana-sp-bridge.zip", root).href, undefined]]);
  assert.equal(JSON.stringify(result.plugin).includes(marker), false);
});

test("missing files, invalid metadata, unsupported version and hash/size mismatches fail closed", async (t) => {
  const cases = [
    ["missing package", (f) => { f.state.readError = Object.assign(new Error(marker), { code: "ENOENT" }); }],
    ["missing ZIP after valid metadata", (f) => { f.state.readError = Object.assign(new Error(marker), { code: "ENOENT" }); f.state.readErrorAt = "hana-sp-bridge.zip"; }],
    ["malformed JSON", (f) => { f.state.metadata = "{broken"; }],
    ["wrong id", (f) => { f.state.metadata.id = "different-plugin"; }],
    ["old version", (f) => { f.state.metadata.version = "0.2.0"; }],
    ["prerelease version", (f) => { f.state.metadata.version = "0.3.0-rc.1"; }],
    ["unknown version", (f) => { f.state.metadata.version = null; }],
    ["wrong protocol", (f) => { f.state.metadata.protocolVersion = 2; }],
    ["wrong SP version", (f) => { f.state.metadata.minSpVersion = "18.0.0"; }],
    ["invalid size", (f) => { f.state.metadata.size = 3; }],
    ["oversized package", (f) => { f.state.metadata.size = 2 * 1024 * 1024 + 1; }],
    ["incorrect size", (f) => { f.state.metadata.size++; }],
    ["incorrect digest", (f) => { f.state.metadata.sha256 = "0".repeat(64); }],
    ["corrupt bytes", (f) => { f.state.bytes = Buffer.from(f.state.bytes); f.state.bytes[50] ^= 1; }],
    ["non-buffer bytes", (f) => { f.state.bytes = new Uint8Array(f.state.bytes); }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const f = fixture(); change(f);
    await assert.rejects(f.load());
    const response = await routes({ loadPlugin: f.load }).call("/bridge/plugin.zip");
    assert.equal(response.status, 503); assert.match(response.headers.get("Content-Type"), /application\/json/);
    const body = await response.json(); assert.equal(body.ok, false); assert.equal(typeof body.error, "string");
    assert.equal(JSON.stringify(body).includes(marker), false);
    assert.equal(response.headers.get("Content-Disposition"), null);
  });
});

test("the build-time ZIP check rejects invalid ZIPs and mismatched internal manifests", async (t) => {
  const valid = fixture();
  assert.equal(validateCompanionZip(valid.state.bytes, valid.state.metadata).version, BUNDLED_PLUGIN_VERSION);
  const cases = [
    ["wrong internal version", () => fixture({ manifest: { ...defaultManifest(), version: "0.2.0" } })],
    ["wrong internal id", () => fixture({ manifest: { ...defaultManifest(), id: "another-plugin" } })],
    ["wrong internal SP version", () => fixture({ manifest: { ...defaultManifest(), minSupVersion: "20.0.0" } })],
    ["unsupported manifest version", () => fixture({ manifest: { ...defaultManifest(), manifestVersion: 2 } })],
    ["missing manifest", () => fixture({ files: [["other.json", "{}"], ["plugin.js", "/* fixture */"], ["README.md", "fixture"]] })],
    ["invalid manifest JSON", () => fixture({ files: [["manifest.json", "{broken"], ["plugin.js", "/* fixture */"], ["README.md", "fixture"]] })],
    ["empty plugin", () => fixture({ files: [["manifest.json", JSON.stringify(defaultManifest())], ["plugin.js", ""], ["README.md", "fixture"]] })],
    ["missing plugin", () => fixture({ files: [["manifest.json", JSON.stringify(defaultManifest())], ["README.md", "fixture"]] })],
    ["truncated directory", () => { const f = fixture(); f.state.bytes = f.state.bytes.subarray(0, f.state.bytes.length - 7); f.refreshMetadata(); return f; }],
    ["invalid CRC with matching local and central headers", () => {
      const f = fixture(), bytes = f.state.bytes;
      const directory = bytes.readUInt32LE(bytes.length - 22 + 16), wrong = (bytes.readUInt32LE(14) ^ 1) >>> 0;
      bytes.writeUInt32LE(wrong, 14); bytes.writeUInt32LE(wrong, directory + 16); f.refreshMetadata(); return f;
    }],
  ];
  for (const [name, make] of cases) await t.test(name, async () => {
    const f = make();
    assert.equal(f.state.metadata.sha256, createHash("sha256").update(f.state.bytes).digest("hex"));
    assert.throws(() => validateCompanionZip(f.state.bytes, f.state.metadata));
  });
});

test("settings metadata reads only package.json; the ZIP is read only for a download", async () => {
  const f = fixture();
  const setup = createBridgeSetup({ bridge: { status: async () => ready() }, version: "fixture", loadPlugin: f.info });
  const result = await setup();
  assert.equal(result.plugin.available, true); assert.equal(result.plugin.version, BUNDLED_PLUGIN_VERSION);
  assert.deepEqual(f.state.reads, [[new URL("package.json", root).href, "utf8"]]);
});

test("download serves byte-for-byte ZIP data with attachment and non-cache headers independently of status", async () => {
  const f = fixture(); let setupCalls = 0;
  const app = routes({ setup: async () => { setupCalls++; throw new Error(marker); }, loadPlugin: f.load });
  assert.deepEqual([...app.handlers.keys()], ["/bridge/setup", "/bridge/plugin.zip"]);
  const response = await app.call("/bridge/plugin.zip");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/zip");
  assert.equal(response.headers.get("Content-Disposition"), 'attachment; filename="hana-sp-bridge.zip"');
  assert.equal(response.headers.get("Content-Length"), String(f.state.bytes.length));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.state.bytes);
  assert.equal(setupCalls, 0);
});

test("export writes the verified ZIP into a user-picked absolute directory", async (t) => {
  const f = fixture();
  const writes = [];
  const sdk = { resources: { write: async (ref, bytes) => { writes.push([ref, Buffer.from(bytes)]); } } };
  const dir = path.join(path.parse(process.cwd()).root, "fixture-picked");
  const result = await writeBundledPlugin({ sdk, dir, loadPlugin: f.load });
  assert.equal(result.path, path.join(dir, "hana-sp-bridge.zip"));
  assert.equal(result.fileName, "hana-sp-bridge.zip");
  assert.equal(result.size, f.state.bytes.length);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], [{ kind: "local-file", path: result.path }, f.state.bytes]);

  for (const bad of ["", "relative\\folder", `C:\\bad\0dir`, null]) {
    await t.test(`rejects unsafe directory ${JSON.stringify(bad)}`, async () => {
      const before = writes.length;
      await assert.rejects(writeBundledPlugin({ sdk, dir: bad, loadPlugin: f.load }), { code: "EXPORT_DIR_INVALID" });
      assert.equal(writes.length, before);
    });
  }

  await t.test("a bad bundle or write failure never reports success", async () => {
    const before = writes.length;
    await assert.rejects(writeBundledPlugin({ sdk, dir, loadPlugin: () => { throw new Error("bad bundle"); } }));
    assert.equal(writes.length, before);
    await assert.rejects(writeBundledPlugin({ sdk: { resources: { write: async () => { throw new Error("EACCES"); } } }, dir, loadPlugin: f.load }), /EACCES/);
  });
});

test("async and synchronous status failures still expose REST capabilities and a valid plugin download", async (t) => {
  for (const sync of [false, true]) await t.test(sync ? "synchronous throw" : "rejected promise", async () => {
    const f = fixture(); let calls = 0;
    const bridge = { status: () => { calls++; if (sync) throw new Error(marker); return Promise.reject(new Error(marker)); }, pair: () => assert.fail("Pairing is forbidden"), restore: () => assert.fail("Starting runtime is forbidden") };
    const setup = createBridgeSetup({ bridge, version: "fixture-version", platform: "win32", loadPlugin: f.load });
    assert.equal(calls, 0); assert.equal(f.state.reads.length, 0);
    const app = routes({ setup, loadPlugin: f.load }), response = await app.call("/bridge/setup");
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true); assert.equal(result.app.version, "fixture-version");
    assert.equal(result.bridge.connected, false); assert.equal(result.bridge.error.code, "SP_BRIDGE_STATUS_UNAVAILABLE");
    assert.equal(result.plugin.available, true); assert.equal(result.plugin.downloadPath, "/bridge/plugin.zip");
    assert.ok(result.capabilities.filter((item) => item.requires === "rest").every((item) => item.available));
    assert.ok(result.capabilities.filter((item) => item.requires === "bridge").every((item) => !item.available));
    assert.equal(result.requirements.nativeIdentity, "not-checked"); assert.equal(result.requirements.platform, "win32");
    assert.deepEqual(result.requirements.permissions, RUNTIME_PERMISSIONS);
    assert.equal(JSON.stringify(result).includes(marker), false); assert.equal(calls, 1);
    assert.equal((await app.call("/bridge/plugin.zip")).status, 200); assert.equal(calls, 1);
  });
});

test("bundle failure is sanitized without hiding a working bridge or catalog", async (t) => {
  for (const sync of [false, true]) await t.test(sync ? "synchronous throw" : "rejected promise", async () => {
    const loadPlugin = () => { if (sync) throw new Error(marker); return Promise.reject(new Error(marker)); };
    const setup = createBridgeSetup({ bridge: { status: async () => ready() }, version: "fixture", loadPlugin });
    const result = await setup();
    assert.equal(result.plugin.available, false); assert.equal(result.plugin.version, null);
    assert.equal(result.plugin.downloadPath, undefined); assert.equal(result.plugin.minimumCompatibleVersion, RECOMMENDED_PLUGIN_VERSION);
    assert.equal(result.bridge.connected, true); assert.equal(result.compatibility.state, "compatible");
    assert.equal(result.capabilities.find((item) => item.id === "completion").available, true);
    assert.equal(JSON.stringify(result).includes(marker), false);
    const response = await routes({ setup, loadPlugin }).call("/bridge/plugin.zip");
    assert.equal(response.status, 503); assert.equal((await response.text()).includes(marker), false);
  });
});

test("fulfilled status is projected and failures never echo raw errors or credential fields", async () => {
  const f = fixture();
  const source = ready({ controlToken: marker, pluginToken: marker, pairingCode: marker, context: { token: marker }, error: { code: "SP_BRIDGE_ERROR", message: marker, stack: marker, token: marker } });
  const result = await createBridgeSetup({ bridge: { status: async () => source }, version: "fixture", loadPlugin: f.load })();
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(result.bridge.error.code, "SP_BRIDGE_ERROR"); assert.notEqual(result.bridge.error.message, marker);
  assert.equal(result.compatibility.state, "disconnected");
  assert.ok(result.capabilities.filter((item) => item.requires === "bridge").every((item) => !item.available));
  assert.equal(source.controlToken, marker, "Status projection must not mutate its source");
});

test("malformed status values fail safely and wrong protocols do not advertise bridge availability", async () => {
  const f = fixture();
  for (const value of [null, undefined, [], "ready"]) {
    const result = await createBridgeSetup({ bridge: { status: async () => value }, version: "fixture", loadPlugin: f.load })();
    assert.equal(result.bridge.connected, false); assert.equal(result.plugin.available, true);
    assert.equal(result.bridge.error.code, "SP_BRIDGE_STATUS_UNAVAILABLE");
  }
  for (const value of [ready({ protocol: 2 }), ready({ protocol: "1" }), ready({ running: false, runtimeState: "starting" }), ready({ accepting: false }), ready({ stopping: true }), ready({ available: false }), ready({ enabled: false })]) {
    const result = await createBridgeSetup({ bridge: { status: async () => value }, version: "fixture", loadPlugin: f.load })();
    assert.notEqual(result.compatibility.state, "compatible");
    assert.ok(result.capabilities.filter((item) => item.requires === "bridge").every((item) => !item.available));
  }
});
