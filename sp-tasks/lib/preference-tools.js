import { SpError } from "./sp.js";
import { invalidateNotice } from "./notice.js";
import { registerAppTool } from "./tool-registration.js";
import { versionAtLeast } from "./capabilities.js";
import { PREFERENCE_SECTIONS, PREFERENCE_FIELDS, PREFERENCE_PROPERTIES, PREFERENCE_MINIMUM_VERSIONS, validatePreferenceCommand, projectPreferences } from "./preferences-contract.js";

export const PREFERENCE_CAPABILITIES = [
  { id: "preferences", label: "声音与日程偏好", description: "读取和修改音量、内置提示音、专注背景音、上下班与午休时段。更新前校验刚读取的字段，保留其他全局配置。", requires: "bridge", minimumPluginVersion: "0.3.0", tools: ["sp_tasks_preferences"] },
  { id: "focus_preferences", label: "番茄钟与专注默认设置", description: "设置番茄钟工作、短休息、长休息时长与周期，以及播放时自动专注、准备页、休息暂停计时和手动休息。会影响后续播放及当前会话的下一次休息转换；不重设当前计时或周期。", requires: "bridge", minimumPluginVersion: "0.4.0", tools: ["sp_tasks_preferences"] },
  { id: "break_preferences", label: "休息提醒设置", description: "设置休息提醒开关、工作阈值、稍后提醒时长，以及锁屏、全屏休息遮罩和窗口前置。开启提醒或缩短阈值可能在当前计时期间触发提醒及已配置的锁屏或全屏行为；不会重置已工作时长。", requires: "bridge", minimumPluginVersion: "0.4.0", tools: ["sp_tasks_preferences"] },
  { id: "display_preferences", label: "界面显示偏好", description: "设置动画、竖向操作栏、庆祝效果、启动提示以及桌面徽标和托盘倒计时；桌面功能受 SP 当前平台支持情况影响。", requires: "bridge", minimumPluginVersion: "0.5.0", tools: ["sp_tasks_preferences"] },
  { id: "task_behavior_preferences", label: "任务行为偏好", description: "设置 SP 删除确认、计时自动加入今天、子任务完成后自动完成父任务、托盘任务显示和笔记格式。自动加入今天可影响正在计时的未排期任务；自动完成父任务影响后续完成事件。", requires: "bridge", minimumPluginVersion: "0.5.0", tools: ["sp_tasks_preferences"] },
  { id: "tracking_preferences", label: "计时默认值与提醒", description: "设置新任务默认估时、超时提醒、完成后自动计时下一项及未计时提醒。开启自动下一项会影响当前任务后续完成；提醒设置可能重启提醒计数、弹出通知或前置窗口。", requires: "bridge", minimumPluginVersion: "0.5.0", tools: ["sp_tasks_preferences"] },
  { id: "reminder_preferences", label: "任务提醒默认值", description: "设置未来排期的默认提醒选项、已有提醒的提前倒计时横幅和窗口前置。不会改写已有任务或重复规则的提醒时间；倒计时时长为零不会关闭到点提醒。", requires: "bridge", minimumPluginVersion: "0.5.0", tools: ["sp_tasks_preferences"] },
];
const preferenceResponseError = (writing) => {
  const error = new SpError("SP_BRIDGE_BAD_RESPONSE", "SP 扩展未确认完整的偏好设置。请先重新读取，不要自动重试更新。");
  if (writing) error.outcomeUnknown = true;
  throw error;
};

export async function registerPreferenceTools(sdk, { bridge, guard, ok }) {
  await registerAppTool(sdk, {
    name: "sp_tasks_preferences",
    description: "get读取白名单分区；update必须带刚读取的完整settings作为expected及非空updates。sound/focusMode/schedule需SP扩展0.3.0，分别为提示音、专注背景音、上下班和午休时段。pomodoro/focusDefaults/takeABreak需0.4.0：番茄钟四参数、专注行为、休息提醒与锁屏/全屏遮罩。display/taskBehavior/timeTracking/reminderDefaults需0.5.0：显示、任务行为、默认估时和计时提醒、任务提醒默认值。自动加入今天可影响正在计时的未排期任务；自动完成父任务和自动下一项会影响后续完成事件，可能开始下一任务计时；提醒设置可能弹窗或前置窗口。时长单位均为毫秒，0的实际含义见字段说明。pomodoro不重设当前计时或周期，专注设置可影响下一次转换。开启takeABreak或缩短阈值可能在当前计时期间触发提醒及锁屏/全屏，关闭不保证撤销已排队动作。defaultTaskRemindOption不改已有提醒；SP删除确认开关不免除工具删除授权。全局偏好可能同步到其他设备；完整expected用于检查已改字段，冲突或结果未知先get。字段缺失或类型不符会明确报不支持，不猜默认值。不提供任意dispatch、凭据、日界线、快捷键或会话启停。",
    parameters: {
      type: "object", additionalProperties: false, required: ["action", "section"],
      properties: {
        action: { type: "string", enum: ["get", "update"] },
        section: { type: "string", enum: PREFERENCE_SECTIONS, description: "focusDefaults映射focusMode行为字段；focusMode仅背景音。display映射misc显示字段，taskBehavior映射tasks，reminderDefaults映射reminder，timeTracking同名。takeABreak包含当前时段可能触发的锁屏和全屏设置；每次更新前读取所选分区的完整settings。" },
        updates: { type: "object", additionalProperties: false, minProperties: 1, properties: PREFERENCE_PROPERTIES, description: "仅update：所选分区的白名单变更。不能跨分区。" },
        expected: { type: "object", additionalProperties: false, properties: PREFERENCE_PROPERTIES, description: "仅update且必填：get刚返回的完整settings，原样传入。" },
      },
    },
    execute: guard(async (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args) || !["get", "update"].includes(args.action)) throw new SpError("SP_BAD_INPUT", "action必须为get或update。");
      const { action, ...input } = args;
      const op = action === "get" ? "preferences.list" : "preferences.update";
      let body;
      try { body = validatePreferenceCommand(op, input); }
      catch (error) { throw new SpError("SP_BAD_INPUT", error.message); }
      let status;
      try { status = await bridge.status(); }
      catch { throw new SpError("SP_BRIDGE_UNAVAILABLE", "无法确认 SP 扩展连接，请在任务台设置中刷新连接状态。"); }
      if (status?.enabled !== true || status.running !== true || status.connected !== true || status.available === false || status.accepting === false || status.stopping === true || status.error || status.protocol !== 1) throw new SpError("SP_BRIDGE_NOT_CONNECTED", "请先在任务台设置中连接 SP 配套扩展。");
      const minimumVersion = PREFERENCE_MINIMUM_VERSIONS[body.section];
      if (!versionAtLeast(status.pluginVersion, minimumVersion)) throw new SpError("SP_BRIDGE_UPGRADE_REQUIRED", `${body.section} 偏好设置需要 SP 扩展 ${minimumVersion} 或更新正式版。`);
      const writing = action === "update";
      let result;
      try { result = await bridge.execute(op, body); }
      catch (cause) {
        const code = typeof cause?.code === "string" && /^SP_[A-Z0-9_]{1,80}$/.test(cause.code) ? cause.code : "SP_BRIDGE_ERROR";
        const error = new SpError(code, "SP 偏好设置请求未能确认完成。请先重新读取当前设置，不要自动重试更新。");
        if (cause?.outcomeUnknown === true) error.outcomeUnknown = true;
        throw error;
      } finally { if (writing) invalidateNotice(); }
      if (result?.section !== body.section) preferenceResponseError(writing);
      let settings;
      try { settings = projectPreferences(body.section, result.settings); }
      catch { preferenceResponseError(writing); }
      if (writing && (typeof result.unchanged !== "boolean" || result.verification !== "applied-state" ||
          PREFERENCE_FIELDS[body.section].some((key) => settings[key] !== (Object.hasOwn(body.updates, key) ? body.updates[key] : body.expected[key])))) preferenceResponseError(true);
      return ok({ section: body.section, settings, ...(writing ? { unchanged: result.unchanged, verification: "applied-state" } : {}) });
    }),
  });
}
