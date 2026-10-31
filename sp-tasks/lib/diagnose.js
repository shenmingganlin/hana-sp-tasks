// lib/diagnose.js — 诊断「为什么没连上」
//
// 这里只做诊断，不做安装。用户要装 SP 就自己去装，装完回来点一下检测。
// 每一项都要能回答「没通的话我该去点什么」，否则这条信息没有用。
//
// 判断顺序按真实故障率排：
//   1. 找不找得到 SP 的数据目录   → 没装，或者装了个不写这个目录的版本
//   2. 找不找得到 token 文件     → 装了，但本地 REST API 没打开
//   3. token 连不连得上 /health  → 打开了，但服务没起来 / 端口被占
//   4. 连上了但读不到任务         → token 不对，或者 SP 数据还没加载完

import { roamingRoots, SP_DATA_DIR_NAMES } from "./token.js";

const PROBE_TIMEOUT_MS = 1500;

async function readText(sdk, path) {
  try {
    const result = await sdk.resources.read({ kind: "local-file", path });
    if (typeof result === "string") return { ok: true, text: result };
    if (result && typeof result === "object") {
      for (const key of ["content", "text", "data", "body"]) {
        if (typeof result[key] === "string") return { ok: true, text: result[key] };
        if (result[key] && typeof result[key].length === "number") {
          return { ok: true, text: Buffer.from(result[key]).toString("utf8") };
        }
      }
    }
    if (result && typeof result.length === "number") {
      return { ok: true, text: Buffer.from(result).toString("utf8") };
    }
    return { ok: false, reason: "读到了但拿不到文本" };
  } catch (error) {
    const message = String(error?.message ?? error);
    const missing = /ENOENT|not found|不存在|no such file/i.test(message);
    return { ok: false, reason: missing ? "文件不存在" : message.slice(0, 160) };
  }
}

/** 诊断与取 token 共用候选路径，包括宿主清空环境变量时的 homedir 兜底。 */
export const candidateRoots = roamingRoots;

/**
 * 找 SP 的数据目录。roots 可注入，否则只能依赖本机环境变量，写不出可重复的测试。
 */
export async function findInstall(sdk, roots = candidateRoots()) {
  const tried = [];
  for (const root of roots) {
    for (const dir of SP_DATA_DIR_NAMES) {
      const base = `${root}\\${dir}`;
      // Preferences 是这个目录里一定存在的小文件，用它判断「目录在不在」，
      // 比试读 token 准：token 只在 API 打开后才有。
      const probe = await readText(sdk, `${base}\\Preferences`);
      if (probe.ok) return { found: true, dataDir: base, tried };
      tried.push(`${base}：${probe.reason}`);
    }
  }
  return { found: false, dataDir: null, tried };
}

async function probe(sdk, cfg, path) {
  const started = Date.now();
  try {
    const response = await sdk.network.fetch(cfg.baseUrl + path, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.accessToken}`, Accept: "application/json" },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - started;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const validEnvelope = payload !== null && typeof payload === "object" &&
      !Array.isArray(payload) && typeof payload.ok === "boolean" &&
      (payload.ok === false || Object.prototype.hasOwnProperty.call(payload, "data"));
    const validData = path === "/health"
      ? payload?.data?.server === "up" && typeof payload.data.rendererReady === "boolean"
      : Array.isArray(payload?.data);
    const ok = response.ok && validEnvelope && payload.ok === true && validData;
    return {
      ok,
      status: response.status,
      latencyMs,
      data: ok ? payload.data : null,
      error: ok ? null : payload?.error?.message ?? (response.ok ? "接口响应格式不正确" : `HTTP ${response.status}`),
      code: payload?.error?.code ?? (response.ok && (!validEnvelope || !validData) ? "SP_BAD_RESPONSE" : null),
    };
  } catch (error) {
    const message = String(error?.message ?? error);
    const blocked = error?.code === "PLUGIN_NETWORK_NOT_DECLARED" || error?.code === "PLUGIN_NETWORK_HOST_NOT_ALLOWED" ||
      /PLUGIN_NETWORK_NOT_DECLARED|PLUGIN_NETWORK_HOST|not allowed/i.test(message);
    const refused = /ECONNREFUSED|EHOSTUNREACH|fetch failed|Failed to fetch/i.test(message);
    const timedOut = error?.code === "PLUGIN_NETWORK_TIMEOUT" || /timed out|timeout/i.test(message);
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      data: null,
      error: blocked ? "宿主网络白名单拦下了请求" : timedOut ? "接口响应超时" : refused ? "连不上这个地址，服务没有在监听" : message.slice(0, 160),
      code: blocked ? "SP_NETWORK_BLOCKED" : timedOut ? "SP_TIMEOUT" : refused ? "SP_UNREACHABLE" : "SP_NETWORK_ERROR",
    };
  }
}

function failureNext(result, fallback) {
  if (result.code === "SP_NETWORK_BLOCKED") return "检查应用的网络权限和白名单，允许访问所填的本机地址。";
  if (result.status === 401) return "令牌不对。到 SP 设置里重新复制一份，填进本应用设置。";
  if (result.code === "API_DISABLED") return "到 SP「设置 → 杂项」把本地 REST API 打开，再点重新检测。";
  if (result.code === "APP_NOT_READY") return "SP 还在加载数据，等它启动完成后再点重新检测。";
  if (result.code === "SP_BAD_RESPONSE") return "这个地址没有返回预期的 SP 接口数据。检查端口是否正确，以及 SP 是否已更新或加载完成。";
  if (result.code === "SP_TIMEOUT") return "SP 没有及时回应。确认它没有卡住，稍后再点重新检测。";
  if (result.code === "SP_UNREACHABLE") return "SP 没在运行，或者本地 REST API 没打开。先确认 SP 开着。";
  return fallback;
}

/**
 * 跑一次完整诊断。永远返回结果，不抛错——诊断页最不该做的就是自己也崩掉。
 */
export async function diagnose(sdk, cfg, options = {}) {
  const install = await findInstall(sdk, options.roots);
  const steps = [];

  steps.push({
    id: "install",
    label: "自动定位 Super Productivity 数据目录（辅助检查）",
    ok: install.found,
    optional: true,
    detail: install.found ? install.dataDir : "没在常见位置找到",
    // 找不到时给出可执行的下一步，而不是一句「未安装」。
    next: install.found
      ? null
      : "没有定位到常见数据目录；若接口检查通过，仍可正常使用。使用便携版或自定义目录时可手动填令牌。",
    tried: install.found ? undefined : install.tried,
  });

  const hasToken = Boolean(cfg.accessToken);
  steps.push({
    id: "token",
    label: "拿到本地接口的访问令牌",
    ok: hasToken,
    detail: hasToken
      ? cfg.tokenSource === "settings" ? "用的是设置里手填的那份" : "自动从 SP 数据目录读到"
      : "没有可用的令牌",
    next: hasToken
      ? null
      : "打开 SP，进「设置 → 杂项」，把本地 REST API 打开。打开后它会自动生成令牌，回来点重新检测。",
  });

  let health = { ok: false, error: "没有令牌，跳过连接测试" };
  let tasks = null;
  if (hasToken) {
    health = await probe(sdk, cfg, "/health");
    steps.push({
      id: "health",
      label: "接口有响应",
      ok: health.ok,
      detail: health.ok
        ? `响应 ${health.latencyMs}ms`
        : health.error ?? "没有响应",
      next: health.ok
        ? null
        : failureNext(health, "检查上面的地址是不是 SP 正在用的那个端口。"),
    });

    if (health.ok) {
      const read = await probe(sdk, cfg, "/tasks");
      const readable = read.ok && Array.isArray(read.data);
      tasks = readable ? read.data : null;
      steps.push({
        id: "read",
        label: "能读到任务",
        ok: readable,
        detail: readable ? `当前 ${read.data.length} 条任务` : read.error ?? "接口响应格式不正确：任务列表必须是数组",
        next: readable
          ? null
          : failureNext(read, "SP 可能还在加载数据，等几秒再试。"),
      });
    }
  }

  const failed = steps.filter((step) => !step.ok && !step.optional);
  return {
    ok: failed.length === 0,
    baseUrl: cfg.baseUrl,
    verdict: failed.length === 0
      ? "连接正常"
      : !hasToken
        ? "没有取得访问令牌"
        : "本地接口未连接成功",
    steps,
    taskCount: tasks ? tasks.length : null,
    downloadUrl: "https://super-productivity.com/",
  };
}
