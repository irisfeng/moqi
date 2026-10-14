import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workSeconds, workedLabel } from "../src/work-duration.ts";
import type { WorkBlock } from "../src/core-bridge.ts";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("elapsed time counts from the run's own start, so a reload does not reset it", () => {
  const work = { status: "thinking", activity: [], startedAt: Date.now() - 125_000 } as unknown as WorkBlock;
  const secs = workSeconds(work);
  assert.ok(secs >= 125 && secs <= 127);
  assert.equal(workedLabel("Thinking", 125), "Thinking for 2m 5s");
  assert.equal(workedLabel("Thinking", 0), "Thinking");
});

test("the live line shows the elapsed time and keeps ticking while the assistant is still thinking", () => {
  assert.match(chat, /const elapsed = work\.stale \? 0 : workSeconds\(work\);/);
  assert.match(chat, /class="live-work-elapsed"/);
  assert.match(chat, /live\.status === "working" \|\| live\.status === "thinking"\) && !live\.stale/);
  assert.match(chat, /return workedLabel\("Thinking", workSeconds\(work\)\);/);
  assert.doesNotMatch(chat, /live-work[^`]*%/);
});
