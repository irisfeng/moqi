import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker, estimateCostUsd } from "../src/ratelimit/budget.ts";
import { DEFAULT_AGENT_INPUT_USD_PER_MTOK } from "../src/model/pi-models.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

test("budget tracker accumulates per-principal and trips at the limit", async () => {
  const b = createBudgetTracker({ limitUsd: 1, windowMs: 60_000 });
  assert.equal((await b.check("U1")).allowed, true);
  await b.record("U1", 0.6, 1000);
  assert.equal((await b.check("U1", 1000)).allowed, true);
  await b.record("U1", 0.6, 1000);
  assert.equal((await b.check("U1", 1000)).allowed, false);
  assert.equal((await b.check("U2", 1000)).allowed, true);
  assert.equal((await b.check("U1", 1000 + 61_000)).allowed, true);
});

test("caps are opt-in: an unconfigured tracker never refuses, a configured one does", async () => {
  const unbounded = createBudgetTracker();
  await unbounded.record("U1", 1_000_000);
  assert.equal((await unbounded.check("U1")).allowed, true, "no configured cap = unlimited (upgrade safety)");
  const capped = createBudgetTracker({ limitUsd: 25 });
  await capped.record("U1", 26);
  assert.equal((await capped.check("U1")).allowed, false);
  assert.equal(estimateCostUsd(1000) > 0, true);
  assert.equal(estimateCostUsd(1_000_000), DEFAULT_AGENT_INPUT_USD_PER_MTOK);
});

test("the org cap holds across principals", async () => {
  const b = createBudgetTracker({ limitUsd: 100, orgLimitUsd: 1, windowMs: 60_000 });
  await b.record("U1", 0.6, 1000);
  await b.record("U2", 0.6, 1000);
  assert.equal((await b.check("U3", 1000)).allowed, false);
});

test("exempt principals bypass both caps and do not consume the org pool", async () => {
  const b = createBudgetTracker({ limitUsd: 1, orgLimitUsd: 2, windowMs: 60_000, exempt: new Set(["payor@x.cn"]) });
  await b.record("payor@x.cn", 500, 1000);
  const self = await b.check("payor@x.cn", 1000);
  assert.equal(self.allowed, true, "personal cap bypassed");
  assert.equal(self.limitUsd, Infinity);
  assert.equal((await b.check("U1", 1000)).allowed, true, "exempt spend left the org pool untouched");
  await b.record("U1", 1.5, 1000);
  assert.equal((await b.check("U1", 1000)).allowed, false, "non-exempt still capped by the personal limit");
  const b2 = createBudgetTracker({ orgLimitUsd: 2, windowMs: 60_000, exempt: new Set(["payor@x.cn"]) });
  await b2.record("payor@x.cn", 100, 1000);
  await b2.record("U2", 1.5, 1000);
  assert.equal((await b2.check("U2", 1000)).allowed, true, "org pool counts only non-exempt spend");
  await b2.record("U3", 1, 1000);
  assert.equal((await b2.check("U3", 1000)).allowed, false, "org cap trips without the exempt principal's spend");
});

test("a principal over budget is refused by the app", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-bud-")),
    budgetUsdPerWindow: 0.00001,
  });
  const { app } = buildApp(config);
  const dm = (text: string): TurnRequest => ({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text,
  });

  const first = await app.turn(dm("hello"));
  assert.equal(first.status, "ok");
  const second = await app.turn(dm("again"));
  assert.equal(second.status, "refused");
  assert.match(second.reason ?? "", /budget exceeded/);
});
