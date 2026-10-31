import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";

const source = await readFile(new URL("../../sp-tasks/ui/assets/companion-download.js", import.meta.url), "utf8");
const html = await readFile(new URL("../../sp-tasks/ui/companion-download.html", import.meta.url), "utf8");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const zip = Uint8Array.from([0x50, 0x4b, 3, 4, ...Array.from({ length: 256 }, (_, index) => index)]);
const clone = (value) => structuredClone(value);
const metadata = (bytes = zip) => ({ ok: true, plugin: {
  available: true, id: "hana-sp-bridge", version: "0.5.0", minSpVersion: "19.3.1", protocolVersion: 1,
  downloadPath: "/bridge/plugin.zip", fileName: "hana-sp-bridge.zip", size: bytes.length, sha256: hash(bytes),
} });
const resource = { kind: "local-file", path: "C:/PRIVATE_SAVE_PATH/hana-sp-bridge.zip" };
const saved = (bytes = zip) => ({ kind: "saved", resource, version: { mtimeMs: 1, size: bytes.length }, overwritten: false, saveReceipt: "PRIVATE_SAVE_RECEIPT" });
const deferred = () => Promise.withResolvers();
async function until(check) {
  for (let index = 0; index < 100; index++) { if (check()) return; await new Promise(setImmediate); }
  assert.fail("The isolated page did not finish its operation");
}

async function pageFixture(options = {}) {
  const state = { metadata: Object.hasOwn(options, "metadata") ? options.metadata : metadata(), zip: options.zip ?? zip, saved: options.saved ?? saved(), calls: [], saves: [], reads: 0, readyCalls: 0, blobCalls: 0, saveError: null, zipError: null, setupError: null, setupStatus: true, zipStatus: true, contentLength: null, events: {}, crypto: Object.hasOwn(options, "crypto") ? options.crypto : webcrypto };
  class Element {
    attributes = {}; dataset = {}; listeners = {}; textContent = ""; hidden = false; disabled = false;
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(event, listener) { this.listeners[event] = listener; }
  }
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const sdk = {
    ready: async () => { state.readyCalls++; if (options.readyError) throw options.readyError; },
    api: { fetch: async (path, init) => {
      state.calls.push({ path, init }); assert.equal(init, undefined);
      if (path === "/bridge/setup") {
        if (state.setupError) throw state.setupError;
        return { ok: state.setupStatus, text: async () => state.setupText ?? JSON.stringify(state.metadata) };
      }
      assert.equal(path, "/bridge/plugin.zip", "Only fixed app-owned GET routes are allowed");
      if (state.zipError) throw state.zipError;
      if (state.zipGate) await state.zipGate.promise;
      return { ok: state.zipStatus, headers: { get: (key) => { assert.equal(key, "content-length"); return state.contentLength; } }, arrayBuffer: async () => {
        state.reads++; return state.zip.buffer.slice(state.zip.byteOffset, state.zip.byteOffset + state.zip.byteLength);
      } };
    } },
    resources: { saveFile: async (input, options) => {
      state.saves.push({ input: clone(input), options: clone(options) });
      if (state.saveGate) await state.saveGate.promise;
      if (state.saveError) throw state.saveError;
      return state.saved;
    } },
  };
  if (options.noSaveApi) delete sdk.resources.saveFile;
  const forbidden = () => { state.blobCalls++; throw new Error("Blob, navigation and direct network fallbacks are forbidden"); };
  const context = vm.createContext({
    document: { getElementById: (id) => { assert.ok(elements.has(id), `Missing HTML element ${id}`); return elements.get(id); }, createElement: forbidden, body: { append: forbidden } },
    crypto: state.crypto, btoa, Blob: forbidden, URL: { createObjectURL: forbidden, revokeObjectURL: forbidden }, fetch: forbidden,
    addEventListener: (event, listener) => { state.events[event] = listener; },
    createHanaAppUiSdk: (input) => { assert.equal(input.followHostTheme, true); return sdk; },
  });
  const sdkImport = 'import { createHanaAppUiSdk } from "./sdk.js";';
  assert.ok(source.startsWith(sdkImport));
  vm.runInContext(source.slice(sdkImport.length), context, { filename: "companion-download.js" });
  await until(() => elements.get("companion-download").attributes["aria-busy"] === "false");
  return { state, elements, context,
    save: () => vm.runInContext("savePackage()", context), refresh: () => vm.runInContext("refreshMetadata()", context),
    click: (id) => elements.get(id).listeners.click(),
    text: () => [...elements.values()].map((element) => element.textContent).join(String.fromCharCode(10)),
    status: () => elements.get("companion-status"),
  };
}

test("the card reuses app styling, has accessible status and no download link fallback", () => {
  assert.ok(html.includes('lang="zh-CN"')); assert.ok(html.includes('./assets/settings.css'));
  assert.ok(html.includes('id="companion-status" role="status" aria-live="polite"'));
  assert.ok(!html.includes("<a ")); assert.ok(!html.includes(" download="));
  for (const id of ["companion-download", "companion-info", "companion-details", "companion-checksum", "companion-refresh", "companion-save"]) assert.ok(html.includes(`id="${id}"`));
  assert.ok(!html.includes("companion-retry"), "There is no unlock step: saving again is always the user's own click");
  assert.ok(html.includes("app/resources.write"));
});

test("initial load and metadata refresh are read-only and never fetch ZIP or save", async () => {
  const page = await pageFixture();
  assert.deepEqual(page.state.calls.map((row) => row.path), ["/bridge/setup"]);
  assert.equal(page.state.readyCalls, 1); assert.equal(page.state.saves.length, 0);
  assert.equal(page.elements.get("companion-save").disabled, false);
  await page.refresh();
  assert.deepEqual(page.state.calls.map((row) => row.path), ["/bridge/setup", "/bridge/setup"]);
  assert.equal(page.state.saves.length, 0); assert.equal(page.state.reads, 0);
  assert.ok(page.text().includes("0.5.0")); assert.ok(page.text().includes("19.3.1"));
});

test("explicit save hashes ZIP bytes and sends binary-safe base64 with no destination path", async () => {
  const page = await pageFixture(); await page.save();
  assert.deepEqual(page.state.calls.map((row) => row.path), ["/bridge/setup", "/bridge/plugin.zip"]);
  assert.equal(page.state.saves.length, 1);
  const request = page.state.saves[0];
  assert.deepEqual(Object.keys(request.input).sort(), ["contentBase64", "mimeType", "suggestedName"]);
  assert.equal(request.input.suggestedName, "hana-sp-bridge.zip"); assert.equal(request.input.mimeType, "application/zip");
  assert.deepEqual(Buffer.from(request.input.contentBase64, "base64"), Buffer.from(zip));
  assert.deepEqual(request.options, { timeoutMs: 300000 });
  assert.equal(page.status().dataset.state, "saved"); assert.match(page.status().textContent, /已确认保存完成/);
  assert.doesNotMatch(page.text(), /PRIVATE_SAVE_PATH|PRIVATE_SAVE_RECEIPT/); assert.equal(page.state.blobCalls, 0);
});

const invalidMetadata = [
  ["missing body", null], ["missing explicit success", { ...metadata(), ok: undefined }],
  ...[
    ["missing package", undefined], ["unavailable package", { available: false, error: "PRIVATE_ROUTE_SECRET" }],
    ["wrong id", { ...metadata().plugin, id: "other" }], ["wrong protocol", { ...metadata().plugin, protocolVersion: 2 }],
    ["external path", { ...metadata().plugin, downloadPath: "https://evil.invalid/private" }],
    ["query path", { ...metadata().plugin, downloadPath: "/bridge/plugin.zip?token=PRIVATE_ROUTE_SECRET" }],
    ["wrong name", { ...metadata().plugin, fileName: "../../private.zip" }],
    ["short size", { ...metadata().plugin, size: 3 }], ["large size", { ...metadata().plugin, size: 2 * 1024 * 1024 + 1 }],
    ["string size", { ...metadata().plugin, size: String(zip.length) }], ["fractional size", { ...metadata().plugin, size: 4.5 }],
    ["wrong hash", { ...metadata().plugin, sha256: "PRIVATE_ROUTE_SECRET" }],
    ["missing version", { ...metadata().plugin, version: null }], ["raw version", { ...metadata().plugin, version: "PRIVATE_ROUTE_SECRET" }],
    ["invalid minimum", { ...metadata().plugin, minSpVersion: "PRIVATE_ROUTE_SECRET" }],
  ].map(([name, plugin]) => [name, { ...metadata(), plugin }]),
];
for (const [label, body] of invalidMetadata) {
  test(`invalid metadata ${label} disables saving without reflecting details`, async () => {
    const page = await pageFixture({ metadata: body }); await page.save();
    assert.equal(page.elements.get("companion-save").disabled, true);
    assert.equal(page.state.saves.length, 0); assert.equal(page.state.reads, 0);
    assert.doesNotMatch(page.text(), /PRIVATE_ROUTE_SECRET|evil.invalid/);
  });
}

test("failed or malformed metadata refresh clears stale metadata and never starts saving", async () => {
  for (const cause of ["throw", "http", "json", "size"]) {
    const page = await pageFixture();
    if (cause === "throw") page.state.setupError = new Error("Authorization: PRIVATE_ROUTE_SECRET");
    if (cause === "http") page.state.setupStatus = false;
    if (cause === "json") page.state.setupText = "PRIVATE_ROUTE_SECRET";
    if (cause === "size") page.state.setupText = "x".repeat(256 * 1024 + 1);
    await page.refresh(); await page.save();
    assert.equal(page.elements.get("companion-save").disabled, true); assert.equal(page.state.saves.length, 0);
    assert.equal(page.elements.get("companion-details").hidden, true); assert.doesNotMatch(page.text(), /PRIVATE_ROUTE_SECRET|Authorization/);
  }
});

for (const [label, crypto] of [["missing", undefined], ["missing subtle", {}], ["missing digest", { subtle: {} }], ["digest failure", { subtle: { digest: async () => { throw new Error("PRIVATE_CRYPTO_SECRET"); } } }], ["wrong digest size", { subtle: { digest: async () => new Uint8Array(16).buffer } }]]) {
  test(`unavailable or broken SHA-256 ${label} refuses save with no fallback`, async () => {
    const page = await pageFixture({ crypto }); await page.save();
    assert.equal(page.state.saves.length, 0); assert.equal(page.state.blobCalls, 0);
    assert.equal(page.status().dataset.state, "error"); assert.doesNotMatch(page.text(), /PRIVATE_CRYPTO_SECRET/);
  });
}

for (const label of ["http", "throw", "short bytes", "wrong magic", "hash mismatch", "extra bytes", "oversized response", "bad content length", "mismatch content length", "oversized content length"]) {
  test(`invalid ZIP ${label} never reaches the save API`, async () => {
    const page = await pageFixture();
    if (label === "http") page.state.zipStatus = false;
    if (label === "throw") page.state.zipError = new Error("Authorization: PRIVATE_ZIP_SECRET");
    if (label === "short bytes") page.state.zip = new Uint8Array([0x50, 0x4b, 3]);
    if (label === "wrong magic") { page.state.zip = zip.slice(); page.state.zip[0] = 0; }
    if (label === "hash mismatch") { page.state.zip = zip.slice(); page.state.zip[10] ^= 1; }
    if (label === "extra bytes") page.state.zip = Uint8Array.from([...zip, 0]);
    if (label === "oversized response") page.state.zip = new Uint8Array(2 * 1024 * 1024 + 1);
    if (label === "bad content length") page.state.contentLength = "PRIVATE_ZIP_SECRET";
    if (label === "mismatch content length") page.state.contentLength = "4";
    if (label === "oversized content length") page.state.contentLength = String(2 * 1024 * 1024 + 1);
    await page.save();
    assert.equal(page.state.saves.length, 0); assert.equal(page.status().dataset.state, "error");
    assert.doesNotMatch(page.text(), /PRIVATE_ZIP_SECRET|Authorization/);
    if (label.includes("content length")) assert.equal(page.state.reads, 0);
  });
}

test("the inclusive 2 MiB package boundary retains every byte in base64", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  bytes.set([0x50, 0x4b, 3, 4]);
  const page = await pageFixture({ metadata: metadata(bytes), zip: bytes, saved: saved(bytes) });
  page.state.contentLength = String(bytes.length); await page.save();
  assert.equal(page.status().dataset.state, "saved");
  assert.deepEqual(Buffer.from(page.state.saves[0].input.contentBase64, "base64"), Buffer.from(bytes));
});

test("page sources contain no literal control bytes or credential-bearing download URLs", () => {
  for (const text of [source, html]) {
    assert.ok([...text].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127 || [9, 10, 13].includes(char.charCodeAt(0))));
    assert.ok(!text.includes("createObjectURL")); assert.ok(!text.includes("new Blob"));
    assert.ok(!text.includes("appSurfaceSession="));
  }
});

for (const [label, receipt, state, text] of [
  ["saved", saved(), "saved", /已确认保存完成/],
  ["canceled", { kind: "canceled" }, "canceled", /已取消.*没有保存/],
  ["browser download", { kind: "download-started", suggestedName: "hana-sp-bridge.zip", mimeType: "application/zip" }, "download-started", /浏览器下载.*尚未确认/],
  ["conflict", { kind: "conflict", resource, version: null }, "unknown", /可能已经写入/],
  ["after-write conflict", { kind: "conflict", resource, version: null, phase: "after-write", mayHaveWritten: true }, "unknown", /可能已经写入/],
  ["saved that may have written elsewhere", { ...saved(), mayHaveWritten: true }, "unknown", /可能已经写入/],
  ["canceled that may have written", { kind: "canceled", mayHaveWritten: true }, "unknown", /可能已经写入/],
  ...[null, undefined, {}, [], "saved", { kind: "future-success" }].map((value, index) => [`malformed ${index + 1}`, value, "unknown", /未收到明确的保存结果.*可能已经写入/]),
]) {
  test(`save receipt ${label} has an honest outcome and is never retried automatically`, async () => {
    const page = await pageFixture(); page.state.saved = receipt; await page.save();
    assert.equal(page.status().dataset.state, state); assert.match(page.status().textContent, text);
    assert.equal(page.state.saves.length, 1, "No automatic retry");
    assert.equal(page.elements.get("companion-save").disabled, false, "Saving again stays the user's explicit choice");
    assert.doesNotMatch(page.text(), /PRIVATE_SAVE_PATH|PRIVATE_SAVE_RECEIPT/);
  });
}

for (const code of ["CAPABILITY_DENIED", "SAVE_FILE_PERMISSION_DENIED", "SLOT_DENIED", "TIMEOUT", "SURFACE_UNAVAILABLE", "HOST_ERROR", undefined, "PRIVATE_ERROR_CODE"]) {
  test(`save rejection ${String(code)} is sanitized and never automatically retried`, async () => {
    const page = await pageFixture();
    page.state.saveError = Object.assign(new Error("Authorization: PRIVATE_SAVE_SECRET C:\PRIVATE_SAVE_PATH"), { code, details: { path: resource.path } });
    await page.save();
    const denied = ["CAPABILITY_DENIED", "SAVE_FILE_PERMISSION_DENIED", "SLOT_DENIED"].includes(code);
    assert.equal(page.status().dataset.state, denied ? "denied" : "unknown");
    if (denied) assert.ok(page.status().textContent.includes("app/resources.write"));
    if (code === "SLOT_DENIED") assert.match(page.status().textContent, /卡片中心.*SP 扩展安装包/);
    if (code === "TIMEOUT") assert.match(page.status().textContent, /超时.*可能已写入/);
    assert.doesNotMatch(page.text(), /PRIVATE_SAVE_SECRET|PRIVATE_SAVE_PATH|PRIVATE_ERROR_CODE|Authorization/);
    assert.equal(page.elements.get("companion-save").disabled, false); assert.equal(page.state.saves.length, 1);
  });
}

test("an unknown result leaves saving to the user's next explicit click", async () => {
  const page = await pageFixture(); page.state.saved = {}; await page.save();
  assert.equal(page.status().dataset.state, "unknown"); assert.equal(page.state.saves.length, 1);
  page.state.saved = { kind: "canceled" }; await page.save();
  assert.equal(page.state.saves.length, 2); assert.equal(page.status().dataset.state, "canceled");
});

test("double clicks and refresh during package fetch or the save dialog cannot overlap saves", async () => {
  const page = await pageFixture(); page.state.zipGate = deferred();
  const first = page.save(); await page.save(); await page.refresh();
  assert.equal(page.state.calls.filter((row) => row.path === "/bridge/plugin.zip").length, 1);
  assert.equal(page.elements.get("companion-save").disabled, true); assert.equal(page.elements.get("companion-refresh").disabled, true);
  page.state.saveGate = deferred(); page.state.zipGate.resolve();
  await until(() => page.state.saves.length === 1);
  page.click("companion-save"); page.click("companion-refresh");
  assert.equal(page.state.saves.length, 1);
  page.state.saveGate.resolve(); await first;
  assert.equal(page.status().dataset.state, "saved");
  assert.equal(page.state.calls.length, 2); assert.equal(page.state.saves.length, 1);
});

test("closing the card during ZIP preparation never opens a late save dialog", async () => {
  const page = await pageFixture(); page.state.zipGate = deferred();
  const pending = page.save(); page.state.events.pagehide(); page.state.zipGate.resolve(); await pending;
  assert.equal(page.state.saves.length, 0); assert.equal(page.elements.get("companion-save").disabled, true);
});

test("closing the card while saving does not invent success or resend the request", async () => {
  const page = await pageFixture(); page.state.saveGate = deferred();
  const pending = page.save(); await until(() => page.state.saves.length === 1);
  page.state.events.pagehide(); page.state.saveGate.resolve(); await pending; await page.save();
  assert.notEqual(page.status().dataset.state, "saved"); assert.equal(page.state.saves.length, 1);
});

test("missing host save support and failed ready handshake fail closed", async () => {
  const noSave = await pageFixture({ noSaveApi: true }); await noSave.save();
  assert.equal(noSave.state.saves.length, 0); assert.equal(noSave.state.reads, 0); assert.ok(noSave.status().textContent.includes("app/resources.write"));
  const notReady = await pageFixture({ readyError: new Error("PRIVATE_READY_SECRET") });
  assert.equal(notReady.state.calls.length, 0); assert.equal(notReady.elements.get("companion-save").disabled, true);
  assert.doesNotMatch(notReady.text(), /PRIVATE_READY_SECRET/);
});
