import { SpError } from "./sp.js";
import { invalidateNotice } from "./notice.js";
import { registerAppTool } from "./tool-registration.js";

const WRITE_ACTIONS = new Set(["create", "update", "delete"]);
const PROTECTED = new Set(["INBOX_PROJECT", "TODAY"]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => { throw new SpError("SP_BAD_INPUT", message); };
const responseError = (message, writing) => {
  const error = new SpError("SP_BRIDGE_BAD_RESPONSE", message);
  if (writing) error.outcomeUnknown = true;
  throw error;
};

function text(value, key, { empty = false, max = 240 } = {}) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${key} 必须是${empty ? "可为空的" : "非空"}单行字符串，最多 ${max} 字符。`);
  }
  return value.trim();
}

// SP reports some colors (e.g. the default Inbox) as rgb(); accept that form so read values can be written back.
function color(value) {
  const result = text(value, "color", { empty: true, max: 40 });
  if (!result || /^#[0-9a-f]{6}$/i.test(result)) return result;
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(result);
  if (!rgb || rgb.slice(1).some((part) => Number(part) > 255)) fail("color 必须是 #RRGGBB 或 rgb(r, g, b)，空串表示清除。");
  return `#${rgb.slice(1).map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
}

function exactId(value, key) {
  const result = text(value, key);
  if (result === "." || result === ".." || /[\\/]/.test(result)) fail(`${key} 不能是路径。`);
  return result;
}

function only(args, allowed) {
  if (!record(args)) fail("参数必须是对象。");
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) fail(`此操作不接受 ${key}。`);
  }
}

function integer(value, key, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${key} 必须是 ${min} 到 ${max} 的整数。`);
  return value;
}

function projection(value, kind, writing = false, expectedId) {
  if (!record(value) || typeof value.id !== "string" || !value.id.trim() || typeof value.title !== "string" ||
      expectedId !== undefined && value.id !== expectedId) {
    responseError("SP 插件没有返回与请求一致的有效对象，请先查询确认。", writing);
  }
  const result = { id: value.id, title: value.title };
  const keys = kind === "projects"
    ? ["icon", "color", "isArchived", "isEnableBacklog", "isHiddenFromMenu", "taskCount", "backlogTaskCount", "noteCount"]
    : ["icon", "color", "taskCount"];
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (key.startsWith("is") ? typeof item !== "boolean" : key.endsWith("Count") ? !Number.isSafeInteger(item) || item < 0 : item !== null && typeof item !== "string") {
      responseError(`SP 插件返回了无效的 ${key}。`, writing);
    }
    result[key] = item;
  }
  return result;
}

async function invoke(bridge, operation, args, writing = false) {
  try {
    return await bridge.execute(operation, args);
  } catch (cause) {
    if (cause instanceof SpError) throw cause;
    const error = new SpError(cause?.code || "SP_BRIDGE_ERROR", String(cause?.message || "SP 配套插件连接失败。"));
    if (cause?.outcomeUnknown === true) error.outcomeUnknown = true;
    if (typeof cause?.createdId === "string") error.createdId = cause.createdId;
    throw error;
  } finally {
    if (writing) invalidateNotice();
  }
}

function changes(args, kind) {
  const body = {};
  if (args.title !== undefined) body.title = text(args.title, "title");
  if (args.icon !== undefined) {
    body.icon = text(args.icon, "icon", { empty: true, max: 80 });
    if (body.icon && !/^[a-z0-9_]+$/i.test(body.icon)) fail("icon 只能是 Material 图标名称，空串表示清除。");
  }
  if (args.color !== undefined) body.color = color(args.color);
  if (kind === "projects") {
    for (const key of ["isEnableBacklog", "isHiddenFromMenu"]) {
      if (args[key] === undefined) continue;
      if (typeof args[key] !== "boolean") fail(`${key} 必须是布尔值。`);
      body[key] = args[key];
    }
  }
  return body;
}

export async function registerStructureTools(sdk, { bridge, guard, ok }) {
  await registerAppTool(sdk, {
    name: "sp_tasks_bridge",
    description: "只读检查 SP 配套插件的配对、运行和连接状态，不开启服务、不返回令牌。项目和标签管理需要在任务台设置中配对插件；原来的 12 个 REST 工具不依赖插件。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: guard(async (args) => {
      only(args, []);
      try { return ok({ bridge: await bridge.status() }); }
      catch (cause) { throw new SpError(cause?.code || "SP_BRIDGE_ERROR", String(cause?.message || "无法读取桥接状态。")); }
    }),
  });

  for (const kind of ["projects", "tags"]) {
    const project = kind === "projects";
    const singular = project ? "project" : "tag";
    const idKey = `${singular}Id`;
    const actions = project ? ["list", "get", "create", "update", "delete"] : ["list", "get", "create", "update"];
    const editKeys = ["title", "icon", "color", ...(project ? ["isEnableBacklog", "isHiddenFromMenu"] : [])];
    await registerAppTool(sdk, {
      name: `sp_tasks_${kind}`,
      description: project
        ? "通过使用 SP 官方 API 的配套插件查询、新建、改名项目和修改图标/颜色/积压区/菜单显示。先 list/get 取得精确 projectId，不猜 ID，不自动复用同名项目。删除必须是用户明确要求，confirmTitle 与现名完全一致并且 allowCascade:true；即使当前可见为空，也可能含无法完整验证的归档任务，必须先说明将级联删除任务、笔记、重复规则等全部项目内容。收件箱不可修改或删除。不提供项目归档或全局配置。"
        : "通过使用 SP 官方 API 的配套插件查询、新建、改名标签和修改图标/颜色。先 list/get 取得精确 tagId；名称必须唯一，不能修改 TODAY 内置标签。公开插件没有删除标签接口，本工具不提供 delete。任务上的标签关联仍用 sp_tasks_update。",
      parameters: {
        type: "object", additionalProperties: false, required: ["action"],
        properties: {
          action: { type: "string", enum: actions },
          [idKey]: { type: "string", description: "get/update/delete 使用的精确 ID，先 list 查询。" },
          title: { type: "string", maxLength: 240, description: "create 必填，update 可改名；不允许重名。" },
          icon: { type: "string", maxLength: 80, description: "Material 图标名，例如 folder；空串清除。" },
          color: { type: "string", description: project ? "#RRGGBB 或 rgb(r, g, b) 颜色，后者转成 #RRGGBB 写入；空串恢复 SP 默认项目色。" : "#RRGGBB 或 rgb(r, g, b) 颜色，后者转成 #RRGGBB 写入；空串清除。" },
          ...(project ? {
            isEnableBacklog: { type: "boolean", description: "启用或关闭项目积压区。" },
            isHiddenFromMenu: { type: "boolean", description: "是否从项目菜单隐藏。" },
            includeArchived: { type: "boolean", description: "仅 list：是否包含归档项目，默认 false。" },
            confirmTitle: { type: "string", description: "仅 delete：必须与当前项目完整名称完全一致。" },
            allowCascade: { type: "boolean", description: "仅 delete：必须为 true 且用户明确授权级联删除全部项目内容；即使可见为空也需要。" },
          } : {}),
          offset: { type: "integer", minimum: 0, description: "仅 list：从 nextOffset 继续。" },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "仅 list：每页数量，默认 50。" },
        },
      },
      execute: guard(async (args) => {
        if (!record(args) || !actions.includes(args.action)) fail(`action 必须是 ${actions.join(" / ")}。`);
        const action = args.action;
        if (action === "list" || action === "get") {
          only(args, action === "get" ? ["action", idKey] : ["action", "limit", "offset", ...(project ? ["includeArchived"] : [])]);
          const targetId = action === "get" ? exactId(args[idKey], idKey) : undefined;
          const limit = args.limit === undefined ? 50 : integer(args.limit, "limit", 1, 200);
          const offset = args.offset === undefined ? 0 : integer(args.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
          if (args.includeArchived !== undefined && typeof args.includeArchived !== "boolean") fail("includeArchived 必须是布尔值。");
          const result = await invoke(bridge, `${kind}.list`, {});
          if (!record(result) || !Array.isArray(result[kind])) responseError("SP 插件列表格式不正确。", false);
          const rows = result[kind].map((item) => projection(item, kind));
          if (new Set(rows.map((row) => row.id)).size !== rows.length) responseError("SP 插件返回了重复对象 ID。", false);
          if (targetId !== undefined) {
            const found = rows.find((row) => row.id === targetId);
            if (!found) throw new SpError(project ? "SP_NO_PROJECT" : "SP_NO_TAG", `找不到 ${idKey} 对应的对象。`);
            return ok({ [singular]: found });
          }
          const filtered = project && args.includeArchived !== true ? rows.filter((row) => row.isArchived !== true) : rows;
          const selected = filtered.slice(offset, offset + limit);
          const nextOffset = offset + selected.length;
          const hasMore = nextOffset < filtered.length;
          return ok({ [kind]: selected, count: selected.length, total: filtered.length, offset, hasMore, nextOffset: hasMore ? nextOffset : null });
        }
        const writing = WRITE_ACTIONS.has(action);
        only(args, action === "delete" ? ["action", idKey, "confirmTitle", "allowCascade"] : ["action", ...(action === "update" ? [idKey] : []), ...editKeys]);
        const targetId = action === "create" ? undefined : exactId(args[idKey], idKey);
        if (PROTECTED.has(targetId)) fail("不能修改或删除 SP 内置收件箱与 TODAY。");
        if (action === "delete") {
          text(args.confirmTitle, "confirmTitle");
          if (args.allowCascade !== undefined && typeof args.allowCascade !== "boolean") fail("allowCascade 必须是布尔值。");
          if (args.allowCascade !== true) fail("删除项目必须明确授权全部级联内容并设置 allowCascade:true；归档任务不一定能完整查出。");
          const result = await invoke(bridge, "projects.delete", { projectId: targetId, confirmTitle: args.confirmTitle, allowCascade: args.allowCascade === true }, writing);
          if (!record(result) || result.id !== targetId || result.deleted !== true) responseError("SP 插件未确认指定项目已删除。", true);
          return ok({ result });
        }
        const body = changes(args, kind);
        if (action === "create" && !body.title) fail("create 必须提供 title。");
        if (action === "update" && !Object.keys(body).length) fail("没有要修改的字段。");
        const result = await invoke(bridge, `${kind}.${action}`, { ...(targetId === undefined ? {} : { [idKey]: targetId }), ...body }, writing);
        return ok({ [singular]: projection(result?.[singular], kind, true, targetId) });
      }),
    });
  }
}
