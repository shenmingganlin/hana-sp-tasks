import { SpError } from "./sp.js";
import { invalidateNotice } from "./notice.js";
import { registerAppTool } from "./tool-registration.js";
import { versionAtLeast } from "./capabilities.js";
import { WORK_CONTEXT_TYPES, WORK_CONTEXT_TARGET_TYPES, validateWorkContextCommand, workContextTargetIdentity, projectWorkContext } from "./work-context-contract.js";

export const WORK_CONTEXT_CAPABILITIES = [
  { id: "work_context", label: "活动工作上下文", description: "读取或切换本机活动项目、标签、今天或收件箱。切换会清除任务详情选择，并按已有配置刷新关联服务；不导航页面、不停止计时。", requires: "bridge", minimumPluginVersion: "0.4.0", tools: ["sp_tasks_work_context"] },
];
function workContextBadResponse(writing) {
  const error = new SpError("SP_BRIDGE_BAD_RESPONSE", "SP 扩展未确认完整的工作上下文，请先重新读取当前上下文。");
  if (writing) error.outcomeUnknown = true;
  throw error;
}
function workContextCallError(cause) {
  const code = typeof cause?.code === "string" && /^SP_[A-Z0-9_]{1,96}$/.test(cause.code) ? cause.code : "SP_BRIDGE_ERROR";
  const messages = {
    SP_CONTEXT_CONFLICT: "当前工作上下文已变化，请重新 get 后再决定是否切换。",
    SP_CONTEXT_NOT_READY: "SP 尚未返回当前工作上下文，请等待加载完成后重新 get。",
    SP_CONTEXT_UNSUPPORTED: "当前 SP 未提供此操作需要的公开接口。",
    SP_NO_PROJECT: "找不到这个精确项目 ID。",
    SP_NO_TAG: "找不到这个精确标签 ID。",
    SP_ARCHIVED_PROJECT: "目标项目已归档，请先在 SP 中恢复。",
  };
  const error = new SpError(code, messages[code] || "SP 工作上下文请求未完成，请先 get 查询当前状态，不要自动重试切换。");
  if (cause?.outcomeUnknown === true) error.outcomeUnknown = true;
  return error;
}

export async function registerWorkContextTools(sdk, { bridge, guard, ok }) {
  await registerAppTool(sdk, {
    name: "sp_tasks_work_context",
    description: "需要 SP 配套扩展 0.4.0。get 读取本机活动工作上下文，返回 id/type/title/taskIds/localOnly；未就绪返回 context:null。switch 要先 get，再将当前上下文的 id/type 两字段作为 expected，并指定 contextType 为 project 或 tag，以及精确 contextId。今天用 tag + TODAY，收件箱用 project + INBOX_PROJECT。只切活动上下文，不导航当前路由页面，不停止或启动任务计时，也不启动番茄钟。实际切换会清除任务详情选择、关闭当前提示，并可能按现有配置刷新关联事项服务。重复切换到当前目标不再次派发。冲突或结果未知时先 get，不自动重试。",
    parameters: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["get", "switch"] },
        contextType: { type: "string", enum: WORK_CONTEXT_TARGET_TYPES, description: "仅 switch：目标是项目 project 还是标签 tag。" },
        contextId: { type: "string", maxLength: 240, description: "仅 switch：目标精确 ID；支持 TODAY 和 INBOX_PROJECT。" },
        expected: { type: "object", additionalProperties: false, required: ["id", "type"], properties: { id: { type: "string", maxLength: 240 }, type: { type: "string", enum: WORK_CONTEXT_TYPES } }, description: "仅 switch 且必填：get 刚返回的当前上下文 id/type 两字段，不包含标题、任务列表或 localOnly。" },
      },
    },
    execute: guard(async (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args) || !["get", "switch"].includes(args.action)) throw new SpError("SP_BAD_INPUT", "action 必须为 get 或 switch。");
      const { action, ...input } = args, op = action === "get" ? "workContext.list" : "workContext.switch";
      let body;
      try { body = validateWorkContextCommand(op, input); }
      catch (error) { throw new SpError("SP_BAD_INPUT", error.message); }
      let status;
      try { status = await bridge.status(); }
      catch { throw new SpError("SP_BRIDGE_UNAVAILABLE", "无法确认 SP 扩展连接，请在任务台设置中刷新连接状态。"); }
      if (status?.enabled !== true || status.running !== true || status.connected !== true || status.available === false || status.accepting === false || status.stopping === true || status.error || status.protocol !== 1) throw new SpError("SP_BRIDGE_NOT_CONNECTED", "请先在任务台设置中连接 SP 配套扩展。");
      if (!versionAtLeast(status.pluginVersion, "0.4.0")) throw new SpError("SP_BRIDGE_UPGRADE_REQUIRED", "工作上下文控制需要 SP 扩展 0.4.0 或更新正式版。");
      const writing = action === "switch";
      let result;
      try { result = await bridge.execute(op, body); }
      catch (cause) { throw workContextCallError(cause); }
      finally { if (writing) invalidateNotice(); }
      if (!result || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "context") || result.context !== null && result.context?.localOnly !== true) workContextBadResponse(writing);
      let context;
      try { context = projectWorkContext(result.context); }
      catch { workContextBadResponse(writing); }
      if (writing) {
        const desired = workContextTargetIdentity(body.contextType, body.contextId);
        if (!context || context.id !== desired.id || context.type !== desired.type || typeof result.unchanged !== "boolean" || result.verification !== "applied-state") workContextBadResponse(true);
      }
      return ok({ context, ...(writing ? { unchanged: result.unchanged, verification: "applied-state" } : {}) });
    }),
  });
}
