import assert from "node:assert/strict";
import { test } from "node:test";
import { growthProgressPercent } from "../src/guide.ts";
import { growthStageIndex, type GrowthTaskView } from "../src/growth.ts";

function growthView(status: GrowthTaskView["status"], firstAcceptedAt: number | null = null): GrowthTaskView {
  return {
    status,
    participation:
      status === "review" || status === "revise" ? ({ firstAcceptedAt } as GrowthTaskView["participation"]) : null,
  } as GrowthTaskView;
}

test("growth rail distinguishes the first draft review from the revision review", () => {
  assert.equal(growthStageIndex(growthView("available")), 0);
  assert.equal(growthStageIndex(growthView("working")), 0);
  assert.equal(growthStageIndex(growthView("review")), 2);
  assert.equal(growthStageIndex(growthView("revise")), 3);
  assert.equal(growthStageIndex(growthView("review", 1)), 4);
  assert.equal(growthStageIndex(growthView("complete", 1)), 5);
});

test("daily review enters the confirmation step without a revision step", () => {
  assert.equal(growthStageIndex({ ...growthView("review"), kind: "daily" }), 3);
});

test("growth progress measures the current level interval", () => {
  assert.equal(growthProgressPercent({ points: 0, nextLevelAt: 50 }), 0);
  assert.equal(growthProgressPercent({ points: 50, nextLevelAt: 150 }), 0);
  assert.equal(growthProgressPercent({ points: 100, nextLevelAt: 150 }), 50);
  assert.equal(growthProgressPercent({ points: 150, nextLevelAt: 300 }), 0);
  assert.equal(growthProgressPercent({ points: 300, nextLevelAt: null }), 100);
});
