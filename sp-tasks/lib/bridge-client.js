import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { BRIDGE_PORT, BRIDGE_PROTOCOL, BRIDGE_READY, BRIDGE_AUTH_FILE, validateCommand, validateResult } from "./bridge-protocol.js";

const STORAGE_KEY = "sp-bridge-v1";
const SERVICE_ID = "sp-bridge";
const active = (runtime) => ["starting", "ready", "stopping"].includes(runtime?.state);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const token = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CHECK_SETUP = "请检查 Hana 运行权限、native 身份配置和 3877 端口；没有停止其他进程。";

export class BridgeError extends Error {
  constructor(code, message, { outcomeUnknown = false, createdId } = {}) {
    super(message); this.name = "BridgeError"; this.code = code;
    if (outcomeUnknown) this.outcomeUnknown = true;
    if (typeof createdId === "string") this.createdId = createdId;
  }
}
function translated(cause, fallback, outcomeUnknown = false) {
  if (cause instanceof BridgeError) return cause;
  const code = typeof cause?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(cause.code) ? cause.code : "SP_BRIDGE_ERROR";
  let message = fallback;
  if (code.includes("SANDBOX") || code.includes("NATIVE_IDENTITY")) message = "Hana 托管运行环境尚未就绪。Windows 需要先按 Hana 应用开发文档为当前使用者初始化 native sandbox 身份；任务台不会自动修改系统权限。";
  else if (code.includes("DENIED") || code.includes("CAPABILITY")) message = "请先在 Hana 中允许任务台的 runtime.execute、runtime.native 和 runtime.network 权限。";
  return new BridgeError(code, message, { outcomeUnknown });
}
function emptyStatus(state, supported) {
  return { configured: !!state, enabled: state?.enabled === true, available: supported, running: false, runtimeState: null, connected: false, pluginVersion: null, lastSeen: null, protocol: BRIDGE_PROTOCOL };
}

/**
 * Construction is side-effect free, including for REST-only SDK clients.
 *
 * After one verified start the runtime is kept as `live`, so a command costs a
 * single fetch. Any failed fetch drops it and the next call re-checks the host.
 * A cold Windows native start can exceed one wait window; a still-starting
 * runtime is left for the next call to adopt and only stopped after `startLimitMs`.
 */
export function createBridgeClient(sdk, { port = BRIDGE_PORT, readyTimeoutMs = 15000, startLimitMs = 180000 } = {}) {
  let mutation = Promise.resolve();
  let startupError = null;
  let stored;
  let live = null;
  const supported = () => typeof sdk?.dataDir === "string" && typeof sdk.storage?.global?.get === "function" && typeof sdk.storage?.global?.set === "function" && ["start", "list", "get", "stop", "fetch"].every((method) => typeof sdk.runtime?.[method] === "function");
  function exclusive(fn) { const result = mutation.then(fn, fn); mutation = result.catch(() => {}); return result; }
  function requireSupport() {
    if (!supported()) throw new BridgeError("SP_BRIDGE_UNSUPPORTED", "当前 Hana 没有提供托管运行接口，请升级 Hana。");
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 15000 || !Number.isInteger(startLimitMs) || startLimitMs < readyTimeoutMs || startLimitMs > 300000) throw new BridgeError("SP_BRIDGE_BAD_CONFIG", "桥接配置无效。");
  }
  async function state() {
    if (!supported()) return null;
    if (stored !== undefined) return stored;
    let value;
    try { value = await sdk.storage.global.get(STORAGE_KEY, null); }
    catch (cause) { throw translated(cause, "无法读取桥接配置。"); }
    if (value == null) return (stored = null);
    if (!record(value) || value.protocol !== BRIDGE_PROTOCOL || typeof value.enabled !== "boolean" || !token(value.controlToken) || !token(value.pluginToken) || value.controlToken === value.pluginToken) throw new BridgeError("SP_BRIDGE_BAD_CONFIG", "保存的桥接凭据无效，请断开后重新配对。");
    return (stored = value);
  }
  async function save(value) {
    stored = undefined;
    try { await sdk.storage.global.set(STORAGE_KEY, value); } catch (cause) { throw translated(cause, "无法保存桥接配置。"); }
    stored = value;
  }
  async function runtime() {
    let candidates;
    try { candidates = await sdk.runtime.list(); } catch (cause) { throw translated(cause, "无法检查桥接进程。"); }
    if (!Array.isArray(candidates)) throw new BridgeError("SP_BRIDGE_BAD_RESPONSE", "Hana 返回的运行列表无效。");
    const matches = candidates.filter((item) => item?.service?.id === SERVICE_ID && active(item));
    if (matches.length > 1) throw new BridgeError("SP_BRIDGE_RUNTIME_CONFLICT", "同时有多个桥接进程在运行。");
    return matches[0] || null;
  }
  async function bootstrap(value) {
    const filename = path.join(sdk.dataDir, BRIDGE_AUTH_FILE);
    const content = JSON.stringify({ protocol: BRIDGE_PROTOCOL, controlToken: value.controlToken, pluginToken: value.pluginToken });
    // Credentials never rotate, so a restart normally finds the file already current.
    // Leaving it alone avoids replacing it while a stopping sandbox still holds it.
    if (await readFile(filename, "utf8").catch(() => null) === content) return;
    const temp = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temp, content, { flag: "wx", mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, filename); break; }
        catch (error) {
          // Windows reports a file briefly held by another process as EPERM/EACCES/EBUSY.
          if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
          await delay(200 * (attempt + 1));
        }
      }
    } finally { await unlink(temp).catch((error) => { if (error?.code !== "ENOENT") throw error; }); }
  }
  /** Finds or starts the runtime and verifies it; the result becomes `live`. */
  async function ready(value) {
    requireSupport();
    if (!value?.enabled) throw new BridgeError("SP_BRIDGE_NOT_PAIRED", "请先在任务台设置中启用并配对 SP 扩展。");
    let current = await runtime();
    if (current?.state === "stopping") throw new BridgeError("SP_BRIDGE_STOPPING", "桥接正在停止，请稍后再试。");
    if (!current) {
      try {
        await bootstrap(value);
        current = await sdk.runtime.start({ runtime: "node", entry: "runtime/bridge.mjs", profile: "native", network: "external", cwd: sdk.dataDir, args: [String(port)], service: { id: SERVICE_ID, port, readyMarker: BRIDGE_READY } });
      } catch (cause) { throw translated(cause, `无法启动桥接进程。${CHECK_SETUP}`); }
    }
    if (typeof current?.runtimeId !== "string" || !current.runtimeId) throw new BridgeError("SP_BRIDGE_BAD_RESPONSE", "Hana 没有返回桥接进程 ID。");
    const id = current.runtimeId, deadline = Date.now() + readyTimeoutMs;
    while (current?.state === "starting" && Date.now() < deadline) {
      await delay(80);
      try { current = await sdk.runtime.get(id); } catch (cause) { throw translated(cause, "无法检查桥接启动进度。"); }
    }
    if (current?.state === "starting") {
      // Stopping here would discard a cold start that is seconds from ready and
      // make every retry cold again; only a start past the hard limit is stopped.
      const startedAt = Date.parse(current.startedAt);
      if (Number.isFinite(startedAt) && Date.now() - startedAt < startLimitMs) throw new BridgeError("SP_BRIDGE_STARTING", "桥接仍在启动（Windows 首次启动可能需要一分钟），稍后重试会沿用同一个进程。");
      await sdk.runtime.stop(id).catch(() => {});
      throw new BridgeError("SP_BRIDGE_START_FAILED", `桥接 ${Math.round(startLimitMs / 1000)} 秒内没有就绪，已停止。${CHECK_SETUP}`);
    }
    if (current?.state !== "ready" || current?.service?.state !== "ready") {
      const exit = Number.isInteger(current?.exitCode) ? `（退出码 ${current.exitCode}）` : "";
      throw new BridgeError("SP_BRIDGE_START_FAILED", `桥接进程在就绪前退出${exit}。${CHECK_SETUP}`);
    }
    if (current.service.port !== port) throw new BridgeError("SP_BRIDGE_RUNTIME_CONFLICT", "桥接正在使用其他端口，请先断开再更换端口。");
    const health = await request(current, value, "/internal/status");
    if (health?.accepting !== true) throw new BridgeError("SP_BRIDGE_STOPPING", "桥接已停止接收命令，请等它停完再重新配对。");
    live = { runtime: current, value };
    return current;
  }
  async function request(current, value, route, { body, isWrite = false } = {}) {
    let response, result;
    try {
      response = await sdk.runtime.fetch(current.runtimeId, route, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${value.controlToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), timeoutMs: body === undefined ? 3000 : 15000 });
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024 + 2048) throw new Error("Response too large.");
      result = JSON.parse(raw);
    } catch (cause) {
      if (live?.runtime === current) live = null;
      throw Object.assign(translated(cause, isWrite ? "桥接没有确认结果。请先查询 SP，再决定是否重试这次修改。" : "桥接没有响应。", isWrite), { transport: true });
    }
    try { validateResult(result); } catch { throw new BridgeError("SP_BRIDGE_BAD_RESPONSE", "桥接返回的结果格式无效。", { outcomeUnknown: isWrite }); }
    if (!response.ok || result.ok === false) {
      if (result.ok === false) throw new BridgeError(result.error.code, result.error.message, { outcomeUnknown: result.outcomeUnknown === true || isWrite && response.status >= 500, createdId: result.createdId });
      throw new BridgeError("SP_BRIDGE_BAD_RESPONSE", "桥接返回了失败的 HTTP 状态。", { outcomeUnknown: isWrite });
    }
    return result.data;
  }
  async function statusOf(value, current) {
    const base = emptyStatus(value, supported());
    if (!current) return base;
    base.runtimeState = current.state; base.running = current.state === "ready" && current.service?.state === "ready";
    if (value?.enabled === false && active(current)) base.stopping = true;
    if (!base.running || !value) return base;
    try {
      const data = await request(current, value, "/internal/status");
      if (!record(data) || typeof data.connected !== "boolean" || data.protocol !== BRIDGE_PROTOCOL || data.pluginVersion !== null && typeof data.pluginVersion !== "string" || data.lastSeen !== null && (!Number.isSafeInteger(data.lastSeen) || data.lastSeen < 0)) throw new BridgeError("SP_BRIDGE_BAD_RESPONSE", "桥接状态无效。");
      return { ...base, accepting: data.accepting === true, connected: data.connected, pluginVersion: data.pluginVersion, lastSeen: data.lastSeen };
    } catch (cause) { return { ...base, error: { code: cause?.code || "SP_BRIDGE_ERROR", message: "桥接没有返回有效的认证状态。" } }; }
  }
  async function status() {
    const value = await state();
    if (live && live.value === value) {
      const result = await statusOf(value, live.runtime);
      if (!result.error) return result;
    }
    const result = !supported() ? emptyStatus(value, false) : await statusOf(value, await runtime());
    return value?.enabled && !result.running && startupError ? { ...result, error: startupError } : result;
  }
  async function start(value) {
    try {
      const current = await ready(value);
      startupError = null;
      return current;
    } catch (cause) {
      const error = translated(cause, `无法启动 SP 扩展连接。${CHECK_SETUP}`);
      startupError = { code: error.code, message: error.message };
      throw error;
    }
  }
  return {
    status,
    pair() {
      return exclusive(async () => {
        requireSupport();
        const previous = await state();
        const value = { protocol: BRIDGE_PROTOCOL, controlToken: previous?.controlToken || randomBytes(32).toString("base64url"), pluginToken: previous?.pluginToken || randomBytes(32).toString("base64url"), enabled: true };
        live = null;
        await save(value);
        const current = await start(value);
        const payload = { protocol: BRIDGE_PROTOCOL, url: `http://127.0.0.1:${port}`, token: value.pluginToken };
        return { pairingCode: `HANA-SP1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`, status: await statusOf(value, current) };
      });
    },
    disable() {
      return exclusive(async () => {
        if (!supported()) return emptyStatus(null, false);
        live = null;
        const value = await state();
        if (value) await save({ ...value, enabled: false });
        startupError = null;
        const current = await runtime();
        if (current) {
          let quiesceError;
          if (value && current.state === "ready") {
            try {
              const result = await request(current, value, "/internal/disable", { body: {} });
              if (!record(result) || result.disabled !== true) throw new BridgeError("SP_BRIDGE_STOP_UNCONFIRMED", "桥接没有确认已取消排队的命令。");
            } catch (cause) { quiesceError = cause; }
          }
          try { await sdk.runtime.stop(current.runtimeId); } catch (cause) { throw translated(cause, "桥接已停用，但进程没能停止。"); }
          if (quiesceError) {
            const after = await sdk.runtime.get(current.runtimeId);
            if (active(after)) throw new BridgeError("SP_BRIDGE_STOP_UNCONFIRMED", "桥接仍在停止，且没有确认已取消排队的命令。");
          }
        }
        return status();
      });
    },
    restore() {
      return exclusive(async () => {
        const value = await state();
        if (!value?.enabled) return emptyStatus(value, supported());
        return statusOf(value, await start(value));
      });
    },
    async execute(op, args = {}) {
      try { validateCommand(op, args); } catch (cause) { throw new BridgeError(cause?.code || "SP_BRIDGE_BAD_INPUT", cause?.message || "命令无效。"); }
      const isWrite = !op.endsWith(".list"), body = { op, args };
      if (live) {
        const { runtime: current, value } = live;
        try { return await request(current, value, "/internal/execute", { body, isWrite }); }
        // A read whose transport failed is safe to send again once the runtime is re-checked.
        catch (error) { if (isWrite || !error.transport) throw error; }
      }
      const entry = await exclusive(async () => {
        if (live) return live;
        const value = await state();
        return { runtime: await start(value), value };
      });
      return request(entry.runtime, entry.value, "/internal/execute", { body, isWrite });
    },
  };
}
