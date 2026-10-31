// 调用 index.js 实际注册的 execute；SDK 网络、配置、资源均在内存内替换。
// 不使用 SP_TOKEN、不读生产文件、不连接任何真实服务。
import assert from "node:assert/strict";
import test from "node:test";
import app from "../../sp-tasks/index.js";
import { readNotice, resetNoticeCache } from "../../sp-tasks/lib/notice.js";

// 任何意外绕过 SDK 的 fetch 都直接失败。
globalThis.fetch = async () => { throw new Error("真实网络已被隔离测试禁用"); };

const response = (status, payload) => new Response(JSON.stringify(payload), { status });
const receipt = () => ({ ready: Promise.resolve(), disposeAsync: async () => {} });

async function setup({ postFails = false, patchFails = false, patchResponseLost = false } = {}) {
  resetNoticeCache();
  const tools = new Map();
  const hooks = new Map();
  const state = { tasks: [], requests: [], postFails, patchFails, patchResponseLost };
  const sdk = {
    dataDir: "test-memory",
    bus: { request: async () => { throw new Error("测试不允许宿主总线请求"); } },
    storage: { global: {}, agent: () => ({}) },
    models: {}, media: {}, providers: {},
    logger: { info: async () => {}, warn: async () => {} },
    config: { getAll: async () => ({ baseUrl: "http://sp.invalid", accessToken: "test-token" }) },
    resources: { read: async () => { throw new Error("测试禁止读取本机资源或 token"); } },
    tools: { register: (definition) => { tools.set(definition.name, definition); return receipt(); } },
    hooks: { onDecision: (name, handler) => { hooks.set(name, handler); return receipt(); } },
    routes: { register: () => receipt() },
    network: { fetch: async (rawUrl, init = {}) => {
      const url = new URL(rawUrl);
      assert.equal(url.origin, "http://sp.invalid");
      assert.equal(init.headers.Authorization, "Bearer test-token");
      const method = init.method ?? "GET";
      const path = url.pathname;
      const body = init.body ? JSON.parse(init.body) : undefined;
      state.requests.push({ method, path, body });
      if (method === "GET" && path === "/tasks") return response(200, { ok: true, data: state.tasks });
      if (method === "GET" && path === "/task-control/current") return response(200, { ok: true, data: null });
      if (method === "POST" && path === "/tasks") {
        if (state.postFails) return response(500, { ok: false, error: { code: "CREATE_FAILED", message: "mock POST failure" } });
        const task = { id: `new-${state.tasks.length + 1}`, isDone: false, plannedAt: 0, tagIds: [], subTaskIds: [], ...body };
        state.tasks.push(task);
        return response(201, { ok: true, data: task });
      }
      if (["POST", "PUT"].includes(method) && path.endsWith("/time")) {
        const task = state.tasks.find((row) => `/tasks/${row.id}/time` === path);
        assert.ok(task, "不能给不存在的任务记工时");
        const before = task.timeSpentOnDay?.[body.date] ?? 0;
        task.timeSpentOnDay = { ...task.timeSpentOnDay, [body.date]: (method === "POST" ? before : 0) + body.duration };
        task.timeSpent = Object.values(task.timeSpentOnDay).reduce((a, b) => a + b, 0);
        return response(200, { ok: true, data: task });
      }
      if (method === "PATCH" && path.startsWith("/tasks/")) {
        if (state.patchFails) return response(500, { ok: false, error: { code: "PLAN_FAILED", message: "mock PATCH failure" } });
        const task = state.tasks.find((row) => `/tasks/${row.id}` === path);
        assert.ok(task, "不能向不存在的任务发 PATCH");
        Object.assign(task, body);
        if (state.patchResponseLost) throw new Error("fetch failed: connection reset after PATCH applied");
        return response(200, { ok: true, data: task });
      }
      throw new Error(`未声明的测试请求：${method} ${path}`);
    } },
  };
  await app.apply(sdk);
  const call = async (name, args) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} 应被注册`);
    const result = await tool.execute(args);
    return { ...JSON.parse(result.content[0].text), isError: result.isError === true };
  };
  return { call, state, sdk, hooks };
}

test("create POST 失败：返回整体错误，不安排、不谎报已创建", async () => {
  const { call, state } = await setup({ postFails: true });
  const result = await call("sp_tasks_create", { title: "测试任务", planToday: true });
  assert.equal(result.ok, false);
  assert.equal(result.isError, true);
  assert.equal(result.code, "CREATE_FAILED");
  assert.equal(result.task, undefined);
  assert.equal(state.tasks.length, 0);
  assert.deepEqual(state.requests.map(({ method }) => method), ["POST"]);
});

test("create 不安排：只建一次，返回任务 id", async () => {
  const { call, state } = await setup();
  const result = await call("sp_tasks_create", { title: "测试任务" });
  assert.equal(result.ok, true);
  assert.equal(result.isError, false);
  assert.equal(result.task.id, "new-1");
  assert.equal(result.task.title, "测试任务");
  assert.deepEqual(state.requests.map(({ method }) => method), ["POST"]);
});

test("create 全部成功：先 POST，再 PATCH 同一个 id", async () => {
  const { call, state } = await setup();
  const result = await call("sp_tasks_create", { title: "测试任务", planToday: true });
  assert.equal(result.ok, true);
  assert.equal(result.isError, false);
  assert.equal(result.task.id, "new-1");
  assert.equal(result.plannedToday, true);
  assert.equal(result.planningError, undefined);
  assert.deepEqual(state.requests.map(({ method, path }) => `${method} ${path}`), ["POST /tasks", "PATCH /tasks/new-1"]);
  assert.equal(state.requests[0].body.plannedAt, undefined);
  assert.equal(state.requests[1].body.dueDay, result.task.dueDay);
  assert.match(result.task.dueDay, /^\d{4}-\d{2}-\d{2}$/);
});

test("create 部分成功：保留任务及 id，明确只重试安排，绝不 DELETE", async () => {
  const { call, state } = await setup({ patchFails: true });
  const result = await call("sp_tasks_create", { title: "测试任务", notes: "原备注", planToday: true });
  assert.equal(result.task?.id, "new-1", "POST 成功的 id 不能在 PATCH 失败后消失");
  assert.equal(result.task.title, "测试任务");
  assert.equal(result.task.notes, "原备注");
  assert.equal(result.ok, true, "建任务已成功，不应引导重建");
  assert.equal(result.isError, false);
  assert.equal(result.partial, true);
  assert.equal(result.plannedToday, false);
  assert.deepEqual(result.planningError, { code: "PLAN_FAILED", message: "mock PATCH failure" });
  assert.match(result.note, /已创建/);
  assert.match(result.note, /不要.*创建/);
  assert.deepEqual(result.retry, {
    tool: "sp_tasks_update", args: { taskIds: ["new-1"], planForToday: true },
  });
  assert.deepEqual(state.requests.map(({ method }) => method), ["POST", "PATCH"]);
  assert.equal(state.tasks.length, 1);

  state.patchFails = false;
  const retried = await call(result.retry.tool, result.retry.args);
  assert.equal(retried.changed, 1);
  assert.equal(retried.failed, 0);
  assert.equal(state.tasks.length, 1, "恢复安排不能重复创建任务");
  assert.match(state.tasks[0].dueDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(state.requests.map(({ method }) => method), ["POST", "PATCH", "PATCH"]);
});

test("create 安排已写入但响应丢失：保留 id，重试 update 不重复创建", async () => {
  const { call, state } = await setup({ patchResponseLost: true });
  const result = await call("sp_tasks_create", { title: "响应丢失测试", planToday: true });
  assert.equal(result.task?.id, "new-1");
  assert.equal(result.ok, true);
  assert.equal(result.isError, false);
  assert.equal(result.partial, true);
  assert.equal(result.plannedToday, false, "没有拿到响应就不能宣称安排已确认");
  assert.match(state.tasks[0].dueDay, /^\d{4}-\d{2}-\d{2}$/, "夹具已经应用 PATCH，不能把本例写成服务端未写入");
  assert.match(result.note, /未确认成功/);
  assert.equal(result.planningError.code, "SP_UNREACHABLE");
  assert.deepEqual(result.retry, {
    tool: "sp_tasks_update", args: { taskIds: ["new-1"], planForToday: true },
  });

  state.patchResponseLost = false;
  const retried = await call(result.retry.tool, result.retry.args);
  assert.equal(retried.changed, 1);
  assert.equal(retried.failed, 0);
  assert.equal(state.tasks.length, 1);
  assert.deepEqual(state.requests.map(({ method, path }) => `${method} ${path}`), [
    "POST /tasks", "PATCH /tasks/new-1", "PATCH /tasks/new-1",
  ]);
});

test("create 部分成功也使旧摘要失效", async () => {
  const { call, state, sdk } = await setup({ patchFails: true });
  state.tasks.push({ id: "existing", title: "已有任务", isDone: false });
  assert.match(await readNotice(sdk), /待办共 1 件/);
  await call("sp_tasks_create", { title: "新任务", planToday: true });
  assert.match(await readNotice(sdk), /待办共 2 件/);
});

const durationTools = [
  { name: "sp_tasks_create", field: "timeEstimate", args: { title: "测试任务" }, method: "POST", path: "/tasks" },
  { name: "sp_tasks_update", field: "timeEstimate", args: { taskIds: ["existing"] }, method: "PATCH", path: "/tasks/existing" },
  { name: "sp_tasks_log_time", field: "duration", args: { taskId: "existing", day: "2026-10-30" }, method: "POST", path: "/tasks/existing/time" },
];

for (const tool of durationTools) {
  test(`${tool.name}：负值与垃圾输入必须在写接口之前拒绝`, async (t) => {
    for (const input of ["-30m", "-1h30m", "1h -30m", "1h junk", "junk 1h", "abc", -1, true, [30]]) {
      await t.test(JSON.stringify(input), async () => {
        const { call, state } = await setup();
        const result = await call(tool.name, { ...tool.args, [tool.field]: input });
        assert.equal(result.code, "SP_BAD_DURATION");
        assert.equal(result.ok, false);
        assert.equal(result.isError, true);
        assert.equal(state.requests.length, 0, "非法时长不能发送写请求");
      });
    }
  });

  test(`${tool.name}：零、小数、组合与1440边界实际发送正确毫秒`, async (t) => {
    for (const [input, expected] of [["0", 0], ["0.5", 30000], ["1h30m", 5400000], ["1440", 86400000], ["1441", 86460000], [1441, 86460000]]) {
      await t.test(JSON.stringify(input), async () => {
        const { call, state } = await setup();
        state.tasks.push({ id: "existing", title: "已有任务", isDone: false });
        const result = await call(tool.name, { ...tool.args, [tool.field]: input });
        if (tool.field === "duration" && expected > 86400000) {
          assert.equal(result.code, "SP_BAD_DURATION", "SP 单日实记工时不能超过 24 小时；预估时长没有此限制");
          assert.equal(state.requests.length, 0);
          return;
        }
        assert.equal(result.ok, true);
        assert.equal(result.isError, false);
        assert.equal(state.requests.length, 1);
        const request = state.requests[0];
        assert.equal(request.method, tool.method);
        assert.equal(request.path, tool.path);
        assert.equal(request.body[tool.field], expected);
        if (tool.field === "duration") {
          assert.equal(result.loggedMs, expected);
          assert.equal(request.body.date, "2026-10-30");
        }
      });
    }
  });

  test(`${tool.name}：空时长不会意外写成零`, async (t) => {
    for (const input of [undefined, null, "", "  "]) {
      await t.test(String(input), async () => {
        const { call, state } = await setup();
        const result = await call(tool.name, { ...tool.args, [tool.field]: input });
        if (tool.name === "sp_tasks_create") {
          assert.equal(result.ok, true);
          assert.equal(state.requests.length, 1);
          assert.equal("timeEstimate" in state.requests[0].body, false);
        } else {
          assert.equal(result.code, "SP_BAD_INPUT");
          assert.equal(state.requests.length, 0);
        }
      });
    }
  });
}

test("pre-step 实际回调保全用户同前缀原文，重复调用不返回决策", async () => {
  const { hooks, state } = await setup();
  state.tasks.push({ id: "existing", title: "已有任务", isDone: false });
  assert.deepEqual([...hooks.keys()], ["agent/pre-step"]);
  const part = { type: "text", text: "[任务台] 这是用户自己输入的" };
  const handler = hooks.get("agent/pre-step");
  const out = await handler({ messages: [{ role: "user", content: [part] }] });
  assert.equal(out.messages[0].content[1], part);
  assert.equal(await handler({ messages: out.messages }), undefined);
});
