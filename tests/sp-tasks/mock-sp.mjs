// 用一台假的 SP 服务验证客户端与视图逻辑：不依赖真实 SP 是否开着。
// 字段形状严格照真实 SP 19.3.1 实测结果写：
//   - 收件箱是真实项目 id "INBOX_PROJECT"，不是「没有 projectId」
//   - plannedAt 用 0 表示未计划（PATCH 不接受 null）
//   - dueDay 可能是 null 或 ""
// 早期版本按「想象」写的假服务掩盖过真的 bug，所以这些形状是刻意的回归基线。
// 跑法：node tests/sp-tasks/mock-sp.mjs
import http from "node:http";
import assert from "node:assert/strict";
import { localDay, shiftDay } from "../../sp-tasks/lib/date.js";

const INBOX = "INBOX_PROJECT";

const TASKS = [
  {
    id: "t1",
    title: "写季度复盘",
    projectId: "p1",
    tagIds: ["g1"],
    plannedAt: Date.now(),
    dueDay: localDay(),
    timeEstimate: 3600000,
    timeSpent: 1200000,
    timeSpentOnDay: { [localDay()]: 1200000 },
    isDone: false,
    subTaskIds: [],
  },
  {
    id: "t2",
    title: "交水费",
    projectId: INBOX,
    deadlineDay: shiftDay(localDay(), -1),
    plannedAt: 0,
    isDone: false,
    tagIds: [],
    subTaskIds: [],
  },
  {
    id: "t3",
    title: "随便记的",
    projectId: INBOX,
    dueDay: null,
    plannedAt: 0,
    isDone: false,
    tagIds: [],
    subTaskIds: [],
  },
  {
    id: "t4",
    title: "已经做完的",
    projectId: INBOX,
    plannedAt: 0,
    isDone: true,
    tagIds: [],
    subTaskIds: [],
  },
];

const PROJECTS = [
  { id: INBOX, title: "Inbox", isArchived: false },
  { id: "p1", title: "工作", isArchived: false },
];
const TAGS = [
  { id: "TODAY", title: "Today" },
  { id: "g1", title: "复盘" },
];

let lastPatch = null;
let lastCreate = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.headers.authorization !== "Bearer testtoken") {
    return send(401, { ok: false, error: { code: "UNAUTHORIZED", message: "bad token" } });
  }

  const p = url.pathname;
  if (req.method === "GET" && p === "/tasks") {
    const tagId = url.searchParams.get("tagId");
    const source = url.searchParams.get("source") || "active";
    // 归档区是另一套数据源（_taskArchiveService），形状与活跃任务一致。
    const ARCHIVED = [
      { id: "a1", title: "去年结项的收尾", projectId: "p1", isDone: true, plannedAt: 0, tagIds: [], subTaskIds: [] },
    ];
    let list;
    if (source === "archived") list = ARCHIVED;
    else if (source === "all") list = [...TASKS, ...ARCHIVED];
    else list = TASKS;
    if (tagId) list = list.filter((t) => t.tagIds.includes(tagId));
    return send(200, { ok: true, data: list });
  }
  if (req.method === "GET" && p === "/projects") return send(200, { ok: true, data: PROJECTS });
  if (req.method === "GET" && p === "/tags") return send(200, { ok: true, data: TAGS });
  if (req.method === "GET" && p === "/task-control/current") return send(200, { ok: true, data: TASKS[0] });
  if (req.method === "GET" && p === "/focus") {
    return send(200, {
      ok: true,
      data: { mode: "Countdown", cycle: 1, isSessionDone: false, timer: { status: "running", elapsedMs: 65000, remainingMs: 2435000 } },
    });
  }
  if (req.method === "GET" && p.startsWith("/tasks/")) {
    const id = p.slice("/tasks/".length);
    const found = TASKS.find((t) => t.id === id);
    return found ? send(200, { ok: true, data: found }) : send(404, { ok: false, error: { code: "TASK_NOT_FOUND", message: "no" } });
  }
  if (req.method === "PATCH" && p.startsWith("/tasks/")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastPatch = JSON.parse(raw);
      const id = p.slice("/tasks/".length);
      send(200, { ok: true, data: { ...TASKS.find((t) => t.id === id), ...lastPatch } });
    });
    return;
  }
  if (req.method === "POST" && p === "/tasks") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastCreate = JSON.parse(raw);
      send(201, { ok: true, data: { id: "new1", ...lastCreate, isDone: false, tagIds: lastCreate.tagIds || [], subTaskIds: [] } });
    });
    return;
  }
  if (req.method === "POST" && p === "/task-control/stop") return send(200, { ok: true, data: { currentTaskId: null } });
  send(404, { ok: false, error: { code: "NOT_FOUND", message: "route" } });
});

const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// 最小 sdk 替身：只提供被测代码用到的三件事
const sdk = {
  network: { fetch: (url, init) => fetch(url, init) },
  config: { getAll: async () => ({}) },
  resources: { read: async () => { throw new Error("测试环境没有 token 文件"); } },
  logger: { info: async () => {} },
};

const { buildOverview, normalizeTaskInput } = await import("../../sp-tasks/lib/view.js");
const { sp } = await import("../../sp-tasks/lib/sp.js");

const cfg = { baseUrl: `http://127.0.0.1:${port}`, accessToken: "testtoken", defaultProjectId: "" };

try {
  // 1. 日期工具
  assert.equal(shiftDay("2026-10-30", 1), "2026-10-31", "推一天");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01", "跨年");
  assert.match(localDay(), /^\d{4}-\d{2}-\d{2}$/, "localDay 格式");

  // 2. 未配置 token 时要给出可照做的提示，而不是裸错误
  await assert.rejects(
    () => sp.tasks(sdk, { baseUrl: cfg.baseUrl, accessToken: "", defaultProjectId: "" }),
    (error) => error.code === "SP_NO_TOKEN",
    "缺 token 应报 SP_NO_TOKEN"
  );

  // 3. 错误 token 要翻译成 SP_UNAUTHORIZED
  await assert.rejects(
    () => sp.tasks(sdk, { baseUrl: cfg.baseUrl, accessToken: "wrong", defaultProjectId: "" }),
    (error) => error.code === "SP_UNAUTHORIZED",
    "错 token 应报 SP_UNAUTHORIZED"
  );

  // 4. 连不上要翻译成 SP_UNREACHABLE
  await assert.rejects(
    () => sp.tasks(sdk, { baseUrl: "http://127.0.0.1:1", accessToken: "testtoken", defaultProjectId: "" }),
    (error) => error.code === "SP_UNREACHABLE",
    "连不上应报 SP_UNREACHABLE"
  );

  // 5. 视图聚合：今天 / 逾期 / 收件箱各归其位
  const overview = await buildOverview(sdk, cfg, {});
  assert.equal(overview.counts.today, 1, "今天的任务 1 条");
  assert.equal(overview.counts.overdue, 1, "逾期 1 条");
  assert.equal(overview.counts.inbox, 2, "收件箱 2 条：t2、t3（t4 已完成不算，t1 属于工作项目）");
  assert.equal(overview.today[0].title, "写季度复盘");
  assert.equal(overview.today[0].project, "工作", "项目名要解析出来");
  assert.equal(overview.today[0].tags[0].title, "复盘", "标签名要解析出来");
  assert.equal(overview.overdue[0].title, "交水费");
  assert.equal(overview.currentTask.id, "t1");
  // focus 只留专注模式本身；timer 是番茄钟的计时器，任务计时中它是 null，
  // 当「有没有在计时」的信号会误报，所以不再投影（见 view.js 的注释）。
  assert.equal(overview.focus.timer, undefined, "不再投影 focus.timer");
  assert.equal(overview.focus.mode, "Countdown");
  assert.equal(overview.effort.todayEstimateMs, 3600000);
  assert.equal(overview.effort.todaySpentMs, 1200000);

  // 6. 收件箱任务：projectId 是 INBOX_PROJECT，project 显示为 null，isInbox 为 true
  const inboxRow = overview.inbox.find((t) => t.id === "t3");
  assert.equal(inboxRow.projectId, "INBOX_PROJECT", "收件箱的 projectId 是真实 id");
  assert.equal(inboxRow.project, null, "收件箱不显示项目名");
  assert.equal(inboxRow.isInbox, true, "收件箱标记");
  assert.equal(inboxRow.dueDay, null, "dueDay 为 null 要归一成 null");

  // 7. plannedAt 为 0 要归一成 null，不能变成 1970 年
  assert.equal(inboxRow.plannedAt, null, "plannedAt 0 视为未计划");

  // 8. 完成态任务不进今天/逾期/收件箱
  assert.ok(!overview.today.some((t) => t.id === "t4"));
  assert.ok(!overview.inbox.some((t) => t.id === "t4"));

  // 9. 名称 → id 解析；明确指定却解析不到时应拒绝，不能静默改落点
  const withProject = await normalizeTaskInput(sdk, cfg, { title: "新任务", projectTitle: "工作", tags: ["复盘"] });
  assert.equal(withProject.projectId, "p1", "项目名要解析成 id");
  assert.deepEqual(withProject.tagIds, ["g1"], "标签名要解析成 id");

  await assert.rejects(
    normalizeTaskInput(sdk, cfg, { title: "新任务", projectTitle: "不存在的项目" }),
    (error) => error.code === "SP_NO_PROJECT"
  );

  const empty = await normalizeTaskInput(sdk, cfg, { title: "  " }).catch((e) => e);
  assert.ok(empty instanceof Error, "空标题要拒绝");

  // 10. 服务端先解析相对时间；归一化输入只接收 YYYY-MM-DD，未指定计划日时送 null。
  const badDay = await normalizeTaskInput(sdk, cfg, { title: "x", dueDay: "明天" });
  assert.equal(badDay.dueDay, null, "非 ISO 日期不能入库，且要显式送 null");

  const noDay = await normalizeTaskInput(sdk, cfg, { title: "x" });
  assert.equal(noDay.dueDay, null, "没给日期时要显式送 null 关掉 SP 的今日默认值");
  assert.ok("dueDay" in noDay, "dueDay 字段必须在，不能省略");

  const goodDay = await normalizeTaskInput(sdk, cfg, { title: "x", dueDay: "2026-12-31" });
  assert.equal(goodDay.dueDay, "2026-12-31", "合法 ISO 日期原样透传");

  // 11. 写操作：plannedAt 必须原样传出去（0 = 取消计划），不能改写成 null
  await sp.updateTask(sdk, cfg, "t3", { plannedAt: 0 });
  assert.equal(lastPatch.plannedAt, 0, "取消计划要传 0");
  await sp.updateTask(sdk, cfg, "t3", { plannedAt: 1793304000000 });
  assert.equal(lastPatch.plannedAt, 1793304000000, "计划时刻原样透传");

  // 12. source 参数：归档是另一套数据源，默认不能把它混进活跃视图
  const activeOnly = await sp.tasks(sdk, cfg, {});
  assert.ok(!activeOnly.some((t) => t.id === "a1"), "默认不该返回归档任务");

  const archivedOnly = await sp.tasks(sdk, cfg, { source: "archived" });
  assert.equal(archivedOnly.length, 1, "archived 只返回归档任务");
  assert.equal(archivedOnly[0].id, "a1");

  const both = await sp.tasks(sdk, cfg, { source: "all" });
  assert.ok(both.some((t) => t.id === "a1") && both.some((t) => t.id === "t1"), "all 两边都要有");
  assert.equal(both.length, TASKS.length + 1, "all = 活跃 + 归档");

  // 13. overview 永远只看活跃任务：归档的不该计入「待办共 N 件」
  const overviewAgain = await buildOverview(sdk, cfg, {});
  assert.ok(!overviewAgain.inbox.some((t) => t.id === "a1"), "归档任务不该出现在收件箱");
  assert.ok(!overviewAgain.today.some((t) => t.id === "a1"), "归档任务不该出现在今天");

  console.log("PASS all assertions");
} finally {
  server.close();
}
