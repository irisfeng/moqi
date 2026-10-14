import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURED_SCENES, featuredScenarioTips } from "../src/featured-scenes.ts";
import { NEUTRAL_HOME, type HomeTip } from "../src/home-config.ts";

function tip(id: string, status: HomeTip["status"] = "active"): HomeTip {
  return {
    id,
    title: id,
    oneLiner: "流程说明",
    prompt: `原始完整要求 ${id}`,
    layer: "task",
    capability: "original-capability",
    depts: ["运营"],
    status,
  };
}

test("the two entry points share only six complete workflows without mutating configuration", () => {
  const source = {
    ...NEUTRAL_HOME,
    tips: [tip("T02"), tip("T10"), ...FEATURED_SCENES.map((scene) => tip(scene.id)).reverse()],
  };
  const before = JSON.stringify(source);
  const selected = featuredScenarioTips(source);
  assert.deepEqual(
    selected.map((item) => item.id),
    ["W01", "W11", "W25", "W05", "W09", "W13"],
  );
  assert.equal(JSON.stringify(source), before);
  for (const item of selected) {
    assert.equal(item.prompt, FEATURED_SCENES.find((scene) => scene.id === item.id)!.prompt);
    assert.equal(item.capability, "original-capability");
    assert.deepEqual(item.depts, ["运营"]);
  }
});

test("missing and deferred scenes do not reappear as basic or invented examples", () => {
  const source = { ...NEUTRAL_HOME, tips: [tip("W01", "deferred"), tip("W09"), tip("T02")] };
  assert.deepEqual(
    featuredScenarioTips(source).map((item) => item.id),
    ["W09"],
  );
  assert.deepEqual(featuredScenarioTips({ ...source, tips: [tip("T02")] }), []);
});
