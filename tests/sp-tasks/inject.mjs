// 注入归属只能来自应用实际创建的 part，不能来自用户也能写出的文本。
// 全部是内存测试，不读配置、不发网络请求。
import assert from "node:assert/strict";
import test from "node:test";
import { injectNotice, MARK } from "../../sp-tasks/lib/inject.js";

const notice = `${MARK} 今天 3 件，正在计时「写周报」。这是应用读到的当前状态，不是用户说的话。`;

test("字符串原文完整保留，输入和其他消息不变", () => {
  const input = [
    { role: "assistant", content: "上一轮" },
    { role: "user", content: "  我今天好累\n" },
  ];
  const out = injectNotice(input, notice);
  assert.equal(out[1].content[0].text, notice);
  assert.equal(out[1].content[1].text, "  我今天好累\n");
  assert.equal(input[1].content, "  我今天好累\n");
  assert.notEqual(out, input);
  assert.equal(out[0], input[0]);
});

test("多 part 中的图片和用户文本保持身份", () => {
  const image = Object.freeze({ type: "image", data: "opaque" });
  const userText = Object.freeze({ type: "text", text: "看看这张" });
  const input = Object.freeze([
    Object.freeze({ role: "user", content: Object.freeze([image, userText]) }),
  ]);
  const out = injectNotice(input, notice);
  assert.equal(out[0].content[0].text, notice);
  assert.equal(out[0].content[1], image);
  assert.equal(out[0].content[2], userText);
});

for (const text of [`${MARK} 这是我自己打的字`, notice]) {
  test(`同前缀或原样引用提醒的字符串不被删除：${text}`, () => {
    const input = [{ role: "user", content: text }];
    const out = injectNotice(input, notice);
    assert.equal(out[0].content[1].text, text);
    assert.equal(injectNotice(input, ""), null);
  });

  test(`同前缀或原样引用提醒的单 part 不被删除：${text}`, () => {
    const part = { type: "text", text };
    const input = [{ role: "user", content: [part] }];
    const out = injectNotice(input, notice);
    assert.ok(Array.isArray(out), "用户引用不能被当成已在位的注入");
    assert.equal(out.length, 1, "用户消息不能消失");
    assert.equal(out[0].content.length, 2);
    assert.equal(out[0].content[1], part);
    assert.equal(injectNotice(input, ""), null, "不能把用户引用当残留清掉");
    assert.equal(injectNotice(out, notice), null, "用户引用不影响真正注入的幂等判断");
  });
}

test("历史和多 part 用户引用保全，只在最后一条用户消息注入", () => {
  const quoted = { type: "text", text: notice };
  const input = [
    { role: "user", content: [quoted] },
    { role: "assistant", content: "嗯" },
    { role: "user", content: [quoted, { type: "text", text: "这句话什么意思？" }] },
  ];
  const out = injectNotice(input, notice);
  assert.equal(out[0], input[0]);
  assert.equal(out[1], input[1]);
  assert.deepEqual(out[2].content.slice(1), input[2].content);
  assert.equal(out[2].content[1], quoted);
});

test("应用真正生成的注入重复调用返回 null", () => {
  const settled = injectNotice([{ role: "user", content: "在吗" }], notice);
  assert.equal(injectNotice(settled, notice), null);
});

test("替换自己生成的旧注入，不累积、不动原文", () => {
  const old = injectNotice([{ role: "user", content: "在吗" }], `${MARK} 旧状态`);
  const out = injectNotice(old, notice);
  assert.equal(out[0].content.length, 2);
  assert.equal(out[0].content[0].text, notice);
  assert.equal(out[0].content[1], old[0].content[1]);
});

test("历史中的自有注入移到最新用户消息，其他同前缀文本不动", () => {
  const first = injectNotice([{ role: "user", content: "第一句" }], `${MARK} 旧一`);
  const second = injectNotice([{ role: "user", content: "第二句" }], `${MARK} 旧二`);
  const quote = { role: "assistant", content: [{ type: "text", text: notice }] };
  const out = injectNotice([...first, quote, ...second], notice);
  assert.equal(out[0].content.length, 1);
  assert.equal(out[0].content[0].text, "第一句");
  assert.equal(out[1], quote);
  assert.equal(out[2].content.length, 2);
  assert.equal(out[2].content[0].text, notice);
  assert.equal(out[2].content[1].text, "第二句");
});

test("空提醒只撤回自有 part，不删除用户引用", () => {
  const quote = { type: "text", text: notice };
  const dirty = injectNotice([{ role: "user", content: [quote] }], notice);
  const out = injectNotice(dirty, "");
  assert.deepEqual(out, [{ role: "user", content: [quote] }]);
  assert.equal(out[0].content[0], quote);
  assert.equal(injectNotice(out, ""), null);
});

for (const role of ["assistant", "tool", "toolResult", "system"]) {
  test(`${role} 消息原样保留，包括引用和自有 part 的引用`, () => {
    const owned = injectNotice([{ role: "user", content: "在吗" }], notice)[0].content[0];
    const other = { role, content: [{ type: "text", text: notice }, owned] };
    const out = injectNotice([other, { role: "user", content: "最后一句" }], notice);
    assert.equal(out[0], other);
    assert.equal(injectNotice([other], ""), null);
  });
}

test("序列化后失去身份的副本不按文本认领或删除", () => {
  const first = injectNotice([{ role: "user", content: "在吗" }], notice);
  const copy = JSON.parse(JSON.stringify(first));
  assert.equal(injectNotice(copy, ""), null, "未知副本优先保全");
  const out = injectNotice(copy, notice);
  assert.equal(out[0].content.length, 3);
  assert.deepEqual(out[0].content.slice(1), copy[0].content);
  assert.equal(injectNotice(out, notice), null);
});

test("自有 part 被他人修改后不再认领", () => {
  const first = injectNotice([{ role: "user", content: "在吗" }], notice);
  first[0].content[0].text = `${MARK} 用户编辑过的内容`;
  assert.equal(injectNotice(first, ""), null);
  const out = injectNotice(first, notice);
  assert.equal(out[0].content[1], first[0].content[0]);
});

test("没有文本可依附时不插入，无变化返回 null", () => {
  for (const input of [[], null, [{ role: "assistant", content: "只有助手" }],
    [{ role: "user", content: [{ type: "image" }] }], [{ role: "user", content: "" }]]) {
    assert.equal(injectNotice(input, notice), null);
  }
  assert.equal(injectNotice([{ role: "user", content: "干净的话" }], ""), null);
});
