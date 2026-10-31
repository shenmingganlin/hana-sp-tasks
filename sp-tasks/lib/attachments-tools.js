import { SpError } from "./sp.js";
import { invalidateNotice } from "./notice.js";
import { registerAppTool } from "./tool-registration.js";
import { versionAtLeast } from "./capabilities.js";
import { ATTACHMENT_URL_LIMIT, ATTACHMENT_TITLE_LIMIT, attachmentExactId, validateAttachmentCommand, projectAttachmentSnapshot } from "./attachments-contract.js";

export const ATTACHMENT_CAPABILITIES = [
  { id: "task_attachments", label: "任务链接附件", description: "查看、添加和移除活动任务的 HTTP/HTTPS 链接附件，以完整附件版本校验防止覆盖新改动，保留文件、图片等其他附件。不上传、下载、打开链接或删除文件。", requires: "bridge", minimumPluginVersion: "0.5.0", tools: ["sp_tasks_attachments"] },
];

function attachmentResponseError(writing) {
  const error = new SpError("SP_BRIDGE_BAD_RESPONSE", "SP 扩展未确认完整的链接附件结果，请先 list 查询，不要自动重试写入。");
  if (writing) error.outcomeUnknown = true;
  throw error;
}
function attachmentCallError(cause) {
  const code = typeof cause?.code === "string" && /^SP_[A-Z0-9_]{1,96}$/.test(cause.code) ? cause.code : "SP_BRIDGE_ERROR";
  const messages = {
    SP_ATTACHMENT_CONFLICT: "附件已被修改，请重新 list 后再决定是否更新。",
    SP_ATTACHMENT_DUPLICATE: "任务已有相同规范化 URL 的链接，请先 list 确认，不会自动添加副本。",
    SP_ATTACHMENT_UNSUPPORTED: "当前接口或目标附件不支持安全更新，仅支持具唯一 ID 的 HTTP/HTTPS 链接。",
    SP_ATTACHMENT_LIMIT: "完整附件元数据超过安全处理限额，请在 SP 中操作。",
    SP_NO_TASK: "找不到这个精确活动任务 ID，归档任务不能直接编辑附件。",
    SP_COMMAND_CANCELLED: "附件命令已取消或过期，没有继续写入。",
  };
  const error = new SpError(code, messages[code] || "SP 附件请求未完成，请先 list 确认当前状态，不要自动重试添加或移除。");
  if (cause?.outcomeUnknown === true) error.outcomeUnknown = true;
  return error;
}

export async function registerAttachmentTools(sdk, { bridge, guard, ok }) {
  await registerAppTool(sdk, {
    name: "sp_tasks_attachments",
    description: "需要 SP 配套扩展 0.5.0。list 查询一个精确活动任务的可编辑 HTTP/HTTPS 链接附件，返回全附件 revision；otherCount 包含保留的图片、文件、旧格式或无法安全编辑的附件。add/remove 必须先 list，把刚返回的 revision 作为 expectedRevision。add 的 url 会按标准 URL 规范化，可附单行 title；相同 URL 拒绝重复。remove 按 attachmentId 精确移除链接，目标已不存在且版本一致则不写。不会上传、下载、访问或打开链接，也不删除文件。SHA-256 覆盖所有附件及隐藏字段；写前再次读取，写后核对整个数组。SP 没有原子比较写接口，applied-state 仅表示读回当前状态，不保证磁盘或跨设备同步完成。超时或结果未知先 list，不自动重试。单任务最多1000项、完整元数据256KiB。",
    parameters: {
      type: "object", additionalProperties: false, required: ["action", "taskId"],
      properties: {
        action: { type: "string", enum: ["list", "add", "remove"] },
        taskId: { type: "string", minLength: 1, maxLength: 240, description: "活动任务精确 ID，不接受名称或路径。" },
        expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$", description: "仅 add/remove 且必填：list 刚返回的完整附件 revision。" },
        url: { type: "string", minLength: 1, maxLength: ATTACHMENT_URL_LIMIT, description: "仅 add 且必填：HTTP/HTTPS 绝对 URL，不含空白、反斜杠或内嵌用户名密码。" },
        title: { type: "string", maxLength: ATTACHMENT_TITLE_LIMIT, description: "仅 add：可选单行链接标题。" },
        attachmentId: { type: "string", minLength: 1, maxLength: 240, description: "仅 remove 且必填：list 返回的可编辑链接精确 ID。" },
      },
    },
    execute: guard(async (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args) || !["list", "add", "remove"].includes(args.action)) throw new SpError("SP_BAD_INPUT", "action 必须为 list、add 或 remove。");
      const { action, ...input } = args, op = `attachments.${action}`;
      let body;
      try { body = validateAttachmentCommand(op, input); }
      catch (error) { throw new SpError("SP_BAD_INPUT", error.message); }
      let status;
      try { status = await bridge.status(); }
      catch { throw new SpError("SP_BRIDGE_UNAVAILABLE", "无法确认 SP 扩展连接，请在任务台设置中刷新状态。"); }
      if (status?.enabled !== true || status.running !== true || status.connected !== true || status.available === false || status.accepting === false || status.stopping === true || status.error || status.protocol !== 1) throw new SpError("SP_BRIDGE_NOT_CONNECTED", "请先在任务台设置中连接 SP 配套扩展。");
      if (!versionAtLeast(status.pluginVersion, "0.5.0")) throw new SpError("SP_BRIDGE_UPGRADE_REQUIRED", "链接附件管理需要 SP 扩展 0.5.0 或更新正式版。");
      const writing = action !== "list";
      let result;
      try { result = await bridge.execute(op, body); }
      catch (cause) { throw attachmentCallError(cause); }
      finally { if (writing) invalidateNotice(); }
      let snapshot;
      try { snapshot = projectAttachmentSnapshot(result); }
      catch { attachmentResponseError(writing); }
      if (snapshot.taskId !== body.taskId) attachmentResponseError(writing);
      if (writing) {
        if (!attachmentExactId(result.attachmentId) || typeof result.unchanged !== "boolean" || result.verification !== "applied-state") attachmentResponseError(true);
        if (action === "add") {
          const added = snapshot.attachments.find((row) => row.id === result.attachmentId);
          if (result.unchanged !== false || snapshot.revision === body.expectedRevision || !added || added.url !== body.url || (Object.hasOwn(body, "title") ? added.title !== body.title : Object.hasOwn(added, "title"))) attachmentResponseError(true);
        } else if (result.attachmentId !== body.attachmentId || snapshot.attachments.some((row) => row.id === body.attachmentId) || (result.unchanged ? snapshot.revision !== body.expectedRevision : snapshot.revision === body.expectedRevision)) attachmentResponseError(true);
      }
      return ok({ ...snapshot, ...(writing ? { attachmentId: result.attachmentId, unchanged: result.unchanged, verification: "applied-state" } : {}) });
    }),
  });
}
