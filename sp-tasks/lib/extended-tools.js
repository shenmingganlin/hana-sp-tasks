import { SpError } from "./sp.js";
import { invalidateNotice } from "./notice.js";
import { validateCommand } from "./bridge-protocol.js";
import { registerAppTool } from "./tool-registration.js";
import { versionAtLeast } from "./capabilities.js";

export const EXTENDED_CAPABILITIES = [
  { id: "counter_config", label: "计数器配置", description: "修改已有计数器名称、图标、启用和按钮显示；明确确认后删除计数器及历史。秒表和提醒计数器可配置，不能改类型，不直接设置 isOn；禁用会暂停计数，重新启用可能继续。SP 19.3.1 的插件创建路径无法保证持久重放，因此不开放新建。", requires: "bridge", tools: ["sp_tasks_counter_config"], minimumPluginVersion: "0.3.0" },
  { id: "workspace", label: "任务排序与定位", description: "查询及重排项目普通任务或父任务的完整子任务列表；查看或打开选中任务详情。保留任务集合和积压区，不移动任务或启动计时。", requires: "bridge", tools: ["sp_tasks_workspace"], minimumPluginVersion: "0.3.0" },
  { id: "reparent", label: "更换叶任务父项", description: "仅同项目活动叶任务和顶层父任务；项目积压区必须为空，相关任务无重复规则、父子及标签关系完整，新父任务与子任务完成状态相同。被移动任务、原新父任务及其全部后代的工时和估时必须为零，不迁移计时历史。可更换父项或解除父项，保留其他关系。", requires: "bridge", tools: ["sp_tasks_workspace"], minimumPluginVersion: "0.3.0" },
];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => { throw new SpError("SP_BAD_INPUT", message); };
const badResponse = (writing) => {
  const error = new SpError("SP_BRIDGE_BAD_RESPONSE", "SP 插件没有确认请求的完整结果，请先查询状态再决定是否重试。");
  if (writing) error.outcomeUnknown = true;
  throw error;
};
function only(args, allowed) {
  if (!record(args)) fail("参数必须是对象。");
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length) fail(`此操作不接受参数 ${extra.join("、")}。`);
}
function exactId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && value === value.trim() && !/[\u0000-\u001f\u007f\\/]/.test(value) && ![".", ".."].includes(value);
}
function taskIds(value) { return Array.isArray(value) && value.length <= 200 && value.every(exactId) && new Set(value).size === value.length; }
function count(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`分页参数必须是 ${min} 到 ${max} 的整数。`);
  return value;
}
async function invoke(bridge, op, args) {
  try { validateCommand(op, args); } catch (cause) { fail(cause?.message || "不支持的操作参数。"); }
  let status;
  try { status = await bridge.status(); }
  catch { throw new SpError("SP_BRIDGE_UNAVAILABLE", "无法确认 SP 配套插件连接，请在任务台设置中检查连接。"); }
  if (status?.enabled !== true || status?.running !== true || status?.connected !== true || status?.available === false || status?.accepting === false || status?.stopping === true || status?.error || status?.protocol !== 1) throw new SpError("SP_BRIDGE_NOT_CONNECTED", "先在任务台设置中连接 SP 配套插件，并确认服务正常运行。");
  if (!versionAtLeast(status.pluginVersion, "0.3.0")) throw new SpError("SP_BRIDGE_UPGRADE_REQUIRED", "这项功能需要 SP 配套插件 0.3.0 或更新正式版，请先升级插件。");
  const writing = !op.endsWith(".list");
  try { return await bridge.execute(op, args); }
  catch (cause) {
    const error = new SpError(cause?.code || "SP_BRIDGE_ERROR", String(cause?.message || "SP 配套插件调用失败。"));
    if (cause?.outcomeUnknown === true) error.outcomeUnknown = true;
    if (typeof cause?.createdId === "string") error.createdId = cause.createdId;
    throw error;
  } finally { if (writing) invalidateNotice(); }
}
function projectCounter(value, writing) {
  if (!record(value) || !exactId(value.id) || typeof value.title !== "string" || !["ClickCounter", "StopWatch", "RepeatedCountdownReminder"].includes(value.type) || typeof value.isEnabled !== "boolean" || typeof value.isHideButton !== "boolean" || typeof value.isOn !== "boolean" || value.icon !== null && typeof value.icon !== "string" || !Number.isSafeInteger(value.trackedDays) || value.trackedDays < 0) badResponse(writing);
  return { id: value.id, title: value.title, type: value.type, icon: value.icon, isEnabled: value.isEnabled, isHideButton: value.isHideButton, isOn: value.isOn, trackedDays: value.trackedDays };
}
function orderResult(value, args, writing) {
  if (!record(value) || value.contextType !== args.contextType || value.contextId !== args.contextId || !taskIds(value.taskIds) || !taskIds(value.backlogTaskIds) || value.taskIds.some((id) => value.backlogTaskIds.includes(id)) || writing && (typeof value.unchanged !== "boolean" || JSON.stringify(value.taskIds) !== JSON.stringify(args.taskIds))) badResponse(writing);
  return { contextType: value.contextType, contextId: value.contextId, taskIds: value.taskIds, backlogTaskIds: value.backlogTaskIds, ...(writing ? { unchanged: value.unchanged } : {}) };
}

export async function registerExtendedTools(sdk, { bridge, guard, ok }) {
  await registerAppTool(sdk, {
    name: "sp_tasks_counter_config",
    description: "需要 SP 配套插件 0.3.0。查询已有计数器配置；update 可改标题、图标、启用和按钮显示，不改类型或历史数值，不直接设置 isOn；禁用会暂停计数，重新启用可能继续。记录数值仍用 sp_tasks_counters。delete 会删除全部历史，必须用户明确要求，并填写当前完整 confirmTitle 和 allowHistoryDelete:true；运行中计数器不能删除。公开创建路径无法保证持久重放，本工具不提供create，请在SP中创建。",
    parameters: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "get", "update", "delete"] },
        counterId: { type: "string", description: "get/update/delete 必填已有计数器精确ID。" },
        title: { type: "string", maxLength: 240, description: "update 可改名；名称必须唯一。" },
        icon: { type: "string", maxLength: 80, description: "Material 图标名；空串清除。" },
        isEnabled: { type: "boolean", description: "是否启用计数器；禁用会暂停计数，重新启用可能继续，不直接修改 isOn。" },
        isHideButton: { type: "boolean", description: "是否隐藏计数器按钮。" },
        confirmTitle: { type: "string", description: "仅delete：与当前完整名称精确一致。" },
        allowHistoryDelete: { type: "boolean", description: "仅delete：用户明确授权删除全部历史后传true。" },
        offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    execute: guard(async (args) => {
      if (!record(args) || !["list", "get", "update", "delete"].includes(args.action)) fail("不支持的计数器操作；新建请在 SP 中完成。");
      const action = args.action;
      if (["list", "get"].includes(action)) {
        only(args, action === "list" ? ["action", "offset", "limit"] : ["action", "counterId"]);
        if (action === "get" && !exactId(args.counterId)) fail("get 必须提供精确 counterId。");
        const offset = count(args.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = count(args.limit, 50, 1, 200);
        const result = await invoke(bridge, "counters.list", {});
        if (!record(result) || !Array.isArray(result.counters)) badResponse(false);
        const rows = result.counters.map((row) => projectCounter(row, false));
        if (new Set(rows.map((row) => row.id)).size !== rows.length) badResponse(false);
        if (action === "get") {
          const counter = rows.find((row) => row.id === args.counterId);
          if (!counter) throw new SpError("SP_NO_COUNTER", "找不到这个计数器。");
          return ok({ counter });
        }
        const counters = rows.slice(offset, offset + limit), next = offset + counters.length;
        return ok({ counters, total: rows.length, count: counters.length, offset, hasMore: next < rows.length, nextOffset: next < rows.length ? next : null });
      }
      only(args, action === "delete" ? ["action", "counterId", "confirmTitle", "allowHistoryDelete"] : ["action", "counterId", "title", "icon", "isEnabled", "isHideButton"]);
      const { action: _action, ...body } = args;
      const result = await invoke(bridge, `counters.${action}`, body);
      if (action === "delete") {
        if (!record(result) || result.id !== body.counterId || result.deleted !== true || !Number.isSafeInteger(result.removedTrackedDays) || result.removedTrackedDays < 0) badResponse(true);
        return ok({ result: { id: result.id, deleted: true, removedTrackedDays: result.removedTrackedDays } });
      }
      const counter = projectCounter(result?.counter, true);
      if (counter.id !== body.counterId || result.updated !== true) badResponse(true);
      for (const key of ["title", "icon", "isEnabled", "isHideButton"]) {
        if (!Object.hasOwn(body, key)) continue;
        const wanted = key === "title" ? body[key].trim() : key === "icon" ? body[key] || null : body[key];
        if (counter[key] !== wanted) badResponse(true);
      }
      return ok({ counter });
    }),
  });
  await registerAppTool(sdk, {
    name: "sp_tasks_workspace",
    description: "需要 SP 配套插件 0.3.0。get_order 查询项目普通列表或父任务完整子列表；reorder 带刚读取的 expectedTaskIds 与相同集合的新 taskIds，只重排、保留积压区，最多200项。reparent 必须带 expectedParentId 和 parentId（无父项传null）；仅同项目活动叶任务与顶层父任务，项目积压区为空，相关任务无重复规则、全局关系一致，目标父子完成状态相同。被移动任务、原新父任务及其全部后代的 timeSpent、timeEstimate 必须明确为0，timeSpentOnDay若存在只能含0；不迁移计时历史。先用 sp_tasks_get 查询，不能跨项目或搬整棵子树。get_selection 查看右侧详情选中任务，select 打开在用任务详情，不启动计时。",
    parameters: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["get_order", "reorder", "reparent", "get_selection", "select"] },
        contextType: { type: "string", enum: ["project", "task"], description: "排序上下文：project普通列表或task子任务列表。" },
        contextId: { type: "string", description: "项目或父任务精确ID。" },
        taskIds: { type: "array", maxItems: 200, uniqueItems: true, items: { type: "string" }, description: "reorder完整新顺序，必须保留原任务集合。" },
        expectedTaskIds: { type: "array", maxItems: 200, uniqueItems: true, items: { type: "string" }, description: "get_order刚返回的完整taskIds，顺序也必须一致。" },
        taskId: { type: "string", description: "select或reparent的在用任务精确ID。" },
        parentId: { type: ["string", "null"], description: "仅reparent：新父任务精确ID，null表示解除父项并追加项目主列表。被移动任务、原新父任务及其全部后代须无工时和估时。" },
        expectedParentId: { type: ["string", "null"], description: "仅reparent：刚查询到的原父任务ID，无父项必须显式传null。" },
      },
    },
    execute: guard(async (args) => {
      if (!record(args) || !["get_order", "reorder", "reparent", "get_selection", "select"].includes(args.action)) fail("不支持的工作区操作。");
      only(args, {
        get_order: ["action", "contextType", "contextId"],
        reorder: ["action", "contextType", "contextId", "taskIds", "expectedTaskIds"],
        reparent: ["action", "taskId", "parentId", "expectedParentId"],
        get_selection: ["action"], select: ["action", "taskId"],
      }[args.action]);
      const { action, ...body } = args;
      const op = { get_order: "taskOrder.list", reorder: "taskOrder.update", reparent: "tasks.reparent", get_selection: "selection.list", select: "selection.select" }[action];
      const result = await invoke(bridge, op, body);
      if (["get_order", "reorder"].includes(action)) return ok({ order: orderResult(result, body, action === "reorder") });
      if (action === "reparent") {
        if (!record(result) || result.id !== body.taskId || result.parentId !== body.parentId || result.previousParentId !== body.expectedParentId || !exactId(result.projectId) || typeof result.unchanged !== "boolean") badResponse(true);
        return ok({ task: { id: result.id, parentId: result.parentId, previousParentId: result.previousParentId, projectId: result.projectId, unchanged: result.unchanged } });
      }
      if (!record(result) || !Object.hasOwn(result, "selectedTask")) badResponse(action === "select");
      const selected = result.selectedTask;
      if (selected !== null && (!record(selected) || !exactId(selected.id) || typeof selected.title !== "string" || typeof selected.isDone !== "boolean")) badResponse(action === "select");
      if (action === "select" && (selected?.id !== body.taskId || typeof result.unchanged !== "boolean")) badResponse(true);
      return ok({ selectedTask: selected === null ? null : { id: selected.id, title: selected.title, isDone: selected.isDone } });
    }),
  });
}
