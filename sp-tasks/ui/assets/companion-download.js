import { createHanaAppUiSdk } from "./sdk.js";

const hana = createHanaAppUiSdk({ followHostTheme: true });
const $ = (id) => document.getElementById(id);
const root = $("companion-download"), saveButton = $("companion-save"), refreshButton = $("companion-refresh");
const status = $("companion-status");
const FILE_NAME = "hana-sp-bridge.zip", ZIP_PATH = "/bridge/plugin.zip", MAX_BYTES = 2 * 1024 * 1024;
const DENIED = ["CAPABILITY_DENIED", "SAVE_FILE_PERMISSION_DENIED", "SLOT_DENIED"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const versionText = (value) => typeof value === "string" && /^\d+\.\d+\.\d+(?:[+-][A-Za-z0-9.-]+)?$/.test(value) && value.length <= 80;
let metadata = null, busy = false, disposed = false, ready = false;

function show(message, state = "info") {
  if (disposed) return;
  status.textContent = message; status.dataset.state = state;
  status.dataset.fault = String(["error", "unknown", "denied"].includes(state));
}
function controls() {
  root.setAttribute("aria-busy", String(busy));
  saveButton.disabled = disposed || busy || metadata === null;
  refreshButton.disabled = disposed || busy;
}
function localError(code) { throw Object.assign(new Error("Package preparation failed."), { localCode: code }); }

function packageMetadata(body) {
  if (!record(body) || body.ok !== true || !record(body.plugin)) localError("METADATA");
  const plugin = body.plugin;
  if (plugin.available === false) localError("UNAVAILABLE");
  if (plugin.available !== true || plugin.id !== "hana-sp-bridge" || plugin.protocolVersion !== 1 ||
      plugin.downloadPath !== ZIP_PATH || plugin.fileName !== FILE_NAME ||
      !Number.isSafeInteger(plugin.size) || plugin.size < 4 || plugin.size > MAX_BYTES ||
      typeof plugin.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(plugin.sha256) ||
      !versionText(plugin.version) || !versionText(plugin.minSpVersion)) localError("METADATA");
  return { size: plugin.size, sha256: plugin.sha256.toLowerCase(), version: plugin.version, minSpVersion: plugin.minSpVersion };
}

async function refreshMetadata() {
  if (busy || disposed) return;
  busy = true; controls();
  show("");
  try {
    if (!ready) { await hana.ready(); ready = true; }
    if (disposed) return;
    const response = await hana.api.fetch("/bridge/setup");
    if (response?.ok !== true) localError("METADATA");
    const text = await response.text();
    if (typeof text !== "string" || text.length > 256 * 1024) localError("METADATA");
    metadata = packageMetadata(JSON.parse(text));
    if (disposed) return;
    $("companion-info").textContent = `版本 ${metadata.version} · ${(metadata.size / 1024).toFixed(1)} KB · 需要 SP ${metadata.minSpVersion} 或更新版本`;
    $("companion-checksum").textContent = metadata.sha256;
    $("companion-details").hidden = false;
    refreshButton.hidden = true;
  } catch (error) {
    metadata = null;
    if (disposed) return;
    $("companion-info").textContent = error?.localCode === "UNAVAILABLE" ? "当前任务台没有附带可用的安装包，请通过 Hana 正常更新任务台。" : "暂时无法读取安装包信息。";
    $("companion-checksum").textContent = ""; $("companion-details").hidden = true;
    refreshButton.hidden = false;
    show("安装包信息没有通过检查，没有发起保存。", "error");
  } finally { busy = false; controls(); }
}

function unconfirmed(message = "未收到明确的保存结果，文件可能已经写入。请先检查目标位置，需要时再点保存。") {
  show(message, "unknown");
}
// The host chooses the path and writes the file; only its outcome kind matters here.
function renderReceipt(result) {
  const kind = record(result) && result.mayHaveWritten !== true ? result.kind : null;
  if (kind === "saved") show("Hana 已确认保存完成。下一步在 SP「设置 → 插件」里选这个文件安装。", "saved");
  else if (kind === "canceled") show("已取消，没有保存 ZIP。", "canceled");
  else if (kind === "download-started") show("Hana 改用浏览器下载，尚未确认文件已保存。请在下载记录里确认。", "download-started");
  else unconfirmed();
}

async function savePackage() {
  if (busy || disposed || metadata === null) return;
  busy = true; controls();
  const expected = metadata;
  let requestedSave = false;
  show("正在校验安装包…");
  try {
    if (typeof globalThis.crypto?.subtle?.digest !== "function") localError("CRYPTO");
    if (typeof hana.resources?.saveFile !== "function") localError("SAVE_UNAVAILABLE");
    const response = await hana.api.fetch(ZIP_PATH);
    if (response?.ok !== true) localError("PACKAGE");
    const length = response.headers?.get?.("content-length");
    if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) !== expected.size)) localError("PACKAGE");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== expected.size || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) localError("PACKAGE");
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    const hash = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    if (digest.length !== 32 || hash !== expected.sha256) localError("PACKAGE");
    if (disposed) return;
    // Encode bytes, not decoded text, so every ZIP byte survives the SDK boundary.
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 16384) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
    const contentBase64 = btoa(chunks.join(""));
    show("校验通过，请在 Hana 的保存对话框里选位置。");
    requestedSave = true;
    const result = await hana.resources.saveFile({ suggestedName: FILE_NAME, mimeType: "application/zip", contentBase64 }, { timeoutMs: 300000 });
    if (!disposed) renderReceipt(result);
  } catch (error) {
    if (disposed) return;
    if (!requestedSave) {
      show(error?.localCode === "CRYPTO" ? "当前环境无法做 SHA-256 校验，没有发起保存。请升级 Hana 后重新打开卡片。"
        : error?.localCode === "SAVE_UNAVAILABLE" ? "当前卡片没有 Hana 保存接口，没有保存。请升级 Hana，并确认任务台的 app/resources.write 权限。"
        : "安装包读取或校验失败，没有发起保存。请重新打开卡片后再试。", "error");
    } else if (error?.code === "SLOT_DENIED") show("当前界面不允许保存文件。请从 Hana 卡片中心打开「SP 扩展安装包」卡片，并允许 app/resources.write。", "denied");
    else if (DENIED.includes(error?.code)) show("保存权限被拒绝。请在 Hana 的任务台应用权限中允许 app/resources.write，再点保存。", "denied");
    else unconfirmed(error?.code === "TIMEOUT" ? "保存等待超时，文件可能已写入，或对话框还开着。请先检查目标位置。" : undefined);
  } finally { busy = false; controls(); }
}

refreshButton.addEventListener("click", () => { void refreshMetadata(); });
saveButton.addEventListener("click", () => { void savePackage(); });
globalThis.addEventListener?.("pagehide", () => { disposed = true; controls(); });
void refreshMetadata();
