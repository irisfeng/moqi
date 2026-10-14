import { test } from "node:test";
import assert from "node:assert/strict";
import { modelMenuOptions, modelPresentation } from "../src/model-presentation.ts";
const option = (id: string, provider = "deepseek", harnessId = "pi") => ({
  value: `${harnessId}:${id}`,
  label: id,
  buttonLabel: id,
  harnessId,
  model: { id, provider },
});
test("new badge expires and does not appear before release", () => {
  assert.equal(modelPresentation("deepseek-flash", "", Date.UTC(2026, 8, 13), "deepseek").badge, "New");
  assert.equal(modelPresentation("deepseek-flash", "", Date.UTC(2026, 9, 10), "deepseek").badge, "");
  assert.equal(modelPresentation("deepseek-flash", "", Date.UTC(2026, 8, 9), "deepseek").badge, "");
});
test("aliases collapse without changing selected runtime model", () => {
  const rows = [
    option("deepseek-v4-flash"),
    option("deepseek-v4-flash-vision-exp"),
    option("deepseek-flash"),
    option("glm-5.3-flash", "zhipu-glm"),
  ];
  const result = modelMenuOptions(rows, "pi:deepseek-v4-flash");
  assert.deepEqual(
    result.map((x) => x.value),
    ["pi:deepseek-v4-flash", "pi:deepseek-flash", "pi:glm-5.3-flash"],
  );
  assert.equal(result[0].description, "Text tasks · legacy entry");
  assert.equal(rows.length, 4);
  assert.equal(modelMenuOptions(rows, "pi:glm-5.3-flash")[0].value, "pi:deepseek-flash");
});
test("does not merge providers or harnesses or invent unavailable models", () => {
  const rows = [
    option("deepseek-v4-flash"),
    option("deepseek-v4-flash-vision-exp", "other"),
    option("deepseek-v4-flash", "deepseek", "codex"),
  ];
  assert.equal(modelMenuOptions(rows, "").length, 3);
  assert.deepEqual(
    modelMenuOptions([option("glm-5.3")], "").map((x) => x.value),
    ["pi:glm-5.3"],
  );
});

test("legacy catalogs keep their image entry available", () => {
  const rows = [option("deepseek-v4-flash"), option("deepseek-v4-flash-vision-exp")];
  assert.equal(modelMenuOptions(rows, rows[0].value).length, 2);
});

test("does not relabel third-party catalogs and collapses unselected text alias", () => {
  assert.equal(modelPresentation("deepseek-flash", "Custom", Date.UTC(2026, 8, 13), "other").label, "Custom");
  assert.equal(modelPresentation("glm-5.3-flash", "Custom", Date.UTC(2026, 8, 13), "other").description, "");
  const rows = [option("deepseek-v4-flash"), option("deepseek-v4-flash-vision-exp")];
  assert.deepEqual(
    modelMenuOptions(rows, "").map((x) => x.value),
    [rows[1].value],
  );
});
