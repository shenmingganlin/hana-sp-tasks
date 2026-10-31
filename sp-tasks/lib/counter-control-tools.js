import { SpError } from "./sp.js";
import { invalidateNotice } from "./notice.js";
import { registerAppTool } from "./tool-registration.js";
import { versionAtLeast } from "./capabilities.js";
import { COUNTER_CONTROL_FIELDS, COUNTER_CONTROL_PROPERTIES, validateCounterControlCommand, projectCounterControl } from "./counter-control-contract.js";

export const COUNTER_CONTROL_CAPABILITIES = [
  { id: "counter_control", label: "秒表启停与倒计时暂停", description: "查看并显式启动或停止已有秒表；重复倒计时提醒仅支持查看和暂停，不清缓存或完成提示。不会自动启用计数器，不控制点击计数器。开关状态仅作用于本机，秒表累计时长仍由 SP 持久化。", requires: "bridge", minimumPluginVersion: "0.4.0", tools: ["sp_tasks_counter_control"] },
];
function counterControlResponseError(writing) {
  const error = new SpError("SP_BRIDGE_BAD_RESPONSE", "SP 扩展未确认完整的计数器开关状态。请先查询 status，不要自动重试。");
  if (writing) error.outcomeUnknown = true;
  throw error;
}

export async function registerCounterControlTools(sdk, { bridge, guard, ok }) {
  await registerAppTool(sdk, {
    name: "sp_tasks_counter_control",
    description: "需要 SP 配套扩展 0.4.0。status 查询一个已有秒表或重复倒计时提醒的开关；start/stop 必须把刚返回的完整 counter 原样作为 expected。start 仅支持已启用的 StopWatch，不会自动启用；stop 可关闭已禁用但 isOn 仍为 true 的秒表。RepeatedCountdownReminder 仅支持 status/stop：暂停现有倒计时，不清缓存、不关闭完成提示，启动或恢复请在 SP 中操作。ClickCounter 不支持启停。已达到目标开关状态时不再切换；冲突或结果未知先查询 status，不自动重试。localOnly 只表示开关状态不跨设备同步；秒表累计时长仍由 SP 定期和停止时持久化，返回 applied-state 不保证磁盘落盘完成。",
    parameters: {
      type: "object", additionalProperties: false, required: ["action", "counterId"],
      properties: {
        action: { type: "string", enum: ["status", "start", "stop"] },
        counterId: { type: "string", minLength: 1, maxLength: 240, description: "已有计数器精确ID；可先用 sp_tasks_counter_config 查找。" },
        expected: { type: "object", additionalProperties: false, required: COUNTER_CONTROL_FIELDS, properties: COUNTER_CONTROL_PROPERTIES, description: "仅start/stop且必填：status刚返回的完整counter，包含id/type/isEnabled/isOn。" },
      },
    },
    execute: guard(async (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args) || !["status", "start", "stop"].includes(args.action)) throw new SpError("SP_BAD_INPUT", "action必须为status/start/stop，不接受toggle。");
      const { action, ...input } = args;
      const op = action === "status" ? "counterControl.list" : `counterControl.${action}`;
      let body;
      try { body = validateCounterControlCommand(op, input); }
      catch (error) { throw new SpError("SP_BAD_INPUT", error.message); }
      let status;
      try { status = await bridge.status(); }
      catch { throw new SpError("SP_BRIDGE_UNAVAILABLE", "无法确认 SP 扩展连接，请在任务台设置中刷新连接状态。"); }
      if (status?.enabled !== true || status.running !== true || status.connected !== true || status.available === false || status.accepting === false || status.stopping === true || status.error || status.protocol !== 1) throw new SpError("SP_BRIDGE_NOT_CONNECTED", "请先在任务台设置中连接 SP 配套扩展。");
      if (!versionAtLeast(status.pluginVersion, "0.4.0")) throw new SpError("SP_BRIDGE_UPGRADE_REQUIRED", "计数器启停需要 SP 扩展 0.4.0 或更新正式版。");
      const writing = action !== "status";
      let result;
      try { result = await bridge.execute(op, body); }
      catch (cause) {
        const error = new SpError(cause?.code || "SP_BRIDGE_ERROR", String(cause?.message || "SP 计数器控制请求失败。"));
        if (cause?.outcomeUnknown === true) error.outcomeUnknown = true;
        throw error;
      } finally { if (writing) invalidateNotice(); }
      let counter;
      try { counter = projectCounterControl(result?.counter); }
      catch { counterControlResponseError(writing); }
      if (counter.id !== body.counterId || result.localOnly !== true) counterControlResponseError(writing);
      if (writing && (typeof result.unchanged !== "boolean" || result.verification !== "applied-state" ||
          counter.type !== body.expected.type || counter.isEnabled !== body.expected.isEnabled || counter.isOn !== (action === "start") ||
          action === "start" && (counter.type !== "StopWatch" || !counter.isEnabled))) counterControlResponseError(true);
      return ok({ counter, localOnly: true, ...(writing ? { unchanged: result.unchanged, verification: "applied-state" } : {}) });
    }),
  });
}
