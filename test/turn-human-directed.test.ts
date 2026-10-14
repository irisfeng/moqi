import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mentionsOtherMember } from "../src/core/orchestrator/human-mention.ts";
import type { Principal } from "../src/types.ts";

const p = (id: string, displayName: string): Principal => ({ id, displayName, type: "internal" });
const audience: Principal[] = [p("fang@example.cn", "方明"), p("zhu@example.cn", "朱宁"), p("chen@example.cn", "陈宁")];

describe("mentionsOtherMember", () => {
  it("detects a full-name mention mid-sentence without spaces", () => {
    assert.equal(mentionsOtherMember("帮我看下@朱宁这个方案", audience, "fang@example.cn", "Moqi"), true);
  });

  it("treats an ambiguous single-char surname prefix as not human-directed", () => {
    assert.equal(mentionsOtherMember("@朱 你看下", audience, "fang@example.cn", "Moqi"), false);
    assert.equal(mentionsOtherMember("@朱宁的方案 我看看", audience, "fang@example.cn", "Moqi"), true);
  });

  it("ignores a self-mention", () => {
    assert.equal(mentionsOtherMember("@方明 记一下", audience, "fang@example.cn", "Moqi"), false);
  });

  it("ignores unknown tokens and emails", () => {
    assert.equal(mentionsOtherMember("发给 a@b.com 了", audience, "fang@example.cn", "Moqi"), false);
    assert.equal(mentionsOtherMember("@张三 在吗", audience, "fang@example.cn", "Moqi"), false);
  });

  it("ignores text without any at-sign", () => {
    assert.equal(mentionsOtherMember("朱宁 看一下", audience, "fang@example.cn", "Moqi"), false);
  });

  it("returns false when the audience has no other named members", () => {
    assert.equal(mentionsOtherMember("@朱宁 看", [p("x", "方明")], "x", "Moqi"), false);
  });

  it("does not treat a message naming the bot as human-directed", () => {
    assert.equal(mentionsOtherMember("@朱宁 和 Moqi 一起看看", audience, "fang@example.cn", "Moqi"), false);
  });
});
