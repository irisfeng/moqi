import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADOPTION_SCENARIO_SYSTEM,
  adoptionScenarioNeedsContext,
  classifyAdoptionScenario,
  prepareAdoptionScenario,
} from "../src/admin/adoption-scenario-classifier.ts";

const answer = (value: unknown) => ({ complete: async () => JSON.stringify(value) });
const live = () => new AbortController().signal;

test("text that carries a credential in a common form is never prepared for the model", () => {
  for (const text of [
    "the password is Hunter2Hunter2",
    "pwd=abcdef123",
    "postgres://admin:S3cretPass99@db.internal/app",
    "key AKIAABCDEFGHIJKLMNOP here",
    "ghs_abcdefghijklmnop1234",
  ])
    assert.equal(prepareAdoptionScenario(text, []).label?.status, "sensitive_skipped", text);
  for (const text of ["how do I reset my password", "see https://example.com/a:b for the plan"])
    assert.ok(prepareAdoptionScenario(text, []).prompt, text);
});

test("a request is prepared for the model only when it is safe and has something to classify", () => {
  assert.deepEqual(prepareAdoptionScenario("   ", []).label, { category: null, status: "empty_text", source: "none" });
  assert.equal(prepareAdoptionScenario("my password: hunter2secret", []).label?.status, "sensitive_skipped");
  assert.equal(prepareAdoptionScenario("x".repeat(4001), []).label?.status, "input_too_long");
  assert.deepEqual(JSON.parse(prepareAdoptionScenario("draft a bid proposal", ["earlier"]).prompt!), {
    current: "draft a bid proposal",
    previous: [],
  });
});

test("a short follow-up carries at most the two requests before it", () => {
  assert.equal(adoptionScenarioNeedsContext("continue"), true);
  assert.equal(adoptionScenarioNeedsContext("继续。"), true);
  assert.equal(adoptionScenarioNeedsContext("continue the bid proposal"), false);
  assert.deepEqual(JSON.parse(prepareAdoptionScenario("continue", ["one", "two", "three"]).prompt!), {
    current: "continue",
    previous: ["two", "three"],
  });
  assert.equal(prepareAdoptionScenario("continue", []).label?.status, "ambiguous");
  assert.equal(prepareAdoptionScenario("continue", ["more details", "continue"]).label?.status, "ambiguous");
  assert.equal(prepareAdoptionScenario("continue", ["password = abcdef123456"]).label?.status, "sensitive_skipped");
});

test("only a well-formed model answer becomes a label", async () => {
  const classified = { category: "writing", status: "classified", reason: "clear_goal" };
  assert.deepEqual(await classifyAdoptionScenario(answer(classified), "{}", live()), {
    category: "writing",
    status: "classified",
    source: "model",
  });
  assert.deepEqual(
    await classifyAdoptionScenario(
      answer({ category: null, status: "multi_intent", reason: "multiple_goals" }),
      "{}",
      live(),
    ),
    { category: null, status: "multi_intent", source: "model" },
  );
  for (const bad of [
    { category: "writing", status: "ambiguous", reason: "insufficient_context" },
    { category: null, status: "classified", reason: "clear_goal" },
    { category: "writing", status: "classified", reason: "refused" },
    { category: "cooking", status: "classified", reason: "clear_goal" },
    { ...classified, extra: true },
  ])
    assert.equal((await classifyAdoptionScenario(answer(bad), "{}", live())).status, "invalid_output");
  assert.equal(
    (await classifyAdoptionScenario({ complete: async () => "not json" }, "{}", live())).status,
    "invalid_output",
  );
  assert.equal(
    (await classifyAdoptionScenario({ complete: async () => undefined }, "{}", live())).status,
    "model_refused",
  );
});

test("a failed model call is a timeout only when the call was aborted", async () => {
  const failing = { complete: () => Promise.reject(new Error("boom")) };
  assert.equal((await classifyAdoptionScenario(failing, "{}", live())).status, "model_error");
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await classifyAdoptionScenario(failing, "{}", aborted.signal)).status, "model_timeout");
});

test("the classifier prompt names every scene and the fixed taxonomy", () => {
  for (const id of ["research", "writing", "business", "data", "presentation", "media", "engineering", "coordination"])
    assert.ok(ADOPTION_SCENARIO_SYSTEM.includes(`${id}=`), id);
  assert.ok(ADOPTION_SCENARIO_SYSTEM.includes("scenes-v1"));
});
