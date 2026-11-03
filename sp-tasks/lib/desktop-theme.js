// desktop-theme.js — 让「SP 桌面卡片」跟着 Hana 当前主题换皮肤。
//
// 小窗只认一个通用外部主题文件：%APPDATA%\SP 桌面卡片\theme.json
//   { "theme": "<皮肤 id>", "source": "任务台" }
// 这里负责读 Hana 的 preferences.json、把主题映射成小窗的皮肤、原子写文件；
// 小窗那边不知道 Hana 的存在，换别的主题来源也能用同一个文件。
//
// 只在 Windows 上做事：小窗目前只有 Windows 版。

import path from "node:path";
import { homedir } from "node:os";
import { roamingRoots } from "./token.js";

const APP_DIR = "SP 桌面卡片";
const THEME_FILE = "theme.json";
const SETTING = "followDesktopTheme";
// 小窗 0.4.0 起把这 11 套 Hana 主题都做成了皮肤，名字和 Hana 的主题 id 一样，直接一比一映射。
const HANA_SKINS = new Set([
  "warm-paper",
  "midnight",
  "high-contrast",
  "grass-aroma",
  "contemplation",
  "absolutely",
  "delve",
  "deep-think",
  "new-warm-paper",
  "midnight-contrast",
  "coral",
]);
const SKIN_NAMES = {
  "warm-paper": "暖纸",
  midnight: "青夜",
  "high-contrast": "素白",
  "grass-aroma": "草香",
  contemplation: "沉思",
  absolutely: "Absolutely",
  delve: "随时准备接住你",
  "deep-think": "用户彻底怒了",
  "new-warm-paper": "新暖纸",
  "midnight-contrast": "青夜·高对比",
  coral: "珊瑚",
};

let started = false;

/** Hana 用哪套，小窗就用同一套；auto 用 Hana 的亮色默认（暖纸）；认不出的退回新暖纸。 */
export function skinForTheme(id) {
  if (typeof id !== "string" || !id) return null;
  if (id === "auto") return "warm-paper";
  return HANA_SKINS.has(id) ? id : "new-warm-paper";
}

export const desktopSettingsPath = (root = roamingRoots()[0]) => (root ? path.join(root, APP_DIR, "settings.json") : "");

export const desktopThemePath = (root = roamingRoots()[0]) => (root ? path.join(root, APP_DIR, THEME_FILE) : "");

/** read 的返回值形状跨版本有过差异，把能读出字符串的几种都兜住。 */
function textOf(result) {
  if (typeof result === "string") return result;
  if (Buffer.isBuffer(result)) return result.toString("utf8");
  if (result && typeof result === "object") {
    for (const key of ["content", "text", "data", "body"]) {
      if (typeof result[key] === "string") return result[key];
      if (Buffer.isBuffer(result[key])) return result[key].toString("utf8");
    }
  }
  if (result && typeof result.length === "number") {
    try {
      return Buffer.from(result).toString("utf8");
    } catch {
      return "";
    }
  }
  return "";
}

async function exists(sdk, file) {
  try {
    await sdk.resources.stat({ kind: "local-file", path: file });
    return true;
  } catch {
    return false;
  }
}

async function readText(sdk, file) {
  return textOf(await sdk.resources.read({ kind: "local-file", path: file }));
}

/** Hana 当前主题；读不到时返回 { theme: null, error }。home 可注入，测试用。 */
export async function readHanaTheme(sdk, { home } = {}) {
  const base = home || (() => {
    try {
      return homedir();
    } catch {
      return "";
    }
  })();
  if (!base) return { theme: null, error: "拿不到用户主目录" };
  const file = path.join(base, ".hanako", "user", "preferences.json");
  try {
    const prefs = JSON.parse(await readText(sdk, file));
    const theme = prefs?.appearance?.theme;
    if (typeof theme === "string" && theme) return { theme, error: null };
    return { theme: null, error: "Hana 设置里没有主题字段" };
  } catch (error) {
    return { theme: null, error: `读不到 Hana 当前主题：${error?.message ?? error}` };
  }
}

/**
 * 小窗那边现在是什么状态：
 * found 有没有装、follow 开关、hanaTheme Hana 当前主题、skin 映射后的皮肤、active 是否真的在跟随。
 */
export async function status(sdk, follow, opts = {}) {
  const file = desktopThemePath(opts.root);
  if (!file) return { found: false, follow: !!follow, hanaTheme: null, skin: null, active: false, file: "", error: "拿不到用户目录" };
  const found = await exists(sdk, desktopSettingsPath(opts.root));
  const hana = await readHanaTheme(sdk, opts);
  const skin = hana.theme ? skinForTheme(hana.theme) : null;
  return {
    found,
    follow: !!follow,
    hanaTheme: hana.theme,
    skin,
    skinName: skin ? SKIN_NAMES[skin] ?? skin : null,
    active: !!follow && found && !!skin,
    file,
    error: hana.error ?? null,
  };
}

/** 原子写：先写 .tmp 再改名，小窗不会读到写了一半的 JSON。 */
async function writeTheme(sdk, skin, root) {
  const file = desktopThemePath(root);
  const tmp = `${file}.tmp`;
  const body = JSON.stringify({ theme: skin, source: "任务台" });
  try {
    await sdk.resources.write({ kind: "local-file", path: tmp }, body);
    await sdk.resources.rename({ kind: "local-file", path: tmp }, { kind: "local-file", path: file });
  } catch {
    await sdk.resources.write({ kind: "local-file", path: file }, body);
    try {
      await sdk.resources.delete({ kind: "local-file", path: tmp });
    } catch {
      // 临时文件删不掉不影响结果
    }
  }
}

async function removeTheme(sdk, root) {
  const file = desktopThemePath(root);
  if (!file) return;
  // 文件本来就不在时不要调 delete：Hana 的安装校验会把 lstat 的 ENOENT 当成安装失败。
  if (!(await exists(sdk, file))) return;
  try {
    await sdk.resources.delete({ kind: "local-file", path: file });
  } catch {
    // 删不掉就算了，下一次同步会再试
  }
}

/** 立即同步一次；关掉跟随会删掉外部主题文件。 */
export async function sync(sdk, follow, opts = {}) {
  const st = await status(sdk, follow, opts);
  if (!st.found) return { ...st, active: false };
  if (!follow) {
    await removeTheme(sdk, opts.root);
    return { ...st, active: false, error: null };
  }
  if (!st.skin) return { ...st, active: false, error: st.error || "认不出 Hana 的主题" };
  try {
    await writeTheme(sdk, st.skin, opts.root);
    return { ...st, active: true, error: null };
  } catch (error) {
    return { ...st, active: false, error: `写不了小窗的主题文件：${error?.message ?? error}` };
  }
}

/**
 * 插件加载后每 5 秒看一眼：开关变了就同步，Hana 换主题了就重写。
 * 文件被删掉也会补回来。只在 Windows 上跑；timer 不拖住进程退出。
 */
export function startDesktopFollow(sdk) {
  if (started || process.platform !== "win32") return;
  started = true;
  // 装好后默认就是没跟随：首次加载不要主动删 theme.json，否则安装确认阶段会被 ENOENT 打断。
  let lastFollow = false;
  let lastSkin = null;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const all = await sdk.config.getAll();
      const follow = all?.[SETTING] === true;
      if (!follow) {
        if (lastFollow) await removeTheme(sdk);
        lastFollow = false;
        lastSkin = null;
        return;
      }
      const st = await status(sdk, true);
      if (!st.found) {
        lastFollow = true;
        lastSkin = null;
        return;
      }
      if (!st.skin) return; // 读不到 Hana 主题就保留上一次写好的文件
      if (st.skin !== lastSkin || !(await exists(sdk, desktopThemePath()))) {
        await writeTheme(sdk, st.skin);
        lastSkin = st.skin;
      }
      lastFollow = true;
    } catch (error) {
      try {
        await sdk.logger.warn(`sp-tasks: desktop theme follow failed: ${error?.message ?? error}`);
      } catch {
        // 日志也失败就算了，不影响任务功能
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, 5000);
  if (typeof timer.unref === "function") timer.unref();
  // 等安装确认 / 启动流程走完再碰外部文件，别在 apply() 期间做资源操作。
  const first = setTimeout(() => void tick(), 2000);
  if (typeof first.unref === "function") first.unref();
}
