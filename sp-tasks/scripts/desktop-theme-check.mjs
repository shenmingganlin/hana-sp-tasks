// desktop-theme-check.mjs — 桌面卡片皮肤跟随的自检：假 SDK + 临时目录，不碰真机数据。
// 用法：node scripts/desktop-theme-check.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopSettingsPath, desktopThemePath, skinForTheme, status, sync } from "../lib/desktop-theme.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-tasks-theme-"));
const root = path.join(dir, "roaming");
const home = path.join(dir, "home");
const appDir = path.join(root, "SP 桌面卡片");
const prefs = path.join(home, ".hanako", "user", "preferences.json");
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(path.dirname(prefs), { recursive: true });
fs.writeFileSync(path.join(appDir, "settings.json"), "{}");
fs.writeFileSync(prefs, JSON.stringify({ appearance: { theme: "new-warm-paper" } }));

const ref = (r) => ({ kind: "local-file", path: r.path });
const sdk = {
  resources: {
    async read(r) { return fs.readFileSync(ref(r).path, "utf8"); },
    async write(r, content) { fs.writeFileSync(ref(r).path, content); },
    async stat(r) { fs.statSync(ref(r).path); return { ok: true }; },
    async rename(from, to) { fs.renameSync(ref(from).path, ref(to).path); },
    async delete(r) { fs.rmSync(ref(r).path, { force: true }); },
  },
  logger: { async warn() {} },
};
const opts = { root, home };
const themeFile = desktopThemePath(root);
const readTheme = () => JSON.parse(fs.readFileSync(themeFile, "utf8"));

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (error) {
    results.push(`✖ ${name}: ${error.message.split("\n")[0]}`);
  }
};

await check("映射：Hana 主题 id 一比一，auto → 暖纸，认不出 → 新暖纸", async () => {
  for (const id of ["warm-paper", "midnight", "high-contrast", "grass-aroma", "contemplation", "absolutely", "delve", "deep-think", "new-warm-paper", "midnight-contrast", "coral"]) {
    assert.equal(skinForTheme(id), id);
  }
  assert.equal(skinForTheme("auto"), "warm-paper");
  assert.equal(skinForTheme("unknown-theme"), "new-warm-paper");
  assert.equal(skinForTheme(""), null);
  assert.equal(skinForTheme(null), null);
});

await check("打开跟随后写入 theme.json，source 是任务台", async () => {
  const st = await sync(sdk, true, opts);
  assert.equal(st.found, true);
  assert.equal(st.active, true);
  assert.equal(st.skin, "new-warm-paper");
  assert.equal(st.skinName, "新暖纸");
  assert.deepEqual(readTheme(), { theme: "new-warm-paper", source: "任务台" });
  assert.equal(fs.existsSync(`${themeFile}.tmp`), false);
});

await check("Hana 换成青夜，重写为青夜", async () => {
  fs.writeFileSync(prefs, JSON.stringify({ appearance: { theme: "midnight" } }));
  const st = await sync(sdk, true, opts);
  assert.equal(st.skin, "midnight");
  assert.equal(st.skinName, "青夜");
  assert.deepEqual(readTheme(), { theme: "midnight", source: "任务台" });
});

await check("关掉跟随删掉 theme.json", async () => {
  const st = await sync(sdk, false, opts);
  assert.equal(st.active, false);
  assert.equal(fs.existsSync(themeFile), false);
});

await check("关掉跟随但文件本来就不在：不报错、不写文件", async () => {
  const st = await sync(sdk, false, opts);
  assert.equal(st.active, false);
  assert.equal(st.error, null);
  assert.equal(fs.existsSync(themeFile), false);
});

await check("小窗没装：found=false，不写文件", async () => {
  fs.rmSync(path.join(appDir, "settings.json"), { force: true });
  const st = await status(sdk, true, opts);
  assert.equal(st.found, false);
  assert.equal(fs.existsSync(themeFile), false);
  fs.writeFileSync(path.join(appDir, "settings.json"), "{}");
});

await check("Hana 设置读不到：保留上一次写好的文件", async () => {
  await sync(sdk, true, opts);
  const before = fs.readFileSync(themeFile, "utf8");
  fs.rmSync(prefs, { force: true });
  const st = await sync(sdk, true, opts);
  assert.equal(st.active, false);
  assert.match(st.error, /读不到 Hana/);
  assert.equal(fs.readFileSync(themeFile, "utf8"), before);
  fs.writeFileSync(prefs, JSON.stringify({ appearance: { theme: "new-warm-paper" } }));
});

await check("找不到桌面卡片目录时路径为空而不是拼错", async () => {
  assert.equal(desktopSettingsPath(""), "");
  assert.equal(desktopThemePath(""), "");
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("✖"))) process.exit(1);
