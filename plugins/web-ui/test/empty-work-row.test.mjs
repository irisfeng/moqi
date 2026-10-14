import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
const source = fs.readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const code = ts.transpile(
  extract("  function chatMessage(", "  function messageMeta(") +
    extract("  function workBlock(", "  function segmentSummaryLabel("),
  { target: ts.ScriptTarget.ES2022 },
);
const nothing = Symbol("nothing");
const html = (strings, ...values) => ({ strings, values });
const names = [
  "nothing",
  "html",
  "messageText",
  "shouldShowApprovalWork",
  "shouldShowWork",
  "buildTimeline",
  "messageLocation",
  "assistantContent",
  "assistantFileList",
  "messageMeta",
  "userErrorMessage",
  "icon",
  "Ban",
  "segmentSummaryLabel",
  "renderTimelineItem",
  "postSpeechText",
  "markdown",
  "ChevronRight",
];
const values = [
  nothing,
  html,
  (m) =>
    m.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(""),
  () => true,
  (w) => !!w?.activity.length,
  (w) => w.activity,
  () => "",
  () => [],
  () => nothing,
  () => html`time`,
  (x) => x,
  () => "",
  null,
  () => "",
  () => "",
  () => "",
  (x) => x,
  null,
];
const render = new Function(...names, code + "; return chatMessage;")(...values);
const msg = (activity = [], extra = {}) => ({
  role: "assistant",
  content: [],
  stopReason: "stop",
  work: { status: "complete", activity },
  ...extra,
});
const hidden = { kind: "text", activity: { payload: { text: "Internal closing record", demoted: true } } };
test("hidden post-delivery bookkeeping does not render a timestamp row", () => {
  assert.equal(render(msg([hidden]), 0), nothing);
});
test("visible reply and work states survive hidden bookkeeping", () => {
  assert.notEqual(render(msg([hidden], { content: [{ type: "text", text: "Actual reply" }] }), 0), nothing);
  assert.notEqual(render(msg([hidden], { deliveredFiles: [{ id: "file" }] }), 0), nothing);
  assert.notEqual(render(msg([hidden], { stopReason: "error", errorMessage: "Failed" }), 0), nothing);
  assert.notEqual(render(msg([hidden], { stopReason: "aborted" }), 0), nothing);
  assert.notEqual(render(msg([{ kind: "text", activity: { payload: { text: "Visible work" } } }]), 0), nothing);
  assert.notEqual(render(msg([{ kind: "tool", row: {} }]), 0), nothing);
  assert.equal(render(msg([]), 0), nothing);
});
