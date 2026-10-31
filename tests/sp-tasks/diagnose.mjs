// 测诊断：每种失败都要给出「下一步去点什么」。
// 诊断页最不该做的事是自己崩掉，或者给出一个查不出原因的「未连接」。
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { candidateRoots, diagnose } from "../../sp-tasks/lib/diagnose.js";
import { autoReadToken } from "../../sp-tasks/lib/token.js";

const okFetch = (data) => async (url) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, data: String(url).endsWith("/health") ? { server: "up", rendererReady: true } : data }),
});

const makeSdk = ({ files = {}, fetchImpl }) => ({
  resources: {
    read: async ({ path }) => {
      if (files[path]) return files[path];
      const error = new Error(`ENOENT: ${path}`);
      throw error;
    },
  },
  network: { fetch: fetchImpl },
});

const APP_ROOT = "C:\\Users\\x\\AppData\\Roaming";
const APP_DATA = `${APP_ROOT}\\superProductivity`;
const withInstall = { [`${APP_DATA}\\Preferences`]: "{}" };
// 根目录必须注入：不注入就只能读本机 APPDATA，测试结果会跟机器绑定。
const roots = [APP_ROOT];

// 1. 全通：四项都过，verdict 说连接正常
{
  const sdk = makeSdk({ files: withInstall, fetchImpl: okFetch([]) });
  const result = await diagnose(sdk, { baseUrl: "http://127.0.0.1:3876", accessToken: "t", tokenSource: "auto" }, { roots });
  assert.equal(result.ok, true, `应全通：${JSON.stringify(result.steps)}`);
  assert.equal(result.verdict, "连接正常");
  assert.ok(result.steps.every((s) => s.ok), "有步骤没过");
  assert.equal(result.downloadUrl.includes("super-productivity.com"), true, "应给下载渠道");
}

// 2. 便携版/自定义目录：定位失败是辅助信息，实际接口可用就应连接正常。
{
  const sdk = makeSdk({ files: {}, fetchImpl: okFetch([]) });
  const result = await diagnose(sdk, { baseUrl: "http://127.0.0.1:3876", accessToken: "t", tokenSource: "auto" }, { roots });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "连接正常");
  const step = result.steps.find((s) => s.id === "install");
  assert.equal(step.ok, false);
  assert.equal(step.optional, true);
  assert.ok(step.next && step.next.length > 10, "失败必须给下一步");
  assert.ok(Array.isArray(step.tried) && step.tried.length > 0, "要能展开看试过哪些路径");
}

// 3. 没取得令牌不等于接口没打开，也可能是资源权限或自定义目录。
{
  const sdk = makeSdk({ files: withInstall, fetchImpl: okFetch([]) });
  const result = await diagnose(sdk, { baseUrl: "http://127.0.0.1:3876", accessToken: "", tokenSource: null }, { roots });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "没有取得访问令牌", `实际：${result.verdict}`);
  const step = result.steps.find((s) => s.id === "token");
  assert.equal(step.ok, false);
  assert.ok(step.next.includes("杂项"), "应指到 SP 设置里的具体位置");
}

// 4. 有 token 但服务没起：指到「SP 没在运行」
{
  const sdk = makeSdk({
    files: withInstall,
    fetchImpl: async () => { throw new Error("fetch failed: ECONNREFUSED"); },
  });
  const result = await diagnose(sdk, { baseUrl: "http://127.0.0.1:3876", accessToken: "t", tokenSource: "auto" }, { roots });
  assert.equal(result.ok, false);
  const step = result.steps.find((s) => s.id === "health");
  assert.equal(step.ok, false);
  assert.ok(/没在运行|没打开/.test(step.next), `下一步不对：${step.next}`);
  // 连不上就不该继续往下测，避免叠一堆无意义的失败
  assert.equal(result.steps.some((s) => s.id === "read"), false, "连不上还继续测读取");
}

// 5. token 不对：401 要指到「重新复制令牌」
{
  const sdk = makeSdk({
    files: withInstall,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/health")) return { ok: true, status: 200, json: async () => ({ ok: true, data: { server: "up", rendererReady: true } }) };
      return { ok: false, status: 401, json: async () => ({ ok: false, error: { code: "UNAUTHORIZED", message: "bad token" } }) };
    },
  });
  const result = await diagnose(sdk, { baseUrl: "http://127.0.0.1:3876", accessToken: "t", tokenSource: "auto" }, { roots });
  assert.equal(result.ok, false);
  const step = result.steps.find((s) => s.id === "read");
  assert.equal(step.ok, false);
  assert.ok(step.next.includes("令牌"), `下一步不对：${step.next}`);
}

// 6. 接口回了非 JSON：不抛错，算失败
{
  const sdk = makeSdk({
    files: withInstall,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }),
  });
  const result = await diagnose(sdk, { baseUrl: "http://127.0.0.1:3876", accessToken: "t", tokenSource: "auto" }, { roots });
  assert.equal(result.ok, false, "非 JSON 应算失败");
}

// 7. 诊断自己出意外也不能抛：给一条可读的失败
{
  const sdk = makeSdk({
    files: withInstall,
    fetchImpl: () => { throw new TypeError("boom"); },
  });
  const result = await diagnose(sdk, { baseUrl: "http://127.0.0.1:3876", accessToken: "t", tokenSource: "auto" }, { roots });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.steps) && result.steps.length > 0, "应仍有步骤可显示");
}

// 8. 步骤顺序：先找安装，再看令牌
{
  const sdk = makeSdk({ files: withInstall, fetchImpl: okFetch([]) });
  const result = await diagnose(sdk, { baseUrl: "http://127.0.0.1:3876", accessToken: "t", tokenSource: "auto" }, { roots });
  const ids = result.steps.map((s) => s.id);
  assert.deepEqual(ids, ["install", "token", "health", "read"], `顺序不对：${ids}`);
}

// 9. HTTP 或业务失败不能因残留 data 数组而被当成读取成功。
for (const [status, payload] of [
  [401, { ok: false, error: { code: "UNAUTHORIZED", message: "bad token" }, data: [] }],
  [200, { ok: false, error: { code: "APP_NOT_READY", message: "not ready" }, data: [] }],
  [200, { ok: true, data: {} }],
  [200, []],
  [200, { data: [] }],
]) {
  const sdk = makeSdk({
    files: withInstall,
    fetchImpl: async (url) => String(url).endsWith("/health")
      ? okFetch([])(url)
      : { ok: status === 200, status, json: async () => payload },
  });
  const result = await diagnose(sdk, { baseUrl: "http://sp.invalid", accessToken: "t" }, { roots });
  assert.equal(result.ok, false, `错误响应不能被当成连接正常：${JSON.stringify(payload)}`);
  assert.equal(result.taskCount, null);
  assert.equal(result.steps.find((step) => step.id === "read").ok, false);
}

// 10. 健康检查也必须是 SP 的响应，坏信封或错误服务不能继续读取任务。
for (const payload of [null, {}, { ok: true }, { ok: true, data: null }, { ok: true, data: [] }]) {
  let calls = 0;
  const sdk = makeSdk({ files: withInstall, fetchImpl: async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => payload };
  } });
  const result = await diagnose(sdk, { baseUrl: "http://sp.invalid", accessToken: "t" }, { roots });
  assert.equal(result.ok, false);
  assert.equal(result.steps.find((step) => step.id === "health").ok, false);
  assert.equal(calls, 1);
}

// 11. 宿主不给环境变量时，诊断和自动令牌读取仍共用 homedir 候选路径。
{
  const originalAppData = process.env.APPDATA;
  const originalProfile = process.env.USERPROFILE;
  const userDirectory = homedir();
  try {
    delete process.env.APPDATA;
    delete process.env.USERPROFILE;
    const expectedRoot = `${userDirectory}\\AppData\\Roaming`;
    assert.ok(candidateRoots().includes(expectedRoot));
    const token = "t".repeat(32);
    const paths = [];
    const sdk = { resources: { read: async ({ path }) => {
      paths.push(path);
      if (path === `${expectedRoot}\\superProductivity\\local-rest-api-token`) return token;
      if (path === `${expectedRoot}\\superProductivity\\Preferences`) return "{}";
      throw new Error("ENOENT");
    } }, network: { fetch: okFetch([]) } };
    assert.equal((await autoReadToken(sdk)).token, token);
    const result = await diagnose(sdk, { baseUrl: "http://sp.invalid", accessToken: token, tokenSource: "auto" });
    assert.equal(result.ok, true);
    assert.equal(result.steps[0].ok, true);
    assert.equal(paths.length, 2);
  } finally {
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
  }
}

console.log("Diagnose assertions passed: API-led connection status, optional directory lookup, shared root discovery, transport and envelope failures, recovery advice.");
