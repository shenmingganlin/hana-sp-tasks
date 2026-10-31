import { SpError, sp } from "./sp.js";
import { resolveDay } from "./date.js";
import { invalidateNotice } from "./notice.js";
import { registerAppTool } from "./tool-registration.js";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const PRESETS = [
  "DAILY", "WEEKLY_CURRENT_WEEKDAY", "MONTHLY_CURRENT_DATE", "MONTHLY_FIRST_DAY",
  "MONTHLY_LAST_DAY", "MONTHLY_NTH_WEEKDAY", "MONDAY_TO_FRIDAY", "YEARLY_CURRENT_DATE", "CUSTOM",
];
const CYCLES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const SCHEDULE_KEYS = ["quickSetting", "startDate", "repeatCycle", "repeatEvery", ...WEEKDAYS];
const REPEAT_KEYS = [...SCHEDULE_KEYS, "isPaused", "skipOverdue"];
const NOTE_KEYS = ["content", "projectId", "isPinnedToToday"];
const paginationProperties = {
  limit: { type: "integer", minimum: 1, maximum: 200, description: "list 每页数量，默认 50。" },
  offset: { type: "integer", minimum: 0, description: "list 起始位置，默认 0；按 nextOffset 继续。" },
};

function invalid(message) {
  throw new SpError("SP_BAD_INPUT", message);
}

function checkAction(args, actions) {
  if (!args || typeof args !== "object" || Array.isArray(args)) invalid("参数必须是对象。");
  if (!actions.includes(args.action)) invalid(`action 只能是 ${actions.join(" / ")}。`);
}

function only(args, keys) {
  const allowed = new Set(["action", ...keys]);
  const extra = Object.keys(args).filter((key) => !allowed.has(key));
  if (extra.length) invalid(`${args.action} 不接受参数：${extra.join("、")}。`);
}

function text(value, key, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && !value.trim())) invalid(`${key} 必须是${empty ? "" : "非空"}字符串。`);
  return value;
}

function id(value, key) {
  const result = text(value, key).trim();
  if (result === "." || result === ".." || /[\\/]/.test(result)) invalid(`${key} 不能是路径或包含路径分隔符。`);
  return result;
}

function boolean(value, key) {
  if (typeof value !== "boolean") invalid(`${key} 必须是布尔值。`);
  return value;
}

function integer(value, key, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${key} 必须是 ${min} 到 ${max} 的整数。`);
  return value;
}

function date(value, key) {
  text(value, key);
  const parsed = resolveDay(value);
  if (!parsed.ok) throw new SpError("SP_BAD_DATE", parsed.error);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.day) || parsed.day < "1000-01-01") {
    throw new SpError("SP_BAD_DATE", `${key} 必须在 1000-01-01 到 9999-12-31 之间。`);
  }
  return parsed.day;
}

function pageOptions(args) {
  return {
    limit: args.limit === undefined ? 50 : integer(args.limit, "limit", 1, 200),
    offset: args.offset === undefined ? 0 : integer(args.offset, "offset", 0),
  };
}

function page(rows, key, { offset, limit }) {
  if (!Array.isArray(rows)) throw new SpError("SP_BAD_RESPONSE", "SP 列表响应格式不正确。");
  const items = rows.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < rows.length;
  return { [key]: items, total: rows.length, count: items.length, offset, hasMore, nextOffset: hasMore ? nextOffset : null };
}

function badResponse(message, writing = false) {
  const error = new SpError("SP_BAD_RESPONSE", message);
  if (writing) error.outcomeUnknown = true;
  throw error;
}

function entity(value, writing = false, expectedId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !value.id.trim()) {
    badResponse("SP 对象响应格式不正确。", writing);
  }
  if (expectedId !== undefined && value.id !== expectedId) badResponse("SP 返回的对象 ID 与请求不符，无法确认结果。", writing);
  return value;
}

function deletion(value, expectedId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.deleted !== true || value.id !== expectedId) {
    badResponse("SP 没有确认删除请求中的对象，请先查询确认结果。", true);
  }
  return value;
}

async function write(sdk, cfg, method, path, body) {
  try {
    return await sp.request(sdk, cfg, method, path, body);
  } finally {
    // A lost response can still mean a successful write; never retain the old snapshot.
    invalidateNotice();
  }
}

function repeatBody(args) {
  const body = {};
  if (args.quickSetting !== undefined) {
    if (!PRESETS.includes(args.quickSetting)) invalid(`quickSetting 只能是 ${PRESETS.join(" / ")}。`);
    body.quickSetting = args.quickSetting;
  }
  if (args.startDate !== undefined) body.startDate = date(args.startDate, "startDate");
  if (args.repeatCycle !== undefined) {
    if (!CYCLES.includes(args.repeatCycle)) invalid(`repeatCycle 只能是 ${CYCLES.join(" / ")}。`);
    body.repeatCycle = args.repeatCycle;
  }
  if (args.repeatEvery !== undefined) body.repeatEvery = integer(args.repeatEvery, "repeatEvery", 1, 1000);
  for (const key of [...WEEKDAYS, "isPaused", "skipOverdue"]) {
    if (args[key] !== undefined) body[key] = boolean(args[key], key);
  }
  const hasCustom = ["repeatCycle", "repeatEvery", ...WEEKDAYS].some((key) => body[key] !== undefined);
  if (hasCustom && body.quickSetting !== "CUSTOM") invalid("repeatCycle、repeatEvery 和星期字段只能与 quickSetting: CUSTOM 一起使用。");
  if (args.action === "update" && SCHEDULE_KEYS.some((key) => body[key] !== undefined) && body.quickSetting === undefined) {
    invalid("修改重复日程必须同时指定 quickSetting；暂停/恢复只需 isPaused。");
  }
  if (args.action === "update" && !Object.keys(body).length) invalid("没有给出要修改的重复规则字段。");
  return body;
}

export async function registerFeatureTools(sdk, { guard, ok }) {
  await registerAppTool(sdk, {
    name: "sp_tasks_repeat",
    description:
      "管理 SP 重复任务规则：list/get 查询，create 把已有顶层任务设为重复任务，update 改日程或暂停/恢复，delete 取消重复规则（保留任务）。" +
      "先查询取得 taskId/repeatCfgId，不猜 id。create 默认每天；每周三可用 WEEKLY_CURRENT_WEEKDAY 加 startDate: 下周三。" +
      "CUSTOM 可指定 repeatCycle/repeatEvery 和七个星期布尔值；要限定星期，请明确写全七天。" +
      "接口不支持改规则标题、时刻、提醒、repeatUntilDay 等高级字段。创建失败或响应丢失时先查询确认，不直接重建。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete"] },
        repeatCfgId: { type: "string", description: "get/update/delete 的规则 ID，先 list 查询。" },
        taskId: { type: "string", description: "create 的已有顶层任务 ID；子任务和关联外部 issue 的任务不能重复。" },
        projectId: { type: "string", description: "仅 list：按已有项目 ID 筛选。" },
        quickSetting: { type: "string", enum: PRESETS, description: "日程预设；修改日程时必填。" },
        startDate: { type: "string", description: "起始日期，支持今天、下周三、YYYY-MM-DD；创建时不得早于任务计划日或今天。" },
        repeatCycle: { type: "string", enum: CYCLES, description: "仅 CUSTOM：重复周期。" },
        repeatEvery: { type: "integer", minimum: 1, maximum: 1000, description: "仅 CUSTOM：每几个周期重复。" },
        ...Object.fromEntries(WEEKDAYS.map((key) => [key, { type: "boolean", description: `仅 CUSTOM：${key} 是否重复。` }])),
        isPaused: { type: "boolean", description: "true 暂停，false 恢复；无需修改日程。" },
        skipOverdue: { type: "boolean", description: "是否跳过已错过的重复实例。" },
        ...paginationProperties,
      },
      required: ["action"],
    },
    execute: guard(async (args, cfg) => {
      checkAction(args, ["list", "get", "create", "update", "delete"]);
      if (args.action === "list") {
        only(args, ["projectId", "offset", "limit"]);
        const options = pageOptions(args);
        const query = args.projectId === undefined ? undefined : { projectId: id(args.projectId, "projectId") };
        return ok(page(await sp.request(sdk, cfg, "GET", "/task-repeat-cfgs", undefined, query), "repeatConfigs", options));
      }
      if (args.action === "create") {
        only(args, ["taskId", ...REPEAT_KEYS]);
        const body = { taskId: id(args.taskId, "taskId"), ...repeatBody(args) };
        return ok({ repeatConfig: entity(await write(sdk, cfg, "POST", "/task-repeat-cfgs", body), true) });
      }
      only(args, args.action === "update" ? ["repeatCfgId", ...REPEAT_KEYS] : ["repeatCfgId"]);
      const repeatCfgId = id(args.repeatCfgId, "repeatCfgId");
      const path = `/task-repeat-cfgs/${encodeURIComponent(repeatCfgId)}`;
      if (args.action === "get") return ok({ repeatConfig: entity(await sp.request(sdk, cfg, "GET", path), false, repeatCfgId) });
      if (args.action === "update") return ok({ repeatConfig: entity(await write(sdk, cfg, "PATCH", path, repeatBody(args)), true, repeatCfgId) });
      return ok({ result: deletion(await write(sdk, cfg, "DELETE", path), repeatCfgId) });
    }),
  });

  await registerAppTool(sdk, {
    name: "sp_tasks_notes",
    description:
      "管理 SP 独立笔记（不是任务的 notes 备注）：list/get 读取，create 新建，update 修改，delete 删除。" +
      "新笔记须指定已有 projectId 或 isPinnedToToday: true。移动项目必须单独 update，只传 noteId/projectId。" +
      "get 返回完整正文；list 支持分页。写入结果不确定时先读回确认，不自动重新 create。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete"] },
        noteId: { type: "string", description: "get/update/delete 的笔记 ID，先 list 查询。" },
        content: { type: "string", description: "完整笔记正文；create 必须非空，update 会替换全文。" },
        projectId: { type: ["string", "null"], description: "list 筛选或 create/update 指定已有项目 ID；仅 create 接受 null。" },
        isPinnedToToday: { type: "boolean", description: "固定到今天；没有项目的笔记必须保持 true。" },
        ...paginationProperties,
      },
      required: ["action"],
    },
    execute: guard(async (args, cfg) => {
      checkAction(args, ["list", "get", "create", "update", "delete"]);
      if (args.action === "list") {
        only(args, ["projectId", "offset", "limit"]);
        const options = pageOptions(args);
        const query = args.projectId === undefined ? undefined : { projectId: id(args.projectId, "projectId") };
        return ok(page(await sp.request(sdk, cfg, "GET", "/notes", undefined, query), "notes", options));
      }
      const create = args.action === "create";
      only(args, create ? NOTE_KEYS : args.action === "update" ? ["noteId", ...NOTE_KEYS] : ["noteId"]);
      const noteId = create ? undefined : id(args.noteId, "noteId");
      const path = create ? "/notes" : `/notes/${encodeURIComponent(noteId)}`;
      if (args.action === "get") return ok({ note: entity(await sp.request(sdk, cfg, "GET", path), false, noteId) });
      if (args.action === "delete") return ok({ result: deletion(await write(sdk, cfg, "DELETE", path), noteId) });
      const body = {};
      if (create || args.content !== undefined) body.content = text(args.content, "content", { empty: !create });
      if (args.projectId !== undefined) body.projectId = create && args.projectId === null ? null : id(args.projectId, "projectId");
      if (args.isPinnedToToday !== undefined) body.isPinnedToToday = boolean(args.isPinnedToToday, "isPinnedToToday");
      if (create && !body.projectId && body.isPinnedToToday !== true) invalid("新笔记必须指定 projectId 或 isPinnedToToday: true。");
      if (!create && !Object.keys(body).length) invalid("没有给出要修改的笔记字段。");
      if (!create && body.projectId !== undefined && (body.content !== undefined || body.isPinnedToToday !== undefined)) {
        invalid("移动笔记请单独 update projectId，再修改正文或固定状态。");
      }
      return ok({ note: entity(await write(sdk, cfg, create ? "POST" : "PATCH", path, body), true, noteId) });
    }),
  });

  await registerAppTool(sdk, {
    name: "sp_tasks_counters",
    description:
      "读取 SP 已有习惯/计数器并记录数值：list/get 查询，set 覆盖某一天的值，increment 给今天增加正整数（默认 1）。" +
      "先查询 counterId 和 type；StopWatch 的 value 单位是毫秒且不能 increment。set 的 day 默认由 SP 决定今天，不能写未来日期。" +
      "不支持创建、删除或修改计数器配置。increment 结果不确定时先 get 确认，禁止盲目重试以免重复累计。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "get", "set", "increment"] },
        counterId: { type: "string", description: "get/set/increment 的已有计数器 ID。" },
        day: { type: "string", description: "仅 set：今天、昨天或 YYYY-MM-DD；不给则用 SP 今天。" },
        value: { type: "integer", minimum: 0, description: "仅 set 必填：该日累计值；StopWatch 为毫秒，其他类型为次数。" },
        by: { type: "integer", minimum: 1, description: "仅 increment：增加的正整数，默认 1。" },
        ...paginationProperties,
      },
      required: ["action"],
    },
    execute: guard(async (args, cfg) => {
      checkAction(args, ["list", "get", "set", "increment"]);
      if (args.action === "list") {
        only(args, ["offset", "limit"]);
        const options = pageOptions(args);
        return ok(page(await sp.request(sdk, cfg, "GET", "/simple-counters"), "counters", options));
      }
      only(args, args.action === "set" ? ["counterId", "day", "value"] : args.action === "increment" ? ["counterId", "by"] : ["counterId"]);
      const counterId = id(args.counterId, "counterId");
      const path = `/simple-counters/${encodeURIComponent(counterId)}`;
      if (args.action === "get") return ok({ counter: entity(await sp.request(sdk, cfg, "GET", path), false, counterId) });
      if (args.action === "set") {
        const body = { value: integer(args.value, "value", 0) };
        if (args.day !== undefined) body.date = date(args.day, "day");
        return ok({ counter: entity(await write(sdk, cfg, "PUT", `${path}/value`, body), true, counterId) });
      }
      const body = { by: args.by === undefined ? 1 : integer(args.by, "by", 1) };
      return ok({ counter: entity(await write(sdk, cfg, "POST", `${path}/increment`, body), true, counterId) });
    }),
  });
}
