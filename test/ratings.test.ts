import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryRatingStore,
  ratingContext,
  ratingTargetId,
  summarizeRatings,
  type Rating,
} from "../src/ratings/rating-store.ts";

function rating(patch: Partial<Rating>): Rating {
  return {
    principalId: "alice",
    targetId: "entry:s1:4",
    sessionId: "s1",
    value: "up",
    reason: "",
    model: "model-a",
    skills: [],
    updatedAt: 1,
    ...patch,
  };
}

test("one person has one rating per target, and can change or remove it", async () => {
  const store = createMemoryRatingStore();
  await store.set(rating({}));
  await store.set(rating({ value: "down", reason: "wrong figure", updatedAt: 2 }));
  await store.set(rating({ principalId: "bob" }));
  const mine = await store.forSession("alice", "s1");
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.value, "down");
  assert.equal((await store.forSession("alice", "other")).length, 0);
  await store.remove("alice", "entry:s1:4");
  assert.equal((await store.forSession("alice", "s1")).length, 0);
  assert.equal((await store.forSession("bob", "s1")).length, 1);
});

test("a message and a file have different targets", () => {
  assert.equal(ratingTargetId("s1", 4), "entry:s1:4");
  assert.equal(ratingTargetId("s1", 4, "f9"), "file:s1:f9");
  assert.equal(
    ratingTargetId("s2", 7, "f9"),
    "file:s2:f9",
    "the same file rated in another conversation is a separate rating",
  );
});

test("the summary counts by model and by each skill used, and lists reasons without naming people", () => {
  const summary = summarizeRatings([
    rating({ skills: ["report", "chart"] }),
    rating({ principalId: "bob", value: "down", reason: "too long", skills: ["report"], updatedAt: 5 }),
    rating({ principalId: "carol", model: null, value: "down" }),
  ]);
  assert.deepEqual(summary.byModel, [
    { name: "model-a", up: 1, down: 1 },
    { name: "", up: 0, down: 1 },
  ]);
  assert.deepEqual(summary.bySkill, [
    { name: "report", up: 1, down: 1 },
    { name: "chart", up: 1, down: 0 },
  ]);
  assert.deepEqual(summary.reasons, [{ reason: "too long", model: "model-a", skills: ["report"], at: 5 }]);
});

test("the model and skills of an answer come from its own turn", async () => {
  const entries = [
    { seq: 1, type: "user", payload: {} },
    { seq: 2, type: "tool_call", payload: { tool: "skills", action: "read", name: "old-skill" } },
    { seq: 3, type: "assistant", payload: {} },
    { seq: 4, type: "user", payload: {} },
    { seq: 5, type: "tool_call", payload: { tool: "skills", action: "read", name: "report" } },
    { seq: 6, type: "tool_call", payload: { tool: "files", action: "read", name: "not-a-skill" } },
    { seq: 7, type: "assistant", payload: {} },
    { seq: 8, type: "user", payload: {} },
  ];
  const asked: number[][] = [];
  const sessions = {
    async getEntries(_id: string, opts?: { beforeSeq?: number }) {
      return entries.filter((entry) => entry.seq < (opts?.beforeSeq ?? Infinity));
    },
    async listLlmRequests(_id: string, opts?: { turnSeqs?: number[] }) {
      asked.push(opts?.turnSeqs ?? []);
      return [{ model: "model-a" }, { model: "model-b" }];
    },
  } as unknown as Parameters<typeof ratingContext>[0];
  assert.deepEqual(await ratingContext(sessions, "s1", 7), { model: "model-b", skills: ["report"] });
  assert.deepEqual(asked, [[4]]);
});
