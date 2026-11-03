// 执行真实页面脚本，只替换 SDK 模块边界和所需 DOM；无浏览器依赖、无真实网络。
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { diagnose } from "../../sp-tasks/lib/diagnose.js";
import { toAppSdkError } from "../../sp-tasks/sdk/app-contract/sdk-error.js";

const source = await readFile(new URL("../../sp-tasks/ui/assets/settings.js", import.meta.url), "utf8");
const html = await readFile(new URL("../../sp-tasks/ui/settings.html", import.meta.url), "utf8");
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const zipBytes = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]);
const setupReport = (overrides = {}) => ({
  ok: true,
  app: { version: "0.7.0-fixture" },
  plugin: {
    available: true, name: "Hana 任务台桥接", id: "hana-sp-bridge", version: "0.3.0",
    downloadPath: "/bridge/plugin.zip", fileName: "hana-sp-bridge.zip", size: zipBytes.length,
    sha256: createHash("sha256").update(zipBytes).digest("hex"), protocolVersion: 1,
    minimumCompatibleVersion: "0.3.0", minSpVersion: "19.3.1",
  },
  bridge: { available: true, enabled: false, connected: false, running: false, pluginVersion: null, protocol: 1 },
  compatibility: { state: "disconnected", connectedVersion: null, requiredVersion: "0.3.0" },
  requirements: {
    nativeAvailable: true, nativeIdentity: "not-checked", platform: "win32",
    permissions: ["app/runtime.execute", "app/runtime.native", "app/runtime.network"],
  },
  capabilities: [
    { id: "tasks", label: "任务与计时", description: "基础接口提供任务和计时。", requires: "rest", available: true, status: "rest", tools: ["sp_tasks_create"] },
    { id: "projects", label: "项目管理", description: "配套扩展提供项目管理。", requires: "bridge", available: false, status: "needs_pairing", tools: ["sp_tasks_projects"] },
    { id: "settings", label: "SP 全局设置", description: "暂未提供此管理接口。", requires: "unsupported", available: false, status: "unsupported", tools: [] },
  ],
  ...overrides,
});

async function openPage(fetchImpl, { setupFetch = () => json(200, setupReport()), clipboard = async () => ({ written: true }), pick = async () => ({ resources: [{ kind: "local-file", path: "X:\\picked-folder", isDirectory: true }] }) } = {}) {
  let finished;
  const idle = new Promise((resolve) => { finished = resolve; });
  const settled = new Set();
  const downloads = [], blobs = [], revoked = [], clipboardWrites = [], picks = [], events = {};
  class Element {
    children = [];
    dataset = {};
    attributes = {};
    listeners = {};
    value = "";
    text = "";
    hidden = false;
    disabled = false;
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
    append(...children) { for (const child of children) child.parent = this; this.children.push(...children); }
    replaceChildren(...children) { this.text = ""; this.children = children; }
    setAttribute(key, value) {
      this.attributes[key] = value;
      if (["verdict", "bridge-setup"].includes(this.id) && key === "aria-busy" && value === "false") {
        settled.add(this.id);
        if (settled.size === 2) finished();
      }
    }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    focus() { this.focused = true; }
    select() { this.selected = true; }
    click() { downloads.push({ href: this.href, fileName: this.download }); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  }
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => {
    const element = new Element();
    element.id = id;
    return [id, element];
  }));
  const calls = [];
  const body = new Element();
  const context = vm.createContext({
    document: {
      body,
      getElementById: (id) => elements.get(id),
      createElement: () => new Element(),
    },
    Blob, crypto: webcrypto,
    URL: {
      createObjectURL: (blob) => { blobs.push(blob); return `blob:fixture-${blobs.length}`; },
      revokeObjectURL: (url) => revoked.push(url),
    },
    setTimeout: (callback) => { callback(); return 1; },
    addEventListener: (name, handler) => { events[name] = handler; },
    createHanaAppUiSdk: () => ({
      ready: async () => {},
      api: { fetch: async (path, init) => { calls.push({ path, init }); return path === "/bridge/setup" ? setupFetch(path, init) : fetchImpl(path, init); } },
      clipboard: { writeText: async (value) => { clipboardWrites.push(value); return clipboard(value); } },
      resources: {
        pick: async (...args) => { picks.push(args); return pick(...args); },
        saveFile: async () => { assert.fail("Hana forbids resource.saveFile in the settings slot"); },
      },
    }),
  });
  // 只移除 SDK import，脚本正文（包括自动检测、api 和渲染）按源码执行。
  vm.runInContext(source.replace(/^import .* from "\.\/sdk\.js";\r?\n/, ""), context, { filename: "settings.js" });
  await idle;
  return {
    elements, calls, downloads, blobs, revoked, clipboardWrites, picks, events, body,
    save: () => vm.runInContext("save()", context),
    useAutomaticToken: () => vm.runInContext("useAutomaticToken()", context),
    bridgeAction: (action) => vm.runInContext(`bridgeAction(${JSON.stringify(action)})`, context),
    copyPairingCode: () => vm.runInContext("copyPairingCode()", context),
    clearPairingCode: () => vm.runInContext("clearPairingCode()", context),
    exportPlugin: () => vm.runInContext("exportPlugin()", context),
    copyPluginPath: () => vm.runInContext("copyPluginPath()", context),
  };
}

test("安装步骤和主按钮直接可见，排障说明和助手引导收在折叠里且不新增链接或自动操作", async () => {
  const stack = [], nodes = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  // The VM fixture has no layout or native details behavior. Check semantic
  // containment here; the isolated real-browser fixture checks visibility.
  for (const token of html.matchAll(/<\/?([a-z][\w:-]*)\b([^>]*)>/gi)) {
    const tag = token[1].toLowerCase();
    if (token[0].startsWith("</")) {
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index >= 0) stack.length = index;
      continue;
    }
    const node = { tag, attributes: token[2], id: /\bid\s*=\s*["']([^"']+)["']/i.exec(token[2])?.[1], ancestors: [...stack] };
    nodes.push(node);
    if (!voidTags.has(tag) && !/\/\s*>$/.test(token[0])) stack.push(node);
  }
  const one = (id) => { const found = nodes.filter((node) => node.id === id); assert.equal(found.length, 1, id); return found[0]; };
  const steps = one("bridge-steps"), help = one("bridge-help"), guide = one("bridge-assistant-setup");
  assert.equal(steps.tag, "details"); assert.match(steps.attributes, /(?:^|\s)open(?:\s|=|$)/i, "Install steps start open");
  assert.equal(help.tag, "details"); assert.doesNotMatch(help.attributes, /(?:^|\s)open(?:\s|=|$)/i, "Troubleshooting starts folded");
  assert.ok(guide.ancestors.includes(help));
  for (const id of ["bridge-download", "bridge-pair", "bridge-copy", "bridge-hide", "bridge-code"]) assert.ok(one(id).ancestors.includes(steps), `${id} belongs to the install steps`);
  for (const id of ["bridge-refresh", "rerun"]) assert.ok(one(id).ancestors.some((node) => node.attributes.includes('class="tiles"')), `${id} sits in the status tiles`);
  const guideNodes = nodes.filter((node) => node === guide || node.ancestors.includes(guide));
  assert.ok(guideNodes.every((node) => !["a", "button", "input", "textarea", "form", "script"].includes(node.tag)));
  assert.ok(guideNodes.every((node) => !/\bon[a-z]+\s*=/i.test(node.attributes)));
  const externalUrls = [...html.matchAll(/\b(?:href|src)\s*=\s*["'](https?:[^"']+)["']/gi)].map((match) => match[1]);
  assert.deepEqual(externalUrls, ["https://super-productivity.com/"]);
  const page = await openPage((path) => {
    assert.equal(path, "/diagnose");
    return json(200, { ok: true, verdict: "Fixture connected", steps: [] });
  });
  assert.deepEqual(page.calls.map(({ path, init }) => ({ path, init })), [{ path: "/desktop-theme", init: undefined }, { path: "/diagnose", init: undefined }, { path: "/bridge/setup", init: undefined }]);
  assert.deepEqual(page.picks, []); assert.deepEqual(page.clipboardWrites, []); assert.deepEqual(page.downloads, []);
  assert.deepEqual(page.elements.get("bridge-assistant-setup").listeners, {});
  assert.doesNotMatch(source, /hana\.(?:chat|sessions|agents|messages)\b/);
});

test("桥接配对码只在明确点击后显示，刷新状态会清除凭据", async () => {
  let connected = false;
  const page = await openPage((path, init) => {
    if (path === "/diagnose") return json(200, { ok: true, verdict: "连接正常", steps: [] });
    if (path === "/bridge/pair") {
      assert.equal(init.method, "POST");
      connected = true;
      return json(200, { ok: true, pairingCode: "HANA-SP1.fixture-only", status: { enabled: true, connected: false, running: true } });
    }
    assert.fail(`Unexpected request ${path}`);
  }, { setupFetch: () => json(200, setupReport({ bridge: { enabled: connected, connected, running: connected, pluginVersion: connected ? "0.3.0" : null } })) });
  assert.deepEqual(page.calls.map((call) => call.path), ["/desktop-theme", "/diagnose", "/bridge/setup"]);
  await page.bridgeAction("pair");
  assert.equal(page.elements.get("bridge-code").value, "HANA-SP1.fixture-only");
  assert.equal(page.elements.get("bridge-code-field").hidden, false);
  await page.bridgeAction("status");
  assert.equal(page.elements.get("bridge-code").value, "");
  assert.equal(page.elements.get("bridge-code-field").hidden, true);
  assert.match(page.elements.get("bridge-status").textContent, /已连接/);
});

test("桥接错误不假报成功，不保留旧配对码且重新启用按钮", async () => {
  const page = await openPage((path) => path === "/diagnose"
    ? json(200, { ok: true, verdict: "连接正常", steps: [] })
    : json(500, { ok: false, error: "缺少托管服务权限" }));
  page.elements.get("bridge-code").value = "old-secret";
  await page.bridgeAction("pair");
  assert.equal(page.elements.get("bridge-code").value, "");
  assert.equal(page.elements.get("bridge-code-field").hidden, true);
  assert.equal(page.elements.get("bridge-status").dataset.fault, "true");
  assert.match(page.elements.get("bridge-status").textContent, /缺少托管服务权限/);
  for (const id of ["bridge-pair", "bridge-refresh", "bridge-disable"]) assert.equal(page.elements.get(id).disabled, false);
});

test("断开桥接使用POST且无秘密状态不能显示连接成功", async () => {
  let invalid = false;
  const page = await openPage((path, init) => {
    if (path === "/diagnose") return json(200, { ok: true, verdict: "连接正常", steps: [] });
    if (path === "/bridge/disable") {
      assert.equal(init.method, "POST");
      return json(200, { ok: true, bridge: { enabled: false, connected: false } });
    }
    assert.fail(`Unexpected request ${path}`);
  }, { setupFetch: () => json(200, setupReport(invalid ? { bridge: {} } : {})) });
  await page.bridgeAction("disable");
  assert.match(page.elements.get("bridge-status").textContent, /已停用|还没有启用/);
  invalid = true;
  await page.bridgeAction("status");
  assert.equal(page.elements.get("bridge-status").dataset.fault, "true");
});

for (const [name, status, expected] of [
  ["宿主接口不支持", { available: false, enabled: false, connected: false }, /升级 Hana/],
  ["认证故障", { available: true, enabled: true, connected: false, running: true, error: { code: "SP_BRIDGE_UNAUTHORIZED", message: "Credential rejected." } }, /SP_BRIDGE_UNAUTHORIZED/],
  ["停止尚未完成", { available: true, enabled: false, connected: false, running: true, stopping: true }, /停止尚未确认/],
]) {
  test(`桥接明确呈现${name}，不误报等待连接`, async () => {
    const page = await openPage((path) => path === "/diagnose"
      ? json(200, { ok: true, verdict: "连接正常", steps: [] })
      : assert.fail(`Unexpected request ${path}`), { setupFetch: () => json(200, setupReport({ bridge: status })) });
    await page.bridgeAction("status");
    assert.equal(page.elements.get("bridge-status").dataset.fault, "true");
    assert.match(page.elements.get("bridge-status").textContent, expected);
    assert.doesNotMatch(page.elements.get("bridge-status").textContent, /等待 SP 插件/);
  });
}

const healthyDiagnosis = (path) => {
  assert.equal(path, "/diagnose");
  return json(200, { ok: true, verdict: "连接正常", steps: [] });
};

test("扩展包保存不再占用卡片中心，设置页保留目录选择与文件写授权", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../sp-tasks/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.contributes.cards, undefined, "No app card is contributed");
  assert.equal(manifest.capabilities.filter((capability) => capability === "app/resources.write").length, 1);
  assert.match(html, /id="bridge-download"/);
  assert.match(html, /id="bridge-copy-path"/);
  assert.match(html, /app\/resources\.write/);
  await assert.rejects(readFile(new URL("../../sp-tasks/ui/companion-download.html", import.meta.url), "utf8"), { code: "ENOENT" });
});

test("打开设置只读取安装信息与诊断，不启用服务或传递令牌", async () => {
  const page = await openPage(healthyDiagnosis);
  assert.deepEqual(page.calls.map(({ path }) => path), ["/desktop-theme", "/diagnose", "/bridge/setup"]);
  assert.ok(page.calls.every(({ init }) => init === undefined));
  assert.equal(page.clipboardWrites.length, 0);
  assert.equal(page.picks.length, 0);
  assert.equal(page.elements.get("bridge-code").value, "");
  assert.equal(page.elements.get("bridge-code-field").hidden, true);
  assert.match(page.elements.get("bridge-package-info").textContent, /0\.3\.0.*KB.*19\.3\.1/);
  assert.equal(page.elements.get("bridge-download").disabled, false);
  assert.match(page.elements.get("bridge-native-status").textContent, /不代表运行权限已授予.*不代表 native 身份已初始化/);
  assert.match(page.elements.get("bridge-permissions").textContent, /app\/runtime\.execute.*app\/runtime\.native.*app\/runtime\.network/);
  assert.doesNotMatch(html + source, /[CD]:[\\/]Users[\\/]|Ganlin|MyDocuments/);
  assert.match(html, /不向 SP 传送 Hana 令牌/);
  assert.match(html, /无法检测，也不执行初始化/);
});

test("刷新后开关跟着真实设置走，不只改状态文字", async () => {
  const desktop = (follow) => (path) => {
    if (path === "/diagnose") return healthyDiagnosis(path);
    if (path === "/desktop-theme") return json(200, { ok: true, found: true, follow, hanaTheme: "coral", skin: "coral", skinName: "珊瑚", active: follow, error: null });
    assert.fail(`Unexpected request ${path}`);
  };
  const on = await openPage(desktop(true));
  assert.equal(on.elements.get("follow-desktop-theme").checked, true);
  assert.match(on.elements.get("desktop-theme-status").textContent, /珊瑚/);
  const off = await openPage(desktop(false));
  assert.equal(off.elements.get("follow-desktop-theme").checked, false);
  assert.match(off.elements.get("desktop-theme-status").textContent, /没有跟随/);
});

test("动态能力按REST检测和扩展连接分别标注，不依赖固定工具数量", async () => {
  const report = setupReport();
  report.capabilities.push({ id: "new-feature", label: "新增能力", description: "仅用于动态渲染验证。", requires: "bridge", available: false, status: "needs_upgrade", tools: ["sp_tasks_new"] });
  const page = await openPage(() => json(200, { ok: false, verdict: "接口未连接", steps: [] }), { setupFetch: () => json(200, report) });
  const rows = page.elements.get("bridge-capabilities").children;
  assert.equal(rows.length, 4);
  assert.match(rows[0].textContent, /需连接本地接口/);
  assert.match(rows[1].textContent, /需连接扩展/);
  assert.match(rows[2].textContent, /SP 接口限制/);
  assert.match(rows[3].textContent, /新增能力.*需更新扩展/);
  assert.ok(rows.every((row) => row.children[1].dataset.ready === "false"));
});

test("能力列表区分尚未实现、公开接口限制与SP持久化缺陷", async () => {
  const report = setupReport();
  report.capabilities.push(
    { id: "pending", label: "其他偏好", description: "有公开配置入口，尚未接入。", requires: "not_implemented", available: false, status: "not_implemented", tools: [] },
    { id: "upstream", label: "创建计数器", description: "SP的创建记录不完整。", requires: "unsupported", blocker: "upstream_bug", available: false, status: "unsupported", tools: [] },
  );
  const page = await openPage(() => json(200, { ok: true, verdict: "接口正常", steps: [] }), { setupFetch: () => json(200, report) });
  const rows = page.elements.get("bridge-capabilities").children;
  assert.match(rows[2].textContent, /SP 接口限制/);
  assert.match(rows[3].textContent, /尚未实现/);
  assert.match(rows[4].textContent, /SP 持久化缺陷/);
  assert.ok(rows.slice(2).every((row) => row.children[1].dataset.ready === "false"));
});

test("连接与兼容检查通过才显示对应扩展能力可用，停用后立即撤回", async () => {
  const report = setupReport();
  report.bridge = { enabled: true, connected: true, running: true, accepting: true, protocol: 1, pluginVersion: "0.3.0" };
  report.compatibility = { state: "compatible", connectedVersion: "0.3.0", requiredVersion: "0.3.0" };
  report.capabilities[1].available = true;
  report.capabilities[1].status = "ready";
  const page = await openPage((path, init) => {
    if (path === "/diagnose") return healthyDiagnosis(path);
    assert.equal(path, "/bridge/disable");
    assert.equal(init.method, "POST");
    report.bridge.enabled = false;
    report.bridge.connected = false;
    report.compatibility.state = "disconnected";
    return json(200, { ok: true, bridge: report.bridge });
  }, { setupFetch: () => json(200, report) });
  assert.equal(page.elements.get("bridge-compatibility").hidden, true, "A compatible extension needs no version notice");
  assert.equal(page.elements.get("bridge-overview").dataset.state, "ok");
  assert.match(page.elements.get("bridge-summary").textContent, /已连接 · 0\.3\.0/);
  assert.equal(page.elements.get("bridge-steps").open, false, "Install steps fold away once connected");
  assert.equal(page.elements.get("bridge-connected-actions").hidden, false);
  assert.equal(page.elements.get("bridge-capabilities").children[0].children[1].dataset.ready, "true");
  assert.equal(page.elements.get("bridge-capabilities").children[1].children[1].dataset.ready, "true");
  await page.bridgeAction("disable");
  assert.equal(page.elements.get("bridge-capabilities").children[1].children[1].dataset.ready, "false");
  assert.equal(page.elements.get("bridge-capabilities").children[0].children[1].dataset.ready, "true");
});

for (const [state, text] of [["outdated", /0\.2\.0 过旧.*需要 0\.3\.0.*更新/], ["unknown", /无法确认.*版本/], ["unavailable", /宿主或扩展信息暂不可用/]]) {
  test(`兼容性${state}给出操作提示而非全部可用`, async () => {
    const report = setupReport({ compatibility: { state, connectedVersion: "0.2.0", requiredVersion: "0.3.0" } });
    report.capabilities[1].status = "needs_upgrade";
    const page = await openPage(healthyDiagnosis, { setupFetch: () => json(200, report) });
    assert.match(page.elements.get("bridge-compatibility").textContent, text);
    assert.equal(page.elements.get("bridge-compatibility").dataset.fault, "true");
    assert.equal(page.elements.get("bridge-capabilities").children[1].children[1].dataset.ready, "false");
  });
}

test("仍在启动显示为等待而非故障，配对时撞上启动也不报错", async () => {
  const starting = { available: true, enabled: true, connected: false, running: false, runtimeState: "starting", protocol: 1, error: { code: "SP_BRIDGE_STARTING", message: "桥接仍在启动。" } };
  const page = await openPage((path) => path === "/diagnose" ? healthyDiagnosis(path)
    : json(500, { ok: false, error: "桥接仍在启动。", code: "SP_BRIDGE_STARTING" }), { setupFetch: () => json(200, setupReport({ bridge: starting })) });
  assert.equal(page.elements.get("bridge-overview").dataset.state, "wait");
  assert.equal(page.elements.get("bridge-status").dataset.fault, "false");
  assert.notEqual(page.elements.get("bridge-help").open, true);
  await page.bridgeAction("pair");
  assert.equal(page.elements.get("bridge-overview").dataset.state, "wait");
  assert.equal(page.elements.get("bridge-status").dataset.fault, "false");
  assert.match(page.elements.get("bridge-status").textContent, /仍在启动.*重新显示配对码/);
  assert.equal(page.elements.get("bridge-code-field").hidden, true);
});

test("已连接的旧版扩展只提示可更新，不报故障", async () => {
  const report = setupReport({
    bridge: { available: true, enabled: true, connected: true, running: true, accepting: true, protocol: 1, pluginVersion: "0.5.0" },
    compatibility: { state: "compatible", connectedVersion: "0.5.0", requiredVersion: "0.5.0", latestVersion: "0.6.0", updateAvailable: true },
  });
  const page = await openPage(healthyDiagnosis, { setupFetch: () => json(200, report) });
  assert.equal(page.elements.get("bridge-overview").dataset.state, "ok");
  assert.equal(page.elements.get("bridge-compatibility").hidden, false);
  assert.equal(page.elements.get("bridge-compatibility").dataset.fault, "false");
  assert.match(page.elements.get("bridge-compatibility").textContent, /可以更新到 0\.6\.0/);
  assert.equal(page.elements.get("bridge-steps").open, false);
});

test("缺少native接口阻止配对按钮，不把Windows身份误报为已初始化", async () => {
  const report = setupReport();
  report.requirements.nativeAvailable = false;
  report.bridge.available = false;
  const page = await openPage(healthyDiagnosis, { setupFetch: () => json(200, report) });
  assert.equal(page.elements.get("bridge-pair").disabled, true);
  assert.equal(page.elements.get("bridge-refresh").disabled, false);
  assert.equal(page.elements.get("bridge-native-help").hidden, false);
  assert.match(page.elements.get("bridge-native-status").textContent, /没有提供.*升级 Hana/);
  assert.equal(page.elements.get("bridge-overview").dataset.state, "fault");
  assert.equal(page.elements.get("bridge-capabilities").children[0].children[1].dataset.ready, "true");
});

test("状态检查失败优先展示错误，不把native接口未确认解释成Hana版本过旧", async () => {
  const report = setupReport();
  report.requirements.nativeAvailable = false;
  report.bridge.available = false;
  report.bridge.error = { code: "SP_BRIDGE_STATUS_UNAVAILABLE", message: "无法检查服务状态。" };
  const page = await openPage(healthyDiagnosis, { setupFetch: () => json(200, report) });
  assert.match(page.elements.get("bridge-status").textContent, /SP_BRIDGE_STATUS_UNAVAILABLE.*无法检查服务状态/);
  assert.match(page.elements.get("bridge-native-status").textContent, /暂时无法确认.*错误/);
  assert.equal(page.elements.get("bridge-help").open, true, "A bridge fault opens troubleshooting");
  assert.doesNotMatch(page.elements.get("bridge-status").textContent + page.elements.get("bridge-native-status").textContent, /升级 Hana/);
  assert.equal(page.elements.get("bridge-pair").disabled, false, "状态读取失败仍可明确重试启用，不等于宿主已证实不支持");
});

test("非Windows宿主不显示只适用于Windows的身份操作说明", async () => {
  const report = setupReport();
  report.requirements.platform = "darwin";
  const page = await openPage(healthyDiagnosis, { setupFetch: () => json(200, report) });
  assert.equal(page.elements.get("bridge-native-help").hidden, true);
});

test("缺少随包ZIP时禁用下载，保持已知能力和诊断可读", async () => {
  const report = setupReport({ plugin: { available: false, version: null, downloadPath: "/bridge/plugin.zip", protocolVersion: 1 } });
  const page = await openPage(healthyDiagnosis, { setupFetch: () => json(200, report) });
  assert.equal(page.elements.get("bridge-download").disabled, true);
  assert.match(page.elements.get("bridge-package-info").textContent, /没有附带可用的扩展包.*正常更新/);
  const before = page.calls.length;
  await page.exportPlugin();
  assert.equal(page.calls.length, before);
  assert.equal(page.picks.length, 0);
  assert.equal(page.elements.get("bridge-capabilities").children.length, 3);
});

for (const [name, mutate] of [
  ["任意下载URL", (report) => { report.plugin.downloadPath = "https://example.invalid/token"; }],
  ["带路径文件名", (report) => { report.plugin.fileName = "../plugin.zip"; }],
  ["缺失安装包尺寸", (report) => { delete report.plugin.size; }],
  ["无效包哈希", (report) => { report.plugin.sha256 = "not-a-hash"; }],
  ["缺失bridge状态", (report) => { report.bridge = {}; }],
  ["损坏能力清单", (report) => { report.capabilities[0].available = "true"; }],
]) {
  test(`安装信息拒绝${name}并保留基础检测结果`, async () => {
    const report = setupReport();
    mutate(report);
    const page = await openPage(healthyDiagnosis, { setupFetch: () => json(200, report) });
    assert.equal(page.elements.get("verdict-text").textContent, "连接正常");
    assert.equal(page.elements.get("bridge-status").dataset.fault, "true");
    assert.equal(page.elements.get("bridge-download").disabled, true);
    assert.equal(page.elements.get("bridge-capabilities").children.length, 0);
    assert.equal(page.elements.get("bridge-refresh").disabled, false);
  });
}

test("复制只通过宿主SDK写入明确展示的配对码，隐藏后不能再复制", async () => {
  const page = await openPage((path) => path === "/diagnose" ? healthyDiagnosis(path)
    : json(200, { ok: true, pairingCode: "HANA-SP1.fixture-only", status: { enabled: true, connected: false, running: true } }));
  await page.copyPairingCode();
  assert.equal(page.clipboardWrites.length, 0);
  await page.bridgeAction("pair");
  assert.equal(page.elements.get("bridge-code").value, "HANA-SP1.fixture-only", "配对后只读setup刷新不能清码");
  await page.copyPairingCode();
  assert.deepEqual(page.clipboardWrites, ["HANA-SP1.fixture-only"]);
  assert.match(page.elements.get("bridge-copy-status").textContent, /已复制/);
  assert.ok(page.calls.every(({ init }) => !init?.body?.includes("HANA-SP1")));
  page.clearPairingCode();
  await page.copyPairingCode();
  assert.equal(page.clipboardWrites.length, 1);
  assert.equal(page.elements.get("bridge-code-field").hidden, true);
  assert.equal(page.elements.get("bridge-code").value, "");
});

for (const [name, clipboard] of [
  ["权限拒绝", async () => { throw new Error("Denied secret=HANA-SP1.fixture-only"); }],
  ["未确认写入", async () => ({ written: false })],
]) {
  test(`复制${name}时选中供手动复制且不在提示中泄漏内容`, async () => {
    const page = await openPage((path) => path === "/diagnose" ? healthyDiagnosis(path)
      : json(200, { ok: true, pairingCode: "HANA-SP1.fixture-only", status: { enabled: true, connected: false, running: true } }), { clipboard });
    await page.bridgeAction("pair");
    await page.copyPairingCode();
    assert.equal(page.elements.get("bridge-code").selected, true);
    assert.equal(page.elements.get("bridge-code").focused, true);
    assert.match(page.elements.get("bridge-copy-status").textContent, /手动复制.*剪贴板写入授权/);
    assert.doesNotMatch(page.elements.get("bridge-copy-status").textContent, /HANA-SP1/);
    assert.equal(page.elements.get("bridge-copy").disabled, false);
  });
}

test("离开页面清除显示中的配对码", async () => {
  const page = await openPage(healthyDiagnosis);
  page.elements.get("bridge-code").value = "HANA-SP1.fixture-only";
  page.elements.get("bridge-code-field").hidden = false;
  page.events.pagehide();
  assert.equal(page.elements.get("bridge-code").value, "");
  assert.equal(page.elements.get("bridge-code-field").hidden, true);
});

test("配对成功后setup刷新失败保留刚生成的码但不误报能力可用", async () => {
  let reads = 0;
  const page = await openPage((path) => path === "/diagnose" ? healthyDiagnosis(path)
    : json(200, { ok: true, pairingCode: "HANA-SP1.fixture-only", status: { enabled: true, connected: false, running: true } }), {
    setupFetch: () => ++reads === 1 ? json(200, setupReport()) : json(503, { ok: false, error: "刷新暂不可用" }),
  });
  await page.bridgeAction("pair");
  assert.equal(page.elements.get("bridge-code").value, "HANA-SP1.fixture-only");
  assert.equal(page.elements.get("bridge-code-field").hidden, false);
  assert.match(page.elements.get("bridge-status").textContent, /刷新暂不可用/);
  assert.equal(page.elements.get("bridge-capabilities").children.length, 0);
});

test("设置页选文件夹后由后台写扩展包，不打开卡片也不调用受限 saveFile", async () => {
  const page = await openPage((path, init) => {
    assert.equal(path, "/bridge/export");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { dir: "X:\\picked-folder" });
    return json(200, { ok: true, path: "X:\\picked-folder\\hana-sp-bridge.zip", fileName: "hana-sp-bridge.zip", size: 8, sha256: "a".repeat(64) });
  });
  await page.exportPlugin();
  assert.equal(page.picks.length, 1);
  assert.equal(page.picks[0][0].mode, "directory");
  assert.equal(page.elements.get("bridge-download-status").dataset.fault, "false");
  assert.match(page.elements.get("bridge-download-status").textContent, /已保存到 X:\\picked-folder\\hana-sp-bridge\.zip/);
  assert.equal(page.elements.get("bridge-copy-path").hidden, false);
  assert.equal(page.downloads.length, 0);
  assert.equal(page.blobs.length, 0);
  assert.doesNotMatch(source, /cards\.open|resources\.saveFile\(|createObjectURL|link\.click/);
  assert.ok(html.includes("app/resources.write"));
});

test("取消文件夹选择不写文件，也不假报保存", async () => {
  const page = await openPage(healthyDiagnosis, { pick: async () => ({ resources: [] }) });
  await page.exportPlugin();
  assert.equal(page.calls.filter(({ path }) => path === "/bridge/export").length, 0);
  assert.match(page.elements.get("bridge-download-status").textContent, /已取消.*没有保存/);
  assert.equal(page.elements.get("bridge-copy-path").hidden, true);
});

for (const [name, fetchImpl, expected] of [
  ["写文件失败", () => json(500, { ok: false, error: "写不了扩展包：EACCES" }), /没有保存.*EACCES/],
  ["写权限被拒绝", () => json(500, { ok: false, error: "Denied", code: "CAPABILITY_DENIED" }), /没有保存.*app\/resources\.write/],
]) {
  test(`${name}如实提示，不清成已保存`, async () => {
    const page = await openPage((path) => {
      assert.equal(path, "/bridge/export");
      return fetchImpl();
    });
    await page.exportPlugin();
    assert.equal(page.elements.get("bridge-download-status").dataset.fault, "true");
    assert.match(page.elements.get("bridge-download-status").textContent, expected);
    assert.doesNotMatch(page.elements.get("bridge-download-status").textContent, /已保存到/);
    assert.equal(page.elements.get("bridge-copy-path").hidden, true);
    assert.equal(page.elements.get("bridge-download").disabled, false);
  });
}

test("连续点击只发起一次选择，等待期间禁用按钮", async () => {
  let resolvePick;
  const page = await openPage(healthyDiagnosis, {
    pick: () => new Promise((resolve) => { resolvePick = resolve; }),
  });
  const pending = page.exportPlugin();
  assert.equal(page.elements.get("bridge-download").disabled, true);
  await page.exportPlugin();
  assert.equal(page.picks.length, 1);
  resolvePick({ resources: [] });
  await pending;
  assert.equal(page.elements.get("bridge-download").disabled, false);
});

test("保存后复制完整路径，便于粘到 SP 的文件选择框", async () => {
  const page = await openPage((path) => {
    assert.equal(path, "/bridge/export");
    return json(200, { ok: true, path: "X:\\picked-folder\\hana-sp-bridge.zip" });
  });
  await page.exportPlugin();
  await page.copyPluginPath();
  assert.deepEqual(page.clipboardWrites, ["X:\\picked-folder\\hana-sp-bridge.zip"]);
  assert.match(page.elements.get("bridge-download-status").textContent, /路径已复制/);
});


async function diagnosticReport(fetchImpl) {
  return diagnose({
    resources: { read: async ({ path }) => {
      if (path.endsWith("\\Preferences")) return "{}";
      throw new Error("禁止读取测试范围外的文件");
    } },
    network: { fetch: fetchImpl },
  }, { baseUrl: "http://sp.invalid", accessToken: "test-token", tokenSource: "settings" }, { roots: ["X:\\test"] });
}

const healthy = (url) => json(200, {
  ok: true,
  data: String(url).endsWith("/health") ? { server: "up", rendererReady: true } : [],
});
const scenarios = [
  { name: "连接正常", fetch: healthy, ok: true },
  {
    name: "API 关闭", ok: false, step: "health", next: /本地 REST API.*打开/,
    fetch: () => json(503, { ok: false, error: { code: "API_DISABLED", message: "API is disabled" } }),
  },
  {
    name: "health 拒绝 token", ok: false, step: "health", next: /令牌/,
    fetch: () => json(401, { ok: false, error: { code: "UNAUTHORIZED", message: "bad token" } }),
  },
  {
    name: "tasks 拒绝 token", ok: false, step: "read", next: /令牌/,
    fetch: (url) => url.endsWith("/health") ? healthy(url) : json(401, { ok: false, error: { code: "UNAUTHORIZED", message: "bad token" } }),
  },
  {
    name: "宿主网络策略拒绝", ok: false, step: "health", next: /白名单|权限/,
    fetch: () => { throw new Error("PLUGIN_NETWORK_NOT_DECLARED: host not allowed"); },
  },
  {
    name: "tasks 被网络策略拒绝", ok: false, step: "read", next: /白名单|权限/,
    fetch: (url) => {
      if (url.endsWith("/health")) return healthy(url);
      throw new Error("PLUGIN_NETWORK_HOST: not allowed");
    },
  },
  {
    name: "tasks 报 API 关闭", ok: false, step: "read", next: /本地 REST API.*打开/,
    fetch: (url) => url.endsWith("/health") ? healthy(url) : json(503, { ok: false, error: { code: "API_DISABLED", message: "API is disabled" } }),
  },
];

// 宿主错误码不必出现在 message 中；通过真实 SDK 错误适配器后仍应被识别。
for (const [code, message] of [
  ["PLUGIN_NETWORK_HOST_NOT_ALLOWED", 'Plugin network.fetch host "[::1]" is not declared in manifest network.allowedHosts'],
  ["PLUGIN_NETWORK_NOT_DECLARED", 'App network.fetch requires a top-level manifest "network" declaration'],
]) {
  for (const endpoint of ["/health", "/tasks"]) {
    scenarios.push({
      name: `${endpoint} 结构化错误码 ${code}`, ok: false,
      step: endpoint === "/health" ? "health" : "read", next: /白名单|权限/,
      fetch: (url) => {
        if (!url.endsWith(endpoint)) return healthy(url);
        throw toAppSdkError(Object.assign(new Error(message), { code }), "network.fetch");
      },
    });
  }
}

for (const scenario of scenarios) {
  test(`页面保留诊断结果和步骤：${scenario.name}`, { timeout: 3000 }, async () => {
    const report = await diagnosticReport(scenario.fetch);
    const page = await openPage((path) => {
      if (path === "/diagnose") return json(200, report);
      assert.equal(path, "/config");
      return json(200, { ok: true, baseUrl: "http://127.0.0.1:3876", hasToken: true, tokenSource: "settings" });
    });
    const el = (id) => page.elements.get(id);
    assert.equal(report.ok, scenario.ok);
    assert.ok(el("verdict-text").textContent.startsWith(report.verdict), "不能把正常故障报告降成请求失败");
    assert.equal(el("steps-fold").open, !scenario.ok, "Details stay folded on success and open on failure");
    assert.equal(el("verdict").dataset.state, scenario.ok ? "ok" : "fault");
    assert.equal(el("steps").children.length, report.steps.length);
    for (const [index, step] of report.steps.entries()) {
      const row = el("steps").children[index];
      assert.ok(row.textContent.includes(step.label));
      assert.ok(row.textContent.includes(step.detail));
      if (!step.ok && step.next) assert.ok(row.textContent.includes(step.next));
    }
    if (scenario.step) {
      const step = report.steps.find((item) => item.id === scenario.step);
      assert.equal(step.ok, false);
      assert.match(step.next, scenario.next, "处理建议必须针对具体故障");
    }
    assert.equal(el("manual").hidden, scenario.ok);
    assert.equal(el("install-help").hidden, true);
    assert.equal(el("rerun").disabled, false);
    assert.equal(el("save").disabled, false);
    assert.equal(el("verdict").attributes["aria-busy"], "false");
  });
}

for (const [name, fetchImpl, detail] of [
  ["网络请求抛错", () => { throw new Error("host unavailable"); }, /host unavailable/],
  ["HTTP 500", () => json(500, { ok: false, error: "route failed" }), /route failed/],
  ["HTTP 200 错误信封", () => json(200, { ok: false, error: "diagnose unavailable" }), /diagnose unavailable/],
  ["非法 JSON", () => new Response("<html>error</html>"), /JSON|响应/],
  ["缺失诊断步骤", () => json(200, { ok: false, verdict: "broken" }), /响应|诊断/],
]) {
  test(`页面单独呈现请求失败：${name}`, { timeout: 3000 }, async () => {
    const { elements } = await openPage(fetchImpl);
    assert.equal(elements.get("verdict-text").textContent, "检测没跑完");
    assert.match(elements.get("steps").textContent, detail);
    assert.match(elements.get("steps").textContent, /重新检测/);
    assert.equal(elements.get("manual").hidden, false);
    assert.equal(elements.get("rerun").disabled, false);
    assert.equal(elements.get("save").disabled, false);
  });
}

test("配置保存的 ok:false 仍须报错，不能显示保存成功", { timeout: 3000 }, async () => {
  const page = await openPage((path, init) => {
    if (path === "/diagnose") return json(200, { ok: true, verdict: "连接正常", steps: [] });
    assert.equal(path, "/config");
    assert.equal(init.method, "POST");
    return json(200, { ok: false, error: "settings rejected" });
  });
  page.elements.get("baseUrl").value = "http://127.0.0.1:1234";
  await page.save();
  assert.equal(page.elements.get("save-status").dataset.fault, "true");
  assert.match(page.elements.get("save-status").textContent, /settings rejected/);
  assert.equal(page.calls.filter((call) => call.path === "/diagnose").length, 1, "保存失败不能继续报告重检成功");
});

test("接口可用但目录未定位时显示正常，不提示重装或令牌失败", { timeout: 3000 }, async () => {
  const report = await diagnose({
    resources: { read: async () => { throw new Error("ENOENT"); } },
    network: { fetch: healthy },
  }, { baseUrl: "http://sp.invalid", accessToken: "test-token", tokenSource: "settings" }, { roots: ["X:\\portable"] });
  const page = await openPage((path) => {
    assert.equal(path, "/diagnose");
    return json(200, report);
  });
  assert.equal(page.elements.get("verdict-text").textContent, "连接正常 · 当前 0 条任务 · " + report.steps.find((step) => step.id === "health").detail);
  assert.equal(page.elements.get("install-help").hidden, true);
  assert.equal(page.elements.get("manual").hidden, true);
  assert.equal(page.elements.get("steps").children[0].dataset.ok, "info");
});

test("明确切回自动令牌只清除手填值，不覆盖地址，并重新检测", { timeout: 3000 }, async () => {
  let switched = false;
  const page = await openPage((path, init) => {
    if (path === "/diagnose") return json(200, { ok: switched, verdict: switched ? "连接正常" : "令牌无效", steps: [] });
    assert.equal(path, "/config");
    if (init?.method === "POST") {
      assert.deepEqual(JSON.parse(init.body), { accessToken: "" });
      switched = true;
      return json(200, { ok: true });
    }
    return json(200, { ok: true, baseUrl: "http://127.0.0.1:3876", hasToken: true, tokenSource: "settings" });
  });
  page.elements.get("baseUrl").value = "http://127.0.0.1:9999";
  page.elements.get("accessToken").value = "unsaved-token";
  await page.useAutomaticToken();
  assert.equal(switched, true);
  assert.equal(page.elements.get("accessToken").value, "");
  assert.equal(page.elements.get("verdict-text").textContent, "连接正常");
  assert.equal(page.calls.filter((call) => call.path === "/diagnose").length, 2);
});

test("普通空令牌保存仍保留已配置的令牌", { timeout: 3000 }, async () => {
  let saved;
  const page = await openPage((path, init) => {
    if (path === "/diagnose") return json(200, { ok: true, verdict: "连接正常", steps: [] });
    assert.equal(path, "/config");
    saved = JSON.parse(init.body);
    return json(200, { ok: true });
  });
  page.elements.get("baseUrl").value = "http://127.0.0.1:1234";
  page.elements.get("accessToken").value = "";
  await page.save();
  assert.deepEqual(saved, { baseUrl: "http://127.0.0.1:1234" });
});
