// lib/inject.js — 把一句状态作为独立 part 注进最后一条用户消息
//
// 为什么不用 before-start：它每个会话只跑一次，而且改的是 systemPrompt（前缀），
// 前缀一变整段 KV cache 作废。pre-step 每轮都跑，改的是最后一条消息（后缀），
// 前缀不动，缓存能命中。
//
// 铁律：用户自己写的那段一个字节都不动。提醒是数组里新加的一个 part，
// 不拼接、不查找、不替换用户文本。

export const MARK = "[任务台]";

// pre-step 契约没有归属字段，只认本模块实际创建且文本未变的对象。
// 序列化或重载后失去身份的 part 宁可保留，也不能靠文本猜它是旧注入。
const ownedParts = new WeakMap();
const isInjected = (part) =>
  part?.type === "text" && typeof part.text === "string" && ownedParts.get(part) === part.text;

/**
 * 返回新的 messages 数组；返回 null 表示「这一轮不用改」。
 * 内容与位置都没变时返回 null，宿主不认为有变更。
 */
export function injectNotice(messages, line) {
  if (!Array.isArray(messages)) return null;
  const notice = typeof line === "string" ? line.trim() : "";

  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }

  const injected = [];
  messages.forEach((message, index) => {
    if (message?.role !== "user" || !Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if (isInjected(part)) injected.push({ index, partIndex, text: part.text });
    });
  });

  const inPlace =
    notice.length > 0 &&
    injected.length === 1 &&
    injected[0].index === lastUser &&
    injected[0].partIndex === 0 &&
    injected[0].text === notice;
  if (inPlace) return null;
  if (!notice && injected.length === 0) return null;

  let changed = false;
  const cleaned = [];
  for (const message of messages) {
    if (message?.role === "user" && Array.isArray(message.content)) {
      const kept = message.content.filter((part) => !isInjected(part));
      if (kept.length !== message.content.length) {
        changed = true;
        if (kept.length === 0) continue;
        cleaned.push({ ...message, content: kept });
        continue;
      }
    }
    cleaned.push(message);
  }

  if (!notice) return changed ? cleaned : null;

  let userIndex = -1;
  for (let i = cleaned.length - 1; i >= 0; i -= 1) {
    if (cleaned[i]?.role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return changed ? cleaned : null;

  const message = cleaned[userIndex];
  const parts = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string" && message.content.length > 0
      ? [{ type: "text", text: message.content }]
      : null;
  // 只有图片的轮次不硬插：没有可依附的文本，也不猜用户意图。
  if (!parts || !parts.some((part) => part?.type === "text")) return changed ? cleaned : null;

  const part = { type: "text", text: notice };
  ownedParts.set(part, notice);
  const next = cleaned.slice();
  next[userIndex] = {
    ...message,
    content: [part, ...parts],
  };
  return next;
}
