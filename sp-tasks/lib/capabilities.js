import { SpError } from "./sp.js";
import { registerAppTool } from "./tool-registration.js";

/** Oldest extension with every capability; versions at or above it are compatible. */
export const RECOMMENDED_PLUGIN_VERSION = "0.5.0";
/** The extension shipped in assets/companion. Newer than the floor only for transport changes. */
export const BUNDLED_PLUGIN_VERSION = "0.6.0";
export const RUNTIME_PERMISSIONS = ["app/runtime.execute", "app/runtime.native", "app/runtime.network"];

export function versionAtLeast(version, minimum) {
  const parse = (value) => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(value)
    ? value.split("+")[0].split(".").map(Number) : null;
  const actual = parse(version), required = parse(minimum);
  if (!actual || !required || !actual.every(Number.isSafeInteger) || !required.every(Number.isSafeInteger)) return false;
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

const BASE_CAPABILITIES = [
  { id: "tasks", label: "任务与排期", requires: "rest", tools: ["sp_tasks_overview", "sp_tasks_search", "sp_tasks_get", "sp_tasks_create", "sp_tasks_update", "sp_tasks_context"], description: "查询、新建、批量修改、子任务、项目归属、标签、计划日与真正截止日。" },
  { id: "time", label: "计时与工时", requires: "rest", tools: ["sp_tasks_timer", "sp_tasks_log_time"], description: "开始或停止计时，查询当前计时，按日补记或覆盖工时。" },
  { id: "archive", label: "归档与恢复记录", requires: "rest", tools: ["sp_tasks_manage"], description: "整树归档、恢复、查询恢复进度、继续修复与明确删除；精确保全历史完成时间另需扩展连接。" },
  { id: "repeat", label: "重复任务", requires: "rest", tools: ["sp_tasks_repeat"], description: "已有任务的重复日程、自定义周期与星期、暂停、恢复和取消规则。" },
  { id: "notes", label: "独立笔记", requires: "rest", tools: ["sp_tasks_notes"], description: "查询、新建、修改、移动、固定到今天和删除笔记。" },
  { id: "counter_values", label: "习惯与计数值", requires: "rest", tools: ["sp_tasks_counters"], description: "读取已有计数器，设置某日数值或累加今天。" },
  { id: "projects", label: "项目管理", requires: "bridge", minimumPluginVersion: "0.1.0", tools: ["sp_tasks_projects"], description: "新建、改名、颜色、图标、积压区、菜单显示；明确确认后可级联删除。" },
  { id: "tags", label: "标签管理", requires: "bridge", minimumPluginVersion: "0.1.0", tools: ["sp_tasks_tags"], description: "新建、改名、颜色和图标；任务标签关联使用任务修改工具。" },
  { id: "completion", label: "精确恢复完成时间", requires: "bridge", minimumPluginVersion: "0.2.0", tools: ["sp_tasks_manage"], description: "依据归档前记录保全历史完成时间和不做分类；需通过任务状态和副作用检查。" },
  { id: "project_archive", label: "项目归档与恢复", requires: "unsupported", blocker: "public_api", tools: [], description: "SP 19.3.1 的公开接口没有完整的项目归档与恢复操作，不能直接改标记替代。" },
  { id: "tag_delete", label: "删除标签", requires: "unsupported", blocker: "public_api", tools: [], description: "SP 19.3.1 的公开插件 API 没有 deleteTag；仍可从任务移除标签关联。" },
  { id: "counter_create", label: "新建计数器", requires: "unsupported", blocker: "upstream_bug", tools: [], description: "SP 19.3.1 的公开创建分支缺少完整持久化记录，无法保证重放或同步后的结果；请在 SP 界面创建。" },
  { id: "advanced_repeat", label: "重复模板高级字段", requires: "unsupported", blocker: "public_api", tools: [], description: "模板标题、提醒、时刻等不在 REST 更新白名单内，公开插件 API 也没有相应更新方法。" },
  { id: "focus_session", label: "番茄钟运行控制", requires: "unsupported", blocker: "public_api", tools: [], description: "可查看专注状态和修改默认参数，但 SP 19.3.1 的公开 REST 只读专注状态，插件 action 白名单未开放专注会话的开始、暂停、取消或完成。任务计时与番茄钟会话是不同操作。" },
  { id: "countdown_start", label: "启动重复倒计时提醒", requires: "unsupported", blocker: "public_api", tools: [], description: "SP 界面启动时还需初始化本机倒计时，公开 toggleSimpleCounter 只切换 isOn，不能保证倒计时运行。已有倒计时可通过计数器控制工具暂停。" },
  { id: "boards", label: "看板与列配置", requires: "unsupported", blocker: "public_api", tools: [], description: "SP 19.3.1 的看板是独立数据模块，公开 getAppState 不包含看板，插件没有看板方法且 action 不在白名单内。项目和标签操作不等于管理看板列。" },
  { id: "ui_state", label: "面板显示状态读取", requires: "unsupported", blocker: "public_api", tools: [], description: "界面命令已开放，但 SP 公开快照没有 layout 或专注覆盖层状态；只能确认命令提交，不能自动读回确认画面。" },
  { id: "global_settings", label: "其余偏好与日界线", requires: "not_implemented", tools: [], description: "常用显示、任务行为、计时提醒、排期提醒和应用内快捷键已接入。其余字段尚未逐项适配；一天起点还需同步改造任务台日期换算。" },
  { id: "file_attachments", label: "文件与图片附件传输", requires: "not_implemented", tools: [], description: "HTTP/HTTPS 链接附件已开放；文件和图片上传、下载、打开及文件删除仍需独立适配。链接管理会保留这些已有附件。" },
  { id: "additional_order", label: "更多列表排序", requires: "not_implemented", tools: [], description: "项目普通任务和父任务子列表排序已开放；积压区和标签排序尚未接入，需要按真实完整成员与顺序校验。" },
];

function usable(bridge) {
  return bridge?.enabled === true && bridge?.running === true && bridge?.connected === true &&
    bridge?.available !== false && bridge?.accepting !== false && bridge?.stopping !== true && !bridge?.error && bridge?.protocol === 1;
}

export function bridgeCompatibility(bridge) {
  let state = "disconnected";
  if (bridge?.available === false) state = "unavailable";
  else if (usable(bridge)) state = versionAtLeast(bridge.pluginVersion, RECOMMENDED_PLUGIN_VERSION) ? "compatible"
    : versionAtLeast(bridge.pluginVersion, "0.0.0") ? "outdated" : "unknown";
  const updateAvailable = state === "compatible" && !versionAtLeast(bridge.pluginVersion, BUNDLED_PLUGIN_VERSION);
  return { state, connectedVersion: bridge?.pluginVersion ?? null, requiredVersion: RECOMMENDED_PLUGIN_VERSION, latestVersion: BUNDLED_PLUGIN_VERSION, updateAvailable };
}

export function capabilityCatalog(bridge, extensions = []) {
  const pending = (item) => ["unsupported", "not_implemented"].includes(item.requires);
  const items = [...BASE_CAPABILITIES.filter((item) => !pending(item)), ...extensions,
    ...BASE_CAPABILITIES.filter(pending)];
  return items.map((item) => {
    if (item.requires === "not_implemented") return { ...item, available: false, status: "not_implemented", reason: item.description };
    if (item.requires === "unsupported") return { ...item, available: false, status: "unsupported", reason: item.description };
    if (item.requires === "rest") return { ...item, available: true, status: "rest", reason: "功能已开放；实际连接请通过任务台设置中的 REST 检测确认。" };
    if (!usable(bridge)) return { ...item, available: false, status: "needs_pairing", reason: "在任务台设置安装并配对 SP 扩展，确认连接正常后使用。" };
    if (!versionAtLeast(bridge.pluginVersion, item.minimumPluginVersion)) return { ...item, available: false, status: "needs_upgrade", reason: `需要 SP 扩展 ${item.minimumPluginVersion} 或以上稳定版本，请从任务台设置下载更新。` };
    return { ...item, available: true, status: "ready" };
  });
}

export async function registerCapabilityTool(sdk, { setup, guard, ok }) {
  await registerAppTool(sdk, {
    name: "sp_tasks_capabilities",
    description: "只读查看任务台版本、内置 SP 扩展版本、连接与版本兼容性，以及已开放功能、尚未实现的功能和 SP API/持久化限制。not_implemented 表示任务台未接入，不能说成 SP 不支持或权限不足；unsupported 的 blocker 区分 public_api 与 upstream_bug。回答能做什么、权限够不够、为什么不能操作时先用本工具。REST 功能标记可用表示已开放，实际连接另需诊断。不会启动服务、修改 SP 或返回配对码。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: guard(async (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new SpError("SP_BAD_INPUT", "参数必须是对象。");
      if (Object.keys(args).length) throw new SpError("SP_BAD_INPUT", `此工具不接受参数 ${Object.keys(args).join("、")}。`);
      return ok(await setup());
    }),
  });
}
