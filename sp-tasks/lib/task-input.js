import { SpError } from "./sp.js";
import { localDay, resolveDay, resolveDuration, resolveMoment } from "./date.js";

export const dateProperties = {
  dueDay: { type: "string", description: "计划执行日（SP dueDay，旧版误称截止日）：今天/明天/下周三/2026-11-15；none 清除计划。真正截止请用 deadlineDay。" },
  dueWithTime: { type: "string", description: "计划执行时间，如明天 9:30；none 清除具体时刻。" },
  deadlineDay: { type: "string", description: "真正截止日，如下周三；none 清除截止日和截止时刻。独立于计划执行日。" },
  deadlineWithTime: { type: "string", description: "真正截止时间，如明天 17:00；none 清除截止日和截止时刻。与 deadlineDay 二选一。" },
  timeEstimate: { type: "string", description: "预估时长，如 45m / 1h30m / 90（分钟）。" },
};

const supplied = (args, key) => args[key] !== undefined;
const cleared = (value) => typeof value === "string" && value.trim().toLowerCase() === "none";
const parse = (fn, value) => {
  const result = fn(value);
  if (!result.ok) throw new SpError("SP_BAD_DATE", result.error);
  return result;
};

export function taskDateFields(args, { todayFlag } = {}) {
  const patch = {};
  if (supplied(args, "dueDay") && supplied(args, "dueWithTime")) {
    throw new SpError("SP_BAD_INPUT", "dueDay 与 dueWithTime 请只提供一个，以免计划日期冲突。");
  }
  if (todayFlag && supplied(args, todayFlag) && (supplied(args, "dueDay") || supplied(args, "dueWithTime"))) {
    throw new SpError("SP_BAD_INPUT", `${todayFlag} 与计划日期请只提供一种。截止日可以单独设置。`);
  }
  if (supplied(args, "deadlineDay") && supplied(args, "deadlineWithTime")) {
    throw new SpError("SP_BAD_INPUT", "deadlineDay 与 deadlineWithTime 请只提供一个。");
  }
  if (supplied(args, "dueDay")) {
    const day = cleared(args.dueDay) ? null : parse(resolveDay, args.dueDay).day;
    Object.assign(patch, { dueDay: day, dueWithTime: null });
  }
  if (supplied(args, "dueWithTime")) {
    if (cleared(args.dueWithTime)) patch.dueWithTime = null;
    else {
      const moment = parse(resolveMoment, args.dueWithTime);
      // SP stores either an all-day plan or a timestamp; its day offset applies to the timestamp.
      Object.assign(patch, { dueDay: null, dueWithTime: moment.ms });
    }
  }
  if (todayFlag && supplied(args, todayFlag)) {
    if (typeof args[todayFlag] !== "boolean") throw new SpError("SP_BAD_INPUT", `${todayFlag} 必须是布尔值。`);
    const day = args[todayFlag] ? localDay() : null;
    Object.assign(patch, { dueDay: day, dueWithTime: null });
  }
  for (const key of ["deadlineDay", "deadlineWithTime"]) {
    if (!supplied(args, key)) continue;
    if (cleared(args[key])) Object.assign(patch, { deadlineDay: null, deadlineWithTime: null, deadlineRemindAt: null });
    else if (key === "deadlineDay") patch.deadlineDay = parse(resolveDay, args[key]).day;
    else patch.deadlineWithTime = parse(resolveMoment, args[key]).ms;
  }
  if (supplied(args, "timeEstimate")) {
    const duration = resolveDuration(args.timeEstimate);
    if (!duration.ok) throw new SpError("SP_BAD_DURATION", duration.error);
    if (duration.ms !== null) patch.timeEstimate = duration.ms;
  }
  return patch;
}

export function taskIds(value) {
  if (!Array.isArray(value) || !value.length || value.some((id) => typeof id !== "string" || !id.trim() || /[/\\]/.test(id) || [".", ".."].includes(id.trim()))) {
    throw new SpError("SP_BAD_INPUT", "taskIds 必须是非空的任务 id 数组。先查询，不能猜 id。");
  }
  return [...new Set(value.map((id) => id.trim()))];
}

export function pageOf(list, args = {}) {
  const limit = args.limit ?? 30;
  const offset = args.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new SpError("SP_BAD_INPUT", "limit 必须为 1-200 的整数，offset 必须为非负整数。");
  }
  const rows = list.slice(offset, offset + limit);
  const hasMore = offset + rows.length < list.length;
  return { rows, count: rows.length, total: list.length, offset, hasMore, nextOffset: hasMore ? offset + rows.length : null };
}
