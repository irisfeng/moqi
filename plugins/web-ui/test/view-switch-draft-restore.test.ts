import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

const switchViewBody = shell.match(/export function switchView\(v: View\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
const leaveBlock = switchViewBody.match(/if \(v !== "chats"\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
const restoreBody = shell.match(/function restoreLastConversation\(\): boolean \{[\s\S]*?\n\}/)?.[0] ?? "";

test("leaving the chats view flushes pending draft writes before teardown", () => {
  assert.ok(leaveBlock, "switchView keeps its leave-chats block");
  assert.match(leaveBlock, /void flushDrafts\(\);/);
  assert.ok(
    leaveBlock.indexOf("flushDrafts()") < leaveBlock.indexOf("teardown()"),
    "flush must land before teardown resets the composer",
  );
});

test("returning to chats reopens the remembered conversation before falling back to the browse page", () => {
  assert.ok(restoreBody, "restoreLastConversation exists");
  assert.match(restoreBody, /state\.rememberedSessionId/, "existing sessions reopen by remembered id");
  assert.match(restoreBody, /sessionsState\.list\.find\(\(s\) => s\.id === state\.rememberedSessionId\)/);
  assert.match(restoreBody, /void openSession\(session\)/);
  assert.match(restoreBody, /state\.rememberedThreadRef/, "an unsent new chat restores through its draft carry");
  assert.match(
    restoreBody,
    /sessionsState\.list\.find\(\(s\) => !s\.id && s\.threadRef === state\.rememberedThreadRef\)/,
    "a pending sidebar row reopens under its original threadRef instead of forking a new one",
  );
  assert.match(restoreBody, /startNewChat\(state\.rememberedScopeId, state\.rememberedContextName\)/);
  assert.match(restoreBody, /return false/, "unknown session id falls back to the browse page");
  assert.match(
    switchViewBody,
    /else if \(!restoreLastConversation\(\)\) void renderChatsPage\(\);/,
    "browse page renders only when nothing is remembered",
  );
  assert.ok(
    switchViewBody.indexOf("mountRestoredCanvas()) drawCanvas()") < switchViewBody.indexOf("restoreLastConversation()"),
    "the canvas keeps priority over conversation restore",
  );
});
