import assert from "node:assert/strict";
import { test } from "node:test";
import { NEUTRAL_HOME, activeTips, scenarioCards, dateKeyOf } from "../src/home-config.ts";

const config = {
  ...NEUTRAL_HOME,
  tips: [
    { id: "A", layer: "icebreak", title: "a", oneLiner: "", prompt: "", capability: "", depts: [], status: "active" },
    { id: "B", layer: "task", title: "b", oneLiner: "", prompt: "", capability: "", depts: [], status: "active" },
    { id: "C", layer: "task", title: "c", oneLiner: "", prompt: "", capability: "", depts: [], status: "active" },
    { id: "D", layer: "collab", title: "d", oneLiner: "", prompt: "", capability: "", depts: [], status: "active" },
    { id: "X", layer: "task", title: "x", oneLiner: "", prompt: "", capability: "", depts: [], status: "deferred" },
  ],
} as typeof NEUTRAL_HOME;

test("deferred tips never enter any pool", () => {
  assert.equal(activeTips(config).length, 4);
  assert.ok(activeTips(config).every((t) => t.id !== "X"));
  for (const user of ["u1", "u2", "u3"]) {
    for (const date of ["2026-09-02", "2026-09-03"]) {
      assert.ok(scenarioCards(config, user, date).every((t) => t.id !== "X"));
    }
  }
});

test("rotation is stable for same user+date and changes next day", () => {
  const a = scenarioCards(config, "user@x.cn", "2026-09-02").map((t) => t.id);
  const b = scenarioCards(config, "user@x.cn", "2026-09-02").map((t) => t.id);
  assert.deepEqual(a, b);
  const nextDays = new Set<string>();
  for (let d = 3; d <= 30; d++)
    nextDays.add(
      scenarioCards(config, "user@x.cn", `2026-09-${String(d).padStart(2, "0")}`)
        .map((t) => t.id)
        .join(","),
    );
  assert.ok(nextDays.size > 1);
});

test("rotation differs across users on the same day", () => {
  const u1 = scenarioCards(config, "u1@x.cn", "2026-09-02")
    .map((t) => t.id)
    .join(",");
  const u2 = scenarioCards(config, "u2@x.cn", "2026-09-02")
    .map((t) => t.id)
    .join(",");
  assert.notEqual(u1, u2);
});

test("dateKeyOf formats local date", () => {
  assert.equal(dateKeyOf(new Date(2026, 8, 2)), "2026-09-02");
});
