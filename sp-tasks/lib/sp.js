// lib/sp.js — Super Productivity 本地 REST API 客户端
// 走 SP 19.x 的 127.0.0.1:3876 回环服务，Bearer token 鉴权。
// 响应统一为 { ok: true, data } 或 { ok: false, error: { code, message } }。

const DEFAULT_BASE_URL = "http://127.0.0.1:3876";
import { invalidateNotice } from "./notice.js";

export class SpError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "SpError";
    this.code = code;
    this.status = status ?? null;
  }
}

/** 把底层网络错误翻译成用户能照着做的判断，而不是 ECONNREFUSED 这样一串。 */
function translateNetworkError(error) {
  const message = `${error?.code ?? ""} ${String(error?.message ?? error ?? "")}`.trim();
  if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|fetch failed|Failed to fetch/i.test(message)) {
    return new SpError(
      "SP_UNREACHABLE",
      "连不上 Super Productivity。确认它正在运行，且「设置 → 杂项」里的本地 REST API 已打开。"
    );
  }
  if (/PLUGIN_NETWORK_NOT_DECLARED|not allowed|PLUGIN_NETWORK_HOST/i.test(message)) {
    return new SpError(
      "SP_NETWORK_BLOCKED",
      "宿主网络白名单拦下了这次请求。应用清单里的 network.allowedHosts 需要包含 127.0.0.1。"
    );
  }
  if (/PLUGIN_NETWORK_TIMEOUT|timed out|timeout|AbortError/i.test(message)) {
    return new SpError("SP_TIMEOUT", "Super Productivity 没有在时限内回应。它可能正忙或卡住了。");
  }
  return new SpError("SP_NETWORK_ERROR", message || "请求 Super Productivity 失败。");
}

function translateStatus(status, payload, rawText) {
  const code = payload?.error?.code;
  const serverMessage = payload?.error?.message;
  if (status === 401) {
    return new SpError(
      "SP_UNAUTHORIZED",
      "访问令牌无效。请到 SP「设置 → 杂项」复制当前的 access token，填进本应用设置。",
      status
    );
  }
  if (status === 503 && code === "API_DISABLED") {
    return new SpError(
      "SP_API_DISABLED",
      "SP 的本地 REST API 处于关闭状态。请到「设置 → 杂项」打开它。",
      status
    );
  }
  if (status === 503 && code === "APP_NOT_READY") {
    return new SpError("SP_NOT_READY", "SP 的数据还没加载完，稍等一下再试。", status);
  }
  return new SpError(code || `SP_HTTP_${status}`, serverMessage || rawText?.slice(0, 300) || `SP 返回 ${status}`, status);
}

import { autoReadToken } from "./token.js";

export function trimBaseUrl(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** 每次调用都重读设置：用户在设置页改完 token 不必重载应用。 */
export async function readConfig(sdk) {
  let baseUrl = DEFAULT_BASE_URL;
  let accessToken = "";
  let defaultProjectId = "";
  try {
    const all = await sdk.config.getAll();
    if (typeof all?.baseUrl === "string" && all.baseUrl.trim()) baseUrl = trimBaseUrl(all.baseUrl);
    if (typeof all?.accessToken === "string") accessToken = all.accessToken.trim();
    if (typeof all?.defaultProjectId === "string") defaultProjectId = all.defaultProjectId.trim();
  } catch (error) {
    throw new SpError("SP_CONFIG_UNREADABLE", `读不到应用设置：${error?.message ?? error}`);
  }

  // 设置页里手填的 token 优先；没有就去 SP 的数据目录自己取。
  // 这样用户只要在 SP 里把接口开关打开，不必再复制粘贴一次。
  let tokenSource = accessToken ? "settings" : null;
  let autoTokenError = null;
  if (!accessToken) {
    const auto = await autoReadToken(sdk);
    if (auto.token) {
      accessToken = auto.token;
      tokenSource = "auto";
    } else {
      autoTokenError = auto.tried || [];
    }
  }

  return { baseUrl, accessToken, defaultProjectId, tokenSource, autoTokenError };
}

export function assertConfigured(cfg) {
  if (!cfg.accessToken) {
    // 自动读失败时把试过的路径与原因一并说出来：用户能自己判断是路径不对、
  // 还是权限没给，而不是只知道「没拿到」。
    const tried = Array.isArray(cfg.autoTokenError) && cfg.autoTokenError.length
      ? `\n尝试过的路径：\n${cfg.autoTokenError.map((line) => `  · ${line}`).join("\n")}`
      : "";
    throw new SpError(
      "SP_NO_TOKEN",
      "没拿到访问令牌。先确认 Super Productivity 正在运行，并在它的「更多设置」里把本地 REST API 打开（打开后会自动生成 token，本应用会自己去读）。这个开关只需开一次。" + tried
    );
  }
}

async function request(sdk, cfg, method, path, body, query) {
  assertConfigured(cfg);
  const url = new URL(cfg.baseUrl + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const init = {
    method,
    headers: { Authorization: `Bearer ${cfg.accessToken}`, Accept: "application/json" },
    timeoutMs: 15000,
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const writing = method !== "GET";
  try {
    let response;
    let text;
    try {
      response = await sdk.network.fetch(url.toString(), init);
      text = await response.text();
    } catch (error) {
      throw translateNetworkError(error);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) throw translateStatus(response.status, null, "");
      throw new SpError("SP_BAD_RESPONSE", "SP 返回了无法识别的响应，请检查连接地址和接口状态。", response.status);
    }
    if (!response.ok || payload?.ok === false) {
      throw translateStatus(response.status, payload, "");
    }
    if (payload?.ok !== true || !Object.prototype.hasOwnProperty.call(payload, "data")) {
      throw new SpError("SP_BAD_RESPONSE", "SP 响应缺少成功标记或 data，无法确认操作结果。", response.status);
    }
    const data = payload.data;
    const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const hasId = (value) => typeof value?.id === "string" && value.id.trim().length > 0;
    const listRoute = /^\/(tasks|projects|tags|task-repeat-cfgs|notes|simple-counters)$/.test(path) && method === "GET";
    const nullable = path === "/task-control/current" || path === "/focus";
    if (listRoute ? !Array.isArray(data) || data.some((row) => !isRecord(row) || !hasId(row))
      : !(isRecord(data) || nullable && data === null)) {
      throw new SpError("SP_BAD_RESPONSE", "SP 响应的数据类型不符合接口契约，无法确认操作结果。", response.status);
    }
    if (/^\/tasks(?:\/[^/]+)?$/.test(path) && method !== "DELETE" && !listRoute &&
        (!hasId(data) || typeof data.title !== "string")) {
      throw new SpError("SP_BAD_RESPONSE", "SP 没有返回有效任务及其 id，无法确认操作结果。", response.status);
    }
    const taskPath = path.match(/^\/tasks\/([^/]+)(?:\/(time|start|archive|restore))?$/);
    if (taskPath) {
      const expectedId = decodeURIComponent(taskPath[1]);
      const returnedId = taskPath[2] === "start" ? data?.currentTaskId : data?.id;
      if (returnedId !== expectedId || method === "DELETE" && data?.deleted !== true || taskPath[2] === "archive" && data?.archived !== true) {
        throw new SpError("SP_BAD_RESPONSE", "SP 返回的任务或操作确认与请求不一致，请重新查询。", response.status);
      }
      if (method !== "DELETE" && !["archive", "start"].includes(taskPath[2]) && typeof data.title !== "string") {
        throw new SpError("SP_BAD_RESPONSE", "SP 没有返回完整任务，无法确认操作结果。", response.status);
      }
    }
    if (path === "/task-control/current" && data !== null && (!hasId(data) || typeof data.title !== "string")) {
      throw new SpError("SP_BAD_RESPONSE", "SP 没有返回有效的当前计时任务。", response.status);
    }
    if (path === "/task-control/stop" && data?.currentTaskId !== null) {
      throw new SpError("SP_BAD_RESPONSE", "SP 没有确认计时器停止，请重新查询状态。", response.status);
    }
    return data;
  } catch (error) {
    if (writing && (error.status === null || error.status >= 500 || error.code === "SP_BAD_RESPONSE")) {
      error.outcomeUnknown = true;
    }
    throw error;
  } finally {
    // A lost response can follow a committed write. Never keep the old snapshot.
    if (writing) invalidateNotice();
  }
}

export const sp = {
  request,
  status: (sdk, cfg) => request(sdk, cfg, "GET", "/status"),
  focus: (sdk, cfg) => request(sdk, cfg, "GET", "/focus"),
  tasks: (sdk, cfg, query) => request(sdk, cfg, "GET", "/tasks", undefined, query),
  task: (sdk, cfg, id, query) => request(sdk, cfg, "GET", `/tasks/${encodeURIComponent(id)}`, undefined, query),
  createTask: (sdk, cfg, body) => request(sdk, cfg, "POST", "/tasks", body),
  updateTask: (sdk, cfg, id, body) => request(sdk, cfg, "PATCH", `/tasks/${encodeURIComponent(id)}`, body),
  deleteTask: (sdk, cfg, id) => request(sdk, cfg, "DELETE", `/tasks/${encodeURIComponent(id)}`),
  archiveTask: (sdk, cfg, id) => request(sdk, cfg, "POST", `/tasks/${encodeURIComponent(id)}/archive`),
  restoreTask: (sdk, cfg, id) => request(sdk, cfg, "POST", `/tasks/${encodeURIComponent(id)}/restore`),
  startTask: (sdk, cfg, id) => request(sdk, cfg, "POST", `/tasks/${encodeURIComponent(id)}/start`),
  stopTask: (sdk, cfg) => request(sdk, cfg, "POST", "/task-control/stop"),
  currentTask: (sdk, cfg) => request(sdk, cfg, "GET", "/task-control/current"),
  logTime: (sdk, cfg, id, body, method = "POST") =>
    request(sdk, cfg, method, `/tasks/${encodeURIComponent(id)}/time`, body),
  projects: (sdk, cfg, query) => request(sdk, cfg, "GET", "/projects", undefined, query),
  tags: (sdk, cfg, query) => request(sdk, cfg, "GET", "/tags", undefined, query),
};
