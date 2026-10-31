import { SpError } from "./sp.js";
import { invalidateNotice } from "./notice.js";
import { registerAppTool } from "./tool-registration.js";
import { versionAtLeast } from "./capabilities.js";
import { KEYBOARD_APP_KEYS, KEYBOARD_GLOBAL_KEYS, KEYBOARD_UPDATE_PROPERTIES, validateKeyboardCommand, projectKeyboardSettings } from "./keyboard-contract.js";

export const KEYBOARD_CAPABILITIES = [
  { id: "keyboard_preferences", label: "应用内快捷键", description: "读取和设置 SP 内置应用与任务快捷键，静态检查新冲突并保留系统热键及插件配置。新增?帮助键需明确接受布局相关冲突风险；配置成功不保证无冲突或操作系统注册成功。应用内响应仍受页面、焦点、系统保留键和布局影响；不发送按键。", requires: "bridge", minimumPluginVersion: "0.5.0", tools: ["sp_tasks_keyboard"] },
];
function keyboardBadResponse(writing) {
  const error = new SpError("SP_BRIDGE_BAD_RESPONSE", "SP 扩展未确认完整的快捷键配置。请先 get，不要自动重试更新。");
  if (writing) error.outcomeUnknown = true;
  throw error;
}

export async function registerKeyboardTools(sdk, { bridge, guard, ok }) {
  await registerAppTool(sdk, {
    name: "sp_tasks_keyboard",
    description: "需要 SP 配套扩展0.5.0。get返回全部内置应用/任务快捷键settings和完整配置指纹revision；缺少的键显示null，不猜默认值，现有非标准键串原样保留。update传刚读的expectedRevision及非空updates，仅改指定应用内按键；null解绑。新键串支持Ctrl/Alt/Shift/Meta与字母、数字、F1-F24、箭头、Enter/Space/Tab/Backspace/Delete/Home/End/PageUp/PageDown/Escape等或+/-；修饰键不可重复，Cmd/Mod不是别名，只有showHelp可设?。会规范大小写和修饰键顺序。静态检查新产生的应用/任务/系统/插件键冲突，默认拒绝并给出相关内置字段名，外部字段仅external-binding；用户明确接受时allowConflicts:true，不自动挪动其他键。新增showHelp:?的实际键随布局及AltGr变化，无法完整核验，必须用户明确接受后allowConflicts:true，成功warnings含help-layout-dependent；已有?和旧有冲突保留。静态检查不是无冲突保证。写入前核对完整指纹并保留所有系统热键、插件和未知配置；SP会重新注册系统热键，配置读回不证明操作系统注册成功。只改配置、不按键，不控制当前计时；实际按键可执行其绑定动作并受焦点、页面、布局及系统保留键影响。冲突或结果未知先get，禁止盲重试。",
    parameters: {
      type: "object", additionalProperties: false, required: ["action"], properties: {
        action: { type: "string", enum: ["get", "update"] },
        expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$", description: "仅update必填：get刚返回的revision，覆盖完整配置而不公开系统/插件键值。" },
        updates: { type: "object", additionalProperties: false, minProperties: 1, properties: KEYBOARD_UPDATE_PROPERTIES, description: "仅update必填；内置应用/任务键名映射到规范按键组合或null。" },
        allowConflicts: { type: "boolean", description: "仅update；默认false。有新冲突，或新增showHelp:?存在未知布局冲突风险，且用户明确接受时设true。" },
      },
    },
    execute: guard(async (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args) || !["get", "update"].includes(args.action)) throw new SpError("SP_BAD_INPUT", "action必须为get或update。");
      const { action, ...input } = args, op = action === "get" ? "keyboard.list" : "keyboard.update";
      let body;
      try { body = validateKeyboardCommand(op, input); }
      catch (error) { throw new SpError("SP_BAD_INPUT", error.message); }
      let status;
      try { status = await bridge.status(); }
      catch { throw new SpError("SP_BRIDGE_UNAVAILABLE", "无法确认 SP 扩展连接，请刷新连接状态。"); }
      if (status?.enabled !== true || status.running !== true || status.connected !== true || status.available === false || status.accepting === false || status.stopping === true || status.error || status.protocol !== 1) throw new SpError("SP_BRIDGE_NOT_CONNECTED", "请先连接 SP 配套扩展。");
      if (!versionAtLeast(status.pluginVersion, "0.5.0")) throw new SpError("SP_BRIDGE_UPGRADE_REQUIRED", "应用内快捷键需要 SP 扩展0.5.0或更新正式版。");
      const writing = action === "update";
      let result;
      try { result = await bridge.execute(op, body); }
      catch (cause) {
        const code = typeof cause?.code === "string" && /^SP_[A-Z0-9_]{1,96}$/.test(cause.code) ? cause.code : "SP_BRIDGE_ERROR";
        let message = "SP 快捷键请求未完成；配置可能已变化，请先get后再决定是否更新。";
        if (code === "SP_KEYBOARD_BINDING_CONFLICT") {
          const match = typeof cause.message === "string" && /^Shortcut conflicts between fields: (.+)\. Use allowConflicts:true only to accept these conflicts\.$/.exec(cause.message);
          const keys = match ? [...new Set(match[1].split(", ").filter((key) => KEYBOARD_APP_KEYS.includes(key) || KEYBOARD_GLOBAL_KEYS.includes(key)))] : [];
          message = `检测到新的快捷键冲突。${keys.length ? `相关内置字段：${keys.join(", ")}。` : ""}可能还涉及系统或插件绑定；请更换组合，仅在用户明确接受时使用allowConflicts:true。`;
          if (cause.message === "The ? help binding is keyboard-layout-dependent. Use allowConflicts:true only after the user accepts possible layout-dependent conflicts.") message = "新增?帮助键可能与不同键盘布局或AltGr产生冲突，当前公开快照无法完整核验。仅在用户明确接受该风险后使用allowConflicts:true；这不表示已确认存在某个具体冲突。";
        }
        const error = new SpError(code, message);
        if (cause?.outcomeUnknown === true) error.outcomeUnknown = true;
        throw error;
      } finally { if (writing) invalidateNotice(); }
      if (typeof result?.revision !== "string" || !/^[a-f0-9]{64}$/.test(result.revision)) keyboardBadResponse(writing);
      let settings;
      try { settings = projectKeyboardSettings(result.settings, true); }
      catch { keyboardBadResponse(writing); }
      let conflicts, warnings;
      if (writing) {
        if (typeof result.unchanged !== "boolean" || result.verification !== "applied-state" || result.unchanged !== (result.revision === body.expectedRevision) || Object.entries(body.updates).some(([key, value]) => settings[key] !== value)) keyboardBadResponse(true);
        if (!Array.isArray(result.conflicts) || result.conflicts.some((item) => !Array.isArray(item?.keys) || item.keys.length !== 2 || item.keys.some((key) => typeof key !== "string" || !key) || item.keys[0] === item.keys[1] || !item.keys.some((key) => KEYBOARD_APP_KEYS.includes(key))) || result.conflicts.length && body.allowConflicts !== true) keyboardBadResponse(true);
        conflicts = result.conflicts.map((item) => ({ keys: item.keys.map((key) => KEYBOARD_APP_KEYS.includes(key) || KEYBOARD_GLOBAL_KEYS.includes(key) ? key : "external-binding") }));
        if (Object.hasOwn(result, "warnings")) {
          if (!Array.isArray(result.warnings) || result.warnings.length !== 1 || result.warnings[0] !== "help-layout-dependent" || body.updates.showHelp !== "?" || body.allowConflicts !== true || result.unchanged) keyboardBadResponse(true);
          warnings = ["help-layout-dependent"];
        }
      }
      return ok({ settings, revision: result.revision, ...(writing ? { unchanged: result.unchanged, verification: "applied-state", conflicts, ...(warnings ? { warnings } : {}) } : {}) });
    }),
  });
}
