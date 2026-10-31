// lib/view.js — 把 SP 的原始任务表整理成「今天 / 过期 / 收件箱」三块视图
// 只在内存里聚合，不落任何任务副本：SP 永远是唯一记录源。
// 日期算法不在这里：统一走 date.js，避免两处实现漂移。

import { SpError, sp } from "./sp.js";
import { dayRange, localDay } from "./date.js";

// 收件箱在 SP 里不是「没有项目」，而是一个真实项目 id。
// 实测：收件箱任务的 projectId === "INBOX_PROJECT"，项目列表里也有它。
const INBOX_PROJECT_ID = "INBOX_PROJECT";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonnegativeMs = (value) => Number.isFinite(value) && value >= 0 ? value : 0;

// 实测的「空值」形状（PATCH 回来会原样存下）：
//   plannedAt: 0    清除旧计划字段（传 null 会 400，只接受 number）
//   dueDay: null    清除计划日（"" 也会被接受并原样存回来）
// 所以读的时候三种都要归一成 null，否则卡片上会多出「0 年前」「1970」这类鬼日期。
const asPlannedAt = (value) => (Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : null);
const asDueDay = (value) => (typeof value === "string" && value ? value : null);
const asCompletionTime = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : null;

/** SP 19.x 的 Today 用 dueWithTime 优先、dueDay 次之；plannedAt 是旧字段。 */
export function taskIsPlannedForDay(task, day = localDay()) {
  if (!isRecord(task)) return false;
  const at = asPlannedAt(task.dueWithTime);
  if (at !== null) {
    const [start, end] = dayRange(day);
    return at >= start && at < end;
  }
  return task.dueDay === day;
}

/** 过了截止时间，或仍留在旧逻辑日的计划，都需要处理；完成任务不再过期。 */
export function taskIsOverdue(task, day = localDay(), at = Date.now()) {
  if (!isRecord(task) || task.isDone === true) return false;
  const deadline = asPlannedAt(task.deadlineWithTime);
  const deadlineDay = asDueDay(task.deadlineDay);
  if (deadline !== null ? deadline < at : deadlineDay !== null && deadlineDay < day) return true;
  const planned = asPlannedAt(task.dueWithTime);
  const plannedDay = asDueDay(task.dueDay);
  return planned !== null ? planned < dayRange(day)[0] : plannedDay !== null && plannedDay < day;
}

/** 任务对模型的统一投影：只留有用字段，不把整条 JSON 抛给模型。 */
export function summarizeTask(task, ctx = {}) {
  if (!isRecord(task)) return null;
  const projectTitle = ctx.projectTitleOf ? ctx.projectTitleOf(task.projectId) : undefined;
  return {
    id: task.id ?? null,
    title: typeof task.title === "string" ? task.title : "",
    notes: typeof task.notes === "string" ? task.notes : undefined,
    notesTruncated: false,
    projectId: task.projectId ?? null,
    project: task.projectId === INBOX_PROJECT_ID ? null : projectTitle ?? null,
    isInbox: task.projectId === INBOX_PROJECT_ID,
    dueDay: asDueDay(task.dueDay),
    dueWithTime: asPlannedAt(task.dueWithTime),
    deadlineDay: asDueDay(task.deadlineDay),
    deadlineWithTime: asPlannedAt(task.deadlineWithTime),
    deadlineRemindAt: asPlannedAt(task.deadlineRemindAt),
    plannedAt: asPlannedAt(task.plannedAt),
    timeEstimate: nonnegativeMs(task.timeEstimate),
    timeSpent: nonnegativeMs(task.timeSpent),
    timeSpentOnDay: isRecord(task.timeSpentOnDay) ? { ...task.timeSpentOnDay } : {},
    isDone: task.isDone === true,
    doneOn: asCompletionTime(task.doneOn),
    wontDoOn: asCompletionTime(task.wontDoOn),
    parentId: typeof task.parentId === "string" && task.parentId ? task.parentId : null,
    subTaskIds: Array.isArray(task.subTaskIds) ? [...task.subTaskIds] : [],
    repeatCfgId: typeof task.repeatCfgId === "string" && task.repeatCfgId ? task.repeatCfgId : null,
    isSubtask: typeof task.parentId === "string" && task.parentId.length > 0,
    hasSubtasks: Array.isArray(task.subTaskIds) && task.subTaskIds.length > 0,
    tagIds: Array.isArray(task.tagIds) ? task.tagIds : [],
    current: ctx.currentTaskId ? task.id === ctx.currentTaskId : false,
  };
}

/** 名称必须完整且唯一；不能因近似匹配或静默回退把任务写到别处。 */
export function resolveNamedEntity(rows, wanted, kind = "project") {
  const label = kind === "tag" ? "标签" : "项目";
  const code = kind === "tag" ? "TAG" : "PROJECT";
  const needle = typeof wanted === "string" ? wanted.trim().toLowerCase() : "";
  const matches = (Array.isArray(rows) ? rows : []).filter((row) =>
    isRecord(row) && typeof row.id === "string" && row.id &&
    needle && String(row.title ?? "").trim().toLowerCase() === needle
  );
  if (!matches.length) throw new SpError(`SP_NO_${code}`, `没找到${label}「${wanted ?? ""}」，请使用已有${label}的完整名称。`);
  if (matches.length > 1) throw new SpError(`SP_AMBIGUOUS_${code}`, `${label}「${wanted}」有多个同名项，请用 id 指定：${matches.map((row) => row.id).join("、")}`);
  return matches[0];
}

/**
 * 把模型/卡片给的宽松输入收成 SP 认的字段。
 * 明确指定的项目或标签解析失败时拒绝操作，未指定项目才使用默认值。
 */
export async function normalizeTaskInput(sdk, cfg, input) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!title) throw new SpError("SP_BAD_INPUT", "任务标题不能为空。");

  const body = { title };
  if (typeof input.notes === "string") body.notes = input.notes;

  for (const key of ["projectId", "projectTitle", "parentId"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim())) {
      throw new SpError("SP_BAD_INPUT", `${key} 必须是非空字符串；不指定时请省略该参数。`);
    }
  }

  if (input.projectId !== undefined && input.projectTitle !== undefined) throw new SpError("SP_BAD_INPUT", "project 与 projectId 请只提供一个。");
  if (input.tags !== undefined && input.tagIds !== undefined) throw new SpError("SP_BAD_INPUT", "tags 与 tagIds 请只提供一个。");
  if (input.tags !== undefined && !Array.isArray(input.tags) || input.tagIds !== undefined && !Array.isArray(input.tagIds)) {
    throw new SpError("SP_BAD_INPUT", "tags/tagIds 必须是数组。");
  }

  if (typeof input.parentId === "string" && input.parentId.trim()) {
    if (input.projectTitle !== undefined || input.projectId !== undefined || input.tags !== undefined || input.tagIds !== undefined) {
      throw new SpError("SP_BAD_INPUT", "子任务继承父任务的项目和标签，不能独立指定。");
    }
    body.parentId = input.parentId.trim();
  } else {
    let projectId = typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : null;
    if (!projectId && typeof input.projectTitle === "string" && input.projectTitle.trim()) {
      const projects = await sp.projects(sdk, cfg);
      projectId = resolveNamedEntity(projects.filter((project) => !project.isArchived), input.projectTitle, "project").id;
    }
    if (input.projectId !== undefined && (!projectId || !(await sp.projects(sdk, cfg)).some((project) => project.id === projectId && !project.isArchived))) {
      throw new SpError("SP_NO_PROJECT", "projectId 对应的项目不存在或已经归档。");
    }
    if (!projectId && cfg.defaultProjectId) {
      const projects = await sp.projects(sdk, cfg);
      if (!projects.some((project) => project.id === cfg.defaultProjectId && !project.isArchived)) {
        throw new SpError("SP_NO_PROJECT", "设置中的默认项目不存在或已经归档，请先修改默认项目。");
      }
      projectId = cfg.defaultProjectId;
    }
    // SP otherwise inherits the currently open UI project and tag.
    body.projectId = projectId || INBOX_PROJECT_ID;
    body.tagIds = [];
  }

  if (Array.isArray(input.tags) && input.tags.length) {
    const tags = await sp.tags(sdk, cfg);
    const ids = [];
    for (const name of input.tags) {
      ids.push(resolveNamedEntity(tags, name, "tag").id);
    }
    if (ids.length) body.tagIds = [...new Set(ids)];
  }
  if (Array.isArray(input.tagIds) && input.tagIds.length) {
    const tags = await sp.tags(sdk, cfg);
    if (input.tagIds.some((id) => typeof id !== "string" || !tags.some((tag) => tag.id === id))) {
      throw new SpError("SP_NO_TAG", "tagIds 包含不存在的标签。");
    }
    body.tagIds = [...new Set(input.tagIds)];
  }

  // SP 的 POST 不带 dueDay 时默认安排到当天；随手记录需显式取消这个默认。
  // 实测唯一能关掉这个默认的办法是显式送空值：dueDay 传 null 或 "" 都落成 null。
  // 所以这里不再省略字段，没有合法 ISO 日期就明确送 null。
  body.dueDay = typeof input.dueDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDay) ? input.dueDay : null;
  if (typeof input.dueWithTime === "number") body.dueWithTime = input.dueWithTime;
  if (typeof input.plannedAt === "number") body.plannedAt = input.plannedAt;
  if (typeof input.timeEstimate === "number" && input.timeEstimate >= 0) body.timeEstimate = input.timeEstimate;

  return body;
}

/** 今天要做的事、已过期、收件箱，外加项目/标签字典与当前计时。 */
export async function buildOverview(sdk, cfg, options = {}) {
  const [rawTasks, projects, tags, currentTask, focus] = await Promise.all([
    sp.tasks(sdk, cfg, options.includeDone ? { includeDone: "true" } : undefined),
    sp.projects(sdk, cfg).catch(() => []),
    sp.tags(sdk, cfg).catch(() => []),
    sp.currentTask(sdk, cfg).catch(() => null),
    sp.focus(sdk, cfg).catch(() => null),
  ]);

  const projectList = (Array.isArray(projects) ? projects : []).filter(isRecord);
  const tagList = (Array.isArray(tags) ? tags : []).filter(isRecord);
  const projectTitleOf = (id) => projectList.find((p) => p.id === id)?.title ?? null;
  const tagTitleOf = (id) => tagList.find((t) => t.id === id)?.title ?? null;
  const ctx = { projectTitleOf, currentTaskId: currentTask?.id ?? null };

  const today = localDay();

  const uniqueTasks = new Map();
  for (const task of Array.isArray(rawTasks) ? rawTasks : []) {
    if (isRecord(task) && typeof task.id === "string" && task.id) uniqueTasks.set(task.id, task);
  }
  const all = [...uniqueTasks.values()].map((task) => ({ raw: task, view: summarizeTask(task, ctx) }));
  const open = all.filter((row) => !row.view.isDone);
  const selected = options.includeDone ? all : open;

  const plannedToday = selected.filter((row) => taskIsPlannedForDay(row.raw, today));
  const overdue = open.filter((row) => taskIsOverdue(row.raw, today));
  const inbox = selected.filter((row) => row.view.isInbox && !row.view.isSubtask);

  const todayRows = new Map();
  for (const row of plannedToday) todayRows.set(row.view.id, row);
  const todayList = [...todayRows.values()];

  // SP 父任务的工时和预估已包含子任务；选中祖先时不能再把后代累加一次。
  const effortRows = todayList.filter((row) => {
    const seen = new Set([row.view.id]);
    let parentId = row.raw.parentId;
    while (typeof parentId === "string" && parentId && !seen.has(parentId)) {
      if (todayRows.has(parentId)) return false;
      seen.add(parentId);
      parentId = uniqueTasks.get(parentId)?.parentId;
    }
    return true;
  });
  const todayEstimate = effortRows.reduce((sum, row) => sum + row.view.timeEstimate, 0);
  const todaySpent = effortRows.reduce((sum, row) => sum + nonnegativeMs(row.raw.timeSpentOnDay?.[today]), 0);

  const decorate = (row) => ({
    ...row.view,
    plannedToday: taskIsPlannedForDay(row.raw, today),
    tags: row.view.tagIds.map((id) => ({ id, title: tagTitleOf(id) })).filter((t) => t.title),
  });

  return {
    day: today,
    generatedAt: new Date().toISOString(),
    today: todayList.map(decorate),
    overdue: overdue.map(decorate).sort((a, b) => String(a.dueDay).localeCompare(String(b.dueDay))),
    inbox: inbox.map(decorate).slice(0, 50),
    ...(options.includeDone ? { completed: all.filter((row) => row.view.isDone).map(decorate) } : {}),
    counts: {
      today: todayList.length,
      overdue: overdue.length,
      inbox: inbox.length,
      open: open.length,
    },
    effort: { todayEstimateMs: todayEstimate, todaySpentMs: todaySpent },
    currentTask: currentTask ? summarizeTask(currentTask, ctx) : null,
    // 只留专注模式本身的状态。曾经在这里投影 focus.timer，但实测它是**专注模式
    // （番茄钟）**的计时器，跟任务计时是两回事：任务正在计时时它依然是 null。
    // 把它当「有没有在计时」的信号会稳定误报，所以拿掉。
    // 任务计时的真实信号只有 currentTask 的 timeSpent / timeSpentOnDay。
    focus: focus
      ? {
          mode: focus.mode ?? null,
          isSessionDone: focus.isSessionDone === true,
        }
      : null,
    projects: projectList.map((p) => ({ id: p.id, title: p.title })),
    tags: tagList.map((t) => ({ id: t.id, title: t.title })),
  };
}
