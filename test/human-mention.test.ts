import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionsOtherMember } from "../src/core/orchestrator/human-mention.ts";
import type { Principal } from "../src/types.ts";

const member = (id: string, displayName: string): Principal => ({ id, type: "internal", displayName });
const audience = [member("me", "Fang Ming"), member("li", "Li"), member("anna", "Anna Chen"), member("wang", "王伟")];
const mentions = (text: string) => mentionsOtherMember(text, audience, "me", "Moqi");

test("a message that addresses another member by name is a message to a colleague", () => {
  assert.equal(mentions("@Anna Chen please look at this"), true);
  assert.equal(mentions("@anna can you check?"), true);
  assert.equal(mentions("帮我看下@王伟这个方案"), true);
  assert.equal(mentions("@Li, see the attachment"), true);
  assert.equal(mentions("请 @王伟 看一下"), true);
  assert.equal(mentions("@王伟"), true);
});

test("an at-sign that is not a member's name does not silence the assistant", () => {
  assert.equal(mentions("please run npm i @lit/reactive-element"), false);
  assert.equal(mentions("explain the @link tag in jsdoc"), false);
  assert.equal(mentions("what does @an mean"), false);
  assert.equal(mentions("mail me at fang@li.example"), false);
  assert.equal(mentions("@Fang Ming note to self"), false);
});

test("quoted lines and code are not read as mentions", () => {
  assert.equal(mentions("> @Anna said the plan is late\nsummarise this"), false);
  assert.equal(mentions("what does `@Li` do in this template?"), false);
  assert.equal(mentions("```\nping @Li\n```\nwhy does this fail?"), false);
  assert.equal(mentions("> earlier note\n@Li what do you think?"), true);
});

test("naming the assistant keeps the turn with the assistant", () => {
  assert.equal(mentions("@Li and Moqi, compare these two files"), false);
});
