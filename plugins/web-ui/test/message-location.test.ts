import assert from "node:assert/strict";
import { test } from "node:test";
import { entriesToMessages, type SessionEntry } from "../src/core-bridge.ts";
import { messageLocation, readMessageLocation } from "../src/message-location.ts";

test("durable message identities keep a notification on its original post after later replies", () => {
  const entries: SessionEntry[] = [
    { type: "user", seq: 0, createdAt: 1, payload: { text: "@同事 请查看", runId: "run-a" } },
    { type: "tool_call", seq: 1, createdAt: 2, payload: { action: "post", callId: "call-a", text: "第一条交付" } },
    { type: "tool_result", seq: 2, createdAt: 3, payload: { callId: "call-a", ok: true, deliveryId: "delivery-a" } },
    { type: "tool_call", seq: 3, createdAt: 4, payload: { action: "post", callId: "call-b", text: "稍后的交付" } },
    { type: "tool_result", seq: 4, createdAt: 5, payload: { callId: "call-b", ok: true, deliveryId: "delivery-b" } },
    { type: "user", seq: 5, createdAt: 6, payload: { text: "另一轮", runId: "run-b" } },
    { type: "assistant", seq: 6, createdAt: 7, payload: { text: "最后一条回复" } },
  ];
  const model = { api: "openai-completions", provider: "openai", id: "test" } as never;
  assert.deepEqual(entriesToMessages(entries, model).map(messageLocation), [
    "run:run-a",
    "delivery:delivery-a",
    "delivery:delivery-b",
    "run:run-b",
    "seq:6",
  ]);
  assert.deepEqual(entriesToMessages(entries.slice(0, 3), model).map(messageLocation), [
    "run:run-a",
    "delivery:delivery-a",
  ]);
});

test("notification location parser rejects invalid frames while preserving sequence zero", () => {
  assert.deepEqual(readMessageLocation({ threadRef: "thread", deliveryId: "delivery", seq: 0, text: "excluded" }), {
    deliveryId: "delivery",
    seq: 0,
  });
  for (const value of [
    null,
    "bad",
    4,
    { seq: -1 },
    { seq: 0.2 },
    { seq: Infinity },
    { runId: {} },
    { deliveryId: "x".repeat(201) },
  ]) {
    assert.deepEqual(readMessageLocation(value), {});
  }
  assert.equal(messageLocation({ seq: 0 }), "seq:0");
  assert.equal(messageLocation({}), "");
});

test("unpaired post results retain delivery identity without treating reactions as posts", () => {
  const model = { api: "openai-completions", provider: "openai", id: "test" } as never;
  const entries: SessionEntry[] = [
    { type: "tool_call", seq: 0, createdAt: 1, payload: { tool: "web", action: "post" } },
    { type: "tool_result", seq: 1, createdAt: 2, payload: { tool: "post", ok: true, deliveryId: "unpaired" } },
    { type: "tool_result", seq: 2, createdAt: 3, payload: { action: "react", ok: true, deliveryId: "reaction" } },
    { type: "assistant", seq: 3, createdAt: 4, payload: { text: "posted" } },
  ];
  assert.equal(messageLocation(entriesToMessages(entries, model)[0]!), "delivery:unpaired");
  entries[1]!.payload = { tool: "post", ok: false, deliveryId: "failed" };
  assert.equal(messageLocation(entriesToMessages(entries, model)[0]!), "seq:3");
});
