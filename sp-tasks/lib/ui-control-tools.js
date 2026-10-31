import { SpError } from "./sp.js";
import { registerAppTool } from "./tool-registration.js";
import { versionAtLeast } from "./capabilities.js";
import { UI_CONTROL_COMMANDS, validateUiControlCommand } from "./ui-control-contract.js";

export const UI_CONTROL_CAPABILITIES = [
  { id: "ui_control", label: "SP 界面面板控制", description: "提交专注覆盖层、添加任务栏和侧栏的固定显示操作。专注覆盖层不等于计时启停；关闭它会取消尚未开始的准备倒计时。笔记或问题面板切换会隐藏其他非任务面板。只确认动作已提交，不能读回或保证画面已显示。", requires: "bridge", minimumPluginVersion: "0.5.0", tools: ["sp_tasks_ui"] },
];

export async function registerUiControlTools(sdk, { bridge, guard, ok }) {
  await registerAppTool(sdk, {
    name: "sp_tasks_ui",
    description: "需要 SP 配套扩展 0.5.0。只提交固定界面动作：focus.show/hide 显示/关闭专注覆盖层，不启动或暂停活动计时；focus.hide 会取消尚未开始的准备倒计时。addTask.show/hide 显示/隐藏添加任务栏，不创建任务，也不保证键盘焦点恢复。notes.toggle/ issues.toggle 切换笔记/问题面板，并隐藏其他非任务面板。sidePanel.hide 隐藏所有非任务侧栏内容，不保证关闭任务详情；pluginPanel.hide 也会隐藏其他非任务面板，并清除活动插件面板选择。成功仅表示 submitted，无法通过公开状态接口确认渲染或当前显示状态；不要自动重试，尤其切换动作，重复调用会反向切换。不是专注会话控制，不接受任意action、DOM或脚本。",
    parameters: {
      type: "object", additionalProperties: false, required: ["command"],
      properties: {
        command: { type: "string", enum: UI_CONTROL_COMMANDS, description: "固定界面命令；成功只确认已提交，不能当成画面已显示。" },
      },
    },
    execute: guard(async (args) => {
      let body;
      try { body = validateUiControlCommand("ui.command", args); }
      catch (error) { throw new SpError("SP_BAD_INPUT", error.message); }
      let status;
      try { status = await bridge.status(); }
      catch { throw new SpError("SP_BRIDGE_UNAVAILABLE", "无法确认 SP 扩展连接，请在任务台设置中刷新连接状态。"); }
      if (status?.enabled !== true || status.running !== true || status.connected !== true || status.available === false || status.accepting === false || status.stopping === true || status.error || status.protocol !== 1) throw new SpError("SP_BRIDGE_NOT_CONNECTED", "请先在任务台设置中连接 SP 配套扩展。");
      if (!versionAtLeast(status.pluginVersion, "0.5.0")) throw new SpError("SP_BRIDGE_UPGRADE_REQUIRED", "界面控制需要 SP 扩展 0.5.0 或更新正式版。");
      let result;
      try { result = await bridge.execute("ui.command", body); }
      catch (cause) {
        const code = typeof cause?.code === "string" && /^SP_[A-Z0-9_]{1,80}$/.test(cause.code) ? cause.code : "SP_BRIDGE_ERROR";
        const error = new SpError(code, "SP 界面操作未能确认提交。请查看 SP 后再决定下一步，不要自动重试。");
        if (cause?.outcomeUnknown === true) error.outcomeUnknown = true;
        throw error;
      }
      if (!result || result.command !== body.command || result.submitted !== true || result.verification !== "submitted") {
        const error = new SpError("SP_BRIDGE_BAD_RESPONSE", "SP 扩展没有确认此界面命令已提交。结果未知，请查看 SP，不要自动重试。");
        error.outcomeUnknown = true;
        throw error;
      }
      return ok({ command: body.command, submitted: true, verification: "submitted" });
    }),
  });
}
