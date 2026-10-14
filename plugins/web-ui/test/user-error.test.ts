import assert from "node:assert/strict";
import test from "node:test";
import { userErrorMessage } from "../src/user-error.ts";

test("budget shows only reference CNY amounts and explains a rolling window", () => {
  const result = userErrorMessage("budget exceeded ($20.01 of $20); try again later");
  assert.match(result, /about ¥135\.68 used, limit about ¥135\.61/);
  assert.doesNotMatch(result, /美元|USD|\$/);
  assert.match(result, /rolling 24 hours/);
  assert.doesNotMatch(result, /midnight|tomorrow|personal|department/);
  assert.match(userErrorMessage("budget exceeded ($100.52 of $100); try again later"), /limit about ¥678\.04/);
});

test("rate limit keeps retry interval", () => {
  assert.equal(
    userErrorMessage(new Error("rate limit exceeded — try again in 17s")),
    "Too many requests. Try again in 17 seconds.",
  );
});

test("known transport and permission failures are actionable", () => {
  assert.match(userErrorMessage(new TypeError("Failed to fetch")), /Check your network/);
  assert.match(userErrorMessage("HTTP 401"), /Sign in again/);
  assert.match(userErrorMessage("attachment upload failed: HTTP 413"), /Attachment upload failed.*smaller file.*413/);
  assert.match(userErrorMessage("session busy (another turn is in progress)"), /last message/);
});

test("unknown details and existing Chinese are preserved without broad replacement", () => {
  for (const value of [
    "自定义错误：请检查材料",
    "Model unicorn: invalid tool schema",
    "Report says: budget exceeded",
    "<script>alert(1)</script>",
    "unknown HTTP 401 provider error",
    "constructor",
    "toString",
    "__proto__",
  ]) {
    assert.equal(userErrorMessage(value), value);
  }
  assert.equal(userErrorMessage(null, "读取失败"), "读取失败");
});

test("localization is idempotent", () => {
  for (const value of ["Failed to fetch", "HTTP 503", "budget exceeded ($21.00 of $20); try again later"]) {
    assert.equal(userErrorMessage(userErrorMessage(value)), userErrorMessage(value));
  }
});

test("reference currency uses exact decimal rounding without exposing USD", () => {
  for (const [usd, cny] of [
    ["0", "0.00"],
    ["0.125", "0.85"],
    ["100", "678.04"],
    ["1000", "6,780.40"],
    ["20.0100", "135.68"],
  ]) {
    const result = userErrorMessage(`budget exceeded ($${usd} of $1000); try again later`);
    assert.ok(result.includes(`about ¥${cny} used`));
    assert.doesNotMatch(result, /美元|USD|\$/);
  }
});

test("small nonzero reference amounts do not appear as zero", () => {
  assert.match(
    userErrorMessage("budget exceeded ($0.0001 of $0.0001); try again later"),
    /about <¥0\.01 used, limit about <¥0\.01/,
  );
});

test("unrecognized provider limits never gain invented amounts or recovery windows", () => {
  for (const original of [
    "You have reached your usage limit",
    "reach limit",
    "budget exceeded ($Infinity of $20); try again later",
    `budget exceeded ($${"9".repeat(33)} of $20); try again later`,
  ]) {
    assert.equal(userErrorMessage(original), original);
  }
});
