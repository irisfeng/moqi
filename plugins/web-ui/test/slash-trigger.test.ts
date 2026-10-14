import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

const tokenBody = composer.match(/const SLASH_TOKEN = \/(.*)\/;/)?.[1];
const groupIndex = Number(composer.match(/return m \? \(m\[(\d)\] \?\? ""\) : null;/)?.[1]);

test("SLASH_TOKEN and slashQuery stay adjacent and one capture group", () => {
  assert.ok(tokenBody, "SLASH_TOKEN regex literal must exist");
  assert.ok(Number.isInteger(groupIndex) && groupIndex >= 1, "slashQuery must read a capture group");
  assert.doesNotMatch(tokenBody, /\(\^\|\\s\)/, "no word-boundary anchor: Chinese input has no spaces before /");
});

const SLASH_TOKEN = new RegExp(tokenBody!);
const slashQuery = (draft: string): string | null => {
  const m = draft.match(SLASH_TOKEN);
  return m ? (m[groupIndex] ?? "") : null;
};

test("typing / after Chinese text arms the skill menu", () => {
  assert.equal(slashQuery("你好/"), "");
  assert.equal(slashQuery("帮我写周报/"), "");
  assert.equal(slashQuery("你好/off"), "off");
});

test("typing / after latin text arms the skill menu too — command-key semantics, not word-start", () => {
  assert.equal(slashQuery("hello/"), "");
  assert.equal(slashQuery("draft revis/"), "");
  assert.equal(slashQuery("hello/office"), "office");
});

test("non-ASCII typed after the slash ends the token instead of matching partially", () => {
  assert.equal(slashQuery("周报/帮我"), null);
  assert.equal(slashQuery("a/中"), null);
});

test("empty draft or no slash stays unarmed", () => {
  assert.equal(slashQuery(""), null);
  assert.equal(slashQuery("你好"), null);
  assert.equal(slashQuery("你好，今天开会"), null);
});

test("dates and numeric paths arm but cannot flash the menu — open requires matches", () => {
  assert.equal(slashQuery("2026/09"), "09");
  assert.match(composer, /open: loading \|\| matches\.length > 0/, "menu opens only with real matches");
});

test("acceptSkill replaces the trailing token in place and keeps the prefix", () => {
  assert.match(composer, /\.replace\(SLASH_TOKEN, \(\) => `\/\$\{skill\.name\} `\)/);
  const replace = (draft: string): string => draft.replace(SLASH_TOKEN, () => "/office-docs ");
  assert.equal(replace("你好/"), "你好/office-docs ");
  assert.equal(replace("帮我写周报/office"), "帮我写周报/office-docs ");
  assert.equal(replace("hello/"), "hello/office-docs ");
  assert.equal(replace("你好/帮我"), "你好/帮我", "no trailing ASCII token — draft untouched");
});
