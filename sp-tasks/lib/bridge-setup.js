import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { bridgeCompatibility, capabilityCatalog, BUNDLED_PLUGIN_VERSION, RECOMMENDED_PLUGIN_VERSION, RUNTIME_PERMISSIONS } from "./capabilities.js";

const PACKAGE_ROOT = new URL("../assets/companion/", import.meta.url);
const FILE_NAME = "hana-sp-bridge.zip";
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;

/**
 * Reads only package.json, so showing settings never touches the ZIP. The ZIP
 * structure is checked when scripts/bundle-companion.mjs builds it.
 */
export async function readBundledInfo({ read = readFile, root = PACKAGE_ROOT } = {}) {
  const metadata = JSON.parse(await read(new URL("package.json", root), "utf8"));
  if (metadata?.id !== "hana-sp-bridge" || metadata.protocolVersion !== 1 ||
      metadata.version !== BUNDLED_PLUGIN_VERSION || typeof metadata.name !== "string" ||
      metadata.minSpVersion !== "19.3.1" || !Number.isSafeInteger(metadata.size) ||
      metadata.size < 4 || metadata.size > MAX_PACKAGE_BYTES || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    throw new Error("The bundled SP extension metadata is invalid.");
  }
  return {
    plugin: { available: true, id: metadata.id, name: metadata.name, version: metadata.version,
      minSpVersion: metadata.minSpVersion, protocolVersion: metadata.protocolVersion,
      minimumCompatibleVersion: RECOMMENDED_PLUGIN_VERSION, fileName: FILE_NAME,
      downloadPath: "/bridge/plugin.zip", size: metadata.size, sha256: metadata.sha256 },
  };
}

/** Download path: the bytes must match the size and digest the card will check again. */
export async function readBundledPlugin({ read = readFile, root = PACKAGE_ROOT } = {}) {
  const { plugin } = await readBundledInfo({ read, root });
  const bytes = await read(new URL(FILE_NAME, root));
  if (!Buffer.isBuffer(bytes) || bytes.length !== plugin.size ||
      createHash("sha256").update(bytes).digest("hex") !== plugin.sha256) {
    throw new Error("The bundled SP extension failed its package integrity check.");
  }
  return { bytes, plugin };
}

/** 设置页选中文件夹后，把校验过的 ZIP 写到 <dir>/hana-sp-bridge.zip。 */
export async function writeBundledPlugin({ sdk, dir, loadPlugin = readBundledPlugin, pathApi = path }) {
  if (typeof dir !== "string" || !dir || dir.includes("\0") || !pathApi.isAbsolute(dir)) {
    throw Object.assign(new Error("保存位置无效，请重新选择文件夹。"), { code: "EXPORT_DIR_INVALID" });
  }
  const { bytes, plugin } = await loadPlugin();
  const target = pathApi.join(dir, plugin.fileName);
  await sdk.resources.write({ kind: "local-file", path: target }, bytes);
  return { path: target, fileName: plugin.fileName, size: bytes.length, sha256: plugin.sha256 };
}

function safeStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bridge status.");
  const status = {};
  for (const key of ["available", "configured", "enabled", "running", "connected"]) status[key] = value[key] === true;
  for (const key of ["accepting", "stopping"]) if (typeof value[key] === "boolean") status[key] = value[key];
  status.runtimeState = ["starting", "ready", "stopping", "stopped", "failed"].includes(value.runtimeState) ? value.runtimeState : null;
  status.pluginVersion = typeof value.pluginVersion === "string" && /^[A-Za-z0-9.+-]{1,80}$/.test(value.pluginVersion) ? value.pluginVersion : null;
  status.protocol = Number.isSafeInteger(value.protocol) ? value.protocol : null;
  status.lastSeen = Number.isSafeInteger(value.lastSeen) && value.lastSeen >= 0 ? value.lastSeen : null;
  if (value.error) status.error = {
    code: typeof value.error.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.error.code) ? value.error.code : "SP_BRIDGE_STATUS_UNAVAILABLE",
    message: "SP 扩展连接尚未就绪，请检查 Hana 运行权限、Windows native 身份配置与本机端口。",
  };
  return status;
}

export function createBridgeSetup({ bridge, version, extensions = [], loadPlugin = readBundledInfo, platform = process.platform }) {
  return async () => {
    const [statusResult, pluginResult] = await Promise.allSettled([
      Promise.resolve().then(() => bridge.status()).then(safeStatus), Promise.resolve().then(() => loadPlugin()),
    ]);
    const status = statusResult.status === "fulfilled" ? statusResult.value : {
      available: false, configured: false, enabled: false, running: false, connected: false, pluginVersion: null, protocol: 1,
      error: { code: "SP_BRIDGE_STATUS_UNAVAILABLE", message: "无法检查 SP 扩展连接，请重新加载任务台后检查。" },
    };
    const plugin = pluginResult.status === "fulfilled" ? pluginResult.value.plugin : {
      available: false, id: "hana-sp-bridge", name: "Hana 任务台 SP 扩展", version: null,
      minimumCompatibleVersion: RECOMMENDED_PLUGIN_VERSION,
      error: "内置扩展包缺失或校验失败，请通过 Hana 正常更新任务台后再下载。",
    };
    return {
      app: { version }, plugin, bridge: status, compatibility: bridgeCompatibility(status),
      requirements: { nativeAvailable: status.available === true, nativeIdentity: "not-checked", platform, permissions: [...RUNTIME_PERMISSIONS] },
      capabilities: capabilityCatalog(status, extensions),
    };
  };
}

export function registerBridgeSetupRoutes(app, { setup, loadPlugin = readBundledPlugin }) {
  app.get("/bridge/setup", async (c) => c.json({ ok: true, ...await setup() }));
  app.get("/bridge/plugin.zip", async (c) => {
    try {
      const { bytes } = await loadPlugin();
      return new Response(bytes, { status: 200, headers: {
        "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${FILE_NAME}"`,
        "Content-Length": String(bytes.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      } });
    } catch {
      return c.json({ ok: false, error: "内置 SP 扩展包不可用，请更新任务台后重试。" }, 503);
    }
  });
}
