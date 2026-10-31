// 工具层端到端测试：直接调用 index.js 注册的 execute 函数，绕开宿主注册表。
// 原因：宿主当前会话仍在用旧的工具定义（重新绑定要等下一次会话重建），
// 所以「参数 schema 已经更新」这件事在这里验证不了，但工具本身的逻辑可以。
//
// 跑法：设置 SP_TOKEN 后 node tests/sp-tasks/tools.mjs
// 会在真实 SP 里建一条带【测试】前缀的任务，结束时删掉。
const TOKEN = process.env.SP_TOKEN;
const BASE = process.env.SP_BASE || "http://127.0.0.1:3876";
if (!TOKEN) {
  console.log("SKIP: 没有 SP_TOKEN，跳过真实接口测试");
  process.exit(0);
}

const sdk = {
  network: { fetch: (url, init) => fetch(url, init) },
  config: {
    getAll: async () => ({ baseUrl: BASE, accessToken: TOKEN, defaultProjectId: "" }),
    get: async () => undefined,
    getSchema: () => null,
  },
  resources: { read: async () => { throw new Error("test"); } },
  logger: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} },
  dataDir: process.cwd(),
  tools: {
    list: [],
    listOwn: async () => sdk.tools.list,
    async register(def) {
      sdk.tools.list.push(def);
      return { ready: Promise.resolve(), disposeAsync: async () => {} };
    },
  },
  routes: { async register() { return { ready: Promise.resolve(), disposeAsync: async () => {} }; } },
  hooks: {},
  commands: { register: async () => ({}), listOwn: async () => [] },
  storage: { global: {}, agent: () => ({}) },
  models: { list: async () => [] },
  media: {},
  providers: {},
  inputBanner: {},
  appEvents: {},
  shortcuts: {},
  messageRenderers: {},
  tasks: {},
  userInteraction: {},
  inputStatus: {},
  launchArgs: {},
  documents: {},
  windows: {},
  instances: {},
  environments: {},
  surfaces: {},
  sessions: {},
  agents: {},
  roles: {},
  capabilities: {},
  usage: {},
  render: {},
  // createAppSdk 会校验 bus.request 必须是函数，得给个真桩。
  bus: { async request() { return {}; }, subscribe() {}, handle() {}, emit() {} },
};

const mod = await import("../../sp-tasks/index.js");
await mod.default.apply(sdk);

const byName = new Map(sdk.tools.list.map((t) => [t.name, t]));
const call = async (name, args) => {
  const tool = byName.get(name);
  if (!tool) throw new Error(`工具没注册：${name}（已注册：${[...byName.keys()].join(", ")}）`);
  const res = await tool.execute({ ...args, context: {} });
  const text = res?.content?.[0]?.text ?? "";
  try {
    return { ...JSON.parse(text), __isError: res?.isError === true };
  } catch {
    return { raw: text, __isError: res?.isError === true };
  }
};

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
  }
};

const created = [];
try {
  console.log("注册的工具：" + [...byName.keys()].join(", "));
  check("注册了 7 个工具", byName.size === 7, byName.size);

  console.log("\n[1] context：项目与标签");
  const ctx = await call("sp_tasks_context", {});
  check("返回 ok", ctx.ok === true, ctx);
  check("有 projects 数组", Array.isArray(ctx.projects), ctx.projects);
  check("有 tags 数组", Array.isArray(ctx.tags), ctx.tags);
  console.log(`      项目 ${ctx.projects?.length ?? 0} 个，标签 ${ctx.tags?.length ?? 0} 个`);

  console.log("\n[2] create：自然语言日期 + 时长");
  const made = await call("sp_tasks_create", {
    title: "【测试】hana 日期换算",
    dueDay: "下周三",
    timeEstimate: "1h30m",
  });
  check("创建成功", made.ok === true, made);
  if (made.task?.id) {
    created.push(made.task.id);
    check("预估已换算成 90 分钟", made.task.timeEstimate === 5400000, made.task.timeEstimate);
    check("截止日已换算成具体日期", /^\d{4}-\d{2}-\d{2}$/.test(made.task.dueDay ?? ""), made.task.dueDay);
    console.log(`      截止日 = ${made.task.dueDay}（下周三）`);
    // 下周三应当是未来 3~10 天内
    const today = new Date();
    const due = new Date(`${made.task.dueDay}T12:00:00`);
    const diffDays = Math.round((due - today) / 86400000);
    check("下周三落在 1~10 天内", diffDays >= 1 && diffDays <= 10, diffDays);
    check("确实是周三", due.getDay() === 3, due.getDay());
  }

  console.log("\n[3] create：带时刻");
  const timed = await call("sp_tasks_create", {
    title: "【测试】hana 时刻",
    dueWithTime: "明天 9:30",
  });
  check("创建成功", timed.ok === true, timed);
  if (timed.task?.id) {
    created.push(timed.task.id);
    const at = new Date(timed.task.dueWithTime ?? 0);
    check("时刻是 9:30", at.getHours() === 9 && at.getMinutes() === 30, `${at.getHours()}:${at.getMinutes()}`);
  }

  console.log("\n[4] create：planToday 应进今天");
  const planned = await call("sp_tasks_create", {
    title: "【测试】hana 今天",
    planToday: true,
  });
  check("创建成功", planned.ok === true, planned);
  if (planned.task?.id) {
    created.push(planned.task.id);
    check("plannedToday 标记为真", planned.plannedToday === true, planned.plannedToday);
    check("plannedAt 有值", typeof planned.task.plannedAt === "number" && planned.task.plannedAt > 0, planned.task.plannedAt);
  }

  console.log("\n[5] overview：今天应能看到刚建的计划任务");
  const ov = await call("sp_tasks_overview", {});
  check("总览返回 ok", ov.ok === true, ov);
  check("今天至少有 1 条", (ov.counts?.today ?? 0) >= 1, ov.counts);
  if (created[2]) {
    check("计划任务出现在今天里", (ov.today || []).some((t) => t.id === created[2]), (ov.today || []).map((t) => t.title));
  }

  console.log("\n[6] search：关键词检索");
  const found = await call("sp_tasks_search", { query: "hana 日期换算" });
  check("检索到", found.ok === true && found.count >= 1, found);
  if (created[0]) {
    check("命中的是刚建那条", (found.tasks || []).some((t) => t.id === created[0]), (found.tasks || []).map((t) => t.title));
  }

  console.log("\n[7] update：批量改期与完成");
  const batch = await call("sp_tasks_update", {
    taskIds: created.slice(0, 2),
    dueDay: "2026-12-31",
  });
  check("批量改期成功", batch.ok === true && batch.changed === 2, batch);

  const done = await call("sp_tasks_update", { taskIds: [created[0]], isDone: true });
  check("勾完成成功", done.ok === true && done.changed === 1, done);

  console.log("\n[8] update：清空截止日");
  const cleared = await call("sp_tasks_update", { taskIds: [created[0]], dueDay: "none" });
  check("清空成功", cleared.ok === true, cleared);

  console.log("\n[9] log_time：补记工时");
  const logged = await call("sp_tasks_log_time", {
    taskId: created[0],
    duration: "45m",
    day: "今天",
  });
  check("记工时成功", logged.ok === true, logged);
  check("时长是 45 分钟", logged.loggedMs === 2700000, logged.loggedMs);

  console.log("\n[10] timer：启停");
  const started = await call("sp_tasks_timer", { action: "start", taskId: created[0] });
  check("开始计时成功", started.ok === true, started);
  const status = await call("sp_tasks_timer", { action: "status" });
  check("状态显示正在计这条", status.currentTask?.id === created[0], status.currentTask);
  const stopped = await call("sp_tasks_timer", { action: "stop" });
  check("停止成功", stopped.ok === true, stopped);

  console.log("\n[11] 错误路径要说人话");
  const badDate = await call("sp_tasks_create", { title: "x", dueDay: "随便什么时候" });
  check("坏日期被拒绝", badDate.ok === false && badDate.code === "SP_BAD_DATE", badDate);
  check("错误信息提示可用写法", String(badDate.message ?? "").includes("今天"), badDate.message);

  const badId = await call("sp_tasks_update", { taskIds: ["不存在的id"], isDone: true });
  check("坏 id 不崩，逐条报错", badId.ok === true && badId.failed === 1, badId);

  const emptyIds = await call("sp_tasks_update", { taskIds: [] });
  check("空 taskIds 被拒绝", emptyIds.ok === false, emptyIds);
} finally {
  // 清理：删掉本次建的所有测试任务
  console.log("\n[清理] 删除测试任务");
  for (const id of created) {
    try {
      const res = await fetch(`${BASE}/tasks/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      console.log(`  ${res.ok ? "已删" : "删除失败"} ${id}`);
    } catch (error) {
      console.log(`  删除异常 ${id}: ${error.message}`);
    }
  }
}

console.log(failures ? `\n${failures} 项失败` : "\nPASS tool-layer assertions");
process.exit(failures ? 1 : 0);
