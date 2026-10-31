// lib/notice.js — 给模型的一句待办摘要
//
// 每轮对话前调用一次，所以这里的每一样东西都要能「来不及就算了」：
// SP 没开、卡住、返回垃圾，一律静默返回空，绝不能让对话卡在这一步。
// 三条约束来自这个位置本身：
//   1. 短超时。800ms 拿不到就当没有。
//   2. 缓存。同一份状态几十秒内不重查，连续几轮内容不变，前缀不动。
//   3. 只在有事可说时返回。今天没事、也没在计时，就什么也不注入。

import { localDay } from "./date.js";
import { taskIsPlannedForDay, taskIsOverdue } from "./view.js";

const NOTICE_BUDGET_MS = 800;
const NOTICE_TTL_MS = 60_000;
const CONFIG_TTL_MS = 30_000;

let noticeCache = { at: 0, day: null, text: "" };
let configCache = { at: 0, cfg: null };
let generation = 0;
let pendingNotice = null;

const now = () => Date.now();
const isCurrent = (context) => context.active && context.generation === generation && now() < context.deadline;

async function quickFetch(sdk, cfg, path, context) {
  if (!cfg.accessToken || !isCurrent(context)) return null;
  try {
    // 必须走 sdk.network.fetch，不能用全局 fetch：
    // 宿主的网络白名单（manifest.network.allowedHosts）只在这条通道上生效，
    // 绕过去会被沙箱拦下，而我又 catch 了异常，结果就是永不生效、也查不到。
    const response = await sdk.network.fetch(cfg.baseUrl + path, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.accessToken}`, Accept: "application/json" },
      timeoutMs: Math.max(1, context.deadline - now()),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload?.ok === false) return null;
    return payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
  } catch {
    return null;
  }
}

async function configFor(sdk, context) {
  if (configCache.cfg && now() - configCache.at < CONFIG_TTL_MS) return configCache.cfg;
  try {
    const all = await sdk.config.getAll();
    if (!isCurrent(context)) return null;
    const cfg = {
      baseUrl: (typeof all?.baseUrl === "string" && all.baseUrl.trim() ? all.baseUrl.trim() : "http://127.0.0.1:3876").replace(/\/+$/, ""),
      accessToken: typeof all?.accessToken === "string" ? all.accessToken.trim() : "",
    };
    if (!cfg.accessToken) {
      // 自动读 token 落在 dataDir 之外，每次都会走宿主资源通道，别每轮都做。
      const { autoReadToken } = await import("./token.js");
      if (!isCurrent(context)) return null;
      const auto = await autoReadToken(sdk);
      if (auto.token) cfg.accessToken = auto.token;
    }
    if (!isCurrent(context)) return null;
    configCache = { at: now(), cfg };
    return cfg;
  } catch {
    return null;
  }
}

function describe(overview) {
  const { open = 0, today = 0, overdue = 0 } = overview.counts ?? {};
  const current = overview.current ?? null;
  if (!open && !current) return "";

  const bits = [];
  if (today > 0) bits.push(`今天 ${today} 件${overdue > 0 ? `（待办中 ${overdue} 件已过期）` : ""}`);
  else if (overdue > 0) bits.push(`今天没安排，另有 ${overdue} 件已过期`);
  else if (open > 0) bits.push(`今天没安排，待办共 ${open} 件`);

  if (current?.title) bits.push(`正在计时「${current.title}」`);
  if (!bits.length) return "";
  return `[任务台] ${bits.join("，")}。这是应用读到的当前状态，不是用户说的话。`;
}

/**
 * 读一眼 SP，压成一句话。拿不到就返回空字符串。
 * 结果缓存 NOTICE_TTL_MS，避免每轮都打一次接口。
 */
async function collectNotice(sdk, today, context) {
  const cfg = await configFor(sdk, context);
  if (!cfg) return "";

  const [tasks, current] = await Promise.all([
    quickFetch(sdk, cfg, "/tasks", context),
    quickFetch(sdk, cfg, "/task-control/current", context),
  ]);
  if (!Array.isArray(tasks) || !isCurrent(context) || localDay() !== today) {
    // 接口不通时沿用上一份摘要会更糟：那是过期状态。什么都不说。
    return "";
  }

  const uniqueTasks = new Map();
  for (const task of tasks) {
    if (task && typeof task === "object" && !Array.isArray(task) && typeof task.id === "string" && task.id) {
      uniqueTasks.set(task.id, task);
    }
  }
  const open = [...uniqueTasks.values()].filter((task) => task.isDone !== true);

  let todayCount = 0;
  let overdueCount = 0;
  for (const task of open) {
    if (taskIsOverdue(task, today)) overdueCount += 1;
    if (taskIsPlannedForDay(task, today)) todayCount += 1;
  }

  const text = describe({
    counts: { open: open.length, today: todayCount, overdue: overdueCount },
    current: current && typeof current.title === "string" ? { title: current.title } : null,
  });

  noticeCache = { at: now(), day: today, text };
  return text;
}

export async function readNotice(sdk) {
  const today = localDay();
  if (noticeCache.day === today && now() - noticeCache.at < NOTICE_TTL_MS) return noticeCache.text;
  if (pendingNotice?.generation === generation && pendingNotice.day === today) return pendingNotice.promise;

  const context = { generation, deadline: now() + NOTICE_BUDGET_MS, active: true };
  const pending = { generation, day: today, promise: null };
  let timer;
  // 预算覆盖配置读取、自动取 token 和 JSON 解码，宿主没有兑现 fetch 超时时也能退出。
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      context.active = false;
      resolve("");
    }, NOTICE_BUDGET_MS);
  });
  pending.promise = Promise.race([collectNotice(sdk, today, context), timeout])
    .catch(() => "")
    .finally(() => {
      clearTimeout(timer);
      context.active = false;
      if (pendingNotice === pending) pendingNotice = null;
    });
  pendingNotice = pending;
  return pending.promise;
}

/** 测试用：清掉缓存，让下一次读真的去打接口。 */
export function resetNoticeCache() {
  invalidateNotice();
}

/**
 * 写操作之后必须调这个。
 *
 * 只靠 TTL 过期是错的：你在对话里建了一条任务，下一轮注入的还会是
 * 「待办共 1 件」，比不注入更糟——那是个确定的错答案。
 * 任何改动 SP 的调用成功后都要打一下，让下一轮重新读。
 */
export function invalidateNotice() {
  generation += 1;
  noticeCache = { at: 0, day: null, text: "" };
  configCache = { at: 0, cfg: null };
  pendingNotice = null;
}
