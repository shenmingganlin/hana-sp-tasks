import { createHanaAppUiSdk } from "./sdk.js";

const hana = createHanaAppUiSdk({ followHostTheme: true });
void hana.ready();

const $ = (id) => document.getElementById(id);

const verdict = $("verdict");
const verdictText = $("verdict-text");
const rerun = $("rerun");
const stepsFold = $("steps-fold");
const stepsList = $("steps");
const manual = $("manual");
const installHelp = $("install-help");
const baseUrlInput = $("baseUrl");
const tokenInput = $("accessToken");
const saveBtn = $("save");
const saveStatus = $("save-status");
const tokenHint = $("token-hint");
const autoTokenBtn = $("use-auto-token");
const bridgeOverview = $("bridge-overview");
const bridgeSummary = $("bridge-summary");
const bridgeStatus = $("bridge-status");
const bridgeCode = $("bridge-code");
const bridgeCodeField = $("bridge-code-field");
const bridgeButtons = [$("bridge-refresh"), $("bridge-pair"), $("bridge-disable")];
const bridgeDownload = $("bridge-download");
const bridgeDownloadStatus = $("bridge-download-status");
const bridgeCopyPath = $("bridge-copy-path");
const bridgeCopyStatus = $("bridge-copy-status");
let bridgeBusy = false;
let bridgeSetup = null;
let exportBusy = false;
let savedPluginPath = "";
let copyBusy = false;
let restConnected = null;
const followDesktop = $("follow-desktop-theme");
const desktopStatus = $("desktop-theme-status");
let desktopBusy = false;
const DESKTOP_CARDS_URL = "https://github.com/shenmingganlin/sp-desktop-cards/releases/latest";
const downloadDesktopCards = $("download-desktop-cards");
const copyDesktopCardsButton = $("copy-desktop-cards-link");
const desktopCardsStatus = $("desktop-cards-status");
let desktopCardsBusy = false;

let busy = false;

async function api(path, init) {
  const response = await hana.api.fetch(path, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  // diagnose 的 ok 是诊断结论，不是路由是否执行成功；配置接口仍按错误信封处理。
  if (!response.ok || (body?.ok === false && path !== "/diagnose")) {
    const detail = typeof body?.error === "string" ? body.error : typeof body?.error?.message === "string" ? body.error.message : typeof body?.message === "string" ? body.message : "";
    throw Object.assign(new Error(detail || `接口返回 ${response.status}`), typeof body?.code === "string" ? { code: body.code } : {});
  }
  if (path === "/diagnose" &&
      (typeof body?.ok !== "boolean" || typeof body?.verdict !== "string" || !Array.isArray(body?.steps))) {
    throw new Error(typeof body?.error === "string" ? body.error : "诊断响应格式不正确：需要 ok、verdict 和 steps。");
  }
  return body;
}

function renderDesktopTheme(state) {
  // 勾选状态必须跟着真实设置走：页面刷新后只看状态文字、开关却回弹，会让人以为没保存。
  followDesktop.checked = state.follow === true;
  desktopStatus.dataset.fault = String(!!state.error);
  if (!state.found) {
    desktopStatus.textContent = "没找到本机的「SP 桌面卡片」。装好后打开一次，这里就能认出来。";
    return;
  }
  if (state.error) {
    desktopStatus.textContent = state.error;
    return;
  }
  if (!state.follow) {
    desktopStatus.textContent = "没有跟随，桌面卡片用自己的皮肤。";
    return;
  }
  const skin = state.skinName || state.skin || "当前皮肤";
  desktopStatus.textContent = `正在跟随 Hana 的「${skin}」主题。`;
}

async function loadDesktopTheme() {
  try {
    renderDesktopTheme(await api("/desktop-theme"));
  } catch (error) {
    desktopStatus.dataset.fault = "true";
    desktopStatus.textContent = `读取失败：${error.message}`;
  }
}

async function saveDesktopTheme() {
  if (desktopBusy) return;
  desktopBusy = true;
  followDesktop.disabled = true;
  try {
    const state = await api("/desktop-theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ follow: followDesktop.checked }),
    });
    renderDesktopTheme(state);
  } catch (error) {
    followDesktop.checked = !followDesktop.checked;
    desktopStatus.dataset.fault = "true";
    desktopStatus.textContent = `没保存成功：${error.message}`;
  } finally {
    desktopBusy = false;
    followDesktop.disabled = false;
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* 一项一行：标记、名称、结果。失败必须带「下一步去做什么」，否则这条诊断没有用。 */
function renderSteps(steps) {
  stepsList.replaceChildren();
  for (const step of steps ?? []) {
    const li = element("li", "step");
    const informational = step.optional === true && step.ok !== true;
    li.dataset.ok = informational ? "info" : String(step.ok === true);
    const mark = element("span", "step-mark", informational ? "i" : step.ok ? "✓" : "✕");
    mark.setAttribute("aria-hidden", "true");
    li.append(mark, element("span", "step-label", step.label ?? step.id ?? ""), element("span", "step-detail", step.detail ?? ""));
    if (step.ok !== true && step.next) li.append(element("p", informational ? "step-hint" : "step-next", step.next));
    // 试过哪些路径只放折叠里：默认不吵，排查时要看得到。
    if (Array.isArray(step.tried) && step.tried.length) {
      const details = element("details", "step-tried");
      const list = element("ul", "");
      for (const line of step.tried) list.append(element("li", "", line));
      details.append(element("summary", "", `试过 ${step.tried.length} 个位置`), list);
      li.append(details);
    }
    stepsList.append(li);
  }
}

function setVerdict(text, state) {
  verdictText.textContent = text;
  verdict.dataset.state = state;
}

async function runDiagnose() {
  if (busy) return;
  busy = true;
  rerun.disabled = true;
  saveBtn.disabled = true;
  if (autoTokenBtn) autoTokenBtn.disabled = true;
  verdict.setAttribute("aria-busy", "true");
  setVerdict("正在检测", "");
  restConnected = null;
  renderBridgeCapabilities();
  try {
    const result = await api("/diagnose");
    const steps = result.steps ?? [];
    restConnected = result.ok;
    renderSteps(steps);
    const facts = result.ok ? ["read", "health"].map((id) => steps.find((step) => step.id === id && step.ok)?.detail).filter(Boolean) : [];
    setVerdict([result.verdict ?? (result.ok ? "连接正常" : "没连上"), ...facts].join(" · "), result.ok ? "ok" : "fault");
    const failed = steps.filter((step) => step.ok !== true && step.optional !== true).length;
    $("steps-summary").textContent = failed ? `检测详情（${failed} 项未通过）` : "检测详情";
    stepsFold.open = !result.ok;
    // 找不到 SP 才提示去装；找到了连不上，要的是「去开开关」，不是「去下载」。
    const installStep = steps.find((step) => step.id === "install");
    const apiResponded = steps.some((step) => step.id === "health" && step.ok === true);
    installHelp.hidden = result.ok === true || apiResponded || installStep?.ok !== false;
    // 有失败项就把手动设置露出来：自动读取失败时那是唯一的出路。
    manual.hidden = result.ok === true;
    if (!result.ok) await loadConfig();
  } catch (error) {
    restConnected = false;
    setVerdict("检测没跑完", "fault");
    renderSteps([
      {
        id: "internal",
        label: "检测请求失败",
        ok: false,
        detail: String(error?.message ?? error),
        next: "再点一次「重新检测」。一直这样就把这个应用重新加载一下。",
      },
    ]);
    $("steps-summary").textContent = "检测详情（检测请求失败）";
    stepsFold.open = true;
    installHelp.hidden = true;
    manual.hidden = false;
  } finally {
    busy = false;
    rerun.disabled = false;
    saveBtn.disabled = false;
    if (autoTokenBtn) autoTokenBtn.disabled = false;
    verdict.setAttribute("aria-busy", "false");
    renderBridgeCapabilities();
  }
}

async function loadConfig() {
  try {
    const config = await api("/config");
    baseUrlInput.value = config.baseUrl ?? "";
    baseUrlInput.placeholder = "http://127.0.0.1:3876";
    // 令牌不回传明文。已有就只说「已保存」，不留占位让人误以为要重填。
    if (config.hasToken) {
      tokenInput.value = "";
      tokenInput.placeholder = config.tokenSource === "settings" ? "已保存（留空表示不改）" : "自动读取中（留空表示不改）";
      tokenHint.textContent = config.tokenSource === "settings"
        ? "当前用的是这里手填的令牌。留空保存表示不改。"
        : "当前令牌是从 SP 的数据目录自动读到的。留空保存表示不改。";
    } else {
      tokenInput.placeholder = "留空表示自动读取";
      tokenHint.textContent = "留空即可。打开 SP 的本地接口后，它会自己写一个令牌文件，这个应用会去读。";
    }
  } catch (error) {
    saveStatus.textContent = `读不到当前设置：${String(error?.message ?? error)}`;
    saveStatus.dataset.fault = "true";
  }
}

async function save() {
  if (busy) return;
  const baseUrl = baseUrlInput.value.trim();
  const accessToken = tokenInput.value.trim();
  const patch = {};
  if (baseUrl) patch.baseUrl = baseUrl;
  // 空 token 表示「不改」，不要用空串覆盖已自动读到的那份。
  if (accessToken) patch.accessToken = accessToken;
  if (!Object.keys(patch).length) {
    saveStatus.textContent = "没有要改的。填了地址或令牌再保存。";
    saveStatus.dataset.fault = "false";
    return;
  }

  await savePatch(patch);
}

async function useAutomaticToken() {
  if (busy) return;
  // 空输入仍表示不改；只有明确点击此按钮才清除手填令牌。
  await savePatch({ accessToken: "" });
}

async function savePatch(patch) {
  busy = true;
  saveBtn.disabled = true;
  if (autoTokenBtn) autoTokenBtn.disabled = true;
  saveStatus.dataset.fault = "false";
  saveStatus.textContent = "保存中";
  try {
    await api("/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    tokenInput.value = "";
    saveStatus.textContent = "已保存，重新检测";
    busy = false;
    saveBtn.disabled = false;
    await runDiagnose();
  } catch (error) {
    saveStatus.textContent = String(error?.message ?? error);
    saveStatus.dataset.fault = "true";
  } finally {
    busy = false;
    saveBtn.disabled = false;
    if (autoTokenBtn) autoTokenBtn.disabled = false;
  }
}
function validateBridgeStatus(status) {
  if (!status || typeof status.enabled !== "boolean" || typeof status.connected !== "boolean") {
    throw new Error("配套插件返回的连接状态不完整。");
  }
}

/** One reading of the bridge, shared by the overview row and the section status. */
function describeBridge(status) {
  if (status.error) {
    if (status.error.code === "SP_BRIDGE_STARTING") return { state: "wait", summary: "正在启动", text: status.error.message || "桥接正在启动，稍后点刷新。", fault: false };
    return { state: "fault", summary: "连接出错", text: `桥接状态检查失败：${status.error.code || "SP_BRIDGE_ERROR"}。${status.error.message || "请检查运行权限与配对状态。"}`, fault: true };
  }
  if (status.available === false) return { state: "fault", summary: "需要升级 Hana", text: "当前 Hana 没有提供所需的托管运行接口，请升级 Hana 后再配对。", fault: true };
  if (status.stopping === true || status.running === true && status.accepting === false) {
    return { state: "fault", summary: "正在停止", text: "桥接正在停止或停止尚未确认，请稍后刷新；现在不能执行扩展管理操作。", fault: true };
  }
  if (!status.enabled) {
    return status.configured
      ? { state: "", summary: "已停用", text: "桥接已停用，基础任务接口不受影响。", fault: false }
      : { state: "", summary: "未启用", text: "还没有启用。按下面三步安装并配对。", fault: false };
  }
  if (status.connected) return { state: "ok", summary: `已连接${status.pluginVersion ? ` · ${status.pluginVersion}` : ""}`, text: `SP 扩展已连接${status.pluginVersion ? `（${status.pluginVersion}）` : ""}。`, fault: false };
  if (status.running) return { state: "wait", summary: "等待 SP 插件连接", text: "本机桥接正在运行，等待 SP 插件连接。在 SP 扩展中粘贴配对码后点刷新。", fault: false };
  if (status.runtimeState === "starting") return { state: "wait", summary: "正在启动", text: "桥接正在启动，Windows 首次启动可能要一分钟。稍后点刷新。", fault: false };
  return { state: "fault", summary: "桥接未就绪", text: "已启用但本机桥接尚未就绪。请检查 Hana 运行权限和 native 身份设置，再点击启用。", fault: true };
}

let shownBridgeState = null;
function showBridgeState(state, summary) {
  bridgeOverview.dataset.state = state;
  bridgeSummary.textContent = summary;
  // Fold the setup steps away once connected, but only when the state changes,
  // so a reader who opened them is not overridden by a refresh.
  if (state === shownBridgeState) return;
  shownBridgeState = state;
  $("bridge-steps").open = state !== "ok";
  $("bridge-steps-summary").textContent = state === "ok" ? "重新安装或更新扩展" : "安装与配对";
  if (state === "fault") $("bridge-help").open = true;
}

function renderBridgeStatus(status) {
  validateBridgeStatus(status);
  const view = describeBridge(status);
  showBridgeState(view.state, view.summary);
  bridgeStatus.dataset.fault = String(view.fault);
  bridgeStatus.textContent = view.text;
  // The overview row already says "connected"; the section repeats only what needs action.
  bridgeStatus.hidden = view.state === "ok";
  $("bridge-connected-actions").hidden = !(status.enabled || status.stopping);
  $("bridge-pair").textContent = status.enabled ? "重新显示配对码" : "启用并显示配对码";
}

function validateBridgeSetup(result) {
  const plugin = result?.plugin;
  const compatibility = result?.compatibility;
  const requirements = result?.requirements;
  if (result?.ok !== true || typeof result.app?.version !== "string" || typeof plugin?.available !== "boolean" ||
      !["compatible", "disconnected", "outdated", "unknown", "unavailable"].includes(compatibility?.state) ||
      typeof compatibility.requiredVersion !== "string" || typeof requirements?.nativeAvailable !== "boolean" ||
      typeof requirements.platform !== "string" || !Array.isArray(requirements.permissions) ||
      !requirements.permissions.every((permission) => typeof permission === "string") || !Array.isArray(result.capabilities)) {
    throw new Error("扩展安装信息格式不完整，请重新刷新或升级任务台。");
  }
  validateBridgeStatus(result.bridge);
  if (plugin.available && (typeof plugin.name !== "string" || typeof plugin.version !== "string" ||
      plugin.downloadPath !== "/bridge/plugin.zip" || plugin.fileName !== "hana-sp-bridge.zip" ||
      !Number.isSafeInteger(plugin.size) || plugin.size <= 0 || plugin.size > 8388608 ||
      typeof plugin.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(plugin.sha256) ||
      !Number.isSafeInteger(plugin.protocolVersion) || plugin.protocolVersion < 1 || typeof plugin.minSpVersion !== "string")) {
    throw new Error("扩展安装包信息无效，暂不能下载。请重新刷新或重新安装任务台。");
  }
  for (const capability of result.capabilities) {
    if (!capability || typeof capability.id !== "string" || typeof capability.label !== "string" ||
        typeof capability.description !== "string" || typeof capability.available !== "boolean" ||
        !["rest", "bridge", "unsupported", "not_implemented"].includes(capability.requires) ||
        !["rest", "ready", "needs_pairing", "needs_upgrade", "unsupported", "not_implemented"].includes(capability.status) ||
        !Array.isArray(capability.tools) || !capability.tools.every((tool) => typeof tool === "string")) {
      throw new Error("扩展能力清单格式不完整，请重新刷新。");
    }
  }
}

function renderBridgeCapabilities() {
  const list = $("bridge-capabilities");
  const hint = $("bridge-capabilities-hint");
  list.replaceChildren();
  if (!bridgeSetup) { hint.textContent = "当前能力"; return; }
  const bridge = bridgeSetup.bridge;
  const connected = bridge.enabled && bridge.connected && bridge.available !== false && !bridge.error && !bridge.stopping && bridge.accepting !== false;
  const counts = { ready: 0, waiting: 0, closed: 0 };
  for (const capability of bridgeSetup.capabilities) {
    const row = element("li", "capability");
    const badge = element("span", "capability-state");
    let ready = false;
    if (capability.requires === "not_implemented" || capability.status === "not_implemented") badge.textContent = "尚未实现";
    else if (capability.requires === "unsupported" || capability.status === "unsupported") badge.textContent = capability.blocker === "upstream_bug" ? "SP 持久化缺陷" : "SP 接口限制";
    else if (capability.requires === "rest") {
      ready = capability.available && restConnected === true;
      badge.textContent = !capability.available ? "暂不可用" : ready ? "可用" : restConnected === null ? "待检测接口" : "需连接本地接口";
    } else {
      ready = connected && capability.available && capability.status === "ready";
      badge.textContent = ready ? "可用" : capability.status === "needs_upgrade" ? "需更新扩展" : "需连接扩展";
    }
    badge.dataset.ready = String(ready);
    counts[ready ? "ready" : ["rest", "bridge"].includes(capability.requires) ? "waiting" : "closed"]++;
    const reason = capability.status === "needs_upgrade" && capability.reason ? ` ${capability.reason}` : "";
    row.append(element("span", "capability-title", capability.label), badge, element("p", "hint capability-description", capability.description + reason));
    list.append(row);
  }
  hint.textContent = [`当前能力：${counts.ready} 项可用`, counts.waiting && `${counts.waiting} 项需连接`, counts.closed && `${counts.closed} 项暂未开放`].filter(Boolean).join(" · ");
}

function renderBridgeSetup() {
  const { plugin, compatibility, requirements, bridge } = bridgeSetup;
  renderBridgeStatus(bridge);
  $("bridge-package-info").textContent = plugin.available
    ? `${plugin.name} ${plugin.version} · ${(plugin.size / 1024).toFixed(1)} KB · 需要 SP ${plugin.minSpVersion} 或更新版本。`
    : "当前任务台没有附带可用的扩展包，请通过 Hana 正常更新任务台。";
  const compat = $("bridge-compatibility");
  const connectedVersion = compatibility.connectedVersion || bridge.pluginVersion || "版本未知";
  const text = compatibility.state === "outdated" ? `已连接的扩展 ${connectedVersion} 过旧，完整功能需要 ${compatibility.requiredVersion} 或更新版本。请保存新的扩展包，在 SP 中更新后重新连接。`
    : compatibility.state === "unknown" ? `无法确认已连接扩展的版本，需要 ${compatibility.requiredVersion} 或更新版本。`
    : compatibility.state === "unavailable" ? "宿主或扩展信息暂不可用，先检查运行条件。"
    : compatibility.updateAvailable === true && bridge.connected ? `可以更新到 ${compatibility.latestVersion}，命令响应更快。当前版本功能完整，可稍后更新。`
    : "";
  compat.textContent = text;
  compat.hidden = !text;
  compat.dataset.fault = String(["outdated", "unknown", "unavailable"].includes(compatibility.state));
  if (compat.dataset.fault === "true") $("bridge-steps").open = true;
  $("bridge-native-status").textContent = requirements.nativeAvailable
    ? "Hana 已提供托管运行接口。这不代表运行权限已授予，也不代表 native 身份已初始化。"
    : bridge.error ? "暂时无法确认 Hana 的托管运行接口，先处理上面的错误再刷新。"
    : "当前 Hana 没有提供托管运行接口，请先升级 Hana。基础任务接口不受影响。";
  $("bridge-native-help").hidden = requirements.platform !== "win32";
  const permissions = $("bridge-permissions");
  const labels = { "app/runtime.execute": "启动托管服务", "app/runtime.native": "使用原生运行环境", "app/runtime.network": "允许服务网络访问" };
  permissions.replaceChildren();
  for (const permission of requirements.permissions) {
    const row = document.createElement("li");
    row.append(element("code", "", permission), element("span", "", labels[permission] ? `：${labels[permission]}` : ""));
    permissions.append(row);
  }
  renderBridgeCapabilities();
}

function updateBridgeButtons() {
  for (const button of bridgeButtons) button.disabled = bridgeBusy;
  $("bridge-pair").disabled = bridgeBusy || bridgeSetup?.requirements.nativeAvailable === false && !bridgeSetup.bridge.error;
  bridgeDownload.disabled = bridgeBusy || exportBusy || bridgeSetup?.plugin.available !== true;
  if (bridgeCopyPath) bridgeCopyPath.disabled = exportBusy || !savedPluginPath;
}

function clearPairingCode() {
  bridgeCode.value = "";
  bridgeCodeField.hidden = true;
  bridgeCopyStatus.textContent = "";
}

async function readBridgeSetup() {
  const result = await api("/bridge/setup");
  validateBridgeSetup(result);
  bridgeSetup = result;
  renderBridgeSetup();
}

async function bridgeAction(action) {
  if (bridgeBusy) return;
  bridgeBusy = true;
  updateBridgeButtons();
  $("bridge-setup").setAttribute("aria-busy", "true");
  clearPairingCode();
  bridgeStatus.hidden = false;
  bridgeStatus.textContent = action === "pair" ? "正在启动桥接…" : "正在读取连接状态…";
  bridgeStatus.dataset.fault = "false";
  try {
    if (action !== "status") {
      const result = await api(`/bridge/${action}`, { method: "POST" });
      const status = action === "pair" ? result.status : result.bridge;
      renderBridgeStatus(status);
      if (action === "pair") {
        if (status.enabled !== true || status.running !== true || status.error || status.available === false ||
            typeof result.pairingCode !== "string" || !/^HANA-SP1\.[A-Za-z0-9_-]{1,4096}$/.test(result.pairingCode)) throw new Error("未收到有效的配对码，或本机桥接尚未就绪。");
        bridgeCode.value = result.pairingCode;
        bridgeCodeField.hidden = false;
      }
    }
    // A read refreshes capabilities after pairing without discarding its code.
    await readBridgeSetup();
  } catch (error) {
    bridgeSetup = null;
    const starting = error?.code === "SP_BRIDGE_STARTING";
    showBridgeState(starting ? "wait" : "fault", starting ? "正在启动" : "连接出错");
    bridgeStatus.hidden = false;
    bridgeStatus.textContent = String(error?.message ?? error) + (starting ? "就绪后再点一次「重新显示配对码」。" : "");
    bridgeStatus.dataset.fault = String(!starting);
    // A failed start may leave the bridge enabled; keep the way out visible.
    $("bridge-connected-actions").hidden = false;
    $("bridge-compatibility").hidden = true;
    $("bridge-package-info").textContent = "暂时无法读取扩展安装信息，请点刷新。";
    renderBridgeCapabilities();
  } finally {
    bridgeBusy = false;
    updateBridgeButtons();
    $("bridge-setup").setAttribute("aria-busy", "false");
  }
}

async function copyPairingCode() {
  if (copyBusy || bridgeBusy || bridgeCodeField.hidden || !bridgeCode.value) return;
  copyBusy = true;
  $("bridge-copy").disabled = true;
  const code = bridgeCode.value;
  bridgeCopyStatus.textContent = "正在复制…";
  bridgeCopyStatus.dataset.fault = "false";
  try {
    const result = await hana.clipboard.writeText(code);
    if (result?.written !== true) throw new Error("Clipboard write was not confirmed");
    if (bridgeCode.value === code && !bridgeCodeField.hidden) bridgeCopyStatus.textContent = "已复制，只粘贴到 SP 扩展。";
  } catch {
    if (bridgeCode.value === code && !bridgeCodeField.hidden) {
      bridgeCode.focus();
      bridgeCode.select();
      bridgeCopyStatus.dataset.fault = "true";
      bridgeCopyStatus.textContent = "没能自动复制，已选中配对码，请按 Ctrl+C（Mac：Command+C）手动复制，或检查 Hana 的剪贴板写入授权。";
    }
  } finally {
    copyBusy = false;
    $("bridge-copy").disabled = false;
  }
}

function showExportResult(text, fault = false) {
  bridgeDownloadStatus.dataset.fault = String(fault);
  bridgeDownloadStatus.textContent = text;
}

async function exportPlugin() {
  if (exportBusy || bridgeBusy || bridgeSetup?.plugin.available !== true) return;
  exportBusy = true;
  savedPluginPath = "";
  if (bridgeCopyPath) bridgeCopyPath.hidden = true;
  updateBridgeButtons();
  showExportResult("请在 Hana 的文件夹选择框里选一个保存位置…");
  try {
    // Hana 只允许卡片或预览面调用 saveFile，设置面没有写文件的对话框。
    // 这里让用户选文件夹，再由应用后台把校验过的 ZIP 写进去。
    const picked = await hana.resources.pick({ mode: "directory" });
    const dir = picked?.resources?.[0];
    if (!dir || dir.kind !== "local-file" || typeof dir.path !== "string" || !dir.path) {
      showExportResult("已取消，没有保存扩展包。");
      return;
    }
    const result = await api("/bridge/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: dir.path }),
    });
    savedPluginPath = typeof result?.path === "string" ? result.path : "";
    showExportResult(savedPluginPath ? `已保存到 ${savedPluginPath}` : "已保存扩展包。");
    if (bridgeCopyPath) bridgeCopyPath.hidden = !savedPluginPath;
  } catch (error) {
    const denied = error?.code === "CAPABILITY_DENIED" || error?.code === "SAVE_FILE_PERMISSION_DENIED";
    showExportResult(denied
      ? "没有保存：Hana 还没允许任务台写文件。请在应用权限里允许 app/resources.write 后再试。"
      : `没有保存：${error?.message || "写入扩展包失败，请换一个文件夹再试。"}`, true);
  } finally {
    exportBusy = false;
    updateBridgeButtons();
  }
}

async function copyPluginPath() {
  if (!savedPluginPath || copyBusy) return;
  copyBusy = true;
  bridgeCopyPath.disabled = true;
  try {
    const result = await hana.clipboard.writeText(savedPluginPath);
    if (result?.written !== true) throw new Error("Clipboard write was not confirmed");
    showExportResult(`路径已复制，去 SP「设置 → 插件」里粘贴即可：${savedPluginPath}`);
  } catch {
    showExportResult(`没能自动复制，请手动选中路径：${savedPluginPath}`, true);
  } finally {
    copyBusy = false;
    bridgeCopyPath.disabled = false;
  }
}

function showDesktopCardsStatus(text, fault = false) {
  desktopCardsStatus.dataset.fault = String(fault);
  desktopCardsStatus.textContent = text;
}

async function copyDesktopCardsUrl(message) {
  try {
    const result = await hana.clipboard.writeText(DESKTOP_CARDS_URL);
    if (result?.written !== true) throw new Error("Clipboard write was not confirmed");
    showDesktopCardsStatus(message);
    return true;
  } catch {
    showDesktopCardsStatus(`没能自动复制，请手动访问：${DESKTOP_CARDS_URL}`, true);
    return false;
  }
}

async function openDesktopCards() {
  if (desktopCardsBusy) return;
  desktopCardsBusy = true;
  downloadDesktopCards.disabled = true;
  copyDesktopCardsButton.disabled = true;
  showDesktopCardsStatus("正在打开下载页…");
  try {
    const result = await hana.external.open(DESKTOP_CARDS_URL);
    if (result?.opened !== true) throw new Error("Host did not confirm opening");
    showDesktopCardsStatus("已在浏览器打开下载页。");
  } catch {
    await copyDesktopCardsUrl("没能直接打开，链接已复制，粘到浏览器即可下载。");
  } finally {
    desktopCardsBusy = false;
    downloadDesktopCards.disabled = false;
    copyDesktopCardsButton.disabled = false;
  }
}

async function copyDesktopCardsLink() {
  if (desktopCardsBusy) return;
  desktopCardsBusy = true;
  copyDesktopCardsButton.disabled = true;
  try {
    await copyDesktopCardsUrl("下载链接已复制。");
  } finally {
    desktopCardsBusy = false;
    copyDesktopCardsButton.disabled = false;
  }
}

followDesktop.addEventListener("change", () => { void saveDesktopTheme(); });
downloadDesktopCards.addEventListener("click", () => { void openDesktopCards(); });
copyDesktopCardsButton.addEventListener("click", () => { void copyDesktopCardsLink(); });
$("bridge-refresh").addEventListener("click", () => { void bridgeAction("status"); });
$("bridge-pair").addEventListener("click", () => { void bridgeAction("pair"); });
$("bridge-disable").addEventListener("click", () => { void bridgeAction("disable"); });
bridgeDownload.addEventListener("click", () => { void exportPlugin(); });
bridgeCopyPath?.addEventListener("click", () => { void copyPluginPath(); });
$("bridge-copy").addEventListener("click", () => { void copyPairingCode(); });
$("bridge-hide").addEventListener("click", clearPairingCode);
globalThis.addEventListener?.("pagehide", clearPairingCode);
rerun.addEventListener("click", () => { void runDiagnose(); });
saveBtn.addEventListener("click", () => { void save(); });
autoTokenBtn?.addEventListener("click", () => { void useAutomaticToken(); });
tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void save();
  }
});

void loadDesktopTheme();
void runDiagnose();
void bridgeAction("status");
