// sp-tasks — 把 Super Productivity 接进对话
//
// 设计取向（v0.2.0 起）：不做界面。SP 自己就是界面，而且比任何复刻都好。
// 这里只补它单独用时不具备的能力——对话里的自然语言批量操作。
//
// 数据通道：SP 19.x 自带的本地 REST API（127.0.0.1:3876，Bearer token），
// 日常任务继续直连 REST；项目/标签写入通过可选的官方 SP 插件桥接。
// SP 是唯一任务记录源；本机只持久保存配对凭据和归档恢复所需的完成元数据。
import { defineApp } from "./sdk/app-contract/server-client.js";
import { fileURLToPath } from "node:url";
import { SpError, sp, readConfig } from "./lib/sp.js";
import { buildOverview, normalizeTaskInput, resolveNamedEntity, summarizeTask, taskIsOverdue, taskIsPlannedForDay } from "./lib/view.js";
import { localDay, resolveDay, resolveDuration } from "./lib/date.js";
import { dateProperties, pageOf, taskDateFields, taskIds } from "./lib/task-input.js";
import { registerFeatureTools } from "./lib/features.js";
import { registerStructureTools } from "./lib/structure-tools.js";
import { registerExtendedTools, EXTENDED_CAPABILITIES } from "./lib/extended-tools.js";
import { registerPreferenceTools, PREFERENCE_CAPABILITIES } from "./lib/preference-tools.js";
import { registerCounterControlTools, COUNTER_CONTROL_CAPABILITIES } from "./lib/counter-control-tools.js";
import { registerWorkContextTools, WORK_CONTEXT_CAPABILITIES } from "./lib/work-context-tools.js";
import { registerUiControlTools, UI_CONTROL_CAPABILITIES } from "./lib/ui-control-tools.js";
import { registerAttachmentTools, ATTACHMENT_CAPABILITIES } from "./lib/attachments-tools.js";
import { registerKeyboardTools, KEYBOARD_CAPABILITIES } from "./lib/keyboard-tools.js";
import { createBridgeClient } from "./lib/bridge-client.js";
import { createBridgeSetup, registerBridgeSetupRoutes, writeBundledPlugin } from "./lib/bridge-setup.js";
import * as desktopTheme from "./lib/desktop-theme.js";
import { registerCapabilityTool } from "./lib/capabilities.js";
import { registerAppTool } from "./lib/tool-registration.js";
import { createTaskManager } from "./lib/archive-management.js";
import { injectNotice } from "./lib/inject.js";
import { readNotice, invalidateNotice } from "./lib/notice.js";
import { diagnose } from "./lib/diagnose.js";

export const name = "sp-tasks";

const ok = (payload) => ({
  content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload }, null, 2) }],
});
const bad = (error) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(
        {
          ok: false,
          code: error instanceof SpError ? error.code : "SP_UNEXPECTED",
          message: String(error?.message ?? error),
          ...(typeof error?.createdId === "string" && error.createdId.trim() ? { createdId: error.createdId } : {}),
          ...(error?.outcomeUnknown ? {
            outcomeUnknown: true,
            note: "写请求结果未确认，SP 可能已经保存。请先查询状态；创建任务、补记工时等累加操作不能直接重试。",
          } : {}),
        },
        null,
        2
      ),
    },
  ],
  isError: true,
});

/** 每个工具的骨架：拿配置、跑活、把失败翻译成人话。 */
const guardWithSdk = (sdk, work) => async (args) => {
  try {
    const cfg = await readConfig(sdk);
    return await work(args ?? {}, cfg);
  } catch (error) {
    return bad(error);
  }
};

export default defineApp(async (sdk) => {
  const sdkRef = sdk;
  const guard = (work) => guardWithSdk(sdk, work);
  const bridge = createBridgeClient(sdk);
  const bridgeGuard = (work) => async (args = {}) => {
    try { return await work(args); }
    catch (cause) {
      const error = cause instanceof SpError ? cause : new SpError(cause?.code || "SP_BRIDGE_ERROR", String(cause?.message || "SP 配套插件调用失败。"));
      if (cause?.outcomeUnknown === true) error.outcomeUnknown = true;
      if (typeof cause?.createdId === "string") error.createdId = cause.createdId;
      return bad(error);
    }
  };
  const manageTasks = createTaskManager(sdk, { bridge });
  const registerTool = (definition) => registerAppTool(sdk, {
    ...definition,
    parameters: { ...definition.parameters, additionalProperties: false },
    execute: async (input = {}) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return bad(new SpError("SP_BAD_INPUT", "参数必须是对象。"));
      const properties = definition.parameters.properties;
      for (const [key, value] of Object.entries(input)) {
        const schema = properties[key];
        if (!Object.hasOwn(properties, key)) return bad(new SpError("SP_BAD_INPUT", `此工具不支持参数 ${key}，请按当前工具定义调用。`));
        if (value === undefined) continue;
        // Duration parsing preserves its more specific errors and accepts numeric minutes.
        if (["timeEstimate", "duration"].includes(key)) continue;
        const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
        if (schema.type === "integer" ? !Number.isSafeInteger(value) : schema.type !== type) {
          return bad(new SpError("SP_BAD_INPUT", `${key} 的类型不正确，应为 ${schema.type}。`));
        }
        if (schema.enum && !schema.enum.includes(value)) return bad(new SpError("SP_BAD_INPUT", `${key} 必须是 ${schema.enum.join(" / ")}。`));
        if (schema.type === "array" && schema.items?.type === "string" && value.some((item) => typeof item !== "string")) {
          return bad(new SpError("SP_BAD_INPUT", `${key} 必须是字符串数组。`));
        }
      }
      return definition.execute(input);
    },
  });
  // 版本号从清单读，不手写。之前写死过两次，日志和清单对不上，
  // 白白浪费一轮排查——日志说的版本应该就是实际跑的那个。
  // 路径用模块自身的 URL 算，不拼 dataDir：安装目录和 dataDir 不是同一个地方。
  let version = "unknown";
  try {
    const here = new URL("./manifest.json", import.meta.url);
    const manifest = await sdk.resources.read({ kind: "local-file", path: fileURLToPath(here) });
    const text = typeof manifest === "string" ? manifest : manifest?.content ?? manifest?.text ?? "";
    version = JSON.parse(String(text)).version ?? version;
  } catch {
    // 读不到不影响任何功能，日志里标 unknown 已经足够。
  }
  await sdk.logger.info(`sp-tasks ${version} loaded | dataDir=${sdk.dataDir}`);
  const bridgeSetup = createBridgeSetup({ bridge, version, extensions: [...EXTENDED_CAPABILITIES, ...PREFERENCE_CAPABILITIES, ...COUNTER_CONTROL_CAPABILITIES, ...WORK_CONTEXT_CAPABILITIES, ...UI_CONTROL_CAPABILITIES, ...ATTACHMENT_CAPABILITIES, ...KEYBOARD_CAPABILITIES] });

  // ── 1. 总览 ────────────────────────────────────────────────────────────
  await registerTool({
    name: "sp_tasks_overview",
    description:
      "看 Super Productivity 当前的待办全貌：今天要做的、已过期的、收件箱里还没安排的，以及现在正在计时哪一条。" +
      "回答「我今天有什么」「还有哪些没做」「现在在做什么」这类问题都用它。" +
      "返回里的 counts 是各栏数量，effort 是今天已排任务的预估与已投入时长。",
    parameters: {
      type: "object",
      properties: {
        includeDone: { type: "boolean", description: "连已完成的任务也一起取回，默认 false。" },
      },
    },
    execute: guard(async (args, cfg) => {
      const overview = await buildOverview(sdkRef, cfg, { includeDone: args.includeDone === true });
      return ok(overview);
    }),
  });

  // ── 2. 新建 ────────────────────────────────────────────────────────────
  await registerTool({
    name: "sp_tasks_create",
    description:
      "在 Super Productivity 里新建一条待办。日期和时长直接写人话即可：" +
      "计划执行日用 dueDay，计划时刻用 dueWithTime；真正截止日/时刻用 deadlineDay/deadlineWithTime。" +
      "timeEstimate 收「30m / 1h30m / 90」。项目与标签按名字匹配，匹配不到不会瞎挂。" +
      "一次只能建一条；要建多条就多次调用。" +
      "若返回 partial: true，任务已创建，只是安排未确认成功；告知用户并按 retry 用 update 重试，不要重新 create。" +
      "标题按原文保存，#、+、时间等不会被 SP 二次解析。项目/标签须已存在且完整名称唯一匹配。重复规则请在建好后用 sp_tasks_repeat 配置。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "任务标题，写成一句可执行的动作。" },
        notes: { type: "string", description: "备注。" },
        project: { type: "string", description: "项目名，按名字匹配已有项目；不给就进收件箱。" },
        projectId: { type: "string", description: "用 id 精确指定项目，适合同名项目；与 project 二选一。" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "标签名数组，只匹配已有标签，不会新建。",
        },
        tagIds: { type: "array", items: { type: "string" }, description: "用 id 精确指定标签；与 tags 二选一。" },
        ...dateProperties,
        planToday: { type: "boolean", description: "true 表示同时安排到今天执行（进今天视图）。" },
        parentId: { type: "string", description: "父任务 id，给了就建成子任务。" },
      },
      required: ["title"],
    },
    execute: guard(async (args, cfg) => {
      const body = await normalizeTaskInput(sdkRef, cfg, {
        title: args.title,
        notes: args.notes,
        projectTitle: args.project,
        projectId: args.projectId,
        tags: args.tags,
        tagIds: args.tagIds,
        parentId: args.parentId,
      });

      const fields = taskDateFields(args, { todayFlag: "planToday" });
      Object.assign(body, fields, { isIgnoreShortSyntax: true });
      if (args.planToday === true) {
        body.dueDay = null;
        body.dueWithTime = null;
      }

      const created = await sp.createTask(sdkRef, cfg, body);
      // 改动了 SP 就丢掉摘要缓存，否则下一轮注入的还是旧数字。
      invalidateNotice();

      // Keep creation and planning outcomes separate so a planning failure cannot cause duplicate creation.
      if (args.planToday === true && created?.id) {
        try {
          const planned = await sp.updateTask(sdkRef, cfg, created.id, {
            dueDay: fields.dueDay, dueWithTime: null,
          });
          return ok({ task: summarizeTask(planned), plannedToday: true });
        } catch (error) {
          // POST 已经成功，不能把已创建的任务藏进整体错误，更不能 DELETE 回滚。
          return ok({
            task: summarizeTask(created),
            partial: true,
            plannedToday: false,
            planningError: {
              code: error instanceof SpError ? error.code : "SP_UNEXPECTED",
              message: String(error?.message ?? error),
            },
            note: "任务已创建，但安排到今天未确认成功。不要重新创建；只用返回的 id 重试安排。",
            retry: { tool: "sp_tasks_update", args: { taskIds: [created.id], planForToday: true } },
          });
        }
      }
      return ok({ task: summarizeTask(created) });
    }),
  });

  // ── 3. 改（含批量）────────────────────────────────────────────────────
  await registerTool({
    name: "sp_tasks_update",
    description:
      "批量修改 Super Productivity 的任务。taskIds 收一个或多个 id；先用 sp_tasks_search 或 sp_tasks_overview 拿到 id。" +
      "能做：勾完成/取消完成、改标题或备注、改计划日和真正截止日、安排到今天/取消安排、改预估时长、替换标签、挪项目。" +
      "「把这个项目里过期的都推到下周」这类请求就是先 search 再一次性 update。",
    parameters: {
      type: "object",
      properties: {
        taskIds: {
          type: "array",
          items: { type: "string" },
          description: "要改的任务 id 列表。",
        },
        isDone: { type: "boolean", description: "true 勾完成，false 取消完成。" },
        title: { type: "string" },
        notes: { type: "string" },
        ...dateProperties,
        planForToday: { type: "boolean", description: "true 安排到今天，false 取消安排。" },
        project: { type: "string", description: "移动到该项目（按名字匹配）。仅对顶层任务有效。" },
        projectId: { type: "string", description: "用 id 精确指定目标项目；与 project 二选一。" },
        tags: { type: "array", items: { type: "string" }, description: "完整标签名称数组，替换原有标签；[] 清空。子任务继承父任务标签。" },
        tagIds: { type: "array", items: { type: "string" }, description: "用 id 精确指定标签，[] 清空；与 tags 二选一。" },
      },
      required: ["taskIds"],
    },
    execute: guard(async (args, cfg) => {
      const ids = taskIds(args.taskIds);

      const patch = {};
      if (typeof args.isDone === "boolean") patch.isDone = args.isDone;
      if (args.title !== undefined) {
        if (typeof args.title !== "string" || !args.title.trim()) throw new SpError("SP_BAD_INPUT", "任务标题不能为空。");
        patch.title = args.title.trim();
        patch.isIgnoreShortSyntax = true;
      }
      if (typeof args.notes === "string") patch.notes = args.notes;

      Object.assign(patch, taskDateFields(args, { todayFlag: "planForToday" }));
      if (args.isDone === true && ("dueDay" in patch || "dueWithTime" in patch)) {
        throw new SpError("SP_BAD_INPUT", "SP 可能忽略完成时同时修改的计划。请先单独修改计划，再标记完成。");
      }
      if (args.project !== undefined && (typeof args.project !== "string" || !args.project.trim())) throw new SpError("SP_BAD_INPUT", "project 必须是非空项目名。");
      if (args.project !== undefined && args.projectId !== undefined) throw new SpError("SP_BAD_INPUT", "project 与 projectId 请只提供一个。");
      if (args.tags !== undefined && args.tagIds !== undefined) throw new SpError("SP_BAD_INPUT", "tags 与 tagIds 请只提供一个。");
      if (typeof args.project === "string" && args.project.trim()) {
        const projects = await sp.projects(sdkRef, cfg);
        const hit = resolveNamedEntity(projects.filter((p) => !p.isArchived), args.project, "project");
        patch.projectId = hit.id;
      }
      if (args.projectId !== undefined) {
        const projects = await sp.projects(sdkRef, cfg);
        if (!projects.some((p) => p.id === args.projectId && !p.isArchived)) throw new SpError("SP_NO_PROJECT", "projectId 对应的项目不存在或已经归档。");
        patch.projectId = args.projectId;
      }
      if (args.tags !== undefined) {
        if (!Array.isArray(args.tags)) throw new SpError("SP_BAD_INPUT", "tags 必须是标签名称数组。");
        const tags = args.tags.length ? await sp.tags(sdkRef, cfg) : [];
        patch.tagIds = [...new Set(args.tags.map((tag) => resolveNamedEntity(tags, tag, "tag").id))];
      }
      if (args.tagIds !== undefined) {
        if (!Array.isArray(args.tagIds)) throw new SpError("SP_BAD_INPUT", "tagIds 必须是数组。");
        const tags = args.tagIds.length ? await sp.tags(sdkRef, cfg) : [];
        if (args.tagIds.some((id) => !tags.some((tag) => tag.id === id))) throw new SpError("SP_NO_TAG", "tagIds 包含不存在的标签。");
        patch.tagIds = [...new Set(args.tagIds)];
      }

      if (!Object.keys(patch).length) throw new SpError("SP_BAD_INPUT", "没有给出要修改的字段。");

      const results = [];
      for (const id of ids) {
        try {
          const updated = await sp.updateTask(sdkRef, cfg, id, patch);
          results.push({ id, ok: true, title: updated?.title ?? null });
        } catch (error) {
          results.push({ id, ok: false, code: error.code, outcomeUnknown: error.outcomeUnknown === true, message: String(error?.message ?? error) });
        }
      }
      const failed = results.filter((r) => !r.ok);
      if (results.length > failed.length) invalidateNotice();
      return ok({
        changed: results.filter((r) => r.ok).length,
        failed: failed.length,
        results,
        note: failed.length ? "部分任务修改未确认成功，逐条原因见 results；outcomeUnknown 表示可能已写入，先查询再决定是否重试。" : undefined,
      });
    }),
  });

  // ── 4. 检索 ────────────────────────────────────────────────────────────
  await registerTool({
    name: "sp_tasks_search",
    description:
      "按标题关键词、项目、标签检索 Super Productivity 里的任务，拿 id 供后续修改。" +
      "建新任务前先用它查重，避免同一件事记两遍。" +
      "source 默认 active（在用的）；archived 翻已归档的，all 两边都找。" +
      "归档任务需先用 sp_tasks_manage restore 恢复后才能修改。默认不包含已完成，翻归档通常需 includeDone:true。" +
      "hasMore 为 true 时用 nextOffset 继续查询，批量操作必须先收集全部页，再修改以免分页期间漏项。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "标题里要包含的文字，不区分大小写。" },
        project: { type: "string", description: "只看某个项目里的（按名字匹配）。" },
        projectId: { type: "string", description: "精确项目 ID，与 project 二选一。" },
        tag: { type: "string", description: "只看带这个标签的任务（完整名称唯一匹配）。" },
        tagId: { type: "string", description: "精确标签 ID，与 tag 二选一；TODAY 表示 SP 今天视图。" },
        includeDone: { type: "boolean", description: "连已完成一起找，默认 false。" },
        overdueOnly: { type: "boolean", description: "只看已过计划日或真正截止日的未完成任务。" },
        source: {
          type: "string",
          enum: ["active", "archived", "all"],
          description: "active 只找在用的（默认），archived 只找归档的，all 两边都找。",
        },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "每页条数，默认 30，最多 200。" },
        offset: { type: "integer", minimum: 0, description: "跳过几条，默认 0；继续分页时用上次的 nextOffset。" },
      },
    },
    execute: guard(async (args, cfg) => {
      const source = args.source === "archived" || args.source === "all" ? args.source : "active";
      const rows = await sp.tasks(sdkRef, cfg, {
        query: args.query,
        includeDone: args.includeDone === true ? "true" : undefined,
        source,
      });
      const today = localDay();
      const projects = await sp.projects(sdkRef, cfg).catch(() => []);

      let list = Array.isArray(rows) ? rows : [];
      if (args.project !== undefined && args.projectId !== undefined || args.tag !== undefined && args.tagId !== undefined) {
        throw new SpError("SP_BAD_INPUT", "名称与 ID 筛选请分别只提供一种。");
      }
      if (typeof args.project === "string" && args.project.trim()) {
        const hit = resolveNamedEntity(projects, args.project, "project");
        list = list.filter((t) => t.projectId === hit.id);
      }
      if (args.projectId !== undefined) {
        const [id] = taskIds([args.projectId]);
        list = list.filter((t) => t.projectId === id);
      }
      if (args.tag !== undefined || args.tagId !== undefined) {
        const id = args.tagId !== undefined ? taskIds([args.tagId])[0]
          : resolveNamedEntity(await sp.tags(sdkRef, cfg), args.tag, "tag").id;
        list = list.filter((t) => id === "TODAY" ? taskIsPlannedForDay(t, today) : t.tagIds?.includes(id));
      }
      if (args.overdueOnly === true) {
        list = list.filter((t) => taskIsOverdue(t, today));
      }
      if (args.includeDone !== true) list = list.filter((t) => !t.isDone);

      const { rows: page, ...pagination } = pageOf(list, args);
      const projectTitleOf = (id) => (projects || []).find((p) => p.id === id)?.title ?? null;
      const tasks = page.map((t) => summarizeTask(t, { projectTitleOf }));
      return ok({ ...pagination, source, tasks });
    }),
  });

  // ── 5. 计时 ────────────────────────────────────────────────────────────
  await registerTool({
    name: "sp_tasks_timer",
    description:
      "控制 Super Productivity 的任务计时器。start 开始给某条任务计时（会接管当前计时），" +
      "stop 停止，status 看现在在计哪条（running 为 false 表示没有任务在计时）。" +
      "任务标题用 sp_tasks_search 查，别猜 id。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "status"] },
        taskId: { type: "string", description: "action=start 时必填。" },
      },
      required: ["action"],
    },
    execute: guard(async (args, cfg) => {
      if (args.action === "start") {
        [args.taskId] = taskIds([args.taskId]);
        const result = await sp.startTask(sdkRef, cfg, args.taskId);
        invalidateNotice();
        const task = await sp.task(sdkRef, cfg, args.taskId).catch(() => null);
        return ok({ currentTaskId: result.currentTaskId, title: task?.title ?? null });
      }
      if (args.action === "stop") {
        const before = await sp.currentTask(sdkRef, cfg).catch(() => null);
        await sp.stopTask(sdkRef, cfg);
        invalidateNotice();
        return ok({ stopped: before ? { id: before.id, title: before.title } : null });
      }
      if (args.action === "status") {
        // 不再回 focus.timer：那是专注模式（番茄钟）的计时器，任务计时中它照样是 null。
        // 真实信号只有 currentTask 本身存在（= 正在给它计时）。
        const current = await sp.currentTask(sdkRef, cfg);
        return ok({
          running: current !== null && current !== undefined,
          // 带上 ctx.currentTaskId，让投影里的 current 标记说真话，
          // 不然这条明明是当前计时任务，却标着 current: false。
          currentTask: current
            ? summarizeTask(current, { currentTaskId: current.id ?? null })
            : null,
        });
      }
      throw new SpError("SP_BAD_INPUT", "action 只能是 start / stop / status。");
    }),
  });

  // ── 6. 记工时 ──────────────────────────────────────────────────────────
  await registerTool({
    name: "sp_tasks_log_time",
    description:
      "给某条任务补记录已投入的工时（不是开始计时，是事后补录）。" +
      "duration 收「45m / 1h30m」，day 收人话日期，默认今天。" +
      "有子任务的任务不能直接记工时——工时要记到子任务上，SP 会自动汇总到父任务。",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务 id。" },
        duration: { type: "string", description: "投入时长，如 45m / 1h30m。" },
        day: { type: "string", description: "记到哪一天，人话日期，默认今天。" },
        mode: {
          type: "string",
          enum: ["add", "set"],
          description: "add 在原有基础上累加（默认），set 直接覆盖该日累计。",
        },
      },
      required: ["taskId", "duration"],
    },
    execute: guard(async (args, cfg) => {
      const [taskId] = taskIds([args.taskId]);
      if (args.mode !== undefined && !["add", "set"].includes(args.mode)) throw new SpError("SP_BAD_INPUT", "mode 只能是 add / set。");
      const parsedDuration = resolveDuration(args.duration);
      if (!parsedDuration.ok) throw new SpError("SP_BAD_DURATION", parsedDuration.error);
      if (parsedDuration.ms === null) throw new SpError("SP_BAD_INPUT", "duration 不能为空。");
      if (parsedDuration.ms > 86400000) throw new SpError("SP_BAD_DURATION", "一天记录的工时不能超过 24 小时。");

      const dayResult = resolveDay(args.day ?? "今天");
      if (!dayResult.ok) throw new SpError("SP_BAD_DATE", dayResult.error);

      const method = args.mode === "set" ? "PUT" : "POST";
      const updated = await sp.logTime(
        sdkRef,
        cfg,
        taskId,
        { date: dayResult.day, duration: Math.round(parsedDuration.ms) },
        method
      );
      invalidateNotice();
      return ok({
        task: summarizeTask(updated),
        loggedMs: Math.round(parsedDuration.ms),
        day: dayResult.day,
      });
    }),
  });

  // ── 7. 项目与标签 ──────────────────────────────────────────────────────
  await registerTool({
    name: "sp_tasks_context",
    description:
      "列出 Super Productivity 里现有的项目和标签。要往某个项目建任务、或想给任务打标签之前先用它，" +
      "否则容易造出重复项目或打错标签。" +
      "本工具只读；配对插件后项目管理用 sp_tasks_projects、标签管理用 sp_tasks_tags，连接检查用 sp_tasks_bridge。重复规则用 sp_tasks_repeat；笔记用 sp_tasks_notes。",
    parameters: { type: "object", properties: {} },
    execute: guard(async (_args, cfg) => {
      const [projects, tags] = await Promise.all([sp.projects(sdkRef, cfg), sp.tags(sdkRef, cfg)]);
      return ok({
        projects: (Array.isArray(projects) ? projects : [])
          .filter((p) => !p.isArchived)
          .map((p) => ({ id: p.id, title: p.title })),
        tags: (Array.isArray(tags) ? tags : []).map((t) => ({ id: t.id, title: t.title })),
      });
    }),
  });

  await registerTool({
    name: "sp_tasks_get",
    description: "读取一条任务的完整备注、父子关系、按日工时、计划、截止、完成时间 doneOn 与放弃标记 wontDoOn。isDone 为 true 且 wontDoOn 非空并等于 doneOn 时是 SP 的不做状态。归档任务用 source:archived；拿到 repeatCfgId 后可管理重复规则。",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        source: { type: "string", enum: ["active", "archived"] },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    execute: guard(async (args, cfg) => {
      const [id] = taskIds([args.taskId]);
      let task;
      if (args.source === "archived") {
        const rows = await sp.tasks(sdkRef, cfg, { source: "archived", includeDone: "true" });
        task = rows.find((row) => row.id === id);
        if (!task) throw new SpError("SP_TASK_NOT_FOUND", "归档区没有这条任务。");
      } else {
        task = await sp.task(sdkRef, cfg, id);
      }
      return ok({ source: args.source ?? "active", task: summarizeTask(task) });
    }),
  });

  await registerTool({
    name: "sp_tasks_manage",
    description: "批量归档、恢复或永久删除任务，先查询准确 id。archive 归档整棵任务树并保存完成状态、完成时间、放弃标记和计划日/计划时间（SP 归档会清空计划和提醒，截止日保留）；restore 在任务仍未安排时写回计划，提醒无法还原；子任务修复会让 SP 重算父任务预估，restore 随后写回归档前的父任务预估（用户恢复后改过的不覆盖）。不能单独归档子任务，应由用户明确选择父任务。restore 默认保留原完成信息；恢复已完成根任务的历史时间需连接 0.2.0 以上 SP 配套插件。无完整快照（包括 0.5.0 热修的布尔快照）时默认不恢复；仅用户接受 SP 原生行为会改变完成信息时传 allowCompletionLoss:true，并说明返回的 degradedRoots。父子同时选中只请求最高选中的父，子结果带 coveredBy。recovery 只读查看保存的恢复进度；restore 部分失败或响应丢失后先查它，再用 repair 继续，不能重新归档。repair 不重发 restore，只修待完成项，保留用户后来的改动；用户明确要保留现状时用 keepCurrentCompletion:true 结束这些待修项。failed/partial/outcomeUnknown 都必须如实报告。delete 永久删除活动任务及子任务，仅用户明确要求时使用；已归档任务返回 SP_TASK_ARCHIVED，需先 restore。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["archive", "restore", "delete", "recovery", "repair"] },
        taskIds: { type: "array", items: { type: "string" }, minItems: 1 },
        allowCompletionLoss: { type: "boolean", description: "仅 restore：用户接受无法保全原完成信息时才为 true。默认 false。" },
        keepCurrentCompletion: { type: "boolean", description: "仅 repair：用户要求保留当前完成信息、结束待修项时为 true；不会改 SP 任务。" },
      },
      required: ["action", "taskIds"],
      additionalProperties: false,
    },
    execute: guard(async (args, cfg) => ok(await manageTasks(args, cfg))),
  });

  await registerFeatureTools(sdk, { guard, ok });
  await registerStructureTools(sdk, { bridge, guard: bridgeGuard, ok });
  await registerExtendedTools(sdk, { bridge, guard: bridgeGuard, ok });
  await registerPreferenceTools(sdk, { bridge, guard: bridgeGuard, ok });
  await registerCounterControlTools(sdk, { bridge, guard: bridgeGuard, ok });
  await registerWorkContextTools(sdk, { bridge, guard: bridgeGuard, ok });
  await registerUiControlTools(sdk, { bridge, guard: bridgeGuard, ok });
  await registerAttachmentTools(sdk, { bridge, guard: bridgeGuard, ok });
  await registerKeyboardTools(sdk, { bridge, guard: bridgeGuard, ok });
  await registerCapabilityTool(sdk, { setup: bridgeSetup, guard: bridgeGuard, ok });

  // ── 8. 让模型天然知道 SP 上有什么 ─────────────────────────────────────
  //
  // 只在 pre-step 注入：它每轮都跑，且能碰的是消息末尾，不是提示词前缀。
  // before-start 改 systemPrompt 会让前缀缓存整段作废，不用它。
  //
  // 这里刻意不做任何可能拖慢对话的事：读不到就返回空，超时就当没有。
  // 用户说了话、模型还没开始想，这一步最多花 800ms；拿不到就静默跳过。
  try {
    await sdk.hooks.onDecision("agent/pre-step", async ({ messages }) => {
      if (!Array.isArray(messages)) return;
      const text = await readNotice(sdk);
      const next = injectNotice(messages, text);
      if (next == null) return;
      return { messages: next };
    });
  } catch (error) {
    // 钩子不可用不该影响工具：没有感知，操作照常。
    await sdk.logger.warn(`sp-tasks: pre-step hook unavailable: ${error?.message ?? error}`);
  }

  // ── 9. 诊断接口（给配置页用）────────────────────────────────────────
  //
  // 只诊断，不代装。用户要装 SP 就自己去装，装完回来点一下检测。
  // 这一路由只读：它不发任何写请求，也不改任何设置。
  try {
    await sdk.routes.register((app) => {
      registerBridgeSetupRoutes(app, { setup: bridgeSetup });
      app.get("/bridge/status", async (c) => {
        try { return c.json({ ok: true, bridge: await bridge.status() }); }
        catch (error) { return c.json({ ok: false, error: String(error?.message || "无法读取配套插件状态。") }, 500); }
      });
      // Pairing is a user settings action, never a model tool. Only this route
      // returns the plugin credential; the separate control credential stays private.
      app.post("/bridge/pair", async (c) => {
        try { return c.json({ ok: true, ...await bridge.pair() }); }
        catch (error) {
          const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : undefined;
          return c.json({ ok: false, error: String(error?.message || "配对服务启动失败。"), ...(code ? { code } : {}) }, 500);
        }
      });
      app.post("/bridge/disable", async (c) => {
        try { return c.json({ ok: true, bridge: await bridge.disable() }); }
        catch (error) { return c.json({ ok: false, error: String(error?.message || "无法断开配套插件。") }, 500); }
      });
      // 设置面不能调 saveFile；由用户在设置里选文件夹，后台把校验过的 ZIP 写进去。
      app.post("/bridge/export", async (c) => {
        let body;
        try { body = await c.req.json(); }
        catch { return c.json({ ok: false, error: "请求体不是 JSON" }, 400); }
        try {
          return c.json({ ok: true, ...await writeBundledPlugin({ sdk, dir: body?.dir }) });
        } catch (error) {
          if (error?.code === "EXPORT_DIR_INVALID") return c.json({ ok: false, error: error.message }, 400);
          return c.json({ ok: false, error: `写不了扩展包：${String(error?.message ?? error)}` }, 500);
        }
      });
      app.get("/diagnose", async (c) => {
        try {
          const cfg = await readConfig(sdk);
          const result = await diagnose(sdk, cfg);
          return c.json({ ok: true, ...result });
        } catch (error) {
          // 诊断自己也不能崩：把错误当成一条失败结果返回。
          return c.json({
            ok: false,
            verdict: "诊断没跑完",
            steps: [{ id: "internal", label: "诊断本身出错", ok: false, detail: String(error?.message ?? error) }],
          });
        }
      });

      // 页面要能改地址和令牌。令牌是敏感项，永远不回传明文，
      // 只回「有没有」和「从哪来的」，否则它就从设置页泄到前端了。
      app.get("/config", async (c) => {
        try {
          const cfg = await readConfig(sdk);
          return c.json({
            ok: true,
            baseUrl: cfg.baseUrl,
            hasToken: Boolean(cfg.accessToken),
            tokenSource: cfg.tokenSource ?? null,
            autoTokenTried: cfg.accessToken ? undefined : cfg.autoTokenError ?? undefined,
          });
        } catch (error) {
          return c.json({ ok: false, error: String(error?.message ?? error) }, 500);
        }
      });

      app.post("/config", async (c) => {
        let body;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ ok: false, error: "请求体不是 JSON" }, 400);
        }
        const patch = {};
        if (body?.baseUrl !== undefined) {
          if (typeof body.baseUrl !== "string") return c.json({ ok: false, error: "baseUrl 必须是字符串" }, 400);
          const trimmed = body.baseUrl.trim();
          if (trimmed && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(trimmed)) {
            return c.json({ ok: false, error: "只接受本机地址，例如 http://127.0.0.1:3876" }, 400);
          }
          patch.baseUrl = trimmed || "http://127.0.0.1:3876";
        }
        if (body?.accessToken !== undefined) {
          if (typeof body.accessToken !== "string") return c.json({ ok: false, error: "accessToken 必须是字符串" }, 400);
          patch.accessToken = body.accessToken.trim();
        }
        if (!Object.keys(patch).length) return c.json({ ok: false, error: "没有要写的字段" }, 400);
        try {
          for (const [key, value] of Object.entries(patch)) await sdk.config.set(key, value);
          return c.json({ ok: true });
        } catch (error) {
          return c.json({ ok: false, error: String(error?.message ?? error) }, 500);
        } finally {
          invalidateNotice();
        }
      });

      // 桌面卡片皮肤：小窗只认 %APPDATA%\SP 桌面卡片\theme.json，我们负责跟着 Hana 主题写它。
      app.get("/desktop-theme", async (c) => {
        try {
          const all = await sdk.config.getAll();
          const state = await desktopTheme.status(sdk, all?.followDesktopTheme === true);
          return c.json({ ok: true, ...state });
        } catch (error) {
          return c.json({ ok: false, error: String(error?.message ?? error) }, 500);
        }
      });

      app.post("/desktop-theme", async (c) => {
        let body;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ ok: false, error: "请求体不是 JSON" }, 400);
        }
        if (typeof body?.follow !== "boolean") return c.json({ ok: false, error: "follow 必须是布尔值" }, 400);
        try {
          await sdk.config.set("followDesktopTheme", body.follow);
          const state = await desktopTheme.sync(sdk, body.follow);
          return c.json({ ok: true, ...state });
        } catch (error) {
          return c.json({ ok: false, error: String(error?.message ?? error) }, 500);
        }
      });
    });
  } catch (error) {
    await sdk.logger.warn(`sp-tasks: diagnose route unavailable: ${error?.message ?? error}`);
  }
  // An unpaired installation remains REST-only. Restoring a user-enabled bridge
  // must not delay or break registration of the original task tools.
  void bridge.restore().catch(async (error) => {
    try { await sdk.logger.warn(`sp-tasks: companion bridge unavailable (${error?.code || "BRIDGE_ERROR"})`); }
    catch { /* Optional bridge diagnostics must not break REST tools. */ }
  });
  // 桌面卡片皮肤跟随：只在 Windows 上跑；开关在设置页，每 5 秒看一眼 Hana 主题。
  desktopTheme.startDesktopFollow(sdk);
});
