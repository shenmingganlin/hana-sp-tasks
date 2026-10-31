// Contract checks use an in-memory transport. No production SP service is contacted.
import assert from "node:assert/strict";
import test from "node:test";
import { sp, SpError } from "../../sp-tasks/lib/sp.js";
import { resolveDay } from "../../sp-tasks/lib/date.js";

globalThis.fetch = async () => { throw new Error("Real network is forbidden in protocol tests"); };
const cfg = { baseUrl: "http://sp.invalid", accessToken: "test-token" };
const validTask = { id: "target", title: "Target", timeSpentOnDay: {} };

function transport({ data, payload, raw, status = 200, fetchError, readError } = {}) {
  const requests = [];
  const sdk = { network: { fetch: async (rawUrl, init) => {
    const url = new URL(rawUrl);
    assert.equal(url.origin, "http://sp.invalid");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    requests.push({ path: url.pathname, method: init.method, query: url.searchParams, body: init.body });
    if (fetchError) throw fetchError;
    return {
      status, ok: status >= 200 && status < 300,
      text: async () => {
        if (readError) throw readError;
        return raw !== undefined ? raw : JSON.stringify(payload !== undefined ? payload : { ok: true, data });
      },
    };
  } } };
  return { sdk, requests };
}

async function expectFailure(options, { method = "GET", path = "/tasks/target", code = "SP_BAD_RESPONSE", unknown = method !== "GET" } = {}) {
  const { sdk, requests } = transport(options);
  await assert.rejects(sp.request(sdk, cfg, method, path, method === "GET" ? undefined : {}), (error) => {
    assert.ok(error instanceof SpError);
    assert.equal(error.code, code);
    assert.equal(error.outcomeUnknown === true, unknown);
    return true;
  });
  assert.equal(requests.length, 1, "A response failure must never trigger an automatic retry");
}

test("task reads and writes require the exact requested id and a task title", async (t) => {
  for (const [method, path] of [
    ["GET", "/tasks/target"], ["PATCH", "/tasks/target"],
    ["POST", "/tasks/target/time"], ["PUT", "/tasks/target/time"],
    ["POST", "/tasks/target/restore"],
  ]) {
    await t.test(`${method} ${path}`, async () => {
      const { sdk } = transport({ data: validTask });
      assert.deepEqual(await sp.request(sdk, cfg, method, path, method === "GET" ? undefined : {}), validTask);
      for (const data of [{}, { id: "other", title: "Wrong" }, { id: "target" }, { id: "target", title: null }, { id: 3, title: "Wrong" }]) {
        await expectFailure({ data }, { method, path });
      }
    });
  }
});

test("new and current tasks require nonempty string ids, while an idle timer may return null", async () => {
  for (const [method, path] of [["POST", "/tasks"], ["GET", "/task-control/current"]]) {
    for (const id of [undefined, null, "", "  ", 42, true]) {
      await expectFailure({ data: { id, title: "Task" } }, { method, path });
    }
    const { sdk } = transport({ data: validTask });
    assert.equal((await sp.request(sdk, cfg, method, path, method === "POST" ? { title: "Task" } : undefined)).id, "target");
  }
  assert.equal(await sp.currentTask(transport({ data: null }).sdk, cfg), null);
  assert.equal(await sp.focus(transport({ data: null }).sdk, cfg), null);
  await expectFailure({ data: null }, { path: "/status" });
});

test("state-changing acknowledgements must identify the requested object and confirmed action", async (t) => {
  const cases = [
    { method: "POST", path: "/tasks/target/start", good: { currentTaskId: "target" }, bad: [{}, { currentTaskId: null }, { currentTaskId: "other" }] },
    { method: "POST", path: "/task-control/stop", good: { currentTaskId: null }, bad: [{}, { currentTaskId: "target" }, { currentTaskId: false }] },
    { method: "POST", path: "/tasks/target/archive", good: { id: "target", archived: true }, bad: [{}, { id: "target" }, { id: "target", archived: false }, { id: "other", archived: true }] },
    { method: "DELETE", path: "/tasks/target", good: { id: "target", deleted: true }, bad: [{}, { id: "target" }, { id: "target", deleted: "true" }, { id: "other", deleted: true }] },
  ];
  for (const { method, path, good, bad } of cases) {
    await t.test(`${method} ${path}`, async () => {
      assert.deepEqual(await sp.request(transport({ data: good }).sdk, cfg, method, path), good);
      for (const data of bad) await expectFailure({ data }, { method, path });
    });
  }
});

test("list contracts reject malformed rows instead of reporting a misleading empty or partial result", async (t) => {
  for (const path of ["/tasks", "/projects", "/tags", "/task-repeat-cfgs", "/notes", "/simple-counters"]) {
    await t.test(path, async () => {
      assert.deepEqual(await sp.request(transport({ data: [] }).sdk, cfg, "GET", path), []);
      assert.deepEqual(await sp.request(transport({ data: [validTask] }).sdk, cfg, "GET", path), [validTask]);
      for (const data of [{}, null, [null], [{}], [{ id: 5 }], [{ id: "" }], [{ id: " " }]]) {
        await expectFailure({ data }, { path });
      }
    });
  }
});

test("a successful HTTP status cannot substitute for the SP success envelope", async (t) => {
  for (const method of ["GET", "PATCH"]) {
    await t.test(method, async () => {
      for (const payload of [null, [], validTask, { data: validTask }, { ok: true }, { ok: "true", data: validTask }]) {
        await expectFailure({ payload }, { method });
      }
      await expectFailure({ raw: "" }, { method });
      await expectFailure({ raw: "<html>unexpected page</html>" }, { method });
      await expectFailure({ status: 204, raw: "" }, { method });
    });
  }
});

test("explicit 4xx rejection is definite, while 5xx writes remain unconfirmed", async () => {
  const rejected = { ok: false, error: { code: "TASK_NOT_FOUND", message: "Task not found" } };
  await expectFailure({ status: 404, payload: rejected }, { method: "PATCH", code: "TASK_NOT_FOUND", unknown: false });
  await expectFailure({ status: 401, payload: { ok: false, error: { code: "UNAUTHORIZED" } } }, { method: "POST", path: "/tasks", code: "SP_UNAUTHORIZED", unknown: false });
  await expectFailure({ status: 500, payload: { ok: false, error: { code: "INTERNAL_ERROR", message: "Commit result unavailable" } } }, { method: "PATCH", code: "INTERNAL_ERROR", unknown: true });
  await expectFailure({ status: 500, payload: { ok: false, error: { code: "INTERNAL_ERROR" } } }, { code: "INTERNAL_ERROR", unknown: false });
  await expectFailure({ status: 200, payload: rejected }, { method: "PATCH", code: "TASK_NOT_FOUND", unknown: false });
});

test("non-JSON HTTP errors preserve status without reflecting unexpected response bodies", async () => {
  const raw = "<html>private diagnostic content should not be reflected</html>";
  for (const [status, code, unknown] of [[400, "SP_HTTP_400", false], [401, "SP_UNAUTHORIZED", false], [500, "SP_HTTP_500", true]]) {
    const { sdk } = transport({ status, raw });
    await assert.rejects(sp.updateTask(sdk, cfg, "target", { title: "Changed" }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.outcomeUnknown === true, unknown);
      assert.equal(error.message.includes("private diagnostic"), false);
      return true;
    });
  }
});

test("structured SDK error codes work without recognizable text, including body-read failures", async () => {
  for (const [code, expected] of [
    ["ECONNREFUSED", "SP_UNREACHABLE"],
    ["PLUGIN_NETWORK_HOST_NOT_ALLOWED", "SP_NETWORK_BLOCKED"],
    ["PLUGIN_NETWORK_NOT_DECLARED", "SP_NETWORK_BLOCKED"],
    ["PLUGIN_NETWORK_TIMEOUT", "SP_TIMEOUT"],
  ]) {
    const error = Object.assign(new Error("host request failed"), { code });
    await expectFailure({ fetchError: error }, { method: "PATCH", code: expected, unknown: true });
    await expectFailure({ fetchError: error }, { code: expected, unknown: false });
  }
  await expectFailure({ readError: Object.assign(new Error("response unavailable"), { code: "PLUGIN_NETWORK_TIMEOUT" }) }, { method: "PATCH", code: "SP_TIMEOUT", unknown: true });
});

test("encoded task ids are checked against decoded identifiers and query strings stay separate", async () => {
  const identifier = "task #? with spaces";
  const { sdk, requests } = transport({ data: { id: identifier, title: "Exact" } });
  assert.equal((await sp.task(sdk, cfg, identifier, { include: "issueUrl", omitted: undefined })).id, identifier);
  assert.equal(requests[0].path, `/tasks/${encodeURIComponent(identifier)}`);
  assert.equal(requests[0].query.get("include"), "issueUrl");
  assert.equal(requests[0].query.has("omitted"), false);
});

test("prototype property names cannot masquerade as valid natural-language dates", () => {
  for (const value of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf", "toLocaleString"]) {
    const result = resolveDay(value, "2026-10-31");
    assert.equal(result.ok, false, value);
    assert.equal(result.day, undefined, value);
  }
});
