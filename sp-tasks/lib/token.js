// lib/token.js — 自动拿 SP 的本地 REST API token
// SP 把 token 写在 userData 下的 local-rest-api-token（纯文本，32 位字母数字）。
// 只要用户在 SP 里把本地 REST API 打开，这个文件就会自动生成，用不着手动复制。
// 读不到不算错：设置页里手填的那份才是主路径，这里只是省一步。

import { homedir } from "node:os";

const TOKEN_PATTERN = /^[A-Za-z0-9]{32}$/;

// 不同安装方式下 userData 目录名略有差别，按可能性排。
export const SP_DATA_DIR_NAMES = ["superProductivity", "Super Productivity", "super-productivity"];

/**
 * 候选的 AppData\Roaming 根目录。
 * 实测教训：v2 App 进程跑在 Node 权限模型下，环境变量可能整个是空的，
 * 只用 process.env.APPDATA 会直接拿到 undefined，于是「一个路径都没试」就失败了。
 * 所以这里以 os.homedir() 为主，环境变量只当补充。
 */
export function roamingRoots() {
  const roots = [];
  const home = (() => {
    try {
      return homedir();
    } catch {
      return "";
    }
  })();
  for (const value of [process.env.APPDATA, home ? `${home}\\AppData\\Roaming` : "", process.env.USERPROFILE ? `${process.env.USERPROFILE}\\AppData\\Roaming` : ""]) {
    if (typeof value === "string" && value.trim()) roots.push(value.trim().replace(/[\\/]+$/, ""));
  }
  return [...new Set(roots)];
}

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

/**
 * 尝试从 SP 的数据目录读 token。
 * 返回 { token, path } 或 { token: "", tried } —— tried 是失败原因，用于设置页提示。
 */
export async function autoReadToken(sdk) {
  if (!sdk?.resources || typeof sdk.resources.read !== "function") {
    return { token: "", tried: ["宿主没有提供资源读取通道"] };
  }

  const roots = roamingRoots();
  if (!roots.length) return { token: "", tried: ["拿不到用户主目录"] };

  const tried = [];
  for (const root of roots) {
    for (const dir of SP_DATA_DIR_NAMES) {
      const filePath = `${root}\\${dir}\\local-rest-api-token`;
      try {
        const result = await sdk.resources.read({ kind: "local-file", path: filePath });
        const token = textOf(result).trim();
        if (TOKEN_PATTERN.test(token)) return { token, path: filePath };
        tried.push(`${filePath}：内容不是 32 位 token（读到 ${token.length} 字符）`);
      } catch (error) {
        tried.push(`${filePath}：${error?.message ?? error}`);
      }
    }
  }
  return { token: "", tried };
}
